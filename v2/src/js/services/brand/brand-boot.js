// Brand boot (Marketing engine — Phase 0).
//
// Fetches the published brand_settings (content-public edge fn) into
// window.CB_BRAND so brand-kit.js renders the live wordmark/tagline, and
// patches any already-rendered logo in place. Fails silently → the site falls
// back to the hardcoded defaults in brand-kit.js (so it never breaks if the
// function isn't deployed / the user is offline).
(function () {
  if (typeof window === "undefined") return;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function wordmarkHtml(wm) {
    return wm === "CareerBoost" ? "Career<span>Boost</span>" : esc(wm);
  }

  function applyBrand(b) {
    if (!b || typeof b !== "object") return;
    window.CB_BRAND = b;
    try {
      if (b.tagline) {
        document.querySelectorAll(".cb-logo-tagline").forEach(function (el) {
          el.textContent = b.tagline;
        });
      }
      if (b.wordmark) {
        document.querySelectorAll(".cb-logo-wordmark").forEach(function (el) {
          el.innerHTML = wordmarkHtml(b.wordmark);
        });
      }
    } catch (_e) { /* DOM not ready / no logo on page — ignore */ }
  }

  function boot() {
    try {
      var cfg = window.CBV2 && window.CBV2.config;
      var base = cfg && cfg.getFunctionsUrl && cfg.getFunctionsUrl();
      if (!base) return;
      var anon = cfg && cfg.getSupabaseAnon && cfg.getSupabaseAnon();
      var headers = anon ? { apikey: anon, Authorization: "Bearer " + anon } : {};
      fetch(base + "/content-public", { headers: headers })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.ok && d.brand) applyBrand(d.brand); })
        .catch(function () { /* offline / not deployed — keep fallbacks */ });
    } catch (_e) { /* ignore */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
