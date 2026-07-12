// POST /functions/v1/console-ai-health
// Body: { mock?: boolean }
// Auth: admin role + AAL2/MFA (getAuthedAdmin).
//
// Powers the Console "AI & Health" section (Phase 2): what AI costs, where it
// fails, and whether the system is up. Returns:
//   { aiHealth: { kpis[4], bySkill[], byModel[], incidents[], failures[] } }
//     - kpis:      AI spend 7d (token estimate) · AI calls 7d · failure rate · open incidents
//     - bySkill:   per-skill calls / est spend / failure rate
//     - byModel:   per-model calls / est spend
//     - incidents: open admin_incidents (needs-you)
//     - failures:  recent failed ai_usage rows (skill · model · error)
//
// Spend is a token-based ESTIMATE (ai_usage stores tokens, not cost) — same
// blended rate as console-pulse, pending the real per-model pricing join.
// Every block is isolated in try/catch; {mock:true} returns fixtures.
import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { getProviderHealth } from "../_shared/provider-health.ts";
import { getScoutHealth } from "../_shared/scout-health.ts";
import { probeProviders } from "../_shared/provider-probe.ts";
import { bustRuntimeConfig } from "../_shared/runtime-config.ts";

const DAY_MS = 86_400_000;
const USD_PER_M_INPUT = 1.0;
const USD_PER_M_OUTPUT = 5.0;
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }
function usd(n: number): string { return "$" + (Math.round(n * 100) / 100).toFixed(2); }
function pretty(skill: string): string { return String(skill || "—").replace(/-/g, " "); }
function tokenSpend(r: Record<string, unknown>): number {
  return ((Number(r.input_tokens) || 0) / 1e6) * USD_PER_M_INPUT + ((Number(r.output_tokens) || 0) / 1e6) * USD_PER_M_OUTPUT;
}
function bucketByDay(rows: Array<Record<string, unknown>>, field: string, n: number): number[] {
  const out = new Array(n).fill(0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const r of rows) {
    const v = r[field]; if (!v) continue;
    const d = new Date(String(v)); if (isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const idx = n - 1 - Math.round((today.getTime() - d.getTime()) / DAY_MS);
    if (idx >= 0 && idx < n) out[idx] += 1;
  }
  return out;
}

const MOCK = {
  _mock: true,
  kpis: [
    { key: "spend", label: "AI spend 7d (est)", tone: "amber", value: 128, fmt: "usd", delta: "-3%", deltaDir: "gd", spark: [22, 19, 21, 18, 17, 16, 15] },
    { key: "calls", label: "AI calls 7d", tone: "cyan", value: 1240, fmt: "int", delta: "+8%", deltaDir: "up", spark: [150, 168, 172, 180, 190, 185, 195] },
    { key: "failrate", label: "Failure rate", tone: "green", value: 0.4, fmt: "pct", delta: "-0.2pt", deltaDir: "gd", spark: [] },
    { key: "incidents", label: "Open incidents", tone: "amber", value: 1, fmt: "int", delta: "1 critical", deltaDir: "down", spark: [] },
  ],
  bySkill: [
    { skill: "resume tailor", calls: 420, spend: "$52.10", failRate: 0.5, tone: "green" },
    { skill: "cover letter generate", calls: 310, spend: "$28.40", failRate: 0.3, tone: "green" },
    { skill: "interview session step", calls: 260, spend: "$31.80", failRate: 1.2, tone: "amber" },
    { skill: "interview intel pack", calls: 150, spend: "$11.90", failRate: 0.0, tone: "green" },
    { skill: "bullet strengthen", calls: 100, spend: "$3.80", failRate: 0.0, tone: "green" },
  ],
  byModel: [
    { model: "claude-haiku-4-5", calls: 720, spend: "$18.20" },
    { model: "claude-sonnet-5", calls: 380, spend: "$78.40" },
    { model: "claude-opus-4-8", calls: 140, spend: "$31.40" },
  ],
  incidents: [{ title: "job-feed latency", severity: "critical", section: "health", when: "2026-06-30" }],
  providers: [
    { id: "anthropic", label: "Anthropic (Claude)", configured: true, status: "credit", failures: 12, successes: 0, lastError: "anthropic: HTTP 400 …credit balance is too low", topup: "https://console.anthropic.com/settings/billing" },
    { id: "openai", label: "OpenAI", configured: true, status: "healthy", failures: 0, successes: 84, lastError: "", topup: "https://platform.openai.com/account/billing/overview" },
    { id: "gemini", label: "Google Gemini", configured: true, status: "healthy", failures: 0, successes: 210, lastError: "", topup: "https://aistudio.google.com/app/apikey" },
    { id: "groq", label: "Groq", configured: false, status: "no-key", failures: 0, successes: 0, lastError: "", topup: "https://console.groq.com/keys" },
  ],
  critical: [{ id: "anthropic", label: "Anthropic (Claude)", status: "credit", topup: "https://console.anthropic.com/settings/billing" }],
  failures: [
    { skill: "interview session step", model: "claude-sonnet-5", error: "provider timeout (529)", when: "2026-06-30" },
    { skill: "resume tailor", model: "claude-haiku-4-5", error: "rate limit (429)", when: "2026-06-29" },
  ],
};

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedAdmin(req);
  } catch (err) {
    return errorResponse((err as Error).message, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  if (body.mock === true) return jsonResponse({ ok: true, aiHealth: MOCK });

  const svc = getServiceClient();

  // ── ai_usage over 14d (split cur/prev for deltas) ─────────────────
  let rows: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("ai_usage")
      .select("skill,model,status,error,input_tokens,output_tokens,created_at")
      .gte("created_at", isoAgo(14)).limit(80000);
    rows = (data || []) as Array<Record<string, unknown>>;
  } catch (_e) { /* empty */ }

  const cur = rows.filter((r) => String(r.created_at) >= isoAgo(7));
  const prev = rows.filter((r) => String(r.created_at) < isoAgo(7));
  const curSpend = cur.reduce((s, r) => s + tokenSpend(r), 0);
  const prevSpend = prev.reduce((s, r) => s + tokenSpend(r), 0);
  const curFails = cur.filter((r) => r.status === "failed").length;
  const failRate = cur.length ? (curFails / cur.length) * 100 : 0;

  function delta(c: number, p: number): { delta: string; dir: string } {
    if (!p) return { delta: c > 0 ? "new" : "steady", dir: "up" };
    const pc = Math.round(((c - p) / p) * 100);
    return { delta: (pc >= 0 ? "+" : "") + pc + "%", dir: pc >= 0 ? "up" : "down" };
  }
  const dSpend = delta(Math.round(curSpend), Math.round(prevSpend));
  const dCalls = delta(cur.length, prev.length);

  // ── by skill ──────────────────────────────────────────────────────
  const skillAgg: Record<string, { calls: number; spend: number; fails: number }> = {};
  for (const r of cur) {
    const k = String(r.skill || "unknown");
    const a = (skillAgg[k] = skillAgg[k] || { calls: 0, spend: 0, fails: 0 });
    a.calls += 1; a.spend += tokenSpend(r); if (r.status === "failed") a.fails += 1;
  }
  const bySkill = Object.keys(skillAgg).map((k) => {
    const a = skillAgg[k];
    const fr = a.calls ? (a.fails / a.calls) * 100 : 0;
    return { skill: pretty(k), calls: a.calls, spend: usd(a.spend), failRate: Math.round(fr * 10) / 10, tone: fr >= 5 ? "red" : fr >= 2 ? "amber" : "green" };
  }).sort((x, y) => y.calls - x.calls).slice(0, 8);

  // ── by model ──────────────────────────────────────────────────────
  const modelAgg: Record<string, { calls: number; spend: number }> = {};
  for (const r of cur) {
    const m = String(r.model || "unknown");
    const a = (modelAgg[m] = modelAgg[m] || { calls: 0, spend: 0 });
    a.calls += 1; a.spend += tokenSpend(r);
  }
  const byModel = Object.keys(modelAgg).map((m) => ({ model: m, calls: modelAgg[m].calls, spend: usd(modelAgg[m].spend) }))
    .sort((x, y) => y.calls - x.calls).slice(0, 6);

  // ── recent failures ───────────────────────────────────────────────
  const failures = cur.filter((r) => r.status === "failed")
    .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
    .slice(0, 8)
    .map((r) => ({ skill: pretty(String(r.skill)), model: String(r.model || "—"), error: String(r.error || "unknown error").slice(0, 120), when: String(r.created_at).slice(0, 10) }));

  // ── open incidents ────────────────────────────────────────────────
  const incidents: Array<Record<string, unknown>> = [];
  let criticalCount = 0;
  try {
    const { data } = await svc.from("admin_incidents").select("title,severity,section,opened_at").eq("status", "open").order("opened_at", { ascending: false }).limit(10);
    for (const i of (data || []) as Array<Record<string, unknown>>) {
      if (i.severity === "critical") criticalCount += 1;
      incidents.push({ title: String(i.title || "Incident"), severity: String(i.severity || "warning"), section: String(i.section || "system"), when: String(i.opened_at || "").slice(0, 10) });
    }
  } catch (_e) { /* ignore */ }

  const ph = await getProviderHealth();
  // Override each provider's status with the ACTIVE probe (the reliable signal —
  // catches out-of-credit / 429 that the passive ai_usage check can't see because
  // ai-run's fallback silently recovers them). Keep the passive counts + key config.
  let providers = ph.providers;
  let critical = ph.critical;
  try {
    // recheck=true (after the operator pastes a new key / clicks "Re-check now")
    // → drop the cached Console keys so getProviderKey reads the just-saved one,
    // and force a fresh probe instead of the 10-min cache.
    const recheck = body.recheck === true;
    if (recheck) bustRuntimeConfig("provider_keys");
    const probes = await probeProviders(recheck);
    const byId: Record<string, { status: string; error?: string }> = {};
    probes.forEach((p) => { byId[p.id] = { status: p.status, error: p.error }; });
    providers = ph.providers.map((p) => {
      const pr = byId[p.id];
      if (!pr || pr.status === "no-key") return p;
      return { ...p, status: pr.status, lastError: pr.error || p.lastError };
    });
    critical = providers.filter((p) => p.status === "credit" || p.status === "key");
  } catch (_e) { /* fall back to passive */ }

  let scout: Awaited<ReturnType<typeof getScoutHealth>> | null = null;
  try { scout = await getScoutHealth(); } catch (_e) { /* isolate */ }
  const aiHealth = {
    kpis: [
      { key: "spend", label: "AI spend 7d (est)", tone: "amber", fmt: "usd", value: Math.round(curSpend), delta: dSpend.delta, deltaDir: dSpend.dir === "down" ? "gd" : "down", spark: bucketByDay(cur, "created_at", 7) },
      { key: "calls", label: "AI calls 7d", tone: "cyan", fmt: "int", value: cur.length, delta: dCalls.delta, deltaDir: dCalls.dir, spark: bucketByDay(cur, "created_at", 7) },
      { key: "failrate", label: "Failure rate", tone: failRate >= 2 ? "amber" : "green", fmt: "pct", value: Math.round(failRate * 10) / 10, delta: failRate < 2 ? "healthy" : "watch", deltaDir: failRate < 2 ? "gd" : "down", spark: [] },
      { key: "incidents", label: "Open incidents", tone: incidents.length ? "amber" : "green", fmt: "int", value: incidents.length, delta: criticalCount ? criticalCount + " critical" : "all clear", deltaDir: incidents.length ? "down" : "up", spark: [] },
    ],
    bySkill, byModel, incidents, failures,
    providers, critical,
    scout,
  };
  return jsonResponse({ ok: true, aiHealth });
}));
