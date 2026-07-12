// Active AI-provider probe — the RELIABLE health signal.
//
// The passive check (provider-health.ts) reads ai_usage failures, but ai-run's
// fallback silently recovers a dead provider, so those failures are never
// logged — a quota-429 or out-of-credit key shows as "idle". This module pings
// each configured provider with a 1-token call and classifies the result, so
// the Console (and the daily health-notify) see the truth.
//
// Cached ~10 min in kv_cache so opening the Console doesn't re-probe (4 tiny
// LLM calls) on every render; the daily health-notify forces a fresh probe.
import { callProvider, type LLMProvider, providerHasKey } from "./llm.ts";
import { buildKvKey, readKvCache, writeKvCache } from "./kv-cache.ts";

export interface ProviderProbe {
  id: string;
  label: string;
  /** healthy | credit | key | rate | errors | no-key */
  status: string;
  topup: string;
  error?: string;
}

const PROBE_TTL_SECONDS = 600;
const PROBE: Array<{ id: LLMProvider; model: string; label: string; topup: string }> = [
  { id: "gemini", model: "gemini-2.0-flash", label: "Google Gemini", topup: "https://aistudio.google.com/app/apikey" },
  { id: "openai", model: "gpt-4o-mini", label: "OpenAI", topup: "https://platform.openai.com/account/billing/overview" },
  { id: "groq", model: "llama-3.3-70b-versatile", label: "Groq", topup: "https://console.groq.com/keys" },
  { id: "anthropic", model: "claude-haiku-4-5", label: "Anthropic (Claude)", topup: "https://console.anthropic.com/settings/billing" },
];

async function probeOne(p: { id: LLMProvider; model: string; label: string; topup: string }): Promise<ProviderProbe> {
  if (!providerHasKey(p.id)) return { id: p.id, label: p.label, status: "no-key", topup: p.topup };
  try {
    // "json" in the prompt keeps Groq happy (it demands it when a JSON
    // response_format is in play) without affecting the others.
    await callProvider(p.id, { systemStable: 'Health probe — reply with this JSON: {"ok":true}', user: "ping (respond in json)", model: p.model, maxTokens: 12, timeoutMs: 10_000 });
    return { id: p.id, label: p.label, status: "healthy", topup: p.topup };
  } catch (e) {
    const msg = String((e as Error).message || e);
    let status = "errors";
    if (/credit|billing|payment|insufficient|out of credit|quota.*(exceed|exhaust)|exceed.*quota/i.test(msg)) status = "credit";
    else if (/invalid.{0,20}api.?key|unauthorized|\b401\b|authentication|permission_denied|expired.*key/i.test(msg)) status = "key";
    else if (/rate.?limit|\b429\b|too many requests|overloaded/i.test(msg)) status = "rate";
    // A 400 that isn't auth/quota/rate means the key reached the API and got a
    // validation error → the provider is UP; don't false-alarm.
    else if (/\b400\b|invalid.?request|response_format|must contain/i.test(msg)) status = "healthy";
    return { id: p.id, label: p.label, status, topup: p.topup, error: msg.slice(0, 140) };
  }
}

export async function probeProviders(force = false): Promise<ProviderProbe[]> {
  const key = await buildKvKey({ v: "provider-probe-1" });
  if (!force) {
    try {
      const cached = await readKvCache<ProviderProbe[]>("other", key);
      if (cached.payload && Array.isArray(cached.payload) && cached.payload.length) return cached.payload;
    } catch { /* miss */ }
  }
  const out = await Promise.all(PROBE.map(probeOne));
  writeKvCache("other", key, out, PROBE_TTL_SECONDS).catch(() => {});
  return out;
}
