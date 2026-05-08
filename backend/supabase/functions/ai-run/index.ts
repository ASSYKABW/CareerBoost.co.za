// POST /functions/v1/ai-run
// Body: { requestId: string, skill: string, promptVersion: string, input: unknown }
// Auth: Supabase JWT (Authorization: Bearer <access_token>).
// Response envelope matches the client orchestrator (src/js/ai/ai.orchestrator.js):
//   { ok, requestId, model, latencyMs, confidence, warnings[], data }
//
// Routing strategy:
//   1. Default chain (when keys exist): Gemini → OpenAI → Groq → Anthropic.
//   2. If a provider call fails (network, quota, invalid JSON), try the next
//      in the chain.
//   3. LLM_PROVIDER forces a single provider for every skill (no fallback).
//   4. AI_ROUTING_<SKILL> or body.provider moves that provider to the front
//      of the chain for that request, then continues with the rest.
import { corsHeaders, errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";
import { validateSkillPayload, type Skill } from "../_shared/schemas.ts";
import { prompts } from "../_shared/prompts.ts";
import {
  callProvider,
  extractJson,
  providerHasKey,
  type LLMProvider,
} from "../_shared/llm.ts";

interface RunBody {
  requestId?: string;
  skill?: string;
  promptVersion?: string;
  input?: unknown;
  model?: string;
  provider?: LLMProvider; // optional client override
}

const INSTRUCTION_HINTS = [
  "consider",
  "try ",
  "you can",
  "make sure",
  "focus on",
  "highlight",
  "quantify",
  "add more",
  "should ",
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

  const candidates = [primary, ...rawAlternatives]
    .filter((v) => v && !isInstructionLike(v));
  const variants = uniqueByMeaning(candidates);
  const filled = uniqueByMeaning([...variants, ...fallbackVariants(primary || variants[0] || "")]);
  const [first = "", second = "", third = ""] = filled;
  return {
    rewrite: first,
    alternatives: [second, third].filter(Boolean),
  };
}

/** Dedupe long-form summaries (do not use isInstructionLike — it false-positives on paragraphs). */
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
        return {
          ...obj,
          target: {
            ...targetObj,
            replacement: first,
            alternatives: rest,
          },
        };
      }

      if (targetObj.type !== "bullet") return obj;
      const rewrites = ensureThreeRewrites(targetObj.replacement, targetObj.alternatives);
      return {
        ...obj,
        target: {
          ...targetObj,
          replacement: rewrites.rewrite,
          alternatives: rewrites.alternatives,
        },
      };
    });
  }

  if (skill === "tailor-plan") {
    if (Array.isArray(parsed.bullets)) {
      parsed.bullets = parsed.bullets.map((bullet) => {
        if (!bullet || typeof bullet !== "object") return bullet;
        const obj = bullet as Record<string, unknown>;
        const rewrites = ensureThreeRewrites(obj.rewrite, obj.alternatives);
        return {
          ...obj,
          rewrite: rewrites.rewrite,
          alternatives: rewrites.alternatives,
        };
      });
    }
    ensureTailorPlanSummaryBlock(parsed);
  }

  return parsed;
}

/** Try order when multiple API keys are configured: 1 Gemini, 2 OpenAI, 3 Groq, then Anthropic. */
const PROVIDER_PRIORITY: LLMProvider[] = ["gemini", "openai", "groq", "anthropic"];

function providersWithKeysInOrder(): LLMProvider[] {
  return PROVIDER_PRIORITY.filter((p) => providerHasKey(p));
}

function chooseProviders(skill: Skill, clientOverride?: LLMProvider): LLMProvider[] {
  const chain = providersWithKeysInOrder();
  if (chain.length === 0) return [];

  // Global operator override — forces every skill through this provider only.
  const globalOverride = (Deno.env.get("LLM_PROVIDER") || "").trim() as LLMProvider;
  if (globalOverride && chain.includes(globalOverride)) {
    return [globalOverride];
  }

  // Optional per-skill overrides via env:
  //   AI_ROUTING_RESUME_TAILOR=openai, AI_ROUTING_JOB_MATCH_SCORE=groq, etc.
  const envKey = "AI_ROUTING_" + skill.toUpperCase().replace(/-/g, "_");
  const perSkillOverride = (Deno.env.get(envKey) || "").trim() as LLMProvider;

  const preferred = (
    (clientOverride && chain.includes(clientOverride) && clientOverride) ||
    (perSkillOverride && chain.includes(perSkillOverride) && perSkillOverride) ||
    null
  ) as LLMProvider | null;

  if (preferred) {
    return [preferred, ...chain.filter((p) => p !== preferred)];
  }

  return chain;
}

async function tryProviders(
  providers: LLMProvider[],
  spec: ReturnType<() => typeof prompts[Skill]>,
  input: unknown,
  skill: Skill,
  model: string | undefined,
) {
  let lastError: Error | null = null;
  const warnings: string[] = [];
  // For long-form writing/evaluation skills, give OpenAI more time before
  // falling back. This avoids premature fallback while still preserving
  // reliability if the primary provider fails.
  const longFormSkills = new Set<Skill>([
    "tailor-plan",
    "resume-critique",
    "interview-session-step",
    "interview-session-debrief",
    "interview-intel-pack",
  ]);
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const timeoutMs =
        (provider === "openai" || provider === "gemini") && longFormSkills.has(skill)
          ? Number(Deno.env.get("LLM_TIMEOUT_OPENAI_LONG_MS") || "45000")
          : Number(Deno.env.get("LLM_TIMEOUT_MS") || "25000");
      const call = await callProvider(provider, {
        system: spec.system,
        user: spec.userTemplate(input),
        model,
        temperature: skill === "query-parse" ? 0 : 0.4,
        maxTokens: (skill === "resume-tailor" || skill === "tailor-plan" || skill === "resume-critique")
          ? 2800
          : skill === "interview-session-debrief" || skill === "interview-intel-pack"
          ? 2200
          : skill === "interview-session-step"
          ? 1600
          : 1000,
        timeoutMs,
      });
      const parsed = extractJson<Record<string, unknown>>(call.text);
      validateSkillPayload(skill, parsed);
      const qualityChecked = applyQualityGates(skill, parsed);
      return { call, parsed: qualityChecked, warnings };
    } catch (err) {
      lastError = err as Error;
      warnings.push(`${provider}: ${(lastError.message || "failed").slice(0, 120)}`);
      // Try the next provider in the list.
    }
  }
  const base = lastError?.message || "No providers available";
  const detail = warnings.length ? `${base} — Attempts: ${warnings.join(" · ")}` : base;
  const wrapped = new Error(detail) as Error & { providerWarnings?: string[] };
  wrapped.providerWarnings = warnings;
  throw wrapped;
}

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
    const { call, parsed, warnings } = await tryProviders(
      providers,
      spec,
      input,
      skill,
      body.model,
    );

    // Fire-and-forget telemetry insert (service role bypasses RLS).
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
      });
    } catch { /* telemetry failure must not break the request */ }

    return jsonResponse({
      ok: true,
      requestId,
      model: call.model,
      provider: call.provider,
      promptVersion,
      latencyMs: call.latencyMs,
      confidence: 0.85,
      warnings,
      data: parsed,
    });
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
