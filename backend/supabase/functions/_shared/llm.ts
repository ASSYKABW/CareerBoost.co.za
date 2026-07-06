// Provider-agnostic LLM adapter. Supports Gemini (Google AI), OpenAI,
// Anthropic, and Groq.
//
// Phase 1 additions:
//   - Structured system blocks (`systemStable` + `systemDynamic`) so Anthropic
//     prompt caching can mark the stable persona+schema+rules block as
//     ephemeral-cacheable. Cuts input cost ~70% on long-form skills.
//   - Tool-use mode for Anthropic (forces strict JSON via tool schema).
//   - JSON-schema strict mode for OpenAI (response_format).
//   - Cache-token usage captured into LLMCallOutput.
//   - Streaming pass-through for SSE-capable callers (Anthropic only).

import { getProviderKey } from "./runtime-config.ts";

export type LLMProvider = "gemini" | "openai" | "anthropic" | "groq";

export interface LLMCallInput {
  /** Stable, prompt-cacheable system block (persona, schema, rules). */
  systemStable: string;
  /** Per-request dynamic system content (rarely-changing context). */
  systemDynamic?: string;
  /** User turn (the actual query / inputs / data). */
  user: string;
  /** Optional structured-output JSON schema (Draft-7-style object). */
  outputSchema?: Record<string, unknown>;
  /** When provided, forces tool-use / structured outputs where supported. */
  toolName?: string;
  /** Per-call model override. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LLMCallOutput {
  text: string;
  model: string;
  provider: LLMProvider;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  latencyMs: number;
}

const TIMEOUT_MS = Number(Deno.env.get("LLM_TIMEOUT_MS") ?? "25000");

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("LLM request timed out")), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

function combineSystem(i: LLMCallInput): string {
  const stable = (i.systemStable || "").trim();
  const dynamic = (i.systemDynamic || "").trim();
  return dynamic ? stable + "\n\n" + dynamic : stable;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
async function callOpenAI(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = await getProviderKey("openai");
  if (!apiKey) throw new Error("No OpenAI key configured (env OPENAI_API_KEY or Console)");
  const model = i.model || Deno.env.get("LLM_MODEL") || "gpt-4o-mini";

  const { signal, cancel } = abortAfter(i.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();
  try {
    const body: Record<string, unknown> = {
      model,
      temperature: i.temperature ?? 0.4,
      messages: [
        { role: "system", content: combineSystem(i) },
        { role: "user", content: i.user },
      ],
    };
    if (i.maxTokens) body.max_tokens = i.maxTokens;

    if (i.outputSchema && i.toolName) {
      // OpenAI strict JSON-schema mode (eliminates extractJson failures).
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: i.toolName,
          strict: true,
          schema: i.outputSchema,
        },
      };
    } else {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 400)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage ?? {};
    return {
      text,
      model,
      provider: "openai",
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function callGemini(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = await getProviderKey("gemini");
  if (!apiKey) throw new Error("No Gemini key configured (env GEMINI_API_KEY or Console)");
  const clientModel = (i.model || "").trim();
  const model =
    clientModel && /^gemini/i.test(clientModel)
      ? clientModel
      : (Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash");
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;

  const { signal, cancel } = abortAfter(i.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${
      encodeURIComponent(apiKey)
    }`;

  try {
    const generationConfig: Record<string, unknown> = {
      temperature: i.temperature ?? 0.4,
      maxOutputTokens: Math.min(i.maxTokens ?? 2048, 8192),
      responseMimeType: "application/json",
    };
    if (i.outputSchema) {
      // Gemini supports OpenAPI subset for responseSchema.
      generationConfig.responseSchema = i.outputSchema;
    }

    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: combineSystem(i) }] },
        contents: [{ role: "user", parts: [{ text: i.user }] }],
        generationConfig,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Gemini ${res.status}: ${txt.slice(0, 400)}`);
    }
    const data = await res.json() as Record<string, unknown>;
    const candidates = Array.isArray(data?.candidates) ? data.candidates as Record<string, unknown>[] : [];
    const first = candidates[0] as Record<string, unknown> | undefined;
    const content = first?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content!.parts as { text?: string }[] : [];
    const text = parts.map((p) => p?.text ?? "").join("");
    const finish = typeof first?.finishReason === "string" ? first.finishReason : "";
    if (!text.trim() && finish) {
      throw new Error(`Gemini blocked or empty output (finishReason=${finish}).`);
    }
    const usage = data?.usageMetadata as Record<string, unknown> | undefined;
    return {
      text,
      model: model.replace(/^models\//, ""),
      provider: "gemini",
      inputTokens: typeof usage?.promptTokenCount === "number" ? usage.promptTokenCount : undefined,
      outputTokens: typeof usage?.candidatesTokenCount === "number" ? usage.candidatesTokenCount : undefined,
      cachedInputTokens: typeof usage?.cachedContentTokenCount === "number"
        ? usage.cachedContentTokenCount
        : undefined,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// Anthropic (with prompt caching + tool use)
// ---------------------------------------------------------------------------
// Opus 4.7+, Sonnet 5, and the Fable/Mythos 5 family removed the sampling
// parameters (temperature/top_p/top_k) and budget_tokens — sending temperature
// returns a 400. Older Claude models (Haiku 4.5, Sonnet 4.5, Opus 4.6 and
// earlier) still accept it. Match the tiers that reject sampling params so we
// can safely route flagship skills (e.g. resume-critique) to current models.
function anthropicRejectsSampling(model: string): boolean {
  const m = (model || "").toLowerCase();
  return /claude-(opus-4-[789]|sonnet-5|fable-5|mythos-5)/.test(m);
}

async function callAnthropic(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = await getProviderKey("anthropic");
  if (!apiKey) throw new Error("No Anthropic key configured (env ANTHROPIC_API_KEY or Console)");
  const model = i.model || Deno.env.get("LLM_MODEL") || "claude-haiku-4-5";

  const { signal, cancel } = abortAfter(i.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();

  // System is an ARRAY of typed text blocks. The stable block is marked
  // cache_control: ephemeral so subsequent calls within ~5 minutes pay 10%
  // input price. Long-form skills (resume tailor/critique, interview debrief)
  // see the largest savings.
  const systemBlocks: Array<Record<string, unknown>> = [];
  const stable = (i.systemStable || "").trim();
  const dynamic = (i.systemDynamic || "").trim();
  if (stable) {
    systemBlocks.push({
      type: "text",
      text: stable,
      cache_control: { type: "ephemeral" },
    });
  }
  if (dynamic) {
    systemBlocks.push({ type: "text", text: dynamic });
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: i.maxTokens ?? 1200,
    system: systemBlocks,
    messages: [{ role: "user", content: i.user }],
  };
  // Only send temperature to models that still accept it (see note above).
  if (!anthropicRejectsSampling(model)) {
    body.temperature = i.temperature ?? 0.4;
  }

  if (i.outputSchema && i.toolName) {
    // Tool-use mode: model is forced to call the tool, which guarantees
    // strict-shape JSON in tool_use.input. Eliminates JSON-extraction failures.
    body.tools = [
      {
        name: i.toolName,
        description: "Emit the structured response for this skill.",
        input_schema: i.outputSchema,
      },
    ];
    body.tool_choice = { type: "tool", name: i.toolName };
  } else {
    // Free-form text fallback — older skills that don't ship a schema yet.
    // Append a no-fence instruction to the dynamic block.
    if (systemBlocks.length === 0) {
      systemBlocks.push({ type: "text", text: "Return ONLY a JSON object." });
    } else {
      systemBlocks[systemBlocks.length - 1] = {
        ...systemBlocks[systemBlocks.length - 1],
        text: ((systemBlocks[systemBlocks.length - 1] as { text: string }).text +
          "\n\nReturn ONLY a JSON object — no markdown, no commentary."),
      };
    }
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Prompt caching has been generally available since 2024-08, but the
        // beta header keeps the response shape predictable on older accounts.
        "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 400)}`);
    }
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];

    // Extract tool_use input (preferred) or text content.
    let text = "";
    if (i.toolName) {
      const tool = blocks.find((b: { type?: string }) => b?.type === "tool_use");
      if (tool && (tool as { input?: unknown }).input) {
        text = JSON.stringify((tool as { input: unknown }).input);
      }
    }
    if (!text) {
      text = blocks
        .filter((b: { type?: string }) => b?.type === "text" || !b?.type)
        .map((b: { text?: string }) => b?.text ?? "")
        .join("");
    }

    const usage = data?.usage ?? {};
    return {
      text,
      model,
      provider: "anthropic",
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// Anthropic streaming (SSE pass-through)
// ---------------------------------------------------------------------------
export interface StreamEvent {
  type: "delta" | "stop";
  text?: string;
  /** Final usage info; only present on the "stop" event. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
  };
  model?: string;
}

/**
 * Streams an Anthropic completion as discrete `delta` events ending in `stop`.
 * NOTE: streaming + tool-use are mutually compatible but tool-use streams emit
 * input_json_delta events (partial JSON). For the streaming-first skill
 * (interview-session-step) we use plain text mode so progressive rendering
 * "just works" and we parse the final text once on stop.
 */
export async function* streamAnthropic(i: LLMCallInput): AsyncGenerator<StreamEvent, void, unknown> {
  const apiKey = await getProviderKey("anthropic");
  if (!apiKey) throw new Error("No Anthropic key configured (env ANTHROPIC_API_KEY or Console)");
  const model = i.model || Deno.env.get("LLM_MODEL") || "claude-sonnet-4-5";

  const systemBlocks: Array<Record<string, unknown>> = [];
  const stable = (i.systemStable || "").trim();
  const dynamic = (i.systemDynamic || "").trim();
  if (stable) {
    systemBlocks.push({ type: "text", text: stable, cache_control: { type: "ephemeral" } });
  }
  if (dynamic) {
    systemBlocks.push({ type: "text", text: dynamic });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: i.maxTokens ?? 1600,
      // Only send temperature to models that still accept it (Opus 4.7+,
      // Sonnet 5, and Fable/Mythos 5 reject it with a 400).
      ...(anthropicRejectsSampling(model) ? {} : { temperature: i.temperature ?? 0.4 }),
      system: systemBlocks,
      messages: [{ role: "user", content: i.user }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text();
    throw new Error(`Anthropic stream ${res.status}: ${txt.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: StreamEvent["usage"] | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta") {
          const delta = evt?.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "delta", text: delta.text };
          }
        } else if (evt.type === "message_delta" && evt.usage) {
          usage = {
            outputTokens: evt.usage.output_tokens,
          };
        } else if (evt.type === "message_start" && evt.message?.usage) {
          usage = {
            ...usage,
            inputTokens: evt.message.usage.input_tokens,
            cachedInputTokens: evt.message.usage.cache_read_input_tokens,
            cacheCreationTokens: evt.message.usage.cache_creation_input_tokens,
          };
        }
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  yield { type: "stop", usage, model };
}

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------
async function callGroq(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = await getProviderKey("groq");
  if (!apiKey) throw new Error("No Groq key configured (env GROQ_API_KEY or Console)");
  const model = i.model || Deno.env.get("LLM_MODEL") || "llama-3.3-70b-versatile";

  const { signal, cancel } = abortAfter(i.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: i.temperature ?? 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: combineSystem(i) },
          { role: "user", content: i.user },
        ],
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Groq ${res.status}: ${txt.slice(0, 400)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage ?? {};
    return {
      text,
      model,
      provider: "groq",
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
export function callProvider(provider: LLMProvider, i: LLMCallInput): Promise<LLMCallOutput> {
  switch (provider) {
    case "gemini":    return callGemini(i);
    case "openai":    return callOpenAI(i);
    case "anthropic": return callAnthropic(i);
    case "groq":      return callGroq(i);
    default: throw new Error(`Unsupported provider: ${provider}`);
  }
}

export function providerHasKey(provider: LLMProvider): boolean {
  switch (provider) {
    case "gemini":    return !!Deno.env.get("GEMINI_API_KEY");
    case "openai":    return !!Deno.env.get("OPENAI_API_KEY");
    case "anthropic": return !!Deno.env.get("ANTHROPIC_API_KEY");
    case "groq":      return !!Deno.env.get("GROQ_API_KEY");
    default: return false;
  }
}

const DEFAULT_PROVIDER_ORDER: LLMProvider[] = ["gemini", "openai", "groq", "anthropic"];

// Legacy entrypoint kept for any external callers.
export async function callLLM(i: LLMCallInput): Promise<LLMCallOutput> {
  const explicit = (Deno.env.get("LLM_PROVIDER") || "").trim() as LLMProvider;
  if (explicit && DEFAULT_PROVIDER_ORDER.includes(explicit) && providerHasKey(explicit)) {
    return callProvider(explicit, i);
  }
  for (const p of DEFAULT_PROVIDER_ORDER) {
    if (providerHasKey(p)) return callProvider(p, i);
  }
  throw new Error("No LLM API key configured (GEMINI_API_KEY, OPENAI_API_KEY, etc.)");
}

// Best-effort JSON extractor for free-form text outputs (used as fallback when
// tool-use mode is unavailable). Strips code fences, grabs the first {...} block.
export function extractJson<T = unknown>(raw: string): T {
  if (!raw) throw new Error("Empty model output.");
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error("Model did not return valid JSON.");
  }
}
