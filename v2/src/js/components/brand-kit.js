(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.brandKit) return;

  function mark(label) {
    const a11y = label ? ' role="img" aria-label="' + String(label) + '"' : ' aria-hidden="true"';
    return (
      '<svg class="cb-mark-svg" viewBox="0 0 80 80"' + a11y + '>' +
        '<rect x="14" y="14" width="52" height="52" transform="rotate(45 40 40)" class="cb-mark-outer"></rect>' +
        '<rect x="22" y="22" width="36" height="36" transform="rotate(45 40 40)" class="cb-mark-inner"></rect>' +
        '<text x="40" y="45" text-anchor="middle" class="cb-mark-text">CB</text>' +
      '</svg>'
    );
  }

  // Phase 0 (Marketing engine): brand is data-driven. brand-boot.js fetches the
  // published brand_settings into window.CB_BRAND; we read it here with the
  // original hardcoded values as fallbacks, so nothing breaks if it's unset.
  function brand() {
    const b = (typeof window !== "undefined" && window.CB_BRAND) || {};
    return {
      wordmark: b.wordmark || "CareerBoost",
      tagline: b.tagline || "BUILT FOR AMBITION",
    };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Keep the "Career[Boost]" accent split for the default name; render a custom
  // wordmark as plain escaped text.
  function wordmarkHtml(wm) {
    if (wm === "CareerBoost") return "Career<span>Boost</span>";
    return esc(wm);
  }

  function logo(options) {
    const opts = options || {};
    const b = brand();
    const compact = opts.compact ? " cb-logo--compact" : "";
    const withTagline = opts.tagline ? (
      '<span class="cb-logo-tagline">' + esc(b.tagline) + "</span>"
    ) : "";
    return (
      '<span class="cb-logo' + compact + '">' +
        '<span class="cb-logo-mark">' + mark() + "</span>" +
        '<span class="cb-logo-copy">' +
          '<span class="cb-logo-wordmark">' + wordmarkHtml(b.wordmark) + "</span>" +
          withTagline +
        "</span>" +
      "</span>"
    );
  }

  window.CBV2.brandKit = { mark: mark, logo: logo, brand: brand };
})();
