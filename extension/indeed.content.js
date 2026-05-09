// Indeed job-page capture (Phase 6).
//
// Indeed publishes JSON-LD JobPosting schema on /viewjob and /jobs pages.
// Their site has both a search/list view (left pane = list, right pane =
// detail) and a standalone /viewjob?jk={id} detail page. We support both.
//
// URL patterns:
//   - https://*.indeed.com/viewjob?jk={id}              (standalone)
//   - https://*.indeed.com/jobs?...&vjk={id}            (list with detail)
//   - https://*.indeed.com/cmp/{Company}/jobs?...       (company page)

(function () {
  function isJobPage() {
    if (!/indeed\.com\//i.test(location.href)) return false;
    if (/\/viewjob\?/.test(location.href)) return true;
    if (/[?&]vjk=/.test(location.href)) return true;
    if (/[?&]jk=/.test(location.href)) return true;
    // Fallback: detect the in-page job pane element used by Indeed's SPA list view.
    return !!document.querySelector("#vjs-content, .jobsearch-JobInfoHeader-title, [data-testid='jobsearch-JobInfoHeader-title']");
  }

  function canonicalIndeedUrl() {
    try {
      const u = new URL(location.href);
      // Prefer ?jk= over ?vjk= (vjk is the visible-job-key on list pages).
      const jk = u.searchParams.get("jk") || u.searchParams.get("vjk");
      if (jk) {
        const host = u.hostname.replace(/^www\./i, "");
        return "https://" + host + "/viewjob?jk=" + encodeURIComponent(jk);
      }
      u.hash = "";
      return u.href;
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
      "#jobDescriptionText",
      "[data-testid='jobsearch-JobComponent-description']",
      ".jobsearch-jobDescriptionText",
      "#vjs-desc",
      ".job_description"
    ];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return window.__CBCapture.cleanMultiline(el.innerText || el.textContent).slice(0, 24000);
    }
    return "";
  }
  function extractFromSelectors() {
    const title = firstText([
      "[data-testid='jobsearch-JobInfoHeader-title']",
      "[data-testid='simpler-jobTitle']",
      ".jobsearch-JobInfoHeader-title",
      "h1.jobsearch-JobInfoHeader-title",
      "h2[data-testid='simpler-jobTitle'] span",
      "h1"
    ]);
    const company = firstText([
      "[data-testid='inlineHeader-companyName'] a",
      "[data-testid='inlineHeader-companyName']",
      "[data-company-name]",
      ".jobsearch-InlineCompanyRating-companyHeader a",
      ".jobsearch-CompanyInfoContainer a",
      "div[data-testid='jobsearch-JobInfoHeader-companyName']"
    ]);
    const location = firstText([
      "[data-testid='inlineHeader-companyLocation'] div",
      "[data-testid='inlineHeader-companyLocation']",
      "[data-testid='job-location']",
      ".jobsearch-JobInfoHeader-subtitle div"
    ]);
    const descriptionText = extractDescriptionViaSelectors();
    const combined = title + " " + location + " " + descriptionText;
    return {
      title: title || "Indeed job",
      company: company || "Indeed listing",
      location: location || "",
      url: canonicalIndeedUrl(),
      remote: /remote|work from home|wfh|hybrid/i.test(combined),
      postedAt: null,
      tags: ["indeed"],
      descriptionText: descriptionText,
      salary: null,
      logo: null,
      _source: "selectors"
    };
  }

  function extractJob() {
    if (window.__CBExtractor && typeof window.__CBExtractor.parseJsonLdJob === "function") {
      const fromLd = window.__CBExtractor.parseJsonLdJob("indeed");
      if (fromLd && fromLd.title && fromLd.company) {
        // Prefer our canonical URL (with ?jk=) so dedup works across the
        // list and detail views of the same job.
        const canonical = canonicalIndeedUrl();
        if (canonical) fromLd.url = canonical;
        if (!fromLd.tags || fromLd.tags.indexOf("indeed") < 0) {
          fromLd.tags = ["indeed"].concat(fromLd.tags || []);
        }
        return fromLd;
      }
    }
    return extractFromSelectors();
  }

  if (!window.__CBCapture) {
    console.warn("[CareerBoost Indeed] capture-base.js not loaded — extension cannot inject.");
    return;
  }
  window.__CBCapture.setupAutoInject({
    vendor: "indeed",
    isJobPage: isJobPage,
    extractJob: extractJob
  });
})();
