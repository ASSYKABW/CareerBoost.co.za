// Phase E2: Candidate-side acquisition attribution capture.
//
// Two concerns, one module:
//
//   1. CAPTURE — on every page load, sniff utm_* + document.referrer +
//      window.location.pathname and stash the bundle in localStorage. The
//      first capture wins (FIRST-TOUCH attribution model) because that's
//      the campaign that actually drove the visit. Later visits where the
//      user clicks through a different UTM are NOT counted — we want the
//      origin signal, not the most recent signal.
//
//   2. POST — when the auth service emits a SIGNED_IN event for the first
//      time (i.e. profile.signup_at is still null because the user just
//      signed up), POST the bundle to /functions/v1/signup-attribution.
//      The backend resolves cf-ipcountry and upserts the profile. On
//      success we clear the localStorage bundle so the next signup on the
//      same browser starts clean.
//
// The capture step is safe to run on every page load — it's a no-op if
// the URL has no UTMs AND localStorage already has a bundle. The POST
// step only fires once per session and gracefully no-ops if the backend
// is unreachable (we don't block sign-in on attribution).

(function () {
  window.CBV2 = window.CBV2 || {};

  const STORAGE_KEY = "cb_acquisition_attr";
  const POST_DONE_KEY = "cb_acquisition_posted";

  function safeReadLocal(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeWriteLocal(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function safeClearLocal(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* private mode */ }
  }

  function hostOf(rawUrl) {
    if (!rawUrl) return null;
    try {
      const u = new URL(rawUrl);
      return u.host.replace(/^www\./, "").toLowerCase().slice(0, 256);
    } catch (e) {
      return null;
    }
  }

  // Capture: read URL params + document.referrer, persist if not already.
  // We always update the landing_path and referrer (no harm in capturing
  // the most recent landing path), but UTMs are first-touch-only.
  function captureAttribution() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const existing = JSON.parse(safeReadLocal(STORAGE_KEY) || "{}");

      const utm = {
        utm_source: params.get("utm_source") || existing.utm_source || null,
        utm_medium: params.get("utm_medium") || existing.utm_medium || null,
        utm_campaign: params.get("utm_campaign") || existing.utm_campaign || null,
        utm_content: params.get("utm_content") || existing.utm_content || null,
        utm_term: params.get("utm_term") || existing.utm_term || null,
        // Referral code (?ref=CODE). First-touch wins, like UTMs — the code
        // that drove the visit gets the credit on signup.
        ref_code: (params.get("ref") || existing.ref_code || "").toString().trim().slice(0, 32) || null,
      };
      // Landing path is captured fresh each visit (most recent wins) so
      // even if a returning visitor lands on a different page, we know
      // which entry point they used most recently. But if we already had
      // a captured path AND no UTMs in the current URL, we keep the
      // original because it was clearly the first-touch entry.
      const hasNewUtms = Object.keys(utm).some((k) => params.get(k) !== null);
      const landing_path = hasNewUtms || !existing.landing_path
        ? (window.location.pathname + window.location.search + window.location.hash).slice(0, 512)
        : existing.landing_path;
      const referrer_host = existing.referrer_host || hostOf(document.referrer);

      const bundle = Object.assign({}, utm, {
        landing_path: landing_path,
        referrer_host: referrer_host,
        captured_at: existing.captured_at || new Date().toISOString(),
      });
      safeWriteLocal(STORAGE_KEY, JSON.stringify(bundle));
      return bundle;
    } catch (e) {
      return null;
    }
  }

  // POST: send the bundle to the backend. Idempotent server-side (first
  // touch wins). We mark POST_DONE_KEY locally so we don't re-fire on
  // every reload — the backend is also idempotent so this is defense in
  // depth, not correctness.
  async function postAttributionIfNeeded() {
    // Already posted on this browser since last clear? Skip.
    if (safeReadLocal(POST_DONE_KEY)) return null;

    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) return null;
    if (!auth.getAccessToken || !auth.getClient) return null;
    const config = window.CBV2.config;
    if (!config || !config.isBackendEnabled || !config.isBackendEnabled()) return null;
    if (!config.getFunctionsUrl) return null;

    const bundle = JSON.parse(safeReadLocal(STORAGE_KEY) || "{}");
    // Even if the bundle is empty (direct visit, no UTMs), we still call
    // the function so the backend records signup_at + cf-ipcountry. The
    // body is just an empty object.
    const payload = {
      utm_source: bundle.utm_source || null,
      utm_medium: bundle.utm_medium || null,
      utm_campaign: bundle.utm_campaign || null,
      utm_content: bundle.utm_content || null,
      utm_term: bundle.utm_term || null,
      referrer_host: bundle.referrer_host || null,
      landing_path: bundle.landing_path || null,
      ref_code: bundle.ref_code || null,
      // Marketing-email consent chosen at signup (single opt-in checkbox).
      marketing_consent: safeReadLocal("cb_marketing_consent") === "1",
    };

    try {
      const client = auth.getClient && auth.getClient();
      let result = null;
      if (client && client.functions && typeof client.functions.invoke === "function") {
        const invoked = await client.functions.invoke("signup-attribution", { body: payload });
        if (invoked.error) throw new Error(invoked.error.message || "Attribution failed");
        result = invoked.data;
      } else {
        const token = await auth.getAccessToken();
        const endpoint = config.getFunctionsUrl() + "/signup-attribution";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            apikey: config.getSupabaseAnon ? config.getSupabaseAnon() : ""
          },
          body: JSON.stringify(payload)
        });
        result = await response.json();
        if (!response.ok || !result || result.ok === false) {
          throw new Error((result && result.error) || "Attribution failed");
        }
      }
      // Success — mark posted so we don't re-fire. If the server says
      // firstTouch was false (already attributed), we still set the flag
      // because there's no value in re-posting.
      safeWriteLocal(POST_DONE_KEY, "1");
      // Clear the bundle — it served its purpose. Next signup on this
      // browser starts clean.
      safeClearLocal(STORAGE_KEY);
      safeClearLocal("cb_marketing_consent");
      return result;
    } catch (err) {
      // Soft-fail: don't block sign-in or surface to user. Log to console
      // only — attribution is best-effort, not a correctness gate.
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[attribution] post failed:", err && err.message ? err.message : err);
      }
      return null;
    }
  }

  // Run capture on script load. Safe to call multiple times — first-touch
  // wins for UTMs.
  captureAttribution();

  // Wire to auth state changes — fire postAttributionIfNeeded once after
  // the user is authenticated. The auth service notifies via onChange.
  function tryWireAuth(attempts) {
    attempts = attempts || 0;
    if (window.CBV2.auth && typeof window.CBV2.auth.onChange === "function") {
      window.CBV2.auth.onChange(function () {
        // We don't care which event — any auth state change that leaves
        // us authenticated is a moment to attempt the POST. The function
        // is idempotent both client-side (POST_DONE_KEY) and server-side
        // (first-touch lock).
        if (window.CBV2.auth.isAuthenticated && window.CBV2.auth.isAuthenticated()) {
          postAttributionIfNeeded();
        }
      });
      // Also fire once now in case we're already authenticated on load.
      if (window.CBV2.auth.isAuthenticated && window.CBV2.auth.isAuthenticated()) {
        postAttributionIfNeeded();
      }
      return;
    }
    if (attempts < 50) {
      setTimeout(function () { tryWireAuth(attempts + 1); }, 100);
    }
  }
  tryWireAuth();

  // Expose for testing / debugging.
  window.CBV2.attribution = {
    capture: captureAttribution,
    post: postAttributionIfNeeded,
    state: function () {
      return {
        bundle: JSON.parse(safeReadLocal(STORAGE_KEY) || "{}"),
        posted: !!safeReadLocal(POST_DONE_KEY),
      };
    },
    // Reset is intentionally exposed for support/debug — never called in
    // normal flow.
    reset: function () {
      safeClearLocal(STORAGE_KEY);
      safeClearLocal(POST_DONE_KEY);
    }
  };
})();
