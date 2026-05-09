// LinkedIn job-page capture (Phase 6 refactor).
//
// Strategy:
//   1. Try JSON-LD JobPosting first (LinkedIn ships it on /jobs/view/{id} pages).
//      ~90% of captures come back complete with no DOM scraping.
//   2. Fall back to the legacy CSS-selector path when JSON-LD is missing
//      (LinkedIn's logged-in collection pages don't always include it).
//
// Shared infrastructure: shared/json-ld-job.js + shared/capture-base.js.

(function () {
  function isJobPage() {
    return /linkedin\.com\/jobs\//i.test(location.href) &&
      (/\/jobs\/view\//i.test(location.href) ||
       /currentJobId=/.test(location.href) ||
       !!document.querySelector("#job-details"));
  }

  function canonicalLinkedInJobUrl() {
    const href = location.href;
    const viewMatch = href.match(/linkedin\.com\/jobs\/view\/(\d+)/i);
    if (viewMatch) return "https://www.linkedin.com/jobs/view/" + viewMatch[1] + "/";
    try {
      const u = new URL(href);
      const currentJobId = u.searchParams.get("currentJobId");
      if (currentJobId) return "https://www.linkedin.com/jobs/view/" + currentJobId + "/";
      u.hash = "";
      return u.href;
    } catch (_err) {
      return href;
    }
  }

  // ---------- DOM-selector fallback (legacy path) ----------
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
      "#job-details",
      ".jobs-description__content",
      ".jobs-box__html-content",
      ".description__text",
      "[data-test-job-description]"
    ];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return window.__CBCapture.cleanMultiline(el.innerText || el.textContent).slice(0, 24000);
    }
    return "";
  }
  function extractFromSelectors() {
    const title = firstText([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title h1",
      ".jobs-unified-top-card__job-title",
      ".top-card-layout__title",
      "h1"
    ]);
    const company = firstText([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      ".topcard__flavor"
    ]);
    const location = firstText([
      ".job-details-jobs-unified-top-card__primary-description-container .tvm__text",
      ".jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__workplace-type",
      ".topcard__flavor--bullet",
      "[data-test-job-location]"
    ]);
    const descriptionText = extractDescriptionViaSelectors();
    const combined = title + " " + location + " " + descriptionText;
    return {
      title: title || "LinkedIn job",
      company: company || "LinkedIn listing",
      location: location || "",
      url: canonicalLinkedInJobUrl(),
      remote: /remote|work from home|wfh|hybrid/i.test(combined),
      postedAt: null,
      tags: ["linkedin"],
      descriptionText: descriptionText,
      salary: null,
      logo: null,
      _source: "selectors"
    };
  }

  // ---------- Combined extractor (JSON-LD first, selectors fallback) ----------
  function extractJob() {
    // JSON-LD path — much more stable than CSS selectors.
    if (window.__CBExtractor && typeof window.__CBExtractor.parseJsonLdJob === "function") {
      const fromLd = window.__CBExtractor.parseJsonLdJob("linkedin");
      if (fromLd && fromLd.title && fromLd.company) {
        // LinkedIn's JSON-LD `url` is sometimes the public canonical, sometimes
        // their internal redirect. Prefer the canonical we built ourselves.
        fromLd.url = fromLd.url || canonicalLinkedInJobUrl();
        if (!fromLd.tags || fromLd.tags.indexOf("linkedin") < 0) {
          fromLd.tags = ["linkedin"].concat(fromLd.tags || []);
        }
        return fromLd;
      }
    }
    return extractFromSelectors();
  }

  if (!window.__CBCapture) {
    console.warn("[CareerBoost LinkedIn] capture-base.js not loaded — extension cannot inject.");
    return;
  }
  window.__CBCapture.setupAutoInject({
    vendor: "linkedin",
    isJobPage: isJobPage,
    extractJob: extractJob
  });
})();
