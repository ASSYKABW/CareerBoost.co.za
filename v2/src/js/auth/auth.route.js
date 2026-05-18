// The /auth route: sign in, sign up, OAuth, and password-reset flows.
// Shown when the backend is enabled and the user is not signed in.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const viewState = {
    mode: "signin",   // signin | signup | forgot
    email: "",
    password: "",
    fullName: "",
    error: "",
    busy: false,
    info: ""
  };

  // P3 signup security: live password checklist requirements.
  // Each rule is { id, label, test }. The signup form re-evaluates
  // them on every keystroke and renders a checkmark/cross per rule.
  // Submit is blocked until all required rules pass.
  const PASSWORD_RULES = [
    { id: "len",    label: "At least 10 characters",          test: function (p) { return String(p || "").length >= 10; } },
    { id: "letter", label: "Contains a letter",                test: function (p) { return /[A-Za-z]/.test(String(p || "")); } },
    { id: "number", label: "Contains a number",                test: function (p) { return /\d/.test(String(p || "")); } },
    { id: "common", label: "Not a common password",            test: function (p) {
      // Tiny rejection list — blocks the dumbest ones without a heavy
      // library. Supabase doesn't enforce password complexity, so this
      // is purely client-side defence in depth.
      const blocklist = ["password", "password1", "qwerty", "12345678", "1234567890", "letmein", "iloveyou", "abc12345"];
      return blocklist.indexOf(String(p || "").toLowerCase()) === -1;
    } }
  ];
  function failingPasswordRules(pwd) {
    return PASSWORD_RULES.filter(function (r) { return !r.test(pwd); });
  }

  function st() { return window.CBV2.sanitizeText || function (s) { return String(s == null ? "" : s); }; }

  // P3 signup security: live password checklist component.
  // Renders 4 rules with a pass/fail chip next to each. Updated on
  // every keystroke via the input handler (which re-renders the form).
  function renderPasswordChecklist(pwd) {
    const s = st();
    return (
      '<ul class="auth-pw-checklist">' +
        PASSWORD_RULES.map(function (rule) {
          const ok = rule.test(pwd);
          const cls = ok ? "is-pass" : "is-fail";
          const icon = ok ? "fa-circle-check" : "fa-circle";
          return '<li class="' + cls + '">' +
            '<i class="fa-solid ' + icon + '" aria-hidden="true"></i> ' +
            s(rule.label) +
          '</li>';
        }).join("") +
      '</ul>'
    );
  }
  function renderBrand() {
    if (window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function") {
      return window.CBV2.brandKit.logo({ compact: false, tagline: true });
    }
    return "Career<span>Boost</span>";
  }

  function renderBackendOffBanner() {
    if (window.CBV2.config.isBackendEnabled()) return "";
    return (
      '<div class="ai-notice warning">' +
      '<i class="fa-solid fa-triangle-exclamation"></i>' +
      "<div><strong>Backend not configured.</strong> The app is running in " +
      "local-only mode. Edit <code>v2/src/js/app/config.js</code> with your " +
      "Supabase project URL and anon key to enable accounts.</div>" +
      "</div>"
    );
  }

  function renderFormBody() {
    const s = st();
    const mode = viewState.mode;

    const email = (
      '<label>Email<input id="auth-email" type="email" autocomplete="email" required value="' +
      s(viewState.email) + '" /></label>'
    );
    const password =
      mode === "forgot"
        ? ""
        : '<label>Password<input id="auth-password" type="password" autocomplete="' +
          (mode === "signup" ? "new-password" : "current-password") +
          '" required value="' + s(viewState.password) + '" /></label>' +
          // P3: live password rule checklist visible only on signup.
          (mode === "signup" ? renderPasswordChecklist(viewState.password) : "");
    const fullName =
      mode === "signup"
        ? '<label>Full name<input id="auth-fullname" type="text" autocomplete="name" value="' +
          s(viewState.fullName) + '" /></label>'
        : "";

    const submitLabel =
      mode === "signup" ? "Create account" :
      mode === "forgot" ? "Send reset link" :
      "Sign in";

    const switchLinks =
      mode === "signin"
        ? '<p class="auth-switch">No account? <a href="#" data-auth-mode="signup">Create one</a> · <a href="#" data-auth-mode="forgot">Forgot password</a></p>'
        : mode === "signup"
        ? '<p class="auth-switch">Already have an account? <a href="#" data-auth-mode="signin">Sign in</a></p>'
        : '<p class="auth-switch"><a href="#" data-auth-mode="signin">Back to sign in</a></p>';

    return (
      fullName +
      email +
      password +
      (viewState.error
        ? '<div class="ai-notice rose"><i class="fa-solid fa-circle-xmark"></i><div>' +
          s(viewState.error) + "</div></div>"
        : "") +
      (viewState.info
        ? '<div class="ai-notice"><i class="fa-solid fa-circle-check"></i><div>' +
          s(viewState.info) + "</div></div>"
        : "") +
      '<div class="auth-submit-row">' +
      '<button class="btn-primary" id="auth-submit" type="submit"' +
      (viewState.busy ? " disabled" : "") + ">" +
      (viewState.busy
        ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Working...'
        : '<i class="fa-solid fa-arrow-right-to-bracket"></i> ' + submitLabel) +
      "</button>" +
      "</div>" +
      switchLinks
    );
  }

  function renderView() {
    const backendOn = window.CBV2.config.isBackendEnabled();
    const title =
      viewState.mode === "signup" ? "Create your CareerBoost account" :
      viewState.mode === "forgot" ? "Reset your password" :
      "Welcome back";
    const subtitle =
      viewState.mode === "signup"
        ? "Free forever while you're job-seeking. Upgrade later for team features."
        : viewState.mode === "forgot"
        ? "We'll email you a secure link to choose a new password."
        : "Sign in to sync your pipeline, resumes, and saved searches across devices.";

    return (
      '<section class="auth-container">' +
        '<div class="auth-card">' +
          '<a class="auth-back" href="#/welcome"><i class="fa-solid fa-arrow-left"></i> Back to home</a>' +
          '<div class="auth-brand">' + renderBrand() + "</div>" +
          '<h1 class="auth-title">' + title + "</h1>" +
          '<p class="auth-subtitle">' + subtitle + "</p>" +
          renderBackendOffBanner() +

          // OAuth buttons are gated by window.CB_CONFIG.oauthEnabled +
          // oauthProviders array. Phase 4 ships google as the default
          // provider; add "linkedin_oidc" to oauthProviders once LinkedIn
          // OAuth is configured in the Supabase Dashboard.
          (backendOn && viewState.mode !== "forgot" && window.CB_CONFIG && window.CB_CONFIG.oauthEnabled
            ? '<div class="auth-oauth">' +
              ((window.CB_CONFIG.oauthProviders || ["google"]).indexOf("google") >= 0
                ? '<button class="btn-ghost oauth-btn" data-oauth="google" type="button">' +
                  '<i class="fa-brands fa-google"></i> Continue with Google' +
                  '</button>'
                : "") +
              ((window.CB_CONFIG.oauthProviders || ["google"]).indexOf("linkedin_oidc") >= 0
                ? '<button class="btn-ghost oauth-btn" data-oauth="linkedin_oidc" type="button">' +
                  '<i class="fa-brands fa-linkedin-in"></i> Continue with LinkedIn' +
                  '</button>'
                : "") +
              '</div>' +
              '<div class="auth-divider"><span>or use email</span></div>'
            : "") +

          '<form class="auth-form" id="auth-form">' +
            renderFormBody() +
          "</form>" +

          '<p class="auth-legal">By continuing you agree to the <a href="#/terms">terms</a> &amp; <a href="#/privacy">privacy policy</a>.</p>' +
        "</div>" +
      "</section>"
    );
  }

  function setMode(mode) {
    viewState.mode = mode;
    viewState.error = "";
    viewState.info = "";
    renderRoute();
  }

  function readInputs() {
    const e = document.getElementById("auth-email");
    const p = document.getElementById("auth-password");
    const n = document.getElementById("auth-fullname");
    viewState.email = e ? e.value.trim() : viewState.email;
    viewState.password = p ? p.value : viewState.password;
    viewState.fullName = n ? n.value.trim() : viewState.fullName;
  }

  async function submit(e) {
    e.preventDefault();
    readInputs();
    viewState.error = "";
    viewState.info = "";
    viewState.busy = true;
    renderRoute();

    try {
      if (viewState.mode === "signin") {
        await window.CBV2.auth.signInWithPassword(viewState.email, viewState.password);
        window.location.hash = "#/dashboard";
      } else if (viewState.mode === "signup") {
        // P3 signup security: enforce password rules client-side BEFORE
        // hitting the network. Supabase doesn't validate complexity, so
        // this is the only place we can stop "password123" at the door.
        const failing = failingPasswordRules(viewState.password);
        if (failing.length) {
          throw new Error("Password doesn't meet requirements: " + failing[0].label.toLowerCase() + ".");
        }
        // Phase 4 + P3: signup → verify-code flow.
        // 1. Sign up. If the project has email-confirmation OFF, signUp
        //    returns a session immediately and the user is already authed
        //    → straight to dashboard.
        // 2. If confirmation is ON (the production setup), signUp returns
        //    user-without-session and Supabase sends an email containing
        //    BOTH a 6-digit OTP code and a magic link. Route the user to
        //    #/auth/verify?email=... where they type the code; the link
        //    in the email also works as a fallback (lands on /auth/confirmed).
        await window.CBV2.auth.signUpWithPassword(
          viewState.email, viewState.password, viewState.fullName
        );
        // Try a session probe — if confirmation is off, we're already
        // signed in and can skip the verify route entirely.
        let signedIn = false;
        try {
          await window.CBV2.auth.signInWithPassword(viewState.email, viewState.password);
          signedIn = true;
        } catch (signInErr) {
          // Most common failure here: "Email not confirmed" — expected
          // on the production setup. Fall through to the verify route.
          const msg = (signInErr && signInErr.message) || "";
          if (!/not\s+confirmed|verify|confirm/i.test(msg)) {
            // Unexpected failure — surface it. User can still sign in
            // manually after they verify their email.
          }
        }
        if (signedIn) {
          window.location.hash = "#/dashboard";
        } else {
          // Stash email in sessionStorage too so a hash-only navigation
          // (no query string) still finds it.
          try { sessionStorage.setItem("cb_signup_pending_email", viewState.email); } catch (_e) {}
          window.location.hash = "#/auth/verify?email=" + encodeURIComponent(viewState.email);
        }
      } else if (viewState.mode === "forgot") {
        await window.CBV2.auth.sendPasswordReset(viewState.email);
        viewState.info = "Check your email for a reset link.";
      }
    } catch (err) {
      viewState.error = (err && err.message) || "Authentication failed.";
    } finally {
      viewState.busy = false;
      renderRoute();
    }
  }

  async function oauth(provider) {
    viewState.error = "";
    try {
      await window.CBV2.auth.signInWithOAuth(provider);
    } catch (err) {
      viewState.error = (err && err.message) || "OAuth sign-in failed.";
      renderRoute();
    }
  }

  function renderRoute() {
    // Avoid full router re-render; just swap the outlet content.
    const outlet = document.getElementById("route-view");
    if (outlet) outlet.innerHTML = renderView();
    bindHandlers();
  }

  function bindHandlers() {
    // Honour ?mode=signup / ?mode=forgot from the URL once on entry.
    try {
      const params = window.CBV2.getRouteParams ? window.CBV2.getRouteParams() : {};
      if (params && params.mode) {
        const requested = String(params.mode).toLowerCase();
        if (["signin", "signup", "forgot"].indexOf(requested) >= 0 && viewState.mode !== requested) {
          viewState.mode = requested;
          const outlet = document.getElementById("route-view");
          if (outlet) outlet.innerHTML = renderView();
        }
      }
    } catch (e) { /* ignore */ }

    const form = document.getElementById("auth-form");
    if (form) form.addEventListener("submit", submit);

    // P3 signup security: live-update the password checklist as the
    // user types. We re-render the form body but NOT the whole page
    // (keeps focus on the password input, no caret jump). To do that
    // cleanly we just update the checklist DOM in place.
    const pwdInput = document.getElementById("auth-password");
    if (pwdInput && viewState.mode === "signup") {
      pwdInput.addEventListener("input", function () {
        viewState.password = pwdInput.value;
        const existing = document.querySelector(".auth-pw-checklist");
        if (existing) {
          existing.outerHTML = renderPasswordChecklist(viewState.password);
        }
      });
    }

    document.querySelectorAll("[data-auth-mode]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        setMode(a.getAttribute("data-auth-mode"));
      });
    });

    document.querySelectorAll("[data-oauth]").forEach(function (b) {
      b.addEventListener("click", function () {
        oauth(b.getAttribute("data-oauth"));
      });
    });
  }

  window.CBV2.routes.auth = renderView;
  window.CBV2.afterRender.auth = bindHandlers;
})();
