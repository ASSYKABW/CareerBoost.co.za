// P1: Cookie / privacy notice banner.
//
// One-time bottom-of-screen banner shown until the user dismisses it.
// Scope is intentionally minimal — per the product decision the user
// chose "banner with link to /privacy only" rather than granular
// category toggles or strict block-before-consent gating.
//
// Why this style:
//   1. The site has no third-party analytics/marketing cookies today
//      (no Google Analytics, no Meta pixel, no Hotjar). Supabase auth
//      uses localStorage which is strictly-necessary for the app to
//      work — gating that behind consent would break the entire site.
//   2. Google Fonts and Font Awesome are CSS/font assets; they don't
//      set cookies in the browser sense. Some Font Awesome kits do,
//      but the cdnjs/jsdelivr distribution we use does not.
//   3. ePrivacy Directive + GDPR Recital 32 require notice + opt-out
//      for non-essential tracking; we're well below that threshold,
//      so a notice-only banner with a link to /privacy is compliant
//      for our current footprint. When we add analytics later, swap
//      this for the granular-categories variant.
//
// Storage:
//   localStorage["cb_cookie_notice_v1"] = "ack" | "later"
//   "ack" stays forever; "later" expires after 24h so the banner
//   nudges them again if they ignored it.
//
// Wiring:
//   Loaded as a normal <script> tag before bootstrap.js. Self-installs
//   on DOMContentLoaded (or immediately if DOM is already ready).

(function () {
  if (window.CB_COOKIE_BANNER_INSTALLED) return;
  window.CB_COOKIE_BANNER_INSTALLED = true;

  const STORAGE_KEY = "cb_cookie_notice_v1";
  const LATER_TTL_MS = 24 * 60 * 60 * 1000;     // 24h
  const BANNER_ID = "cb-cookie-banner";

  function readConsent() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.choice) return null;
      // "later" expires; "ack" never does.
      if (parsed.choice === "later" && Date.now() - (parsed.at || 0) > LATER_TTL_MS) {
        return null;
      }
      return parsed.choice;
    } catch (_e) {
      return null;
    }
  }

  function writeConsent(choice) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice: choice, at: Date.now() }));
    } catch (_e) { /* private mode or quota full — non-fatal */ }
  }

  function injectStyles() {
    if (document.getElementById("cb-cookie-banner-styles")) return;
    const style = document.createElement("style");
    style.id = "cb-cookie-banner-styles";
    // Inline styles (not in main bundle) so the banner appears reliably
    // even during early bootstrap before stylesheets finish loading.
    style.textContent = (
      "#" + BANNER_ID + "{" +
        "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483645;" +
        "max-width:760px;margin:0 auto;padding:14px 18px;" +
        "background:linear-gradient(180deg,#101728 0%,#0a0f1d 100%);" +
        "border:1px solid rgba(94,234,212,0.22);border-radius:14px;" +
        "box-shadow:0 12px 40px rgba(0,0,0,0.45);color:#f8fbff;" +
        "font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
        "display:flex;align-items:center;flex-wrap:wrap;gap:12px;" +
        "transform:translateY(20px);opacity:0;" +
        "animation:cb-cookie-pop 220ms cubic-bezier(0.16,1,0.3,1) 200ms forwards;" +
      "}" +
      "@keyframes cb-cookie-pop{to{transform:translateY(0);opacity:1}}" +
      "#" + BANNER_ID + ".is-dismissing{" +
        "transform:translateY(20px);opacity:0;transition:transform 180ms ease,opacity 180ms ease;" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-icon{" +
        "flex:0 0 auto;width:36px;height:36px;border-radius:10px;" +
        "background:rgba(94,234,212,0.12);color:#5eead4;" +
        "display:flex;align-items:center;justify-content:center;font-size:16px;" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-text{" +
        "flex:1 1 280px;min-width:0;color:rgba(232,238,252,0.92);" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-text a{" +
        "color:#5eead4;text-decoration:underline;text-underline-offset:2px;" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-actions{" +
        "display:flex;gap:8px;flex:0 0 auto;" +
      "}" +
      "#" + BANNER_ID + " button{" +
        "appearance:none;border:0;cursor:pointer;font:inherit;" +
        "padding:8px 14px;border-radius:8px;" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-primary{" +
        "background:linear-gradient(135deg,#5eead4,#a78bfa);color:#0a0f1d;font-weight:600;" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-primary:hover{filter:brightness(1.08)}" +
      "#" + BANNER_ID + " .cb-cookie-ghost{" +
        "background:rgba(255,255,255,0.06);color:#e8eefc;border:1px solid rgba(255,255,255,0.14);" +
      "}" +
      "#" + BANNER_ID + " .cb-cookie-ghost:hover{background:rgba(255,255,255,0.12)}" +
      "@media (max-width:560px){" +
        "#" + BANNER_ID + "{padding:12px 14px;gap:8px;left:8px;right:8px;bottom:8px;}" +
        "#" + BANNER_ID + " .cb-cookie-text{font-size:13px;flex-basis:100%;}" +
        "#" + BANNER_ID + " .cb-cookie-icon{display:none;}" +
        "#" + BANNER_ID + " .cb-cookie-actions{margin-left:auto;}" +
      "}"
    );
    document.head.appendChild(style);
  }

  function buildBanner() {
    const wrap = document.createElement("div");
    wrap.id = BANNER_ID;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Cookie and privacy notice");
    wrap.innerHTML = (
      '<span class="cb-cookie-icon" aria-hidden="true">' +
        '<i class="fa-solid fa-cookie-bite"></i>' +
      '</span>' +
      '<p class="cb-cookie-text">' +
        'CareerBoost uses local storage to keep you signed in and remember your preferences. ' +
        'No advertising or third-party trackers. ' +
        'See our <a href="#/privacy">Privacy Policy</a> for full detail.' +
      '</p>' +
      '<div class="cb-cookie-actions">' +
        '<button type="button" class="cb-cookie-ghost" data-cb-cookie="later">Not now</button>' +
        '<button type="button" class="cb-cookie-primary" data-cb-cookie="ack">Got it</button>' +
      '</div>'
    );
    return wrap;
  }

  function dismiss(choice) {
    writeConsent(choice);
    const el = document.getElementById(BANNER_ID);
    if (!el) return;
    el.classList.add("is-dismissing");
    // Remove after the exit transition completes.
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  function show() {
    if (document.getElementById(BANNER_ID)) return;
    injectStyles();
    const banner = buildBanner();
    document.body.appendChild(banner);
    banner.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest && e.target.closest("[data-cb-cookie]");
      if (!btn) return;
      const choice = btn.getAttribute("data-cb-cookie");
      if (choice === "ack" || choice === "later") dismiss(choice);
    });
  }

  function maybeShow() {
    if (readConsent()) return;
    // Delay slightly so we don't compete with the app's first paint
    // and the banner doesn't shove down hero content during load.
    setTimeout(show, 600);
  }

  // Public escape hatch — useful for /privacy page "Re-show banner" CTA
  // or for QA reset between test runs.
  window.CBCookies = {
    show: show,
    reset: function () {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (_e) {}
      const el = document.getElementById(BANNER_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    },
    state: readConsent
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeShow);
  } else {
    maybeShow();
  }
})();
