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
        '<button class="cbc-btn cbc-sm" data-act="adjust"><i class="fa-solid fa-sliders"></i> Adjust quota</button>' +
        '<button class="cbc-btn cbc-sm" data-act="promo"><i class="fa-solid fa-gift"></i> Grant promo</button>' +
        '<button class="cbc-btn cbc-sm" data-act="promote"><i class="fa-solid fa-user-shield"></i> Promote</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-act="suspend"><i class="fa-solid fa-ban"></i> Suspend</button></div>' +
      '<div id="cbc-act-form" style="margin-top:12px"></div>';
  }

  function isOperator(d) { return (d.roles || []).some(function (r) { return ["admin", "owner", "developer"].indexOf(r) >= 0; }); }

  // Inline action forms rendered into #cbc-act-form when an action is clicked.
  function formHtml(act, d) {
    if (act === "adjust") {
      return '<div class="cbc-act-panel"><div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">Grant extra quota (adds to this month\'s allowance).</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<select id="cbc-q-key" class="cbc-inp"><option value="ai_resumes">Resume tailors</option><option value="ai_covers">Cover letters</option><option value="ai_mocks">Mock interviews</option><option value="ai_research">Company research</option><option value="ai_question_banks">Question banks</option></select>' +
          '<input id="cbc-q-amt" class="cbc-inp" type="number" min="1" max="1000" value="5" style="width:78px" />' +
          '<button class="cbc-btn cbc-primary cbc-sm" data-act-submit="adjust">Grant</button></div></div>';
    }
    if (act === "promo") {
      return '<div class="cbc-act-panel"><div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">Create a % discount for ' + esc(d.email) + '.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<input id="cbc-p-pct" class="cbc-inp" type="number" min="1" max="99" value="30" style="width:66px" /><span style="font-size:12px;color:var(--c-muted)">% off</span>' +
          '<input id="cbc-p-exp" class="cbc-inp" type="date" title="Optional expiry" />' +
          '<button class="cbc-btn cbc-primary cbc-sm" data-act-submit="promo">Grant discount</button></div></div>';
    }
    if (act === "promote") {
      if (isOperator(d)) {
        return '<div class="cbc-act-panel"><div style="font-size:12.5px;margin-bottom:8px">This user is an operator (' + esc((d.roles || []).join(", ")) + ').</div>' +
          '<button class="cbc-btn cbc-danger cbc-sm" data-act-submit="demote">Remove operator access</button></div>';
      }
      return '<div class="cbc-act-panel"><div style="font-size:12.5px;margin-bottom:8px">Grant <b>admin</b> access to ' + esc(d.email) + '? They\'ll still need MFA to use the console.</div>' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-act-submit="promote">Promote to admin</button></div>';
    }
    if (act === "suspend") {
      return '<div class="cbc-act-panel" style="color:var(--c-muted);font-size:12.5px"><i class="fa-solid fa-circle-info" style="color:var(--c-amber)"></i> No admin suspend endpoint exists yet — this needs a dedicated soft-delete action. Tracked for a later increment.</div>';
    }
    return "";
  }

  function bindDrawer(d) {
    var drawer = document.querySelector("#cbc-drawer"); if (!drawer) return;
    drawer.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.onclick = function () {
        var host = drawer.querySelector("#cbc-act-form"); if (!host) return;
        host.innerHTML = formHtml(btn.getAttribute("data-act"), d);
        var submit = host.querySelector("[data-act-submit]");
        if (submit) submit.onclick = function () { submitAction(d, submit.getAttribute("data-act-submit"), submit); };
      };
    });
  }

  async function submitAction(d, kind, btn) {
    var toast = UI().toast || function (m) { console.log(m); };
    btn.disabled = true;
    try {
      if (kind === "adjust") {
        var q = document.querySelector("#cbc-q-key").value;
        var amt = Math.max(1, Math.min(1000, parseInt(document.querySelector("#cbc-q-amt").value, 10) || 0));
        await D().adjustQuota(d.id, q, amt);
        toast("Granted " + amt + " × " + q.replace("ai_", "").replace(/_/g, " "));
      } else if (kind === "promo") {
        var pct = Math.max(1, Math.min(99, parseInt(document.querySelector("#cbc-p-pct").value, 10) || 0));
        var exp = (document.querySelector("#cbc-p-exp").value || "").trim();
        await D().grantPromo(d.email, pct, exp || null);
        toast(pct + "% discount granted to " + d.email);
      } else if (kind === "promote") {
        await D().promoteUser(d.id, ["admin"]);
        toast("Promoted " + d.email + " to admin");
      } else if (kind === "demote") {
        await D().promoteUser(d.id, []);
        toast("Removed operator access from " + d.email);
      }
      setTimeout(function () { openUser(d.id); }, 400); // refresh so the change reflects
    } catch (e) {
      btn.disabled = false;
      toast((e && e.message) ? e.message : "Action failed.");
    }
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
    bindDrawer(d);
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

  // openUser exposed so other sections (e.g. Pulse's top-spenders table) can
  // open the same real user drawer (quota, timeline, actions).
  window.CBConsole.sections.users = { load: load, openUser: openUser };
})();
