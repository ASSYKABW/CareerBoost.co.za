// Settings → Data & Privacy → Marketing email preference (POPIA).
//
// Single opt-in management for lifecycle/marketing email. Mirrors the
// settings sub-module pattern: render() returns HTML that settings.route.js
// inlines; a single document-level delegated listener (wired once) handles
// loading the current state and toggling it via the email-consent edge fn.
// Transactional/account email is unaffected by this control.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsEmailConsent = window.CBV2.settingsEmailConsent || {};

  function st(v) { return (window.CBV2.sanitizeText || String)(v == null ? "" : v); }

  function render() {
    return '' +
      '<section class="card settings-section" id="cb-econsent-card">' +
        '<div class="panel-head">' +
          '<h2>Marketing emails</h2>' +
          '<span class="chip cyan">Your choice</span>' +
        '</div>' +
        '<p class="page-subtitle">Job-search tips, product updates, and our weekly SA Job Market Pulse. ' +
          'Account and security emails (sign-in, password resets) are separate and always sent.</p>' +
        '<div data-cb-econsent-out>' +
          '<button class="btn-ghost" type="button" data-cb-econsent-load>' +
            '<i class="fa-solid fa-envelope"></i> Show my email preference</button>' +
        '</div>' +
      '</section>';
  }

  async function call(action, payload) {
    const auth = window.CBV2.auth;
    const config = window.CBV2.config;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) throw new Error("Please sign in first.");
    const client = auth.getClient && auth.getClient();
    var body = Object.assign({ action: action }, payload || {});
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const invoked = await client.functions.invoke("email-consent", { body: body });
      if (invoked.error) throw new Error(invoked.error.message || "Request failed");
      return invoked.data;
    }
    if (!config || !config.getFunctionsUrl) throw new Error("Backend not configured.");
    const token = await auth.getAccessToken();
    const resp = await fetch(config.getFunctionsUrl() + "/email-consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: config.getSupabaseAnon ? config.getSupabaseAnon() : "",
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || !data || data.ok === false) throw new Error((data && data.error) || "Request failed");
    return data;
  }

  function renderState(out, consent) {
    var onLabel = consent
      ? '<span style="color:var(--success,#7CFCB0);font-weight:600;"><i class="fa-solid fa-circle-check"></i> Subscribed</span>'
      : '<span style="color:var(--muted,rgba(240,244,255,0.6));"><i class="fa-solid fa-circle-minus"></i> Not subscribed</span>';
    var btn = consent
      ? '<button class="btn-ghost" type="button" data-cb-econsent-toggle="0">Unsubscribe</button>'
      : '<button class="btn-primary" type="button" data-cb-econsent-toggle="1">Subscribe me</button>';
    out.innerHTML =
      '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:160px;font-size:14px;">' + onLabel + '</div>' + btn +
      '</div>';
  }

  function setBusy(btn, busy, label) { if (btn) { btn.disabled = !!busy; if (label != null) btn.innerHTML = label; } }

  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;

    var loadBtn = t.closest("[data-cb-econsent-load]");
    if (loadBtn) {
      e.preventDefault();
      var card = loadBtn.closest("#cb-econsent-card");
      var out = card && card.querySelector("[data-cb-econsent-out]");
      setBusy(loadBtn, true, '<i class="fa-solid fa-spinner fa-spin"></i> Loading…');
      call("get").then(function (d) { if (out) renderState(out, !!d.consent); })
        .catch(function (err) {
          setBusy(loadBtn, false, '<i class="fa-solid fa-envelope"></i> Show my email preference');
          if (window.CBV2.toast) window.CBV2.toast.error((err && err.message) || "Couldn't load preference.");
        });
      return;
    }

    var toggle = t.closest("[data-cb-econsent-toggle]");
    if (toggle) {
      e.preventDefault();
      var want = toggle.getAttribute("data-cb-econsent-toggle") === "1";
      var card2 = toggle.closest("#cb-econsent-card");
      var out2 = card2 && card2.querySelector("[data-cb-econsent-out]");
      setBusy(toggle, true, "Saving…");
      call("set", { consent: want }).then(function (d) {
        if (out2) renderState(out2, !!d.consent);
        if (window.CBV2.toast) window.CBV2.toast.success(want ? "You're subscribed. Thanks!" : "You've been unsubscribed.");
      }).catch(function (err) {
        setBusy(toggle, false, want ? "Subscribe me" : "Unsubscribe");
        if (window.CBV2.toast) window.CBV2.toast.error((err && err.message) || "Couldn't save.");
      });
    }
  });

  window.CBV2.settingsEmailConsent.render = render;
})();
