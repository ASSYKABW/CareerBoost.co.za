// Web Share Target handler — receives jobs shared from other apps.
//
// When a user installs CareerBoost as a PWA (Add to Home Screen on Android),
// the system share sheet adds CareerBoost as a target. Sharing a job URL
// from LinkedIn / Indeed / any browser opens the PWA at /?share=1&url=...
// (params declared in manifest.json under share_target).
//
// Flow:
//   1. captureIncoming() runs immediately when this script loads (before
//      bootstrap.js). If the URL contains ?share=1, extract the candidate
//      job URL from the title/text/url params — Android apps disagree on
//      which they populate — stash it under sessionStorage.cb_pending_share,
//      then strip the share params from the URL with replaceState so
//      reloads don't re-trigger the import.
//
//   2. consumePending() is called by bootstrap after auth + store are both
//      ready. Runs saveApplicationFromJobUrl(), shows a success/dup/error
//      toast, and routes the user to #/applications so they see the new
//      pipeline card.
//
//   3. If the user shared while signed out, the stash survives across the
//      sign-in flow (sessionStorage persists for the tab). consumePending()
//      is called again after auth.onChange fires.

(function () {
  window.CBV2 = window.CBV2 || {};

  const STASH_KEY = "cb_pending_share";
  // Permissive URL matcher. Catches the URL inside a sentence like
  // "Check out this role: https://www.linkedin.com/jobs/view/123".
  // Trailing punctuation (.,;) is stripped after extraction.
  const URL_RE = /(https?:\/\/[^\s<>"]+)/i;

  function extractUrlFrom(text) {
    if (!text) return "";
    const m = String(text).match(URL_RE);
    if (!m) return "";
    // Strip trailing punctuation that's unlikely to be part of the URL.
    return m[1].replace(/[).,;!?]+$/, "");
  }

  function captureIncoming() {
    const qs = window.location.search || "";
    if (qs.indexOf("share=") < 0) return false;

    let params;
    try { params = new URLSearchParams(qs); } catch (e) { return false; }

    const urlParam   = (params.get("url")   || "").trim();
    const textParam  = (params.get("text")  || "").trim();
    const titleParam = (params.get("title") || "").trim();

    // Resolve best candidate URL: explicit `url` param wins, then any URL
    // embedded in text (LinkedIn / WhatsApp typically), then title.
    const url = urlParam
      || extractUrlFrom(textParam)
      || extractUrlFrom(titleParam);

    // Strip the share params from the address bar so reloads don't re-fire.
    try {
      const cleanQs = new URLSearchParams(qs);
      cleanQs.delete("share");
      cleanQs.delete("title");
      cleanQs.delete("text");
      cleanQs.delete("url");
      const cleanSearch = cleanQs.toString();
      const newUrl = window.location.pathname
        + (cleanSearch ? "?" + cleanSearch : "")
        + (window.location.hash || "");
      window.history.replaceState({}, document.title, newUrl);
    } catch (e) { /* ignore */ }

    if (!url) {
      // Nothing usable. Stash a marker so consumePending shows a friendly
      // toast once the toast service is up. Don't write to sessionStorage —
      // a transient global is enough since this only matters for this load.
      window.__cbShareError = "We couldn't find a job URL in what you shared.";
      return true;
    }

    try {
      sessionStorage.setItem(STASH_KEY, JSON.stringify({
        url: url,
        title: titleParam || "",
        text: textParam || "",
        capturedAt: Date.now()
      }));
    } catch (e) { /* sessionStorage may be disabled in private mode */ }

    return true;
  }

  function consumePending() {
    // Surface the "couldn't find URL" error once if it was set during capture.
    if (window.__cbShareError) {
      const t = window.CBV2.toast;
      if (t && t.error) t.error(window.__cbShareError);
      delete window.__cbShareError;
    }

    let stash = null;
    try {
      const raw = sessionStorage.getItem(STASH_KEY);
      stash = raw ? JSON.parse(raw) : null;
    } catch (e) { /* ignore */ }
    if (!stash || !stash.url) return false;

    // Wait for sign-in if needed. Bootstrap calls us again after auth
    // succeeds, so leaving the stash in place is the right move.
    const auth = window.CBV2.auth;
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled && window.CBV2.config.isBackendEnabled();
    if (backendOn && auth && auth.isAuthenticated && !auth.isAuthenticated()) {
      const t = window.CBV2.toast;
      if (t && t.info && !window.__cbSharePromptShown) {
        window.__cbSharePromptShown = true;
        t.info(
          "Sign in to save the job you just shared.",
          { duration: 7000 }
        );
      }
      return false;
    }

    const store = window.CBV2.store;
    if (!store || typeof store.saveApplicationFromJobUrl !== "function") {
      // Store not ready yet — bootstrap will retry after activation.
      return false;
    }

    const res = store.saveApplicationFromJobUrl(stash.url, {});
    try { sessionStorage.removeItem(STASH_KEY); } catch (e) { /* ignore */ }
    delete window.__cbSharePromptShown;

    const t = window.CBV2.toast;

    if (res && res.ok) {
      const app = res.application || {};
      const label = (app.company && app.role && app.company !== "Employer")
        ? (app.company + " — " + app.role)
        : "the shared job";
      if (t && t.success) t.success("Saved " + label + " to your pipeline.");

      // Telemetry — surfaces in Admin so we can see Web Share Target traction.
      try {
        if (window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
          window.CBV2.usage.track("share_target_import", {
            url: stash.url,
            host: (function () {
              try { return new URL(stash.url).hostname; } catch (e) { return ""; }
            })(),
            status: "success"
          }, { module: "pwa", route: "share" });
        }
      } catch (e) { /* never fail an import on telemetry */ }

      // Route to applications so the user sees the new card.
      navigateTo("#/applications");
      return true;
    }

    const msg = (res && res.error) || "Couldn't save that link.";
    if (msg.indexOf("already in your pipeline") >= 0) {
      if (t && t.info) t.info("That job is already in your pipeline.");
      navigateTo("#/applications");
    } else if (t && t.error) {
      t.error(msg);
    }

    try {
      if (window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
        window.CBV2.usage.track("share_target_import", {
          url: stash.url,
          status: msg.indexOf("already") >= 0 ? "duplicate" : "error",
          error: msg
        }, { module: "pwa", route: "share" });
      }
    } catch (e) { /* ignore */ }

    return false;
  }

  function navigateTo(hashRoute) {
    if (window.location.hash === hashRoute) {
      if (typeof window.CBV2.renderCurrentRoute === "function") {
        window.CBV2.renderCurrentRoute();
      }
    } else {
      window.location.hash = hashRoute;
    }
  }

  window.CBV2.shareHandler = {
    captureIncoming: captureIncoming,
    consumePending: consumePending,
    hasPending: function () {
      try { return !!sessionStorage.getItem(STASH_KEY); }
      catch (e) { return false; }
    }
  };

  // Capture immediately on script load. Safe — only touches sessionStorage
  // and the URL bar (replaceState). No DOM dependencies.
  captureIncoming();
})();
