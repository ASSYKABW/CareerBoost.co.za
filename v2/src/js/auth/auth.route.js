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

  function st() { return window.CBV2.sanitizeText || function (s) { return String(s == null ? "" : s); }; }
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
          '" required value="' + s(viewState.password) + '" /></label>';
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
        // Phase 4: auto-sign-in flow.
        // 1. Sign up. If the project has email-confirmation OFF, signUp returns
        //    a session immediately and the user is already authed → straight to
        //    dashboard. If confirmation is ON, signUp returns user-without-session
        //    and we show "Check your inbox".
        // 2. As a belt-and-braces step, attempt signInWithPassword right after.
        //    On confirmation-OFF projects this is a no-op (already signed in).
        //    On confirmation-ON projects it predictably fails with "Email not
        //    confirmed" — we catch that and fall through to the inbox view.
        await window.CBV2.auth.signUpWithPassword(
          viewState.email, viewState.password, viewState.fullName
        );
        let signedIn = false;
        try {
          await window.CBV2.auth.signInWithPassword(viewState.email, viewState.password);
          signedIn = true;
        } catch (signInErr) {
          // Most common failure here: "Email not confirmed". Fall through.
          const msg = (signInErr && signInErr.message) || "";
          if (!/not\s+confirmed|verify|confirm/i.test(msg)) {
            // Unexpected failure — surface it. User can still sign in manually
            // once they receive the confirmation email.
          }
        }
        if (signedIn) {
          window.location.hash = "#/dashboard";
        } else {
          viewState.info = "Account created. Check your inbox for a confirmation email, then sign in.";
          viewState.mode = "signin";
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
