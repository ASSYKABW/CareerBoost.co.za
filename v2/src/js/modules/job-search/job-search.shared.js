// Job Search shared presentation and query helpers.
(function () {
  window.CBV2 = window.CBV2 || {};

  function normalizeSortValue(v) {
    const s = String(v || "newest").toLowerCase();
    if (s === "match") return "newest";
    if (s === "newest" || s === "oldest" || s === "role-fit" || s === "relevance") return s;
    return "newest";
  }

  function sortLabel(sort) {
    switch (normalizeSortValue(sort)) {
      case "oldest":
        return "Oldest first";
      case "role-fit":
        return "Role fit first";
      case "relevance":
        return "Keyword relevance";
      default:
        return "Newest first";
    }
  }

  function fitChipLabel(score) {
    if (typeof score !== "number") return { cls: "subtle", text: "Fit n/a" };
    if (score >= 72) return { cls: "green", text: "Strong fit" };
    if (score >= 50) return { cls: "cyan", text: "Aligned" };
    return { cls: "violet", text: "Open fit" };
  }

  function displaySourceLabel(label) {
    const raw = String(label || "").trim();
    if (/linkedin/i.test(raw)) return "LinkedIn";
    if (/indeed/i.test(raw)) return "Indeed";
    if (/adzuna/i.test(raw)) return "Adzuna";
    if (/remotive/i.test(raw)) return "Remotive";
    return raw;
  }

  function sourceChipTitle(job) {
    if (!job || typeof job !== "object") return "Job source";
    const trust = job.sourceTrust && typeof job.sourceTrust === "object" ? job.sourceTrust : null;
    if (trust && trust.warning) return trust.warning;
    if (trust && trust.urlVerified) {
      return "Verified from listing URL" + ((trust.finalUrlHost || trust.urlHost) ? ": " + (trust.finalUrlHost || trust.urlHost) : "") + ".";
    }
    if (job.sourceType === "xray") return "Discovered through a verified provider-page web search.";
    return "Reported by the search provider.";
  }

  function formatShortDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function formatRunTime(iso) {
    if (!iso || String(iso).length < 16) return "";
    try {
      return String(iso).slice(11, 16);
    } catch (e) {
      return "";
    }
  }

  function ringScoreFromTotal(total) {
    if (typeof total !== "number" || total < 0) return 0;
    return Math.min(100, Math.round(20 + Math.min(80, total * 2)));
  }

  window.CBV2.jobSearchShared = {
    normalizeSortValue: normalizeSortValue,
    sortLabel: sortLabel,
    fitChipLabel: fitChipLabel,
    displaySourceLabel: displaySourceLabel,
    sourceChipTitle: sourceChipTitle,
    formatShortDate: formatShortDate,
    formatRunTime: formatRunTime,
    ringScoreFromTotal: ringScoreFromTotal
  };
})();
