// In-app "you've got a discount" banner.
//
// For a signed-in user who has an active discount available for their next
// subscription — a per-account grant OR the global first-time campaign — this
// shows a bright, persistent banner near the top with the % and an expiry
// countdown (which gets more urgent as the end nears) plus a one-tap CTA that
// opens the upgrade modal. The discount itself is applied server-side at
// checkout; this is the nudge.
//
// Source of truth: the my-discount edge function (promo_grants is
// service-role only, so eligibility must be resolved server-side). We fetch
// once when entitlements become available (i.e. the user is signed in), so
// it never fires on the public/landing pages.
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.discountBanner && window.CBV2.discountBanner._installed) return;

  var state = { discount: null, loaded: false, busy: false, dismissed: false };

  function getClient() {
    var a = window.CBV2 && window.CBV2.auth;
    return a && typeof a.getClient === "function" ? a.getClient() : null;
  }

  function ensureEl() {
    var el = document.getElementById("cb-discount-banner");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cb-discount-banner";
    el.className = "cb-discount-banner";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    el.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest("[data-cb-discount-cta]")) openUpgrade();
      if (t && t.closest && t.closest("[data-cb-discount-dismiss]")) {
        state.dismissed = true;
        try { sessionStorage.setItem("cb_discount_dismissed", "1"); } catch (_e) {}
        render();
      }
    });
    return el;
  }

  function openUpgrade() {
    if (window.CBV2.upgradeModal && typeof window.CBV2.upgradeModal.show === "function") {
      window.CBV2.upgradeModal.show({ reason: "promo" });
    } else {
      location.hash = "#/settings?tab=billing";
    }
  }

  function daysLeft(endsAt) {
    if (!endsAt) return null;
    var s = String(endsAt);
    var end = new Date(s.length <= 10 ? s + "T23:59:59Z" : s);
    if (isNaN(end.getTime())) return null;
    return Math.ceil((end.getTime() - Date.now()) / 86400000);
  }

  function urgencyText(d) {
    if (d == null) return "";
    if (d <= 0) return "Ends today — last chance!";
    if (d === 1) return "Ends tomorrow — act now!";
    if (d <= 7) return "Only " + d + " days left.";
    return "Ends in " + d + " days.";
  }

  function render() {
    var el = ensureEl();
    var d = state.discount;
    var show = !!(d && d.active && d.percent > 0) && !state.dismissed;
    if (!show) {
      el.classList.remove("is-visible");
      document.body.classList.remove("has-discount-banner");
      el.innerHTML = "";
      return;
    }
    var left = daysLeft(d.endsAt);
    var urgent = left != null && left <= 3;
    el.innerHTML =
      '<div class="cb-discount-banner-inner' + (urgent ? " is-urgent" : "") + '">' +
        '<span class="cb-discount-banner-emoji" aria-hidden="true">🎉</span>' +
        '<span class="cb-discount-banner-msg">' +
          '<strong>You\'ve got ' + d.percent + '% off your next upgrade.</strong>' +
          (left != null ? ' <span class="cb-discount-banner-sub">' + urgencyText(left) + '</span>' : '') +
        '</span>' +
        '<button type="button" class="cb-discount-banner-cta" data-cb-discount-cta>Claim ' + d.percent + '% off</button>' +
        '<button type="button" class="cb-discount-banner-x" data-cb-discount-dismiss aria-label="Dismiss">&times;</button>' +
      '</div>';
    el.classList.add("is-visible");
    document.body.classList.add("has-discount-banner");
  }

  function load() {
    if (state.loaded || state.busy) { render(); return; }
    var client = getClient();
    if (!client || !client.functions || typeof client.functions.invoke !== "function") return;
    state.busy = true;
    try { state.dismissed = sessionStorage.getItem("cb_discount_dismissed") === "1"; } catch (_e) {}
    client.functions.invoke("my-discount", { body: {} })
      .then(function (res) {
        state.discount = (res && res.data && res.data.discount) || null;
        state.loaded = true;
      })
      .catch(function () { /* silent — never block the app on the nudge */ })
      .then(function () { state.busy = false; render(); });
  }

  // Only attempt once entitlements exist — that means the user is signed in,
  // so we never hit my-discount (which 401s) on the public pages.
  function wire(attempts) {
    attempts = attempts || 0;
    var ent = window.CBV2 && window.CBV2.entitlements;
    if (!ent || typeof ent.onChange !== "function") {
      if (attempts < 20) setTimeout(function () { wire(attempts + 1); }, 300);
      return;
    }
    ent.onChange(load);
    load();
  }

  window.CBV2.discountBanner = {
    reload: function () { state.loaded = false; load(); },
    _installed: true,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { wire(); });
  } else {
    wire();
  }
})();
