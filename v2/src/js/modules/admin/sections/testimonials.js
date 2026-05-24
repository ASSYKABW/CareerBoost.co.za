// Admin section: testimonials management.
//
// Operators can:
//   - See all submitted testimonials (pending first, then approved, then rejected)
//   - Edit quote, name, role, company, sort_order, admin_note
//   - Approve → publishes to landing page (no deploy needed)
//   - Reject → hidden from landing page
//   - Delete → permanent removal
//
// All mutations call admin-testimonials edge function.
// State lives on h.adminTestimonialsRemote so the standard refresh dispatcher works.

(function () {
  window.CBV2   = window.CBV2   || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  // ── State ─────────────────────────────────────────────────────────
  function ensureState() {
    var h = window.CBAdmin.helpers || (window.CBAdmin.helpers = {});
    if (!h.adminTestimonialsRemote) {
      h.adminTestimonialsRemote = {
        status: "idle",
        data:   null,
        error:  "",
        loadedAt: 0,
        editing: null, // id being edited, or null
        busy:   false,
      };
    }
    return h.adminTestimonialsRemote;
  }

  function st(v) { return (window.CBV2.sanitizeText || String)(v); }

  function getCsrfNonce() {
    try {
      var n = sessionStorage.getItem("cb_admin_csrf_nonce");
      if (!n) {
        var a = (crypto.randomUUID && crypto.randomUUID()) || "";
        n = a || ("fallback_" + Date.now() + "_" + Math.random().toString(36).slice(2));
        sessionStorage.setItem("cb_admin_csrf_nonce", n);
      }
      return n;
    } catch (_e) {
      return "ephemeral_" + Date.now();
    }
  }

  function callApi(action, payload) {
    var auth   = window.CBV2.auth;
    var client = auth && auth.getClient && auth.getClient();
    var body   = Object.assign({ action: action }, payload || {});
    var headers = { "X-CB-Admin-Nonce": getCsrfNonce() };
    if (client && client.functions && typeof client.functions.invoke === "function") {
      return client.functions.invoke("admin-testimonials", { body: body, headers: headers })
        .then(function (res) {
          if (res.error) throw res.error;
          if (res.data && res.data.ok === false) throw new Error(res.data.error || "API error");
          return res.data;
        });
    }
    return Promise.reject(new Error("Supabase client unavailable."));
  }

  function fetchList() {
    var state = ensureState();
    if (state.busy) return Promise.resolve();
    state.busy = true;
    state.status = "loading";
    rerender();
    return callApi("list")
      .then(function (data) {
        state.data    = data.testimonials || [];
        state.status  = "ok";
        state.error   = "";
        state.loadedAt = Date.now();
      })
      .catch(function (err) {
        state.status = "error";
        state.error  = err && err.message ? err.message : String(err);
      })
      .finally(function () {
        state.busy = false;
        rerender();
      });
  }

  function doMutation(action, payload) {
    var state = ensureState();
    state.busy = true;
    rerender();
    return callApi(action, payload)
      .then(function () {
        state.editing = null;
        return fetchList();
      })
      .catch(function (err) {
        state.busy = false;
        alert("Error: " + (err && err.message ? err.message : String(err)));
        rerender();
      });
  }

  // ── Render ────────────────────────────────────────────────────────
  var STATUS_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
  var STATUS_CHIP  = { pending: "amber",   approved: "green",    rejected: "red" };

  function chipHtml(text, tone) {
    return '<span class="chip ' + (tone || "blue") + '">' + st(text) + '</span>';
  }

  function renderRow(t) {
    var state   = ensureState();
    var isEditing = state.editing === t.id;
    var tone    = STATUS_CHIP[t.status]  || "blue";
    var label   = STATUS_LABEL[t.status] || t.status;
    var dateStr = t.submitted_at ? new Date(t.submitted_at).toLocaleDateString() : "—";

    if (isEditing) {
      return (
        '<div class="admin-panel" style="margin-bottom:12px;padding:16px;" data-t-id="' + st(t.id) + '">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
            '<input class="admin-input" style="flex:1;min-width:160px;" id="t-edit-name-' + st(t.id) + '" value="' + st(t.name) + '" placeholder="Name" />' +
            '<input class="admin-input" style="flex:1;min-width:160px;" id="t-edit-role-' + st(t.id) + '" value="' + st(t.role) + '" placeholder="Role / title" />' +
            '<input class="admin-input" style="flex:1;min-width:160px;" id="t-edit-company-' + st(t.id) + '" value="' + st(t.company) + '" placeholder="Company / location" />' +
          '</div>' +
          '<textarea class="admin-input" style="width:100%;min-height:90px;margin-bottom:8px;" id="t-edit-quote-' + st(t.id) + '">' + st(t.quote) + '</textarea>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
            '<input class="admin-input" style="width:80px;" id="t-edit-sort-' + st(t.id) + '" type="number" value="' + (t.sort_order || 0) + '" placeholder="Sort" />' +
            '<input class="admin-input" style="flex:1;min-width:200px;" id="t-edit-note-' + st(t.id) + '" value="' + st(t.admin_note || '') + '" placeholder="Admin note (internal)" />' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn btn--primary btn--sm" data-t-action="save" data-t-id="' + st(t.id) + '">Save</button>' +
            '<button class="btn btn--ghost btn--sm"  data-t-action="cancel-edit">Cancel</button>' +
          '</div>' +
        '</div>'
      );
    }

    return (
      '<div class="admin-panel" style="margin-bottom:12px;padding:16px;" data-t-id="' + st(t.id) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">' +
          '<div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
              chipHtml(label, tone) +
              (t.rating ? '<span style="color:#fbbf24;">★</span><small>' + t.rating + '/5</small>' : '') +
              '<small style="color:var(--col-muted,#888);">' + st(dateStr) + '</small>' +
            '</div>' +
            '<strong>' + st(t.name) + '</strong>' +
            (t.role    ? ' <span style="color:var(--col-muted,#888);">·</span> <small>' + st(t.role)    + '</small>' : '') +
            (t.company ? ' <span style="color:var(--col-muted,#888);">·</span> <small>' + st(t.company) + '</small>' : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;">' +
            (t.status !== "approved" ? '<button class="btn btn--sm" style="background:rgba(0,255,136,0.15);color:#00ff88;border:1px solid rgba(0,255,136,0.3);" data-t-action="approve" data-t-id="' + st(t.id) + '">Approve</button>' : '') +
            (t.status !== "rejected" ? '<button class="btn btn--sm" style="background:rgba(255,100,100,0.1);color:#ff8080;border:1px solid rgba(255,100,100,0.25);" data-t-action="reject"  data-t-id="' + st(t.id) + '">Reject</button>'  : '') +
            '<button class="btn btn--ghost btn--sm" data-t-action="edit" data-t-id="' + st(t.id) + '">Edit</button>' +
            '<button class="btn btn--sm" style="background:rgba(255,60,60,0.1);color:#ff6060;border:1px solid rgba(255,60,60,0.2);" data-t-action="delete" data-t-id="' + st(t.id) + '">Delete</button>' +
          '</div>' +
        '</div>' +
        '<blockquote style="border-left:3px solid rgba(255,255,255,0.1);margin:10px 0 0;padding-left:12px;color:var(--col-muted,#aaa);font-size:13px;">' +
          '"' + st(t.quote) + '"' +
        '</blockquote>' +
        (t.email      ? '<small style="color:var(--col-muted,#888);display:block;margin-top:6px;">✉ ' + st(t.email) + '</small>' : '') +
        (t.admin_note ? '<small style="color:var(--col-muted,#888);display:block;margin-top:4px;">Note: ' + st(t.admin_note) + '</small>' : '') +
        (t.sort_order ? '<small style="color:var(--col-muted,#888);display:block;margin-top:4px;">Sort: ' + t.sort_order + '</small>' : '') +
      '</div>'
    );
  }

  function render(data) {
    var state = ensureState();
    if (!state.data && state.status !== "ok") {
      fetchList();
      return '<p style="color:var(--col-muted,#888);padding:20px;">Loading testimonials…</p>';
    }
    if (state.status === "error") {
      return '<p style="color:#ff8080;padding:20px;">Error: ' + st(state.error) + '</p>';
    }

    var list = state.data || [];
    var pending  = list.filter(function (t) { return t.status === "pending"; });
    var approved = list.filter(function (t) { return t.status === "approved"; });
    var rejected = list.filter(function (t) { return t.status === "rejected"; });

    var totalApproved = approved.length;
    var totalPending  = pending.length;
    var h = window.CBAdmin.helpers;

    var statsHtml = (h && h.renderStat)
      ? (
        '<section class="admin-stat-grid">' +
          h.renderStat("Total submitted", list.length, "all time", "cyan") +
          h.renderStat("Pending review", totalPending, "needs action", totalPending ? "amber" : "green") +
          h.renderStat("Live on site", totalApproved, "approved", totalApproved ? "green" : "blue") +
          h.renderStat("Rejected", rejected.length, "not published", "red") +
        '</section>'
      )
      : '';

    var shareUrl = "https://www.careerboost.co.za/testimonial.html";

    function section(title, items) {
      if (!items.length) return '';
      return (
        '<h3 style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--col-muted,#888);margin:20px 0 8px;">' + title + '</h3>' +
        items.map(renderRow).join("")
      );
    }

    return (
      statsHtml +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Testimonials</span><h2>Social proof queue</h2></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
            '<a href="' + shareUrl + '" target="_blank" rel="noopener" class="btn btn--ghost btn--sm">&#128279; Share form</a>' +
            '<button class="btn btn--ghost btn--sm" id="admin-t-refresh-btn">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<p style="font-size:13px;color:var(--col-muted,#888);margin-bottom:16px;">' +
          'Share the form link with users to collect quotes. Approve here to publish live — no deploy needed.' +
        '</p>' +
        (state.busy && !state.data ? '<p style="color:var(--col-muted,#888);">Loading…</p>' : '') +
        '<div id="admin-t-list">' +
          section("Pending review (" + pending.length + ")",  pending) +
          section("Approved — live (" + approved.length + ")", approved) +
          section("Rejected (" + rejected.length + ")",       rejected) +
          (!list.length
            ? '<p style="color:var(--col-muted,#888);padding:20px;text-align:center;">No testimonials yet. Share the form link to start collecting.</p>'
            : '') +
        '</div>' +
      '</article>'
    );
  }

  function rerender() {
    if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") {
      window.CBV2.renderCurrentRoute();
    }
  }

  // ── Delegated click handler (bound once on script load) ───────────
  function bind() {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest("[data-t-action]");
      if (!btn) return;
      var state  = ensureState();
      var action = btn.getAttribute("data-t-action");
      var id     = btn.getAttribute("data-t-id");

      if (action === "approve") {
        if (!confirm("Approve this testimonial? It will appear on the landing page immediately.")) return;
        doMutation("approve", { id: id });
      } else if (action === "reject") {
        doMutation("reject", { id: id });
      } else if (action === "edit") {
        state.editing = id;
        rerender();
      } else if (action === "cancel-edit") {
        state.editing = null;
        rerender();
      } else if (action === "save") {
        var name    = (document.getElementById("t-edit-name-"    + id) || {}).value || "";
        var role    = (document.getElementById("t-edit-role-"    + id) || {}).value || "";
        var company = (document.getElementById("t-edit-company-" + id) || {}).value || "";
        var quote   = (document.getElementById("t-edit-quote-"   + id) || {}).value || "";
        var sort    = parseInt((document.getElementById("t-edit-sort-" + id) || {}).value || "0", 10);
        var note    = (document.getElementById("t-edit-note-"    + id) || {}).value || "";
        if (!quote.trim()) { alert("Quote cannot be empty."); return; }
        doMutation("update", { id: id, name: name, role: role, company: company, quote: quote, sort_order: sort, admin_note: note });
      } else if (action === "delete") {
        if (!confirm("Permanently delete this testimonial? This cannot be undone.")) return;
        doMutation("delete", { id: id });
      }
    });
  }

  if (!window.__CB_TESTIMONIALS_BOUND) {
    window.__CB_TESTIMONIALS_BOUND = true;
    bind();
  }

  window.CBAdmin.sections.testimonials = {
    render: render,
    fetch:  fetchList,
  };
})();
