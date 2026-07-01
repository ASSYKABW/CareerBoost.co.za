// CareerBoost Console — Users section (Phase 2).
//
// Registers window.CBConsole.sections.users = { load(bodyEl) }. The route
// dispatcher calls load() when the user opens the Users nav item. Renders a
// search box + results table, and on row click opens the shared drawer (via
// CBConsole.ui) with a rich detail view fetched from console-users.
//
// Read-only for now: the four action buttons are placeholders that toast which
// existing endpoint they'll call. Mutations (adjust quota / grant promo /
// promote / suspend) get wired to admin-user-adjust / admin-promo /
// admin-promote-user in the next increment, once each contract is matched.
(function () {
  window.CBConsole = window.CBConsole || {};
  window.CBConsole.sections = window.CBConsole.sections || {};
  var U = function () { return window.CBConsole.util; };
  var D = function () { return window.CBConsole.data; };
  var UI = function () { return window.CBConsole.ui || {}; };
  function esc(s) { return U().escapeHtml(s); }

  var state = { q: "" };

  function sampleBadge(on) {
    if (!on) return "";
    return '<div style="margin-bottom:12px;font-size:12px;color:var(--c-amber);background:rgba(255,157,74,.08);border:1px solid rgba(255,157,74,.22);border-radius:10px;padding:8px 12px">' +
      '<i class="fa-solid fa-flask"></i> Sample data — deploy <code>console-users</code> and sign in with MFA to see real accounts.</div>';
  }

  function renderShell() {
    return '<section class="cbc-card cbc-panel">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Operate · users</div><h2>Find a user</h2></div>' +
        '<div style="display:flex;align-items:center;gap:9px;height:38px;padding:0 12px;border-radius:11px;border:1px solid var(--c-border-strong);background:rgba(255,255,255,.03);min-width:240px">' +
          '<i class="fa-solid fa-magnifying-glass" style="color:var(--c-muted)"></i>' +
          '<input data-user-search placeholder="Search email or name…" autocomplete="off" style="flex:1;background:transparent;border:0;outline:0;color:var(--c-text);font:inherit;font-size:13px" /></div></div>' +
      '<div id="cbc-users-results"></div></section>';
  }

  function skeleton() {
    var r = ""; for (var i = 0; i < 5; i++) r += '<div class="cbc-skel" style="height:44px;margin-bottom:8px"></div>';
    return r;
  }
  function emptyState(q) {
    return '<div style="text-align:center;padding:34px;color:var(--c-muted)">' +
      '<i class="fa-solid fa-users" style="font-size:22px;color:var(--c-dim)"></i>' +
      '<p style="margin-top:10px">No users' + (q ? " matching “" + esc(q) + "”" : "") + ".</p></div>";
  }

  function rowsHtml(users) {
    var body = users.map(function (u) {
      return '<tr data-user-row="' + esc(u.id) + '">' +
        '<td><span class="cbc-uchip"><span class="cbc-uav">' + esc((u.name || u.email || "?").charAt(0).toUpperCase()) + "</span>" +
          '<span><div style="font-weight:600">' + esc(u.name || "—") + '</div><div style="font-size:11.5px;color:var(--c-muted);font-family:var(--c-mono)">' + esc(u.email) + "</div></span></span></td>" +
        '<td><span class="cbc-chip ' + (u.planTone || "dim") + '">' + esc(u.plan) + "</span></td>" +
        '<td class="n">' + (u.pipeline != null ? u.pipeline : "—") + "</td>" +
        '<td class="n">' + (u.aiCalls != null ? u.aiCalls : "—") + "</td>" +
        '<td class="n" style="color:var(--c-muted)">' + esc(u.lastActive || "—") + "</td></tr>";
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>User</th><th>Plan</th><th style="text-align:right">Pipeline</th><th style="text-align:right">AI calls</th><th style="text-align:right">Last active</th></tr></thead><tbody>' + body + "</tbody></table>";
  }

  async function fetchAndRender(bodyEl) {
    var results = bodyEl.querySelector("#cbc-users-results");
    if (results) results.innerHTML = skeleton();
    var res = await D().loadUsers(state.q);
    var users = (res && res.users) || [];
    var mock = !!(res && res._mock);
    results = bodyEl.querySelector("#cbc-users-results");
    if (!results) return;
    if (!users.length) { results.innerHTML = sampleBadge(mock) + emptyState(state.q); return; }
    var total = res.total != null ? res.total : users.length;
    results.innerHTML = sampleBadge(mock) +
      '<div style="font-size:12px;color:var(--c-dim);margin-bottom:8px">' + total + " account" + (total === 1 ? "" : "s") + "</div>" +
      rowsHtml(users);
    results.querySelectorAll("[data-user-row]").forEach(function (tr) {
      tr.addEventListener("click", function () { openUser(tr.getAttribute("data-user-row")); });
    });
  }

  function quotaBar(qi) {
    var lim = qi.limit;
    var label = qi.used + " / " + (lim == null ? "∞" : lim);
    var pct = lim == null ? 12 : Math.min(100, Math.round((qi.used / Math.max(1, lim)) * 100));
    var warn = lim != null && qi.used >= lim ? " warn" : "";
    return '<div class="cbc-qbar"><div class="cbc-ql"><span>' + esc(qi.label) + "</span><span>" + esc(label) + "</span></div>" +
      '<div class="cbc-track' + warn + '"><i style="width:' + pct + '%"></i></div></div>';
  }

  function detailHtml(d) {
    var quota = (d.quota || []).map(quotaBar).join("") || '<div style="color:var(--c-muted);font-size:12.5px">No AI usage yet this month.</div>';
    var timeline = (d.timeline || []).length
      ? d.timeline.map(function (t) {
          return '<div class="cbc-fi"><span class="cbc-fd"></span><div><div class="cbc-ft">' + esc(t.event) + '</div><div class="cbc-fm">' + esc(t.when) + (t.module ? " · " + esc(t.module) : "") + "</div></div></div>";
        }).join("")
      : '<div style="color:var(--c-muted);font-size:12.5px">No recent activity.</div>';
    var mfa = d.mfa ? '<div class="cbc-v" style="color:var(--c-ok)">Enabled</div>' : '<div class="cbc-v" style="color:var(--c-amber)">Not set</div>';
    var roleChip = (d.roles && d.roles.length) ? ' <span class="cbc-chip violet" style="margin-left:6px">' + esc(d.roles.join(", ")) + "</span>" : "";
    return '<button class="cbc-dw-x" data-drawer-close><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="cbc-dw-hd"><div class="cbc-dw-av">' + esc((d.name || "?").charAt(0).toUpperCase()) + "</div>" +
        '<div><div class="cbc-nm">' + esc(d.name || "—") + roleChip + '</div><div class="cbc-em">' + esc(d.email) + "</div></div></div>" +
      '<div class="cbc-dw-meta">' +
        '<div><div class="cbc-l">Plan</div><div class="cbc-v">' + esc(d.plan) + (d.planStatus && d.planStatus !== "active" ? " · " + esc(d.planStatus) : "") + "</div></div>" +
        '<div><div class="cbc-l">Joined</div><div class="cbc-v mono">' + esc(d.joined || "—") + "</div></div>" +
        '<div><div class="cbc-l">AI calls (90d)</div><div class="cbc-v mono">' + ((d.stats && d.stats.aiCalls) || 0) + "</div></div>" +
        '<div><div class="cbc-l">MFA</div>' + mfa + "</div></div>" +
      '<div class="cbc-dw-sec">Quota usage (this month)</div>' + quota +
      '<div class="cbc-dw-sec">Recent activity</div><div class="cbc-feed" style="max-height:220px">' + timeline + "</div>" +
      '<div class="cbc-dw-sec">Actions</div><div class="cbc-dw-actions">' +
        '<button class="cbc-btn cbc-sm" data-toast="Adjust quota — wiring to admin-user-adjust next"><i class="fa-solid fa-sliders"></i> Adjust quota</button>' +
        '<button class="cbc-btn cbc-sm" data-toast="Grant promo — wiring to admin-promo next"><i class="fa-solid fa-gift"></i> Grant promo</button>' +
        '<button class="cbc-btn cbc-sm" data-toast="Promote — wiring to admin-promote-user next"><i class="fa-solid fa-user-shield"></i> Promote</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-toast="Suspend — wiring next"><i class="fa-solid fa-ban"></i> Suspend</button></div>';
  }

  function drawerSkeleton() {
    return '<button class="cbc-dw-x" data-drawer-close><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="cbc-skel" style="height:56px;margin-bottom:16px"></div>' +
      '<div class="cbc-skel" style="height:90px;margin-bottom:16px"></div>' +
      '<div class="cbc-skel" style="height:130px"></div>';
  }

  async function openUser(userId) {
    if (UI().openDrawer) UI().openDrawer(drawerSkeleton());
    var res = await D().loadUserDetail(userId);
    var d = (res && res.detail) || {};
    if (UI().openDrawer) UI().openDrawer(detailHtml(d));
  }

  async function load(bodyEl) {
    state.q = "";
    bodyEl.innerHTML = renderShell();
    var input = bodyEl.querySelector("[data-user-search]");
    if (input) {
      var t;
      input.addEventListener("input", function () {
        clearTimeout(t);
        t = setTimeout(function () { state.q = input.value.trim(); fetchAndRender(bodyEl); }, 300);
      });
    }
    fetchAndRender(bodyEl);
  }

  window.CBConsole.sections.users = { load: load };
})();
