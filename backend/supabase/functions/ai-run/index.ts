// POST /functions/v1/ai-run
// Body: { requestId: string, skill: string, promptVersion: string, input: unknown,
//         stream?: boolean }
// Auth: Supabase JWT (Authorization: Bearer <access_token>).
//
// Phase 1 wiring:
//   1. Smart per-skill model routing (SKILL_ROUTING in _shared/routing.ts).
//   2. Anthropic prompt caching (5-min ephemeral; ~70% input cost reduction).
//   3. Tool-use / structured outputs for high-complexity skills.
//   4. Response cache lookup (skip LLM entirely on identical inputs).
//   5. Per-user daily rate limits + cost cap.
//   6. Cost tracking ($USD per call) written to ai_usage.
//   7. Streaming pass-through for `interview-session-step` (when stream=true).
//
// Routing precedence:
//   1. body.provider (client override) — highest priority.
//   2. AI_ROUTING_<SKILL> env (operator per-skill override).
//   3. LLM_PROVIDER env (operator global override — forces single provider).
//   4. SKILL_ROUTING.provider (Phase 1 smart default).
//   5. DEFAULT_PROVIDER_ORDER (legacy fallback chain when key missing).

import { corsHeaders, errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";
import { validateSkillPayload, type Skill } from "../_shared/schemas.ts";
import { prompts } from "../_shared/prompts.ts";
import { TOOL_SCHEMAS } from "../_shared/tool-schemas.ts";
import {
  SKILL_ROUTING,
  maxTokensFor,
  modelOverride,
  temperatureFor,
} from "../_shared/routing.ts";
import {
  callProvider,
  extractJson,
  providerHasKey,
  streamAnthropic,
  type LLMProvider,
} from "../_shared/llm.ts";
import { computeCostUSD } from "../_shared/pricing.ts";
import { checkRateLimit, recordRateLimitUsage } from "../_shared/rate-limit.ts";
import {
  buildCacheKey,
  readResponseCache,
  writeResponseCache,
} from "../_shared/response-cache.ts";

interface RunBody {
  requestId?: string;
  skill?: string;
  promptVersion?: string;
  input?: unknown;
  model?: string;
  provider?: LLMProvider;
  /** Phase 1: opt-in streaming for `interview-session-step`. */
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Quality gates (kept from pre-Phase-1 — still valuable as belt-and-braces).
// ---------------------------------------------------------------------------
const INSTRUCTION_HINTS = [
  "consider", "try ", "you can", "make sure", "focus on",
  "highlight", "quantify", "add more", "should ",
];

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isInstructionLike(value: string): boolean {
  const text = normalizeText(value).toLowerCase();
  if (!text) return true;
  if (text.length < 20) return true;
  return INSTRUCTION_HINTS.some((hint) => text.includes(hint));
}

function uniqueByMeaning(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function fallbackVariants(base: string): string[] {
  const clean = normalizeText(base);
  if (!clean) return [];
  return uniqueByMeaning([
    clean,
    `${clean} while emphasizing ownership and the practical result delivered.`,
    `${clean} In one sentence, make the action, scope, and real impact clear without adding new facts.`,
  ]);
}

function ensureThreeRewrites(rewrite: unknown, alternatives: unknown): { rewrite: string; alternatives: string[] } {
  const primary = typeof rewrite === "string" ? normalizeText(rewrite) : "";
  const rawAlternatives = Array.isArray(alternatives)
    ? alternatives.filter((v): v is string => typeof v === "string").map(normalizeText)
    : [];
  const candidates = [primary, ...rawAlternatives].filter((v) => v && !isInstructionLike(v));
  const variants = uniqueByMeaning(candidates);
  const filled = uniqueByMeaning([...variants, ...fallbackVariants(primary || variants[0] || "")]);
  const [first = "", second = "", third = ""] = filled;
  return { rewrite: first, alternatives: [second, third].filter(Boolean) };
}

function uniqueSummaries(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length < 50) continue;
    const key = normalized.toLowerCase().replace(/\s+/g, " ").slice(0, 500);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function synthesizeSummaryAlternatives(primary: string): string[] {
  const base = normalizeText(primary);
  if (!base || base.length < 80) return [];
  const parts = base.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  if (parts.length >= 3) {
    const v = parts.slice(0, 2).join(" ");
    if (v.length >= 50) out.push(v);
  }
  if (parts.length >= 2) {
    const v2 = [parts[1], parts[0], ...parts.slice(2)].join(" ");
    if (v2.length >= 50) out.push(v2);
  }
  const trimmed = base
    .replace(/\b(very|really|highly|significantly|extremely)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (trimmed.length >= 50 && trimmed.toLowerCase() !== base.toLowerCase()) out.push(trimmed);
  return uniqueSummaries(out);
}

function ensureTailorPlanSummaryBlock(parsed: Record<string, unknown>): void {
  const summary = typeof parsed.summary === "string" ? normalizeText(parsed.summary) : "";
  if (!summary) return;
  const raw = Array.isArray(parsed.summaryAlternatives)
    ? parsed.summaryAlternatives.filter((v): v is string => typeof v === "string").map(normalizeText)
    : [];
  let merged = uniqueSummaries([summary, ...raw]);
  if (merged.length < 3) {
    merged = uniqueSummaries([...merged, ...synthesizeSummaryAlternatives(summary)]);
  }
  parsed.summary = merged[0] || summary;
  parsed.summaryAlternatives = merged.slice(1, 3);
}

function applyQualityGates(skill: Skill, parsed: Record<string, unknown>): Record<string, unknown> {
  if (skill === "resume-critique" && Array.isArray(parsed.issues)) {
    parsed.issues = parsed.issues.map((issue) => {
      if (!issue || typeof issue !== "object") return issue;
      const obj = issue as Record<string, unknown>;
      const target = obj.target;
      if (!target || typeof target !== "object") return obj;
      const targetObj = target as Record<string, unknown>;
      if (targetObj.type === "section" && obj.section === "summary") {
        const rep = typeof targetObj.replacement === "string" ? normalizeText(targetObj.replacement) : "";
        if (!rep) return obj;
        const rawAlts = Array.isArray(targetObj.alternatives)
          ? targetObj.alternatives.filter((v): v is string => typeof v === "string").map(normalizeText)
          : [];
        let merged = uniqueSummaries([rep, ...rawAlts]);
        if (merged.length < 3) {
          merged = uniqueSummaries([...merged, ...synthesizeSummaryAlternatives(rep)]);
        }
        const first = merged[0] || rep;
        const rest = merged.slice(1, 3);
        return { ...obj, target: { ...targetObj, replacement: first, alternatives: rest } };
      }
      if (targetObj.type !== "bullet") return obj;
      const rewrites = ensureThreeRewrites(targetObj.replacement, targetObj.alternatives);
      return {
        ...obj,
        target: { ...targetObj, replacement: rewrites.rewrite, alternatives: rewrites.alternatives },
      };
    });
  }
  if (skill === "tailor-plan") {
    if (Array.isArray(parsed.bullets)) {
      parsed.bullets = parsed.bullets.map((bullet) => {
        if (!bullet || typeof bullet !== "object") return bullet;
        const obj = bullet as Record<string, unknown>;
        const rewrites = ensureThreeRewrites(obj.rewrite, obj.alternatives);
        return { ...obj, rewrite: rewrites.rewrite, alternatives: rewrites.alternatives };
      });
    }
    ensureTailorPlanSummaryBlock(parsed);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Provider chain selection (Phase 1 smart routing on top of legacy chain).
// ---------------------------------------------------------------------------
const DEFAULT_PROVIDER_ORDER: LLMProvider[] = ["gemini", "openai", "groq", "anthropic"];

function providersWithKeys(): LLMProvider[] {
  return DEFAULT_PROVIDER_ORDER.filter(providerHasKey);
}

function chooseProviders(skill: Skill, clientOverride?: LLMProvider): LLMProvider[] {
  const available = providersWithKeys();
  if (available.length === 0) return [];

  // Operator global override — single provider, no fallback.
  const globalOverride = (Deno.env.get("LLM_PROVIDER") || "").trim() as LLMProvider;
  if (globalOverride && available.includes(globalOverride)) {
    return [globalOverride];
  }

  // Per-skill operator override.
  const envKey = "AI_ROUTING_" + skill.toUpperCase().replace(/-/g, "_");
  const perSkillOverride = (Deno.env.get(envKey) || "").trim() as LLMProvider;

  // Phase 1: smart route default.
  const smartDefault = SKILL_ROUTING[skill]?.provider;

  const preferred =
    (clientOverride && available.includes(clientOverride) && clientOverride) ||
    (perSkillOverride && available.includes(perSkillOverride) && perSkillOverride) ||
    (smartDefault && available.includes(smartDefault) && smartDefault) ||
    null;

  if (preferred) {
    return [preferred, ...available.filter((p) => p !== preferred)];
  }
  return available;
}

function modelForCall(skill: Skill, provider: LLMProvider, clientModel?: string): string | undefined {
  // 1. Client override (rarely used).
  if (clientModel) return clientModel;
  // 2. Operator per-skill override (MODEL_RESUME_TAILOR=...).
  const envOverride = modelOverride(skill);
  if (envOverride) return envOverride;
  // 3. Smart route default — only return when the chosen provider matches the
  //    routed provider (otherwise we'd send a Claude model name to Gemini).
  const route = SKILL_ROUTING[skill];
  if (route && route.provider === provider) return route.model;
  // 4. Provider's own internal default.
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider chain runner with quality gates + tool-use enforcement.
// ---------------------------------------------------------------------------
async function tryProviders(
  providers: LLMProvider[],
  spec: typeof prompts[Skill],
  input: unknown,
  skill: Skill,
  clientModel: string | undefined,
) {
  let lastError: Error | null = null;
  const warnings: string[] = [];
  const tool = TOOL_SCHEMAS[skill];

  for (const provider of providers) {
    try {
      const longForm = SKILL_ROUTING[skill]?.longForm === true;
      const timeoutMs = longForm
        ? Number(Deno.env.get("LLM_TIMEOUT_OPENAI_LONG_MS") || "45000")
        : Number(Deno.env.get("LLM_TIMEOUT_MS") || "25000");

      const call = await callProvider(provider, {
        systemStable: spec.systemStable,
        user: spec.userTemplate(input),
        model: modelForCall(skill, provider, clientModel),
        temperature: temperatureFor(skill),
        maxTokens: maxTokensFor(skill),
        timeoutMs,
        toolName: tool?.toolName,
        outputSchema: tool?.schema,
      });

      const parsed = extractJson<Record<string, unknown>>(call.text);
      validateSkillPayload(skill, parsed);
      const qualityChecked = applyQualityGates(skill, parsed);
      return { call, parsed: qualityChecked, warnings };
    } catch (err) {
      lastError = err as Error;
      warnings.push(`${provider}: ${(lastError.message || "failed").slice(0, 120)}`);
    }
  }
  const base = lastError?.message || "No providers available";
  const detail = warnings.length ? `${base} — Attempts: ${warnings.join(" · ")}` : base;
  const wrapped = new Error(detail) as Error & { providerWarnings?: string[] };
  wrapped.providerWarnings = warnings;
  throw wrapped;
}

// ---------------------------------------------------------------------------
// Streaming handler (interview-session-step only, opt-in via body.stream).
// ---------------------------------------------------------------------------
async function streamResponse(
  req: Request,
  spec: typeof prompts[Skill],
  input: unknown,
  skill: Skill,
  userId: string,
  requestId: string,
  promptVersion: string,
  clientModel?: string,
): Promise<Response> {
  // Streaming only supports Anthropic right now.
  if (!providerHasKey("anthropic")) {
    return errorResponse("Streaming requires ANTHROPIC_API_KEY.", 503);
  }

  const route = SKILL_ROUTING[skill];
  const model = clientModel || modelOverride(skill) || route?.model || "claude-sonnet-4-5";
  const started = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("meta", { requestId, model, provider: "anthropic" });

      let fullText = "";
      let usage: {
        inputTokens?: number; outputTokens?: number;
        cachedInputTokens?: number; cacheCreationTokens?: number;
      } | undefined;

      try {
        for await (const evt of streamAnthropic({
          systemStable: spec.systemStable,
          user: spec.userTemplate(input),
          model,
          temperature: temperatureFor(skill),
          maxTokens: maxTokensFor(skill),
        })) {
          if (evt.type === "delta" && evt.text) {
            fullText += evt.text;
            send("delta", { text: evt.text });
          } else if (evt.type === "stop") {
            usage = evt.usage;
          }
        }

        // Try to validate. Streaming returns plain text JSON; on validation
        // failure we still emit `done` but with parsed=null.
        let parsed: Record<string, unknown> | null = null;
        let valid = false;
        try {
          parsed = extractJson<Record<string, unknown>>(fullText);
          validateSkillPayload(skill, parsed);
          parsed = applyQualityGates(skill, parsed);
          valid = true;
        } catch (err) {
          send("warn", { message: "Schema validation failed: " + (err as Error).message });
        }

        const latencyMs = Date.now() - started;
        const cost = computeCostUSD(model, usage ?? {});

        send("done", {
          ok: valid,
          requestId,
          model,
          provider: "anthropic",
          latencyMs,
          confidence: 0.85,
          data: parsed,
        });
        controller.close();

        // Telemetry (fire-and-forget).
        try {
          await getServiceClient().from("ai_usage").insert({
            user_id: userId,
            request_id: requestId,
            skill,
            provider: "anthropic",
            model,
            prompt_version: promptVersion,
            status: valid ? "success" : "failed",
            latency_ms: latencyMs,
            input_tokens: usage?.inputTokens ?? null,
            output_tokens: usage?.outputTokens ?? null,
            input_tokens_cached: usage?.cachedInputTokens ?? null,
            cache_creation_tokens: usage?.cacheCreationTokens ?? null,
            cost_usd: cost || null,
          });
        } catch { /* ignore */ }
        if (valid) {
          await recordRateLimitUsage(userId, skill, cost).catch(() => {});
        }
      } catch (err) {
        send("error", { message: (err as Error).message || "Stream failed" });
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Request-Id": requestId,
    },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const skill = body.skill as Skill | undefined;
  const input = body.input;
  const requestId = body.requestId || crypto.randomUUID();
  const promptVersion = body.promptVersion || `${skill}@server`;

  if (!skill || !(skill in prompts)) {
    return errorResponse(`Unknown or missing skill: ${skill}`, 400);
  }

  // ---- Rate limit (pre-LLM, fail-open on infra errors). ----
  const rateDecision = await checkRateLimit(user.id, skill);
  if (!rateDecision.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        requestId,
        error: rateDecision.reason || "Rate limited.",
        bucketCount: rateDecision.bucketCount,
        dailyCostUsd: rateDecision.dailyCostUsd,
      }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": String(rateDecision.retryAfterSeconds ?? 3600),
          "X-Request-Id": requestId,
        },
      },
    );
  }

  // ---- Streaming branch (interview-session-step). ----
  if (body.stream === true) {
    if (skill !== "interview-session-step") {
      return errorResponse(
        `Streaming is not supported for skill "${skill}". Only interview-session-step.`,
        400,
      );
    }
    return streamResponse(
      req, prompts[skill], input, skill,
      user.id, requestId, promptVersion, body.model,
    );
  }

  // ---- Response cache lookup (pre-LLM). ----
  const cacheKey = await buildCacheKey(skill, input, promptVersion);
  const cached = await readResponseCache(skill, cacheKey);
  if (cached.envelope) {
    return jsonResponse({
      ...cached.envelope,
      requestId,
      cacheHit: true,
      cacheAgeSeconds: cached.ageSeconds,
    }, { headers: { "X-Request-Id": requestId, "X-Cache": "HIT" } });
  }

  const providers = chooseProviders(skill, body.provider);
  if (providers.length === 0) {
    return errorResponse(
      "No LLM providers configured. Set at least one of GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, or ANTHROPIC_API_KEY as Supabase Edge Function secrets.",
      503,
    );
  }

  const spec = prompts[skill];
  const started = Date.now();

  try {
    const { call, parsed, warnings } = await tryProviders(providers, spec, input, skill, body.model);
    const cost = computeCostUSD(call.model, {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedInputTokens: call.cachedInputTokens,
      cacheCreationTokens: call.cacheCreationTokens,
    });

    // Telemetry insert (fire-and-forget; service-role bypasses RLS).
    try {
      await getServiceClient().from("ai_usage").insert({
        user_id: user.id,
        request_id: requestId,
        skill,
        provider: call.provider,
        model: call.model,
        prompt_version: promptVersion,
        status: "success",
        latency_ms: call.latencyMs,
        input_tokens: call.inputTokens ?? null,
        output_tokens: call.outputTokens ?? null,
        input_tokens_cached: call.cachedInputTokens ?? null,
        cache_creation_tokens: call.cacheCreationTokens ?? null,
        cost_usd: cost || null,
      });
    } catch { /* telemetry failure must not break the request */ }

    const envelope = {
      ok: true,
      model: call.model,
      provider: call.provider,
      promptVersion,
      latencyMs: call.latencyMs,
      confidence: 0.85,
      warnings,
      data: parsed,
    };

    // Persist envelope to response cache (fire-and-forget).
    writeResponseCache(skill, cacheKey, envelope, promptVersion).catch(() => {});

    // Increment rate-limit counter (fire-and-forget).
    recordRateLimitUsage(user.id, skill, cost).catch(() => {});

    return jsonResponse(
      { ...envelope, requestId, cacheHit: false },
      { headers: { "X-Request-Id": requestId, "X-Cache": "MISS" } },
    );
  } catch (err) {
    const message = (err as Error).message || "LLM call failed";
    const failWarnings = (err as Error & { providerWarnings?: string[] }).providerWarnings || [];

    try {
      await getServiceClient().from("ai_usage").insert({
        user_id: user.id,
        request_id: requestId,
        skill,
        prompt_version: promptVersion,
        status: "failed",
        latency_ms: Date.now() - started,
        error: message.slice(0, 500),
      });
    } catch { /* ignore */ }

    return new Response(
      JSON.stringify({
        ok: false,
        requestId,
        error: message,
        warnings: failWarnings,
        latencyMs: Date.now() - started,
      }),
      {
        status: 502,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        },
      },
    );
  }
});
