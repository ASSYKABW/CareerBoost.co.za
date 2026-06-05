// Settings → Data & Privacy → Push notifications.
//
// Manages the PWA Web Push subscription via window.CBPush. The whole card stays
// hidden until push is configured (a VAPID public key is set) AND the browser
// supports it — so it never shows a dead control. Mirrors the settings
// sub-module pattern (render() returns HTML; one delegated listener handles
// load/enable/disable). subscribe() runs from the button click (a user gesture).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsPush = window.CBV2.settingsPush || {};

  function available() {
    return !!(window.CBPush && window.CBPush.isConfigured && window.CBPush.isConfigured());
  }

  function render() {
    if (!available()) return ""; // dormant until VAPID key configured + supported
    return '' +
      '<section class="card settings-section" id="cb-push-card">' +
        '<div class="panel-head">' +
          '<h2>Push notifications</h2>' +
          '<span class="chip cyan">This device</span>' +
        '</div>' +
        '<p class="page-subtitle">Get notified about new matching jobs and reminders to finish an application — even when CareerBoost is closed. Works on this device only; manage it per device.</p>' +
        '<div data-cb-push-out>' +
          '<button class="btn-ghost" type="button" data-cb-push-load>' +
            '<i class="fa-solid fa-bell"></i> Manage notifications</button>' +
        '</div>' +
      '</section>';
  }

  function renderState(out, s) {
    if (s.permission === "denied") {
      out.innerHTML = '<p class="ai-meta" style="color:var(--danger,#ff8080);">Notifications are blocked for this site in your browser settings. Re-enable them there, then reload.</p>';
      return;
    }
    var label = s.subscribed
      ? '<span style="color:var(--success,#7CFCB0);font-weight:600;"><i class="fa-solid fa-circle-check"></i> On for this device</span>'
      : '<span style="color:var(--muted,rgba(240,244,255,0.6));"><i class="fa-solid fa-circle-minus"></i> Off</span>';
    var btn = s.subscribed
      ? '<button class="btn-ghost" type="button" data-cb-push-toggle="0">Turn off</button>'
      : '<button class="btn-primary" type="button" data-cb-push-toggle="1">Turn on</button>';
    out.innerHTML =
      '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:160px;font-size:14px;">' + label + "</div>" + btn +
      "</div>";
  }

  function setBusy(btn, busy, label) { if (btn) { btn.disabled = !!busy; if (label != null) btn.innerHTML = label; } }

  function loadInto(out) {
    return window.CBPush.status().then(function (s) { renderState(out, s); });
  }

  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;

    var loadBtn = t.closest("[data-cb-push-load]");
    if (loadBtn) {
      e.preventDefault();
      var card = loadBtn.closest("#cb-push-card");
      var out = card && card.querySelector("[data-cb-push-out]");
      setBusy(loadBtn, true, '<i class="fa-solid fa-spinner fa-spin"></i> Loading…');
      loadInto(out).catch(function () {
        setBusy(loadBtn, false, '<i class="fa-solid fa-bell"></i> Manage notifications');
        if (window.CBV2.toast) window.CBV2.toast.error("Couldn't read notification status.");
      });
      return;
    }

    var toggle = t.closest("[data-cb-push-toggle]");
    if (toggle) {
      e.preventDefault();
      var want = toggle.getAttribute("data-cb-push-toggle") === "1";
      var card2 = toggle.closest("#cb-push-card");
      var out2 = card2 && card2.querySelector("[data-cb-push-out]");
      setBusy(toggle, true, "Working…");
      var op = want ? window.CBPush.subscribe() : window.CBPush.unsubscribe();
      op.then(function () {
        if (window.CBV2.toast) window.CBV2.toast.success(want ? "Notifications on for this device." : "Notifications off.");
        return loadInto(out2);
      }).catch(function (err) {
        setBusy(toggle, false, want ? "Turn on" : "Turn off");
        if (window.CBV2.toast) window.CBV2.toast.error((err && err.message) || "Couldn't update notifications.");
      });
    }
  });

  window.CBV2.settingsPush.render = render;
})();
