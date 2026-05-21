// Day 4.1 — Offline / sync banner.
//
// Quiet network-health monitor that shows a top-of-viewport banner
// when the user's connection to Supabase is failing. Triggers after
// 3 consecutive failures so one transient blip doesn't startle
// people. Clears on the first success after.
//
// Counts as a failure:
//   - functions.invoke that throws or returns a 5xx
//   - functions.invoke with a network-level error (no status)
//   - explicit recordFailure() calls from service layers if they
//     have richer context (e.g. entitlements.load timeout)
//
// Does NOT count as a failure:
//   - 4xx responses (auth rejected, quota exhausted, bad request).
//     Those are logic errors, not sync problems — surfacing a
//     "we're having trouble syncing" banner for a quota_exhausted
//     would be misleading.
//
// API:
//   syncMonitor.recordSuccess()       — reset counter, hide banner
//   syncMonitor.recordFailure(reason) — increment, show banner at 3
//   syncMonitor.retry()                — fire the optional retry hook
//   syncMonitor.onRetry(fn)            — register a retry handler
//   syncMonitor.getState()             — { consecutiveFailures, visible }
//
// The patch site in auth.service.js wraps client.functions.invoke
// so every Edge Function call auto-reports. That covers ~95% of the
// user-visible Supabase traffic. DB queries via client.from() are
// not wrapped (returns a query builder that's hard to intercept
// cleanly) — service layers calling those can call recordFailure
// explicitly if they care.

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.syncMonitor && window.CBV2.syncMonitor._installed) return;

  const FAILURE_THRESHOLD = 3;
  // Don't auto-show again within 60s after a manual dismiss so the
  // user isn't fighting the banner if the outage persists.
  const DISMISS_COOLDOWN_MS = 60 * 1000;

  const state = {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    lastReason: "",
    visible: false,
    dismissedUntil: 0,
    retryHandlers: [],
  };

  // ---- DOM management -----------------------------------------------------

  function ensureBannerEl() {
    let el = document.getElementById("cb-sync-banner");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cb-sync-banner";
    el.className = "cb-sync-banner";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      '<div class="cb-sync-banner-inner">' +
        '<i class="fa-solid fa-triangle-exclamation cb-sync-banner-icon" aria-hidden="true"></i>' +
        '<span class="cb-sync-banner-msg">We\'re having trouble syncing — retrying…</span>' +
        '<button type="button" class="cb-sync-banner-btn" data-cb-sync-retry>' +
          '<i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry now' +
        '</button>' +
        '<button type="button" class="cb-sync-banner-close" data-cb-sync-dismiss aria-label="Dismiss">' +
          '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' +
        '</button>' +
      '</div>';
    document.body.appendChild(el);

    // Idempotent event delegation.
    el.addEventListener("click", function (ev) {
      const tgt = ev.target && ev.target.closest && ev.target.closest("button");
      if (!tgt) return;
      if (tgt.hasAttribute("data-cb-sync-retry")) {
        retry();
      } else if (tgt.hasAttribute("data-cb-sync-dismiss")) {
        dismiss();
      }
    });
    return el;
  }

  function showBanner() {
    if (state.visible) return;
    if (Date.now() < state.dismissedUntil) return;
    const el = ensureBannerEl();
    el.classList.add("is-visible");
    state.visible = true;
    document.body.classList.add("has-sync-banner");
  }

  function hideBanner() {
    if (!state.visible) {
      // Even when not "visible" in our state, the element may exist
      // from a previous show — make sure it's hidden.
      const el = document.getElementById("cb-sync-banner");
      if (el) el.classList.remove("is-visible");
      document.body.classList.remove("has-sync-banner");
      return;
    }
    const el = document.getElementById("cb-sync-banner");
    if (el) el.classList.remove("is-visible");
    state.visible = false;
    document.body.classList.remove("has-sync-banner");
  }

  // ---- Public API ---------------------------------------------------------

  function recordSuccess() {
    if (state.consecutiveFailures === 0 && !state.visible) return;
    state.consecutiveFailures = 0;
    state.lastReason = "";
    hideBanner();
  }

  function recordFailure(reason) {
    state.consecutiveFailures += 1;
    state.lastFailureAt = Date.now();
    if (reason) state.lastReason = String(reason).slice(0, 200);
    if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
      showBanner();
    }
  }

  function onRetry(fn) {
    if (typeof fn === "function") state.retryHandlers.push(fn);
  }

  function retry() {
    // Re-render the current route — usually the cheapest way to
    // re-trigger the fetchers that failed. Service layers that have
    // their own retry logic can register via onRetry() to do better.
    state.retryHandlers.forEach(function (fn) {
      try { fn(); } catch (e) { /* never let one handler kill the others */ }
    });
    if (typeof window.CBV2.renderCurrentRoute === "function") {
      try { window.CBV2.renderCurrentRoute(); } catch (_e) {}
    }
  }

  function dismiss() {
    state.dismissedUntil = Date.now() + DISMISS_COOLDOWN_MS;
    hideBanner();
  }

  function getState() {
    return {
      consecutiveFailures: state.consecutiveFailures,
      visible: state.visible,
      lastReason: state.lastReason,
      lastFailureAt: state.lastFailureAt,
      dismissedUntil: state.dismissedUntil,
    };
  }

  window.CBV2.syncMonitor = {
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    retry: retry,
    onRetry: onRetry,
    getState: getState,
    _installed: true,
  };

  // ---- Auto-recovery on `online` event ------------------------------------
  // If the browser tells us the network came back, optimistically clear
  // the banner. The next real fetch will either confirm (success →
  // counter stays 0) or re-fail and re-show.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("online", function () {
      hideBanner();
      state.consecutiveFailures = 0;
    });
  }
})();
