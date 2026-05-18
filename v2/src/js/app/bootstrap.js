(function () {
  // Routes that are visible to signed-out visitors (public).
  // "auth/confirmed" is public because users land there from an email
  // confirmation link — at click-time they're not yet signed in (the
  // SDK parses the hash a moment later). Without it here, the click
  // would silently redirect to #/welcome and never render the success
  // card.
  // P3 signup: "auth/verify" is the new OTP code-entry route. Public
  // because the user lands there BEFORE their session is established
  // (the verifyOtp call IS what creates the session). Otherwise the
  // unauthed-redirect would bounce them to /welcome before they can
  // type the code.
  // auth/reset is the new "set new password" landing page reached
  // from the password-reset email link. Public because the user
  // isn't fully authenticated yet (recovery session is a partial
  // auth state that only allows updateUser({password})).
  const PUBLIC_ROUTES = ["welcome", "auth", "auth/confirmed", "auth/verify", "auth/reset", "privacy", "terms"];
  // Routes rendered fullscreen (no sidebar/topbar) for authed users.
  // "auth/confirmed" stays fullscreen even after the SDK establishes a
  // session mid-render, so the user sees the polished "You're in!" card
  // until they actively click a CTA — instead of snapping into the app
  // shell behind their back.
  const FULLSCREEN_AUTHED_ROUTES = ["onboarding", "admin", "auth/confirmed"];

  function mountAppShell() {
    const app = document.getElementById("app");
    if (!app) return;
    app.innerHTML = window.CBV2.createAppShell(window.CBV2.getState().route);
    if (typeof window.CBV2.bindGlobalSearch === "function") {
      window.CBV2.bindGlobalSearch();
    }
    if (typeof window.CBV2.bindUserMenu === "function") {
      window.CBV2.bindUserMenu();
    }
    if (typeof window.CBV2.bindShortcutsButton === "function") {
      window.CBV2.bindShortcutsButton();
    }
    if (typeof window.CBV2.bindNavShell === "function") {
      window.CBV2.bindNavShell();
    }
    if (window.CBV2.statusPill && typeof window.CBV2.statusPill.mount === "function") {
      window.CBV2.statusPill.mount();
    }
  }

  function renderLoadingScreen(message) {
    const app = document.getElementById("app");
    if (!app) return;
    const brandHtml = window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function"
      ? window.CBV2.brandKit.logo({ compact: false, tagline: true })
      : "Career<span>Boost</span>";
    app.innerHTML =
      '<section class="boot-splash">' +
      '<div class="boot-splash-card">' +
      '<div class="auth-brand">' + brandHtml + "</div>" +
      '<p><i class="fa-solid fa-circle-notch fa-spin"></i> ' +
      (message || "Loading your workspace...") + "</p>" +
      "</div></section>";
  }

  function renderFullscreenPublic() {
    const app = document.getElementById("app");
    if (!app) return;
    app.innerHTML = '<main id="route-view"></main>';
    const name = currentRouteName();
    const target = PUBLIC_ROUTES.indexOf(name) >= 0 ? name : "welcome";
    const render = window.CBV2.routes && window.CBV2.routes[target];
    if (typeof render === "function") {
      document.getElementById("route-view").innerHTML = render();
      const hook = window.CBV2.afterRender && window.CBV2.afterRender[target];
      if (typeof hook === "function") hook({});
      if (window.CBV2.usage && typeof window.CBV2.usage.trackRoute === "function") {
        window.CBV2.usage.trackRoute(target, {});
      }
    }
    window.CBV2.setRoute(target);
  }

  function renderFullscreenAuthed(target) {
    const app = document.getElementById("app");
    if (!app) return;
    app.innerHTML = '<main id="route-view"></main>';
    const render = window.CBV2.routes && window.CBV2.routes[target];
    if (typeof render === "function") {
      document.getElementById("route-view").innerHTML = render();
      const hook = window.CBV2.afterRender && window.CBV2.afterRender[target];
      if (typeof hook === "function") hook({});
      if (window.CBV2.usage && typeof window.CBV2.usage.trackRoute === "function") {
        window.CBV2.usage.trackRoute(target, {});
      }
    }
    window.CBV2.setRoute(target);
  }

  function normalizeHashRoute(defaultRoute) {
    if (!window.location.hash) {
      window.location.hash = "#/" + (defaultRoute || "dashboard");
    }
  }

  function currentRouteName() {
    const raw = window.location.hash.replace(/^#\//, "").trim();
    return (raw.split("?")[0] || "dashboard");
  }

  async function needsOnboarding() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) return false;
    const client = auth.getClient();
    const user = auth.getUser();
    if (!client || !user) return false;
    try {
      const { data } = await client.from("profiles")
        .select("onboarding_completed").eq("user_id", user.id).maybeSingle();
      if (!data) return true; // No profile row yet — treat as brand new.
      return data.onboarding_completed === false;
    } catch (e) {
      return false; // Never block the user on a flaky check.
    }
  }

  let mode = "local"; // "local" | "authed" | "unauthed"

  async function ensureAuthAndStore() {
    const backendOn = window.CBV2.config.isBackendEnabled();
    if (!backendOn) { mode = "local"; return; }

    renderLoadingScreen("Connecting to your account...");

    try {
      await window.CBV2.auth.init();
    } catch (err) {
      console.warn("[bootstrap] auth init failed:", err);
      mode = "local";
      return;
    }

    if (!window.CBV2.auth.isAuthenticated()) {
      mode = "unauthed";
      // Default unauth'd users to the welcome landing page unless they
      // explicitly navigated to /auth (sign in) or another public route.
      const current = currentRouteName();
      if (PUBLIC_ROUTES.indexOf(current) < 0) {
        window.location.hash = "#/welcome";
      }
      return;
    }

    renderLoadingScreen("Syncing your data...");
    try {
      const client = window.CBV2.auth.getClient();
      const user = window.CBV2.auth.getUser();
      await window.CBV2.remoteStore.activate(client, user);
      if (window.CBV2.profile) { try { await window.CBV2.profile.load(); } catch (e) { /* ignore */ } }
    } catch (err) {
      console.warn("[bootstrap] remote store activation failed:", err);
    }
    mode = "authed";

    // Gate on onboarding if this user hasn't finished it yet.
    try {
      if (await needsOnboarding()) {
        if (currentRouteName() !== "onboarding") {
          window.location.hash = "#/onboarding";
        }
        return;
      }
    } catch (e) { /* non-fatal */ }

    const current = currentRouteName();
    if (current === "auth" || current === "welcome" || current === "onboarding") {
      window.location.hash = "#/dashboard";
    }
  }

  function wireAuthStateTransitions() {
    if (!window.CBV2.auth || !window.CBV2.config.isBackendEnabled()) return;
    window.CBV2.auth.onChange(async function (session) {
      if (!session) {
        if (mode === "unauthed") return;
        window.CBV2.remoteStore.deactivate();
        if (window.CBV2.profile) window.CBV2.profile.clear();
        mode = "unauthed";
        window.location.hash = "#/welcome";
        setTimeout(function () { window.location.reload(); }, 50);
        return;
      }
      // Signed in (or token refreshed). If not already hydrated, do it now.
      if (mode === "authed" && window.CBV2.store.isRemote) return;
      try {
        const client = window.CBV2.auth.getClient();
        const user = window.CBV2.auth.getUser();
        await window.CBV2.remoteStore.activate(client, user);
        if (window.CBV2.profile) { try { await window.CBV2.profile.load(); } catch (e) { /* ignore */ } }
        mode = "authed";

        let goOnboarding = false;
        try { goOnboarding = await needsOnboarding(); } catch (e) { /* ignore */ }

        if (goOnboarding) {
          // Render onboarding fullscreen — don't mount the sidebar.
          // EXCEPTION: don't yank a user who just confirmed their email
          // straight into onboarding. They're staring at the "You're in!"
          // card with two CTAs (profile setup OR dashboard) — let them
          // pick. Onboarding will gate them on the next navigation if
          // they really haven't done it yet.
          if (currentRouteName() === "auth/confirmed") {
            renderFullscreenAuthed("auth/confirmed");
          } else if (currentRouteName() !== "onboarding") {
            window.location.hash = "#/onboarding";
          } else {
            renderFullscreenAuthed("onboarding");
          }
        } else {
          const current = currentRouteName();
          // Stay on the confirmation card after sign-in completes mid-
          // render. The user explicitly clicks "Set up my profile" or
          // "Skip — open dashboard"; we don't shove them anywhere.
          if (current === "auth/confirmed") {
            renderFullscreenAuthed("auth/confirmed");
            return;
          }
          mountAppShell();
          if (current === "auth" || current === "welcome" || current === "onboarding") {
            window.location.hash = "#/dashboard";
          } else {
            window.CBV2.renderCurrentRoute();
          }
        }
      } catch (err) {
        console.warn("[bootstrap] post-signin hydrate failed:", err);
      }
    });
  }

  async function init() {
    // Default landing: dashboard for local mode, welcome for signed-out backend.
    const backendOn = window.CBV2.config.isBackendEnabled();
    normalizeHashRoute(backendOn ? "welcome" : "dashboard");
    await ensureAuthAndStore();

    function renderForCurrentMode() {
      if (mode === "unauthed") {
        renderFullscreenPublic();
        return;
      }
      const name = currentRouteName();
      if (FULLSCREEN_AUTHED_ROUTES.indexOf(name) >= 0) {
        renderFullscreenAuthed(name);
        return;
      }
      // Authed app-shell path. If we weren't previously mounted, mount now.
      if (!document.querySelector(".app-shell")) {
        mountAppShell();
      }
      window.CBV2.renderCurrentRoute();
    }

    if (mode === "unauthed") {
      renderFullscreenPublic();
    } else if (FULLSCREEN_AUTHED_ROUTES.indexOf(currentRouteName()) >= 0) {
      renderFullscreenAuthed(currentRouteName());
    } else {
      mountAppShell();
      window.CBV2.renderCurrentRoute();
    }

    // P3 boot splash: mark body as booted so the splash fades + the
    // app outlet becomes visible. requestAnimationFrame ensures the
    // first paint of the actual UI lands before we kick off the fade
    // — gets us a clean handoff without a flash of empty shell.
    requestAnimationFrame(function () {
      document.body.classList.add("cb-booted");
      // Remove the splash element entirely after the fade so it isn't
      // sitting in the DOM intercepting (already pointer-events:none
      // but cleaner to drop it).
      setTimeout(function () {
        const splash = document.getElementById("cb-boot-splash");
        if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
      }, 280);
    });

    window.addEventListener("hashchange", renderForCurrentMode);
    wireAuthStateTransitions();
  }

  init();
})();
