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

  window.CBConsole.util = {
    escapeHtml: escapeHtml, fmt: fmt, sparkPath: sparkPath, areaPaths: areaPaths,
    countUp: countUp, prefersReducedMotion: prefersReducedMotion, toastErr: toastErr,
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
      { icon: "fa-triangle-exclamation", tone: "red", title: "Open incident", sub: "job-feed latency · 38 min", count: 1, action: "Review" },
      { icon: "fa-star", tone: "amber", title: "Testimonials to approve", sub: "2 submitted today", count: 2, action: "Open" },
      { icon: "fa-credit-card", tone: "amber", title: "Failed payment", sub: "Pro renewal · retry scheduled", count: 1, action: "Resolve" },
      { icon: "fa-bolt", tone: "cyan", title: "AI cost spike watch", sub: "resume-tailor · +22% vs avg", count: 1, action: "Inspect" },
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
      { name: "Lerato M.", email: "lerato@…", plan: "Pro", planTone: "violet", calls: 142, spend: "$11.40", status: "normal", statusTone: "green" },
      { name: "Sipho K.", email: "sipho@…", plan: "Career", planTone: "cyan", calls: 98, spend: "$8.10", status: "normal", statusTone: "green" },
      { name: "Anon (free)", email: "q***@…", plan: "Free", planTone: "dim", calls: 71, spend: "$0.00", status: "watch", statusTone: "amber" },
      { name: "Naledi P.", email: "naledi@…", plan: "Plus", planTone: "cyan", calls: 54, spend: "$4.30", status: "normal", statusTone: "green" },
      { name: "Bot? 41.x", email: "burner@…", plan: "Free", planTone: "dim", calls: 230, spend: "$0.00", status: "flagged", statusTone: "red" },
    ],
  };
  function mockPulse(range) {
    var base = MOCK_PULSE[range] || MOCK_PULSE["7d"];
    var n = range === "24h" ? 12 : range === "7d" ? 14 : 30, cur = [], prev = [];
    for (var i = 0; i < n; i++) { cur.push(8 + i * 0.7 + Math.sin(i * 1.3) * 2.2); prev.push(6 + i * 0.45 + Math.sin(i * 1.1) * 1.6); }
    return {
      _mock: true, range: base.range, kpis: base.kpis,
      northStar: { title: "New activations / day", trend: "▲ 18% vs prev", cur: cur, prev: prev },
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
  async function call(fnName, body) {
    var auth = window.CBV2 && window.CBV2.auth;
    var client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    if (!client || !client.functions) throw new Error("Supabase client unavailable.");
    var res = await client.functions.invoke(fnName, { body: body || {} });
    if (res.error) throw new Error(res.error.message || "Edge function error.");
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
  };
})();
