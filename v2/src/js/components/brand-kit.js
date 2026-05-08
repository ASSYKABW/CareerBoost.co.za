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

  function logo(options) {
    const opts = options || {};
    const compact = opts.compact ? " cb-logo--compact" : "";
    const withTagline = opts.tagline ? (
      '<span class="cb-logo-tagline">BUILT FOR AMBITION</span>'
    ) : "";
    return (
      '<span class="cb-logo' + compact + '">' +
        '<span class="cb-logo-mark">' + mark() + "</span>" +
        '<span class="cb-logo-copy">' +
          '<span class="cb-logo-wordmark">Career<span>Boost</span></span>' +
          withTagline +
        "</span>" +
      "</span>"
    );
  }

  window.CBV2.brandKit = { mark: mark, logo: logo };
})();
