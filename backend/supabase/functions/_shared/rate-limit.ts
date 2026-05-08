// Per-user, per-skill, per-day rate limit + cost cap.
//
// Storage: public.ai_rate_limits (see migration 0004).
// Increment is best-effort fire-and-forget after a SUCCESSFUL LLM call.
// The pre-call check reads current bucket counters and rejects if either
// the call count or the daily cost cap would be exceeded.

import { getServiceClient } from "./auth.ts";
import type { Skill } from "./schemas.ts";

// Per-skill daily call caps. Operators can override via env:
//   AI_LIMIT_RESUME_TAILOR=20, AI_DAILY_COST_CAP_USD=2.50
const DEFAULT_DAILY_LIMITS: Record<Skill, number> = {
  // Cheap classifiers — high cap.
  "query-parse":              200,
  "job-match-score":          150,
  "jd-analyze":                80,
  "resume-parse":              30,
  "interview-score":          120,
  "application-insight":       60,
  "followup-email":            40,
  // Mid tier.
  "interview-coach":           40,
  "cover-letter-generate":     40,
  // Heavy / costly.
  "resume-tailor":             20,
  "tailor-plan":               20,
  "resume-critique":           20,
  "interview-session-debrief": 20,
  "interview-intel-pack":      15,
  // Streaming conversational — capped per session count.
  "interview-session-step":   200,
};

const DEFAULT_DAILY_COST_CAP_USD = Number(
  Deno.env.get("AI_DAILY_COST_CAP_USD") || "5.00",
);

function limitFor(skill: Skill): number {
  const envKey = "AI_LIMIT_" + skill.toUpperCase().replace(/-/g, "_");
  const envVal = Number(Deno.env.get(envKey) || "0");
  if (envVal > 0) return envVal;
  return DEFAULT_DAILY_LIMITS[skill] ?? 50;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  /** Current bucket count for this user/skill/day, post-check. */
  bucketCount: number;
  /** Current daily total cost for this user across all skills. */
  dailyCostUsd: number;
}

/**
 * Read-only check before issuing the LLM call. Looks at TODAY's row for this
 * (user, skill) and the user's TOTAL daily cost. Returns a decision; caller
 * stops on `!allowed`. NO mutation here — call recordRateLimitUsage() AFTER
 * the LLM call succeeds (so failed/cached calls don't burn quota).
 */
export async function checkRateLimit(
  userId: string,
  skill: Skill,
): Promise<RateLimitDecision> {
  const admin = getServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const limit = limitFor(skill);

  // One round-trip: select counts for user/today.
  const { data, error } = await admin
    .from("ai_rate_limits")
    .select("skill, count, cost_usd")
    .eq("user_id", userId)
    .eq("bucket", today);

  if (error) {
    // Fail-open: telemetry/RLS issue shouldn't block the user from using AI.
    return { allowed: true, bucketCount: 0, dailyCostUsd: 0 };
  }

  const rows = (data ?? []) as { skill: string; count: number; cost_usd: number }[];
  const skillRow = rows.find((r) => r.skill === skill);
  const skillCount = skillRow?.count ?? 0;
  const dailyCost = rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);

  if (skillCount >= limit) {
    // Reset at midnight UTC — give an honest retry-after.
    const now = new Date();
    const tomorrow = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0,
    ));
    const retryAfter = Math.max(60, Math.round((tomorrow.getTime() - now.getTime()) / 1000));
    return {
      allowed: false,
      reason: `Daily limit reached for ${skill} (${limit}/day). Resets at midnight UTC.`,
      retryAfterSeconds: retryAfter,
      bucketCount: skillCount,
      dailyCostUsd: dailyCost,
    };
  }

  if (dailyCost >= DEFAULT_DAILY_COST_CAP_USD) {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0,
    ));
    const retryAfter = Math.max(60, Math.round((tomorrow.getTime() - now.getTime()) / 1000));
    return {
      allowed: false,
      reason: `Daily AI cost cap reached ($${DEFAULT_DAILY_COST_CAP_USD.toFixed(2)}). Resets at midnight UTC.`,
      retryAfterSeconds: retryAfter,
      bucketCount: skillCount,
      dailyCostUsd: dailyCost,
    };
  }

  return { allowed: true, bucketCount: skillCount, dailyCostUsd: dailyCost };
}

/**
 * Increment counter + cost after a successful billable call.
 * Fire-and-forget — caller awaits but never throws.
 */
export async function recordRateLimitUsage(
  userId: string,
  skill: Skill,
  costUsd: number,
): Promise<void> {
  try {
    const admin = getServiceClient();
    await admin.rpc("increment_ai_rate_limit", {
      p_user: userId,
      p_skill: skill,
      p_cost: Number(costUsd.toFixed(6)),
    });
  } catch {
    // Telemetry must not break the user request.
  }
}
