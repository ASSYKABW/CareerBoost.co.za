(function () {
  window.CBJobs = window.CBJobs || {};
  window.CBJobs.providers = window.CBJobs.providers || [];

  const TIMEOUT_MS = 10000;
  const MAX_RETRIES = 2;
  const BASE_BACKOFF_MS = 450;
  const ADZUNA_REGION_COUNTRIES = {
    global: ["za", "gb", "us", "au", "ca", "de", "nl", "fr", "sg", "in"],
    africa: ["za"],
    europe: ["gb", "de", "fr", "nl", "es", "it"],
    north_america: ["us", "ca"],
    asia_pacific: ["au", "sg", "in"]
  };

  function getAdzunaConfig() {
    const store = window.CBV2 && window.CBV2.store;
    if (!store || typeof store.getApiKeys !== "function") return null;
    const keys = store.getApiKeys() || {};
    const appId = String(keys.adzunaAppId || "").trim();
    const appKey = String(keys.adzunaAppKey || "").trim();
    if (!appId || !appKey) return null;
    return {
      appId: appId,
      appKey: appKey,
      country: String(keys.adzunaCountry || "gb").toLowerCase().trim() || "gb"
    };
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(0, ms || 0));
    });
  }

  function fetchJsonWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(url, Object.assign({}, init || {}, { signal: controller.signal }))
      .then(function (res) {
        clearTimeout(timer);
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (json) {
            if (res.ok) return json;
            const e = new Error(
              (json && (json.error || json.message)) ||
              ("HTTP " + res.status)
            );
            e.status = res.status;
            throw e;
          });
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }

  function fetchAdzunaWithRetry(url) {
    let attempt = 0;
    function run() {
      attempt += 1;
      return fetchJsonWithTimeout(url).catch(function (err) {
        const status = Number(err && err.status);
        const retryable =
          status === 429 ||
          status === 408 ||
          status === 425 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504;
        if (!retryable || attempt > MAX_RETRIES + 1) throw err;
        const wait = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        return sleep(wait).then(run);
      });
    }
    return run();
  }

  function buildAdzunaUrl(params, cfg, country) {
    const u = new URL(
      "https://api.adzuna.com/v1/api/jobs/" +
        encodeURIComponent(country || cfg.country) +
        "/search/1"
    );
    u.searchParams.set("app_id", cfg.appId);
    u.searchParams.set("app_key", cfg.appKey);
    u.searchParams.set("results_per_page", String(Math.max(10, Math.min(50, Number(params.limit) || 40))));
    if (params.query) u.searchParams.set("what", String(params.query).slice(0, 160));
    if (params.remoteOnly) u.searchParams.set("where", "remote");
    else if (params.location) u.searchParams.set("where", String(params.location).slice(0, 100));
    if ((Number(params.postedWithinDays) || 0) > 0) {
      u.searchParams.set("max_days_old", String(Number(params.postedWithinDays)));
    }
    const jt = Array.isArray(params.jobType) ? String(params.jobType[0] || "") : "";
    if (jt === "full_time") u.searchParams.set("full_time", "1");
    if (jt === "part_time") u.searchParams.set("part_time", "1");
    if (jt === "contract") u.searchParams.set("contract", "1");
    return u.toString();
  }

  function regionCountriesForAdzuna(params, cfg) {
    const region = String((params && params.searchRegion) || "global").toLowerCase();
    const list = ADZUNA_REGION_COUNTRIES[region] || ADZUNA_REGION_COUNTRIES.global;
    const base = String((cfg && cfg.country) || "").toLowerCase();
    if (base && list.indexOf(base) < 0) return [base].concat(list).slice(0, 8);
    return list.slice(0, 8);
  }

  function locationMatchScore(job, params) {
    const loc = String((job && job.location) || "").toLowerCase();
    const wanted = String((params && params.location) || "").toLowerCase().trim();
    if (!wanted) return 1;
    if (loc.indexOf(wanted) >= 0) return 3;
    const tokens = wanted.split(/[^a-z0-9]+/).filter(function (x) { return x && x.length > 2; });
    let hits = 0;
    tokens.forEach(function (t) { if (loc.indexOf(t) >= 0) hits += 1; });
    return hits > 0 ? 2 : 0;
  }

  function formatSalary(min, max, country) {
    if (!(min && max)) return "";
    const c = String(country || "").toLowerCase();
    const symbol =
      c === "us" ? "$" :
      c === "gb" ? "£" :
      (c === "de" || c === "fr" || c === "es" || c === "nl" || c === "it") ? "€" :
      "";
    return symbol + Math.round(Number(min) / 1000) + "k-" + symbol + Math.round(Number(max) / 1000) + "k";
  }

  function normalizeAdzunaJob(item, cfg) {
    const norm = window.CBJobs && window.CBJobs.normalize;
    const stripHtml = norm && typeof norm.stripHtml === "function"
      ? norm.stripHtml
      : function (s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); };
    const toDateIso = norm && typeof norm.toDateIso === "function"
      ? norm.toDateIso
      : function (d) { return d ? String(d).slice(0, 10) : ""; };
    const loc = (item && item.location && item.location.display_name) || "";
    const title = (item && item.title) || "";
    const desc = stripHtml((item && item.description) || "");
    const tags = [];
    if (item && item.category && item.category.label) tags.push(String(item.category.label).toLowerCase());
    if (item && item.contract_time) tags.push(String(item.contract_time).toLowerCase());
    if (item && item.contract_type) tags.push(String(item.contract_type).toLowerCase());
    return {
      id: "adzuna_" + String((item && item.id) || ""),
      source: "Adzuna",
      sourceId: "adzuna",
      sourceType: "api",
      title: title,
      company: (item && item.company && item.company.display_name) || "",
      companyLogo: "",
      location: loc,
      remote: /remote|work from home|wfh|anywhere/i.test(loc + " " + title),
      employmentType: String((item && item.contract_time) || "full_time").toLowerCase(),
      salary: formatSalary(item && item.salary_min, item && item.salary_max, cfg.country),
      postedAt: toDateIso(item && item.created),
      url: (item && item.redirect_url) || "",
      tags: tags.slice(0, 8),
      descriptionText: desc.slice(0, 24000)
    };
  }

  function getExternalSearchConfig() {
    const cfg = (window.CB_CONFIG && window.CB_CONFIG.externalSearch) || {};
    return {
      enabled: !!cfg.enabled,
      provider: String(cfg.provider || "").trim()
    };
  }

  function isExternalSearchAllowed() {
    const cfg = getExternalSearchConfig();
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

  function normalizeExternalJob(item) {
    const norm = window.CBJobs && window.CBJobs.normalize;
    const stripHtml = norm && typeof norm.stripHtml === "function"
      ? norm.stripHtml
      : function (s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); };
    const toDateIso = norm && typeof norm.toDateIso === "function"
      ? norm.toDateIso
      : function (d) { return d ? String(d).slice(0, 10) : ""; };
    const sourceLabel = String((item && item.source) || "ExternalSearch");
    return {
      id: String((item && item.id) || ""),
      source: /linkedin/i.test(sourceLabel) ? "LinkedIn" : (/indeed/i.test(sourceLabel) ? "Indeed" : sourceLabel),
      sourceId: String((item && item.sourceId) || "external-search"),
      sourceType: String((item && item.sourceType) || "api"),
      title: String((item && item.title) || ""),
      company: String((item && item.company) || ""),
      companyLogo: String((item && item.logo) || ""),
      location: String((item && item.location) || ""),
      remote: !!(item && item.remote),
      employmentType: String((item && item.employmentType) || "full_time"),
      salary: String((item && item.salary) || ""),
      postedAt: toDateIso(item && item.postedAt),
      url: String((item && item.url) || ""),
      providerSource: String((item && item.providerSource) || ""),
      finalUrl: String((item && item.finalUrl) || ""),
      finalSource: String((item && item.finalSource) || ""),
      sourceTrust: item && item.sourceTrust && typeof item.sourceTrust === "object" ? item.sourceTrust : null,
      tags: Array.isArray(item && item.tags)
        ? item.tags.map(function (t) { return String(t); }).filter(function (t) { return !/rapidapi/i.test(t); }).slice(0, 8)
        : [],
      descriptionText: stripHtml((item && item.descriptionText) || "").slice(0, 24000)
    };
  }

  function runExternalSearch(params) {
    const cfg = getExternalSearchConfig();
    if (!isExternalSearchAllowed()) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        jobs: [],
        error: "External search disabled or backend auth unavailable."
      });
    }
    const auth = window.CBV2.auth;
    const payload = {
      query: (params && params.query) || "",
      filters: {
        remoteOnly: !!(params && params.remoteOnly),
        postedWithinDays: Number((params && params.postedWithinDays) || 0),
        sort: (params && params.sort) || "relevance",
        location: String((params && params.location) || "").trim(),
        jobType: Array.isArray(params && params.jobType) ? params.jobType.slice(0, 8) : [],
        experienceLevel: Array.isArray(params && params.experienceLevel) ? params.experienceLevel.slice(0, 8) : [],
        activeOnly: !params || params.activeOnly !== false,
        searchRegion: String((params && params.searchRegion) || "global"),
        locationStrictness: String((params && params.locationStrictness) || "strict")
      },
      nlq: (params && params.nlq) || null,
      provider: cfg.provider || undefined
    };
    function dedupeByUrl(jobs) {
      const out = [];
      const seen = {};
      (Array.isArray(jobs) ? jobs : []).forEach(function (j) {
        const u = String((j && j.url) || "").trim().toLowerCase();
        if (!u || seen[u]) return;
        seen[u] = true;
        out.push(j);
      });
      return out;
    }

    function shouldFallbackFromProviderError(data) {
      if (!data || data.ok !== true) return false;
      if (!Array.isArray(data.sources) || !data.sources.length) return false;
      return data.sources.some(function (s) {
        const err = String((s && s.error) || "").toLowerCase();
        return err.indexOf("unknown provider") >= 0;
      });
    }

    const client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    if (client && client.functions && typeof client.functions.invoke === "function") {
      function invokeWithClient(bodyPayload) {
        return client.functions.invoke("external-search", { body: bodyPayload })
          .then(function (res) {
            const data = res && res.data;
            const err = res && res.error;
            if (err) throw err;
            return data || {};
          });
      }
      return invokeWithClient(payload)
        .then(function (data) {
          if (cfg.provider === "all" && shouldFallbackFromProviderError(data)) {
            return invokeWithClient(Object.assign({}, payload, { provider: undefined }))
              .then(function (legacy) {
                const jobs = Array.isArray(legacy && legacy.jobs) ? legacy.jobs.map(normalizeExternalJob) : [];
                return {
                  ok: !!(legacy && legacy.ok),
                  jobs: dedupeByUrl(jobs),
                  upstreamSources: Array.isArray(legacy && legacy.sources) ? legacy.sources : []
                };
              });
          }
          if (!data || !data.ok) {
            return { ok: false, jobs: [], error: (data && data.error) || "external-search failed" };
          }
          const jobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeExternalJob) : [];
          return { ok: true, jobs: dedupeByUrl(jobs), upstreamSources: Array.isArray(data.sources) ? data.sources : [] };
        })
        .catch(function (err) {
          return { ok: false, jobs: [], error: (err && err.message) || "external-search invoke failed" };
        });
    }

    const tokenPromise = auth && typeof auth.getAccessToken === "function"
      ? auth.getAccessToken()
      : Promise.resolve("");
    function postExternalSearch(token, bodyPayload) {
      const fnUrl =
        (window.CBV2 && window.CBV2.config && typeof window.CBV2.config.getFunctionsUrl === "function")
          ? window.CBV2.config.getFunctionsUrl()
          : "";
      if (!fnUrl) throw new Error("Functions URL not configured");
      return fetchJsonWithTimeout(String(fnUrl).replace(/\/+$/, "") + "/external-search", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          apikey: window.CBV2.config.getSupabaseAnon(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(bodyPayload)
      });
    }

    return tokenPromise.then(function (token) {
      if (!token) throw new Error("Not signed in");
      return postExternalSearch(token, payload)
        .then(function (data) {
          if (cfg.provider === "all" && shouldFallbackFromProviderError(data)) {
            return postExternalSearch(token, Object.assign({}, payload, { provider: undefined }));
          }
          return data;
        });
    })
      .then(function (data) {
        if (!data || !data.ok) {
          return { ok: false, jobs: [], error: (data && data.error) || "external-search failed" };
        }
        const jobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeExternalJob) : [];
        return { ok: true, jobs: dedupeByUrl(jobs), upstreamSources: Array.isArray(data.sources) ? data.sources : [] };
      })
      .catch(function (err) {
        return { ok: false, jobs: [], error: (err && err.message) || "external-search request failed" };
      });
  }

  function isBackendSearchAllowed() {
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

  function buildBackendSearchPayload(params) {
    return {
      query: (params && params.query) || "",
      filters: {
        remoteOnly: !!(params && params.remoteOnly),
        postedWithinDays: Number((params && params.postedWithinDays) || 0),
        sort: (params && params.sort) || "relevance",
        location: String((params && params.location) || "").trim(),
        jobType: Array.isArray(params && params.jobType) ? params.jobType.slice(0, 8) : [],
        experienceLevel: Array.isArray(params && params.experienceLevel) ? params.experienceLevel.slice(0, 8) : [],
        activeOnly: !params || params.activeOnly !== false,
        searchRegion: String((params && params.searchRegion) || "global"),
        locationStrictness: String((params && params.locationStrictness) || "strict")
      },
      nlq: (params && params.nlq) || null
    };
  }

  function runBackendSearch(params) {
    if (!isBackendSearchAllowed()) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        jobs: [],
        error: "CareerBoost Cloud search requires a signed-in backend session."
      });
    }
    const auth = window.CBV2.auth;
    const payload = buildBackendSearchPayload(params || {});
    const client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    if (client && client.functions && typeof client.functions.invoke === "function") {
      return client.functions.invoke("jobs-search", { body: payload })
        .then(function (res) {
          const data = res && res.data;
          const err = res && res.error;
          if (err) throw err;
          if (!data || !data.ok) {
            return { ok: false, jobs: [], error: (data && data.error) || "jobs-search failed" };
          }
          const jobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeExternalJob) : [];
          return {
            ok: true,
            jobs: jobs,
            upstreamSources: Array.isArray(data.sources) ? data.sources : []
          };
        })
        .catch(function (err) {
          return { ok: false, jobs: [], error: (err && err.message) || "jobs-search invoke failed" };
        });
    }

    const tokenPromise = auth && typeof auth.getAccessToken === "function"
      ? auth.getAccessToken()
      : Promise.resolve("");
    return tokenPromise.then(function (token) {
      if (!token) throw new Error("Not signed in");
      const fnUrl =
        (window.CBV2 && window.CBV2.config && typeof window.CBV2.config.getFunctionsUrl === "function")
          ? window.CBV2.config.getFunctionsUrl()
          : "";
      if (!fnUrl) throw new Error("Functions URL not configured");
      return fetchJsonWithTimeout(String(fnUrl).replace(/\/+$/, "") + "/jobs-search", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          apikey: window.CBV2.config.getSupabaseAnon(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
    })
      .then(function (data) {
        if (!data || !data.ok) {
          return { ok: false, jobs: [], error: (data && data.error) || "jobs-search failed" };
        }
        const jobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeExternalJob) : [];
        return {
          ok: true,
          jobs: jobs,
          upstreamSources: Array.isArray(data.sources) ? data.sources : []
        };
      })
      .catch(function (err) {
        return { ok: false, jobs: [], error: (err && err.message) || "jobs-search request failed" };
      });
  }

  window.CBJobs.providers.push({
    id: "backend",
    label: "CareerBoost Cloud",
    sourceType: "api",
    priority: 1,
    search: function (params) {
      return runBackendSearch(params || {});
    }
  });

  window.CBJobs.providers.push({
    id: "adzuna",
    label: "Adzuna",
    sourceType: "api",
    priority: 5,
    search: function (params) {
      const cfg = getAdzunaConfig();
      if (!cfg) {
        return Promise.resolve({
          ok: false,
          skipped: true,
          jobs: [],
          error: "Adzuna API keys are missing. Add them in Settings."
        });
      }
      const p = params || {};
      const countries = regionCountriesForAdzuna(p, cfg);
      return Promise.all(countries.map(function (country) {
        const url = buildAdzunaUrl(p, cfg, country);
        return fetchAdzunaWithRetry(url)
          .then(function (data) {
            const raw = Array.isArray(data && data.results) ? data.results : [];
            return {
              ok: true,
              country: country,
              jobs: raw.map(function (item) {
                const j = normalizeAdzunaJob(item, Object.assign({}, cfg, { country: country }));
                if (j && j.tags && j.tags.indexOf("country:" + country) < 0) j.tags.push("country:" + country);
                return j;
              })
            };
          })
          .catch(function (err) {
            return { ok: false, country: country, jobs: [], error: (err && err.message) || "fetch failed" };
          });
      })).then(function (parts) {
        const jobs = [];
        const sourceMeta = [];
        parts.forEach(function (part) {
          sourceMeta.push({
            name: "Adzuna-" + part.country,
            count: Array.isArray(part.jobs) ? part.jobs.length : 0,
            ok: !!part.ok,
            error: part.error || null
          });
          if (part.ok && Array.isArray(part.jobs)) {
            part.jobs.forEach(function (j) { jobs.push(j); });
          }
        });
        jobs.sort(function (a, b) {
          const sa = locationMatchScore(a, p);
          const sb = locationMatchScore(b, p);
          if (sb !== sa) return sb - sa;
          return (Date.parse(b.postedAt || "") || 0) - (Date.parse(a.postedAt || "") || 0);
        });
        const anyOk = parts.some(function (x) { return x.ok; });
        return {
          ok: anyOk,
          jobs: jobs.slice(0, Math.max(20, Number(p.limit) || 40)),
          upstreamSources: sourceMeta
        };
      }).catch(function (err) {
        const msg = (err && err.message) || "Adzuna multi-country fetch failed";
        return { ok: false, jobs: [], error: msg };
      });
    }
  });

  window.CBJobs.providers.push({
    id: "external-search",
    label: "External Search",
    sourceType: "api",
    priority: 8,
    search: function (params) {
      return runExternalSearch(params || {});
    }
  });

  // Phase 2: companies-search provider — direct-from-company ATS feeds
  // (Greenhouse, Lever). Highest-quality job source because the data
  // comes straight from the employer with no aggregator delay or
  // truncation. Backed by the tracked_companies table managed by admin.
  function runCompaniesSearch(params) {
    if (!isBackendSearchAllowed()) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        jobs: [],
        error: "Companies search requires a signed-in backend session."
      });
    }
    const auth = window.CBV2.auth;
    const payload = buildBackendSearchPayload(params || {});
    const client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    if (client && client.functions && typeof client.functions.invoke === "function") {
      return client.functions.invoke("companies-search", { body: payload })
        .then(function (res) {
          const data = res && res.data;
          const err = res && res.error;
          if (err) throw err;
          if (!data || !data.ok) {
            return { ok: false, jobs: [], error: (data && data.error) || "companies-search failed" };
          }
          const jobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeExternalJob) : [];
          return {
            ok: true,
            jobs: jobs,
            upstreamSources: Array.isArray(data.sources) ? data.sources : [],
            meta: data.meta || {}
          };
        })
        .catch(function (err) {
          return { ok: false, jobs: [], error: (err && err.message) || "companies-search invoke failed" };
        });
    }
    return Promise.resolve({ ok: false, jobs: [], error: "Supabase client unavailable." });
  }

  window.CBJobs.providers.push({
    id: "companies-search",
    label: "Direct from Companies",
    sourceType: "api",
    priority: 2, // higher priority than aggregators — these are first-party listings
    search: function (params) {
      return runCompaniesSearch(params || {});
    }
  });
})();
