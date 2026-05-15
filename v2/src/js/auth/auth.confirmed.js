// Post-confirmation landing page. Reached after the user clicks the
// confirmation link in their signup email (or after an OAuth round-
// trip). Replaces the prior emailRedirectTo target of #/dashboard,
// which dropped users into the app cold without any feedback that
// their account was actually created.
//
// What this route does:
//   1. Waits briefly for the Supabase SDK to parse the URL hash
//      (#access_token=…&type=signup&…) and establish a session.
//   2. If signed in: shows a polished "Welcome!" card with the user's
//      email + two CTAs (continue to dashboard, or to onboarding).
//   3. If not signed in (link expired, already used, opened from a
//      different device, etc.): shows a clear recovery prompt that
//      lets the user either sign in or request a fresh confirmation.
//
// The route is registered at #/auth/confirmed. The dispatcher accepts
// the trailing path segment and routes to this view.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const state = {
    status: "checking",  // checking | success | expired | error | local
    email: "",
    message: "",
  };

  function st(value) {
    return (window.CBV2.sanitizeText || String)(value);
  }

  // Detect the kind of auth flow we just came back from based on the
  // URL hash. Supabase appends &type=signup | recovery | magiclink |
  // invite after the access_token. Useful for tailoring the copy.
  function detectFlow() {
    try {
      // The router has already consumed the hash route segment, so the
      // Supabase tokens normally live in window.location.hash AFTER the
      // route slug, e.g. "#/auth/confirmed#access_token=..." or as
      // query params on the URL when type=email_change.
      const hash = String(window.location.hash || "");
      if (/type=recovery/.test(hash)) return "recovery";
      if (/type=signup/.test(hash))   return "signup";
      if (/type=invite/.test(hash))   return "invite";
      if (/type=magiclink/.test(hash))return "magiclink";
      if (/type=email_change/.test(hash)) return "email_change";
      return "signup";
    } catch (e) { return "signup"; }
  }

  // Wait up to ~3 seconds for the SDK to finish its hash exchange.
  // Resolves when a session exists or when the timeout elapses.
  async function awaitSession(timeoutMs) {
    const auth = window.CBV2 && window.CBV2.auth;
    if (!auth) return null;
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
      try {
        if (auth.isAuthenticated && auth.isAuthenticated()) {
          return auth.getUser ? auth.getUser() : null;
        }
      } catch (e) { /* ignore */ }
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return null;
  }

  function renderView() {
    if (state.status === "checking") {
      return (
        '<main class="lp-page lp-auth-confirm-page">' +
          '<section class="lp-auth-confirm-card">' +
            '<div class="lp-auth-confirm-spinner" aria-hidden="true"></div>' +
            '<h1>Confirming your email…</h1>' +
            '<p>Hang tight — finishing your signup.</p>' +
          '</section>' +
        '</main>'
      );
    }

    if (state.status === "success") {
      const greetingName = state.email ? state.email.split("@")[0] : "there";
      return (
        '<main class="lp-page lp-auth-confirm-page">' +
          '<section class="lp-auth-confirm-card lp-auth-confirm-card--success">' +
            '<div class="lp-auth-confirm-icon" aria-hidden="true">' +
              '<i class="fa-solid fa-circle-check"></i>' +
            '</div>' +
            '<span class="lp-eyebrow">Welcome to CareerBoost</span>' +
            '<h1>You\'re in, ' + st(greetingName) + '.</h1>' +
            '<p>Your email is verified and your workspace is ready. Pick where you want to start:</p>' +
            '<div class="lp-auth-confirm-actions">' +
              '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/onboarding">' +
                '<i class="fa-solid fa-compass"></i> Set up my profile' +
              '</a>' +
              '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#/dashboard">' +
                'Skip — open dashboard' +
              '</a>' +
            '</div>' +
            '<p class="lp-auth-confirm-meta">' +
              'Signed in as <strong>' + st(state.email || "your account") + '</strong>' +
            '</p>' +
          '</section>' +
        '</main>'
      );
    }

    if (state.status === "expired") {
      return (
        '<main class="lp-page lp-auth-confirm-page">' +
          '<section class="lp-auth-confirm-card lp-auth-confirm-card--warn">' +
            '<div class="lp-auth-confirm-icon lp-auth-confirm-icon--warn" aria-hidden="true">' +
              '<i class="fa-solid fa-clock-rotate-left"></i>' +
            '</div>' +
            '<span class="lp-eyebrow">Confirmation link expired</span>' +
            '<h1>This link can\'t be used.</h1>' +
            '<p>Confirmation links expire after a short window or stop working once they\'ve been used. Sign in and we\'ll resend a fresh one if your email is still pending.</p>' +
            '<div class="lp-auth-confirm-actions">' +
              '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/auth">' +
                '<i class="fa-solid fa-right-to-bracket"></i> Sign in' +
              '</a>' +
              '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#/auth?mode=signup">' +
                'Create a new account' +
              '</a>' +
            '</div>' +
          '</section>' +
        '</main>'
      );
    }

    // Fallback — generic error.
    return (
      '<main class="lp-page lp-auth-confirm-page">' +
        '<section class="lp-auth-confirm-card lp-auth-confirm-card--warn">' +
          '<div class="lp-auth-confirm-icon lp-auth-confirm-icon--warn" aria-hidden="true">' +
            '<i class="fa-solid fa-triangle-exclamation"></i>' +
          '</div>' +
          '<h1>Something went wrong.</h1>' +
          '<p>' + st(state.message || "We couldn\'t verify the confirmation link.") + '</p>' +
          '<div class="lp-auth-confirm-actions">' +
            '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/auth">' +
              '<i class="fa-solid fa-right-to-bracket"></i> Sign in' +
            '</a>' +
            '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#/welcome">' +
              'Back to home' +
            '</a>' +
          '</div>' +
        '</section>' +
      '</main>'
    );
  }

  // Re-render whatever is currently in the outlet without doing a
  // full router cycle (avoids fighting the router on hash changes).
  function rerender() {
    const outlet = document.getElementById("route-view");
    if (outlet) outlet.innerHTML = renderView();
  }

  async function afterRender() {
    // Backend disabled (local preview)? Tell the user we couldn't
    // verify anything because there's no auth service.
    const cfg = window.CBV2 && window.CBV2.config;
    if (cfg && cfg.isBackendEnabled && !cfg.isBackendEnabled()) {
      state.status = "expired";
      rerender();
      return;
    }

    state.status = "checking";
    rerender();

    const flow = detectFlow();
    const user = await awaitSession(3500);

    if (user) {
      state.status = "success";
      state.email = user.email || "";
      rerender();
      return;
    }

    // No session after waiting — most likely an expired or already-
    // used confirmation link. Could also be that the user opened the
    // link in a fresh browser that doesn't carry their pre-confirm
    // state — that's fine, sign in works.
    state.status = "expired";
    state.message = flow === "recovery"
      ? "Password reset link expired. Request a fresh one from the sign-in page."
      : "Confirmation link expired or already used.";
    rerender();
  }

  // Register against the route slug. The router strips the leading
  // "#/" and routes by the first path segment, so we register the
  // two-segment "auth/confirmed" key directly.
  window.CBV2.routes["auth/confirmed"] = renderView;
  window.CBV2.afterRender["auth/confirmed"] = afterRender;
})();
