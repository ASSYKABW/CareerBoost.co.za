// Console agent runtime — a small, safe Anthropic tool-use loop.
//
// Design constraints (CareerBoost Command, Phase A):
//   • ALLOWLISTED TOOLS ONLY — the agent can call exactly the tools the
//     caller passes in, nothing else. v1 tools are read-only.
//   • HARD BUDGET CAP — cost (computeCostUSD) accumulates after every model
//     call; exceeding budgetUsd stops the run with status 'over_budget'.
//   • FULL LEDGER — every run writes an agent_runs row (migration 0046) with
//     a step-by-step transcript, so anything an agent ever did is reviewable.
//   • BOUNDED — maxTurns model calls, capped tool output size, per-call
//     timeout. An agent run can be slow or wrong, never runaway.
//
// The loop talks to the Anthropic Messages API directly (multi-turn tool_use
// isn't what _shared/llm.ts's single-shot callProvider is for). Pricing comes
// from _shared/pricing.ts so agent spend is measured with the same table as
// product spend.
import { getServiceClient } from "./auth.ts";
import { computeCostUSD } from "./pricing.ts";
import { getProviderKey } from "./runtime-config.ts";

export interface AgentTool {
  name: string;
  description: string;
  // JSON Schema for the tool input (Anthropic `input_schema`).
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentRunOptions {
  agent: string;                 // 'console' | 'marketing' | ...
  system: string;
  prompt: string;
  tools: AgentTool[];
  createdBy?: string | null;
  model?: string;                // default claude-sonnet-4-5
  budgetUsd?: number;            // default 0.25, hard cap
  maxTurns?: number;             // default 6 model calls
  maxTokens?: number;            // per model call, default 1200
}

export interface AgentRunResult {
  runId: string | null;
  status: "done" | "failed" | "over_budget";
  result: string;
  steps: Array<Record<string, unknown>>;
  turns: number;
  costUsd: number;
  error?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result blocks (we author these, the model never sends them)
  tool_use_id?: string;
  content?: string;
}

const TOOL_OUTPUT_CAP = 6000; // chars per tool result fed back to the model

function capJson(value: unknown): string {
  let s: string;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  return s.length > TOOL_OUTPUT_CAP ? s.slice(0, TOOL_OUTPUT_CAP) + "…(truncated)" : s;
}

// ── Provider fallback ───────────────────────────────────────────────────
// This loop used to call Anthropic directly, hardcoded. When the Anthropic
// credit ran dry every agent run hard-failed with HTTP 400 and the Console
// agents were simply dead — while the product's own content path degraded to
// Groq and kept working, because it routes through _shared/routing.ts.
//
// Agents now use the same principle: one dry provider must never take the
// agents down. The loop's internal representation stays Anthropic-shaped
// (content blocks); an adapter translates to OpenAI's tool-calling dialect at
// the boundary, so providers can be swapped mid-run without rewriting history.

/** One model reply, normalised to Anthropic-shaped blocks. */
interface ModelReply {
  blocks: AnthropicContentBlock[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

interface AgentProvider {
  id: string;
  model: string;
  call: (system: string, messages: Array<Record<string, unknown>>, tools: AgentTool[], maxTokens: number, signal: AbortSignal) => Promise<ModelReply>;
}

async function callAnthropic(
  apiKey: string, model: string, system: string,
  messages: Array<Record<string, unknown>>, tools: AgentTool[], maxTokens: number, signal: AbortSignal,
): Promise<ModelReply> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system, messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    }),
  });
  if (!res.ok) throw new Error("Anthropic HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json() as {
    content: AnthropicContentBlock[];
    stop_reason: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    blocks: data.content || [],
    stopReason: String(data.stop_reason || ""),
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

/** Anthropic message history → OpenAI chat messages. */
function toOpenAiMessages(system: string, messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    const role = String(m.role);
    const content = m.content;
    if (typeof content === "string") { out.push({ role, content }); continue; }
    const blocks = (content || []) as AnthropicContentBlock[];

    if (role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }

    // A user turn is either plain text or the tool results we authored. OpenAI
    // wants one message per result, keyed by tool_call_id.
    const results = blocks.filter((b) => b.type === "tool_result");
    if (results.length) {
      for (const r of results) out.push({ role: "tool", tool_call_id: r.tool_use_id, content: String(r.content ?? "") });
    } else {
      out.push({ role: "user", content: blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n") });
    }
  }
  return out;
}

async function callOpenAiCompat(
  baseUrl: string, apiKey: string, model: string, system: string,
  messages: Array<Record<string, unknown>>, tools: AgentTool[], maxTokens: number, signal: AbortSignal,
): Promise<ModelReply> {
  const payload: Record<string, unknown> = {
    model, max_tokens: maxTokens, messages: toOpenAiMessages(system, messages),
  };
  if (tools.length) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    payload.tool_choice = "auto";
  }
  const res = await fetch(baseUrl, {
    method: "POST", signal,
    headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = data.choices?.[0]?.message || {};
  const blocks: AnthropicContentBlock[] = [];
  if (msg.content) blocks.push({ type: "text", text: String(msg.content) });
  for (const tc of msg.tool_calls || []) {
    let input: Record<string, unknown> = {};
    // A smaller model can emit malformed JSON arguments. Treat that as an empty
    // input rather than throwing away the whole run.
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
    blocks.push({ type: "tool_use", id: tc.id || ("call_" + Math.random().toString(36).slice(2)), name: tc.function?.name, input });
  }
  return {
    blocks,
    stopReason: (msg.tool_calls && msg.tool_calls.length) ? "tool_use" : "end_turn",
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

/** Providers to try, best first. Only those with a key configured. */
async function buildProviderChain(preferredModel?: string): Promise<AgentProvider[]> {
  const chain: AgentProvider[] = [];
  const anthropicKey = await getProviderKey("anthropic");
  if (anthropicKey) {
    const model = preferredModel || "claude-sonnet-4-5";
    chain.push({
      id: "anthropic", model,
      call: (s, m, t, mt, sig) => callAnthropic(anthropicKey, model, s, m, t, mt, sig),
    });
  }
  const groqKey = await getProviderKey("groq");
  if (groqKey) {
    const model = "llama-3.3-70b-versatile";
    chain.push({
      id: "groq", model,
      call: (s, m, t, mt, sig) => callOpenAiCompat("https://api.groq.com/openai/v1/chat/completions", groqKey, model, s, m, t, mt, sig),
    });
  }
  const openaiKey = await getProviderKey("openai");
  if (openaiKey) {
    const model = "gpt-4o-mini";
    chain.push({
      id: "openai", model,
      call: (s, m, t, mt, sig) => callOpenAiCompat("https://api.openai.com/v1/chat/completions", openaiKey, model, s, m, t, mt, sig),
    });
  }
  return chain;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const chain = await buildProviderChain(opts.model);
  if (!chain.length) {
    return { runId: null, status: "failed", result: "", steps: [], turns: 0, costUsd: 0, error: "No AI provider key configured (set ANTHROPIC_API_KEY, GROQ_API_KEY or OPENAI_API_KEY, or add one in the Console)." };
  }
  let active = 0; // index into `chain`
  const budgetUsd = Math.min(2, Math.max(0.02, opts.budgetUsd ?? 0.25));
  const maxTurns = Math.min(10, Math.max(1, opts.maxTurns ?? 6));
  const maxTokens = Math.min(4000, Math.max(300, opts.maxTokens ?? 1200));

  const svc = getServiceClient();
  const steps: Array<Record<string, unknown>> = [];
  let runId: string | null = null;
  try {
    const { data } = await svc.from("agent_runs").insert({
      agent: opts.agent, status: "running", autonomy: "suggest",
      prompt: opts.prompt.slice(0, 4000), budget_usd: budgetUsd,
      created_by: opts.createdBy || null,
    }).select("id").single();
    runId = data?.id ? String(data.id) : null;
  } catch { /* ledger unavailable (migration missing) — run anyway, ledger-less */ }

  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: opts.prompt },
  ];

  let costUsd = 0;
  let turns = 0;
  let finalText = "";
  let status: AgentRunResult["status"] = "done";
  let error: string | undefined;

  async function persist(final: boolean) {
    if (!runId) return;
    try {
      await svc.from("agent_runs").update({
        steps, turns, cost_usd: Math.round(costUsd * 10000) / 10000,
        ...(final ? { status, result: finalText.slice(0, 8000), error: error || null, finished_at: new Date().toISOString() } : {}),
      }).eq("id", runId);
    } catch { /* non-fatal */ }
  }

  try {
    for (turns = 1; turns <= maxTurns; turns++) {
      // Try the active provider; on failure fall down the chain. History is
      // provider-neutral, so a mid-run switch costs only the failed call.
      let data: ModelReply | null = null;
      const attemptErrors: string[] = [];
      while (active < chain.length) {
        const provider = chain[active];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45_000);
        try {
          data = await provider.call(opts.system, messages, opts.tools, maxTokens, controller.signal);
          costUsd += computeCostUSD(provider.model, { inputTokens: data.inputTokens, outputTokens: data.outputTokens });
          break;
        } catch (err) {
          const msg = provider.id + ": " + ((err as Error).message || "call failed");
          attemptErrors.push(msg);
          steps.push({ at: new Date().toISOString(), type: "provider_failover", provider: provider.id, error: msg.slice(0, 300) });
          active += 1;
          if (active < chain.length) {
            steps.push({ at: new Date().toISOString(), type: "note", text: "Falling back to " + chain[active].id + " (" + chain[active].model + ")." });
          }
        } finally {
          clearTimeout(timer);
        }
      }
      if (!data) throw new Error("All AI providers failed. " + attemptErrors.join(" | "));

      const textBlocks = (data.blocks || []).filter((b) => b.type === "text" && b.text);
      for (const b of textBlocks) {
        steps.push({ at: new Date().toISOString(), type: "text", text: (b.text || "").slice(0, 2000) });
      }

      const toolUses = (data.blocks || []).filter((b) => b.type === "tool_use");
      if (data.stopReason !== "tool_use" || toolUses.length === 0) {
        finalText = textBlocks.map((b) => b.text).join("\n").trim();
        break;
      }

      // Echo the assistant turn, then answer every tool_use block.
      messages.push({ role: "assistant", content: data.blocks });
      const results: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        const tool = toolByName.get(String(tu.name));
        let output: string;
        if (!tool) {
          output = JSON.stringify({ error: "Unknown tool: " + tu.name });
        } else {
          try {
            output = capJson(await tool.run(tu.input || {}));
          } catch (err) {
            output = JSON.stringify({ error: (err as Error).message || "tool failed" });
          }
        }
        steps.push({ at: new Date().toISOString(), type: "tool", tool: tu.name, input: tu.input || {}, output: output.slice(0, 1500) });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      messages.push({ role: "user", content: results });
      await persist(false);

      if (costUsd >= budgetUsd) {
        status = "over_budget";
        finalText = "Stopped: run hit its $" + budgetUsd.toFixed(2) + " budget cap before finishing. Partial findings are in the step log.";
        break;
      }
      if (turns === maxTurns) {
        finalText = textBlocks.map((b) => b.text).join("\n").trim() ||
          "Stopped at the max-turns cap. Partial findings are in the step log.";
      }
    }
  } catch (err) {
    status = "failed";
    error = (err as Error).message || "Agent run failed.";
  }

  await persist(true);
  return { runId, status, result: finalText, steps, turns, costUsd: Math.round(costUsd * 10000) / 10000, error };
}
