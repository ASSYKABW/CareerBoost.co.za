// POST /functions/v1/console-growth
// Body: { mock?: boolean }
// Auth: admin role + AAL2/MFA (getAuthedAdmin).
//
// Powers the Console "Growth & Marketing" section (Phase 2 — final section).
// Returns:
//   { growth: { kpis[4], channels[], funnel[], referrals, experiments[],
//               content[], lifecycle } }
//     - kpis:        signups 30d · activation rate · referrals confirmed · push devices
//     - channels:    attribution rollup (profiles.utm_source/referrer_host) with
//                    signups + activated + conv%
//     - funnel:      signups → onboarded → engaged → paid (30d window)
//     - referrals:   confirmed/rewarded/pending + top referrers
//     - experiments: marketing_experiments (status, variants, winner)
//     - content:     marketing_content_scorecard() top pieces
//     - lifecycle:   email drips (enrolled/completed/stopped) + push devices
//
// NOTE: referrals (0036), experiments (0037), drips (0039), push (0041) may not
// be applied in prod yet — each block is isolated in try/catch and degrades to
// zeros/empty so this endpoint NEVER 500s on a missing table. {mock:true} → fixtures.
import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";

const DAY_MS = 86_400_000;
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }
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
    { key: "signups", label: "Signups (30d)", tone: "cyan", value: 312, fmt: "int", delta: "+31%", deltaDir: "up", spark: [40, 52, 61, 70, 89] },
    { key: "activation", label: "Activation rate", tone: "violet", value: 62, fmt: "pct", delta: "onboarded", deltaDir: "up", spark: [] },
    { key: "referrals", label: "Referrals (30d)", tone: "green", value: 14, fmt: "int", delta: "3 rewarded", deltaDir: "up", spark: [1, 2, 1, 3, 2, 3, 2] },
    { key: "push", label: "Push devices", tone: "cyan", value: 48, fmt: "int", delta: "5 stale", deltaDir: "up", spark: [] },
  ],
  channels: [
    { channel: "Programmatic SEO", signups: 128, activated: 74, conv: 58 },
    { channel: "linkedin.com", signups: 64, activated: 41, conv: 64 },
    { channel: "Referrals", signups: 38, activated: 29, conv: 76 },
    { channel: "direct", signups: 52, activated: 24, conv: 46 },
    { channel: "google.com", signups: 30, activated: 15, conv: 50 },
  ],
  funnel: [
    { stage: "Signed up", count: 312, pct: 100 },
    { stage: "Onboarded", count: 194, pct: 62 },
    { stage: "Engaged (used app)", count: 141, pct: 45 },
    { stage: "Paid", count: 12, pct: 4 },
  ],
  referrals: { confirmed: 11, rewarded: 3, pending: 0, top: [{ email: "lerato@example.com", count: 4 }, { email: "sipho@example.com", count: 3 }] },
  experiments: [
    { key: "hero-cta", name: "Hero CTA copy", status: "running", variants: 2, winner: null },
    { key: "pricing-badge", name: "Pricing badge test", status: "done", variants: 2, winner: "b" },
  ],
  content: [
    { slug: "cv-tips-za", title: "CV tips for SA job seekers", views: 840, clicks: 96, signups: 22 },
    { slug: "interview-prep", title: "Interview prep guide", views: 512, clicks: 61, signups: 9 },
  ],
  lifecycle: { enrolled: 86, completed: 31, stopped: 6, pushDevices: 48, pushStale: 5 },
};

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    return errorResponse((err as Error).message, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  if (body.mock === true) return jsonResponse({ ok: true, growth: MOCK });

  const svc = getServiceClient();

  // ── Marketing Copilot approval queue (social_drafts) ──────────────
  const action = String(body.action || "");
  if (action === "drafts-list") {
    try {
      const { data, error } = await svc.from("social_drafts")
        .select("id,platform,status,hook,body,hashtags,link,rationale,created_at,posted_at,scheduled_for")
        .order("created_at", { ascending: false }).limit(40);
      if (error) throw error;
      const drafts = (data || []) as Array<Record<string, unknown>>;
      // #3 per-post performance: attributed signups per POSTED draft, matched
      // on the utm_campaign slug in its link (captured by signup-attribution
      // onto profiles). Clicks aren't measurable without a redirect service,
      // so we report the metric that matters most: signups.
      const campaignOf = (link: string): string => {
        const m = /[?&]utm_campaign=([^&#]+)/.exec(link || "");
        return m ? decodeURIComponent(m[1]).toLowerCase() : "";
      };
      const slugs = Array.from(new Set(
        drafts.filter((d) => d.status === "posted").map((d) => campaignOf(String(d.link || ""))).filter(Boolean),
      ));
      const counts: Record<string, number> = {};
      if (slugs.length) {
        try {
          const { data: profs } = await svc.from("profiles").select("utm_campaign").in("utm_campaign", slugs).limit(20000);
          for (const p of (profs || []) as Array<Record<string, unknown>>) {
            const c = String(p.utm_campaign || "").toLowerCase();
            if (c) counts[c] = (counts[c] || 0) + 1;
          }
        } catch { /* attribution unavailable — omit signups */ }
      }
      for (const d of drafts) {
        if (d.status === "posted") d.signups = counts[campaignOf(String(d.link || ""))] || 0;
      }
      return jsonResponse({ ok: true, drafts });
    } catch (e) {
      // Table missing (0047 pending) — empty queue, never a 500.
      return jsonResponse({ ok: true, drafts: [], note: (e as Error).message });
    }
  }
  if (action === "draft-update" || action === "draft-delete") {
    const csrf = checkAdminCsrf(req);
    if (!csrf.ok) return errorResponse(csrf.error, csrf.status);
    const id = String(body.id || "").trim();
    if (!id) return errorResponse("id required", 400);
    const meta = extractRequestMeta(req);
    if (action === "draft-delete") {
      const { error } = await svc.from("social_drafts").delete().eq("id", id);
      if (error) return errorResponse("Delete failed: " + error.message, 500);
      await logAdminAction(admin, "social_draft_delete", { payload: { id }, resultStatus: "success", ...meta });
      return jsonResponse({ ok: true });
    }
    // Patch = status change and/or inline content edits (hook/body/hashtags).
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const status = String(body.status || "").trim();
    if (status) {
      if (!["draft", "approved", "posted", "rejected"].includes(status)) {
        return errorResponse("status must be draft|approved|posted|rejected", 400);
      }
      patch.status = status;
      if (status === "posted") patch.posted_at = new Date().toISOString();
    }
    if (body.body !== undefined) {
      const text = String(body.body || "").slice(0, 3000);
      if (text.length < 20) return errorResponse("body too short (min 20 chars).", 400);
      patch.body = text;
    }
    if (body.hook !== undefined) patch.hook = String(body.hook || "").slice(0, 200) || null;
    if (body.hashtags !== undefined) patch.hashtags = String(body.hashtags || "").slice(0, 200) || null;
    if (body.scheduled_for !== undefined) {
      // #4 calendar: planned posting date. Blank/invalid → unplanned (null).
      const s = String(body.scheduled_for || "").trim();
      patch.scheduled_for = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    }
    if (Object.keys(patch).length === 1) return errorResponse("Nothing to update.", 400);
    const { error } = await svc.from("social_drafts").update(patch).eq("id", id);
    if (error) return errorResponse("Update failed: " + error.message, 500);
    await logAdminAction(admin, "social_draft_update", { payload: { id, status }, resultStatus: "success", ...meta });
    return jsonResponse({ ok: true });
  }
  const since30 = isoAgo(30);
  const since60 = isoAgo(60);

  // ── Signups + attribution + activation (profiles, one fetch) ──────
  let profiles: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("profiles")
      .select("user_id,created_at,onboarding_completed,utm_source,referrer_host")
      .gte("created_at", since60).limit(20000);
    profiles = (data || []) as Array<Record<string, unknown>>;
  } catch (_e) { /* empty */ }
  const cur = profiles.filter((p) => String(p.created_at) >= since30);
  const prev = profiles.filter((p) => String(p.created_at) < since30);
  const signups30 = cur.length;
  const onboarded30 = cur.filter((p) => p.onboarding_completed === true).length;
  const activationPct = signups30 ? Math.round((onboarded30 / signups30) * 100) : 0;
  const dSignups = prev.length
    ? (Math.round(((signups30 - prev.length) / prev.length) * 100))
    : null;

  // Channel rollup: utm_source → referrer_host → 'direct'.
  const chanAgg: Record<string, { signups: number; activated: number }> = {};
  for (const p of cur) {
    const ch = String(p.utm_source || p.referrer_host || "direct").toLowerCase();
    const a = (chanAgg[ch] = chanAgg[ch] || { signups: 0, activated: 0 });
    a.signups += 1; if (p.onboarding_completed === true) a.activated += 1;
  }
  const channels = Object.keys(chanAgg).map((ch) => {
    const a = chanAgg[ch];
    return { channel: ch, signups: a.signups, activated: a.activated, conv: a.signups ? Math.round((a.activated / a.signups) * 100) : 0 };
  }).sort((x, y) => y.signups - x.signups).slice(0, 8);

  // ── Funnel: signed up → onboarded → engaged → paid (30d) ──────────
  const curIds = new Set(cur.map((p) => String(p.user_id)));
  let engaged = 0;
  try {
    const { data } = await svc.from("usage_events").select("user_id").gte("occurred_at", since30).limit(60000);
    const active = new Set((data || []).map((r: Record<string, unknown>) => String(r.user_id)));
    for (const id of curIds) if (active.has(id)) engaged += 1;
  } catch (_e) { /* zero */ }
  let paidNew = 0;
  try {
    const { data } = await svc.from("subscriptions")
      .select("user_id,plan_id,status,created_at")
      .neq("plan_id", "free").gte("created_at", since30).limit(20000);
    paidNew = ((data || []) as Array<Record<string, unknown>>)
      .filter((s) => ["active", "trialing", "past_due"].includes(String(s.status))).length;
  } catch (_e) { /* zero */ }
  const pct = (n: number) => (signups30 ? Math.round((n / signups30) * 100) : 0);
  const funnel = [
    { stage: "Signed up", count: signups30, pct: signups30 ? 100 : 0 },
    { stage: "Onboarded", count: onboarded30, pct: pct(onboarded30) },
    { stage: "Engaged (used app)", count: engaged, pct: pct(engaged) },
    { stage: "Paid", count: paidNew, pct: pct(paidNew) },
  ];

  // ── Referrals (0036 — may not exist yet) ──────────────────────────
  let referrals: Record<string, unknown> = { confirmed: 0, rewarded: 0, pending: 0, top: [] };
  let refConfirmed30 = 0;
  let refSpark: number[] = [];
  try {
    const { data } = await svc.from("referrals").select("referrer_id,status,created_at").limit(20000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const conf = rows.filter((r) => r.status === "confirmed" || r.status === "rewarded");
    refConfirmed30 = conf.filter((r) => String(r.created_at) >= since30).length;
    refSpark = bucketByDay(conf.filter((r) => String(r.created_at) >= isoAgo(7)), "created_at", 7);
    const byRef: Record<string, number> = {};
    for (const r of conf) { const id = String(r.referrer_id); byRef[id] = (byRef[id] || 0) + 1; }
    const top: Array<Record<string, unknown>> = [];
    for (const id of Object.keys(byRef).sort((a, b) => byRef[b] - byRef[a]).slice(0, 5)) {
      let email = "—";
      try { const { data: u } = await svc.auth.admin.getUserById(id); email = String(u?.user?.email || "—"); } catch (_e) { /* deleted */ }
      top.push({ email, count: byRef[id] });
    }
    referrals = {
      confirmed: rows.filter((r) => r.status === "confirmed").length,
      rewarded: rows.filter((r) => r.status === "rewarded").length,
      pending: rows.filter((r) => r.status === "pending").length,
      top,
    };
  } catch (_e) { /* table missing → zeros */ }

  // ── Experiments (0037) ────────────────────────────────────────────
  let experiments: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.from("marketing_experiments")
      .select("key,name,status,variants,winner").order("updated_at", { ascending: false }).limit(10);
    experiments = ((data || []) as Array<Record<string, unknown>>).map((e) => ({
      key: String(e.key), name: String(e.name || e.key), status: String(e.status || "draft"),
      variants: Array.isArray(e.variants) ? (e.variants as unknown[]).length : 0,
      winner: e.winner ? String(e.winner) : null,
    }));
  } catch (_e) { /* table missing → empty */ }

  // ── Content scorecard (0034 RPC) ──────────────────────────────────
  let content: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc.rpc("marketing_content_scorecard");
    content = ((data || []) as Array<Record<string, unknown>>)
      .map((c) => ({ slug: String(c.slug || ""), title: String(c.title || c.slug || "—"), views: Number(c.views) || 0, clicks: Number(c.clicks) || 0, signups: Number(c.signups) || 0 }))
      .sort((x, y) => y.views - x.views).slice(0, 6);
  } catch (_e) { /* rpc missing → empty */ }

  // ── Lifecycle: email drips (0039) + push (0041) ───────────────────
  const lifecycle: Record<string, unknown> = { enrolled: 0, completed: 0, stopped: 0, pushDevices: 0, pushStale: 0 };
  try {
    const { data } = await svc.from("email_drip_state").select("status").limit(20000);
    for (const r of (data || []) as Array<Record<string, unknown>>) {
      if (r.status === "enrolled") lifecycle.enrolled = (lifecycle.enrolled as number) + 1;
      else if (r.status === "completed") lifecycle.completed = (lifecycle.completed as number) + 1;
      else if (r.status === "stopped") lifecycle.stopped = (lifecycle.stopped as number) + 1;
    }
  } catch (_e) { /* zeros */ }
  let pushDevices = 0, pushStale = 0;
  try {
    const { data } = await svc.from("push_subscriptions").select("failure_count").limit(20000);
    const rows = (data || []) as Array<Record<string, unknown>>;
    pushDevices = rows.length;
    pushStale = rows.filter((r) => (Number(r.failure_count) || 0) > 0).length;
  } catch (_e) { /* zeros */ }
  lifecycle.pushDevices = pushDevices;
  lifecycle.pushStale = pushStale;

  // ── Website traffic (anonymous visitors) ──────────────────────────
  // The pre-signup half of the funnel, unlocked by 0053 + usage-ingest. Until
  // then the product could only ever see people from sign-in onward.
  //
  // Aggregated in TS over a bounded window rather than in SQL: volumes are tiny
  // today and this keeps it to one endpoint with no new view/RPC. If usage_events
  // ever gets big, move this to a materialised view — the shape won't change.
  //
  // STITCHING: the client stamps the SAME persistent anonymous_id before AND
  // after signup, so an anon id that also appears on a signed-in row is a
  // visitor who converted. That's the visit→signup number, with no vendor.
  let traffic: Record<string, unknown> = {
    visitors7: 0, visitors30: 0, views7: 0, sessions7: 0,
    returning7: 0, converted30: 0, convRate: 0,
    series: [], topPages: [], sources: [], devices: [], empty: true,
  };
  try {
    const since30 = isoAgo(30);
    const { data: evRows } = await svc
      .from("usage_events")
      .select("user_id, anonymous_id, event_name, route, metadata, occurred_at")
      .gte("occurred_at", since30)
      .not("anonymous_id", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(20000);
    const ev = (evRows || []) as Array<Record<string, unknown>>;

    const since7 = Date.now() - 7 * DAY_MS;
    const anon30 = new Set<string>();
    const anon7 = new Set<string>();
    const knownAnon = new Set<string>();       // anon ids seen WITH a user_id → converted
    const firstSeen = new Map<string, number>();
    const pages = new Map<string, number>();
    const sources = new Map<string, number>();
    const devices = new Map<string, number>();
    const byDay = new Map<string, Set<string>>();
    let views7 = 0, sessions7 = 0;

    for (const r of ev) {
      const anon = String(r.anonymous_id || "");
      if (!anon) continue;
      const t = Date.parse(String(r.occurred_at || "")) || 0;
      const isAnonRow = r.user_id === null || r.user_id === undefined;
      if (!isAnonRow) { knownAnon.add(anon); continue; }  // signed-in rows only mark conversion

      anon30.add(anon);
      const prevSeen = firstSeen.get(anon);
      if (prevSeen === undefined || t < prevSeen) firstSeen.set(anon, t);

      const day = new Date(t).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day)!.add(anon);

      if (t >= since7) {
        anon7.add(anon);
        const name = String(r.event_name || "");
        if (name === "view_route") {
          views7++;
          const route = String(r.route || "unknown");
          pages.set(route, (pages.get(route) || 0) + 1);
        }
        if (name === "session_start") {
          sessions7++;
          const md = (r.metadata || {}) as Record<string, unknown>;
          // UTM wins over referrer when present — that's the deliberate channel.
          const utm = String(md.utmSource || "").trim();
          const ref = String(md.referrer || "").trim();
          const src = utm ? "utm:" + utm : (ref || "direct");
          if (src !== "internal") sources.set(src, (sources.get(src) || 0) + 1);
          const dev = String(md.deviceType || "unknown");
          devices.set(dev, (devices.get(dev) || 0) + 1);
        }
      }
    }

    // Returning = first seen before this 7d window but active inside it.
    let returning7 = 0;
    for (const a of anon7) {
      const f = firstSeen.get(a);
      if (f !== undefined && f < since7) returning7++;
    }
    // Converted = visitors (last 30d) whose anon id also appears signed-in.
    let converted30 = 0;
    for (const a of anon30) if (knownAnon.has(a)) converted30++;

    const days: Array<{ day: string; visitors: number }> = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
      days.push({ day: d, visitors: (byDay.get(d) || new Set()).size });
    }
    const rank = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

    traffic = {
      visitors7: anon7.size,
      visitors30: anon30.size,
      views7,
      sessions7,
      returning7,
      converted30,
      convRate: anon30.size ? Math.round((converted30 / anon30.size) * 1000) / 10 : 0,
      series: days,
      topPages: rank(pages, 8),
      sources: rank(sources, 8),
      devices: rank(devices, 4),
      empty: anon30.size === 0,
    };
  } catch (_e) { /* leave the zeroed default — never 500 the section */ }

  // ── Content engine status ─────────────────────────────────────────────
  // The engine (market-scan → fact-led drafts) had no trigger until the panel
  // below shipped, so its tables sat empty and the Console gave no hint why.
  // This reports whether it has anything true to say THIS week.
  let engine: Record<string, unknown> = {
    weekStart: null, segments: [], schedule: [], scannedTotal: 0, sufficientCount: 0,
    pieces: 0, drafts: 0, lastRunAt: null, lastRunStatus: null, lastRunError: null,
  };
  try {
    const monday = new Date();
    const day = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - day);
    const weekStart = monday.toISOString().slice(0, 10);

    const { data: snaps } = await svc
      .from("market_snapshots")
      .select("segment,label,scanned,sufficient,week_start")
      .eq("week_start", weekStart);
    const rows = (snaps || []) as Array<Record<string, unknown>>;

    const { count: pieceCount } = await svc.from("content_pieces").select("id", { count: "exact", head: true });
    const { count: draftCount } = await svc.from("social_drafts").select("id", { count: "exact", head: true });
    const { data: lastRun } = await svc
      .from("agent_runs").select("status,error,created_at")
      .eq("agent", "marketing").order("created_at", { ascending: false }).limit(1).maybeSingle();

    // This week's schedule, read back from the pieces themselves — the plan
    // has no table of its own; a scheduled piece IS the plan (source_data
    // carries weekStart/dayIdx/angle, scheduled_at carries the day).
    const { data: sched } = await svc
      .from("content_pieces")
      .select("id, title, type, status, scheduled_at, source_data")
      .contains("source_data", { weekStart })
      .order("scheduled_at", { ascending: true })
      .limit(20);
    const schedule = ((sched || []) as Array<Record<string, unknown>>).map((r) => {
      const sd = (r.source_data || {}) as Record<string, unknown>;
      return {
        id: String(r.id), title: String(r.title || ""), type: String(r.type || ""),
        status: String(r.status || ""), date: String(r.scheduled_at || "").slice(0, 10),
        day: String(sd.day || ""), dayIdx: Number(sd.dayIdx),
        angle: String(sd.angle || ""), hook: String(sd.hook || ""),
        segment: String((sd.selection as Record<string, unknown>)?.segment || ""),
      };
    });

    engine = {
      weekStart,
      schedule,
      segments: rows.map((r) => ({
        segment: String(r.segment ?? ""), label: String(r.label ?? ""),
        scanned: Number(r.scanned) || 0, sufficient: !!r.sufficient,
      })),
      scannedTotal: rows.reduce((n, r) => n + (Number(r.scanned) || 0), 0),
      sufficientCount: rows.filter((r) => !!r.sufficient).length,
      pieces: Number(pieceCount) || 0,
      drafts: Number(draftCount) || 0,
      lastRunAt: lastRun ? String(lastRun.created_at) : null,
      lastRunStatus: lastRun ? String(lastRun.status) : null,
      lastRunError: lastRun && lastRun.error ? String(lastRun.error).slice(0, 160) : null,
    };
  } catch (_e) { /* leave the default — never 500 the section */ }

  const growth = {
    traffic,
    engine,
    kpis: [
      { key: "signups", label: "Signups (30d)", tone: "cyan", fmt: "int", value: signups30, delta: dSignups === null ? "new" : (dSignups >= 0 ? "+" : "") + dSignups + "%", deltaDir: dSignups !== null && dSignups < 0 ? "down" : "up", spark: bucketByDay(cur, "created_at", 30) },
      { key: "activation", label: "Activation rate", tone: "violet", fmt: "pct", value: activationPct, delta: onboarded30 + " onboarded", deltaDir: activationPct >= 50 ? "up" : "down", spark: [] },
      { key: "referrals", label: "Referrals (30d)", tone: "green", fmt: "int", value: refConfirmed30, delta: (referrals.rewarded as number) + " rewarded", deltaDir: "up", spark: refSpark },
      { key: "push", label: "Push devices", tone: "cyan", fmt: "int", value: pushDevices, delta: pushStale ? pushStale + " stale" : "healthy", deltaDir: pushStale ? "down" : "up", spark: [] },
    ],
    channels, funnel, referrals, experiments, content, lifecycle,
  };
  return jsonResponse({ ok: true, growth });
}));
