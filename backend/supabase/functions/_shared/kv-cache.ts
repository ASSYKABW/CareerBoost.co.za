// Generic third-party API response cache — backed by public.kv_cache.
//
// Use case: paid integrations (Google CSE, Adzuna, etc.) where the same query
// from different users or the same user repeated rapidly yields identical
// upstream responses. Caching at this layer cuts integration cost dramatically
// without changing the user-facing UX.
//
// Distinct from ai_response_cache (response-cache.ts):
//   - Different namespaces per integration
//   - Generic JSON payload (no envelope assumption)
//   - Atomic hit-count bump via kv_cache_increment_hit RPC
//   - Service-role only (RLS deny for users)

import { getServiceClient } from "./auth.ts";

export type KvNamespace = "cse" | "adzuna" | "muse" | "rapidapi" | "other";

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Stable canonicalize — sorts keys recursively so JSON object key order
// doesn't fragment the cache.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    out.push(JSON.stringify(k) + ":" + canonicalize(obj[k]));
  }
  return "{" + out.join(",") + "}";
}

/** Build a cache key from any structured input. Includes a namespace string. */
export async function buildKvKey(parts: unknown): Promise<string> {
  return await sha256Hex(canonicalize(parts));
}

export interface KvReadResult<T> {
  payload: T | null;
  ageSeconds: number;
}

/**
 * Look up a cached payload. Returns { payload: null } on miss / expired.
 * Side effect: bumps hit_count async on hit (best-effort).
 */
export async function readKvCache<T = unknown>(
  namespace: KvNamespace,
  cacheKey: string,
): Promise<KvReadResult<T>> {
  try {
    const admin = getServiceClient();
    const { data, error } = await admin
      .from("kv_cache")
      .select("payload, created_at, expires_at")
      .eq("namespace", namespace)
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error || !data) return { payload: null, ageSeconds: 0 };
    const expiresAt = new Date(data.expires_at as string).getTime();
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return { payload: null, ageSeconds: 0 };
    }
    // Best-effort hit-count bump — don't await, don't throw.
    admin
      .rpc("kv_cache_increment_hit", { p_namespace: namespace, p_cache_key: cacheKey })
      .then(() => {}, () => {});
    const created = new Date(data.created_at as string).getTime();
    return {
      payload: data.payload as T,
      ageSeconds: Math.max(0, Math.round((Date.now() - created) / 1000)),
    };
  } catch {
    return { payload: null, ageSeconds: 0 };
  }
}

/**
 * Persist a payload. Fire-and-forget; failures are silent.
 *
 * @param ttlSeconds — how long to cache. Use 60*60*24 for 24h.
 */
export async function writeKvCache(
  namespace: KvNamespace,
  cacheKey: string,
  payload: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) return;
  try {
    const admin = getServiceClient();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await admin.from("kv_cache").upsert(
      {
        namespace,
        cache_key: cacheKey,
        payload,
        hit_count: 0,
        expires_at: expiresAt,
      },
      { onConflict: "namespace,cache_key" },
    );
  } catch {
    // Cache write failures must not break the request.
  }
}
