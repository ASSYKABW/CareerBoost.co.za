// POST /functions/v1/admin-credentials
//
// Admin-only status check for every API key the app depends on. Returns
// "set / not set" for each known Supabase Edge Function secret WITHOUT
// ever returning the value itself.
//
// This powers the admin "API Credentials" panel which surfaces:
//   - which keys are currently configured
//   - which are missing
//   - the copy-paste `npx supabase secrets set ...` command to rotate
//
// Why not also write secrets here?
//   Storing API keys in our database (so the admin UI could "save" them)
//   would put us one RLS bug, one backup, one stray console.log away from
//   global key leakage. Keys live in Supabase's own secret store; rotation
//   happens via the supabase CLI. This function is read-only and never
//   returns secret values.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin } from "../_shared/auth.ts";

interface SecretSpec {
  /** Env var name as it appears in supabase secrets. */
  name: string;
  /** Human-readable label for the admin UI. */
  label: string;
  /** Category for grouping in the UI. */
  category: "ai" | "job-boards" | "search" | "billing" | "infrastructure";
  /** Which provider / service this belongs to. Used to group related keys. */
  service: string;
  /** One-line "what breaks without this" hint shown under the row. */
  purpose: string;
  /** Required for the service to work at all. Missing = users see errors. */
  required: boolean;
}

// Catalog of every key we care about. Add new rows here whenever a new
// service ships — the UI auto-renders them. Order = display order.
const CATALOG: SecretSpec[] = [
  // ---- AI providers ----------------------------------------------------
  {
    name: "ANTHROPIC_API_KEY", label: "Anthropic API key",
    category: "ai", service: "Anthropic (Claude)",
    purpose: "Resume tailoring, cover letters, interview prep, AI chat panel — Claude Sonnet + Haiku.",
    required: false,
  },
  {
    name: "OPENAI_API_KEY", label: "OpenAI API key",
    category: "ai", service: "OpenAI",
    purpose: "Follow-up email drafts, jobs-rerank embeddings (text-embedding-3-small), fallback for several skills.",
    required: false,
  },
  {
    name: "GEMINI_API_KEY", label: "Google Gemini API key",
    category: "ai", service: "Google Gemini",
    purpose: "Cheap-tier classifiers: query-parse, job-match-score, jd-analyze (Gemini 2.0 Flash).",
    required: false,
  },
  {
    name: "GROQ_API_KEY", label: "Groq API key",
    category: "ai", service: "Groq",
    purpose: "Optional fallback provider in the LLM routing chain. Skip if you don't use Groq.",
    required: false,
  },

  // ---- Job boards ------------------------------------------------------
  {
    name: "ADZUNA_APP_ID", label: "Adzuna App ID",
    category: "job-boards", service: "Adzuna",
    purpose: "8-country job fan-out in jobs-search. App ID + Key are both required for Adzuna to return any results.",
    required: false,
  },
  {
    name: "ADZUNA_APP_KEY", label: "Adzuna App Key",
    category: "job-boards", service: "Adzuna",
    purpose: "8-country job fan-out in jobs-search. App ID + Key are both required for Adzuna to return any results.",
    required: false,
  },

  // ---- LinkedIn-style external search (Google CSE) --------------------
  {
    name: "GOOGLE_CSE_API_KEY", label: "Google CSE API key",
    category: "search", service: "Google Programmable Search",
    purpose: "LinkedIn / Indeed X-ray search in external-search. Without this CSE results stay empty.",
    required: false,
  },
  {
    name: "GOOGLE_CSE_CX", label: "Google CSE engine ID (cx)",
    category: "search", service: "Google Programmable Search",
    purpose: "The custom search engine id paired with the API key above. Both required together.",
    required: false,
  },

  // ---- Billing ---------------------------------------------------------
  {
    name: "STRIPE_SECRET_KEY", label: "Stripe secret key",
    category: "billing", service: "Stripe",
    purpose: "Checkout sessions + customer portal. Required for paid plans to work.",
    required: false,
  },
  {
    name: "STRIPE_WEBHOOK_SECRET", label: "Stripe webhook signing secret",
    category: "billing", service: "Stripe",
    purpose: "Verifies webhook authenticity in stripe-webhook. Without this, subscription state can't sync.",
    required: false,
  },

  // ---- Infrastructure (managed by Supabase, can't be rotated by us) ---
  {
    name: "SUPABASE_URL", label: "Supabase project URL",
    category: "infrastructure", service: "Supabase",
    purpose: "Auto-set by Supabase. Not rotatable here.",
    required: true,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase service role key",
    category: "infrastructure", service: "Supabase",
    purpose: "Auto-set by Supabase. Rotation is done via the Supabase dashboard, not the CLI.",
    required: true,
  },
];

function isSet(name: string): boolean {
  const v = Deno.env.get(name);
  return typeof v === "string" && v.trim().length > 0;
}

// Provider-level "is this whole service usable?" rollup. A service like
// Adzuna needs BOTH app id AND app key — the UI uses this to render a
// single chip per service instead of two confusing per-env-var chips.
function serviceRollup(items: SecretSpec[]): Record<string, { set: boolean; missing: string[] }> {
  const groups: Record<string, SecretSpec[]> = {};
  for (const item of items) {
    if (!groups[item.service]) groups[item.service] = [];
    groups[item.service].push(item);
  }
  const out: Record<string, { set: boolean; missing: string[] }> = {};
  for (const service of Object.keys(groups)) {
    const members = groups[service];
    const missing = members.filter((m) => !isSet(m.name)).map((m) => m.name);
    out[service] = { set: missing.length === 0, missing };
  }
  return out;
}

// -----------------------------------------------------------------------
// Health checks — actually ping each provider with the configured key.
//
// "Set" only tells us the env var is non-empty. That doesn't mean the
// key works: it could be revoked, the account could be out of credit,
// the provider could be down. Each checker hits the cheapest "is this
// usable?" endpoint the provider offers (usually GET /models or an
// equivalent metadata call) with a tight 5s timeout.
//
// Returns:
//   ok                — auth succeeded, provider is reachable
//   unauthorized      — 401/403, key revoked or wrong
//   rate_limited      — 429, key works but throttled (still ok-ish)
//   quota_exhausted   — billing dead (best-effort detection from error body)
//   network_error     — fetch threw / timeout
//   not_configured    — env var not set
//   not_supported     — service has no programmatic health check
// -----------------------------------------------------------------------

type HealthStatus =
  | "ok"
  | "unauthorized"
  | "rate_limited"
  | "quota_exhausted"
  | "network_error"
  | "not_configured"
  | "not_supported";

interface CheckResult {
  ok: boolean;
  status: HealthStatus;
  message: string;
  latencyMs?: number;
  httpStatus?: number;
}

const CHECK_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function interpretHttp(status: number, bodySnippet: string): { ok: boolean; status: HealthStatus; message: string } {
  if (status >= 200 && status < 300) return { ok: true, status: "ok", message: "Reachable." };
  if (status === 401 || status === 403) return { ok: false, status: "unauthorized", message: "Auth failed (key invalid or revoked)." };
  if (status === 429) return { ok: false, status: "rate_limited", message: "Rate limited — key valid but throttled." };
  if (status === 402) return { ok: false, status: "quota_exhausted", message: "Billing required — no credit." };
  const isQuota = /quota|billing|credit|insufficient|exceeded/i.test(bodySnippet);
  if (status >= 400 && status < 500 && isQuota) return { ok: false, status: "quota_exhausted", message: "Provider reports quota / billing issue." };
  return { ok: false, status: "network_error", message: "HTTP " + status + (bodySnippet ? " — " + bodySnippet.slice(0, 80) : "") };
}

async function checkAnthropic(): Promise<CheckResult> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, status: "not_configured", message: "Key not set." };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

async function checkOpenAI(): Promise<CheckResult> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return { ok: false, status: "not_configured", message: "Key not set." };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/models?limit=1", {
      method: "GET",
      headers: { "Authorization": "Bearer " + key },
    });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

async function checkGemini(): Promise<CheckResult> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { ok: false, status: "not_configured", message: "Key not set." };
  const started = Date.now();
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key) + "&pageSize=1";
    const res = await fetchWithTimeout(url, { method: "GET" });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

async function checkGroq(): Promise<CheckResult> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return { ok: false, status: "not_configured", message: "Key not set." };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: { "Authorization": "Bearer " + key },
    });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

async function checkAdzuna(): Promise<CheckResult> {
  const id = Deno.env.get("ADZUNA_APP_ID");
  const sec = Deno.env.get("ADZUNA_APP_KEY");
  if (!id || !sec) return { ok: false, status: "not_configured", message: "App ID and Key both required." };
  const started = Date.now();
  try {
    const url = "https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=" + encodeURIComponent(id) +
                "&app_key=" + encodeURIComponent(sec) + "&results_per_page=1";
    const res = await fetchWithTimeout(url, { method: "GET" });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

async function checkGoogleCSE(): Promise<CheckResult> {
  const key = Deno.env.get("GOOGLE_CSE_API_KEY");
  const cx = Deno.env.get("GOOGLE_CSE_CX");
  if (!key || !cx) return { ok: false, status: "not_configured", message: "API key and engine ID both required." };
  const started = Date.now();
  try {
    const url = "https://customsearch.googleapis.com/customsearch/v1?key=" + encodeURIComponent(key) +
                "&cx=" + encodeURIComponent(cx) + "&q=test&num=1";
    const res = await fetchWithTimeout(url, { method: "GET" });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

async function checkStripe(): Promise<CheckResult> {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return { ok: false, status: "not_configured", message: "Key not set." };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.stripe.com/v1/account", {
      method: "GET",
      headers: { "Authorization": "Bearer " + key },
    });
    const body = await res.text().catch(() => "");
    return { ...interpretHttp(res.status, body), latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (e) {
    return { ok: false, status: "network_error", message: String((e as Error).message).slice(0, 120) };
  }
}

// Map service label (matches CATALOG[].service) → checker. Services without
// an entry get not_supported status (Supabase infra falls in this bucket —
// the function is already authenticated via Supabase, so trivially "ok").
const CHECKERS: Record<string, () => Promise<CheckResult>> = {
  "Anthropic (Claude)": checkAnthropic,
  "OpenAI": checkOpenAI,
  "Google Gemini": checkGemini,
  "Groq": checkGroq,
  "Adzuna": checkAdzuna,
  "Google Programmable Search": checkGoogleCSE,
  "Stripe": checkStripe,
};

async function runCheck(service: string): Promise<CheckResult> {
  const fn = CHECKERS[service];
  if (!fn) return { ok: false, status: "not_supported", message: "No health check available for this service." };
  return await fn();
}

interface RequestBody {
  /** Optional: check one specific service. Omit to skip checks (status only). */
  check?: string;
  /** Optional: check all services in parallel (admin pressed "Test all"). */
  checkAll?: boolean;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedAdmin(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: RequestBody = {};
  try {
    body = await req.json() as RequestBody;
  } catch {
    body = {};
  }

  const status = CATALOG.map((spec) => ({
    name: spec.name,
    label: spec.label,
    category: spec.category,
    service: spec.service,
    purpose: spec.purpose,
    required: spec.required,
    set: isSet(spec.name),
  }));

  // Optional health check phase.
  let checks: Record<string, CheckResult> | null = null;
  if (body.check) {
    checks = { [body.check]: await runCheck(body.check) };
  } else if (body.checkAll === true) {
    // Run all known checkers in parallel. Each has its own 5s timeout, so
    // the whole batch caps out at ~5s wall time even if every provider hangs.
    const services = Object.keys(CHECKERS);
    const results = await Promise.all(services.map((s) => runCheck(s)));
    checks = {};
    services.forEach((s, i) => { checks![s] = results[i]; });
  }

  return jsonResponse({
    ok: true,
    catalog: status,
    services: serviceRollup(CATALOG),
    checks: checks,
    projectRef: (function () {
      const url = Deno.env.get("SUPABASE_URL") || "";
      const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\./i);
      return m ? m[1] : "";
    })(),
    generatedAt: new Date().toISOString(),
  });
});
