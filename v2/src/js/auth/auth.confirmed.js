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
    status: "checking",  // checking | success | recovery | expired | error | local
    email: "",
    message: "",
    flow: "",            // signup | recovery | invite | magiclink | email_change
    // recovery-only fields
    recoveryBusy: false,
    recoveryError: "",
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

    if (state.status === "recovery") {
      // Password-reset flow: Supabase has signed the user in with a
      // recovery session, but we MUST prompt for a new password before
      // dumping them into the app. Otherwise anyone with the email
      // link gets full account access.
      const errHtml = state.recoveryError
        ? '<p class="lp-auth-confirm-error" role="alert"><i class="fa-solid fa-circle-exclamation"></i> ' + st(state.recoveryError) + '</p>'
        : "";
      const busy = state.recoveryBusy;
      return (
        '<main class="lp-page lp-auth-confirm-page">' +
          '<section class="lp-auth-confirm-card">' +
            '<div class="lp-auth-confirm-icon" aria-hidden="true">' +
              '<i class="fa-solid fa-key"></i>' +
            '</div>' +
            '<span class="lp-eyebrow">Reset password</span>' +
            '<h1>Set a new password.</h1>' +
            '<p>Choose a new password for <strong>' + st(state.email || "your account") + '</strong>. You\'ll stay signed in afterwards.</p>' +
            '<form id="cb-recovery-form" class="lp-auth-confirm-form" autocomplete="off" novalidate>' +
              '<label class="lp-auth-confirm-field">' +
                '<span>New password</span>' +
                '<input type="password" id="cb-recovery-pw1" autocomplete="new-password" minlength="8" required ' +
                  (busy ? "disabled" : "") + '>' +
              '</label>' +
              '<label class="lp-auth-confirm-field">' +
                '<span>Confirm new password</span>' +
                '<input type="password" id="cb-recovery-pw2" autocomplete="new-password" minlength="8" required ' +
                  (busy ? "disabled" : "") + '>' +
              '</label>' +
              '<p class="lp-auth-confirm-hint">At least 8 characters. Mix of letters + numbers recommended.</p>' +
              errHtml +
              '<div class="lp-auth-confirm-actions">' +
                '<button type="submit" class="lp-btn lp-btn--primary lp-btn--lg" ' +
                  (busy ? "disabled" : "") + '>' +
                  '<i class="fa-solid fa-' + (busy ? "spinner fa-spin-pulse" : "check") + '"></i> ' +
                  (busy ? "Updating password…" : "Update password") +
                '</button>' +
              '</div>' +
            '</form>' +
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
    state.flow = flow;
    const user = await awaitSession(3500);

    if (user) {
      state.email = user.email || "";
      if (flow === "recovery") {
        // CRITICAL: do NOT show the "You're in" success screen for
        // password-reset flows. The recovery link signs the user in
        // (Supabase behavior) but we MUST prompt for a new password
        // before they can continue — otherwise anyone with the email
        // link gets full account access.
        state.status = "recovery";
        rerender();
        bindRecoveryForm();
        return;
      }
      state.status = "success";
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

  // Wire the new-password form. Submit calls auth.updateUser with the
  // new password, then redirects to /dashboard with a success toast.
  function bindRecoveryForm() {
    const form = document.getElementById("cb-recovery-form");
    if (!form || form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    // Auto-focus first password field.
    const pw1 = document.getElementById("cb-recovery-pw1");
    if (pw1) { try { pw1.focus(); } catch (_e) {} }

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (state.recoveryBusy) return;
      const p1 = document.getElementById("cb-recovery-pw1");
      const p2 = document.getElementById("cb-recovery-pw2");
      const pw1Val = p1 ? p1.value : "";
      const pw2Val = p2 ? p2.value : "";

      if (!pw1Val || pw1Val.length < 8) {
        state.recoveryError = "Password must be at least 8 characters.";
        rerender(); bindRecoveryForm();
        return;
      }
      if (pw1Val !== pw2Val) {
        state.recoveryError = "Passwords don't match. Type the same one in both fields.";
        rerender(); bindRecoveryForm();
        return;
      }

      state.recoveryBusy = true;
      state.recoveryError = "";
      rerender();
      // Don't re-bind here — the input is disabled, no interaction
      // possible until the async call returns.

      try {
        const auth = window.CBV2 && window.CBV2.auth;
        const client = auth && auth.getClient && auth.getClient();
        if (!client || !client.auth || typeof client.auth.updateUser !== "function") {
          throw new Error("Auth client unavailable. Refresh and try again.");
        }
        const { error } = await client.auth.updateUser({ password: pw1Val });
        if (error) throw new Error(error.message || "Couldn't update password.");
        // Success — redirect with a toast.
        state.recoveryBusy = false;
        rerender();
        if (window.CBV2.toast) {
          window.CBV2.toast.success("Password updated. You're signed in.");
        }
        // Brief delay so the user sees the success toast before route change.
        setTimeout(function () {
          window.location.hash = "#/dashboard";
        }, 400);
      } catch (err) {
        state.recoveryBusy = false;
        state.recoveryError = (err && err.message) || "Couldn't update password. Try again or request a fresh reset link.";
        rerender();
        bindRecoveryForm();
      }
    });
  }

  // Register against the route slug. The router strips the leading
  // "#/" and routes by the first path segment, so we register the
  // two-segment "auth/confirmed" key directly.
  window.CBV2.routes["auth/confirmed"] = renderView;
  window.CBV2.afterRender["auth/confirmed"] = afterRender;
})();
