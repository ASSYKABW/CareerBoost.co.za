// Admin section: Brand Kit (Marketing & Brand engine — Phase 0).
//
// Operators edit the singleton brand_settings row: wordmark, tagline, colors,
// logo variant, OG image, and the voice/tone profile (which Phase 1+ injects
// into AI content generation). Saved via the admin-brand edge function; the
// public site reads the same row via content-public so edits go live with no
// deploy.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function ensureState() {
    var h = window.CBAdmin.helpers || (window.CBAdmin.helpers = {});
    if (!h.adminBrandRemote) {
      h.adminBrandRemote = { status: "idle", data: null, error: "", busy: false };
    }
    return h.adminBrandRemote;
  }

  function st(v) { return (window.CBV2.sanitizeText || String)(v == null ? "" : v); }

  function getCsrfNonce() {
    try {
      var n = sessionStorage.getItem("cb_admin_csrf_nonce");
      if (!n) {
        n = (crypto.randomUUID && crypto.randomUUID()) || ("fallback_" + Date.now());
        sessionStorage.setItem("cb_admin_csrf_nonce", n);
      }
      return n;
    } catch (_e) { return "ephemeral_" + Date.now(); }
  }

  function callApi(action, payload) {
    var auth = window.CBV2.auth;
    var client = auth && auth.getClient && auth.getClient();
    var body = Object.assign({ action: action }, payload || {});
    var headers = { "X-CB-Admin-Nonce": getCsrfNonce() };
    if (client && client.functions && typeof client.functions.invoke === "function") {
      return client.functions.invoke("admin-brand", { body: body, headers: headers })
        .then(function (res) {
          if (res.error) throw res.error;
          if (res.data && res.data.ok === false) throw new Error(res.data.error || "API error");
          return res.data;
        });
    }
    return Promise.reject(new Error("Supabase client unavailable."));
  }

  function fetchBrand() {
    var state = ensureState();
    if (state.busy) return Promise.resolve();
    state.busy = true;
    state.status = "loading";
    rerender();
    return callApi("get")
      .then(function (data) {
        state.data = data.brand || {};
        state.status = "ok";
        state.error = "";
      })
      .catch(function (err) {
        state.status = "error";
        state.error = err && err.message ? err.message : String(err);
      })
      .then(function () { state.busy = false; rerender(); });
  }

  function rerender() {
    if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") {
      window.CBV2.renderCurrentRoute();
    }
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }
  function lines(text) {
    return String(text || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function render() {
    var state = ensureState();
    if (!state.data && state.status !== "ok") {
      fetchBrand();
      return '<p style="color:var(--col-muted,#888);padding:20px;">Loading brand kit…</p>';
    }
    if (state.status === "error") {
      return '<article class="admin-panel"><p style="color:#ff8080;padding:20px;">Error: ' + st(state.error) + '</p>' +
             '<button class="btn btn--ghost btn--sm" data-brand-action="reload">Retry</button></article>';
    }
    var b = state.data || {};
    var vt = b.voice_tone || {};
    var logoVariant = b.logo_variant || "full";

    function opt(v, label) {
      return '<option value="' + v + '"' + (logoVariant === v ? " selected" : "") + ">" + label + "</option>";
    }

    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Marketing &amp; Brand</span><h2>Brand Kit</h2></div>' +
          '<button class="btn btn--ghost btn--sm" data-brand-action="reload">Refresh</button>' +
        '</div>' +
        '<p style="font-size:13px;color:var(--col-muted,#888);margin-bottom:16px;">' +
          'Edit the brand once here — it drives the public site (wordmark, tagline) and the voice the AI content engine writes in. Saves go live without a deploy.' +
        '</p>' +

        '<div class="admin-brand-preview" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;background:rgba(124,240,255,0.06);border:1px solid rgba(124,240,255,0.2);margin-bottom:18px;">' +
          '<span class="num-font" style="font-size:20px;font-weight:700;">' + st(b.wordmark || "CareerBoost") + '</span>' +
          '<span style="font-size:11px;letter-spacing:.14em;color:var(--col-muted,#999);">' + st(b.tagline || "") + '</span>' +
          '<span style="width:18px;height:18px;border-radius:4px;background:' + st(b.primary_color || "#7cf0ff") + ';"></span>' +
          '<span style="width:18px;height:18px;border-radius:4px;background:' + st(b.accent_color || "#a888ff") + ';"></span>' +
        '</div>' +

        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:12px;">' +
          field("Wordmark", '<input class="admin-input" id="brand-wordmark" value="' + st(b.wordmark || "") + '" maxlength="80" />') +
          field("Tagline", '<input class="admin-input" id="brand-tagline" value="' + st(b.tagline || "") + '" maxlength="120" />') +
          field("Primary color", '<input class="admin-input" id="brand-primary" type="text" value="' + st(b.primary_color || "#7cf0ff") + '" placeholder="#7cf0ff" />') +
          field("Accent color", '<input class="admin-input" id="brand-accent" type="text" value="' + st(b.accent_color || "#a888ff") + '" placeholder="#a888ff" />') +
          field("Logo variant", '<select class="admin-input" id="brand-logo-variant">' + opt("mark", "Mark only") + opt("wordmark", "Wordmark only") + opt("full", "Full lockup") + '</select>') +
          field("OG / share image URL", '<input class="admin-input" id="brand-og" value="' + st(b.og_image_url || "") + '" placeholder="https://…/og-image.png" />') +
        '</div>' +

        '<h3 style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--col-muted,#888);margin:18px 0 8px;">Voice &amp; tone (drives AI content)</h3>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:8px;">' +
          field("Tone", '<input class="admin-input" id="brand-vt-tone" value="' + st(vt.tone || "") + '" placeholder="Confident, warm, practical" />') +
          field("Reading level", '<input class="admin-input" id="brand-vt-level" value="' + st(vt.readingLevel || "") + '" placeholder="Grade 8 / plain English" />') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">' +
          field("Do (one per line)", '<textarea class="admin-input" id="brand-vt-do" style="min-height:80px;">' + st((vt.do || []).join("\n")) + '</textarea>') +
          field("Don\'t (one per line)", '<textarea class="admin-input" id="brand-vt-dont" style="min-height:80px;">' + st((vt.dont || []).join("\n")) + '</textarea>') +
        '</div>' +

        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<button class="btn btn--primary btn--sm" data-brand-action="save"' + (state.busy ? " disabled" : "") + '>' + (state.busy ? "Saving…" : "Save brand") + '</button>' +
          (b.updated_at ? '<small style="color:var(--col-muted,#888);">Last updated ' + st(new Date(b.updated_at).toLocaleString()) + '</small>' : '') +
        '</div>' +
      '</article>'
    );
  }

  function field(label, control) {
    return '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--col-muted,#999);">' +
      st(label) + control + '</label>';
  }

  function bind() {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest("[data-brand-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-brand-action");
      var state = ensureState();

      if (action === "reload") { state.status = "idle"; state.data = null; fetchBrand(); return; }
      if (action === "save") {
        var payload = {
          wordmark: val("brand-wordmark"),
          tagline: val("brand-tagline"),
          primary_color: val("brand-primary"),
          accent_color: val("brand-accent"),
          logo_variant: val("brand-logo-variant"),
          og_image_url: val("brand-og"),
          voice_tone: {
            tone: val("brand-vt-tone"),
            readingLevel: val("brand-vt-level"),
            do: lines(val("brand-vt-do")),
            dont: lines(val("brand-vt-dont")),
          },
        };
        state.busy = true; rerender();
        callApi("update", payload)
          .then(function () {
            if (window.CBV2.toast) window.CBV2.toast.success("Brand saved — live on the site shortly.");
            return fetchBrand();
          })
          .catch(function (err) {
            state.busy = false;
            if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Save failed.");
            rerender();
          });
      }
    });
  }

  if (!window.__CB_BRAND_KIT_BOUND) {
    window.__CB_BRAND_KIT_BOUND = true;
    bind();
  }

  window.CBAdmin.sections["brand-kit"] = { render: render, fetch: fetchBrand };
})();
