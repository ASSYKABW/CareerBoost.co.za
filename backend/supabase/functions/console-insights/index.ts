// POST /functions/v1/console-insights
// Body: { mock?: boolean }
// Auth: admin role + AAL2/MFA (getAuthedAdmin).
//
// The "what to improve" engine. A set of rule-based DETECTORS — each reads real
// data and, if a threshold trips, emits a ranked finding:
//   { sev, icon, tag, title, why, action, to }
// Deterministic, explainable, cheap; the numbers always come from SQL (no LLM
// guessing). Every detector is isolated in try/catch so one failure can't sink
// the board. Findings are ranked crit → warn → opp. {mock:true} → fixtures.
//
// This is the starter set; add detectors here as the product grows (a later
// phase can add an optional LLM pass to phrase the "why", but the thresholds
// stay the source of truth).
import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const DAY_MS = 86_400_000;
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }

type Sev = "crit" | "warn" | "opp";
interface Finding { sev: Sev; icon: string; tag: string; title: string; why: string; action: string; to: string; }
const SEV_RANK: Record<Sev, number> = { crit: 0, warn: 1, opp: 2 };

const MOCK = {
  _mock: true, total: 7,
  findings: [
    { sev: "opp", icon: "fa-rocket", tag: "High", title: "Mock interviews convert 3× — but only 9% of signups try one", why: "Free→Paid is 4.8% overall, yet 14% for users who run a mock interview. Surface it earlier in onboarding.", action: "Add onboarding step", to: "growth" },
    { sev: "warn", icon: "fa-user-slash", tag: "Activation", title: "38% of new signups never tailor a resume", why: "Resume tailoring is the core 'aha'. Users who skip it in week 1 retain at half the rate.", action: "View funnel", to: "growth" },
    { sev: "crit", icon: "fa-bolt", tag: "Cost", title: "resume-tailor AI cost +22% while cache hit-rate fell to 51%", why: "Prompt-cache efficiency dropped — spend is rising faster than usage.", action: "Inspect AI cost", to: "ai" },
    { sev: "opp", icon: "fa-arrow-up-right-dots", tag: "~R2,400/mo", title: "Pro users hit the voice-mock cap 3 days in", why: "11 of 18 Pro users maxed voice mocks before mid-month — an upgrade signal toward Career.", action: "Review upsell", to: "money" },
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
  if (body.mock === true) return jsonResponse({ ok: true, ...MOCK });

  const svc = getServiceClient();
  const findings: Finding[] = [];

  // ── D1: open incidents ────────────────────────────────────────────
  try {
    const { data } = await svc.from("admin_incidents")
      .select("title,severity,section").eq("status", "open")
      .order("opened_at", { ascending: false }).limit(4);
    for (const i of (data || []) as Array<Record<string, unknown>>) {
      const crit = i.severity === "critical";
      findings.push({
        sev: crit ? "crit" : "warn", icon: "fa-triangle-exclamation", tag: crit ? "Critical" : "Incident",
        title: String(i.title || "Open incident"),
        why: "Open incident in " + String(i.section || "the system") + " — acknowledge and resolve before it affects users.",
        action: "Review", to: "ai",
      });
    }
  } catch (_e) { /* skip detector */ }

  // ── D2: AI failure-rate spike (7d) ────────────────────────────────
  try {
    const { data } = await svc.from("ai_usage").select("status").gte("created_at", isoAgo(7)).limit(60000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    if (rows.length >= 20) {
      const failRate = (rows.filter((r) => r.status === "failed").length / rows.length) * 100;
      if (failRate >= 5) {
        findings.push({ sev: "crit", icon: "fa-bolt", tag: "Reliability", title: "AI failure rate is " + failRate.toFixed(1) + "% over the last 7 days", why: "Above the 5% alert line. Users are hitting errors on paid actions — check provider status and recent prompt changes.", action: "Inspect AI health", to: "ai" });
      } else if (failRate >= 2) {
        findings.push({ sev: "warn", icon: "fa-bolt", tag: "Reliability", title: "AI failure rate creeping up (" + failRate.toFixed(1) + "%)", why: "Still under the alert line but worth watching — a rising trend usually precedes an incident.", action: "Inspect AI health", to: "ai" });
      }
    }
  } catch (_e) { /* skip detector */ }

  // ── D3: activation gap (onboarding among recent signups) ──────────
  try {
    const { data } = await svc.from("profiles").select("onboarding_completed").gte("created_at", isoAgo(14)).limit(20000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    if (rows.length >= 10) {
      const incomplete = rows.filter((r) => r.onboarding_completed === false).length;
      const pct = Math.round((incomplete / rows.length) * 100);
      if (pct >= 30) {
        findings.push({ sev: "warn", icon: "fa-user-slash", tag: "Activation", title: pct + "% of the last 14 days of signups haven't finished onboarding", why: "Onboarding completion is the first activation gate. Users who stall here rarely reach the core 'aha' and churn quietly.", action: "View funnel", to: "growth" });
      }
    }
  } catch (_e) { /* skip detector */ }

  // ── D4: monetization headroom (paid ratio) ────────────────────────
  try {
    const [{ count: total }, { count: paid }] = await Promise.all([
      svc.from("profiles").select("user_id", { count: "exact", head: true }),
      svc.from("subscriptions").select("user_id", { count: "exact", head: true }).neq("plan_id", "free").eq("status", "active"),
    ]);
    if ((total || 0) >= 15) {
      const rate = ((paid || 0) / (total || 1)) * 100;
      if (rate < 5) {
        findings.push({ sev: "opp", icon: "fa-arrow-up-right-dots", tag: "Revenue", title: "Only " + rate.toFixed(1) + "% of users are on a paid plan", why: "Conversion is your biggest untouched lever at this stage. A targeted upgrade nudge on high-intent actions (after a tailor or mock) tends to move this most.", action: "Review funnel", to: "money" });
      }
    }
  } catch (_e) { /* skip detector */ }

  // ── D5: payment recovery ──────────────────────────────────────────
  try {
    const { count } = await svc.from("subscriptions").select("user_id", { count: "exact", head: true }).eq("status", "past_due");
    if (count && count > 0) {
      findings.push({ sev: "warn", icon: "fa-credit-card", tag: "Churn risk", title: count + " paid " + (count === 1 ? "subscription is" : "subscriptions are") + " past due", why: "Failed renewals are the most recoverable churn — a quick reminder or a card-update link often saves them before the plan lapses.", action: "Recover payments", to: "money" });
    }
  } catch (_e) { /* skip detector */ }

  findings.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]);
  return jsonResponse({ ok: true, findings: findings.slice(0, 8), total: findings.length });
}));
