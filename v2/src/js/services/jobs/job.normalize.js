(function () {
  window.CBJobs = window.CBJobs || {};

  function cleanStructuredText(value) {
    return String(value || "")
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map(function (line) { return line.trim(); })
      .join("\n")
      .trim();
  }

  function stripHtml(html) {
    if (!html) return "";
    const raw = String(html);
    if (!/<[a-z][\s\S]*>/i.test(raw)) return cleanStructuredText(raw);

    if (typeof document === "undefined") {
      return cleanStructuredText(
        raw
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<li[^>]*>/gi, "\n• ")
          .replace(/<\/li>/gi, "\n")
          .replace(/<\/(p|div|section|article|ul|ol|h[1-6])>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
      );
    }

    const div = document.createElement("div");
    div.innerHTML = raw;
    Array.prototype.forEach.call(div.querySelectorAll("br"), function (br) {
      br.parentNode.replaceChild(document.createTextNode("\n"), br);
    });
    Array.prototype.forEach.call(div.querySelectorAll("li"), function (li) {
      li.insertBefore(document.createTextNode("• "), li.firstChild);
      li.appendChild(document.createTextNode("\n"));
    });
    Array.prototype.forEach.call(div.querySelectorAll("h1,h2,h3,h4,h5,h6"), function (el) {
      el.insertBefore(document.createTextNode("\n"), el.firstChild);
      el.appendChild(document.createTextNode("\n"));
    });
    Array.prototype.forEach.call(div.querySelectorAll("p,div,section,article,ul,ol"), function (el) {
      el.appendChild(document.createTextNode("\n"));
    });
    return cleanStructuredText(div.textContent || div.innerText || "");
  }

  function toDateIso(input) {
    if (!input) return "";
    try {
      const d = new Date(input);
      if (isNaN(d.getTime())) return "";
      return d.toISOString().slice(0, 10);
    } catch (err) {
      return "";
    }
  }

  function daysSince(iso) {
    if (!iso) return 999;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 999;
    const diff = Date.now() - d.getTime();
    return Math.max(0, Math.floor(diff / (24 * 3600 * 1000)));
  }

  function detectRemote(text) {
    if (!text) return false;
    return /\bremote\b|\banywhere\b|\bwfh\b|\bwork from home\b/i.test(text);
  }

  const TITLE_NOISE = /\b(remote|worldwide|anywhere|hybrid|onsite|on-site|fulltime|full-time|parttime|part-time|contract|permanent|m\/f\/d|m\/w\/d|eu|us|uk|global|senior|junior|lead|principal|staff|mid|intermediate|jr|sr)\b/gi;

  function normalizeTitle(title) {
    return (title || "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/\[.*?\]/g, " ")
      .replace(TITLE_NOISE, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, "-");
  }

  function normalizeCompany(company) {
    return (company || "")
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|gmbh|co|corp|company|limited|incorporated|s\.?a\.?|s\.?l\.?|b\.?v\.?)\b/g, " ")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  function makeKey(company, title) {
    return normalizeCompany(company) + "::" + normalizeTitle(title);
  }

  function makeUrlKey(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      return (u.host + u.pathname).toLowerCase().replace(/\/+$/, "");
    } catch (err) {
      return (url || "").toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    }
  }

  window.CBJobs.normalize = {
    stripHtml: stripHtml,
    toDateIso: toDateIso,
    daysSince: daysSince,
    detectRemote: detectRemote,
    makeKey: makeKey,
    makeUrlKey: makeUrlKey,
    normalizeTitle: normalizeTitle,
    normalizeCompany: normalizeCompany
  };
})();
