// CareerBoost Console — route module (Phase 1: Pulse + Insights + section maps).
//
// Registers the `console` route (reached at #/console). Rendered fullscreen
// by bootstrap.js (added to FULLSCREEN_AUTHED_ROUTES). The legacy admin stays
// untouched at #/admin until cutover (Phase 3).
//
// Architecture: renderConsole() returns the shell synchronously (sidebar +
// topbar + an empty #cbc-body skeleton). afterRender → bindConsole() wires the
// chrome and asynchronously loads data from CBConsole.data (live console-*
// endpoints, or mock fixtures) into the body. Section switching + range are
// in-app state (no hash churn, no router round-trip).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};
  window.CBConsole = window.CBConsole || {};

  var U = function () { return window.CBConsole.util; };
  var D = function () { return window.CBConsole.data; };

  var state = { section: "pulse", range: "7d", pulse: null, insights: null, tick: null };

  var NAV = [
    { sec: "pulse", icon: "fa-gauge-high", label: "Pulse" },
    { sec: "users", icon: "fa-users", label: "Users" },
    { sec: "money", icon: "fa-sack-dollar", label: "Money" },
    { sec: "ai", icon: "fa-microchip", label: "AI &amp; Health", badge: "1" },
    { sec: "growth", icon: "fa-arrow-trend-up", label: "Growth &amp; Marketing", badge: "5" },
  ];
  var SECTIONS = {
    pulse: { title: "Pulse", sub: "Everything you'd check first thing — live." },
    users: { title: "Users", sub: "Find anyone, see their whole story, act in one click." },
    money: { title: "Money", sub: "MRR, subscriptions, churn, and promo performance." },
    ai: { title: "AI &amp; Health", sub: "What AI costs, where it fails, and whether the system is up." },
    growth: { title: "Growth &amp; Marketing", sub: "Where users come from, and every lever to get more." },
  };
  var STUBS = {
    users: { icon: "fa-users", items: [["fa-magnifying-glass", "Instant search", "by email, name, or id"], ["fa-timeline", "Activity timeline", "every signup→action→payment event"], ["fa-sliders", "Adjust quota", "per-skill, with audit trail"], ["fa-gift", "Grant promo / discount", "one-off or campaign"], ["fa-user-shield", "Promote to admin", "role + MFA enforced"], ["fa-ban", "Suspend / restore", "soft-delete, 30-day window"]] },
    money: { icon: "fa-sack-dollar", items: [["fa-chart-line", "MRR & growth", "by plan, with trend"], ["fa-layer-group", "Active subs", "Plus / Pro / Career split"], ["fa-arrow-down-up-across-line", "Churn & retention", "cohort survival"], ["fa-credit-card", "Failed payments", "retry status + recover"], ["fa-tag", "Promo performance", "redemptions → revenue"], ["fa-rotate-left", "Refunds", "14-day window tracker"]] },
    ai: { icon: "fa-microchip", items: [["fa-coins", "Spend by skill/model", "resume, cover, interview…"], ["fa-database", "Cache hit-rate", "prompt + response cache"], ["fa-bolt", "Failure spikes", "provider errors, auto-alert"], ["fa-user-secret", "Abuse watch", "top spenders & burst detection"], ["fa-heart-pulse", "Edge function status", "latency + uptime per function"], ["fa-key", "Credential rotation", "key age + one-click rotate"]] },
    growth: { icon: "fa-arrow-trend-up", items: [["fa-diagram-project", "Attribution", "channel → signup → paid"], ["fa-filter", "Funnel", "visit → activate → upgrade"], ["fa-user-group", "Referrals", "leaderboard + rewards"], ["fa-flask", "A/B experiments", "live variants + lift"], ["fa-pen-nib", "Content studio", "blog + SEO landing pages"], ["fa-paper-plane", "Email & push", "drips, broadcasts, campaigns"]] },
  };

  // ─── Access gate (client-side UX only — endpoints enforce server-side) ──
  function rolesFromUser(user) {
    if (!user) return [];
    var m = user.app_metadata || {};
    return [].concat(m.role || []).concat(m.roles || [])
      .map(function (x) { return String(x || "").toLowerCase().trim(); }).filter(Boolean);
  }
  function hasAccess() {
    if (window.CBConsole.forceMock) return true;
    try { if (new URLSearchParams(window.location.search).get("mock") === "1") return true; } catch (e) { /* ignore */ }
    var cfg = window.CBV2 && window.CBV2.config;
    if (!cfg || typeof cfg.isBackendEnabled !== "function" || !cfg.isBackendEnabled()) return true; // local-only build
    var auth = window.CBV2 && window.CBV2.auth;
    if (!auth || typeof auth.isAuthenticated !== "function" || !auth.isAuthenticated()) return false;
    return rolesFromUser(auth.getUser && auth.getUser()).some(function (r) {
      return ["admin", "owner", "developer"].indexOf(r) >= 0;
    });
  }

  // MFA gate. The console's endpoints require an aal2 (MFA-verified) session
  // (getAuthedAdmin enforces it server-side); without this the console would
  // 403 and fall back to sample data. Reuses CBAdmin.mfa (admin.mfa.js) so
  // there's one MFA surface. Returns: "skip" (mock/dev/signed out), "loading"
  // (snapshot pending), "challenge" (aal1 + a verified factor → 6-digit prompt),
  // "enroll" (aal1 + no factor → point to /mfa-setup.html), or "ok" (aal2).
  function mfaState() {
    if (window.CBConsole.forceMock) return "skip";
    try { if (new URLSearchParams(window.location.search).get("mock") === "1") return "skip"; } catch (e) { /* ignore */ }
    var cfg = window.CBV2 && window.CBV2.config;
    if (!cfg || typeof cfg.isBackendEnabled !== "function" || !cfg.isBackendEnabled()) return "skip";
    var auth = window.CBV2 && window.CBV2.auth;
    if (!auth || typeof auth.isAuthenticated !== "function" || !auth.isAuthenticated()) return "skip";
    var mfa = window.CBAdmin && window.CBAdmin.mfa;
    if (!mfa || typeof mfa.getSnapshot !== "function") return "ok"; // module absent — let the server enforce
    var s = mfa.getSnapshot();
    if (!s || !s.loaded) return "loading";
    if (s.currentLevel === "aal2") return "ok";
    return (s.verifiedFactors && s.verifiedFactors.length) ? "challenge" : "enroll";
  }

  // ─── Shell ─────────────────────────────────────────────────────────
  function renderNav() {
    return NAV.map(function (n) {
      var on = n.sec === state.section ? " is-on" : "";
      var bdg = n.badge ? '<span class="cbc-bdg">' + n.badge + "</span>" : "";
      return '<div class="cbc-nl' + on + '" data-sec="' + n.sec + '"><i class="fa-solid ' + n.icon + '"></i> ' + n.label + bdg + "</div>";
    }).join("");
  }
  function renderSidebar() {
    return (
      '<aside class="cbc-sb" id="cbc-sb">' +
        '<div class="cbc-brand"><div class="cbc-mk">CB</div>' +
          '<div><div class="cbc-nm">Career<span>Boost</span></div><div class="cbc-eb">CONSOLE</div></div></div>' +
        '<nav class="cbc-navg"><p>Operate</p>' + renderNav() + "</nav>" +
        '<div class="cbc-sb-foot"><div class="cbc-av"></div>' +
          '<div><div class="cbc-who">' + currentOperatorName() + '</div><div class="cbc-ro">Owner</div></div>' +
          '<span class="cbc-mfa"><i class="fa-solid fa-shield-halved"></i> MFA</span></div>' +
      "</aside>"
    );
  }
  function currentOperatorName() {
    var auth = window.CBV2 && window.CBV2.auth;
    var user = auth && auth.getUser ? auth.getUser() : null;
    var nm = (user && (user.user_metadata && user.user_metadata.full_name)) || (user && user.email) || "Operator";
    return U().escapeHtml(String(nm).split("@")[0]);
  }
  function renderTopbar() {
    var s = SECTIONS[state.section] || SECTIONS.pulse;
    return (
      '<div class="cbc-top">' +
        '<div style="display:flex;align-items:center;gap:12px">' +
          '<button class="cbc-hamb" data-hamb><i class="fa-solid fa-bars"></i></button>' +
          '<div><h1 id="cbc-title">' + s.title + '</h1><div class="cbc-sub" id="cbc-sub">' + s.sub + "</div></div>" +
        "</div>" +
        '<div class="cbc-top-actions">' +
          '<button class="cbc-search" data-cmd-open><i class="fa-solid fa-magnifying-glass"></i> <span>Search users, actions…</span> <span class="cbc-k">⌘K</span></button>' +
          '<button class="cbc-btn" data-assist title="Ask the Console Assistant"><i class="fa-solid fa-wand-magic-sparkles" style="color:var(--c-violet)"></i> Assistant</button>' +
          '<div class="cbc-seg" id="cbc-seg">' +
            '<button data-range="24h"' + (state.range === "24h" ? ' class="is-on"' : "") + ">24h</button>" +
            '<button data-range="7d"' + (state.range === "7d" ? ' class="is-on"' : "") + ">7d</button>" +
            '<button data-range="30d"' + (state.range === "30d" ? ' class="is-on"' : "") + ">30d</button>" +
          "</div>" +
          '<span class="cbc-pill cbc-env"><i class="fa-solid fa-circle-nodes"></i> production</span>' +
          '<span class="cbc-pill"><span class="cbc-dot"></span> Live</span>' +
        "</div>" +
      "</div>"
    );
  }
  function renderShell() {
    return (
      '<div class="cbc-shell">' + renderSidebar() +
        '<main class="cbc-main">' + renderTopbar() +
          '<div id="cbc-body">' + renderSkeleton() + "</div>" +
        "</main>" +
      "</div>" + renderScaffold()
    );
  }
  function renderSkeleton() {
    var k = "";
    for (var i = 0; i < 6; i++) k += '<div class="cbc-card cbc-kpi"><div class="cbc-skel" style="height:74px"></div></div>';
    return '<section class="cbc-kpis">' + k + "</section>" +
      '<section class="cbc-card cbc-panel"><div class="cbc-skel" style="height:120px"></div></section>';
  }
  function renderScaffold() {
    return (
      '<div class="cbc-scrim" data-drawer-close></div>' +
      '<aside class="cbc-drawer" id="cbc-drawer"></aside>' +
      '<div class="cbc-cmd" id="cbc-cmd"><div class="cbc-cmd-box">' +
        '<div class="cbc-cmd-in"><i class="fa-solid fa-magnifying-glass"></i><input id="cbc-cmd-input" placeholder="Search users, jump to a section, run an action…" /></div>' +
        '<div class="cbc-cmd-list">' +
          '<div class="cbc-cmd-it" data-go="users"><i class="fa-solid fa-user"></i> Find a user… <span class="cbc-kk">Users</span></div>' +
          '<div class="cbc-cmd-it" data-go="money"><i class="fa-solid fa-sack-dollar"></i> Go to Money <span class="cbc-kk">Nav</span></div>' +
          '<div class="cbc-cmd-it" data-go="ai"><i class="fa-solid fa-microchip"></i> Go to AI &amp; Health <span class="cbc-kk">Nav</span></div>' +
          '<div class="cbc-cmd-it" data-go="growth"><i class="fa-solid fa-arrow-trend-up"></i> Go to Growth &amp; Marketing <span class="cbc-kk">Nav</span></div>' +
        "</div>" +
      "</div></div>"
    );
  }
  function renderDenied() {
    return (
      '<div class="cbc"><div class="cbc-main" style="max-width:520px;margin:14vh auto 0">' +
        '<section class="cbc-card cbc-panel" style="text-align:center;padding:34px">' +
          '<div class="cbc-stub-si" style="margin-bottom:12px;font-size:26px;color:var(--c-amber)"><i class="fa-solid fa-shield-halved"></i></div>' +
          '<h1 style="font-size:20px;font-weight:800">Admin access required</h1>' +
          '<p style="color:var(--c-muted);margin:8px 0 18px">This console is restricted to operators. Sign in with an admin account (with MFA) to continue.</p>' +
          '<a class="cbc-btn cbc-primary" href="#/auth">Sign in</a> ' +
          '<a class="cbc-btn" href="#/dashboard">Back to app</a>' +
        "</section></div></div>"
    );
  }
  function renderConsole() {
    if (!hasAccess()) return renderDenied();
    var m = mfaState();
    if (m === "loading") return '<div class="cbc" style="min-height:100vh">' + window.CBAdmin.mfa.renderLoadingScreen() + "</div>";
    if (m === "challenge") return '<div class="cbc" style="min-height:100vh">' + window.CBAdmin.mfa.renderChallengeScreen() + "</div>";
    if (m === "enroll") return '<div class="cbc" style="min-height:100vh">' + window.CBAdmin.mfa.renderEnrollNudge() + "</div>";
    return '<div class="cbc">' + renderShell() + "</div>";
  }

  // ─── Pulse body ────────────────────────────────────────────────────
  function renderKpis(kpis) {
    return '<section class="cbc-kpis">' + kpis.map(function (d) {
      var col = d.tone === "violet" ? "#b06bff" : d.tone === "amber" ? "#ff9d4a" : d.tone === "green" ? "#22c55e" : "#22e3ff";
      var arrow = d.deltaDir === "down" ? "▼ " : d.deltaDir === "up" ? "▲ " : "▼ ";
      return '<div class="cbc-card cbc-kpi cbc-' + d.tone + '">' +
        '<span class="cbc-ac"></span>' +
        '<div class="cbc-lab">' + U().escapeHtml(d.label) + "</div>" +
        '<div class="cbc-rw"><div class="cbc-num" data-count="' + d.value + '" data-fmt="' + d.fmt + '">0</div>' +
          '<span class="cbc-delta ' + d.deltaDir + '">' + arrow + U().escapeHtml(d.delta) + "</span></div>" +
        '<svg class="cbc-spark" viewBox="0 0 200 30" preserveAspectRatio="none">' +
          '<path d="' + U().sparkPath(d.spark, 200, 30) + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "</div>";
    }).join("") + "</section>";
  }
  function renderInsights(ins) {
    var rows = (ins.findings || []).map(function (d) {
      return '<div class="cbc-ins-it">' +
        '<div class="cbc-ins-ic ' + d.sev + '"><i class="fa-solid ' + d.icon + '"></i></div>' +
        '<div class="cbc-ins-bd"><div class="cbc-t">' + U().escapeHtml(d.title) + '</div><div class="cbc-w">' + U().escapeHtml(d.why) + "</div></div>" +
        '<div class="cbc-ins-rt"><span class="cbc-ins-tag ' + d.sev + '">' + U().escapeHtml(d.tag) + "</span>" +
          '<span style="display:flex;gap:6px">' +
            '<button class="cbc-btn cbc-sm cbc-amber" data-ins-fix="1" data-ins-title="' + U().escapeHtml(d.title) + '" title="Diagnose &amp; propose fixes"><i class="fa-solid fa-screwdriver-wrench"></i></button>' +
            '<button class="cbc-btn cbc-sm" data-ins-go="' + d.to + '">' + U().escapeHtml(d.action) + " →</button></span></div>" +
      "</div>";
    }).join("");
    return '<section class="cbc-card cbc-panel cbc-insights">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Insights · what to improve</div><h2>Your biggest levers right now</h2></div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<span class="cbc-chip violet"><i class="fa-solid fa-wand-magic-sparkles"></i> auto-detected</span>' +
          '<button class="cbc-btn cbc-sm" data-toast="Would open the full ranked Insights list">View all ' + (ins.total || (ins.findings || []).length) + "</button></div></div>" +
      '<div id="cbc-ins-list">' + rows + "</div></section>";
  }
  function renderChart(ns) {
    var w = 620, h = 190, all = (ns.cur || []).concat(ns.prev || []);
    var max = Math.max.apply(null, all.length ? all : [1]) || 1;
    function line(pts) {
      var step = pts.length > 1 ? w / (pts.length - 1) : 0;
      return pts.map(function (p, i) { return (i ? "L" : "M") + Math.round(i * step) + " " + Math.round(h - 14 - (p / max) * (h - 28)); }).join(" ");
    }
    var cur = line(ns.cur || []);
    return '<div class="cbc-card cbc-panel">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">North star</div><h2>' + U().escapeHtml(ns.title) + '</h2></div>' +
        '<span class="cbc-chip cyan">' + U().escapeHtml(ns.trend) + "</span></div>" +
      '<svg width="100%" height="190" viewBox="0 0 620 190" preserveAspectRatio="none" style="display:block">' +
        '<defs><linearGradient id="cbcNs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(34,227,255,.30)"/><stop offset="1" stop-color="rgba(34,227,255,0)"/></linearGradient></defs>' +
        '<path d="' + cur + " L " + w + " " + h + " L 0 " + h + ' Z" fill="url(#cbcNs)" stroke="none"/>' +
        '<path d="' + line(ns.prev || []) + '" fill="none" stroke="#b06bff" stroke-width="2" stroke-dasharray="4 4" opacity=".65"/>' +
        '<path d="' + cur + '" fill="none" stroke="#22e3ff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<div style="display:flex;gap:14px;margin-top:8px;font-size:11.5px;color:var(--c-muted)">' +
        '<span><i class="fa-solid fa-minus" style="color:var(--c-cyan)"></i> this period</span>' +
        '<span><i class="fa-solid fa-minus" style="color:var(--c-violet)"></i> previous</span></div></div>';
  }
  function renderAttention(items) {
    var rows = items.map(function (a) {
      return '<div class="cbc-att-it"><div class="cbc-att-ic ' + a.tone + '"><i class="fa-solid ' + a.icon + '"></i></div>' +
        '<div class="cbc-tx">' + U().escapeHtml(a.title) + "<small>" + U().escapeHtml(a.sub) + "</small></div>" +
        '<div class="cbc-rt"><span class="cbc-ct">' + a.count + '</span><button class="cbc-btn cbc-sm cbc-amber" data-resolve>' + U().escapeHtml(a.action) + "</button></div></div>";
    }).join("");
    return '<div class="cbc-card cbc-panel cbc-att"><div class="cbc-ph"><div><div class="cbc-eb">Needs you</div><h2>Attention queue</h2></div></div>' + rows + "</div>";
  }
  function renderFeed(items) {
    var rows = items.map(feedItemHtml).join("");
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Realtime</div><h2>Live activity</h2></div>' +
      '<span class="cbc-chip green"><span class="cbc-dot"></span> streaming</span></div>' +
      '<div class="cbc-feed" id="cbc-feed">' + rows + "</div></div>";
  }
  function feedItemHtml(o, fresh) {
    return '<div class="cbc-fi ' + (o.tone || "cyan") + (fresh ? " is-new" : "") + '"><span class="cbc-fd"></span>' +
      '<div><div class="cbc-ft">' + o.text + '</div><div class="cbc-fm">' + U().escapeHtml(o.meta || "just now") + "</div></div></div>";
  }
  function renderSpenders(rows) {
    var body = rows.map(function (u, i) {
      return '<tr data-spender="' + i + '"><td><span class="cbc-uchip"><span class="cbc-uav">' + U().escapeHtml(u.name.charAt(0)) + "</span>" + U().escapeHtml(u.name) + "</span></td>" +
        '<td><span class="cbc-chip ' + u.planTone + '">' + U().escapeHtml(u.plan) + "</span></td>" +
        '<td class="n">' + u.calls + '</td><td class="n">' + U().escapeHtml(u.spend) + "</td>" +
        '<td class="n"><span class="cbc-chip ' + u.statusTone + '">' + U().escapeHtml(u.status) + "</span></td></tr>";
    }).join("");
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Abuse watch</div><h2>Top AI spenders (7d)</h2></div>' +
      '<button class="cbc-btn cbc-sm" data-toast="Would open AI & Health → AI Cost">View all</button></div>' +
      '<table class="cbc-table"><thead><tr><th>User</th><th>Plan</th><th style="text-align:right">Calls</th><th style="text-align:right">Spend</th><th style="text-align:right">Status</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>" +
      '<div class="cbc-qa" style="margin-top:16px">' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-toast="Compose broadcast (mock)"><i class="fa-solid fa-bullhorn"></i> Broadcast</button>' +
        '<button class="cbc-btn cbc-sm" data-toast="Promotions (mock)"><i class="fa-solid fa-tag"></i> Promo</button>' +
        '<button class="cbc-btn cbc-sm" data-toast="Opened logs (mock)"><i class="fa-solid fa-terminal"></i> Logs</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-toast="Stop promotion now (mock)"><i class="fa-solid fa-circle-stop"></i> Stop promo</button></div></div>';
  }
  function renderSampleBadge(isMock) {
    if (!isMock) return "";
    return '<div style="margin-bottom:13px;font-size:12px;color:var(--c-amber);background:rgba(255,157,74,.08);border:1px solid rgba(255,157,74,.22);border-radius:10px;padding:8px 12px">' +
      '<i class="fa-solid fa-flask"></i> Sample data — the <code>console-pulse</code> / <code>console-insights</code> endpoints aren\'t live yet. Deploy them to see real numbers.</div>';
  }
  function renderPulseBody() {
    var p = state.pulse, ins = state.insights;
    return renderSampleBadge(p && p._mock) +
      renderKpis(p.kpis) +
      renderInsights(ins) +
      '<section class="cbc-grid cbc-g-2a">' + renderChart(p.northStar) + renderAttention(p.attention) + "</section>" +
      '<section class="cbc-grid cbc-g-2b">' + renderFeed(p.feed) + renderSpenders(p.spenders) + "</section>";
  }
  function renderStubBody(sec) {
    var s = STUBS[sec]; if (!s) return "";
    return '<section class="cbc-card"><div class="cbc-stub"><div class="cbc-si"><i class="fa-solid ' + s.icon + '"></i></div>' +
      "<h2>" + SECTIONS[sec].title + "</h2><p>" + SECTIONS[sec].sub + " &nbsp;This screen is mapped but not built yet — here's what lands here.</p>" +
      '<div class="cbc-stub-grid">' + s.items.map(function (it) {
        return "<div><i class=\"fa-solid " + it[0] + "\"></i><b>" + it[1] + "</b><small>" + it[2] + "</small></div>";
      }).join("") + "</div></div></section>";
  }

  // ─── Interactions ──────────────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function toast(msg) {
    if (window.CBV2 && window.CBV2.toast && window.CBV2.toast.show) { window.CBV2.toast.show(msg); return; }
    U().toastErr(msg);
  }

  function paintCountAndChart() {
    $$("#cbc-body .cbc-num[data-count]").forEach(function (n) {
      U().countUp(n, Number(n.getAttribute("data-count")), n.getAttribute("data-fmt"));
    });
  }

  async function loadAndRenderPulse() {
    var body = $("#cbc-body"); if (!body) return;
    state.pulse = await D().loadPulse(state.range);
    state.insights = await D().loadInsights();
    if (state.section !== "pulse") return; // user navigated away mid-load
    body.innerHTML = renderPulseBody();
    paintCountAndChart();
    startTicker();
  }

  function switchSection(sec) {
    state.section = sec;
    $$("#cbc-sb .cbc-nl").forEach(function (n) { n.classList.toggle("is-on", n.getAttribute("data-sec") === sec); });
    var meta = SECTIONS[sec] || SECTIONS.pulse;
    if ($("#cbc-title")) $("#cbc-title").innerHTML = meta.title;
    if ($("#cbc-sub")) $("#cbc-sub").innerHTML = sec === "pulse" ? meta.sub : "Phase 2 — wires to your existing secure endpoints.";
    closeNav();
    stopTicker();
    var body = $("#cbc-body"); if (!body) return;
    if (sec === "pulse") {
      if (state.pulse) { body.innerHTML = renderPulseBody(); paintCountAndChart(); startTicker(); }
      else { body.innerHTML = renderSkeleton(); loadAndRenderPulse(); }
    } else if (window.CBConsole.sections && window.CBConsole.sections[sec] && typeof window.CBConsole.sections[sec].load === "function") {
      body.innerHTML = renderSkeleton();
      try { window.CBConsole.sections[sec].load(body); }
      catch (err) { console.warn("[console] section '" + sec + "' failed:", err); body.innerHTML = renderStubBody(sec); }
    } else {
      body.innerHTML = renderStubBody(sec);
    }
  }

  // Live activity ticker — only animates with sample data (honest: we don't
  // fabricate "live" events over real data; BE-4 realtime replaces this).
  var TICK_EVENTS = [
    { text: "<b>New signup</b> — naledi@outlook.com", tone: "cyan" },
    { text: "<b>AI spend</b> +$0.42 · resume-tailor", tone: "amber" },
    { text: "<b>Cover letter</b> generated", tone: "cyan" },
    { text: "<b>Upgraded to Plus</b> — R210/mo", tone: "green" },
    { text: "<b>Company research</b> generated · 6 sources", tone: "violet" },
  ];
  var tickIdx = 0;
  function startTicker() {
    stopTicker();
    if (!state.pulse || !state.pulse._mock) return;
    if (U().prefersReducedMotion()) return;
    state.tick = setInterval(function () {
      var feed = $("#cbc-feed");
      if (!feed) { stopTicker(); return; }
      var o = TICK_EVENTS[tickIdx % TICK_EVENTS.length]; tickIdx++;
      var wrap = document.createElement("div"); wrap.innerHTML = feedItemHtml({ text: o.text, meta: "just now", tone: o.tone }, true);
      feed.insertBefore(wrap.firstChild, feed.firstChild);
      while (feed.children.length > 9) feed.removeChild(feed.lastChild);
    }, 4200);
  }
  function stopTicker() { if (state.tick) { clearInterval(state.tick); state.tick = null; } }

  function openDrawer(u) {
    var d = $("#cbc-drawer"); if (!d) return;
    d.innerHTML =
      '<button class="cbc-dw-x" data-drawer-close><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="cbc-dw-hd"><div class="cbc-dw-av">' + U().escapeHtml(u.name.charAt(0)) + "</div>" +
        '<div><div class="cbc-nm">' + U().escapeHtml(u.name) + '</div><div class="cbc-em">' + U().escapeHtml(u.email) + "</div></div></div>" +
      '<div class="cbc-dw-meta">' +
        '<div><div class="cbc-l">Plan</div><div class="cbc-v">' + U().escapeHtml(u.plan) + "</div></div>" +
        '<div><div class="cbc-l">Joined</div><div class="cbc-v mono">2026-04-12</div></div>' +
        '<div><div class="cbc-l">Lifetime spend</div><div class="cbc-v mono">' + U().escapeHtml(u.spend) + "</div></div>" +
        '<div><div class="cbc-l">MFA</div><div class="cbc-v" style="color:var(--c-ok)">Enabled</div></div></div>' +
      '<div class="cbc-dw-sec">Quota usage (this month)</div>' +
      '<div class="cbc-qbar"><div class="cbc-ql"><span>AI resume tailors</span><span>8 / 10</span></div><div class="cbc-track"><i style="width:80%"></i></div></div>' +
      '<div class="cbc-qbar"><div class="cbc-ql"><span>Mock interviews</span><span>3 / 3</span></div><div class="cbc-track warn"><i style="width:100%"></i></div></div>' +
      '<div class="cbc-qbar"><div class="cbc-ql"><span>Cover letters</span><span>6 / 15</span></div><div class="cbc-track"><i style="width:40%"></i></div></div>' +
      '<div class="cbc-dw-sec">Actions</div><div class="cbc-dw-actions">' +
        '<button class="cbc-btn cbc-sm" data-toast="Adjust quota (mock)"><i class="fa-solid fa-sliders"></i> Adjust quota</button>' +
        '<button class="cbc-btn cbc-sm" data-toast="Grant promo (mock)"><i class="fa-solid fa-gift"></i> Grant promo</button>' +
        '<button class="cbc-btn cbc-sm" data-toast="Promote (mock)"><i class="fa-solid fa-user-shield"></i> Promote</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-toast="Suspend (mock)"><i class="fa-solid fa-ban"></i> Suspend</button></div>';
    $(".cbc-scrim").classList.add("is-show"); d.classList.add("is-show");
  }
  function closeDrawer() { var d = $("#cbc-drawer"); if (d) d.classList.remove("is-show"); var s = $(".cbc-scrim"); if (s) s.classList.remove("is-show"); }
  // Generic drawer opener for section modules (e.g. console.users.js).
  function openDrawerHtml(html) {
    var d = $("#cbc-drawer"); if (!d) return;
    d.innerHTML = html;
    var s = $(".cbc-scrim"); if (s) s.classList.add("is-show");
    d.classList.add("is-show");
  }

  // ── Console Assistant (agent-run) ──────────────────────────────────
  // Single-shot Q&A: each Ask = one audited, budget-capped agent run with
  // read-only tools. The transcript lives in the drawer DOM only.
  var assistMode = "console";      // "console" (read-only analyst) | "resolver" (proposes fixes)
  var pendingProposals = [];       // resolver proposals awaiting Apply, indexed by data-rs-apply
  function assistantShell() {
    var isRes = assistMode === "resolver";
    return '<button class="cbc-dw-x" data-drawer-close><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="cbc-dw-hd"><div class="cbc-dw-av" style="background:linear-gradient(135deg,' + (isRes ? "#ff9d4a,#ef4855" : "#b06bff,#22e3ff") + ')"><i class="fa-solid ' + (isRes ? "fa-screwdriver-wrench" : "fa-wand-magic-sparkles") + '"></i></div>' +
        '<div><div class="cbc-nm">' + (isRes ? "Ops Resolver" : "Console Assistant") + '</div><div class="cbc-em">' + (isRes ? "diagnoses &middot; proposes fixes &middot; you apply" : "read-only &middot; audited &middot; budget-capped") + '</div></div></div>' +
      '<div id="cbc-as-log" class="cbc-feed" style="max-height:none"></div>' +
      '<div class="cbc-dw-sec">' + (isRes ? "Describe the problem" : "Ask") + '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<input id="cbc-as-input" class="cbc-inp" style="flex:1" placeholder="' + (isRes ? "e.g. AI failures are spiking — diagnose and propose fixes" : "e.g. Why did AI spend jump this week?") + '" />' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-assist-ask style="height:34px">' + (isRes ? "Diagnose" : "Ask") + '</button></div>' +
      '<div style="font-size:11px;color:var(--c-dim);margin-top:8px">' +
        (isRes
          ? 'It investigates with real data, then each proposed fix gets an <b>Apply</b> button — nothing runs without your tap.'
          : 'Try: &ldquo;Which channel converts best?&rdquo; &middot; &ldquo;Find thabo&rdquo; &middot; &ldquo;What model is resume-tailor using?&rdquo;') + '</div>';
  }
  function openAssistant(mode, prefill, autorun) {
    assistMode = mode === "resolver" ? "resolver" : "console";
    pendingProposals = [];
    openDrawerHtml(assistantShell());
    var input = $("#cbc-as-input");
    if (input) {
      if (prefill) input.value = prefill;
      setTimeout(function () { input.focus(); }, 80);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { var b = $("[data-assist-ask]"); if (b && !b.disabled) submitAssistant(b); }
      });
      if (autorun && prefill) {
        setTimeout(function () { var b = $("[data-assist-ask]"); if (b && !b.disabled) submitAssistant(b); }, 120);
      }
    }
  }
  // Map an approved proposal onto the EXISTING secure lever endpoints — the
  // Apply tap goes through the same CSRF+MFA+audit path as doing it manually.
  function applyProposal(p) {
    var d = window.CBConsole.data;
    var prm = p.params || {};
    if (p.kind === "set_model_route") return d.setModelRoute(String(prm.skill || ""), String(prm.provider || ""), String(prm.model || ""));
    if (p.kind === "resolve_incident") return d.resolveIncident(String(prm.incidentId || ""), String(prm.note || "Resolved via Ops Resolver"));
    if (p.kind === "ack_incident") return d.ackIncident(String(prm.incidentId || ""));
    if (p.kind === "stop_promo") return d.stopPromo();
    if (p.kind === "grant_quota") return d.grantQuotaByEmail(String(prm.email || ""), String(prm.quota || ""), Number(prm.amount) || 1);
    return Promise.reject(new Error("Unknown action kind: " + p.kind));
  }
  function proposalCardsHtml(props, baseIdx) {
    function summary(prm) {
      return Object.keys(prm || {}).map(function (k) { return k + "=" + prm[k]; }).join(" · ");
    }
    return props.map(function (p, i) {
      return '<div class="cbc-act-panel" style="margin:8px 0 0 19px">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<span class="cbc-chip amber"><i class="fa-solid fa-bolt"></i> ' + U().escapeHtml(p.kind.replace(/_/g, " ")) + '</span>' +
          '<span style="font-family:var(--c-mono);font-size:11px;color:var(--c-muted);word-break:break-all">' + U().escapeHtml(summary(p.params)) + '</span>' +
          '<button class="cbc-btn cbc-primary cbc-sm" data-rs-apply="' + (baseIdx + i) + '" style="margin-left:auto">Apply</button></div>' +
        '<div style="font-size:12px;color:var(--c-muted);margin-top:5px">' + U().escapeHtml(p.reason) + '</div></div>';
    }).join("");
  }
  async function applyProposalClick(btn) {
    var p = pendingProposals[Number(btn.getAttribute("data-rs-apply"))];
    if (!p) return;
    btn.disabled = true;
    try {
      await applyProposal(p);
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Applied';
      toast("Applied: " + p.kind.replace(/_/g, " "));
    } catch (err) {
      btn.disabled = false;
      toast((err && err.message) ? err.message : "Apply failed.");
    }
  }
  async function submitAssistant(btn) {
    var input = $("#cbc-as-input"), log = $("#cbc-as-log");
    if (!input || !log) return;
    var q = input.value.trim(); if (!q) return;
    input.value = ""; btn.disabled = true;
    log.insertAdjacentHTML("beforeend",
      '<div class="cbc-fi violet"><span class="cbc-fd"></span><div><div class="cbc-ft"><b>You</b></div><div class="cbc-fm">' + U().escapeHtml(q) + '</div></div></div>' +
      '<div class="cbc-fi" id="cbc-as-wait"><span class="cbc-fd"></span><div><div class="cbc-ft"><i class="fa-solid fa-circle-notch fa-spin"></i> Investigating&hellip;</div></div></div>');
    try {
      var r = await (assistMode === "resolver" ? window.CBConsole.data.runResolver(q) : window.CBConsole.data.runAgent(q));
      var wait = $("#cbc-as-wait"); if (wait) wait.remove();
      var toolSteps = (r.steps || []).filter(function (s) { return s.type === "tool"; });
      var stepsHtml = toolSteps.length
        ? '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11.5px;color:var(--c-dim)">' + toolSteps.length + ' tool call' + (toolSteps.length === 1 ? "" : "s") + ' &middot; $' + Number(r.costUsd || 0).toFixed(2) + '</summary>' +
          toolSteps.map(function (s) {
            return '<div style="font-family:var(--c-mono);font-size:11px;color:var(--c-muted);margin-top:5px">&#128295; ' + U().escapeHtml(s.tool || "") + ' &rarr; ' + U().escapeHtml(String(s.output || "").slice(0, 160)) + '</div>';
          }).join("") + '</details>'
        : "";
      log.insertAdjacentHTML("beforeend",
        '<div class="cbc-fi green"><span class="cbc-fd"></span><div style="min-width:0"><div class="cbc-ft"><b>' + (assistMode === "resolver" ? "Resolver" : "Assistant") + '</b>' + (r._mock ? ' <span class="cbc-chip amber">sample</span>' : "") + '</div>' +
        '<div style="font-size:13px;line-height:1.5;margin-top:3px;white-space:pre-wrap">' + U().escapeHtml(r.result || r.error || "No answer.") + '</div>' + stepsHtml + "</div></div>");
      // Resolver: turn each propose_action into an Apply card.
      if (assistMode === "resolver") {
        var props = U().extractProposals(r.steps);
        if (props.length) {
          var base = pendingProposals.length;
          pendingProposals = pendingProposals.concat(props);
          log.insertAdjacentHTML("beforeend", proposalCardsHtml(props, base));
        }
      }
    } catch (err) {
      var w = $("#cbc-as-wait"); if (w) w.remove();
      log.insertAdjacentHTML("beforeend",
        '<div class="cbc-fi red"><span class="cbc-fd"></span><div><div class="cbc-ft">Failed</div><div class="cbc-fm">' + U().escapeHtml((err && err.message) || "Agent run failed") + "</div></div></div>");
    }
    btn.disabled = false;
    log.scrollTop = log.scrollHeight;
  }
  function openCmd() { var c = $("#cbc-cmd"); if (c) { c.classList.add("is-show"); var i = $("#cbc-cmd-input"); if (i) setTimeout(function () { i.focus(); }, 60); } }
  function closeCmd() { var c = $("#cbc-cmd"); if (c) c.classList.remove("is-show"); }
  function openNav() { var s = $("#cbc-sb"); if (s) s.classList.add("is-open"); var sc = $(".cbc-scrim"); if (sc) sc.classList.add("is-show"); }
  function closeNav() { var s = $("#cbc-sb"); if (s) s.classList.remove("is-open"); }

  // Single delegated click handler for the whole console — survives the
  // body being re-rendered on every section/range switch.
  function onClick(e) {
    var t = e.target.closest ? e.target.closest("[data-sec],[data-range],[data-resolve],[data-spender],[data-ins-go],[data-ins-fix],[data-rs-apply],[data-toast],[data-cmd-open],[data-drawer-close],[data-hamb],[data-go],[data-assist],[data-assist-ask]") : null;
    if (!t) return;
    if (t.hasAttribute("data-assist")) { openAssistant("console"); return; }
    if (t.hasAttribute("data-assist-ask")) { submitAssistant(t); return; }
    if (t.hasAttribute("data-ins-fix")) {
      openAssistant("resolver", "Investigate and propose fixes: " + (t.getAttribute("data-ins-title") || "current issues"), true);
      return;
    }
    if (t.hasAttribute("data-rs-apply")) { applyProposalClick(t); return; }
    if (t.hasAttribute("data-sec")) { switchSection(t.getAttribute("data-sec")); return; }
    if (t.hasAttribute("data-range")) {
      state.range = t.getAttribute("data-range");
      $$("#cbc-seg button").forEach(function (b) { b.classList.toggle("is-on", b.getAttribute("data-range") === state.range); });
      state.pulse = null; loadAndRenderPulse(); return;
    }
    if (t.hasAttribute("data-resolve")) { var it = t.closest(".cbc-att-it"); if (it) it.classList.add("is-gone"); toast("Marked resolved"); return; }
    if (t.hasAttribute("data-spender")) { var idx = Number(t.getAttribute("data-spender")); if (state.pulse && state.pulse.spenders[idx]) openDrawer(state.pulse.spenders[idx]); return; }
    if (t.hasAttribute("data-ins-go")) { switchSection(t.getAttribute("data-ins-go")); toast("Jumped to the section to act on this"); return; }
    if (t.hasAttribute("data-go")) { closeCmd(); switchSection(t.getAttribute("data-go")); return; }
    if (t.hasAttribute("data-toast")) { toast(t.getAttribute("data-toast")); return; }
    if (t.hasAttribute("data-cmd-open")) { openCmd(); return; }
    if (t.hasAttribute("data-hamb")) { openNav(); return; }
    if (t.hasAttribute("data-drawer-close")) { closeDrawer(); closeNav(); return; }
  }
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") { e.preventDefault(); openCmd(); }
    if (e.key === "Escape") { closeCmd(); closeDrawer(); }
  }

  var wired = false;
  function bindConsole() {
    if (!hasAccess()) return;
    var m = mfaState();
    if (m === "loading") {
      var mfa = window.CBAdmin && window.CBAdmin.mfa;
      if (mfa && mfa.refreshSnapshot) mfa.refreshSnapshot().then(function () { if (window.CBV2.renderCurrentRoute) window.CBV2.renderCurrentRoute(); });
      return;
    }
    if (m === "challenge") { if (window.CBAdmin.mfa && window.CBAdmin.mfa.bindChallengeForm) window.CBAdmin.mfa.bindChallengeForm(); return; }
    if (m === "enroll") return;
    state.section = "pulse"; state.pulse = null;
    // Delegated handlers are attached once to document; re-binding the route
    // (e.g. navigating away and back) must not stack duplicates.
    if (!wired) {
      document.addEventListener("click", function (e) {
        if (!e.target.closest || !e.target.closest(".cbc")) return;
        onClick(e);
      });
      document.addEventListener("keydown", function (e) { if ($(".cbc")) onKey(e); });
      wired = true;
    }
    loadAndRenderPulse();
  }

  // Tiny UI API so section modules (console.users.js, …) can open the shared
  // drawer + toast without re-implementing them.
  window.CBConsole.ui = { openDrawer: openDrawerHtml, closeDrawer: closeDrawer, toast: toast, openAssistant: openAssistant };

  window.CBV2.routes.console = renderConsole;
  window.CBV2.afterRender.console = bindConsole;
})();
