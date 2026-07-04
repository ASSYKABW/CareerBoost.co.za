// Provider health — detects when an AI provider's key is dead or out of credit.
//
// ai-run records failures into ai_usage with the error TEXT (which carries the
// per-provider prefix from tryProviders, e.g. "anthropic: Anthropic HTTP 400:
// …credit balance is too low…"). The `provider` column is null on failures, so
// we classify by scanning that text. Successes DO carry `provider`, so we use
// those as the "the key works" signal.
//
// Consumed by console-ai-health (detailed panel) and console-pulse (banner),
// so the operator sees "Anthropic is out of credit — top up" without digging.
import { getServiceClient } from "./auth.ts";
import { getRuntimeConfig } from "./runtime-config.ts";

const DAY_MS = 86_400_000;

interface ProviderDef { id: string; label: string; env: string; topup: string }
const PROVIDERS: ProviderDef[] = [
  { id: "anthropic", label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY", topup: "https://console.anthropic.com/settings/billing" },
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY", topup: "https://platform.openai.com/account/billing/overview" },
  { id: "gemini", label: "Google Gemini", env: "GEMINI_API_KEY", topup: "https://aistudio.google.com/app/apikey" },
  { id: "groq", label: "Groq", env: "GROQ_API_KEY", topup: "https://console.groq.com/keys" },
];

// Order matters: check the most actionable/severe signatures first.
function classify(seg: string): string {
  if (/credit balance|insufficient (funds|credit|quota|balance)|billing|payment required|out of credit|quota.*(exceed|exhaust)/i.test(seg)) return "credit";
  if (/invalid.{0,20}api.?key|invalid_api_key|unauthorized|\b401\b|authentication_error|x-api-key|expired.*key|permission_denied/i.test(seg)) return "key";
  if (/rate.?limit|\b429\b|too many requests|overloaded|\b529\b/i.test(seg)) return "rate";
  return seg ? "errors" : "";
}

export interface ProviderHealth {
  id: string;
  label: string;
  configured: boolean;
  /** healthy | credit | key | rate | errors | no-key | idle */
  status: string;
  failures: number;
  successes: number;
  lastError: string;
  topup: string;
}

export async function getProviderHealth(): Promise<{ providers: ProviderHealth[]; critical: ProviderHealth[] }> {
  const svc = getServiceClient();
  const since = new Date(Date.now() - DAY_MS).toISOString();
  let rows: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("ai_usage").select("status,provider,error,created_at").gte("created_at", since).limit(20000);
    rows = (data || []) as Array<Record<string, unknown>>;
  } catch { /* empty on error */ }

  let overrides: Record<string, string> = {};
  try { overrides = await getRuntimeConfig<Record<string, string>>("provider_keys", {}); } catch { /* none */ }

  const providers: ProviderHealth[] = PROVIDERS.map((p) => {
    const configured = !!(Deno.env.get(p.env) || overrides[p.id]);
    const successes = rows.filter((r) => r.status === "success" && String(r.provider) === p.id).length;

    const counts: Record<string, number> = { credit: 0, key: 0, rate: 0, errors: 0 };
    let lastError = "";
    for (const r of rows) {
      if (r.status !== "failed") continue;
      const err = String(r.error || "");
      const idx = err.toLowerCase().indexOf(p.id + ":");
      const seg = idx >= 0 ? err.slice(idx, idx + 180) : "";
      if (!seg) continue;
      const c = classify(seg);
      if (c) { counts[c]++; if (!lastError) lastError = seg.slice(0, 150); }
    }
    const failures = counts.credit + counts.key + counts.rate + counts.errors;

    let status: string;
    if (!configured) status = "no-key";
    else if (counts.credit > 0) status = "credit";
    else if (counts.key > 0) status = "key";
    else if (counts.rate >= 3) status = "rate";
    else if (successes > 0) status = "healthy";
    else if (counts.errors > 0) status = "errors";
    else status = "idle";

    return { id: p.id, label: p.label, configured, status, failures, successes, lastError, topup: p.topup };
  });

  const critical = providers.filter((p) => p.status === "credit" || p.status === "key");
  return { providers, critical };
}
