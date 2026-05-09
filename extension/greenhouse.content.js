// Greenhouse job-board capture (Phase 6).
//
// Greenhouse is one of the largest ATS platforms — companies host their
// public boards under either:
//   - https://boards.greenhouse.io/{company}/jobs/{id}
//   - https://job-boards.greenhouse.io/{company}/jobs/{id}    (newer pattern)
//   - https://{company}.greenhouse.io/jobs/{id}                (legacy custom)
//
// Greenhouse pages ship JSON-LD JobPosting reliably. The DOM is also
// stable: #header h1.app-title, .company-name, #content with description.
// We try JSON-LD first, fall back to those selectors.

(function () {
  function isJobPage() {
    if (!/greenhouse\.io\//i.test(location.href)) return false;
    return /\/jobs\/\d+/i.test(location.href) ||
           !!document.querySelector("#app_body, #content, .app-title");
  }

  function canonicalGreenhouseUrl() {
    try {
      const u = new URL(location.href);
      // Strip tracking params (gh_jid is fine to keep, but utm_* etc. should go).
      const keep = new URLSearchParams();
      ["gh_jid", "gh_src"].forEach(function (k) {
        const v = u.searchParams.get(k);
        if (v) keep.set(k, v);
      });
      const qs = keep.toString();
      return u.origin + u.pathname + (qs ? "?" + qs : "");
    } catch (_e) {
      return location.href;
    }
  }

  // ---------- DOM-selector fallback ----------
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
      "#content",
      "#app_body",
      ".job__description",
      ".job-post",
      "main"
    ];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return window.__CBCapture.cleanMultiline(el.innerText || el.textContent).slice(0, 24000);
    }
    return "";
  }
  function detectCompanyFromUrl() {
    try {
      const u = new URL(location.href);
      // boards.greenhouse.io/{company}/jobs/{id}
      const m1 = u.pathname.match(/^\/([^/]+)\/jobs\/\d+/i);
      if (m1) return m1[1].replace(/[-_]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      // {company}.greenhouse.io
      if (u.hostname.endsWith(".greenhouse.io") && u.hostname !== "boards.greenhouse.io" && u.hostname !== "job-boards.greenhouse.io") {
        const sub = u.hostname.split(".")[0];
        return sub.replace(/[-_]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      }
      return "";
    } catch (_e) {
      return "";
    }
  }
  function extractFromSelectors() {
    const title = firstText([
      "h1.app-title",
      ".app-title",
      "h1.posting-headline",
      "h1"
    ]);
    const company = firstText([
      ".company-name",
      ".company",
      "[class*='company']"
    ]) || detectCompanyFromUrl();
    const location = firstText([
      ".location",
      ".posting-categories .location",
      ".job__location",
      "[class*='location']"
    ]);
    const descriptionText = extractDescriptionViaSelectors();
    const combined = title + " " + location + " " + descriptionText;
    return {
      title: title || "Greenhouse job",
      company: company || "Greenhouse listing",
      location: location || "",
      url: canonicalGreenhouseUrl(),
      remote: /remote|work from home|wfh|hybrid/i.test(combined),
      postedAt: null,
      tags: ["greenhouse"],
      descriptionText: descriptionText,
      salary: null,
      logo: null,
      _source: "selectors"
    };
  }

  function extractJob() {
    if (window.__CBExtractor && typeof window.__CBExtractor.parseJsonLdJob === "function") {
      const fromLd = window.__CBExtractor.parseJsonLdJob("greenhouse");
      if (fromLd && fromLd.title && fromLd.company) {
        const canonical = canonicalGreenhouseUrl();
        if (canonical) fromLd.url = canonical;
        if (!fromLd.tags || fromLd.tags.indexOf("greenhouse") < 0) {
          fromLd.tags = ["greenhouse"].concat(fromLd.tags || []);
        }
        return fromLd;
      }
    }
    return extractFromSelectors();
  }

  if (!window.__CBCapture) {
    console.warn("[CareerBoost Greenhouse] capture-base.js not loaded — extension cannot inject.");
    return;
  }
  window.__CBCapture.setupAutoInject({
    vendor: "greenhouse",
    isJobPage: isJobPage,
    extractJob: extractJob
  });
})();
