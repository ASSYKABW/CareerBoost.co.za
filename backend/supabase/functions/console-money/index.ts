// POST /functions/v1/console-money
// Body: { mock?: boolean }
// Auth: admin role + AAL2/MFA (getAuthedAdmin).
//
// Powers the Console "Money" section (Phase 2). Returns one payload:
//   { money: { kpis[4], plans[], failed[], promo, } }
//   - kpis:   MRR (ZAR), active paid, churn (30d), past due
//   - plans:  active-paid breakdown by plan (count + MRR)
//   - failed: past-due subscriptions (email + plan) — recoverable churn
//   - promo:  current campaign (promo_settings) + grant stats (promo_grants)
//
// ZAR-native (Paystack settles in ZAR). Every block is isolated in try/catch so
// one bad query never 500s the board. {mock:true} returns fixtures.
import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const DAY_MS = 86_400_000;
const PRICE_ZAR: Record<string, number> = { plus: 210, pro: 380, career: 699 };
const PAID_PLANS = ["plus", "pro", "career"];
const ACTIVE_STATES = ["active", "trialing", "past_due"];

// A comp (admin-granted free months) writes plan_id='pro'/status='active' with
// no processor behind it — identical to a real subscription apart from the
// money. Counting those as MRR reports revenue that does not exist, and it
// inflates by the FULL plan price on the first grant. Revenue therefore means
// "a payment processor is attached"; access is counted separately.
function isRealPayer(s: Record<string, unknown>): boolean {
  return !!(s.payment_processor || s.stripe_subscription_id || s.paystack_subscription_code);
}
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }
function titleCase(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function planTone(p: string): string { return p === "career" ? "violet" : "cyan"; }
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
    { key: "mrr", label: "MRR (ZAR)", tone: "green", value: 4890, fmt: "zar", delta: "+2 paid", deltaDir: "up", spark: [2600, 2900, 3400, 3800, 4200, 4600, 4890] },
    { key: "paid", label: "Active paid", tone: "cyan", value: 12, fmt: "int", delta: "+3 (30d)", deltaDir: "up", spark: [7, 8, 9, 10, 11, 11, 12] },
    { key: "churn", label: "Churn (30d)", tone: "amber", value: 2, fmt: "int", delta: "14% of paid", deltaDir: "down", spark: [0, 1, 0, 0, 1, 0, 0] },
    { key: "pastdue", label: "Past due", tone: "amber", value: 1, fmt: "int", delta: "recover", deltaDir: "down", spark: [] },
  ],
  plans: [
    { plan: "Plus", planTone: "cyan", count: 5, mrr: 1050 },
    { plan: "Pro", planTone: "cyan", count: 4, mrr: 1520 },
    { plan: "Career", planTone: "violet", count: 3, mrr: 2097 },
  ],
  failed: [{ email: "sample@example.com", plan: "Pro", since: "2026-06-27" }],
  promo: { active: true, percent: 30, endDate: "2026-07-31", grants: { active: 4, redeemed: 9 } },
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
  if (body.mock === true) return jsonResponse({ ok: true, money: MOCK });

  const svc = getServiceClient();

  // ── Subscriptions (single fetch, aggregate in TS) ─────────────────
  let subs: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc
      .from("subscriptions")
      .select("plan_id,status,created_at,canceled_at,current_period_end,payment_processor,stripe_subscription_id,paystack_subscription_code")
      .limit(20000);
    subs = (data || []) as Array<Record<string, unknown>>;
  } catch (_e) { /* leave empty */ }

  // Everyone on a paid tier — bought or comped. This is ACCESS, not revenue.
  const activeAccess = subs.filter((s) => PAID_PLANS.includes(String(s.plan_id)) && ACTIVE_STATES.includes(String(s.status)));
  // Only the ones actually paying feed MRR.
  const activePaid = activeAccess.filter(isRealPayer);
  const comped = activeAccess.filter((s) => !isRealPayer(s));
  const mrr = activePaid.reduce((sum, s) => sum + (PRICE_ZAR[String(s.plan_id)] || 0), 0);
  const compedValue = comped.reduce((sum, s) => sum + (PRICE_ZAR[String(s.plan_id)] || 0), 0);
  const newPaid30 = activePaid.filter((s) => String(s.created_at) >= isoAgo(30)).length;

  // A paid sub whose period ended but which nothing has renewed: either the
  // processor webhook is not firing or the customer has lapsed. Both mean MRR
  // is counting money that may not arrive, so surface it rather than hide it.
  const nowIso = new Date().toISOString();
  const stalePaid = activePaid.filter((s) => {
    const end = s.current_period_end ? String(s.current_period_end) : "";
    return !!end && end < nowIso;
  });
  const staleValue = stalePaid.reduce((sum, s) => sum + (PRICE_ZAR[String(s.plan_id)] || 0), 0);

  // Churn: canceled within 30d (canceled_at set OR status canceled recently).
  const churn30 = subs.filter((s) => {
    const c = s.canceled_at ? String(s.canceled_at) : "";
    return (c && c >= isoAgo(30)) || (s.status === "canceled" && String(s.created_at) >= isoAgo(30) && !!c);
  }).length;
  const churnPct = activePaid.length + churn30 > 0 ? Math.round((churn30 / (activePaid.length + churn30)) * 100) : 0;

  // Past due (recoverable) — one query (with user_id), then resolve emails.
  const pastDueCount = subs.filter((s) => s.status === "past_due").length;
  const failed: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("subscriptions").select("user_id,plan_id,canceled_at").eq("status", "past_due").limit(12);
    for (const s of (data || []) as Array<Record<string, unknown>>) {
      let email = "—";
      try { const { data: u } = await svc.auth.admin.getUserById(String(s.user_id)); email = String(u?.user?.email || "—"); } catch (_e) { /* ignore */ }
      failed.push({ email, plan: titleCase(String(s.plan_id)), since: String(s.canceled_at || "").slice(0, 10) || "—" });
    }
  } catch (_e) { /* ignore */ }

  // By-plan breakdown: paying vs comped, so a plan full of comps cannot read as
  // a plan full of revenue.
  const plans = PAID_PLANS.map((p) => {
    const count = activePaid.filter((s) => String(s.plan_id) === p).length;
    const compCount = comped.filter((s) => String(s.plan_id) === p).length;
    return { plan: titleCase(p), planTone: planTone(p), count, comped: compCount, mrr: count * (PRICE_ZAR[p] || 0) };
  }).filter((p) => p.count > 0 || p.comped > 0);

  // Promo performance.
  let promo: Record<string, unknown> = { active: false, percent: 0, endDate: null, grants: { active: 0, redeemed: 0 } };
  try {
    const { data: ps } = await svc.from("promo_settings").select("enabled,percent,end_date").eq("id", 1).maybeSingle();
    let gActive = 0, gRedeemed = 0;
    try {
      const { data: grants } = await svc.from("promo_grants").select("status,redeemed_at").limit(20000);
      for (const g of (grants || []) as Array<Record<string, unknown>>) {
        if (g.status === "active") gActive += 1;
        if (g.redeemed_at) gRedeemed += 1;
      }
    } catch (_e) { /* ignore */ }
    promo = {
      active: !!(ps && ps.enabled),
      percent: ps && ps.percent ? Number(ps.percent) : 0,
      endDate: ps && ps.end_date ? String(ps.end_date) : null,
      grants: { active: gActive, redeemed: gRedeemed },
    };
  } catch (_e) { /* leave default */ }

  const spark = bucketByDay(activePaid, "created_at", 7);
  const money = {
    kpis: [
      { key: "mrr", label: "MRR (ZAR)", tone: "green", fmt: "zar", value: mrr, delta: newPaid30 ? "+" + newPaid30 + " paid (30d)" : "steady", deltaDir: "up", spark: spark },
      { key: "paid", label: "Active paid", tone: "cyan", fmt: "int", value: activePaid.length, delta: comped.length ? "+" + comped.length + " comped" : (newPaid30 ? "+" + newPaid30 + " (30d)" : "steady"), deltaDir: "up", spark: spark },
      { key: "churn", label: "Churn (30d)", tone: "amber", fmt: "int", value: churn30, delta: churnPct + "% of paid", deltaDir: churn30 > 0 ? "down" : "up", spark: [] },
      { key: "pastdue", label: "Past due", tone: "amber", fmt: "int", value: pastDueCount, delta: pastDueCount ? "recover" : "clear", deltaDir: pastDueCount ? "down" : "up", spark: [] },
    ],
    plans,
    failed,
    promo,
    // Revenue integrity: what MRR is NOT counting, and what it might be
    // over-counting. Both are zero on a clean board.
    integrity: {
      comped: comped.length,
      compedValue: compedValue,
      stalePaid: stalePaid.length,
      staleValue: staleValue,
    },
  };
  return jsonResponse({ ok: true, money });
}));
