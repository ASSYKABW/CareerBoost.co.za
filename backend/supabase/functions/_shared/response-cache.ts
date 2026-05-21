// Response cache for idempotent AI skill calls.
//
// Storage: public.ai_response_cache (see migration 0004).
// Keyed by sha256(skill + canonical_input_json). 24-hour default TTL.
// On cache hit, the Edge Function returns the saved envelope WITHOUT calling
// the LLM at all. Hit_count is incremented async for observability.
//
// IMPORTANT: We canonicalize the input to make hashes stable across:
//   - JSON key reordering (sort keys)
//   - Whitespace differences in nested strings (left intact — semantically meaningful)
//   - The non-deterministic requestId/promptVersion fields (excluded)
//   - The aiContext personalization payload (INCLUDED — different users get
//     different ranks for the same query, so they need different cache entries)

import { getServiceClient } from "./auth.ts";
import type { Skill } from "./schemas.ts";

// Per-skill TTL in seconds. Heavy creative skills are NOT cacheable on a fresh
// JD, but the same JD + same resume + same instruction yields the same plan,
// so 24h is a safe default. Set to 0 to disable cache for a skill.
const DEFAULT_TTL_SECONDS: Record<Skill, number> = {
  "query-parse":              60 * 60 * 24 * 7,   // 1 week — query→filters is purely structural
  "job-match-score":          60 * 60 * 24,
  "jd-analyze":               60 * 60 * 24 * 30,  // 30 days — JD parsing is deterministic
  "resume-parse":             60 * 60 * 24 * 30,  // resume rarely changes once uploaded
  "interview-score":          60 * 60 * 24,
  "interview-coach":          60 * 60 * 12,
  "cover-letter-generate":    0,                  // disabled: tone/length variations matter
  "resume-tailor":            60 * 60 * 6,
  "tailor-plan":              60 * 60 * 6,
  "resume-critique":          60 * 60 * 6,
  "interview-session-step":   0,                  // streaming + per-turn — never cache
  "interview-session-debrief":60 * 60 * 24,
  "interview-intel-pack":     60 * 60 * 24,
  "application-insight":      60 * 60 * 6,
  "followup-email":           0,                  // disabled: tone variations matter
  // Phase 5: skill plans are stable for the same skill+context for hours.
  "skill-action-plan":        60 * 60 * 12,
  // In-app guidance chat — disabled (chat is per-conversation and the
  // prompt context shifts with feature surface, so caching tends to
  // serve stale or wrong replies).
  "chat-assist":              0,
  // Single-bullet strengthen — same bullet text + role context is
  // deterministic enough to cache. 24h matches the user's edit
  // cadence (they tweak a bullet, then often re-strengthen later).
  "bullet-strengthen":        60 * 60 * 24,
};

// Stable JSON stringify that sorts object keys recursively.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  // Strip non-deterministic fields BEFORE hashing. requestId is per-call;
  // promptVersion shouldn't affect cache (a prompt change is what triggers a
  // bump, but cache is keyed on input not version — see hashKey below).
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (k === "requestId" || k === "request_id") continue;
    filtered[k] = obj[k];
  }
  return "{" + Object.entries(filtered)
    .map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v))
    .join(",") + "}";
}

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a cache key. Includes prompt_version so bumping the prompt invalidates cache. */
export async function buildCacheKey(
  skill: Skill,
  input: unknown,
  promptVersion: string,
): Promise<string> {
  const canonical = canonicalize({ skill, promptVersion, input });
  return await sha256Hex(canonical);
}

export interface CacheRead {
  envelope: Record<string, unknown> | null;
  ageSeconds: number;
}

/**
 * Look up a cached response envelope. Returns null on miss / expired / disabled.
 * Side effect: increments hit_count async (best-effort).
 */
export async function readResponseCache(
  skill: Skill,
  cacheKey: string,
): Promise<CacheRead> {
  if ((DEFAULT_TTL_SECONDS[skill] ?? 0) <= 0) {
    return { envelope: null, ageSeconds: 0 };
  }
  try {
    const admin = getServiceClient();
    const { data, error } = await admin
      .from("ai_response_cache")
      .select("envelope, created_at, expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error || !data) return { envelope: null, ageSeconds: 0 };
    const expiresAt = new Date(data.expires_at as string).getTime();
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return { envelope: null, ageSeconds: 0 };
    }
    const created = new Date(data.created_at as string).getTime();
    return {
      envelope: data.envelope as Record<string, unknown>,
      ageSeconds: Math.max(0, Math.round((Date.now() - created) / 1000)),
    };
  } catch {
    return { envelope: null, ageSeconds: 0 };
  }
}

/**
 * Persist a successful envelope. Fire-and-forget; failures are silent.
 */
export async function writeResponseCache(
  skill: Skill,
  cacheKey: string,
  envelope: Record<string, unknown>,
  promptVersion: string,
): Promise<void> {
  const ttl = DEFAULT_TTL_SECONDS[skill] ?? 0;
  if (ttl <= 0) return;
  try {
    const admin = getServiceClient();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await admin.from("ai_response_cache").upsert(
      {
        cache_key: cacheKey,
        skill,
        envelope,
        prompt_version: promptVersion,
        hit_count: 0,
        expires_at: expiresAt,
      },
      { onConflict: "cache_key" },
    );
  } catch {
    // Cache failures must not break the request.
  }
}
