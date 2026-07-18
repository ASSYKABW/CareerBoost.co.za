// Live SA job-market facts, for the user-facing Analytics.
//
// Analytics used to be entirely self-referential: its "missing skills" were the
// skills the user had typed into their own must-have list, and its benchmarks
// were hardcoded constants. This is the external truth it was missing — the
// same weekly scan that powers the marketing engine (real postings, real skill
// demand, real salary-disclosure rates), served through the market-insights
// function so the underlying table stays server-only.
//
// Cached for the session: the scan only changes weekly, so re-fetching per
// render would be pure waste. Every failure path degrades to null — Analytics
// must render fine without this, it's an enrichment, not a dependency.
(function () {
  window.CBV2 = window.CBV2 || {};

  const CACHE_KEY = "cbv2_market_insights_v1";
  const TTL_MS = 6 * 60 * 60 * 1000; // 6h — the scan is weekly; this is just churn control

  const state = { data: null, loadedAt: 0, loading: null };

  // Map a free-text target title onto one of the scanned segments. Deliberately
  // conservative: a wrong match (accountant figures shown to a developer) is far
  // worse than no match, so anything unrecognised returns null and the UI says
  // it has no read on that role rather than guessing.
  const SEGMENT_RULES = [
    { segment: "software-developer", test: /(software|developer|engineer|programmer|full[\s-]?stack|back[\s-]?end|front[\s-]?end|devops|\.net|java|python|react|node)/i },
    { segment: "data-analyst", test: /(data analyst|data scientist|business intelligence|\bbi\b|analytics|data engineer|\bdata\b)/i },
    { segment: "accountant", test: /(accountant|accounting|bookkeep|audit|financial account|payroll|\bfinance\b)/i },
    { segment: "sales-representative", test: /(sales|business development|account manager|account executive|\bbdm\b|representative)/i }
  ];

  function matchSegment(titles) {
    const list = [].concat(titles || []).filter(Boolean).map(String);
    for (let i = 0; i < list.length; i++) {
      for (let r = 0; r < SEGMENT_RULES.length; r++) {
        if (SEGMENT_RULES[r].test.test(list[i])) return SEGMENT_RULES[r].segment;
      }
    }
    return null;
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.at || Date.now() - parsed.at > TTL_MS) return null;
      return parsed.data || null;
    } catch (e) { return null; }
  }

  function writeCache(data) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* quota — non-fatal */ }
  }

  async function load() {
    if (state.data && Date.now() - state.loadedAt < TTL_MS) return state.data;
    if (state.loading) return state.loading;

    const cached = readCache();
    if (cached) { state.data = cached; state.loadedAt = Date.now(); return cached; }

    const auth = window.CBV2.auth;
    const cfg = window.CBV2.config;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) return null;
    if (!cfg || !cfg.isBackendEnabled || !cfg.isBackendEnabled()) return null;

    state.loading = (async function () {
      try {
        const client = auth.getClient && auth.getClient();
        if (!client || !client.functions || typeof client.functions.invoke !== "function") return null;
        const res = await client.functions.invoke("market-insights", { body: {} });
        if (res.error) throw res.error;
        const data = res.data;
        if (!data || data.ok === false || !Array.isArray(data.segments)) return null;
        state.data = data;
        state.loadedAt = Date.now();
        writeCache(data);
        return data;
      } catch (e) {
        if (window.__CAREERBOOST_MARKET_DEBUG) console.warn("[market] load failed:", e && e.message);
        return null;
      } finally {
        state.loading = null;
      }
    })();
    return state.loading;
  }

  function get() { return state.data; }

  function segmentFor(titles) {
    const data = state.data;
    if (!data || !data.segments || !data.segments.length) return null;
    const id = matchSegment(titles);
    if (!id) return null;
    for (let i = 0; i < data.segments.length; i++) {
      if (data.segments[i].segment === id) return data.segments[i];
    }
    return null;
  }

  /**
   * Skills the market asks for that the candidate has no evidence of.
   * `haveSkills` is the candidate's own skill corpus (resume + profile), so the
   * gap is measured against what employers actually posted this week — not,
   * as before, against a list the user typed themselves.
   */
  function skillGap(segment, haveSkills) {
    if (!segment || !Array.isArray(segment.topSkills)) return [];
    const have = {};
    [].concat(haveSkills || []).forEach(function (s) {
      const k = String(s || "").toLowerCase().trim();
      if (k) have[k] = true;
    });
    return segment.topSkills.filter(function (s) {
      const k = String(s.name || "").toLowerCase().trim();
      if (!k) return false;
      if (have[k]) return false;
      // Substring both ways so "node.js" vs "node" and "aws" vs "aws cloud" match.
      for (const key in have) {
        if (key.indexOf(k) >= 0 || k.indexOf(key) >= 0) return false;
      }
      return true;
    });
  }

  window.CBV2.marketInsights = {
    load: load,
    get: get,
    matchSegment: matchSegment,
    segmentFor: segmentFor,
    skillGap: skillGap
  };
})();
