// POST /functions/v1/console-pulse
// Body: { range?: "24h" | "7d" | "30d", mock?: boolean }
// Auth: admin role + AAL2/MFA (getAuthedAdmin), same envelope as every admin fn.
//
// Powers the new Console "Pulse" screen. Returns one payload:
//   { pulse: { range, kpis[6], northStar, attention[], feed[], spenders[] } }
//
// Strategy: at the current (pre-traction) scale we fetch bounded recent rows
// via the service client and aggregate in TS — the same approach admin-overview
// uses. Every metric is computed in its own try/catch and degrades to a safe
// fallback, so a single bad query NEVER 500s the whole board. Pass {mock:true}
// to get fixtures (deploy smoke-test without touching data).
import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

type Range = "24h" | "7d" | "30d";
const DAY_MS = 86_400_000;

// Real ZAR monthly prices (mirror plan_catalog / landing pricing).
const PRICE_ZAR: Record<string, number> = { plus: 210, pro: 380, career: 699 };
// Rough blended token pricing (USD per 1M tokens). ai_usage stores tokens but
// not cost, so spend is a token-based ESTIMATE until we join the real per-model
// pricing table (_shared/pricing.ts). Conservative blended rate across models.
const USD_PER_M_INPUT = 1.0;
const USD_PER_M_OUTPUT = 5.0;

function rangeDays(r: Range): number { return r === "24h" ? 1 : r === "30d" ? 30 : 7; }
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }

// Bucket rows into `buckets` daily counts (oldest→newest) by an ISO date field.
function bucketByDay(rows: Array<Record<string, unknown>>, field: string, buckets: number): number[] {
  const out = new Array(buckets).fill(0);
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  for (const row of rows) {
    const v = row[field];
    if (!v) continue;
    const d = new Date(String(v)); if (isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((todayMid.getTime() - d.getTime()) / DAY_MS);
    const idx = buckets - 1 - diff;
    if (idx >= 0 && idx < buckets) out[idx] += 1;
  }
  return out;
}
function pctDelta(cur: number, prev: number): { delta: string; dir: string } {
  if (!prev) return { delta: cur > 0 ? "new" : "steady", dir: "up" };
  const p = Math.round(((cur - prev) / prev) * 100);
  return { delta: (p >= 0 ? "+" : "") + p + "%", dir: p >= 0 ? "up" : "down" };
}

function mockPulse(range: Range) {
  return {
    _mock: true, range,
    kpis: [
      { key: "signups", label: "New signups", tone: "cyan", value: 86, fmt: "int", delta: "+14%", deltaDir: "up", spark: [8, 11, 9, 13, 12, 16, 17] },
      { key: "active", label: "Active users", tone: "violet", value: 148, fmt: "int", delta: "+6%", deltaDir: "up", spark: [120, 126, 124, 131, 138, 142, 148] },
      { key: "revenue", label: "MRR (ZAR)", tone: "green", value: 4120, fmt: "zar", delta: "+22%", deltaDir: "up", spark: [1900, 2300, 2600, 2900, 3400, 3800, 4120] },
      { key: "paid", label: "Paid subs", tone: "cyan", value: 7, fmt: "int", delta: "+2", deltaDir: "up", spark: [3, 4, 4, 5, 6, 6, 7] },
      { key: "aispend", label: "AI spend (est)", tone: "amber", value: 128, fmt: "usd", delta: "-3%", deltaDir: "gd", spark: [22, 19, 21, 18, 17, 16, 15] },
      { key: "errors", label: "AI error rate", tone: "green", value: 0.4, fmt: "pct", delta: "-0.2pt", deltaDir: "gd", spark: [9, 8, 7, 6, 6, 5, 4] },
    ],
    northStar: { title: "New activations / day", trend: "▲ 18% vs prev", cur: [8, 10, 9, 12, 11, 14, 13, 16, 15, 18], prev: [6, 7, 8, 8, 10, 10, 12, 12, 14, 14] },
    attention: [{ icon: "fa-triangle-exclamation", tone: "red", title: "Open incident", sub: "sample", count: 1, action: "Review" }],
    feed: [{ text: "<b>Sample event</b>", meta: "mock", tone: "cyan" }],
    spenders: [{ name: "Sample", email: "—", plan: "Pro", planTone: "violet", calls: 0, spend: "$0.00", status: "normal", statusTone: "green" }],
  };
}

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
  try { body = await req.json(); } catch { /* empty body ok */ }
  const range: Range = (["24h", "7d", "30d"].includes(String(body.range)) ? body.range : "7d") as Range;
  if (body.mock === true) return jsonResponse({ ok: true, pulse: mockPulse(range) });

  const svc = getServiceClient();
  const days = rangeDays(range);
  const sinceCur = isoAgo(days);
  const sincePrev = isoAgo(days * 2);
  const since30 = isoAgo(30);
  const sparkBuckets = days === 1 ? 12 : days === 30 ? 30 : 7;

  // ── KPI: signups ──────────────────────────────────────────────────
  let kSignups = { value: 0, delta: "steady", dir: "up", spark: [] as number[], prevSpark: [] as number[] };
  try {
    const { data } = await svc.from("profiles").select("created_at").gte("created_at", sincePrev).limit(20000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const curRows = rows.filter((r) => String(r.created_at) >= sinceCur);
    const prevRows = rows.filter((r) => String(r.created_at) < sinceCur);
    const d = pctDelta(curRows.length, prevRows.length);
    // prev series for the north-star chart: bucket the previous window over
    // 2N days, take the first N (the shifted window), aligned oldest→newest.
    const prevSpark = bucketByDay(prevRows, "created_at", sparkBuckets * 2).slice(0, sparkBuckets);
    kSignups = { value: curRows.length, delta: d.delta, dir: d.dir, spark: bucketByDay(curRows, "created_at", sparkBuckets), prevSpark };
  } catch (_e) { /* keep fallback */ }

  // ── KPI: active users (distinct over the window) ──────────────────
  let kActive = { value: 0, delta: "steady", dir: "up", spark: [] as number[] };
  try {
    const { data } = await svc.from("usage_sessions").select("user_id,last_activity_at").gte("last_activity_at", sincePrev).limit(40000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const cur = new Set(rows.filter((r) => String(r.last_activity_at) >= sinceCur).map((r) => r.user_id)).size;
    const prev = new Set(rows.filter((r) => String(r.last_activity_at) < sinceCur).map((r) => r.user_id)).size;
    const d = pctDelta(cur, prev);
    // Spark = sessions/day across the window (cheap proxy for the active trend).
    const spark = bucketByDay(rows, "last_activity_at", sparkBuckets);
    kActive = { value: cur, delta: d.delta, dir: d.dir, spark };
  } catch (_e) { /* keep fallback */ }

  // ── KPI: MRR (ZAR) + paid subs ────────────────────────────────────
  let kRevenue = { value: 0, delta: "steady", dir: "up", spark: [] as number[] };
  let kPaid = { value: 0, delta: "steady", dir: "up", spark: [] as number[] };
  try {
    const { data } = await svc.from("subscriptions").select("plan_id,status,created_at").neq("plan_id", "free").limit(20000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const activePaid = rows.filter((r) => r.status === "active" || r.status === "trialing" || r.status === "past_due");
    const mrr = activePaid.reduce((sum, r) => sum + (PRICE_ZAR[String(r.plan_id)] || 0), 0);
    const newPaidCur = rows.filter((r) => String(r.created_at) >= sinceCur).length;
    const newPaidPrev = rows.filter((r) => String(r.created_at) >= sincePrev && String(r.created_at) < sinceCur).length;
    const dPaid = pctDelta(newPaidCur, newPaidPrev);
    kRevenue = { value: mrr, delta: "MRR", dir: "up", spark: bucketByDay(rows, "created_at", sparkBuckets) };
    kPaid = { value: activePaid.length, delta: (newPaidCur >= 0 ? "+" : "") + newPaidCur + " new", dir: dPaid.dir, spark: bucketByDay(rows, "created_at", sparkBuckets) };
  } catch (_e) { /* keep fallback */ }

  // ── KPI: AI spend (token estimate) + error rate ───────────────────
  let kSpend = { value: 0, delta: "steady", dir: "gd", spark: [] as number[] };
  let kErrors = { value: 0, delta: "steady", dir: "gd", spark: [] as number[] };
  const topSpenders: Array<{ user_id: string; calls: number }> = [];
  try {
    const { data } = await svc.from("ai_usage").select("status,created_at,input_tokens,output_tokens,user_id").gte("created_at", sincePrev).limit(60000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const cur = rows.filter((r) => String(r.created_at) >= sinceCur);
    const prev = rows.filter((r) => String(r.created_at) < sinceCur);
    const spendOf = (rs: Array<Record<string, unknown>>) =>
      rs.reduce((s, r) => s + ((Number(r.input_tokens) || 0) / 1e6) * USD_PER_M_INPUT + ((Number(r.output_tokens) || 0) / 1e6) * USD_PER_M_OUTPUT, 0);
    const curSpend = spendOf(cur), prevSpend = spendOf(prev);
    const dSpend = pctDelta(Math.round(curSpend), Math.round(prevSpend));
    kSpend = { value: Math.round(curSpend), delta: dSpend.delta, dir: dSpend.dir === "down" ? "gd" : "down", spark: bucketByDay(cur, "created_at", sparkBuckets) };
    const failRate = cur.length ? (cur.filter((r) => r.status === "failed").length / cur.length) * 100 : 0;
    kErrors = { value: Math.round(failRate * 10) / 10, delta: failRate < 2 ? "healthy" : "watch", dir: failRate < 2 ? "gd" : "down", spark: [] };
    // Top spenders by call count over the window.
    const byUser: Record<string, number> = {};
    for (const r of cur) { const u = String(r.user_id || ""); if (u) byUser[u] = (byUser[u] || 0) + 1; }
    Object.keys(byUser).sort((a, b) => byUser[b] - byUser[a]).slice(0, 5).forEach((u) => topSpenders.push({ user_id: u, calls: byUser[u] }));
  } catch (_e) { /* keep fallback */ }

  // ── Attention queue (open incidents + past-due payments) ──────────
  const attention: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("admin_incidents").select("id,title,severity,section,opened_at").eq("status", "open").order("opened_at", { ascending: false }).limit(10);
    for (const i of (data || []) as Array<Record<string, unknown>>) {
      attention.push({ kind: "incident", id: String(i.id), icon: "fa-triangle-exclamation", tone: i.severity === "critical" ? "red" : "amber", title: String(i.title || "Incident"), sub: String(i.section || "system") + " · since " + String(i.opened_at || "").slice(0, 10), count: 1 });
    }
  } catch (_e) { /* ignore */ }
  try {
    const { count } = await svc.from("subscriptions").select("user_id", { count: "exact", head: true }).eq("status", "past_due");
    if (count && count > 0) attention.push({ kind: "payments", icon: "fa-credit-card", tone: "amber", title: "Failed payments", sub: "renewal retry pending", count });
  } catch (_e) { /* ignore */ }

  // Live promo state → powers the real Start/Stop promo quick action.
  let promo: Record<string, unknown> = { active: false, percent: 0, endDate: null };
  try {
    const { data } = await svc.from("promo_settings").select("enabled,percent,end_date").eq("id", 1).maybeSingle();
    if (data) promo = { active: !!data.enabled, percent: Number(data.percent) || 0, endDate: data.end_date ? String(data.end_date) : null };
  } catch (_e) { /* keep default */ }

  // ── Activity feed (recent events) ─────────────────────────────────
  const feed: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("usage_events").select("event_name,occurred_at,module").order("occurred_at", { ascending: false }).limit(12);
    for (const e of (data || []) as Array<Record<string, unknown>>) {
      feed.push({ text: "<b>" + String(e.event_name || "event").replace(/_/g, " ") + "</b>", meta: String(e.module || "app"), tone: "cyan" });
    }
  } catch (_e) { /* ignore */ }

  // ── Resolve spender emails ────────────────────────────────────────
  const spenders: Array<Record<string, unknown>> = [];
  for (const s of topSpenders) {
    let email = "—", plan = "Free";
    try {
      const { data } = await svc.auth.admin.getUserById(s.user_id);
      email = String(data?.user?.email || "—");
    } catch (_e) { /* deleted user */ }
    try {
      const { data } = await svc.from("subscriptions").select("plan_id").eq("user_id", s.user_id).maybeSingle();
      if (data?.plan_id) plan = String(data.plan_id).charAt(0).toUpperCase() + String(data.plan_id).slice(1);
    } catch (_e) { /* ignore */ }
    const flagged = s.calls > 150 && plan === "Free";
    spenders.push({
      id: s.user_id,
      name: email.split("@")[0], email, plan, planTone: plan === "Free" ? "dim" : "cyan",
      calls: s.calls, spend: "$" + (s.calls * 0.012).toFixed(2),
      status: flagged ? "flagged" : "normal", statusTone: flagged ? "red" : "green",
    });
  }

  const pulse = {
    range,
    kpis: [
      { key: "signups", label: "New signups", tone: "cyan", fmt: "int", value: kSignups.value, delta: kSignups.delta, deltaDir: kSignups.dir, spark: kSignups.spark },
      { key: "active", label: "Active users", tone: "violet", fmt: "int", value: kActive.value, delta: kActive.delta, deltaDir: kActive.dir, spark: kActive.spark },
      { key: "revenue", label: "MRR (ZAR)", tone: "green", fmt: "zar", value: kRevenue.value, delta: kRevenue.delta, deltaDir: kRevenue.dir, spark: kRevenue.spark },
      { key: "paid", label: "Paid subs", tone: "cyan", fmt: "int", value: kPaid.value, delta: kPaid.delta, deltaDir: kPaid.dir, spark: kPaid.spark },
      { key: "aispend", label: "AI spend (est)", tone: "amber", fmt: "usd", value: kSpend.value, delta: kSpend.delta, deltaDir: kSpend.dir, spark: kSpend.spark },
      { key: "errors", label: "AI error rate", tone: "green", fmt: "pct", value: kErrors.value, delta: kErrors.delta, deltaDir: kErrors.dir, spark: kErrors.spark },
    ],
    northStar: { title: "New signups / day", trend: "vs previous " + days + "d", cur: kSignups.spark, prev: kSignups.prevSpark },
    promo,
    attention,
    feed: feed.length ? feed : [{ text: "<b>No recent events</b>", meta: "quiet", tone: "cyan" }],
    spenders,
  };
  return jsonResponse({ ok: true, pulse });
}));
