// Shared JSON-LD JobPosting extractor.
//
// Modern job sites (LinkedIn, Indeed, Greenhouse, most ATS platforms) embed
// schema.org JobPosting structured data in `<script type="application/ld+json">`
// blocks for SEO. That data is *much* more stable than CSS selectors:
//   - Class names rotate every few weeks.
//   - JSON-LD shape is anchored to schema.org and changes maybe yearly.
//   - It's the same source Google uses for Jobs Search results, so sites
//     have a strong incentive to keep it accurate.
//
// This module exposes window.__CBExtractor with two helpers:
//   - parseJsonLdJob() → first JobPosting found, normalized to our canonical
//     shape, or null.
//   - findJsonLdBlocks() → all parsed JSON-LD documents on the page.
//
// Per-vendor content scripts call parseJsonLdJob() first; if it returns null
// (page not yet hydrated, or vendor that doesn't ship JSON-LD), they fall
// back to whatever CSS-selector path they had before.

(function () {
  if (window.__CBExtractor) return;

  function safeParse(text) {
    try { return JSON.parse(text); }
    catch (_e) { return null; }
  }

  /**
   * Return ALL parsed JSON-LD documents on the page. Each `<script>` tag
   * may contain a single object or an array — we flatten everything into
   * a flat list of objects.
   */
  function findJsonLdBlocks() {
    const tags = document.querySelectorAll('script[type="application/ld+json"]');
    const out = [];
    tags.forEach(function (tag) {
      const text = tag && tag.textContent;
      if (!text) return;
      const parsed = safeParse(text);
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        parsed.forEach(function (item) { if (item && typeof item === "object") out.push(item); });
      } else if (parsed && typeof parsed === "object") {
        // Some sites wrap multiple types in an @graph array.
        if (Array.isArray(parsed["@graph"])) {
          parsed["@graph"].forEach(function (item) { if (item && typeof item === "object") out.push(item); });
        } else {
          out.push(parsed);
        }
      }
    });
    return out;
  }

  function isJobPosting(obj) {
    if (!obj || typeof obj !== "object") return false;
    const t = obj["@type"];
    if (Array.isArray(t)) return t.indexOf("JobPosting") >= 0;
    return t === "JobPosting";
  }

  function clean(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }

  function cleanMultiline(text) {
    return String(text == null ? "" : text)
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|li|div|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .split(/\n+/)
      .map(function (line) { return line.replace(/[ ]{2,}/g, " ").trim(); })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function pickHiringOrgName(org) {
    if (!org) return "";
    if (typeof org === "string") return clean(org);
    if (typeof org === "object") return clean(org.name || org["@name"] || "");
    return "";
  }

  function pickLogo(org) {
    if (!org || typeof org !== "object") return null;
    const logo = org.logo;
    if (!logo) return null;
    if (typeof logo === "string") return logo;
    if (typeof logo === "object" && typeof logo.url === "string") return logo.url;
    return null;
  }

  /**
   * Compose a human-readable location string from the various JSON-LD shapes:
   *   - "TELECOMMUTE" jobLocationType → "Remote"
   *   - jobLocation may be an object or array of objects
   *   - applicantLocationRequirements may include country names
   */
  function pickLocation(job) {
    const remoteHint = job.jobLocationType === "TELECOMMUTE" || /telecommute|remote/i.test(String(job.jobLocationType || ""));
    const locs = [];
    const raw = job.jobLocation;
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    arr.forEach(function (loc) {
      if (!loc) return;
      if (typeof loc === "string") {
        locs.push(clean(loc));
        return;
      }
      const addr = loc.address || loc;
      if (!addr || typeof addr !== "object") return;
      const parts = [
        addr.streetAddress, addr.addressLocality, addr.addressRegion,
        addr.postalCode, addr.addressCountry && (addr.addressCountry.name || addr.addressCountry)
      ].filter(Boolean).map(clean).filter(Boolean);
      if (parts.length) locs.push(parts.join(", "));
    });
    // applicantLocationRequirements is used by remote jobs to say "anywhere in
    // the US/EU/etc." — fold those into the location string so users see
    // geographic constraints.
    const reqs = job.applicantLocationRequirements;
    if (Array.isArray(reqs)) {
      reqs.forEach(function (r) {
        if (r && r.name) locs.push("Open to: " + clean(r.name));
      });
    } else if (reqs && reqs.name) {
      locs.push("Open to: " + clean(reqs.name));
    }
    let result = locs.filter(Boolean).join(" · ");
    if (remoteHint && !/remote/i.test(result)) {
      result = result ? "Remote · " + result : "Remote";
    }
    return result;
  }

  /** Normalize various ISO date shapes to a YYYY-MM-DD string (or null). */
  function pickPostedAt(job) {
    const d = job.datePosted || job.postedDate || job.startDate;
    if (!d) return null;
    const s = String(d);
    // schema.org allows full ISO 8601; we keep just the date portion.
    const m = s.match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
  }

  /** "Senior · Full-time" type chip set. Optional tags. */
  function pickTags(job) {
    const tags = [];
    if (job.employmentType) {
      const t = Array.isArray(job.employmentType) ? job.employmentType.join(" ") : String(job.employmentType);
      t.split(/[,\s]+/).forEach(function (s) {
        const c = clean(s).toLowerCase();
        if (c) tags.push(c.replace(/_/g, " "));
      });
    }
    if (job.experienceRequirements) {
      const e = job.experienceRequirements;
      if (typeof e === "string") tags.push(clean(e));
      else if (e && e.monthsOfExperience) tags.push(Math.round(e.monthsOfExperience / 12) + "yr+ experience");
    }
    if (job.industry) {
      const i = Array.isArray(job.industry) ? job.industry.join(", ") : String(job.industry);
      if (i) tags.push(clean(i));
    }
    return tags.slice(0, 8);
  }

  /** Compose a salary string like "$120k - $160k / year USD" or null. */
  function pickSalary(job) {
    const sal = job.baseSalary || job.salary;
    if (!sal) return null;
    if (typeof sal === "string") return clean(sal);
    if (typeof sal !== "object") return null;
    const value = sal.value;
    if (!value) return null;
    const currency = sal.currency || (value && value.currency) || "";
    let min, max, unit;
    if (typeof value === "object") {
      min = Number(value.minValue || value.value || 0);
      max = Number(value.maxValue || value.value || 0);
      unit = clean(value.unitText || "");
    } else if (typeof value === "number") {
      min = max = value;
    }
    function fmt(n) {
      if (!n) return "";
      if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
      return "$" + n;
    }
    let out = "";
    if (min && max && min !== max) out = fmt(min) + " – " + fmt(max);
    else if (min) out = fmt(min);
    if (unit) out += " / " + unit.toLowerCase();
    if (currency && currency !== "USD") out += " " + currency;
    return out || null;
  }

  /**
   * Convert a JSON-LD JobPosting object to our canonical job shape.
   * Returns null if the object is missing essential fields (title or hiring org).
   */
  function extractFromJsonLd(job, vendor) {
    if (!job || typeof job !== "object") return null;
    const title = clean(job.title);
    const company = pickHiringOrgName(job.hiringOrganization);
    if (!title || !company) return null;
    const description = cleanMultiline(job.description || "").slice(0, 24000);
    const location = pickLocation(job);
    const tags = pickTags(job);
    if (vendor) tags.unshift(String(vendor).toLowerCase());
    return {
      title: title,
      company: company,
      location: location,
      url: clean(job.url || ""),
      remote: job.jobLocationType === "TELECOMMUTE" || /telecommute|remote/i.test(String(job.jobLocationType || "")),
      postedAt: pickPostedAt(job),
      tags: tags,
      descriptionText: description,
      salary: pickSalary(job),
      logo: pickLogo(job.hiringOrganization),
      _source: "json-ld"
    };
  }

  /**
   * Find the first JobPosting in the page's JSON-LD blocks and return our
   * canonical shape. Pass `vendor` (e.g. "linkedin") so it gets prepended
   * to tags.
   */
  function parseJsonLdJob(vendor) {
    const blocks = findJsonLdBlocks();
    for (let i = 0; i < blocks.length; i++) {
      if (isJobPosting(blocks[i])) {
        const out = extractFromJsonLd(blocks[i], vendor);
        if (out) return out;
      }
    }
    return null;
  }

  window.__CBExtractor = {
    parseJsonLdJob: parseJsonLdJob,
    findJsonLdBlocks: findJsonLdBlocks,
    extractFromJsonLd: extractFromJsonLd,
    isJobPosting: isJobPosting,
    clean: clean,
    cleanMultiline: cleanMultiline
  };
})();
