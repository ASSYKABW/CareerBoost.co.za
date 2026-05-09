// Smart model routing per skill.
//
// Each skill has a complexity tier. Cheap classifiers go to fast/inexpensive
// models; long-form creative reasoning goes to the top tier. Operators can
// override via env (LLM_PROVIDER, AI_ROUTING_<SKILL>=provider, LLM_MODEL,
// MODEL_<SKILL>=model-id) — see chooseProviders() in ai-run/index.ts.
//
// Pricing snapshot used by pricing.ts is *separate* from this routing config.

import type { LLMProvider } from "./llm.ts";
import type { Skill } from "./schemas.ts";

export interface SkillRoute {
  /** Preferred provider when its key is configured. */
  provider: LLMProvider;
  /** Preferred model on that provider. */
  model: string;
  /** Hints for token budgeting + caching. */
  tier: "cheap" | "mid" | "top";
  /** Long-form skills get more time + bigger output cap. */
  longForm?: boolean;
  /** Whether this skill should attempt streaming when supported by the call site. */
  stream?: boolean;
}

// Default skill → preferred (provider, model). Tuned for current price/quality
// frontiers (Nov 2025). Replace model names when newer ones land.
//
// Notes:
//   - Anthropic Sonnet 4.5 + Haiku 4.5 are 2025 models; if your account doesn't
//     have access yet, the chain falls back automatically to the next provider.
//   - Gemini 2.0 Flash is the cheap tier on Google.
//   - GPT-4o-mini is the cheap mid-tier on OpenAI.
export const SKILL_ROUTING: Record<Skill, SkillRoute> = {
  // ----- Cheap classifiers / structured extraction (~50× cheaper) -----------
  "query-parse":              { provider: "gemini",    model: "gemini-2.0-flash",     tier: "cheap" },
  "job-match-score":          { provider: "gemini",    model: "gemini-2.0-flash",     tier: "cheap" },
  "jd-analyze":               { provider: "gemini",    model: "gemini-2.0-flash",     tier: "cheap" },
  "resume-parse":             { provider: "anthropic", model: "claude-haiku-4-5",     tier: "cheap" },
  "interview-score":          { provider: "anthropic", model: "claude-haiku-4-5",     tier: "cheap" },

  // ----- Mid-tier reasoning -------------------------------------------------
  "followup-email":           { provider: "openai",    model: "gpt-4o-mini",          tier: "mid" },
  "application-insight":      { provider: "anthropic", model: "claude-haiku-4-5",     tier: "mid" },
  "interview-coach":          { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "mid" },
  "cover-letter-generate":    { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "mid" },

  // ----- Top tier — long-form creative + cited reasoning -------------------
  "resume-tailor":            { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "top", longForm: true },
  "tailor-plan":              { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "top", longForm: true },
  "resume-critique":          { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "top", longForm: true },
  "interview-session-debrief":{ provider: "anthropic", model: "claude-sonnet-4-5",    tier: "top", longForm: true },
  "interview-intel-pack":     { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "top", longForm: true },

  // ----- Streaming-first conversational ------------------------------------
  "interview-session-step":   { provider: "anthropic", model: "claude-sonnet-4-5",    tier: "top", longForm: true, stream: true },

  // ----- Phase 5 additions -------------------------------------------------
  "skill-action-plan":        { provider: "anthropic", model: "claude-haiku-4-5",     tier: "mid" },
};

/** Per-tier max output token budget. */
export function maxTokensFor(skill: Skill): number {
  const route = SKILL_ROUTING[skill];
  if (route?.longForm) return 2800;
  if (route?.tier === "top") return 2200;
  if (route?.tier === "mid") return 1400;
  return 900;
}

/** Per-tier temperature default. */
export function temperatureFor(skill: Skill): number {
  // Deterministic for structured extraction.
  if (skill === "query-parse" || skill === "jd-analyze" || skill === "resume-parse") return 0.1;
  // High variance for creative rewrites — alternatives should genuinely differ.
  if (skill === "resume-tailor" || skill === "tailor-plan" || skill === "resume-critique" || skill === "cover-letter-generate") return 0.7;
  // Default conversational.
  return 0.4;
}

/**
 * Read an operator override of the form MODEL_<SKILL>=model-id.
 * Returns "" when unset. Lets ops swap a single skill's model without code changes.
 */
export function modelOverride(skill: Skill): string {
  const key = "MODEL_" + skill.toUpperCase().replace(/-/g, "_");
  return (Deno.env.get(key) || "").trim();
}
