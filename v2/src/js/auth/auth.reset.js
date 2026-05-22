// P3 reset-password: dedicated #/auth/reset route.
//
// Flow:
//   1. User clicks "Forgot password" on #/auth → enters email →
//      sendPasswordReset() emails them a recovery link.
//   2. Email link contains a recovery token; Supabase appends it as
//      a URL fragment after the route: #/auth/reset#access_token=...&type=recovery.
//   3. The Supabase SDK auto-parses the token and establishes a
//      *recovery* session (a temporary auth state where the user can
//      change their password but not much else).
//   4. THIS route shows a "Type your new password" form with the
//      same live password rules checklist used at signup.
//   5. Submit calls supabase.auth.updateUser({password}) — that
//      persists the new password and upgrades the session to a
//      normal one. We redirect to dashboard.
//
// Security:
//   - Same password rules as signup (10+ chars, letter, number, not
//     on the common-password blocklist).
//   - Old password is NOT required (Supabase doesn't include it in
//     recovery flow; the recovery token IS the proof of identity).
//   - Recovery token expires in 1 hour by default — if expired, the
//     UI shows a "link expired, request a new one" recovery state.
//   - Password confirmation field to catch typos.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const state = {
    status: "checking",   // checking | ready | success | expired | error
    password: "",
    confirm: "",
    busy: false,
    error: "",
    info: ""
  };

  // Same password rules as signup. We don't import from auth.route.js
  // because that's an IIFE with no exports; duplicating four lines is
  // cheaper than re-architecting both modules.
  const PASSWORD_RULES = [
    { id: "len",    label: "At least 10 characters", test: function (p) { return String(p || "").length >= 10; } },
    { id: "letter", label: "Contains a letter",       test: function (p) { return /[A-Za-z]/.test(String(p || "")); } },
    { id: "number", label: "Contains a number",       test: function (p) { return /\d/.test(String(p || "")); } },
    { id: "common", label: "Not a common password",   test: function (p) {
      const blocklist = ["password", "password1", "qwerty", "12345678", "1234567890", "letmein", "iloveyou", "abc12345"];
      return blocklist.indexOf(String(p || "").toLowerCase()) === -1;
    } }
  ];
  function failingRules(pwd) {
    return PASSWORD_RULES.filter(function (r) { return !r.test(pwd); });
  }

  function st(value) { return (window.CBV2.sanitizeText || String)(value); }
  function renderBrand() {
    if (window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function") {
      return window.CBV2.brandKit.logo({ compact: false, tagline: true });
    }
    return "Career<span>Boost</span>";
  }

  // Establish the recovery session. The Supabase email link redirects
  // here with the tokens appended after a SECOND hash fragment:
  //   https://www.careerboost.co.za/#/auth/reset#access_token=...&refresh_token=...&type=recovery
  //
  // The SDK's detectSessionInUrl tries to parse window.location.hash
  // but the double-hash confuses its key extractor — it sees
  // "/auth/reset#access_token" as the key name and misses it entirely.
  // We work around by:
  //   1. Extracting tokens from the raw URL via regex (catches both
  //      the implicit-grant #access_token= and the PKCE ?code= shapes)
  //   2. Calling setSession() / exchangeCodeForSession() directly
  //   3. Cleaning the URL hash so a refresh doesn't re-process
  //
  // Returns true on success, false on timeout / expired link / missing
  // code verifier (cross-device click).
  async function awaitRecoverySession(timeoutMs) {
    const auth = window.CBV2 && window.CBV2.auth;
    if (!auth) return false;

    // Already signed in (recovery session was set on a previous render)?
    if (auth.isAuthenticated && auth.isAuthenticated()) return true;

    const client = auth.getClient && auth.getClient();
    const fullUrl = String(window.location.href || "");

    // Implicit-grant flow — tokens in the URL hash. Match anywhere in
    // the URL using `[#&?]` so we catch the case where access_token sits
    // after a second `#` (our hash-routed redirect_to).
    const accessTokenMatch = fullUrl.match(/[#&?]access_token=([^&#]+)/);
    const refreshTokenMatch = fullUrl.match(/[#&?]refresh_token=([^&#]+)/);
    if (accessTokenMatch && refreshTokenMatch && client && client.auth && typeof client.auth.setSession === "function") {
      try {
        const { data, error } = await client.auth.setSession({
          access_token: decodeURIComponent(accessTokenMatch[1]),
          refresh_token: decodeURIComponent(refreshTokenMatch[1]),
        });
        if (error) {
          console.warn("[auth.reset] setSession error:", error.message);
          if (/expired|invalid|jwt/i.test(error.message || "")) {
            state.error = "This reset link expired or was already used. Request a fresh one below.";
          }
          return false;
        }
        if (data && data.session) {
          // Clean the URL so a page refresh doesn't re-process the
          // tokens (and so the route doesn't keep the long hash).
          try {
            history.replaceState({}, "", window.location.pathname + window.location.search + "#/auth/reset");
          } catch (_e) { /* non-fatal */ }
          return true;
        }
      } catch (err) {
        console.warn("[auth.reset] setSession threw:", err);
      }
    }

    // PKCE flow — `?code=PKCE_xxxx` somewhere in the URL.
    if (client && client.auth && typeof client.auth.exchangeCodeForSession === "function") {
      const codeMatch = fullUrl.match(/[?&]code=([^&#]+)/);
      if (codeMatch && codeMatch[1]) {
        try {
          const { data, error } = await client.auth.exchangeCodeForSession(codeMatch[1]);
          if (error) {
            console.warn("[auth.reset] exchangeCodeForSession error:", error.message);
            if (/verifier|code/i.test(error.message || "")) {
              state.error = "This reset link can only be used on the same browser that requested it. Open the link in the browser where you clicked Forgot password — or request a new link below.";
            }
            return false;
          }
          if (data && data.session) {
            try {
              history.replaceState({}, "", window.location.pathname + window.location.search + "#/auth/reset");
            } catch (_e) {}
            return true;
          }
        } catch (err) {
          console.warn("[auth.reset] exchangeCodeForSession threw:", err);
        }
      }
    }

    // Final fallback — wait for the SDK to do it on its own (rare but
    // covers any edge case where the manual paths didn't trigger).
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      try {
        if (auth.isAuthenticated && auth.isAuthenticated()) return true;
      } catch (_e) { /* ignore */ }
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return false;
  }

  function renderPwChecklist(pwd) {
    return (
      '<ul class="auth-pw-checklist">' +
        PASSWORD_RULES.map(function (rule) {
          const ok = rule.test(pwd);
          const cls = ok ? "is-pass" : "is-fail";
          const icon = ok ? "fa-circle-check" : "fa-circle";
          return '<li class="' + cls + '"><i class="fa-solid ' + icon + '"></i> ' + st(rule.label) + '</li>';
        }).join("") +
      '</ul>'
    );
  }

  function renderView() {
    if (state.status === "checking") {
      return (
        '<section class="auth-container">' +
          '<div class="auth-card">' +
            '<div class="auth-brand">' + renderBrand() + '</div>' +
            '<h1 class="auth-title">Preparing your reset…</h1>' +
            '<p class="auth-subtitle">Verifying the link from your email. One moment.</p>' +
            '<div class="cb-boot-spinner" style="margin:24px auto;width:24px;height:24px;border-radius:50%;border:2px solid rgba(255,255,255,0.12);border-top-color:#5eead4;animation:cb-boot-spin 600ms linear infinite;"></div>' +
          '</div>' +
        '</section>'
      );
    }
    if (state.status === "expired") {
      // If the failure reason was a PKCE verifier mismatch (different
      // browser/device than the one used to request the reset), show
      // the more accurate explanation. Otherwise show the generic
      // "link expired" copy.
      const hasSpecificError = !!state.error;
      const title = hasSpecificError ? "Can't use this link here." : "This reset link expired.";
      const subtitle = hasSpecificError
        ? state.error
        : "Reset links work for 1 hour and only once. Request a fresh one from the sign-in page.";
      return (
        '<section class="auth-container">' +
          '<div class="auth-card">' +
            '<a class="auth-back" href="#/auth"><i class="fa-solid fa-arrow-left"></i> Back to sign in</a>' +
            '<div class="auth-brand">' + renderBrand() + '</div>' +
            '<h1 class="auth-title">' + st(title) + '</h1>' +
            '<p class="auth-subtitle">' + st(subtitle) + '</p>' +
            '<div class="auth-submit-row">' +
              '<a class="btn-primary" href="#/auth?mode=forgot"><i class="fa-solid fa-paper-plane"></i> Send me a new link</a>' +
            '</div>' +
          '</div>' +
        '</section>'
      );
    }
    if (state.status === "success") {
      return (
        '<section class="auth-container">' +
          '<div class="auth-card">' +
            '<div class="auth-brand">' + renderBrand() + '</div>' +
            '<div style="text-align:center;font-size:48px;color:#34d399;margin:8px 0 16px;"><i class="fa-solid fa-circle-check"></i></div>' +
            '<h1 class="auth-title">Password updated.</h1>' +
            '<p class="auth-subtitle">You\'re signed in with the new password. Redirecting to your dashboard…</p>' +
          '</div>' +
        '</section>'
      );
    }

    // Ready (or error) — render the form.
    const pwd = state.password;
    const mismatch = state.confirm && state.password !== state.confirm;
    return (
      '<section class="auth-container">' +
        '<div class="auth-card">' +
          '<a class="auth-back" href="#/auth"><i class="fa-solid fa-arrow-left"></i> Back to sign in</a>' +
          '<div class="auth-brand">' + renderBrand() + '</div>' +
          '<h1 class="auth-title">Choose a new password</h1>' +
          '<p class="auth-subtitle">Almost there. Pick a strong password — you\'ll be signed in straight after.</p>' +
          '<form class="auth-form" id="auth-reset-form" autocomplete="off">' +
            '<label>New password' +
              '<input id="auth-reset-pwd" type="password" autocomplete="new-password" required value="' + st(pwd) + '" />' +
            '</label>' +
            renderPwChecklist(pwd) +
            '<label>Confirm password' +
              '<input id="auth-reset-confirm" type="password" autocomplete="new-password" required value="' + st(state.confirm) + '" />' +
            '</label>' +
            (mismatch
              ? '<div class="ai-notice rose"><i class="fa-solid fa-circle-xmark"></i><div>Passwords don\'t match.</div></div>'
              : '') +
            (state.error
              ? '<div class="ai-notice rose"><i class="fa-solid fa-circle-xmark"></i><div>' + st(state.error) + '</div></div>'
              : '') +
            '<div class="auth-submit-row">' +
              '<button class="btn-primary" type="submit"' + (state.busy ? ' disabled' : '') + '>' +
                (state.busy
                  ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Saving…'
                  : '<i class="fa-solid fa-key"></i> Update password') +
              '</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</section>'
    );
  }

  function rerender() {
    const outlet = document.getElementById("route-view");
    if (outlet) outlet.innerHTML = renderView();
    bindHandlers();
  }

  async function submit(ev) {
    if (ev) ev.preventDefault();
    if (state.busy) return;

    const pwdEl = document.getElementById("auth-reset-pwd");
    const confEl = document.getElementById("auth-reset-confirm");
    state.password = pwdEl ? pwdEl.value : state.password;
    state.confirm = confEl ? confEl.value : state.confirm;

    if (state.password !== state.confirm) {
      state.error = "Passwords don't match.";
      rerender();
      return;
    }
    const failing = failingRules(state.password);
    if (failing.length) {
      state.error = "Password doesn't meet requirements: " + failing[0].label.toLowerCase() + ".";
      rerender();
      return;
    }

    state.busy = true;
    state.error = "";
    rerender();

    try {
      const auth = window.CBV2.auth;
      const client = auth && auth.getClient && auth.getClient();
      if (!client) throw new Error("Backend not configured.");
      const { error } = await client.auth.updateUser({ password: state.password });
      if (error) throw error;
      state.status = "success";
      rerender();
      setTimeout(function () {
        window.location.hash = "#/dashboard";
      }, 1200);
    } catch (err) {
      state.error = (err && err.message) || "Couldn't update password.";
      // If Supabase rejects because the recovery session has expired
      // mid-flow, switch to the expired view so the user gets a clear
      // recovery CTA instead of just a banner.
      if (/expired|invalid|jwt/i.test(state.error)) {
        state.status = "expired";
      }
      state.busy = false;
      rerender();
    }
  }

  function bindHandlers() {
    const form = document.getElementById("auth-reset-form");
    if (form) form.addEventListener("submit", submit);

    // Live update the password checklist as user types.
    const pwd = document.getElementById("auth-reset-pwd");
    if (pwd) {
      pwd.addEventListener("input", function () {
        state.password = pwd.value;
        const existing = document.querySelector(".auth-pw-checklist");
        if (existing) existing.outerHTML = renderPwChecklist(state.password);
      });
    }
    const conf = document.getElementById("auth-reset-confirm");
    if (conf) {
      // Mismatch banner UX: only show while typing when the user has
      // entered AT LEAST as many characters as the password — typing
      // "p" doesn't mean "doesn't match", just "not finished".
      // Also show on blur (covers the case where they Tab away before
      // typing enough chars). Reset on focus so the user isn't stared
      // down by an error the moment they refocus to fix it.
      function shouldShowMismatch() {
        if (!state.confirm) return false;
        if (state.confirm.length < state.password.length) return false;
        return state.password !== state.confirm;
      }
      function syncMismatchBanner() {
        const banner = document.querySelector(".auth-form .ai-notice.rose");
        const want = shouldShowMismatch() && !state.error;
        if (want && !banner) rerender();
        if (!want && banner && !state.error) rerender();
      }
      conf.addEventListener("input", function () {
        state.confirm = conf.value;
        syncMismatchBanner();
      });
      conf.addEventListener("blur", function () {
        // On blur, show mismatch even if shorter than password — they're
        // done with the field and the values don't agree.
        state.confirm = conf.value;
        if (state.confirm && state.password !== state.confirm && !state.error) {
          const banner = document.querySelector(".auth-form .ai-notice.rose");
          if (!banner) rerender();
        }
      });
      conf.addEventListener("focus", function () {
        // Clear stale mismatch banner so the user can fix without being
        // yelled at while they're trying.
        const banner = document.querySelector(".auth-form .ai-notice.rose");
        if (banner && !state.error) {
          banner.remove();
        }
      });
    }
  }

  async function afterRender() {
    const cfg = window.CBV2 && window.CBV2.config;
    if (cfg && cfg.isBackendEnabled && !cfg.isBackendEnabled()) {
      state.status = "expired";
      rerender();
      return;
    }
    state.status = "checking";
    rerender();
    const ok = await awaitRecoverySession(3500);
    state.status = ok ? "ready" : "expired";
    rerender();
  }

  window.CBV2.routes["auth/reset"] = renderView;
  window.CBV2.afterRender["auth/reset"] = afterRender;
})();
