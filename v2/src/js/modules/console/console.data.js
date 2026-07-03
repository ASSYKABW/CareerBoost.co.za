// CareerBoost Console — data layer + small render utilities.
//
// Phase 1. Two data sources behind one interface:
//   • LIVE  — POSTs to the `console-*` Edge Functions via the Supabase
//             client (`client.functions.invoke`), so the user's JWT (and
//             AAL2/MFA elevation) ride along automatically. The functions
//             enforce admin role + MFA server-side (getAuthedAdmin).
//   • MOCK  — local fixtures, used when ?mock=1, when the backend is off,
//             when the user isn't signed in, OR as a graceful fallback if
//             a live call fails (so the console never renders blank during
//             the rollout, before the endpoints are deployed).
//
// Payload shapes are identical from both sources — the route module
// (console.route.js) never needs to know which one it got. Mock payloads
// carry `_mock: true` so the UI can badge "sample data" honestly.
(function () {
  window.CBConsole = window.CBConsole || {};

  // ─── Render utilities ──────────────────────────────────────────────
  // Strong HTML escaper — escapes &, <, >, ", ' so values are safe in BOTH
  // element text and attribute contexts. (Deliberately stronger than the
  // app's <>-only sanitizeText; the console renders operator-facing data
  // including user emails/names from the DB.)
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function fmt(v, type) {
    var n = Number(v) || 0;
    if (type === "zar") return "R " + Math.round(n).toLocaleString();
    if (type === "usd") return "$" + Math.round(n).toLocaleString();
    if (type === "pct") return n.toFixed(1) + "%";
    return Math.round(n).toLocaleString();
  }
  // Build an SVG path "d" string from an array of numbers, fit to w×h.
  function sparkPath(points, w, h) {
    if (!points || !points.length) return "";
    var max = Math.max.apply(null, points), min = Math.min.apply(null, points);
    var rng = (max - min) || 1;
    var step = points.length > 1 ? w / (points.length - 1) : 0;
    return points.map(function (p, i) {
      var x = Math.round(i * step);
      var y = Math.round(h - 4 - ((p - min) / rng) * (h - 8));
      return (i ? "L" : "M") + x + " " + y;
    }).join(" ");
  }
  // Build a filled area + line path pair from values fit to w×h (baseline 0).
  function areaPaths(points, w, h, pad) {
    pad = pad || 14;
    if (!points || !points.length) return { line: "", area: "" };
    var max = Math.max.apply(null, points) || 1;
    var step = points.length > 1 ? w / (points.length - 1) : 0;
    var line = points.map(function (p, i) {
      var x = Math.round(i * step);
      var y = Math.round(h - pad - (p / max) * (h - pad * 2));
      return (i ? "L" : "M") + x + " " + y;
    }).join(" ");
    return { line: line, area: line + " L " + w + " " + h + " L 0 " + h + " Z" };
  }
  // Animate a number node from 0 → target. Honours reduced-motion.
  function countUp(node, target, type) {
    if (!node) return;
    if (prefersReducedMotion()) { node.textContent = fmt(target, type); return; }
    var start = performance.now(), dur = 750;
    function tick(now) {
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(target * eased, type);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  function toastErr(msg) {
    if (window.CBV2 && window.CBV2.toast && typeof window.CBV2.toast.error === "function") {
      window.CBV2.toast.error(msg);
    } else {
      console.warn("[console] " + msg);
    }
  }

  // Shared section-UI helpers (used by console.money.js / console.ai.js /
  // console.growth.js — one definition, no per-section copies).
  function kpiCard(d) {
    var col = d.tone === "green" ? "#22c55e" : d.tone === "amber" ? "#ff9d4a" : d.tone === "violet" ? "#b06bff" : "#22e3ff";
    var arrow = d.deltaDir === "down" ? "▼ " : "▲ ";
    var spark = (d.spark && d.spark.length)
      ? '<svg class="cbc-spark" viewBox="0 0 200 30" preserveAspectRatio="none"><path d="' + sparkPath(d.spark, 200, 30) + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : "";
    return '<div class="cbc-card cbc-kpi cbc-' + d.tone + '"><span class="cbc-ac"></span>' +
      '<div class="cbc-lab">' + escapeHtml(d.label) + '</div>' +
      '<div class="cbc-rw"><div class="cbc-num" data-count="' + d.value + '" data-fmt="' + escapeHtml(d.fmt) + '">0</div>' +
      '<span class="cbc-delta ' + d.deltaDir + '">' + arrow + escapeHtml(d.delta) + '</span></div>' + spark + '</div>';
  }
  function kpiSkeleton(n) {
    var r = "";
    for (var i = 0; i < (n || 4); i++) r += '<div class="cbc-card cbc-kpi"><div class="cbc-skel" style="height:74px"></div></div>';
    return r;
  }
  function sampleBadge(on, endpoint, what) {
    if (!on) return "";
    return '<div style="margin-bottom:13px;font-size:12px;color:var(--c-amber);background:rgba(255,157,74,.08);border:1px solid rgba(255,157,74,.22);border-radius:10px;padding:8px 12px">' +
      '<i class="fa-solid fa-flask"></i> Sample data — deploy <code>' + escapeHtml(endpoint) + '</code> and sign in with MFA to see real ' + escapeHtml(what) + '.</div>';
  }

  window.CBConsole.util = {
    escapeHtml: escapeHtml, fmt: fmt, sparkPath: sparkPath, areaPaths: areaPaths,
    countUp: countUp, prefersReducedMotion: prefersReducedMotion, toastErr: toastErr,
    kpiCard: kpiCard, kpiSkeleton: kpiSkeleton, sampleBadge: sampleBadge,
    // Pull the resolver's propose_action calls out of an agent-run step
    // transcript → [{kind, params, reason}] for the Apply buttons.
    extractProposals: function (steps) {
      return (steps || []).filter(function (s) {
        return s && s.type === "tool" && s.tool === "propose_action" && s.input && s.input.kind;
      }).map(function (s) {
        return { kind: String(s.input.kind), params: (s.input.params && typeof s.input.params === "object") ? s.input.params : {}, reason: String(s.input.reason || "") };
      });
    },
  };

  // ─── Mock fixtures (mirror the approved reference screen) ───────────
  function sineSeries(seed, n, base, slope) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(Math.max(0, Math.round(base + i * slope + Math.sin(i * 1.3 + seed) * (base * 0.12))));
    return a;
  }
  var MOCK_PULSE = {
    "24h": {
      range: "24h",
      kpis: [
        { key: "signups", label: "New signups", tone: "cyan", value: 14, fmt: "int", delta: "+27%", deltaDir: "up", spark: [2, 1, 3, 2, 4, 3, 5, 4, 6] },
        { key: "active", label: "Active users", tone: "violet", value: 41, fmt: "int", delta: "+8%", deltaDir: "up", spark: [30, 33, 31, 36, 34, 38, 37, 40, 41] },
        { key: "revenue", label: "New revenue", tone: "green", value: 610, fmt: "zar", delta: "+1 paid", deltaDir: "up", spark: [0, 0, 210, 210, 210, 400, 400, 610, 610] },
        { key: "paid", label: "Paid conv.", tone: "cyan", value: 1, fmt: "int", delta: "steady", deltaDir: "up", spark: [0, 1, 0, 1, 1, 0, 1, 1, 1] },
        { key: "aispend", label: "AI spend", tone: "amber", value: 19, fmt: "usd", delta: "-4%", deltaDir: "gd", spark: [3, 2, 3, 2, 2, 3, 2, 2, 2] },
        { key: "errors", label: "Error rate", tone: "green", value: 0.3, fmt: "pct", delta: "-0.1pt", deltaDir: "gd", spark: [6, 5, 4, 5, 4, 4, 3, 3, 3] },
      ],
    },
    "7d": {
      range: "7d",
      kpis: [
        { key: "signups", label: "New signups", tone: "cyan", value: 86, fmt: "int", delta: "+14%", deltaDir: "up", spark: [8, 11, 9, 13, 12, 16, 17] },
        { key: "active", label: "Active users", tone: "violet", value: 148, fmt: "int", delta: "+6%", deltaDir: "up", spark: [120, 126, 124, 131, 138, 142, 148] },
        { key: "revenue", label: "New revenue", tone: "green", value: 4120, fmt: "zar", delta: "+22%", deltaDir: "up", spark: [1900, 2300, 2600, 2900, 3400, 3800, 4120] },
        { key: "paid", label: "Paid conv.", tone: "cyan", value: 7, fmt: "int", delta: "+2", deltaDir: "up", spark: [3, 4, 4, 5, 6, 6, 7] },
        { key: "aispend", label: "AI spend", tone: "amber", value: 128, fmt: "usd", delta: "-3%", deltaDir: "gd", spark: [22, 19, 21, 18, 17, 16, 15] },
        { key: "errors", label: "Error rate", tone: "green", value: 0.4, fmt: "pct", delta: "-0.2pt", deltaDir: "gd", spark: [9, 8, 7, 6, 6, 5, 4] },
      ],
    },
    "30d": {
      range: "30d",
      kpis: [
        { key: "signups", label: "New signups", tone: "cyan", value: 312, fmt: "int", delta: "+31%", deltaDir: "up", spark: [40, 52, 61, 70, 89] },
        { key: "active", label: "Active users", tone: "violet", value: 421, fmt: "int", delta: "+12%", deltaDir: "up", spark: [300, 330, 360, 395, 421] },
        { key: "revenue", label: "New revenue", tone: "green", value: 16800, fmt: "zar", delta: "+28%", deltaDir: "up", spark: [7000, 9200, 11500, 14100, 16800] },
        { key: "paid", label: "Paid conv.", tone: "cyan", value: 23, fmt: "int", delta: "+9", deltaDir: "up", spark: [8, 12, 15, 19, 23] },
        { key: "aispend", label: "AI spend", tone: "amber", value: 612, fmt: "usd", delta: "+6%", deltaDir: "down", spark: [90, 110, 120, 140, 152] },
        { key: "errors", label: "Error rate", tone: "green", value: 0.6, fmt: "pct", delta: "+0.1pt", deltaDir: "down", spark: [4, 5, 5, 6, 6] },
      ],
    },
  };
  var MOCK_COMMON = {
    attention: [
      { kind: "incident", id: "inc1", icon: "fa-triangle-exclamation", tone: "red", title: "job-feed latency", sub: "health · since 2026-07-01", count: 1 },
      { kind: "incident", id: "inc2", icon: "fa-bolt", tone: "amber", title: "AI cost spike watch", sub: "ai-cost · since 2026-07-02", count: 1 },
      { kind: "payments", icon: "fa-credit-card", tone: "amber", title: "Failed payments", sub: "renewal retry pending", count: 1 },
    ],
    feed: [
      { text: "<b>New signup</b> — thabo@gmail.com", meta: "organic · just now", tone: "cyan" },
      { text: "<b>Upgraded to Pro</b> — R380/mo", meta: "checkout · 2m", tone: "green" },
      { text: "<b>Mock interview</b> completed · Technical persona", meta: "app · 4m", tone: "violet" },
      { text: "<b>Resume tailored</b> · 94% match", meta: "app · 6m", tone: "cyan" },
      { text: "<b>Incident opened</b> · job-feed latency", meta: "system · 9m", tone: "amber" },
      { text: "<b>Referral converted</b> · +1 paid", meta: "growth · 12m", tone: "green" },
    ],
    spenders: [
      { id: "u1", name: "Lerato M.", email: "lerato@…", plan: "Pro", planTone: "violet", calls: 142, spend: "$11.40", status: "normal", statusTone: "green" },
      { id: "u2", name: "Sipho K.", email: "sipho@…", plan: "Career", planTone: "cyan", calls: 98, spend: "$8.10", status: "normal", statusTone: "green" },
      { id: "u6", name: "Anon (free)", email: "q***@…", plan: "Free", planTone: "dim", calls: 71, spend: "$0.00", status: "watch", statusTone: "amber" },
      { id: "u3", name: "Naledi P.", email: "naledi@…", plan: "Plus", planTone: "cyan", calls: 54, spend: "$4.30", status: "normal", statusTone: "green" },
      { id: "u4", name: "Bot? 41.x", email: "burner@…", plan: "Free", planTone: "dim", calls: 230, spend: "$0.00", status: "flagged", statusTone: "red" },
    ],
  };
  function mockPulse(range) {
    var base = MOCK_PULSE[range] || MOCK_PULSE["7d"];
    var n = range === "24h" ? 12 : range === "7d" ? 14 : 30, cur = [], prev = [];
    for (var i = 0; i < n; i++) { cur.push(8 + i * 0.7 + Math.sin(i * 1.3) * 2.2); prev.push(6 + i * 0.45 + Math.sin(i * 1.1) * 1.6); }
    return {
      _mock: true, range: base.range, kpis: base.kpis,
      northStar: { title: "New activations / day", trend: "▲ 18% vs prev", cur: cur, prev: prev },
      promo: { active: true, percent: 30, endDate: "2026-07-31" },
      attention: MOCK_COMMON.attention, feed: MOCK_COMMON.feed, spenders: MOCK_COMMON.spenders,
    };
  }
  var MOCK_INSIGHTS = {
    _mock: true, total: 7,
    findings: [
      { sev: "opp", icon: "fa-rocket", tag: "High", title: "Mock interviews convert 3× — but only 9% of signups try one", why: "Free→Paid is 4.8% overall, yet 14% for users who run a mock interview. Surfacing it earlier in onboarding could lift paid conversions.", action: "Add onboarding step", to: "growth" },
      { sev: "warn", icon: "fa-user-slash", tag: "Activation", title: "38% of new signups never tailor a resume", why: "Resume tailoring is the core 'aha' moment. Users who skip it in week 1 retain at roughly half the rate.", action: "View funnel", to: "growth" },
      { sev: "crit", icon: "fa-bolt", tag: "Cost", title: "resume-tailor AI cost +22% while cache hit-rate fell to 51%", why: "Prompt-cache efficiency dropped this week — spend is rising faster than usage. Likely a prompt-version change broke caching.", action: "Inspect AI cost", to: "ai" },
      { sev: "opp", icon: "fa-arrow-up-right-dots", tag: "~R2,400/mo", title: "Pro users hit the voice-mock cap 3 days into the month", why: "11 of 18 Pro users maxed voice mocks before mid-month — a clean upgrade signal toward Career.", action: "Review upsell", to: "money" },
    ],
  };
  var MOCK_USERS = [
    { id: "u1", name: "Lerato Mokoena", email: "lerato@example.com", plan: "Pro", planTone: "cyan", joined: "2026-03-02", lastActive: "2026-06-29", aiCalls: 142, pipeline: 12, status: "active" },
    { id: "u2", name: "Sipho Khumalo", email: "sipho@example.com", plan: "Career", planTone: "violet", joined: "2026-02-14", lastActive: "2026-06-30", aiCalls: 98, pipeline: 8, status: "active" },
    { id: "u3", name: "Naledi Pillay", email: "naledi@example.com", plan: "Plus", planTone: "cyan", joined: "2026-05-20", lastActive: "2026-06-28", aiCalls: 54, pipeline: 5, status: "active" },
    { id: "u4", name: "Thabo Nkosi", email: "thabo@example.com", plan: "Free", planTone: "dim", joined: "2026-06-25", lastActive: "2026-06-27", aiCalls: 3, pipeline: 1, status: "active" },
    { id: "u5", name: "Aisha Patel", email: "aisha@example.com", plan: "Plus", planTone: "cyan", joined: "2026-04-11", lastActive: "2026-06-26", aiCalls: 37, pipeline: 6, status: "active" },
    { id: "u6", name: "Themba Dlamini", email: "themba@example.com", plan: "Free", planTone: "dim", joined: "2026-06-18", lastActive: "2026-06-24", aiCalls: 9, pipeline: 2, status: "active" },
  ];
  function mockUsers(q) {
    var list = MOCK_USERS;
    if (q) { var s = String(q).toLowerCase(); list = list.filter(function (u) { return u.email.toLowerCase().indexOf(s) >= 0 || u.name.toLowerCase().indexOf(s) >= 0; }); }
    return { _mock: true, users: list, total: list.length, page: 1, perPage: 25 };
  }
  function mockUserDetail(userId) {
    var u = MOCK_USERS.filter(function (x) { return x.id === userId; })[0] || MOCK_USERS[0];
    return {
      _mock: true, id: u.id, name: u.name, email: u.email, joined: u.joined, roles: [], mfa: true,
      plan: u.plan, planStatus: "active",
      quota: [
        { label: "AI resume tailors", used: 8, limit: 10 },
        { label: "Mock interviews", used: 3, limit: 3 },
        { label: "Cover letters", used: 6, limit: 15 },
      ],
      timeline: [
        { event: "resume tailored", when: "2026-06-29", module: "resume" },
        { event: "mock interview", when: "2026-06-28", module: "interview" },
        { event: "job saved", when: "2026-06-27", module: "job-search" },
        { event: "cover letter generated", when: "2026-06-26", module: "cover-letter" },
      ],
      stats: { pipeline: u.pipeline, savedJobs: 14, aiCalls: u.aiCalls, sessions: 21 },
    };
  }

  // ─── Live transport ────────────────────────────────────────────────
  function isMock() {
    if (window.CBConsole.forceMock) return true;
    try { if (new URLSearchParams(window.location.search).get("mock") === "1") return true; } catch (e) { /* ignore */ }
    var cfg = window.CBV2 && window.CBV2.config;
    if (!cfg || typeof cfg.isBackendEnabled !== "function" || !cfg.isBackendEnabled()) return true;
    var auth = window.CBV2 && window.CBV2.auth;
    if (!auth || typeof auth.isAuthenticated !== "function" || !auth.isAuthenticated()) return true;
    return false;
  }
  // Pull the REAL error message out of a supabase-js FunctionsHttpError —
  // the default .message is the useless "Edge Function returned a non-2xx
  // status code"; the actual { error } body lives on error.context (Response).
  // Dead-session detection: Supabase revokes older sessions when you sign in
  // elsewhere (or they age out). The raw error is cryptic — translate it to
  // the action that actually fixes it.
  function friendly(msg, fnName) {
    if (/session_id claim|Session rejected|Invalid Refresh Token|JWT expired|refresh_token_not_found/i.test(msg)) {
      return "Your admin session has expired (signed in elsewhere?). Refresh the page, sign in again with your MFA code, then retry.";
    }
    return fnName + ": " + msg;
  }
  async function realError(err, fnName) {
    try {
      if (err && err.context && typeof err.context.json === "function") {
        var body = await err.context.json();
        if (body && body.error) return new Error(friendly(String(body.error), fnName));
      }
    } catch (e) { /* body not json */ }
    return new Error(friendly(String((err && err.message) || "Edge function error."), fnName));
  }
  async function call(fnName, body) {
    var auth = window.CBV2 && window.CBV2.auth;
    var client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    if (!client || !client.functions) throw new Error("Supabase client unavailable.");
    var res = await client.functions.invoke(fnName, { body: body || {} });
    if (res.error) throw await realError(res.error, fnName);
    return res.data;
  }

  // Admin CSRF nonce — client-generated, stored in sessionStorage. The server
  // only checks the nonce's SHAPE, not its value (see _shared/admin-csrf.ts),
  // and we reuse the SAME key the legacy admin uses so one session shares one
  // nonce. Required on admin *mutation* endpoints.
  function csrfNonce() {
    try {
      var n = sessionStorage.getItem("cb_admin_csrf_nonce");
      if (!n || n.length < 32) {
        var raw = (window.crypto && crypto.randomUUID) ? (crypto.randomUUID() + crypto.randomUUID())
          : ("nonce_" + Date.now() + "_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
        n = raw.replace(/[^A-Za-z0-9\-_]/g, "").slice(0, 100);
        if (n.length < 32) n = (n + "00000000000000000000000000000000000000").slice(0, 40);
        sessionStorage.setItem("cb_admin_csrf_nonce", n);
      }
      return n;
    } catch (e) {
      return ("fallback_" + Date.now() + "_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9\-_]/g, "").slice(0, 60);
    }
  }
  // Mutation transport — like call() but attaches the CSRF nonce header that
  // admin mutation endpoints require (admin-user-adjust, admin-promote-user).
  async function callMut(fnName, body) {
    var auth = window.CBV2 && window.CBV2.auth;
    var client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    if (!client || !client.functions) throw new Error("Supabase client unavailable.");
    var res = await client.functions.invoke(fnName, { body: body || {}, headers: { "X-CB-Admin-Nonce": csrfNonce() } });
    if (res.error) throw await realError(res.error, fnName);
    return res.data;
  }

  window.CBConsole.data = {
    isMock: isMock,
    call: call,
    loadPulse: async function (range) {
      range = range || "7d";
      if (isMock()) return mockPulse(range);
      try {
        var d = await call("console-pulse", { range: range });
        return (d && d.pulse) ? d.pulse : d;
      } catch (e) {
        // Phase 1: endpoint may not be deployed yet — degrade to samples
        // rather than a blank console, and badge it so it's never mistaken
        // for real numbers.
        console.warn("[console] console-pulse failed, using sample data:", e.message);
        return mockPulse(range);
      }
    },
    loadInsights: async function () {
      if (isMock()) return MOCK_INSIGHTS;
      try {
        var d = await call("console-insights", {});
        return (d && d.findings) ? d : MOCK_INSIGHTS;
      } catch (e) {
        console.warn("[console] console-insights failed, using sample data:", e.message);
        return MOCK_INSIGHTS;
      }
    },
    loadUsers: async function (q, page) {
      if (isMock()) return mockUsers(q);
      try {
        var d = await call("console-users", { action: "list", q: q || "", page: page || 1 });
        return (d && d.users) ? d : mockUsers(q);
      } catch (e) {
        console.warn("[console] console-users(list) failed, using sample data:", e.message);
        return mockUsers(q);
      }
    },
    loadUserDetail: async function (userId) {
      if (isMock()) return { detail: mockUserDetail(userId) };
      try {
        var d = await call("console-users", { action: "detail", userId: userId });
        return (d && d.detail) ? d : { detail: mockUserDetail(userId) };
      } catch (e) {
        console.warn("[console] console-users(detail) failed, using sample data:", e.message);
        return { detail: mockUserDetail(userId) };
      }
    },
    // ── Mutations (wired to the existing proven admin endpoints) ──────
    adjustQuota: async function (userId, quota, amount) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-user-adjust", { targetUserId: userId, action: "grant_quota", payload: { quota: quota, amount: amount } });
    },
    resetQuota: async function (userId) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-user-adjust", { targetUserId: userId, action: "reset_quota", payload: {} });
    },
    grantPromo: async function (email, percent, expiresAt) {
      if (isMock()) return { ok: true, _mock: true };
      var body = { action: "grant-create", email: email, kind: "percent", percent: percent };
      if (expiresAt) body.expires_at = expiresAt;
      return call("admin-promo", body); // admin-promo grants don't require the CSRF nonce
    },
    promoteUser: async function (userId, roles) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-promote-user", { targetUserId: userId, roles: roles || [] });
    },
    loadMoney: async function () {
      var MOCK = {
        _mock: true,
        kpis: [
          { key: "mrr", label: "MRR (ZAR)", tone: "green", value: 4890, fmt: "zar", delta: "+2 paid", deltaDir: "up", spark: [2, 1, 2, 1, 2, 1, 2] },
          { key: "paid", label: "Active paid", tone: "cyan", value: 12, fmt: "int", delta: "+3 (30d)", deltaDir: "up", spark: [7, 8, 9, 10, 11, 11, 12] },
          { key: "churn", label: "Churn (30d)", tone: "amber", value: 2, fmt: "int", delta: "14% of paid", deltaDir: "down", spark: [] },
          { key: "pastdue", label: "Past due", tone: "amber", value: 1, fmt: "int", delta: "recover", deltaDir: "down", spark: [] },
        ],
        plans: [
          { plan: "Plus", planTone: "cyan", count: 5, mrr: 1050 },
          { plan: "Pro", planTone: "cyan", count: 4, mrr: 1520 },
          { plan: "Career", planTone: "violet", count: 3, mrr: 2097 },
        ],
        failed: [{ email: "thabo@example.com", plan: "Pro", since: "2026-06-27" }],
        promo: { active: true, percent: 30, endDate: "2026-07-31", grants: { active: 4, redeemed: 9 } },
      };
      if (isMock()) return MOCK;
      try {
        var d = await call("console-money", {});
        return (d && d.money) ? d.money : MOCK;
      } catch (e) {
        console.warn("[console] console-money failed, using sample data:", e.message);
        return MOCK;
      }
    },
    loadAiHealth: async function () {
      var MOCK = {
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
        failures: [
          { skill: "interview session step", model: "claude-sonnet-5", error: "provider timeout (529)", when: "2026-06-30" },
          { skill: "resume tailor", model: "claude-haiku-4-5", error: "rate limit (429)", when: "2026-06-29" },
        ],
      };
      if (isMock()) return MOCK;
      try {
        var d = await call("console-ai-health", {});
        return (d && d.aiHealth) ? d.aiHealth : MOCK;
      } catch (e) {
        console.warn("[console] console-ai-health failed, using sample data:", e.message);
        return MOCK;
      }
    },
    loadGrowth: async function () {
      var MOCK = {
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
      if (isMock()) return MOCK;
      try {
        var d = await call("console-growth", {});
        return (d && d.growth) ? d.growth : MOCK;
      } catch (e) {
        console.warn("[console] console-growth failed, using sample data:", e.message);
        return MOCK;
      }
    },
    // ── Model Control (console-config) ────────────────────────────────
    loadModelControl: async function () {
      var MOCK = {
        _mock: true,
        skills: [
          { skill: "resume-tailor", tier: "top", defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", envProvider: null, envModel: null, db: null, effectiveProvider: "anthropic", effectiveModel: "claude-sonnet-4-5", source: "default" },
          { skill: "cover-letter-generate", tier: "mid", defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", envProvider: null, envModel: null, db: { provider: "anthropic", model: "claude-sonnet-5" }, effectiveProvider: "anthropic", effectiveModel: "claude-sonnet-5", source: "admin" },
          { skill: "interview-session-step", tier: "top", defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", envProvider: null, envModel: null, db: null, effectiveProvider: "anthropic", effectiveModel: "claude-sonnet-4-5", source: "default" },
          { skill: "query-parse", tier: "cheap", defaultProvider: "gemini", defaultModel: "gemini-2.0-flash", envProvider: null, envModel: null, db: null, effectiveProvider: "gemini", effectiveModel: "gemini-2.0-flash", source: "default" },
          { skill: "chat-assist", tier: "cheap", defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5", envProvider: null, envModel: null, db: null, effectiveProvider: "anthropic", effectiveModel: "claude-haiku-4-5", source: "default" },
        ],
        global: null, globalEnv: null,
        availableProviders: ["anthropic", "gemini", "openai"],
        modelCatalog: {
          anthropic: ["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-5", "claude-sonnet-5"],
          gemini: ["gemini-2.0-flash"], openai: ["gpt-4o-mini"], groq: [],
        },
      };
      if (isMock()) return MOCK;
      try {
        var d = await call("console-config", { action: "get" });
        return (d && d.config) ? d.config : MOCK;
      } catch (e) {
        console.warn("[console] console-config failed, using sample data:", e.message);
        return MOCK;
      }
    },
    // ── Console Assistant (agent-run) ─────────────────────────────────
    runAgent: async function (prompt) {
      if (isMock()) {
        return {
          ok: true, _mock: true, status: "done", turns: 2, costUsd: 0.04,
          result: "(Sample) Signups are up 14% this week (86 vs 75), AI spend fell 3% to ~$128, and there is 1 open incident (job-feed latency). Recommendation: review the incident in AI & Health.",
          steps: [
            { type: "tool", tool: "get_pulse", input: { days: 7 }, output: '{"signups":86,"aiCalls":1240,"aiFailed":5,"openIncidents":["critical: job-feed latency"]}' },
            { type: "text", text: "Signups and spend look healthy; one incident needs review." },
          ],
        };
      }
      return callMut("agent-run", { agent: "console", prompt: prompt });
    },
    // ── Marketing Copilot (agent-run agent=marketing + social_drafts) ──
    runMarketing: async function (prompt) {
      if (isMock()) {
        return {
          ok: true, _mock: true, status: "done", turns: 3, costUsd: 0.18,
          result: "(Sample) Created 2 drafts: a LinkedIn post on the '38% never tailor a resume' insight (your best-converting theme) and a TikTok script on interview nerves. Referral traffic converts at 76% — both CTAs push the referral angle.",
        };
      }
      return callMut("agent-run", { agent: "marketing", prompt: prompt });
    },
    // ── Ops Resolver (agent-run agent=resolver) + its Apply levers ─────
    runResolver: async function (prompt) {
      if (isMock()) {
        return {
          ok: true, _mock: true, status: "done", turns: 3, costUsd: 0.11,
          result: "(Sample) interview-session-step failed 6.2% of calls in the last 24h — all errors are Anthropic 529 (overloaded). Other skills are healthy, so this is provider-side, not a prompt regression. Recommended: fail the skill over to OpenAI until Anthropic recovers, and the job-feed incident has been quiet for 48h so it can be closed.",
          steps: [
            { type: "tool", tool: "get_ai_usage_breakdown", input: { days: 1 }, output: '{"bySkill":[{"skill":"interview-session-step","calls":210,"failed":13}]}' },
            { type: "tool", tool: "get_open_incidents", input: {}, output: '[{"id":"inc_1","title":"job-feed latency","severity":"warning"}]' },
            { type: "tool", tool: "propose_action", input: { kind: "set_model_route", params: { skill: "interview-session-step", provider: "openai", model: "gpt-4o-mini" }, reason: "13/210 calls failed with Anthropic 529 in 24h; OpenAI healthy at 0 failures." }, output: '{"queued":true}' },
            { type: "tool", tool: "propose_action", input: { kind: "resolve_incident", params: { incidentId: "inc_1", note: "latency normal for 48h" }, reason: "job-feed latency back under threshold since 2026-06-30." }, output: '{"queued":true}' },
          ],
        };
      }
      return callMut("agent-run", { agent: "resolver", prompt: prompt });
    },
    resolveIncident: async function (id, note) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-incident-update", { incidentId: id, action: "resolve", note: note || "Resolved via Ops Resolver" });
    },
    ackIncident: async function (id) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-incident-update", { incidentId: id, action: "ack" });
    },
    stopPromo: async function () {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-promo", { action: "update", enabled: false });
    },
    startPromo: async function () {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-promo", { action: "update", enabled: true });
    },
    grantQuotaByEmail: async function (email, quota, amount) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("admin-user-adjust", { targetEmail: email, action: "grant_quota", payload: { quota: quota, amount: Number(amount) || 1 } });
    },
    loadDrafts: async function () {
      var MOCK = {
        _mock: true,
        drafts: [
          { id: "d1", platform: "linkedin", status: "draft", hook: "Your CV isn't bad. It's generic.", body: "Most job seekers send the same CV to 40 companies and hear nothing back.\n\nThe data from our users is blunt: tailored applications get replies. Generic ones get silence.\n\nThree things that actually move the needle:\n1. Mirror the job's exact language\n2. Lead with proof, not duties\n3. Cut everything the role doesn't need\n\nYour experience deserves to be seen properly.", hashtags: "#JobSearchZA #CVTips #CareerBoost", link: "https://www.careerboost.co.za/?utm_source=linkedin&utm_medium=social&utm_campaign=generic-cv", rationale: "Activation data: 38% of signups never tailor a resume — the core 'aha' gap.", created_at: "2026-07-02", posted_at: null },
          { id: "d3", platform: "x", status: "posted", hook: "5 CV mistakes SA recruiters see daily 🧵", body: "1/ Your CV has 6 seconds to survive the first scan. These 5 mistakes end it early:\n\n2/ Objective statements from 2005. Replace with a 2-line value summary.\n\n3/ Duties instead of results. 'Managed stock' vs 'Cut stock losses 18%'.\n\n4/ One CV for every job. Tailoring is the single biggest reply-rate lever.\n\n5/ Tailor yours in minutes → link below", hashtags: "#JobSearchZA #CVTips", link: "https://www.careerboost.co.za/?utm_source=x&utm_medium=social&utm_campaign=cv-mistakes-thread", rationale: "CV content is the top-converting theme.", created_at: "2026-06-28", posted_at: "2026-06-29", signups: 4, scheduled_for: null },
          { id: "d2", platform: "tiktok", status: "approved", hook: "POV: the interviewer asks 'tell me about yourself'", scheduled_for: "2026-07-07", body: "HOOK (0-3s): Freeze on camera. 'Tell me about yourself.' Panic.\n\nBEAT 1: 'Every interview starts here. Most people wing it.'\nON-SCREEN: 'The 60-second formula'\n\nBEAT 2: 'Present → Past → Future. What you do, what you've done, why THIS role.'\n\nBEAT 3: 'I practised mine against an AI interviewer until it was automatic.'\n\nCTA: 'Free mock interview — link in bio.'", hashtags: "#InterviewTips #JobTok #SouthAfrica", link: "https://www.careerboost.co.za/?utm_source=tiktok&utm_medium=social&utm_campaign=tell-me-about-yourself", rationale: "Mock interviews convert 3× — biggest upgrade lever.", created_at: "2026-07-01", posted_at: null },
        ],
      };
      if (isMock()) return MOCK;
      try {
        var d = await call("console-growth", { action: "drafts-list" });
        return (d && d.drafts) ? d : { drafts: [] };
      } catch (e) {
        console.warn("[console] drafts-list failed:", e.message);
        return { drafts: [] };
      }
    },
    // patch = {status?} and/or inline edits {hook?, body?, hashtags?}.
    // Accepts a bare status string for the older call sites.
    updateDraft: async function (id, patch) {
      if (isMock()) return { ok: true, _mock: true };
      if (typeof patch === "string") patch = { status: patch };
      return callMut("console-growth", Object.assign({ action: "draft-update", id: id }, patch || {}));
    },
    deleteDraft: async function (id) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("console-growth", { action: "draft-delete", id: id });
    },
    setModelRoute: async function (skill, provider, model) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("console-config", { action: "set-route", skill: skill, provider: provider || "", model: model || "" });
    },
    clearModelRoute: async function (skill) {
      if (isMock()) return { ok: true, _mock: true };
      return callMut("console-config", { action: "clear-route", skill: skill });
    },
  };
})();
