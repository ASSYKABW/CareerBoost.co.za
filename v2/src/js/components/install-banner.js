// PWA "Add to Home Screen" install nudge.
//
// Chrome on Android (and Edge / Samsung Internet) fires a beforeinstallprompt
// event when the site is installable AND the user has engaged enough to
// pass the browser's heuristics. We catch the event, stash it, then surface
// a small banner asking the user to install. Tap "Install" → Chrome's
// native install dialog opens. Tap "Not now" → we dismiss for 14 days.
//
// Why this exists:
//   The Web Share Target feature (Phase 2) only works for INSTALLED PWAs.
//   Most users don't know that "Add to Home Screen" exists, let alone that
//   it enables the share menu integration. Without this nudge, the entire
//   share_target feature stays invisible to them.
//
// Storage:
//   localStorage["cb_install_nudge_v1"] = { choice: "dismissed"|"accepted", at: ts }
//   "dismissed" recurs after 14 days (allows a retry if the user grew interested).
//   "accepted" never shows again (we trust Chrome to know if they uninstalled).
//
// Routes where the banner is suppressed (focus contexts):
//   auth*, onboarding, admin, interview, resume, cover-letter — places where
//   interrupting the user is rude.

(function () {
  if (window.CB_INSTALL_NUDGE_INSTALLED) return;
  window.CB_INSTALL_NUDGE_INSTALLED = true;

  const STORAGE_KEY = "cb_install_nudge_v1";
  const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const BANNER_ID = "cb-install-banner";
  // Routes where we DON'T pop the banner. Match on hash prefix.
  const QUIET_ROUTE_PREFIXES = [
    "auth",
    "onboarding",
    "admin",
    "interview",
    "resume",
    "cover-letter",
  ];

  // Holds the deferred beforeinstallprompt event so we can fire .prompt()
  // later from a user gesture (Chrome only allows it once, from a gesture).
  let deferredPrompt = null;

  function readState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.choice) return null;
      if (parsed.choice === "dismissed" && Date.now() - (parsed.at || 0) > DISMISS_TTL_MS) {
        return null; // dismissal expired, allow re-show
      }
      return parsed.choice;
    } catch (_e) { return null; }
  }

  function writeState(choice) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        choice: choice, at: Date.now()
      }));
    } catch (_e) { /* quota / private mode — non-fatal */ }
  }

  function isStandaloneAlready() {
    // Already installed and running as a PWA — don't pester.
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.navigator && window.navigator.standalone === true) return true; // iOS Safari
    return false;
  }

  function isMobileViewport() {
    // Touch + narrow. The install prompt is most valuable on phones; desktop
    // users can install via the address bar icon if they want to.
    const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const narrow = window.innerWidth < 820;
    return touch || narrow;
  }

  function currentRouteName() {
    const raw = (window.location.hash || "").replace(/^#\//, "").trim();
    return (raw.split("?")[0] || "").toLowerCase();
  }

  function isQuietRoute() {
    const name = currentRouteName();
    if (!name) return false;
    return QUIET_ROUTE_PREFIXES.some(function (prefix) {
      return name === prefix || name.indexOf(prefix + "/") === 0;
    });
  }

  function cookieBannerPresent() {
    return !!document.getElementById("cb-cookie-banner");
  }

  function injectStyles() {
    if (document.getElementById("cb-install-banner-styles")) return;
    const style = document.createElement("style");
    style.id = "cb-install-banner-styles";
    style.textContent = (
      "#" + BANNER_ID + "{" +
        "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483644;" + // below cookie banner
        "max-width:520px;margin:0 auto;padding:12px 14px;" +
        "background:linear-gradient(180deg,#0f172a 0%,#080d18 100%);" +
        "border:1px solid rgba(34,227,255,0.28);border-radius:14px;" +
        "box-shadow:0 18px 50px rgba(0,0,0,0.5);color:#f8fbff;" +
        "font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
        "display:flex;align-items:center;gap:12px;" +
        "transform:translateY(20px);opacity:0;" +
        "animation:cb-install-pop 240ms cubic-bezier(0.16,1,0.3,1) 100ms forwards;" +
      "}" +
      "@keyframes cb-install-pop{to{transform:translateY(0);opacity:1}}" +
      "#" + BANNER_ID + ".is-dismissing{" +
        "transform:translateY(20px);opacity:0;transition:transform 200ms ease,opacity 200ms ease;" +
      "}" +
      "#" + BANNER_ID + ".is-above-cookie{bottom:96px;}" + // stack above cookie banner
      "#" + BANNER_ID + " .cb-install-icon{" +
        "flex:0 0 auto;width:42px;height:42px;border-radius:10px;" +
        "background:rgba(34,227,255,0.12);color:#22e3ff;" +
        "display:flex;align-items:center;justify-content:center;font-size:18px;" +
      "}" +
      "#" + BANNER_ID + " .cb-install-text{flex:1 1 auto;min-width:0;}" +
      "#" + BANNER_ID + " .cb-install-title{" +
        "font-size:14px;font-weight:600;color:#f8fbff;margin:0 0 2px;" +
      "}" +
      "#" + BANNER_ID + " .cb-install-sub{" +
        "font-size:12.5px;color:rgba(232,238,252,0.65);margin:0;line-height:1.4;" +
      "}" +
      "#" + BANNER_ID + " .cb-install-actions{" +
        "display:flex;gap:6px;flex:0 0 auto;" +
      "}" +
      "#" + BANNER_ID + " button{" +
        "appearance:none;border:0;cursor:pointer;font:inherit;" +
        "padding:8px 12px;border-radius:8px;" +
      "}" +
      "#" + BANNER_ID + " .cb-install-primary{" +
        "background:linear-gradient(135deg,#22e3ff,#5eead4);color:#062018;font-weight:700;" +
      "}" +
      "#" + BANNER_ID + " .cb-install-primary:hover{filter:brightness(1.08)}" +
      "#" + BANNER_ID + " .cb-install-dismiss{" +
        "background:transparent;color:rgba(232,238,252,0.5);font-size:18px;line-height:1;" +
        "padding:6px 8px;" +
      "}" +
      "#" + BANNER_ID + " .cb-install-dismiss:hover{color:#f8fbff}" +
      "@media (max-width:480px){" +
        "#" + BANNER_ID + "{padding:10px 12px;gap:10px;}" +
        "#" + BANNER_ID + " .cb-install-icon{width:36px;height:36px;font-size:15px;}" +
        "#" + BANNER_ID + " .cb-install-title{font-size:13px;}" +
        "#" + BANNER_ID + " .cb-install-sub{font-size:11.5px;}" +
      "}"
    );
    document.head.appendChild(style);
  }

  function buildBanner() {
    const wrap = document.createElement("div");
    wrap.id = BANNER_ID;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Install CareerBoost on your home screen");
    if (cookieBannerPresent()) wrap.classList.add("is-above-cookie");
    wrap.innerHTML = (
      '<span class="cb-install-icon" aria-hidden="true">' +
        '<i class="fa-solid fa-mobile-screen-button"></i>' +
      '</span>' +
      '<div class="cb-install-text">' +
        '<p class="cb-install-title">Add CareerBoost to your home screen</p>' +
        '<p class="cb-install-sub">Save jobs straight from LinkedIn — opens in one tap.</p>' +
      '</div>' +
      '<div class="cb-install-actions">' +
        '<button type="button" class="cb-install-primary" data-cb-install="accept">Install</button>' +
        '<button type="button" class="cb-install-dismiss" data-cb-install="dismiss" aria-label="Dismiss">' +
          '&times;' +
        '</button>' +
      '</div>'
    );
    return wrap;
  }

  function removeBanner() {
    const el = document.getElementById(BANNER_ID);
    if (!el) return;
    el.classList.add("is-dismissing");
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  function trackEvent(name, extra) {
    try {
      if (window.plausible) window.plausible(name, { props: extra || {} });
    } catch (_e) { /* ignore */ }
    try {
      if (window.CBV2 && window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
        window.CBV2.usage.track(name, extra || {}, { module: "pwa", route: currentRouteName() });
      }
    } catch (_e) { /* ignore */ }
  }

  function show() {
    if (document.getElementById(BANNER_ID)) return;
    if (!deferredPrompt) return;
    if (isQuietRoute()) return; // suppress on focus routes
    injectStyles();
    const banner = buildBanner();
    document.body.appendChild(banner);
    trackEvent("pwa_install_prompted", {});

    banner.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest && e.target.closest("[data-cb-install]");
      if (!btn) return;
      const action = btn.getAttribute("data-cb-install");

      if (action === "accept") {
        const promptEvt = deferredPrompt;
        if (!promptEvt) { removeBanner(); return; }
        deferredPrompt = null;
        try {
          promptEvt.prompt();
          (promptEvt.userChoice || Promise.resolve({ outcome: "unknown" })).then(function (choiceRes) {
            const outcome = (choiceRes && choiceRes.outcome) || "unknown";
            if (outcome === "accepted") {
              writeState("accepted");
              trackEvent("pwa_install_accepted", {});
            } else {
              writeState("dismissed");
              trackEvent("pwa_install_dismissed", { via: "native-dialog" });
            }
            removeBanner();
          });
        } catch (err) {
          // If .prompt() throws (e.g., already consumed), fall back gracefully.
          writeState("dismissed");
          trackEvent("pwa_install_dismissed", { via: "prompt-error" });
          removeBanner();
        }
      } else if (action === "dismiss") {
        writeState("dismissed");
        trackEvent("pwa_install_dismissed", { via: "banner-x" });
        removeBanner();
      }
    });
  }

  function tryShow() {
    if (!deferredPrompt) return;
    if (readState()) return;          // user already chose
    if (isStandaloneAlready()) return; // already installed
    if (!isMobileViewport()) return;   // desktop has the address-bar icon
    if (isQuietRoute()) return;        // suppress on focus screens
    // Defer slightly so we don't land in the middle of first-paint and
    // never collide with the cookie banner's entry animation.
    setTimeout(show, cookieBannerPresent() ? 1500 : 600);
  }

  // Catch the install event. Chrome fires this when the site meets the
  // installability criteria AND the user has engaged enough. preventDefault()
  // is what lets us defer the dialog and fire it from our own button.
  window.addEventListener("beforeinstallprompt", function (e) {
    if (readState()) return; // respect prior dismissal
    if (isStandaloneAlready()) return;
    e.preventDefault();
    deferredPrompt = e;
    tryShow();
  });

  // If the user installs via the browser's UI (not our banner), clean up.
  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    writeState("accepted");
    trackEvent("pwa_install_accepted", { via: "browser-ui" });
    removeBanner();
  });

  // Re-evaluate on route changes — if the user navigates AWAY from a quiet
  // route to the dashboard, we still want to surface the prompt.
  window.addEventListener("hashchange", function () {
    if (!document.getElementById(BANNER_ID)) tryShow();
  });

  // Test escape hatch — useful for QA reset and manual triggers.
  window.CBInstall = {
    reset: function () {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (_e) {}
      removeBanner();
    },
    forceShow: function () {
      // For testing only — only works if Chrome actually fired the event.
      tryShow();
    }
  };
})();
