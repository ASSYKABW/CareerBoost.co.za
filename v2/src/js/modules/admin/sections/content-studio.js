// Admin section: Content Studio (Marketing & Brand engine — Phase 0).
//
// Manual content CRUD over content_pieces via the admin-content edge function.
// Lifecycle: draft -> needs_review -> approved -> scheduled -> published -> archived.
// Phase 1 adds the AI "Generate" action; Phase 2 adds the auto-draft cadence.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  var TYPES = [
    ["blog", "Blog / SEO article"],
    ["social_linkedin", "LinkedIn post"],
    ["social_x", "X / Twitter post"],
    ["social_ig", "Instagram caption"],
    ["newsletter", "Newsletter"],
    ["announcement", "In-app announcement"],
    ["push", "Push notification"],
    ["landing_variant", "Landing copy variant"],
    ["landing_seo", "SEO landing page (role + city)"],
  ];
  var STATUSES = ["draft", "needs_review", "approved", "scheduled", "published", "archived"];
  var STATUS_TONE = { draft: "subtle", needs_review: "amber", approved: "blue", scheduled: "cyan", published: "green", archived: "red" };

  function typeLabel(t) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i][0] === t) return TYPES[i][1]; return t; }

  function ensureState() {
    var h = window.CBAdmin.helpers || (window.CBAdmin.helpers = {});
    if (!h.adminContentRemote) {
      h.adminContentRemote = { status: "idle", data: null, error: "", busy: false, editing: null, creating: false };
    }
    return h.adminContentRemote;
  }

  function st(v) { return (window.CBV2.sanitizeText || String)(v == null ? "" : v); }

  // Phase 4: per-post performance (views/clicks from content-track + attributed signups).
  function renderScorecard() {
    var state = ensureState();
    var rows = state.scorecard || [];
    var cell = 'style="padding:6px 8px;text-align:right;"';
    var body = rows.length
      ? rows.map(function (r) {
          return "<tr><td style=\"padding:6px 8px;\">" + st(r.title || r.slug) + "</td>" +
            "<td " + cell + ">" + (r.views || 0) + "</td>" +
            "<td " + cell + ">" + (r.clicks || 0) + "</td>" +
            "<td style=\"padding:6px 8px;text-align:right;color:var(--accent,#7cf0ff);font-weight:600;\">" + (r.signups || 0) + "</td></tr>";
        }).join("")
      : "<tr><td colspan=\"4\" style=\"padding:10px 8px;color:var(--col-muted,#888);\">No published posts yet, or no traffic recorded. Publish a post and share its link.</td></tr>";
    return (
      '<article class="admin-panel" style="margin-bottom:16px;">' +
        '<div class="admin-panel-head"><div><span>Marketing &amp; Brand</span><h2>Content performance</h2></div>' +
          '<button class="btn btn--ghost btn--sm" data-content-action="perf-close">Hide</button></div>' +
        '<p style="font-size:12.5px;color:var(--col-muted,#888);margin-bottom:10px;">Blog views &amp; clicks, plus signups attributed to each post (utm_campaign = slug).</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead><tr style="text-align:left;color:var(--col-muted,#999);border-bottom:1px solid var(--border,rgba(255,255,255,0.08));">' +
            '<th style="padding:6px 8px;">Post</th><th style="padding:6px 8px;text-align:right;">Views</th>' +
            '<th style="padding:6px 8px;text-align:right;">Clicks</th><th style="padding:6px 8px;text-align:right;">Signups</th></tr></thead>' +
          "<tbody>" + body + "</tbody>" +
        "</table>" +
      "</article>"
    );
  }

  function getCsrfNonce() {
    try {
      var n = sessionStorage.getItem("cb_admin_csrf_nonce");
      if (!n) { n = (crypto.randomUUID && crypto.randomUUID()) || ("fallback_" + Date.now()); sessionStorage.setItem("cb_admin_csrf_nonce", n); }
      return n;
    } catch (_e) { return "ephemeral_" + Date.now(); }
  }

  function callApi(action, payload) {
    var auth = window.CBV2.auth;
    var client = auth && auth.getClient && auth.getClient();
    var body = Object.assign({ action: action }, payload || {});
    var headers = { "X-CB-Admin-Nonce": getCsrfNonce() };
    if (client && client.functions && typeof client.functions.invoke === "function") {
      return client.functions.invoke("admin-content", { body: body, headers: headers })
        .then(function (res) {
          if (res.error) throw res.error;
          if (res.data && res.data.ok === false) throw new Error(res.data.error || "API error");
          return res.data;
        });
    }
    return Promise.reject(new Error("Supabase client unavailable."));
  }

  // Manual trigger of the marketing-cron cadence (admin JWT path). The
  // scheduler hits the same function with X-Cron-Secret.
  function callCron(task) {
    var auth = window.CBV2.auth;
    var client = auth && auth.getClient && auth.getClient();
    if (!(client && client.functions && typeof client.functions.invoke === "function")) {
      return Promise.reject(new Error("Supabase client unavailable."));
    }
    return client.functions.invoke("marketing-cron", { body: { task: task || "draft" }, headers: { "X-CB-Admin-Nonce": getCsrfNonce() } })
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.ok === false) throw new Error(res.data.error || "Cadence failed");
        return res.data;
      });
  }

  function fetchList() {
    var state = ensureState();
    if (state.busy) return Promise.resolve();
    state.busy = true; state.status = "loading"; rerender();
    return callApi("list")
      .then(function (data) { state.data = data.content || []; state.status = "ok"; state.error = ""; })
      .catch(function (err) { state.status = "error"; state.error = err && err.message ? err.message : String(err); })
      .then(function () { state.busy = false; rerender(); });
  }

  function rerender() {
    if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") window.CBV2.renderCurrentRoute();
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }

  // ── AI generation (Phase 1) ─────────────────────────────────────────
  function renderGenForm() {
    var state = ensureState();
    var typeOpts = TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + "</option>"; }).join("");
    var lbl = 'style="display:block;font-size:12px;color:var(--col-muted,#999);margin-bottom:4px;"';
    return (
      '<article class="admin-panel" style="margin-bottom:16px;border:1px solid rgba(124,240,255,0.25);">' +
        '<div class="admin-panel-head"><div><span>Content Studio</span><h2><i class="fa-solid fa-wand-magic-sparkles"></i> Generate with AI</h2></div></div>' +
        '<p style="font-size:12.5px;color:var(--col-muted,#888);margin-bottom:10px;">Writes in your Brand Kit voice using only the facts you provide. Lands as a draft for your review — nothing goes live without approval.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:10px;">' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--col-muted,#999);">Type<select class="admin-input" id="cs-gen-type">' + typeOpts + "</select></label>" +
        "</div>" +
        "<label " + lbl + ">Brief / topic</label>" +
        '<textarea class="admin-input" id="cs-gen-brief" style="width:100%;min-height:70px;margin-bottom:8px;" placeholder="e.g. 5 resume mistakes that cost South African grads interviews"></textarea>' +
        "<label " + lbl + ">Key facts (optional — the AI only uses facts you give it)</label>" +
        '<textarea class="admin-input" id="cs-gen-facts" style="width:100%;min-height:60px;margin-bottom:12px;" placeholder="Real stats / data points, one per line"></textarea>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn--primary btn--sm" data-content-action="gen-run"' + (state.genBusy ? " disabled" : "") + ">" + (state.genBusy ? "Generating…" : "Generate draft") + "</button>" +
          '<button class="btn btn--ghost btn--sm" data-content-action="gen-cancel">Cancel</button>' +
        "</div>" +
      "</article>"
    );
  }

  function fetchBrandVoice() {
    // Best-effort: reuse Brand Kit's cached voice, else fetch admin-brand.
    var h = window.CBAdmin.helpers || {};
    if (h.adminBrandRemote && h.adminBrandRemote.data && h.adminBrandRemote.data.voice_tone) {
      return Promise.resolve(h.adminBrandRemote.data.voice_tone);
    }
    var auth = window.CBV2.auth;
    var client = auth && auth.getClient && auth.getClient();
    if (!(client && client.functions && typeof client.functions.invoke === "function")) return Promise.resolve({});
    return client.functions.invoke("admin-brand", { body: { action: "get" }, headers: { "X-CB-Admin-Nonce": getCsrfNonce() } })
      .then(function (res) { return (res && res.data && res.data.brand && res.data.brand.voice_tone) || {}; })
      .catch(function () { return {}; });
  }

  function doGenerate() {
    var state = ensureState();
    var contentType = val("cs-gen-type") || "blog";
    var brief = val("cs-gen-brief");
    var facts = val("cs-gen-facts");
    if (!brief.trim()) { if (window.CBV2.toast) window.CBV2.toast.error("Add a brief / topic first."); return; }
    if (!(window.CBAI && typeof window.CBAI.runSkill === "function")) { if (window.CBV2.toast) window.CBV2.toast.error("AI engine unavailable."); return; }
    state.genBusy = true; rerender();
    fetchBrandVoice()
      .then(function (voice) {
        return window.CBAI.runSkill("content-generate", { contentType: contentType, brief: brief, data: facts, brandVoice: voice });
      })
      .then(function (envelope) {
        var d = (envelope && envelope.data) || {};
        var bodyText = String(d.body || "");
        var tags = Array.isArray(d.hashtags) ? d.hashtags : [];
        if (tags.length && contentType.indexOf("social") === 0) bodyText += "\n\n" + tags.join(" ");
        return callApi("create", {
          type: contentType,
          title: String(d.title || brief).slice(0, 240),
          body: bodyText,
          excerpt: String(d.excerpt || "").slice(0, 600),
          seo: (d.seo && typeof d.seo === "object") ? d.seo : {},
          created_by: "ai",
          status: "needs_review",
          prompt_version: (envelope && envelope.promptVersion) || "content-generate@v1.0.0",
          source_data: { brief: brief, facts: facts, hashtags: tags },
        });
      })
      .then(function () {
        state.genBusy = false; state.generating = false;
        if (window.CBV2.toast) window.CBV2.toast.success("AI draft created — review it below.");
        return fetchList();
      })
      .catch(function (err) {
        state.genBusy = false;
        if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Generation failed.");
        rerender();
      });
  }

  function renderForm(piece) {
    var p = piece || { type: "blog", title: "", excerpt: "", body: "", slug: "" };
    var typeOpts = TYPES.map(function (t) {
      return '<option value="' + t[0] + '"' + (p.type === t[0] ? " selected" : "") + ">" + t[1] + "</option>";
    }).join("");
    var heading = piece && piece.id ? "Edit content" : "New content";
    return (
      '<article class="admin-panel" style="margin-bottom:16px;">' +
        '<div class="admin-panel-head"><div><span>Content Studio</span><h2>' + heading + '</h2></div></div>' +
        (piece && piece.id ? '<input type="hidden" id="cs-id" value="' + st(piece.id) + '" />' : '') +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:10px;">' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--col-muted,#999);">Type<select class="admin-input" id="cs-type">' + typeOpts + '</select></label>' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--col-muted,#999);">Title<input class="admin-input" id="cs-title" value="' + st(p.title) + '" maxlength="240" /></label>' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--col-muted,#999);">Slug (blog, optional)<input class="admin-input" id="cs-slug" value="' + st(p.slug || "") + '" placeholder="auto from title" /></label>' +
        '</div>' +
        '<label style="display:block;font-size:12px;color:var(--col-muted,#999);margin-bottom:4px;">Excerpt</label>' +
        '<input class="admin-input" id="cs-excerpt" style="width:100%;margin-bottom:10px;" value="' + st(p.excerpt) + '" maxlength="600" />' +
        '<label style="display:block;font-size:12px;color:var(--col-muted,#999);margin-bottom:4px;">Body</label>' +
        '<textarea class="admin-input" id="cs-body" style="width:100%;min-height:200px;margin-bottom:12px;">' + st(p.body || "") + '</textarea>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn--primary btn--sm" data-content-action="' + (piece && piece.id ? "save-edit" : "save-new") + '">Save</button>' +
          '<button class="btn btn--ghost btn--sm" data-content-action="cancel">Cancel</button>' +
        '</div>' +
      '</article>'
    );
  }

  function statusSelect(p) {
    var opts = STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (p.status === s ? " selected" : "") + ">" + s.replace(/_/g, " ") + "</option>";
    }).join("");
    return '<select class="admin-input" style="width:auto;padding:4px 8px;" data-content-status data-content-id="' + st(p.id) + '">' + opts + '</select>';
  }

  function renderRow(p) {
    var tone = STATUS_TONE[p.status] || "blue";
    var when = p.updated_at ? new Date(p.updated_at).toLocaleDateString() : "";
    return (
      '<div class="admin-panel" style="margin-bottom:10px;padding:14px 16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">' +
          '<div style="min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">' +
              '<span class="chip ' + tone + '">' + st(p.status.replace(/_/g, " ")) + '</span>' +
              '<span class="chip subtle">' + st(typeLabel(p.type)) + '</span>' +
              (p.created_by === "ai" ? '<span class="chip cyan">AI</span>' : '') +
              '<small style="color:var(--col-muted,#888);">' + st(when) + '</small>' +
            '</div>' +
            '<strong>' + st(p.title || "(untitled)") + '</strong>' +
            (p.excerpt ? '<p style="margin:4px 0 0;font-size:12.5px;color:var(--col-muted,#aaa);">' + st(p.excerpt) + '</p>' : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;align-items:center;flex-wrap:wrap;">' +
            statusSelect(p) +
            '<button class="btn btn--ghost btn--sm" data-content-action="edit" data-content-id="' + st(p.id) + '">Edit</button>' +
            '<button class="btn btn--sm" style="background:rgba(255,60,60,0.1);color:#ff6060;border:1px solid rgba(255,60,60,0.2);" data-content-action="delete" data-content-id="' + st(p.id) + '">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function render() {
    var state = ensureState();
    if (!state.data && state.status !== "ok") {
      fetchList();
      return '<p style="color:var(--col-muted,#888);padding:20px;">Loading content…</p>';
    }
    if (state.status === "error") {
      return '<article class="admin-panel"><p style="color:#ff8080;padding:20px;">Error: ' + st(state.error) + '</p>' +
             '<button class="btn btn--ghost btn--sm" data-content-action="refresh">Retry</button></article>';
    }
    var list = state.data || [];
    var h = window.CBAdmin.helpers;

    var byStatus = {};
    list.forEach(function (p) { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
    var statsHtml = (h && h.renderStat) ? (
      '<section class="admin-stat-grid">' +
        h.renderStat("Drafts", byStatus.draft || 0, "in progress", "subtle") +
        h.renderStat("Needs review", byStatus.needs_review || 0, "awaiting approval", (byStatus.needs_review ? "amber" : "green")) +
        h.renderStat("Published", byStatus.published || 0, "live", "green") +
        h.renderStat("Total", list.length, "all content", "cyan") +
      '</section>'
    ) : '';

    var formHtml = "";
    if (state.generating) formHtml = renderGenForm();
    else if (state.creating) formHtml = renderForm(null);
    else if (state.editing) formHtml = renderForm(state.editing);

    return (
      statsHtml +
      formHtml +
      (state.showPerf ? renderScorecard() : "") +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Marketing &amp; Brand</span><h2>Content Studio</h2></div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button class="btn btn--primary btn--sm" data-content-action="gen-open"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate with AI</button>' +
            '<button class="btn btn--ghost btn--sm" data-content-action="new">+ New content</button>' +
            '<button class="btn btn--ghost btn--sm" data-content-action="cadence"><i class="fa-solid fa-bolt"></i> Run cadence now</button>' +
            '<button class="btn btn--ghost btn--sm" data-content-action="perf"><i class="fa-solid fa-chart-line"></i> Performance</button>' +
            '<button class="btn btn--ghost btn--sm" data-content-action="refresh">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<p style="font-size:13px;color:var(--col-muted,#888);margin-bottom:14px;">' +
          'Draft, review, and schedule content. The AI generator and 3×/week cadence land in the next phases — for now this is your manual content store.' +
        '</p>' +
        (list.length ? list.map(renderRow).join("") :
          '<p style="color:var(--col-muted,#888);padding:20px;text-align:center;">No content yet. Click “New content” to create your first piece.</p>') +
      '</article>'
    );
  }

  function bind() {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest("[data-content-action]");
      if (!btn) return;
      var state = ensureState();
      var action = btn.getAttribute("data-content-action");
      var id = btn.getAttribute("data-content-id");

      if (action === "refresh") { state.status = "idle"; state.data = null; fetchList(); return; }
      if (action === "new") { state.creating = true; state.editing = null; state.generating = false; rerender(); return; }
      if (action === "cancel") { state.creating = false; state.editing = null; rerender(); return; }
      if (action === "gen-open") { state.generating = true; state.creating = false; state.editing = null; rerender(); return; }
      if (action === "gen-cancel") { state.generating = false; rerender(); return; }
      if (action === "gen-run") { doGenerate(); return; }
      if (action === "cadence") {
        if (window.CBV2.toast) window.CBV2.toast.info("Running cadence — generating a fresh draft…");
        callCron("draft")
          .then(function () {
            if (window.CBV2.toast) window.CBV2.toast.success("Cadence ran — a new AI draft is in your review queue.");
            return fetchList();
          })
          .catch(function (err) {
            if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Cadence failed.");
          });
        return;
      }
      if (action === "perf") {
        callApi("scorecard")
          .then(function (d) { state.scorecard = (d && d.scorecard) || []; state.showPerf = true; rerender(); })
          .catch(function (err) { if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Couldn't load performance."); });
        return;
      }
      if (action === "perf-close") { state.showPerf = false; rerender(); return; }
      if (action === "edit") {
        callApi("get", { id: id }).then(function (data) { state.editing = data.piece; state.creating = false; rerender(); })
          .catch(function (err) { if (window.CBV2.toast) window.CBV2.toast.error(err.message || "Load failed."); });
        return;
      }
      if (action === "save-new" || action === "save-edit") {
        var payload = {
          type: val("cs-type"), title: val("cs-title"), slug: val("cs-slug"),
          excerpt: val("cs-excerpt"), body: val("cs-body"),
        };
        if (!payload.title.trim() && !payload.body.trim()) { if (window.CBV2.toast) window.CBV2.toast.error("Add a title or body first."); return; }
        var isEdit = action === "save-edit";
        if (isEdit) payload.id = val("cs-id");
        callApi(isEdit ? "update" : "create", payload).then(function () {
          state.creating = false; state.editing = null;
          if (window.CBV2.toast) window.CBV2.toast.success(isEdit ? "Content updated." : "Draft created.");
          return fetchList();
        }).catch(function (err) { if (window.CBV2.toast) window.CBV2.toast.error(err.message || "Save failed."); });
        return;
      }
      if (action === "delete") {
        if (!confirm("Permanently delete this content piece?")) return;
        callApi("delete", { id: id }).then(function () {
          if (window.CBV2.toast) window.CBV2.toast.success("Deleted.");
          return fetchList();
        }).catch(function (err) { if (window.CBV2.toast) window.CBV2.toast.error(err.message || "Delete failed."); });
      }
    });

    document.addEventListener("change", function (e) {
      var sel = e.target && e.target.closest && e.target.closest("[data-content-status]");
      if (!sel) return;
      var id = sel.getAttribute("data-content-id");
      var status = sel.value;
      var payload = { id: id, status: status };
      if (status === "scheduled") {
        var when = prompt("Schedule for (ISO date-time, e.g. 2026-06-10T09:00):", new Date(Date.now() + 86400000).toISOString().slice(0, 16));
        if (!when) { fetchList(); return; }
        payload.scheduled_at = when;
      }
      callApi("set-status", payload).then(function () {
        if (window.CBV2.toast) window.CBV2.toast.success("Status → " + status.replace(/_/g, " "));
        return fetchList();
      }).catch(function (err) { if (window.CBV2.toast) window.CBV2.toast.error(err.message || "Status change failed."); });
    });
  }

  if (!window.__CB_CONTENT_STUDIO_BOUND) {
    window.__CB_CONTENT_STUDIO_BOUND = true;
    bind();
  }

  window.CBAdmin.sections["content-studio"] = { render: render, fetch: fetchList };
})();
