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
}

const TOOL_OUTPUT_CAP = 6000; // chars per tool result fed back to the model

function capJson(value: unknown): string {
  let s: string;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  return s.length > TOOL_OUTPUT_CAP ? s.slice(0, TOOL_OUTPUT_CAP) + "…(truncated)" : s;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return { runId: null, status: "failed", result: "", steps: [], turns: 0, costUsd: 0, error: "ANTHROPIC_API_KEY not configured." };
  }
  const model = opts.model || "claude-sonnet-4-5";
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

  const anthropicTools = opts.tools.map((t) => ({
    name: t.name, description: t.description, input_schema: t.inputSchema,
  }));
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      let res: Response;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model, max_tokens: maxTokens, system: opts.system,
            messages, tools: anthropicTools,
          }),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error("Anthropic HTTP " + res.status + ": " + body.slice(0, 200));
      }
      const data = await res.json() as {
        content: AnthropicContentBlock[];
        stop_reason: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      costUsd += computeCostUSD(model, {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      });

      const textBlocks = (data.content || []).filter((b) => b.type === "text" && b.text);
      for (const b of textBlocks) {
        steps.push({ at: new Date().toISOString(), type: "text", text: (b.text || "").slice(0, 2000) });
      }

      const toolUses = (data.content || []).filter((b) => b.type === "tool_use");
      if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = textBlocks.map((b) => b.text).join("\n").trim();
        break;
      }

      // Echo the assistant turn, then answer every tool_use block.
      messages.push({ role: "assistant", content: data.content });
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
