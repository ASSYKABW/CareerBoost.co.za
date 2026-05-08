// Tiny company logo resolver.
//
// Uses DuckDuckGo's unauthenticated favicon service (`ip3/<host>.ico`) which
// works cross-origin from the browser for any public domain. We *guess* the
// domain from the company name (lowercase, alnum only, + .com) and rely on
// the <img>'s onerror fallback to show the initials badge if the guess fails.
//
// No API keys. No server round-trip. No personal data leaves the page.
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.logos) return;

  const cache = new Map();

  function slugify(company) {
    return String(company || "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 32);
  }

  function guessDomain(company) {
    const slug = slugify(company);
    if (!slug || slug.length < 2) return "";
    return slug + ".com";
  }

  function logoUrl(company) {
    if (!company) return "";
    if (cache.has(company)) return cache.get(company);
    const domain = guessDomain(company);
    if (!domain) return "";
    // DuckDuckGo's icon endpoint. Returns a 32x32 favicon, fast, no CORS issues.
    const url = "https://icons.duckduckgo.com/ip3/" + domain + ".ico";
    cache.set(company, url);
    return url;
  }

  function initialsFor(company) {
    const words = String(company || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  // Deterministic pastel tone from the company name for the initials fallback.
  function tone(company) {
    const palette = ["cyan", "violet", "blue", "green", "warning", "rose"];
    const s = String(company || "");
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
  }

  // Returns an HTML string for a logo badge with graceful initials fallback.
  // sizes: sm | md | lg
  function badge(company, size) {
    const cls = "logo-badge logo-badge--" + (size || "md") + " " + tone(company);
    const ini = initialsFor(company);
    const src = logoUrl(company);
    if (!src) {
      return '<span class="' + cls + '" aria-hidden="true">' + ini + '</span>';
    }
    // The <img> falls back by hiding itself on error, revealing the inline
    // initials span rendered behind it. The `loading="lazy"` avoids hammering
    // the icon service during long pipeline renders.
    return (
      '<span class="' + cls + '" aria-hidden="true">' +
        '<span class="logo-initials">' + ini + '</span>' +
        '<img class="logo-img" loading="lazy" src="' + src + '" alt="" ' +
          'onerror="this.style.display=\'none\';this.previousElementSibling.style.opacity=1;" />' +
      '</span>'
    );
  }

  window.CBV2.logos = {
    url: logoUrl,
    initials: initialsFor,
    tone: tone,
    badge: badge
  };
})();
