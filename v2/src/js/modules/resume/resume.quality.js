// Resume Lab shared quality helpers.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  function clampScore(n) {
    return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  }

  function scoreTone(score) {
    const s = clampScore(score);
    if (s >= 86) return "green";
    if (s >= 70) return "warning";
    return "rose";
  }

  function readinessLabel(score) {
    const s = clampScore(score);
    if (s >= 86) return "Ready to submit";
    if (s >= 70) return "Needs light polish";
    if (s >= 50) return "Needs stronger evidence";
    return "Needs rebuilding";
  }

  function evidenceBand(score) {
    const s = clampScore(score);
    if (s >= 75) return { tone: "green", label: "Strong evidence" };
    if (s >= 45) return { tone: "warning", label: "Some evidence" };
    return { tone: "rose", label: "Thin evidence" };
  }

  // ---------------------------------------------------------------------------
  // Honest "measurable impact" detection.
  //
  // The old signal was `/\d/.test(text)` — which counts a stray year
  // ("Owned roadmap 2021"), a version ("migrated to ES6"), a phone-style
  // token, or "24/7" as a quantified achievement and badly inflates the
  // Evidence metric. This looks for a genuine magnitude / percentage /
  // currency / scale / ranking / before-after / time-reduction signal and
  // explicitly ignores bare years and version numbers.
  // ---------------------------------------------------------------------------

  // Countable "scale" nouns — a number tied to one of these is real impact.
  const SCALE_UNIT =
    "(?:users?|customers?|clients?|people|employees|engineers?|developers?|" +
    "designers?|analysts?|teams?|reports?|projects?|products?|features?|" +
    "requests?|transactions?|records?|rows|queries|tickets?|leads?|deals?|" +
    "accounts?|stores?|sites?|markets?|countries|regions|partners?|vendors?|" +
    "campaigns?|articles?|posts?|downloads?|installs?|subscribers?|followers?|" +
    "impressions?|views?|sessions?|signups?|conversions?|awards?|patents?|" +
    "sprints?|releases?|deployments?|services?|microservices|apis?|endpoints?|" +
    "models?|datasets?|dashboards?|stakeholders?|reviewers?|units?|skus?|" +
    "bugs?|defects?|incidents?|epics?|stories|repos?|repositories|schools?|" +
    "students?|members?|attendees?|participants?|components?|library|libraries|" +
    "pages?|screens?|flows?|integrations?|pipelines?|workflows?|tables?|" +
    "environments?|clusters?|nodes?|brands?|portfolios?|courses?|hires?|" +
    "applications?|apps?|websites?|platforms?|systems?|tools?|locations?)";

  const TIME_UNIT = "(?:hours?|days?|weeks?|months?|years?|minutes?|seconds?|hrs?|mins?|ms)";

  // Verbs/prepositions that turn a time figure into a measured change.
  const CHANGE_CUE =
    /\b(reduc|cut|sav|shorten|accelerat|slash|decreas|drop|down|from|within|under|below|improv|increas|grew|grow|boost|rais|speed|faster|quicker)/;

  function hasImpactMetric(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return false;
    const low = t.toLowerCase();

    // Lexical change words carry impact even without a digit.
    if (/\b(doubl|tripl|quadrupl|halv|tenfold|two-?fold|three-?fold|fivefold)\w*/.test(low)) return true;

    // Percentages: "35%", "35 percent", "by 12.5 %"
    if (/\d+(?:\.\d+)?\s?%/.test(low) || /\d+(?:\.\d+)?\s?percent/.test(low)) return true;

    // Currency + magnitude suffixes: "$1.2M", "€500k", "R2,000,000", "40k ARR"
    if (/[$€£₹]\s?\d/.test(t) || /\b\d+(?:\.\d+)?\s?(k|m|bn|mn|million|billion|thousand)\b/.test(low)) return true;

    // Multipliers: "3x", "10× faster"
    if (/\b\d+(?:\.\d+)?\s?[x×]\b/.test(low)) return true;

    // Ranking / superlative counts: "top 5", "#1", "no. 2"
    if (/\btop\s?\d+\b/.test(low) || /#\s?\d+\b/.test(low) || /\bno\.?\s?\d+\b/.test(low)) return true;

    // Before → after numeric change: "from 60 to 92", "20 → 80"
    if (/\bfrom\s+\d[\d.,]*\s*\S{0,6}\s*to\s+\d/.test(low) || /\d[\d.,]*\s*(?:→|->)\s*\d/.test(low)) return true;

    // Big magnitudes: thousands separators, or 4+ digits that aren't a bare year.
    const bigNums = low.match(/\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g) || [];
    for (let i = 0; i < bigNums.length; i += 1) {
      const digits = bigNums[i].replace(/,/g, "");
      const isYear = /^\d{4}$/.test(digits) && Number(digits) >= 1900 && Number(digits) <= 2099;
      if (!isYear) return true;
    }

    // A number tied to a countable scale noun: "12 teams", "500+ customers".
    if (new RegExp("\\d+(?:\\.\\d+)?\\+?\\s?" + SCALE_UNIT, "i").test(low)) return true;

    // A time figure only counts when paired with a change cue: "cut build time
    // to 3 minutes" ✓ but "5 years of experience" ✗.
    if (CHANGE_CUE.test(low) && new RegExp("\\d+(?:\\.\\d+)?\\s?" + TIME_UNIT + "\\b", "i").test(low)) return true;

    return false;
  }

  window.CBV2.resume.quality = {
    clampScore: clampScore,
    scoreTone: scoreTone,
    readinessLabel: readinessLabel,
    evidenceBand: evidenceBand,
    hasImpactMetric: hasImpactMetric
  };
})();
