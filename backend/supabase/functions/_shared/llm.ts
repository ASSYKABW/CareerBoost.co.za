// Provider-agnostic LLM adapter. Supports Gemini (Google AI), OpenAI,
// Anthropic, and Groq. Swap providers by setting LLM_PROVIDER in the function env.

export type LLMProvider = "gemini" | "openai" | "anthropic" | "groq";

export interface LLMCallInput {
  system: string;
  user: string;
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
  latencyMs: number;
}

const TIMEOUT_MS = Number(Deno.env.get("LLM_TIMEOUT_MS") ?? "25000");

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("LLM request timed out")), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function callOpenAI(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = i.model || Deno.env.get("LLM_MODEL") || "gpt-4.1";

  const { signal, cancel } = abortAfter(i.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
          { role: "system", content: i.system },
          { role: "user", content: i.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model,
      provider: "openai",
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

async function callGemini(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
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
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: i.system }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: i.user }],
          },
        ],
        generationConfig: {
          temperature: i.temperature ?? 0.4,
          maxOutputTokens: Math.min(i.maxTokens ?? 2048, 8192),
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 400)}`);
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
      outputTokens: typeof usage?.candidatesTokenCount === "number"
        ? usage.candidatesTokenCount
        : undefined,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

async function callAnthropic(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = i.model || Deno.env.get("LLM_MODEL") || "claude-3-5-haiku-latest";

  const { signal, cancel } = abortAfter(i.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: i.maxTokens ?? 1200,
        temperature: i.temperature ?? 0.4,
        system: i.system + "\n\nReturn ONLY valid JSON.",
        messages: [{ role: "user", content: i.user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks.map((b: any) => b?.text ?? "").join("");
    return {
      text,
      model,
      provider: "anthropic",
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

async function callGroq(i: LLMCallInput): Promise<LLMCallOutput> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  // Groq deprecated llama-3.1-70b-versatile in early 2025. llama-3.3-70b-versatile
  // is the drop-in replacement (same size class, same JSON support).
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
          { role: "system", content: i.system },
          { role: "user", content: i.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model,
      provider: "groq",
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    cancel();
  }
}

export function callProvider(
  provider: LLMProvider,
  i: LLMCallInput,
): Promise<LLMCallOutput> {
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

// Legacy single-provider entry point (kept for backwards compatibility).
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

// Best-effort JSON extractor (strips code fences, grabs the first {...} block).
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
