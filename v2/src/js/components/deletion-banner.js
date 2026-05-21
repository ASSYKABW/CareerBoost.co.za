// Day 4.4 — Pending-deletion banner.
//
// When the user has scheduled their account for deletion via Settings
// → Delete account (soft mode), the server stores
// profiles.pending_deletion_at = now + 7 days. This module reads that
// from entitlements + renders a persistent banner near the top of the
// viewport with a one-tap "Restore" button.
//
// Visibility logic:
//   - Hidden when entitlements.pending_deletion_at is null/undefined
//   - Visible when set and in the future (the grace window)
//   - Auto-hides if entitlements changes (user restored, or
//     pending_deletion_at passed and was purged on the server)
//
// Position: sits BELOW the Day 4.1 sync banner (uses a higher z-index
// than page content but lower than modals). Adds body padding-top when
// visible so sticky topbars aren't covered.

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.deletionBanner && window.CBV2.deletionBanner._installed) return;

  const state = {
    visible: false,
    scheduledFor: null,
    busy: false,    // true while Restore call is in flight
  };

  function getEntitlements() {
    return window.CBV2 && window.CBV2.entitlements;
  }
  function getEntData() {
    const ent = getEntitlements();
    return ent && typeof ent.get === "function" ? ent.get() : null;
  }

  function ensureBannerEl() {
    let el = document.getElementById("cb-deletion-banner");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cb-deletion-banner";
    el.className = "cb-deletion-banner";
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    el.addEventListener("click", function (ev) {
      const btn = ev.target && ev.target.closest && ev.target.closest("button[data-cb-restore]");
      if (btn) restore();
    });
    return el;
  }

  function formatDate(d) {
    if (!d) return "soon";
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];
    });
  }

  function render() {
    const el = ensureBannerEl();
    if (!state.visible) {
      el.classList.remove("is-visible");
      document.body.classList.remove("has-deletion-banner");
      el.innerHTML = "";
      return;
    }
    const dateLabel = escapeHtml(formatDate(state.scheduledFor));
    el.innerHTML =
      '<div class="cb-deletion-banner-inner">' +
        '<i class="fa-solid fa-clock-rotate-left cb-deletion-banner-icon" aria-hidden="true"></i>' +
        '<span class="cb-deletion-banner-msg">' +
          '<strong>Account deletion scheduled for ' + dateLabel + '.</strong>' +
          ' <span class="cb-deletion-banner-sub">Restore now to keep your account, or do nothing and everything is deleted on that date.</span>' +
        '</span>' +
        '<button type="button" class="cb-deletion-banner-btn" data-cb-restore' +
          (state.busy ? ' disabled' : '') + '>' +
          (state.busy
            ? '<i class="fa-solid fa-spinner fa-spin-pulse" aria-hidden="true"></i> Restoring…'
            : '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Restore account') +
        '</button>' +
      '</div>';
    el.classList.add("is-visible");
    document.body.classList.add("has-deletion-banner");
  }

  function sync() {
    const data = getEntData();
    const raw = data && data.pending_deletion_at;
    const parsed = raw ? new Date(raw) : null;
    const now = new Date();
    const shouldShow = !!(parsed && parsed > now);
    state.visible = shouldShow;
    state.scheduledFor = shouldShow ? parsed : null;
    render();
  }

  async function restore() {
    if (state.busy) return;
    state.busy = true;
    render();
    const auth = window.CBV2 && window.CBV2.auth;
    const client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    try {
      let response;
      if (client && client.functions && typeof client.functions.invoke === "function") {
        const invoked = await client.functions.invoke("restore-account", { body: {} });
        if (invoked.error) throw invoked.error;
        response = invoked.data || {};
      } else if (auth && typeof auth.getAccessToken === "function") {
        const token = await auth.getAccessToken();
        const url = window.CBV2.config.getFunctionsUrl() + "/restore-account";
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            apikey: window.CBV2.config.getSupabaseAnon(),
          },
          body: "{}",
        });
        response = await resp.json();
        if (!resp.ok || (response && response.ok === false)) {
          throw new Error((response && response.error) || ("HTTP " + resp.status));
        }
      } else {
        throw new Error("Auth client unavailable.");
      }
      // Refresh entitlements so pending_deletion_at clears, then the
      // sync() call below hides the banner.
      const ent = getEntitlements();
      if (ent && typeof ent.load === "function") {
        try { await ent.load(true); } catch (_e) {}
      }
      if (window.CBV2.toast) window.CBV2.toast.success("Account restored — deletion cancelled.");
    } catch (err) {
      const msg = (err && err.message) || "Restore failed.";
      if (window.CBV2.toast) window.CBV2.toast.error("Couldn't restore account: " + msg);
    } finally {
      state.busy = false;
      sync();
    }
  }

  function wireSubscriptions(attempts) {
    attempts = attempts || 0;
    const ent = getEntitlements();
    if (!ent || typeof ent.onChange !== "function") {
      if (attempts < 20) setTimeout(function () { wireSubscriptions(attempts + 1); }, 250);
      return;
    }
    ent.onChange(sync);
    sync();
  }

  // Public API — mainly for the settings page to nudge sync after the
  // delete RPC completes; the entitlements.onChange subscription
  // usually handles it on its own.
  window.CBV2.deletionBanner = {
    sync: sync,
    restore: restore,
    _installed: true,
  };

  // Boot on DOMContentLoaded so document.body is ready for the
  // appendChild in ensureBannerEl.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireSubscriptions);
  } else {
    wireSubscriptions();
  }
})();
