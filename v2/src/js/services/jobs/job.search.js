(function () {
  window.CBJobs = window.CBJobs || {};
  window.CBJobs.providers = window.CBJobs.providers || [];

  // Phase 1: signed-in + cloud → CareerBoost Cloud (jobs-search) only; see docs/JOB_SEARCH_ARCHITECTURE.md
  function cloudJobSearchPrimary(params) {
    params = params || {};
    if (params.forceClientProviders) return false;
    if (params.sources && params.sources.length) return false;
    const cfg = window.CBV2 && window.CBV2.config;
    return Boolean(cfg && typeof cfg.isCloudJobSearchPrimary === "function" && cfg.isCloudJobSearchPrimary());
  }

  function isExternalSearchMergeEnabled() {
    const cfg = (window.CB_CONFIG && window.CB_CONFIG.externalSearch) || {};
    if (!cfg.enabled) return false;
    const auth = window.CBV2 && window.CBV2.auth;
    const appCfg = window.CBV2 && window.CBV2.config;
    return Boolean(
      auth &&
      typeof auth.isAuthenticated === "function" &&
      auth.isAuthenticated() &&
      appCfg &&
      typeof appCfg.isBackendEnabled === "function" &&
      appCfg.isBackendEnabled()
    );
  }

  function narrowProvidersForCloudPrimary(sortedProviders, params) {
    if (!cloudJobSearchPrimary(params)) return sortedProviders;
    const hasBackend = sortedProviders.some(function (p) {
      return p.id === "backend";
    });
    if (!hasBackend) {
      // Phase 2: no cloud aggregator registered — keep guest-style providers.
      return sortedProviders;
    }
    const keep = sortedProviders.filter(function (p) {
      if (p.id === "backend") return true;
      // Client-side Adzuna provider — uses the user's personal Adzuna
      // keys (set via Settings → API Keys) to do multi-region search
      // directly from the browser. Yes, it generates CORS console
      // warnings on the calls that fail, BUT calls do succeed in many
      // cases AND personal keys give users access to coverage the
      // server-side proxy (global ADZUNA_* env vars) doesn't include
      // in their plan. Removing this provider dropped search result
      // counts noticeably for power users.
      //
      // (Prior to May 2026 this was temporarily disabled — see commit
      // 640edd2 — but reverted after operator confirmed real impact.)
      if (p.id === "adzuna") return true;
      if (p.id === "external-search") return isExternalSearchMergeEnabled();
      return false;
    });
    return keep.length ? keep : sortedProviders;
  }

  function slugUpstreamId(name) {
    return String(name || "feed")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "feed";
  }

  function describeSearchPath(params) {
    params = params || {};
    const cfg = window.CBV2 && window.CBV2.config;
    const auth = window.CBV2 && window.CBV2.auth;
    const backendOn = Boolean(cfg && typeof cfg.isBackendEnabled === "function" && cfg.isBackendEnabled());
    const signedIn = Boolean(auth && typeof auth.isAuthenticated === "function" && auth.isAuthenticated());
    const cloudPrimary = cloudJobSearchPrimary(params);
    let mode = "guest_browser";
    if (params.forceClientProviders) mode = "client_forced";
    else if (cloudPrimary) mode = "cloud_primary";
    else if (signedIn && backendOn) mode = "signed_in_browser";
    else if (signedIn && !backendOn) mode = "signed_in_local";
    return { mode: mode, backendEnabled: backendOn, signedIn: signedIn, cloudPrimary: cloudPrimary };
  }

  /** Shorter TTL so filter tweaks feel fresh; use bypassCache for explicit refresh. */
  const CACHE_TTL_MS = 4 * 60 * 1000;
  const cache = new Map();

  function normalizeRoleProfileForCache(roleProfile) {
    roleProfile = roleProfile || {};
    function arr(x) {
      return (Array.isArray(x) ? x : [])
        .map(function (v) { return String(v || "").trim().toLowerCase(); })
        .filter(Boolean)
        .sort();
    }
    return {
      targetTitles: arr(roleProfile.targetTitles),
      seniority: String(roleProfile.seniority || "any").toLowerCase(),
      mustHaveSkills: arr(roleProfile.mustHaveSkills),
      excludeKeywords: arr(roleProfile.excludeKeywords),
      strictMode: !!roleProfile.strictMode
    };
  }

  function cacheKey(params) {
    const nk =
      params.nlq && Array.isArray(params.nlq.keywords)
        ? params.nlq.keywords.join(",").toLowerCase()
        : "";
    const ext = (window.CB_CONFIG && window.CB_CONFIG.externalSearch) || {};
    return JSON.stringify({
      q: (params.query || "").toLowerCase().trim(),
      r: !!params.remoteOnly,
      d: params.postedWithinDays || 0,
      l: String(params.location || "").toLowerCase().trim(),
      jt: Array.isArray(params.jobType) ? params.jobType.map(function (v) { return String(v || "").toLowerCase(); }).sort() : [],
      xl: Array.isArray(params.experienceLevel) ? params.experienceLevel.map(function (v) { return String(v || "").toLowerCase(); }).sort() : [],
      ao: params.activeOnly !== false,
      sr: String(params.searchRegion || "").toLowerCase(),
      ls: String(params.locationStrictness || "").toLowerCase(),
      s: params.sources || [],
      o: params.sort || "newest",
      nk: nk,
      rp: normalizeRoleProfileForCache(params.roleProfile),
      fc: !!params.forceClientProviders,
      es: !!ext.enabled,
      esp: String(ext.provider || "")
    });
  }

  function getFromCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.t > CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return hit.v;
  }

  function setCache(key, value) {
    cache.set(key, { t: Date.now(), v: value });
  }

  function providerRank() {
    const list = (window.CBJobs.providers || []).slice().sort(function (a, b) {
      return a.priority - b.priority;
    });
    const map = {};
    list.forEach(function (p, idx) {
      map[p.id] = idx;
    });
    return map;
  }

  function dedupe(jobs) {
    const norm = window.CBJobs.normalize;
    const rank = providerRank();
    const byKey = new Map();
    jobs.forEach(function (job) {
      const keyId = norm.makeKey(job.company, job.title);
      const keyUrl = norm.makeUrlKey(job.url);
      const key = keyId + "|" + (keyUrl || "-");
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, job);
        return;
      }
      const curRank = rank[job.sourceId] != null ? rank[job.sourceId] : (rank[job.source] != null ? rank[job.source] : 99);
      const oldRank = rank[existing.sourceId] != null ? rank[existing.sourceId] : (rank[existing.source] != null ? rank[existing.source] : 99);
      if (curRank < oldRank) byKey.set(key, job);
    });

    const seenCompanyTitle = new Map();
    byKey.forEach(function (job) {
      const k = norm.makeKey(job.company, job.title);
      const existing = seenCompanyTitle.get(k);
      if (!existing) {
        seenCompanyTitle.set(k, job);
        return;
      }
      const curRank = rank[job.sourceId] != null ? rank[job.sourceId] : (rank[job.source] != null ? rank[job.source] : 99);
      const oldRank = rank[existing.sourceId] != null ? rank[existing.sourceId] : (rank[existing.source] != null ? rank[existing.source] : 99);
      if (curRank < oldRank) seenCompanyTitle.set(k, job);
    });

    return Array.from(seenCompanyTitle.values());
  }

  const QUERY_NOISE = new Set([
    "apply", "career", "careers", "hiring", "job", "jobs", "role", "roles", "position", "positions",
    "work", "remote", "hybrid", "onsite", "on-site", "full", "time", "fulltime", "full-time",
    "part", "contract", "permanent", "temporary", "internship", "entry", "junior", "senior",
    "lead", "principal", "staff", "mid", "engineer", "engineering", "developer", "manager"
  ]);

  const LOCATION_NOISE = new Set([
    "near", "around", "within", "remote", "hybrid", "onsite", "on-site", "city", "country",
    "province", "state", "region", "area"
  ]);

  const REGION_TERMS = {
    africa: [
      "africa", "south africa", "za", "gauteng", "pretoria", "centurion", "johannesburg",
      "cape town", "durban", "kenya", "nigeria", "ghana", "egypt", "morocco"
    ],
    europe: [
      "europe", "emea", "uk", "united kingdom", "england", "london", "germany", "berlin",
      "france", "paris", "netherlands", "amsterdam", "spain", "italy", "ireland"
    ],
    north_america: [
      "north america", "usa", "united states", "us", "canada", "new york", "california",
      "texas", "toronto", "vancouver"
    ],
    asia_pacific: [
      "asia", "apac", "australia", "au", "sydney", "melbourne", "singapore", "india",
      "bangalore", "japan", "tokyo"
    ]
  };

  function cleanSourceLabel(label) {
    const raw = String(label || "").trim();
    if (/linkedin/i.test(raw)) return "LinkedIn";
    if (/indeed/i.test(raw)) return "Indeed";
    return raw || "Unknown";
  }

  function slugSourceLabel(label) {
    return String(label || "source")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42) || "source";
  }

  function inferSourceFromUrl(url) {
    let host = "";
    try {
      host = new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return "";
    }
    if (!host) return "";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
    if (host === "indeed.com" || host.endsWith(".indeed.com")) return "Indeed";
    if (host === "adzuna.com" || host.endsWith(".adzuna.com") || host.indexOf("adzuna.") === 0) return "Adzuna";
    if (host === "remotive.com" || host.endsWith(".remotive.com")) return "Remotive";
    if (host === "reed.co.uk" || host.endsWith(".reed.co.uk")) return "Reed.co.uk";
    if (host === "jobmail.co.za" || host.endsWith(".jobmail.co.za")) return "Jobmail";
    if (host === "bebee.com" || host.endsWith(".bebee.com")) return "beBee";
    if (host.indexOf("rpo-recruitment") >= 0 || host.indexOf("rporecruitment") >= 0) return "RPO Recruitment";
    if (host.indexOf("executiveplacements") >= 0) return "ExecutivePlacements.com";
    if (host.indexOf("careerjunction") >= 0) return "CareerJunction";
    if (host.indexOf("pnet") >= 0) return "PNet";
    if (host.indexOf("glassdoor") >= 0) return "Glassdoor";
    if (host.indexOf("ziprecruiter") >= 0) return "ZipRecruiter";
    if (host.indexOf("workdayjobs") >= 0 || host.indexOf("myworkdayjobs") >= 0) return "Workday";
    return host
      .replace(/\.(co\.uk|co\.za|com\.au|com|org|net|io|ai|co|jobs)$/i, "")
      .split(".")
      .pop()
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
  }

  function hostFromUrl(url) {
    try {
      return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function buildSourceTrust(src, providerMeta, inferredSource, source) {
    if (src && src.sourceTrust && typeof src.sourceTrust === "object") {
      return Object.assign({}, src.sourceTrust);
    }
    const reportedRaw = String((src && src.source) || "").trim();
    const providerRaw = String((providerMeta && (providerMeta.label || providerMeta.id)) || "").trim();
    const reported = cleanSourceLabel(reportedRaw || providerRaw || "");
    const host = hostFromUrl(src && src.url);
    const trust = {
      reportedSource: reported,
      urlHost: host,
      urlVerified: !!(host && inferredSource),
      reason: inferredSource
        ? "Source verified from the listing URL host."
        : "Source provided by the search provider."
    };
    if (inferredSource && reported && reported !== "Unknown" && reported !== source) {
      trust.warning = "Provider reported " + reported + ", but the listing URL points to " + source + ".";
      trust.reason = "CareerBoost corrected the source using the listing URL host.";
    }
    return trust;
  }

  function normalizedText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9+#.\-\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitUsefulTokens(value, noise, max) {
    return normalizedText(value)
      .split(/\s+/)
      .filter(function (token) {
        if (!token || token.length < 2) return false;
        if (/^\d+$/.test(token)) return false;
        return !(noise && noise.has(token));
      })
      .slice(0, max || 24);
  }

  function locationTokens(value) {
    return splitUsefulTokens(value, LOCATION_NOISE, 12)
      .filter(function (token) { return token.length > 2 || token === "za" || token === "uk" || token === "us"; });
  }

  function jobSearchCorpus(job) {
    return normalizedText([
      job.title,
      job.company,
      job.location,
      (job.tags || []).join(" "),
      job.employmentType,
      String(job.descriptionText || "").slice(0, 900)
    ].join(" "));
  }

  function containsTerm(text, term) {
    const t = normalizedText(term);
    if (!t) return false;
    if (text.indexOf(t) >= 0) return true;
    const parts = t.split(/\s+/).filter(Boolean);
    return parts.length > 1 && parts.every(function (p) { return p.length < 4 || text.indexOf(p) >= 0; });
  }

  function matchesLocationConstraint(job, params) {
    const wanted = String(params.location || "").trim();
    const strictness = String(params.locationStrictness || "strict").toLowerCase();
    if (!wanted) return true;

    const wantedNorm = normalizedText(wanted);
    const remoteWanted = /(^|\s)(remote|anywhere|work from home|wfh)($|\s)/.test(wantedNorm);
    if (remoteWanted) return !!job.remote || /remote|anywhere|work from home|wfh/i.test(job.location || "");

    // Companion to the backend matchesLocation fix (jobs-search/index.ts
    // commit f7bed36). A remote job is location-independent for the
    // candidate — they can do remote work from any city. Without this
    // guard, the client-side filter was nuking every remote job that
    // didn't happen to mention the user's typed city in its text,
    // including ~100% of Remotive/Arbeitnow/Jobicy results.
    if (job.remote && strictness !== "strict") return true;

    const locText = normalizedText([
      job.location,
      (job.tags || []).join(" "),
      String(job.descriptionText || "").slice(0, 500)
    ].join(" "));
    if (containsTerm(locText, wantedNorm)) return true;
    if (/south africa|\bsa\b|\bza\b/.test(wantedNorm) && /\b(za|south africa|gauteng|pretoria|centurion|johannesburg|cape town|durban)\b/.test(locText)) return true;
    if (/united kingdom|\buk\b/.test(wantedNorm) && /\b(uk|united kingdom|england|london|manchester)\b/.test(locText)) return true;
    if (/united states|\busa\b|\bus\b/.test(wantedNorm) && /\b(us|usa|united states|new york|california|texas)\b/.test(locText)) return true;

    const tokens = locationTokens(wantedNorm);
    if (!tokens.length) return strictness === "broad";
    const hits = tokens.reduce(function (sum, token) {
      return sum + (locText.indexOf(token) >= 0 ? 1 : 0);
    }, 0);
    if (strictness === "strict") {
      return hits >= Math.min(tokens.length, 2);
    }
    if (strictness === "balanced") {
      return hits > 0;
    }
    return hits > 0 || (!!job.remote && !tokens.some(function (t) { return /pretoria|centurion|johannesburg|gauteng|cape|durban/.test(t); }));
  }

  function matchesSearchRegion(job, params) {
    const region = String(params.searchRegion || "global").toLowerCase();
    if (!region || region === "global") return true;
    const terms = REGION_TERMS[region] || [];
    if (!terms.length) return true;
    // Same logic as matchesLocationConstraint: remote jobs are region-
    // independent for the candidate's purposes. A Cape Town candidate
    // searching "Africa" region should still see a remote job at a US
    // company because they could take that job. Without this guard the
    // client-side region filter killed almost every remote result.
    if (job.remote) return true;
    const text = normalizedText([
      job.location,
      (job.tags || []).join(" "),
      String(job.descriptionText || "").slice(0, 700)
    ].join(" "));
    return terms.some(function (term) { return containsTerm(text, term); });
  }

  function relevanceGateTokens(params) {
    params = params || {};
    const parts = [];
    if (params.nlq && Array.isArray(params.nlq.keywords)) {
      params.nlq.keywords.forEach(function (x) { parts.push(x); });
    }
    splitUsefulTokens(params.query || "", QUERY_NOISE, 16).forEach(function (x) { parts.push(x); });
    const rp = params.roleProfile || {};
    (Array.isArray(rp.targetTitles) ? rp.targetTitles : []).forEach(function (x) { parts.push(x); });
    (Array.isArray(rp.mustHaveSkills) ? rp.mustHaveSkills : []).forEach(function (x) { parts.push(x); });
    const locationSet = new Set(locationTokens(params.location || ""));
    const seen = {};
    const out = [];
    parts.forEach(function (part) {
      splitUsefulTokens(part, QUERY_NOISE, 8).forEach(function (token) {
        if (locationSet.has(token)) return;
        if (seen[token]) return;
        seen[token] = true;
        out.push(token);
      });
    });
    return out.slice(0, 18);
  }

  function matchesQueryConstraint(job, params) {
    const tokens = relevanceGateTokens(params);
    if (!tokens.length) return true;
    const title = normalizedText(job.title || "");
    const tags = normalizedText((job.tags || []).join(" "));
    const text = jobSearchCorpus(job);
    let titleHits = 0;
    let broadHits = 0;
    tokens.forEach(function (token) {
      if (title.indexOf(token) >= 0 || tags.indexOf(token) >= 0) titleHits += 1;
      if (text.indexOf(token) >= 0) broadHits += 1;
    });
    if (titleHits > 0) return true;
    return broadHits >= Math.min(2, tokens.length);
  }

  function applyFilters(jobs, params, diagnostics) {
    const norm = window.CBJobs.normalize;
    const days = params.postedWithinDays || 0;
    const intent = window.CBJobs.intent;
    const cfg = window.CBV2 && window.CBV2.config;
    const strictConstraintsEnabled = !(cfg && typeof cfg.isFeatureEnabled === "function") ||
      cfg.isFeatureEnabled("searchStrictConstraints");
    const d = diagnostics || null;
    if (d) {
      d.counts = d.counts || {};
      d.counts.remoteFiltered = 0;
      d.counts.postedFiltered = 0;
      d.counts.locationFiltered = 0;
      d.counts.regionFiltered = 0;
      d.counts.queryFiltered = 0;
      d.counts.intentFiltered = 0;
      d.counts.intentExcludedKeyword = 0;
      d.counts.intentSeniorityMismatch = 0;
      d.counts.intentMissingSkills = 0;
      d.counts.intentTitleMismatch = 0;
      d.counts.afterBaseFilters = 0;
      d.counts.afterConstraintFilters = 0;
      d.counts.afterIntentFilters = 0;
    }
    return jobs.filter(function (job) {
      if (params.remoteOnly && !job.remote) {
        if (!norm.detectRemote(job.location)) {
          if (d) d.counts.remoteFiltered += 1;
          return false;
        }
      }
      if (days > 0) {
        if (norm.daysSince(job.postedAt) > days) {
          if (d) d.counts.postedFiltered += 1;
          return false;
        }
      }
      if (d) d.counts.afterBaseFilters += 1;
      if (!matchesLocationConstraint(job, params)) {
        if (d) d.counts.locationFiltered += 1;
        return false;
      }
      if (!matchesSearchRegion(job, params)) {
        if (d) d.counts.regionFiltered += 1;
        return false;
      }
      if (!matchesQueryConstraint(job, params)) {
        if (d) d.counts.queryFiltered += 1;
        return false;
      }
      if (d) d.counts.afterConstraintFilters += 1;
      if (intent && typeof intent.evaluateJobIntent === "function") {
        const evalOut = intent.evaluateJobIntent(job, params.roleProfile || {});
        job.roleIntent = evalOut;
        if (strictConstraintsEnabled && !evalOut.pass) {
          if (d) {
            d.counts.intentFiltered += 1;
            if (evalOut.reasons && evalOut.reasons.some(function (r) { return r.indexOf("Excluded by keyword") >= 0; })) d.counts.intentExcludedKeyword += 1;
            if (evalOut.reasons && evalOut.reasons.some(function (r) { return r.indexOf("Seniority: mismatch") >= 0; })) d.counts.intentSeniorityMismatch += 1;
            if (evalOut.reasons && evalOut.reasons.some(function (r) { return r.indexOf("Missing skills:") >= 0; })) d.counts.intentMissingSkills += 1;
            if ((!evalOut.matchedTitle || !evalOut.matchedTitle.length) && (params.roleProfile && params.roleProfile.targetTitles && params.roleProfile.targetTitles.length)) {
              d.counts.intentTitleMismatch += 1;
            }
          }
          return false;
        }
      }
      if (d) d.counts.afterIntentFilters += 1;
      return true;
    });
  }

  function tokenizeQuery(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9+#.\-\s]+/g, " ")
      .split(/\s+/)
      .filter(function (t) {
        return t.length > 1;
      })
      .slice(0, 32);
  }

  function relevanceTokensFromParams(params) {
    params = params || {};
    const acc = [];
    const have = {};
    function take(tok) {
      const t = String(tok || "")
        .toLowerCase()
        .trim();
      if (t.length < 2 || have[t]) return;
      have[t] = true;
      acc.push(t);
    }
    const nlq = params.nlq;
    if (nlq && Array.isArray(nlq.keywords)) {
      nlq.keywords.forEach(function (k) {
        take(k);
      });
    }
    if (nlq && nlq.location != null && String(nlq.location).trim()) {
      tokenizeQuery(String(nlq.location)).forEach(take);
    }
    tokenizeQuery(params.query || "").forEach(take);
    return acc.slice(0, 24);
  }

  // Phase 5: BM25 ranker (Okapi BM25, the IR-relevance gold standard).
  // Built per `sortJobsInMemory` call so IDF reflects the current result set.
  // Falls back to the legacy substring scoring if semanticMatch isn't loaded
  // (e.g. unit-test runner that doesn't include the utils bundle).
  let bm25CorpusCache = null;
  let bm25CorpusJobs = null;
  function getBm25Corpus(jobs) {
    if (bm25CorpusJobs === jobs && bm25CorpusCache) return bm25CorpusCache;
    const sm = window.CBV2 && window.CBV2.semanticMatch;
    if (!sm || typeof sm.buildBm25 !== "function") return null;
    const docs = jobs.map(function (j) {
      return {
        id: j.id || j.url || (j.title + "|" + j.company),
        fields: {
          title: j.title || "",
          company: j.company || "",
          tags: (j.tags || []).join(" "),
          location: j.location || "",
          // Cap body to avoid IDF dominance from one verbose listing.
          body: String(j.descriptionText || "").slice(0, 1200)
        }
      };
    });
    bm25CorpusJobs = jobs;
    bm25CorpusCache = sm.buildBm25(docs, { title: 3, tags: 2, company: 1.5, location: 1, body: 1 });
    return bm25CorpusCache;
  }

  function jobTextRelevanceScore(job, tokens, allJobs) {
    if (!tokens || !tokens.length) return 0;

    // Phase 5: BM25 path when the semantic-match helper is available.
    // Reuses the corpus across all calls within a single sort to amortize
    // the IDF index build (~150 jobs × 5 fields = sub-millisecond cost).
    const sm = window.CBV2 && window.CBV2.semanticMatch;
    if (sm && typeof sm.buildBm25 === "function" && Array.isArray(allJobs) && allJobs.length) {
      const corpus = getBm25Corpus(allJobs);
      if (corpus) {
        const id = job.id || job.url || (job.title + "|" + job.company);
        const queryText = tokens.join(" ");
        // BM25 scores are unbounded — scale to a 0-100ish range so they
        // compose with the other weighted signals in scoreJob().
        const raw = corpus.score(queryText, id);
        let bm = Math.round(Math.min(100, raw * 12));
        // Recency tail-boost (kept from legacy behavior — search results
        // for the same query should prefer fresher postings).
        const posted = Date.parse(job.postedAt || "");
        if (!Number.isNaN(posted)) {
          const days = (Date.now() - posted) / 86400000;
          if (days <= 1) bm += 2;
          else if (days <= 7) bm += 1;
        }
        return bm;
      }
    }

    // Legacy fallback — substring weighted scoring. Kept so the function works
    // in test contexts that don't load the utils bundle.
    if (!job.__cbTextCache) {
      job.__cbTextCache = {
        title: (job.title || "").toLowerCase(),
        company: (job.company || "").toLowerCase(),
        loc: (job.location || "").toLowerCase(),
        tags: (job.tags || []).join(" ").toLowerCase(),
        desc: (job.descriptionText || "").toLowerCase().slice(0, 700)
      };
    }
    const title = job.__cbTextCache.title;
    const company = job.__cbTextCache.company;
    const loc = job.__cbTextCache.loc;
    const tags = job.__cbTextCache.tags;
    const desc = job.__cbTextCache.desc;
    var score = 0;
    for (var i = 0; i < tokens.length; i += 1) {
      var t = tokens[i];
      if (!t) continue;
      if (title.indexOf(t) >= 0) score += 14;
      else if (tags.indexOf(t) >= 0) score += 8;
      else if (company.indexOf(t) >= 0) score += 5;
      else if (loc.indexOf(t) >= 0) score += 4;
      else if (desc.indexOf(t) >= 0) score += 2;
    }
    var posted = Date.parse(job.postedAt || "");
    if (!Number.isNaN(posted)) {
      var days = (Date.now() - posted) / 86400000;
      if (days <= 1) score += 2;
      else if (days <= 7) score += 1;
    }
    return score;
  }

  function sortJobsInMemory(jobs, sort, params) {
    params = params || {};
    if (sort === "role-fit") {
      return jobs.slice().sort(function (a, b) {
        const sa = a && a.roleIntent ? a.roleIntent.score : 0;
        const sb = b && b.roleIntent ? b.roleIntent.score : 0;
        if (sb !== sa) return sb - sa;
        const ra = a && typeof a.rankScore === "number" ? a.rankScore : 0;
        const rb = b && typeof b.rankScore === "number" ? b.rankScore : 0;
        if (rb !== ra) return rb - ra;
        return (Date.parse(b.postedAt || "") || 0) - (Date.parse(a.postedAt || "") || 0);
      });
    }
    if (sort === "relevance") {
      // Phase 1.8: use the comprehensive rankScore (fit + relevance +
      // location proximity + recency + sourceConfidence) as primary
      // signal. BM25 keyword density is a tiebreaker for jobs whose
      // overall rank is the same. Previously this sort ONLY used BM25
      // which ignored location proximity entirely — so a perfect Cape
      // Town SE job could rank below a Brazilian remote SE job that
      // mentioned "engineer" five times in its description.
      var tokens = relevanceTokensFromParams(params);
      return jobs.slice().sort(function (a, b) {
        var ra = a && typeof a.rankScore === "number" ? a.rankScore : 0;
        var rb = b && typeof b.rankScore === "number" ? b.rankScore : 0;
        if (rb !== ra) return rb - ra;
        // Tiebreaker 1: BM25 keyword density (when tokens exist).
        if (tokens.length) {
          var bma = jobTextRelevanceScore(a, tokens, jobs);
          var bmb = jobTextRelevanceScore(b, tokens, jobs);
          if (bmb !== bma) return bmb - bma;
        }
        // Tiebreaker 2: recency.
        return (Date.parse(b.postedAt || "") || 0) - (Date.parse(a.postedAt || "") || 0);
      });
    }
    if (sort === "oldest") {
      return jobs.slice().sort(function (a, b) {
        return (a.postedAt || "").localeCompare(b.postedAt || "");
      });
    }
    // "newest" — sort by date, but use rankScore as tiebreaker when
    // jobs are posted on the same day. Otherwise the user's location
    // intent gets totally ignored for date-sorted views.
    return jobs.slice().sort(function (a, b) {
      var dateCmp = (b.postedAt || "").localeCompare(a.postedAt || "");
      if (dateCmp !== 0) return dateCmp;
      var ra = a && typeof a.rankScore === "number" ? a.rankScore : 0;
      var rb = b && typeof b.rankScore === "number" ? b.rankScore : 0;
      return rb - ra;
    });
  }

  function chooseProviders(requested) {
    const all = (window.CBJobs.providers || []).slice().sort(function (a, b) {
      return a.priority - b.priority;
    });
    if (!requested || !requested.length) return all;
    return all.filter(function (p) {
      return requested.indexOf(p.id) >= 0;
    });
  }

  function canonicalizeJob(job, providerMeta) {
    const src = job && typeof job === "object" ? job : {};
    const p = providerMeta && typeof providerMeta === "object" ? providerMeta : {};
    const inferredSource = inferSourceFromUrl(src.url);
    const source = cleanSourceLabel(inferredSource || src.source || p.label || p.id || "unknown");
    let sourceId = src.sourceId || (inferredSource ? slugSourceLabel(inferredSource) : p.id) || "unknown";
    if (
      inferredSource &&
      source !== "LinkedIn" &&
      (/linkedin/i.test(String(sourceId)) || /linkedin/i.test(String(src.source || p.label || p.id || "")))
    ) {
      sourceId = slugSourceLabel(inferredSource);
    }
    if (
      inferredSource &&
      source !== "Indeed" &&
      (/indeed/i.test(String(sourceId)) || /indeed/i.test(String(src.source || p.label || p.id || "")))
    ) {
      sourceId = slugSourceLabel(inferredSource);
    }
    const sourceKey = source.toLowerCase();
    const sourceSlug = slugSourceLabel(source);
    const tags = Array.isArray(src.tags)
      ? src.tags
          .map(function (t) { return String(t || "").trim(); })
          .filter(Boolean)
          .filter(function (t) {
            const k = t.toLowerCase();
            if (k.indexOf("rapidapi") >= 0) return false;
            if (k === sourceKey || k === sourceSlug) return false;
            if (k === "linkedin" || k === "indeed" || k === "adzuna") return false;
            return true;
          })
          .slice(0, 10)
      : [];
    return {
      id: src.id || "",
      source: source,
      sourceId: sourceId,
      sourceType: src.sourceType || p.sourceType || "api",
      title: src.title || "",
      company: src.company || "",
      companyLogo: src.companyLogo || "",
      location: src.location || "",
      remote: !!src.remote,
      employmentType: src.employmentType || "",
      salary: src.salary || "",
      postedAt: src.postedAt || "",
      url: src.url || "",
      providerSource: src.providerSource || "",
      finalUrl: src.finalUrl || "",
      finalSource: src.finalSource || "",
      tags: tags,
      descriptionText: String(src.descriptionText || "").slice(0, 24000),
      sourceTrust: buildSourceTrust(src, p, inferredSource, source)
    };
  }

  function isValidCanonicalJob(job) {
    if (!job || typeof job !== "object") return false;
    if (!job.title || !job.company) return false;
    if (!job.url && !job.descriptionText) return false;
    return true;
  }

  function canonicalValidationError(job) {
    if (!job || typeof job !== "object") return "not_object";
    if (!job.title) return "missing_title";
    if (!job.company) return "missing_company";
    if (!job.sourceId) return "missing_source_id";
    if (!job.sourceType) return "missing_source_type";
    if (!job.url && !job.descriptionText) return "missing_url_and_description";
    return "";
  }

  function normalizeConstraintArray(v, max) {
    return (Array.isArray(v) ? v : [])
      .map(function (x) { return String(x || "").trim(); })
      .filter(Boolean)
      .slice(0, max || 24);
  }

  function normalizeCandidateConstraints(params) {
    params = params || {};
    const rp = (params.roleProfile && typeof params.roleProfile === "object" && params.roleProfile) ||
      (params.candidateProfile && typeof params.candidateProfile === "object" && params.candidateProfile) ||
      {};
    return Object.assign({}, rp, {
      targetTitles: normalizeConstraintArray(rp.targetTitles, 16),
      mustHaveSkills: normalizeConstraintArray(rp.mustHaveSkills, 24),
      excludeKeywords: normalizeConstraintArray(rp.excludeKeywords, 24),
      seniority: String(rp.seniority || "any").toLowerCase().trim() || "any",
      strictMode: !!rp.strictMode
    });
  }

  function boundedScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function sourceConfidenceScore(job) {
    const type = String((job && job.sourceType) || "api").toLowerCase();
    const trust = job && job.sourceTrust && typeof job.sourceTrust === "object" ? job.sourceTrust : null;
    if (trust && trust.warning) return 70;
    if (trust && trust.urlVerified && type === "api") return 95;
    if (trust && trust.urlVerified && type === "xray") return 75;
    if (type === "api") return 90;
    if (type === "xray") return 65;
    if (type === "import") return 55;
    return 50;
  }

  function recencyScore(job) {
    const norm = window.CBJobs.normalize;
    const ds = norm && typeof norm.daysSince === "function" ? norm.daysSince(job && job.postedAt) : 999;
    if (ds <= 1) return 100;
    if (ds <= 3) return 90;
    if (ds <= 7) return 75;
    if (ds <= 14) return 60;
    if (ds <= 30) return 40;
    return 20;
  }

  // Phase 1.8: location proximity scoring. When the user typed a city,
  // we want city-matched jobs at the top, then region-matched, then
  // remote, then the rest. Previously remote jobs from Jobicy could
  // outrank a perfect Cape Town match because the only signals were
  // title relevance + recency + intent score.
  //
  // Returns 0-100:
  //   100 = job location includes the user's typed city/text exactly
  //    70 = job location matches the searchRegion (e.g. "africa")
  //    55 = remote job (assumed location-independent — user can take it
  //         from any city; still ranks above truly distant on-site)
  //    20 = job has a location but it doesn't match user's intent
  //    50 = no location filter set (neutral, doesn't push rank either way)
  function locationProximityScore(job, params) {
    const wanted = String((params && params.location) || "").trim();
    if (!wanted) return 50; // user didn't type a location — neutral

    const norm = window.CBNorm || {};
    const normalize = typeof norm.normalize === "function"
      ? norm.normalize
      : function (s) { return String(s || "").toLowerCase().trim(); };

    const wantedNorm = normalize(wanted);
    const remoteWanted = /(^|\s)(remote|anywhere|work from home|wfh)($|\s)/.test(wantedNorm);
    const locNorm = normalize(job.location || "");
    const text = normalize([
      job.location, (job.tags || []).join(" "),
      String(job.descriptionText || "").slice(0, 400)
    ].join(" "));

    // User explicitly wants remote: remote jobs are best.
    if (remoteWanted) {
      if (job.remote || /remote|anywhere|wfh/i.test(job.location || "")) return 100;
      return 30;
    }

    // Direct city match in job.location (Adzuna-style structured field).
    if (locNorm && locNorm.indexOf(wantedNorm) >= 0) return 100;

    // City-shortcut country match (e.g. user typed "south africa" and
    // job is in Cape Town/Johannesburg).
    if (/south africa|\bsa\b|\bza\b/.test(wantedNorm) &&
        /\b(za|south africa|gauteng|pretoria|centurion|johannesburg|cape town|durban)\b/.test(text)) return 95;
    if (/united kingdom|\buk\b/.test(wantedNorm) &&
        /\b(uk|united kingdom|england|london|manchester|edinburgh|bristol|leeds)\b/.test(text)) return 95;
    if (/united states|\busa\b|\bus\b/.test(wantedNorm) &&
        /\b(us|usa|united states|new york|california|texas|seattle|boston|chicago)\b/.test(text)) return 95;

    // Token match in description (e.g. job description mentions Cape Town).
    if (text.indexOf(wantedNorm) >= 0) return 80;

    // Region match (searchRegion === "africa" and job text has region terms).
    const region = String((params && params.searchRegion) || "").toLowerCase();
    if (region && region !== "global") {
      const REGIONS = (window.CBJobs && window.CBJobs.REGION_TERMS) || {};
      const terms = REGIONS[region] || [];
      if (terms.some(function (t) { return text.indexOf(t) >= 0; })) return 70;
    }

    // Remote job, no city match: still relevant (user could take it).
    if (job.remote) return 55;

    // Truly elsewhere — give it a tiny score so it ranks at the bottom
    // but isn't filtered out entirely.
    return 20;
  }

  function scoreJob(job, params) {
    const tokens = relevanceTokensFromParams(params);
    const relevance = boundedScore(jobTextRelevanceScore(job, tokens) * 4);
    const fit = boundedScore(job && job.roleIntent && typeof job.roleIntent.score === "number" ? job.roleIntent.score : 50);
    const recency = recencyScore(job);
    const sourceConfidence = sourceConfidenceScore(job);
    const locationProximity = locationProximityScore(job, params);
    // Rebalanced weights: locationProximity gets meaningful weight (0.30)
    // because when a user types a city they really want city-matched
    // jobs near the top. Fit + relevance still drive the majority.
    // Old: fit 0.4 + relevance 0.3 + recency 0.2 + sourceConfidence 0.1
    // New: fit 0.30 + relevance 0.25 + locationProximity 0.30 + recency 0.10 + sourceConfidence 0.05
    const total = boundedScore(
      fit * 0.30 +
      relevance * 0.25 +
      locationProximity * 0.30 +
      recency * 0.10 +
      sourceConfidence * 0.05
    );
    job.rankScore = total;
    job.rankBreakdown = {
      fit: fit,
      relevance: relevance,
      locationProximity: locationProximity,
      recency: recency,
      sourceConfidence: sourceConfidence
    };
    return total;
  }

  window.CBJobs.search = function (params) {
    params = Object.assign({}, params || {});
    params.roleProfile = normalizeCandidateConstraints(params);
    try {
      const cfg = window.CBV2 && window.CBV2.config;
      if (cfg && typeof cfg.isForceClientJobSearch === "function" && cfg.isForceClientJobSearch()) {
        params.forceClientProviders = true;
      }
    } catch (e) { /* ignore */ }
    const key = cacheKey(params);
    const pathInfo = describeSearchPath(params);
    const cached = getFromCache(key);
    if (cached && !params.bypassCache) {
      const now = Date.now();
      const gen = typeof cached.generatedAt === "number" ? cached.generatedAt : now;
      const prevDiag = cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {};
      const out = Object.assign({}, cached);
      out.diagnostics = Object.assign({}, prevDiag, {
        searchPath: pathInfo,
        cache: { hit: true, ageMs: Math.max(0, now - gen) },
        clientLatencyMs: 0
      });
      return Promise.resolve(out);
    }

    const searchStarted = Date.now();
    const providers = narrowProvidersForCloudPrimary(chooseProviders(params.sources), params);
    const liveProviders = providers.slice();

    const runLive = Promise.all(
      liveProviders.map(function (p) {
        const t0 = Date.now();
        return p
          .search({
            query: params.query,
            limit: params.limit || 40,
            sort: params.sort,
            remoteOnly: params.remoteOnly,
            postedWithinDays: params.postedWithinDays,
            location: params.location,
            jobType: params.jobType,
            experienceLevel: params.experienceLevel,
            activeOnly: params.activeOnly,
            searchRegion: params.searchRegion,
            locationStrictness: params.locationStrictness,
            nlq: params.nlq,
            roleProfile: params.roleProfile
          })
          .then(function (res) {
            const latencyMs = Date.now() - t0;
            const rawJobs = res.jobs || [];
            const reasons = {};
            const validJobs = [];
            rawJobs.forEach(function (j) {
              const cj = canonicalizeJob(j, p);
              const reason = canonicalValidationError(cj);
              if (!reason) {
                validJobs.push(cj);
                return;
              }
              reasons[reason] = (reasons[reason] || 0) + 1;
            });
            return {
              id: p.id,
              label: cleanSourceLabel(p.label),
              ok: !!res.ok,
              count: validJobs.length,
              jobs: validJobs,
              error: res.error || null,
              skipped: !!res.skipped,
              latencyMs: latencyMs,
              upstreamSources: res && res.upstreamSources ? res.upstreamSources : null,
              receivedCount: rawJobs.length,
              rejectedInvalid: Math.max(0, rawJobs.length - validJobs.length),
              rejectedReasons: reasons
            };
          })
          .catch(function (err) {
            return {
              id: p.id,
              label: cleanSourceLabel(p.label),
              ok: false,
              count: 0,
              jobs: [],
              error: err.message || "fetch failed",
              skipped: false,
              latencyMs: Date.now() - t0,
              upstreamSources: null,
              receivedCount: 0,
              rejectedInvalid: 0,
              rejectedReasons: {}
            };
          });
      })
    );

    return runLive.then(function (results) {
      const liveJobs = results.reduce(function (acc, r) {
        return r.ok ? acc.concat(r.jobs) : acc;
      }, []);
      let combined = liveJobs;
      const sourceStatus = {};
      results.forEach(function (r) {
        sourceStatus[r.id] = {
          ok: r.ok,
          count: r.count,
          receivedCount: typeof r.receivedCount === "number" ? r.receivedCount : r.count,
          rejectedInvalid: typeof r.rejectedInvalid === "number" ? r.rejectedInvalid : 0,
          rejectedReasons: r.rejectedReasons && typeof r.rejectedReasons === "object" ? r.rejectedReasons : {},
              label: cleanSourceLabel(r.label),
          error: r.error,
          skipped: !!r.skipped,
          latencyMs: typeof r.latencyMs === "number" ? r.latencyMs : null,
          kind: "client",
          sourceType: "api"
        };
        if (r.id === "backend" && Array.isArray(r.upstreamSources)) {
          r.upstreamSources.forEach(function (u) {
            const nm = (u && u.name) || "feed";
            const sid = "upstream:" + slugUpstreamId(nm);
            if (!sourceStatus[sid]) {
              sourceStatus[sid] = {
                ok: !!u.ok,
                count: typeof u.count === "number" ? u.count : 0,
                label: cleanSourceLabel(nm),
                error: u.error || null,
                latencyMs: null,
                kind: "upstream",
                parent: "backend"
              };
            }
          });
        }
        if (r.id === "external-search" && Array.isArray(r.upstreamSources)) {
          r.upstreamSources.forEach(function (u) {
            const nm = (u && u.name) || "feed";
            const sid = "upstream:" + slugUpstreamId(nm);
            if (!sourceStatus[sid]) {
              sourceStatus[sid] = {
                ok: !!u.ok,
                count: typeof u.count === "number" ? u.count : 0,
                label: cleanSourceLabel(nm),
                error: u.error || null,
                latencyMs: null,
                kind: "upstream",
                parent: "external-search"
              };
            }
          });
        }
      });

      // If cloud-primary path returns nothing, auto-fallback once to browser providers
      // so user still gets Adzuna/local feeds without manually toggling settings.
      if (
        cloudJobSearchPrimary(params) &&
        !params.__cloudFallbackTried &&
        combined.length === 0
      ) {
        const retryParams = Object.assign({}, params, {
          forceClientProviders: true,
          bypassCache: true,
          __cloudFallbackTried: true
        });
        return window.CBJobs.search(retryParams).then(function (fallbackRes) {
          if (
            fallbackRes &&
            fallbackRes.diagnostics &&
            typeof fallbackRes.diagnostics === "object"
          ) {
            fallbackRes.diagnostics.phase0 =
              fallbackRes.diagnostics.phase0 && typeof fallbackRes.diagnostics.phase0 === "object"
                ? fallbackRes.diagnostics.phase0
                : {};
            fallbackRes.diagnostics.phase0.fallbackEnabled = true;
            fallbackRes.diagnostics.phase0.fallbackReason = "cloud_empty_results";
            fallbackRes.diagnostics.phase0.fallbackMode = "client_forced_auto";
          }
          return fallbackRes;
        });
      }

      return finalize(combined, sourceStatus);
    });

    function finalize(jobs, sourceStatus) {
      const clientLatencyMs = Date.now() - searchStarted;
      const diagnostics = {
        counts: {
          fetched: jobs.length,
          afterDedupe: 0,
          afterBaseFilters: 0,
          afterIntentFilters: 0,
          droppedInvalid: 0
        },
        searchPath: pathInfo,
        clientLatencyMs: clientLatencyMs,
        cache: { hit: false, ageMs: 0 },
        phase0: {
          fallbackEnabled: false,
          canonicalSchemaVersion: 1
        }
      };
      diagnostics.sourceValidation = {};
      Object.keys(sourceStatus).forEach(function (sid) {
        const s = sourceStatus[sid];
        if (!s || s.kind === "upstream") return;
        diagnostics.sourceValidation[sid] = {
          label: cleanSourceLabel(s.label || sid),
          receivedCount: typeof s.receivedCount === "number" ? s.receivedCount : 0,
          keptCount: typeof s.count === "number" ? s.count : 0,
          rejectedInvalid: typeof s.rejectedInvalid === "number" ? s.rejectedInvalid : 0,
          rejectedReasons: s.rejectedReasons && typeof s.rejectedReasons === "object" ? s.rejectedReasons : {}
        };
      });
      let cleaned = [];
      jobs.forEach(function (j) {
        if (isValidCanonicalJob(j)) cleaned.push(j);
        else diagnostics.counts.droppedInvalid += 1;
      });
      let out = dedupe(cleaned);
      diagnostics.counts.afterDedupe = out.length;
      out = applyFilters(out, params, diagnostics);
      const visibleSourceCounts = {};
      out.forEach(function (j) {
        const label = cleanSourceLabel(j && j.source);
        if (!label || label === "Unknown") return;
        visibleSourceCounts[label] = (visibleSourceCounts[label] || 0) + 1;
      });
      Object.keys(visibleSourceCounts).forEach(function (label) {
        const sid = "results:" + slugSourceLabel(label);
        sourceStatus[sid] = {
          ok: true,
          count: visibleSourceCounts[label],
          label: label,
          error: null,
          skipped: false,
          latencyMs: null,
          kind: "results",
          sourceType: "api"
        };
      });
      var scoreSum = 0;
      out.forEach(function (j) {
        scoreSum += scoreJob(j, params);
      });
      diagnostics.scoring = {
        weighted: { fit: 0.4, relevance: 0.3, recency: 0.2, sourceConfidence: 0.1 },
        avgRankScore: out.length ? Math.round(scoreSum / out.length) : 0
      };
      const sortKey = params.sort === "match" ? "newest" : params.sort || "newest";
      out = sortJobsInMemory(out, sortKey, params);
      const result = {
        jobs: out,
        total: out.length,
        sources: sourceStatus,
        query: params.query || "",
        nlq: params.nlq || null,
        roleProfile: params.roleProfile || null,
        diagnostics: diagnostics,
        generatedAt: Date.now()
      };
      setCache(key, result);
      return result;
    }
  };

  window.CBJobs.sortJobsInMemory = sortJobsInMemory;
  window.CBJobs.relevanceTokensFromParams = relevanceTokensFromParams;
  window.CBJobs.jobTextRelevanceScore = jobTextRelevanceScore;

  window.CBJobs.clearCache = function () {
    cache.clear();
  };
})();
