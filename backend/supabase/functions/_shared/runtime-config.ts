// Live operator settings (runtime_config table) with a short in-isolate cache.
//
// First consumer: ai_routing — per-skill LLM provider/model overrides set from
// the Console "Model Control" panel. ai-run consults getAiRouteOverride() on
// every call; the 45s cache means an admin change propagates in under a
// minute with ~zero added latency (one DB read per key per isolate per 45s).
//
// FAIL-OPEN by design: if the table is missing (migration not applied yet) or
// the read errors, we return the fallback so user-facing AI calls are never
// blocked by the config plumbing. The Console panel surfaces write errors
// loudly instead.
import { getServiceClient } from "./auth.ts";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 45_000;

export async function getRuntimeConfig<T>(key: string, fallback: T): Promise<T> {
  const hit = CACHE.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  try {
    const svc = getServiceClient();
    const { data, error } = await svc
      .from("runtime_config")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    const value = (!error && data && data.value !== undefined && data.value !== null)
      ? data.value as T
      : fallback;
    CACHE.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch {
    // Table missing / transient error — serve fallback, cache briefly so a
    // hard outage doesn't add a failing query to every AI call.
    CACHE.set(key, { value: fallback, expiresAt: Date.now() + TTL_MS });
    return fallback;
  }
}

/** Drop a cached key (console-config calls this after a write so the isolate
 *  that served the write sees it immediately; other isolates converge ≤45s). */
export function bustRuntimeConfig(key: string): void {
  CACHE.delete(key);
}

export interface AiRouteOverride {
  provider?: string;
  model?: string;
}

/** Merged admin override for a skill: skill-specific beats `_global`.
 *  Returns null when no override is set (the common case). */
export async function getAiRouteOverride(skill: string): Promise<AiRouteOverride | null> {
  const routing = await getRuntimeConfig<Record<string, AiRouteOverride>>("ai_routing", {});
  const s = routing ? routing[skill] : undefined;
  const g = routing ? routing["_global"] : undefined;
  if (!s && !g) return null;
  const provider = (s && s.provider) || (g && g.provider) || undefined;
  // A skill-specific entry owns its model; only inherit the global model when
  // the skill has no entry at all (a global model only makes sense alongside
  // the global provider).
  const model = s ? s.model : (g ? g.model : undefined);
  if (!provider && !model) return null;
  return { provider, model };
}
