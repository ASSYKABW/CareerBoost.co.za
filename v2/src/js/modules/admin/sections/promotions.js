// Admin section: Promotions (Phase 1 — global intro-discount campaign).
//
// Operators control the singleton promo_settings row: on/off, discount %,
// end date, and which plans/intervals it applies to. Saved via the
// admin-promo edge function; the paystack-checkout function and the public
// site read the same row, so changes go live with no deploy.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  var PLANS = [["plus", "Plus"], ["pro", "Pro"], ["career", "Career"]];
  var INTERVALS = [["monthly", "Monthly"], ["annual", "Annual"]];

  function ensureState() {
    var h = window.CBAdmin.helpers || (window.CBAdmin.helpers = {});
    if (!h.adminPromoRemote) {
      h.adminPromoRemote = { status: "idle", data: null, error: "", busy: false, grants: null, grantsBusy: false };
    }
    return h.adminPromoRemote;
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
      return client.functions.invoke("admin-promo", { body: body, headers: headers })
        .then(function (res) {
          if (res.error) {
            // supabase-js hides the real message behind a generic
            // "non-2xx status code" — dig the actual error out of the body.
            var ctx = res.error.context;
            if (ctx && typeof ctx.json === "function") {
              return ctx.json().then(function (b) {
                throw new Error((b && b.error) || res.error.message || "API error");
              }, function () { throw res.error; });
            }
            throw res.error;
          }
          if (res.data && res.data.ok === false) throw new Error(res.data.error || "API error");
          return res.data;
        });
    }
    return Promise.reject(new Error("Supabase client unavailable."));
  }

  function fetchPromo() {
    var state = ensureState();
    if (state.busy) return Promise.resolve();
    state.busy = true;
    state.status = "loading";
    rerender();
    return callApi("get")
      .then(function (data) {
        state.data = data.promo || {};
        state.status = "ok";
        state.error = "";
      })
      .catch(function (err) {
        state.status = "error";
        state.error = err && err.message ? err.message : String(err);
      })
      .then(function () { state.busy = false; rerender(); });
  }

  function fetchGrants() {
    var state = ensureState();
    if (state.grantsBusy) return Promise.resolve();
    state.grantsBusy = true;
    return callApi("grants-list")
      .then(function (data) { state.grants = (data && data.grants) || []; })
      .catch(function () { if (state.grants === null) state.grants = []; })
      .then(function () { state.grantsBusy = false; rerender(); });
  }

  function rerender() {
    if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") {
      window.CBV2.renderCurrentRoute();
    }
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }
  function checkedList(prefix, pairs) {
    var out = [];
    pairs.forEach(function (p) { if (checked(prefix + p[0])) out.push(p[0]); });
    return out;
  }

  function field(label, control) {
    return '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--col-muted,#999);">' +
      st(label) + control + '</label>';
  }

  function checkRow(prefix, pairs, selected) {
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;padding-top:4px;">' +
      pairs.map(function (p) {
        var on = selected.indexOf(p[0]) >= 0;
        return '<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--col-text,#e8eaf2);cursor:pointer;">' +
          '<input type="checkbox" id="' + prefix + p[0] + '"' + (on ? " checked" : "") + ' /> ' + st(p[1]) +
          '</label>';
      }).join("") +
    '</div>';
  }

  function render() {
    var state = ensureState();
    if (!state.data && state.status !== "ok") {
      fetchPromo();
      return '<p style="color:var(--col-muted,#888);padding:20px;">Loading promotions…</p>';
    }
    if (state.status === "error") {
      return '<article class="admin-panel"><p style="color:#ff8080;padding:20px;">Error: ' + st(state.error) + '</p>' +
             '<button class="btn btn--ghost btn--sm" data-promo-action="reload">Retry</button></article>';
    }
    var p = state.data || {};
    var enabled = !!p.enabled;
    var percent = p.percent != null ? p.percent : 30;
    var endDate = p.end_date ? String(p.end_date).slice(0, 10) : "";
    var plans = Array.isArray(p.plans) ? p.plans : ["plus", "pro", "career"];
    var intervals = Array.isArray(p.intervals) ? p.intervals : ["monthly"];

    var statusChip = enabled
      ? '<span class="chip green">LIVE</span>'
      : '<span class="chip subtle">Off</span>';

    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Marketing &amp; Brand</span><h2>Promotions</h2></div>' +
          '<button class="btn btn--ghost btn--sm" data-promo-action="reload">Refresh</button>' +
        '</div>' +
        '<p style="font-size:13px;color:var(--col-muted,#888);margin-bottom:16px;">' +
          'The first-subscription intro discount. Changes here apply to checkout charges <strong>and</strong> the public banner immediately — no deploy. ' +
          'Only genuine first-time subscribers get it, once each.' +
        '</p>' +

        '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:rgba(124,240,255,0.06);border:1px solid rgba(124,240,255,0.2);margin-bottom:18px;">' +
          statusChip +
          '<span style="font-size:14px;">' + (enabled
            ? st(percent) + '% off the first ' + (intervals.indexOf("annual") >= 0 && intervals.indexOf("monthly") < 0 ? "year" : "month") + ' · ' + st(plans.join(", ")) + (endDate ? ' · until ' + st(endDate) : ' · no end date')
            : 'No promotion running') +
          '</span>' +
        '</div>' +

        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:12px;">' +
          field("Campaign", '<label style="display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--col-text,#e8eaf2);cursor:pointer;padding-top:4px;"><input type="checkbox" id="promo-enabled"' + (enabled ? " checked" : "") + ' /> Enabled</label>') +
          field("Discount %", '<input class="admin-input" id="promo-percent" type="number" min="1" max="99" value="' + st(percent) + '" />') +
          field("End date (optional)", '<input class="admin-input" id="promo-end" type="date" value="' + st(endDate) + '" />') +
        '</div>' +

        '<div style="margin-bottom:8px;">' +
          field("Applies to plans", checkRow("promo-plan-", PLANS, plans)) +
        '</div>' +
        '<div style="margin-bottom:16px;">' +
          field("Applies to intervals", checkRow("promo-int-", INTERVALS, intervals)) +
        '</div>' +

        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<button class="btn btn--primary btn--sm" data-promo-action="save"' + (state.busy ? " disabled" : "") + '>' + (state.busy ? "Saving…" : "Save promotion") + '</button>' +
          (enabled ? '<button class="btn btn--ghost btn--sm" data-promo-action="stop"' + (state.busy ? " disabled" : "") + ' style="color:#ff9b9b;border-color:rgba(255,120,120,0.4);">Stop promotion now</button>' : '') +
          (p.updated_at ? '<small style="color:var(--col-muted,#888);">Last updated ' + st(new Date(p.updated_at).toLocaleString()) + '</small>' : '') +
        '</div>' +
      '</article>'
    ) + renderGrantsSection();
  }

  function renderGrantsSection() {
    var state = ensureState();
    if (state.grants === null && !state.grantsBusy) fetchGrants();
    var grants = state.grants || [];
    var rows = grants.map(function (g) {
      var expired = g.expires_at && new Date(g.expires_at) < new Date();
      var chip = g.status === "active"
        ? (expired ? '<span class="chip subtle">Expired</span>' : '<span class="chip green">Active</span>')
        : (g.status === "redeemed" ? '<span class="chip blue">Redeemed</span>' : '<span class="chip subtle">' + st(g.status) + '</span>');
      var exp = g.expires_at ? new Date(g.expires_at).toLocaleDateString() : "—";
      return '<tr>' +
        '<td style="padding:6px 8px;">' + st(g.email || g.user_id) + '</td>' +
        '<td style="padding:6px 8px;">' + st(g.percent) + '%</td>' +
        '<td style="padding:6px 8px;">' + chip + '</td>' +
        '<td style="padding:6px 8px;">' + st(exp) + '</td>' +
        '<td style="padding:6px 8px;text-align:right;">' + (g.status === "active" ? '<button class="btn btn--ghost btn--sm" data-promo-action="grant-revoke" data-grant-id="' + st(g.id) + '">Revoke</button>' : '') + '</td>' +
      '</tr>';
    }).join("");
    if (!rows) rows = '<tr><td colspan="5" style="padding:10px 8px;color:var(--col-muted,#888);">No grants yet.</td></tr>';

    return (
      '<article class="admin-panel" style="margin-top:16px;">' +
        '<div class="admin-panel-head"><div><span>Marketing &amp; Brand</span><h2>Per-account grants</h2></div>' +
          '<button class="btn btn--ghost btn--sm" data-promo-action="grants-reload">Refresh</button>' +
        '</div>' +
        '<p style="font-size:13px;color:var(--col-muted,#888);margin-bottom:14px;">Give a specific account a one-time % discount on their next subscription — returning customers included. It\'s consumed on their next successful checkout; set an optional expiry.</p>' +
        '<div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:10px;align-items:end;margin-bottom:16px;">' +
          field("Customer email", '<input class="admin-input" id="grant-email" type="email" placeholder="name@example.com" />') +
          field("Discount %", '<input class="admin-input" id="grant-percent" type="number" min="1" max="99" value="30" />') +
          field("Expires (optional)", '<input class="admin-input" id="grant-expires" type="date" />') +
          '<button class="btn btn--primary btn--sm" data-promo-action="grant-create"' + (state.grantsBusy ? " disabled" : "") + '>Grant</button>' +
        '</div>' +
        '<div style="overflow-x:auto;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
            '<thead><tr style="text-align:left;color:var(--col-muted,#888);"><th style="padding:6px 8px;">Email</th><th style="padding:6px 8px;">%</th><th style="padding:6px 8px;">Status</th><th style="padding:6px 8px;">Expires</th><th></th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
      '</article>'
    );
  }

  function bind() {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest("[data-promo-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-promo-action");
      var state = ensureState();

      if (action === "reload") { state.status = "idle"; state.data = null; fetchPromo(); return; }
      if (action === "stop") {
        var ok = (typeof window.confirm !== "function") ||
          window.confirm("Stop the promotion now? The banner and checkout discount turn off immediately. You can re-enable it anytime.");
        if (!ok) return;
        state.busy = true; rerender();
        callApi("update", { enabled: false })
          .then(function () {
            if (window.CBV2.toast) window.CBV2.toast.success("Promotion stopped.");
            return fetchPromo();
          })
          .catch(function (err) {
            state.busy = false;
            if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Couldn't stop promotion.");
            rerender();
          });
        return;
      }
      if (action === "save") {
        var payload = {
          enabled: checked("promo-enabled"),
          percent: Number(val("promo-percent")),
          end_date: val("promo-end"),
          plans: checkedList("promo-plan-", PLANS),
          intervals: checkedList("promo-int-", INTERVALS),
        };
        state.busy = true; rerender();
        callApi("update", payload)
          .then(function () {
            if (window.CBV2.toast) window.CBV2.toast.success("Promotion saved — live now.");
            return fetchPromo();
          })
          .catch(function (err) {
            state.busy = false;
            if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Save failed.");
            rerender();
          });
      }

      if (action === "grants-reload") { state.grants = null; fetchGrants(); return; }
      if (action === "grant-create") {
        var email = val("grant-email").trim();
        var payload = { email: email, percent: Number(val("grant-percent")), expires_at: val("grant-expires") };
        state.grantsBusy = true; rerender();
        callApi("grant-create", payload)
          .then(function () {
            if (window.CBV2.toast) window.CBV2.toast.success("Granted " + payload.percent + "% to " + email + ".");
            state.grants = null;
            return fetchGrants();
          })
          .catch(function (err) {
            state.grantsBusy = false;
            if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Grant failed.");
            rerender();
          });
        return;
      }
      if (action === "grant-revoke") {
        var gid = btn.getAttribute("data-grant-id");
        if (!gid) return;
        state.grantsBusy = true; rerender();
        callApi("grant-revoke", { id: gid })
          .then(function () {
            if (window.CBV2.toast) window.CBV2.toast.success("Grant revoked.");
            state.grants = null;
            return fetchGrants();
          })
          .catch(function (err) {
            state.grantsBusy = false;
            if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Revoke failed.");
            rerender();
          });
        return;
      }
    });
  }

  if (!window.__CB_PROMOTIONS_BOUND) {
    window.__CB_PROMOTIONS_BOUND = true;
    bind();
  }

  window.CBAdmin.sections["promotions"] = { render: render, fetch: fetchPromo };
})();
