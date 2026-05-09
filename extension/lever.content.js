// Lever job-board capture (Phase 6).
//
// URL pattern: https://jobs.lever.co/{company}/{posting-id}
// Lever doesn't always ship JSON-LD reliably — they use Next.js with their
// own structured-data layout. Their DOM is consistent though, with stable
// data-qa attributes that have been in place for years.
//
// We try JSON-LD first (some Lever boards do ship it), then fall back to
// the data-qa selectors. The company name is in the URL path so we can
// always derive a fallback even if the page is partially rendered.

(function () {
  function isJobPage() {
    if (!/jobs\.lever\.co\//i.test(location.href)) return false;
    // /{company}/{uuid} — UUIDs are 36 chars; posting IDs are usually that.
    return /\/[\w-]+\/[\w-]{8,}/i.test(location.pathname);
  }

  function canonicalLeverUrl() {
    try {
      const u = new URL(location.href);
      // Strip everything except the canonical /{company}/{id} path.
      const m = u.pathname.match(/^\/([\w-]+)\/([\w-]+)/);
      if (m) {
        return "https://jobs.lever.co/" + m[1] + "/" + m[2];
      }
      u.search = "";
      u.hash = "";
      return u.href;
    } catch (_e) {
      return location.href;
    }
  }

  function detectCompanyFromUrl() {
    try {
      const u = new URL(location.href);
      const m = u.pathname.match(/^\/([\w-]+)/);
      if (!m) return "";
      return m[1].replace(/[-_]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    } catch (_e) {
      return "";
    }
  }

  // ---------- DOM-selector fallback (Lever's data-qa is rock-solid) ----------
  function textOf(selector) {
    const el = document.querySelector(selector);
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
  function firstText(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const t = textOf(selectors[i]);
      if (t) return t;
    }
    return "";
  }
  function extractDescriptionViaSelectors() {
    const selectors = [
      ".section-wrapper.page-full-width",
      ".content[data-qa='job-description']",
      ".section.page-centered.posting-page",
      ".posting-page",
      "main"
    ];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return window.__CBCapture.cleanMultiline(el.innerText || el.textContent).slice(0, 24000);
    }
    return "";
  }
  function extractFromSelectors() {
    const title = firstText([
      "[data-qa='posting-name']",
      "h2[data-qa='posting-name']",
      ".posting-headline h2",
      ".posting-headline",
      "h2"
    ]);
    const company = firstText([
      ".main-header-logo + div h2",
      ".company-name",
      "[data-qa='company-name']"
    ]) || detectCompanyFromUrl();
    const location = firstText([
      ".posting-categories .location",
      ".sort-by-time .posting-category",
      "[class*='location']"
    ]);
    const workMode = firstText([
      ".sort-by-commitment .posting-category",
      "[class*='workplaceType']"
    ]);
    const descriptionText = extractDescriptionViaSelectors();
    const combined = title + " " + location + " " + workMode + " " + descriptionText;
    return {
      title: title || "Lever job",
      company: company || "Lever listing",
      location: location || "",
      url: canonicalLeverUrl(),
      remote: /remote|work from home|wfh|hybrid|telecommute/i.test(combined),
      postedAt: null,
      tags: ["lever"],
      descriptionText: descriptionText,
      salary: null,
      logo: null,
      _source: "selectors"
    };
  }

  function extractJob() {
    if (window.__CBExtractor && typeof window.__CBExtractor.parseJsonLdJob === "function") {
      const fromLd = window.__CBExtractor.parseJsonLdJob("lever");
      if (fromLd && fromLd.title && fromLd.company) {
        const canonical = canonicalLeverUrl();
        if (canonical) fromLd.url = canonical;
        if (!fromLd.tags || fromLd.tags.indexOf("lever") < 0) {
          fromLd.tags = ["lever"].concat(fromLd.tags || []);
        }
        return fromLd;
      }
    }
    return extractFromSelectors();
  }

  if (!window.__CBCapture) {
    console.warn("[CareerBoost Lever] capture-base.js not loaded — extension cannot inject.");
    return;
  }
  window.__CBCapture.setupAutoInject({
    vendor: "lever",
    isJobPage: isJobPage,
    extractJob: extractJob
  });
})();
