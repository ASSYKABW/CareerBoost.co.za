(function () {
  // Routes that are visible to signed-out visitors (public).
  const PUBLIC_ROUTES = ["welcome", "auth"];
  // Routes rendered fullscreen (no sidebar/topbar) for authed users.
  const FULLSCREEN_AUTHED_ROUTES = ["onboarding"];

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
          if (currentRouteName() !== "onboarding") {
            window.location.hash = "#/onboarding";
          } else {
            renderFullscreenAuthed("onboarding");
          }
        } else {
          mountAppShell();
          const current = currentRouteName();
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

    window.addEventListener("hashchange", renderForCurrentMode);
    wireAuthStateTransitions();
  }

  init();
})();
