(function () {
  window.CBV2 = window.CBV2 || {};

  function parseHash() {
    const raw = window.location.hash.replace(/^#\//, "").trim();
    if (!raw) return { route: "dashboard", params: {} };
    // Strip trailing Supabase auth fragments (#access_token=...) appended
    // after our route slug — see bootstrap.js currentRouteName() for
    // full rationale. Without this, an /auth/reset link with the SDK
    // token still in the hash produces a route="auth/reset#access_token..."
    // that doesn't match any registered route.
    const beforeFragment = raw.split("#")[0];
    const parts = beforeFragment.split("?");
    const route = parts[0] || "dashboard";
    const params = {};
    if (parts[1]) {
      parts[1].split("&").forEach(function (pair) {
        const kv = pair.split("=");
        if (kv[0]) {
          params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
        }
      });
    }
    return { route: route, params: params };
  }

  function updateActiveNav(routeId) {
    const links = document.querySelectorAll(".nav-link[data-route]");
    links.forEach(function (link) {
      const isActive = link.getAttribute("data-route") === routeId;
      link.classList.toggle("is-active", isActive);
    });
  }

  window.CBV2.getRouteParams = function () {
    return parseHash().params;
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderRouteError(routeName, err) {
    const safeRoute = escapeHtml(routeName || "unknown");
    const safeMsg = escapeHtml(err && err.message ? err.message : "Unknown render failure");
    return (
      '<section class="page-container">' +
      '<article class="card">' +
      '<p class="eyebrow">Route Error</p>' +
      '<h1 class="page-title">Could not render this page</h1>' +
      '<p class="page-subtitle">A runtime error occurred while opening <strong>' + safeRoute + "</strong>. You can retry safely.</p>" +
      '<p class="ai-error" style="margin-top:12px;">' + safeMsg + "</p>" +
      '<div class="hero-actions" style="margin-top:14px;">' +
      '<button type="button" class="btn-primary" id="route-error-retry"><i class="fa-solid fa-rotate-right"></i> Retry</button>' +
      "</div>" +
      "</article>" +
      "</section>"
    );
  }

  window.CBV2.renderCurrentRoute = function () {
    const parsed = parseHash();
    const nextRoute = parsed.route;
    const routes = window.CBV2.routes || {};
    const renderFn = routes[nextRoute] || routes.dashboard;
    window.CBV2.setRoute(routes[nextRoute] ? nextRoute : "dashboard");

    const outlet = document.getElementById("route-view");
    if (!outlet) {
      return;
    }
    // P3: render synchronously. The old path replaced the outlet with a
    // 4-card skeleton, waited 180ms via setTimeout, then rendered the
    // real route. That artificial pause meant every navigation flashed
    // empty cards for ~180ms. Sections that legitimately load async
    // data should show their own inline loading state — the router
    // shouldn't impose a generic shimmer on top of that.
    try {
      outlet.innerHTML = renderFn();
      updateActiveNav(window.CBV2.getState().route);
      const hook = window.CBV2.afterRender && window.CBV2.afterRender[window.CBV2.getState().route];
      if (typeof hook === "function") {
        hook(parsed.params);
      }
      if (window.CBV2.usage && typeof window.CBV2.usage.trackRoute === "function") {
        window.CBV2.usage.trackRoute(window.CBV2.getState().route, parsed.params);
      }
    } catch (err) {
      console.error("[router] render failure for route", window.CBV2.getState().route, err);
      outlet.innerHTML = renderRouteError(window.CBV2.getState().route, err);
      const retry = document.getElementById("route-error-retry");
      if (retry) {
        retry.addEventListener("click", function () {
          window.CBV2.renderCurrentRoute();
        });
      }
    }
  };

  // Phase C: re-render the dashboard when the tab regains focus after a long
  // idle (≥2 min). Cheap, safe, and makes counters feel "alive" without
  // requiring a manual refresh. Only triggers when actually on the dashboard.
  let lastVisibleAt = Date.now();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    const idle = now - lastVisibleAt;
    lastVisibleAt = now;
    if (idle < 2 * 60 * 1000) return;
    const state = window.CBV2.getState && window.CBV2.getState();
    if (!state) return;
    if (state.route === "dashboard" || state.route === "applications") {
      window.CBV2.renderCurrentRoute();
    }
  });
  window.addEventListener("focus", function () { lastVisibleAt = Date.now(); });
})();
