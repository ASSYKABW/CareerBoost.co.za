// Job Search — Phase 4: LinkedIn via Google discovery lane; NLQ + diagnostics.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};
  const shared = window.CBV2.jobSearchShared || {};
  const JOB_SEARCH_MEMORY_KEY = "cb.v2.jobSearch.lastResults";
  const JOB_SEARCH_LOCAL_KEY = "cbv2_job_search_results_v1:local";

  /** Last successful search snapshot (in-memory; survives in-SPA navigation). */
  var lastSearchView = {
    jobs: [],
    query: "",
    at: 0,
    total: 0,
    roleProfile: null,
    sort: "newest",
    diagnostics: null,
    sources: null,
    nlq: null
  };
  var lastSearchViewOwner = "";

  function currentStoreOwner() {
    const store = window.CBV2 && window.CBV2.store;
    return store && store.isRemote ? "remote" : "local";
  }

  function compactJobSearchJob(job) {
    job = job || {};
    const copy = {};
    Object.keys(job).forEach(function (key) {
      const value = job[key];
      if (typeof value === "function") return;
      if (key === "descriptionText" || key === "description") {
        const text = String(value || "");
        copy[key] = text.length > 18000 ? text.slice(0, 18000).trimEnd() : text;
        return;
      }
      if (key === "raw" || key === "payload" || key === "html") return;
      copy[key] = value;
    });
    return copy;
  }

  function normalizeSearchSnapshot(saved) {
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.jobs)) return null;
    const jobs = saved.jobs.slice(0, 120).map(compactJobSearchJob);
    return {
      jobs: jobs,
      query: saved.query || "",
      at: Number(saved.at || 0),
      total: Number(saved.total || jobs.length || 0),
      roleProfile: saved.roleProfile || null,
      sort: saved.sort || "newest",
      diagnostics: saved.diagnostics || null,
      sources: saved.sources || null,
      nlq: saved.nlq || null,
      filters: saved.filters && typeof saved.filters === "object" ? saved.filters : null
    };
  }

  function currentSearchSnapshot() {
    const store = window.CBV2 && window.CBV2.store;
    const js = store && typeof store.getJobSearchState === "function" ? store.getJobSearchState() || {} : {};
    return normalizeSearchSnapshot(Object.assign({}, lastSearchView, {
      jobs: (lastSearchView.jobs || []).slice(0, 120),
      filters: js.lastFilters || null
    }));
  }

  function persistLastSearchView() {
    try {
      const snapshot = currentSearchSnapshot();
      lastSearchViewOwner = currentStoreOwner();
      const store = window.CBV2 && window.CBV2.store;
      if (store && typeof store.setLastJobSearchResults === "function") {
        store.setLastJobSearchResults(snapshot);
      } else if (window.localStorage) {
        window.localStorage.setItem(JOB_SEARCH_LOCAL_KEY, JSON.stringify(snapshot));
      }
      if (window.sessionStorage) {
        window.sessionStorage.setItem(JOB_SEARCH_MEMORY_KEY, JSON.stringify(snapshot));
      }
    } catch (err) {
      // Search memory is a convenience repair cache; ignore storage failures.
    }
  }

  function readPersistedSearchView() {
    try {
      const store = window.CBV2 && window.CBV2.store;
      if (store && typeof store.getLastJobSearchResults === "function") {
        const fromStore = normalizeSearchSnapshot(store.getLastJobSearchResults());
        if (fromStore && fromStore.jobs.length) return fromStore;
      }
      if (window.localStorage) {
        const localRaw = window.localStorage.getItem(JOB_SEARCH_LOCAL_KEY);
        const local = localRaw ? normalizeSearchSnapshot(JSON.parse(localRaw)) : null;
        if (local && local.jobs.length) return local;
      }
      if (!window.sessionStorage) return null;
      const raw = window.sessionStorage.getItem(JOB_SEARCH_MEMORY_KEY);
      return raw ? normalizeSearchSnapshot(JSON.parse(raw)) : null;
    } catch (err) {
      return null;
    }
  }

  function applyRestoredSearchView(saved, force) {
    if (!saved || !Array.isArray(saved.jobs)) return false;
    if (!force && lastSearchView.at && saved.at && saved.at <= lastSearchView.at) return false;
    lastSearchView = Object.assign({}, lastSearchView, {
      jobs: saved.jobs,
      query: saved.query || "",
      at: Number(saved.at || 0),
      total: Number(saved.total || saved.jobs.length || 0),
      roleProfile: saved.roleProfile || null,
      sort: saved.sort || "newest",
      filters: saved.filters && typeof saved.filters === "object" ? saved.filters : null,
      diagnostics: saved.diagnostics || null,
      sources: saved.sources || null,
      nlq: saved.nlq || null
    });
    lastSearchViewOwner = currentStoreOwner();
    return true;
  }

  function restoreLastSearchView() {
    try {
      const saved = readPersistedSearchView();
      if (!saved) return;
      applyRestoredSearchView(saved, lastSearchViewOwner && lastSearchViewOwner !== currentStoreOwner());
      if (saved.filters && window.CBV2 && window.CBV2.store && typeof window.CBV2.store.setJobSearchState === "function") {
        window.CBV2.store.setJobSearchState({
          lastQuery: saved.query || "",
          lastFilters: saved.filters
        });
      }
    } catch (err) {
      // Bad cache data should never break the Job Search route.
    }
  }

  function clearPersistedLastSearchView() {
    try {
      const store = window.CBV2 && window.CBV2.store;
      if (store && typeof store.clearLastJobSearchResults === "function") {
        store.clearLastJobSearchResults();
      }
      if (window.localStorage) window.localStorage.removeItem(JOB_SEARCH_LOCAL_KEY);
      if (window.sessionStorage) window.sessionStorage.removeItem(JOB_SEARCH_MEMORY_KEY);
      lastSearchViewOwner = currentStoreOwner();
    } catch (err) {
      // ignore
    }
  }

  function getUrlKeyFn() {
    const H = window.CBV2 && window.CBV2.jobListingUrlHelpers;
    if (H && typeof H.urlKeyForDedup === "function") return H.urlKeyForDedup;
    const norm = window.CBJobs && window.CBJobs.normalize;
    if (norm && typeof norm.makeUrlKey === "function") return norm.makeUrlKey;
    return function (url) {
      try {
        const u = new URL(url);
        return (u.host + u.pathname).toLowerCase().replace(/\/+$/, "");
      } catch (err) {
        return String(url || "").toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
      }
    };
  }

  function applicationSourceUrl(app) {
    if (!app) return "";
    if (app.jobUrl) return String(app.jobUrl);
    const notes = String(app.notes || "");
    const helper = window.CBV2 && window.CBV2.jobNotes;
    if (helper && typeof helper.parseImportedNotes === "function") {
      const parsed = helper.parseImportedNotes(notes);
      if (parsed && parsed.source) return parsed.source;
    }
    const m = notes.match(/^Source\s*:\s*(.+)$/mi);
    return m ? m[1].trim() : "";
  }

  function normalizeMatchText(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function findJobForApplication(app) {
    const jobs = lastSearchView.jobs || [];
    if (!app || !jobs.length) return null;
    const urlKey = getUrlKeyFn();
    const sourceUrl = applicationSourceUrl(app);
    const sourceKey = sourceUrl ? urlKey(sourceUrl) : "";
    if (sourceKey) {
      const byUrl = jobs.find(function (job) {
        return job && job.url && urlKey(job.url) === sourceKey;
      });
      if (byUrl) return byUrl;
    }

    const company = normalizeMatchText(app.company);
    const role = normalizeMatchText(app.role);
    if (!company && !role) return null;
    return jobs.find(function (job) {
      return job &&
        normalizeMatchText(job.company) === company &&
        normalizeMatchText(job.title) === role;
    }) || null;
  }

  function publishJobSearchMemory() {
    if ((lastSearchView.jobs || []).length || lastSearchView.at) {
      persistLastSearchView();
    }
    window.CBV2.jobSearchMemory = {
      getLastView: function () {
        return lastSearchView;
      },
      findJobForApplication: findJobForApplication
    };
  }

  // Phase 4.5: don't auto-restore the previous search on page load. Users
  // were finding the form pre-filled and a stale results list every time
  // they refreshed or signed back in — confusing and slow. Now:
  //   - Page refresh / sign-in / new tab → form blank, no results shown
  //   - In-tab navigation away and back → in-memory `lastSearchView`
  //     survives the route swap, so results stay during the same session
  //   - Saved/bookmarked jobs (separate store) are unaffected
  // Purge any stale persisted snapshots so they don't bloat localStorage.
  clearPersistedLastSearchView();
  // Also wipe the persisted lastQuery so the keyword input starts blank.
  try {
    const _store = window.CBV2 && window.CBV2.store;
    if (_store && typeof _store.setJobSearchState === "function") {
      _store.setJobSearchState({ lastQuery: "" });
    }
  } catch (e) { /* ignore */ }
  publishJobSearchMemory();

  function getSt() {
    return window.CBV2.sanitizeText;
  }

  function isSavedTabParams(params) {
    const t = params && params.tab;
    return t === "saved" || t === "alerts";
  }

  function isHistoryTabParams(params) {
    return params && params.tab === "history";
  }

  function isSearchExplainabilityOn() {
    const cfg = window.CBV2 && window.CBV2.config;
    return !(cfg && typeof cfg.isFeatureEnabled === "function") || cfg.isFeatureEnabled("searchExplainability");
  }

  function isSearchStrictConstraintsOn() {
    const cfg = window.CBV2 && window.CBV2.config;
    return !(cfg && typeof cfg.isFeatureEnabled === "function") || cfg.isFeatureEnabled("searchStrictConstraints");
  }

  function formatRunTime(iso) {
    if (typeof shared.formatRunTime === "function") return shared.formatRunTime(iso);
    if (!iso || String(iso).length < 16) return "";
    try {
      return String(iso).slice(11, 16);
    } catch (e) {
      return "";
    }
  }

  function getHistoryRuns() {
    const store = window.CBV2.store;
    if (!store || typeof store.getJobSearchAnalytics !== "function") return [];
    const a = store.getJobSearchAnalytics();
    return Array.isArray(a && a.runs) ? a.runs.slice(0, 48) : [];
  }

  function renderHistoryRunRow(run, st) {
    const q = run && run.query != null ? String(run.query) : "";
    const total = run && typeof run.total === "number" ? String(run.total) : "—";
    const ms = run && typeof run.latencyMs === "number" ? String(run.latencyMs) + " ms" : "—";
    const whenLine =
      run && run.at ? st(formatShortDate(run.at) + " · " + formatRunTime(run.at)) : st("—");
    const base = "#/job-search?rerunq=" + encodeURIComponent(q);
    const hrefRun = base + "&run=1";
    return (
      '<li class="job-search-history-row">' +
      '<div class="job-search-history-row__main">' +
      "<strong>" +
      st(q || "(empty query)") +
      "</strong>" +
      '<p class="job-search-history-row__meta ai-meta">' +
      whenLine +
      "</p>" +
      "</div>" +
      '<div class="job-search-history-row__side">' +
      '<span class="chip subtle">' +
      st(total + " matches · " + ms) +
      "</span>" +
      '<a class="btn-primary btn-sm" href="' +
      hrefRun +
      '"><i class="fa-solid fa-play" aria-hidden="true"></i> Run again</a>' +
      '<a class="btn-secondary btn-sm" href="' +
      base +
      '"><i class="fa-solid fa-folder-open" aria-hidden="true"></i> Load</a>' +
      "</div>" +
      "</li>"
    );
  }

  function renderHistoryWorkspace(st) {
    const runs = getHistoryRuns();
    const head =
      '<div class="resume-section-head job-search-history-head">' +
      '<h2><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> Search history</h2>' +
      '<span class="chip subtle">' +
      st(String(runs.length) + " recent run" + (runs.length === 1 ? "" : "s") + " · newest first in this list") +
      "</span>" +
      "</div>";
    let body = "";
    if (!runs.length) {
      body =
        '<div class="job-search-history-empty muted">' +
        st("No runs logged yet. Complete a search on the Search tab — each run is recorded here for quick reruns.") +
        "</div>";
    } else {
      body =
        '<ul class="job-search-history-list" id="job-search-history-list">' +
        runs
          .map(function (r) {
            return renderHistoryRunRow(r, st);
          })
          .join("") +
        "</ul>";
    }
    return (
      '<div class="job-search-history-workspace" id="job-search-history-root">' +
      '<article class="card panel-lg job-search-history-card">' +
      head +
      body +
      "</article>" +
      "</div>"
    );
  }

  function isCloudJobSearchPrimary() {
    const cfg = window.CBV2 && window.CBV2.config;
    return Boolean(cfg && typeof cfg.isCloudJobSearchPrimary === "function" && cfg.isCloudJobSearchPrimary());
  }

  function isForceClientJobSearch() {
    const cfg = window.CBV2 && window.CBV2.config;
    return Boolean(cfg && typeof cfg.isForceClientJobSearch === "function" && cfg.isForceClientJobSearch());
  }

  function lastRun(js) {
    const runs = js && js.analytics && Array.isArray(js.analytics.runs) ? js.analytics.runs : [];
    return runs[0] || null;
  }

  function formatShortDate(iso) {
    if (typeof shared.formatShortDate === "function") return shared.formatShortDate(iso);
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function ringScoreFromTotal(total) {
    if (typeof shared.ringScoreFromTotal === "function") return shared.ringScoreFromTotal(total);
    if (typeof total !== "number" || total < 0) return 0;
    return Math.min(100, Math.round(20 + Math.min(80, total * 2)));
  }

  function formatPostedLine(iso) {
    const ds = window.CBJobs && window.CBJobs.normalize && window.CBJobs.normalize.daysSince;
    if (typeof ds === "function") {
      const d = ds(iso);
      if (d < 400) {
        if (d === 0) return "Posted today";
        if (d === 1) return "Posted yesterday";
        return "Posted " + d + " days ago";
      }
    }
    if (iso && String(iso).length >= 10) return "Posted " + String(iso).slice(0, 10);
    return "";
  }

  function hasRichRoleProfile(rp) {
    if (!rp || typeof rp !== "object") return false;
    if (Array.isArray(rp.targetTitles) && rp.targetTitles.length) return true;
    if (Array.isArray(rp.mustHaveSkills) && rp.mustHaveSkills.length) return true;
    if (rp.seniority && String(rp.seniority).toLowerCase() !== "any") return true;
    if (Array.isArray(rp.excludeKeywords) && rp.excludeKeywords.length) return true;
    return false;
  }

  /** Preserve API / client sort order while splitting into intent tiers. */
  function groupJobsForDisplay(jobs, roleProfile) {
    const ordered = jobs.slice();
    if (!hasRichRoleProfile(roleProfile)) {
      return [{ id: "all", title: "Results", jobs: ordered }];
    }
    const strong = [];
    const rest = [];
    ordered.forEach(function (j) {
      const hi = j && j.roleIntent && typeof j.roleIntent.score === "number" && j.roleIntent.score >= 66;
      if (hi) strong.push(j);
      else rest.push(j);
    });
    const out = [];
    if (strong.length) out.push({ id: "strong", title: "Strong matches", jobs: strong });
    if (rest.length) {
      out.push({ id: "rest", title: strong.length ? "More to explore" : "Results", jobs: rest });
    }
    return out.length ? out : [{ id: "all", title: "Results", jobs: ordered }];
  }

  function normalizeSortValue(v) {
    if (typeof shared.normalizeSortValue === "function") return shared.normalizeSortValue(v);
    const s = String(v || "newest").toLowerCase();
    if (s === "match") return "newest";
    if (s === "newest" || s === "oldest" || s === "role-fit" || s === "relevance") return s;
    return "newest";
  }

  function sortLabel(sort) {
    if (typeof shared.sortLabel === "function") return shared.sortLabel(sort);
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
    if (typeof shared.fitChipLabel === "function") return shared.fitChipLabel(score);
    if (typeof score !== "number") return { cls: "subtle", text: "Fit n/a" };
    if (score >= 72) return { cls: "green", text: "Strong fit" };
    if (score >= 50) return { cls: "cyan", text: "Aligned" };
    return { cls: "violet", text: "Open fit" };
  }

  function displaySourceLabel(label) {
    if (typeof shared.displaySourceLabel === "function") return shared.displaySourceLabel(label);
    const raw = String(label || "").trim();
    if (/linkedin/i.test(raw)) return "LinkedIn";
    if (/indeed/i.test(raw)) return "Indeed";
    return raw;
  }

  function sourceChipTitle(job) {
    if (typeof shared.sourceChipTitle === "function") return shared.sourceChipTitle(job);
    if (!job || typeof job !== "object") return "Job source";
    const trust = job.sourceTrust && typeof job.sourceTrust === "object" ? job.sourceTrust : null;
    if (trust && trust.warning) return trust.warning;
    if (trust && trust.urlVerified) {
      return "Verified from listing URL" + ((trust.finalUrlHost || trust.urlHost) ? ": " + (trust.finalUrlHost || trust.urlHost) : "") + ".";
    }
    if (job.sourceType === "xray") return "Discovered through a verified provider-page web search.";
    return "Reported by the search provider.";
  }

  function isCountrySourceLabel(label) {
    return /^(uk|us|usa|za|sa|ca|au)$/i.test(String(label || "").trim());
  }

  function effectiveSourceLabel(job) {
    if (!job || typeof job !== "object") return "";
    const raw = displaySourceLabel(job.source || "");
    const trust = job.sourceTrust && typeof job.sourceTrust === "object" ? job.sourceTrust : null;
    const reported = trust && trust.reportedSource ? displaySourceLabel(trust.reportedSource) : "";
    if (isCountrySourceLabel(raw) && reported && !isCountrySourceLabel(reported) && reported !== "Unknown") {
      return reported;
    }
    return raw;
  }

  function sourceWarningText(job) {
    if (!job || !job.sourceTrust || !job.sourceTrust.warning) return "";
    const label = effectiveSourceLabel(job);
    if (isCountrySourceLabel(job.source) && label && !isCountrySourceLabel(label)) return "";
    return job.sourceTrust.warning;
  }

  function snippet(text, max) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1).trim() + "…";
  }

  function isDuplicateInPipeline(job) {
    if (!job) return false;
    const store = window.CBV2.store;
    if (!store || typeof store.getApplications !== "function") return false;
    const apps = store.getApplications();
    const H = window.CBV2.jobListingUrlHelpers;
    const urlKey = H && typeof H.urlKeyForDedup === "function" ? H.urlKeyForDedup : null;
    if (job.url && urlKey) {
      const k = urlKey(job.url);
      if (k) {
        return apps.some(function (a) {
          return a.jobUrl && urlKey(a.jobUrl) === k;
        });
      }
    }
    const c = String(job.company || "").trim().toLowerCase();
    const t = String(job.title || "").trim().toLowerCase();
    if (!c && !t) return false;
    return apps.some(function (a) {
    return (
        String(a.company || "").trim().toLowerCase() === c && String(a.role || "").trim().toLowerCase() === t
      );
    });
  }

  function searchPathLabel(sp) {
    if (!sp || typeof sp !== "object") return "";
    const m = String(sp.mode || "");
    if (m === "cloud_primary") return "CareerBoost Cloud";
    if (m === "client_forced") return "Browser feeds (diagnostic)";
    if (m === "guest_browser") return "Browser feeds (guest)";
    if (m === "signed_in_browser") return "Browser feeds (signed in)";
    if (m === "signed_in_local") return "Local session";
    return m || "—";
  }

  function renderDiagnosticsHtml(st, diag) {
    if (!diag || typeof diag !== "object") return "";
    const c = diag.counts && typeof diag.counts === "object" ? diag.counts : {};
    const path = searchPathLabel(diag.searchPath);
    const lat = typeof diag.clientLatencyMs === "number" ? diag.clientLatencyMs + " ms client" : "";
    const parts = [];
    if (path) parts.push(path);
    if (lat) parts.push(lat);
    if (typeof c.fetched === "number") parts.push(String(c.fetched) + " fetched");
    if (typeof c.afterDedupe === "number") parts.push(String(c.afterDedupe) + " after dedupe");
    if (typeof c.afterBaseFilters === "number") parts.push(String(c.afterBaseFilters) + " after date/remote");
    if (typeof c.afterConstraintFilters === "number") parts.push(String(c.afterConstraintFilters) + " after query/location");
    if (typeof c.afterIntentFilters === "number") parts.push(String(c.afterIntentFilters) + " after intent");
    if (diag.cache && diag.cache.hit) parts.push("cache hit");
    if (diag.phase0 && diag.phase0.fallbackEnabled) parts.push("cloud fallback used");
    if (!parts.length) return "";
      return (
      '<div class="job-search-diag-strip ai-meta" role="status">' +
      '<i class="fa-solid fa-stethoscope" aria-hidden="true"></i> ' +
      st(parts.join(" · ")) +
        "</div>"
    );
  }

  function renderSourceStripHtml(st, sources) {
    if (!sources || typeof sources !== "object") return "";
    const ids = Object.keys(sources);
    if (!ids.length) return "";
    const chips = ids
      .map(function (id) {
        const s = sources[id];
        if (!s) return "";
        const ok = !!s.ok;
        const skipped = !!s.skipped;
        const cls = ok ? "subtle" : (skipped ? "violet" : "warning");
        const label = displaySourceLabel(s.label || id);
        const base = label + ": " + (typeof s.count === "number" ? String(s.count) : "—");
        const ms = typeof s.latencyMs === "number" ? " · " + String(s.latencyMs) + " ms" : "";
        const err = !ok && s.error ? " · " + String(s.error).slice(0, 56) : "";
        const title = s.error ? String(s.error) : base + ms;
        const shown = skipped
          ? (label + ": skipped" + (s.error ? " - " + String(s.error).slice(0, 72) : ""))
          : (base + ms + err);
        return (
          '<span class="chip ' +
          cls +
          '" title="' +
          st(title) +
          '">' +
          st(shown) +
          "</span>"
        );
      })
      .filter(Boolean)
      .join("");
    if (!chips) return "";
    return (
      '<div class="job-search-source-strip ai-meta" role="status">' +
      '<i class="fa-solid fa-sitemap" aria-hidden="true"></i> ' +
      chips +
      "</div>"
    );
  }

  function noResultAdvice() {
    const diag = lastSearchView.diagnostics || {};
    const c = diag.counts || {};
    const sources = lastSearchView.sources || {};
    const sourceIds = Object.keys(sources);
    const failed = sourceIds.filter(function (id) {
      return sources[id] && !sources[id].ok && !sources[id].skipped;
    }).length;
    const skipped = sourceIds.filter(function (id) {
      return sources[id] && sources[id].skipped;
    }).length;
    if (failed || skipped) {
      return "Some sources were unavailable or skipped. Review the source strip, then use LinkedIn/Indeed handoff or paste a listing URL into your pipeline.";
    }
    if (typeof c.afterDedupe === "number" && c.afterDedupe > 0 && c.afterIntentFilters === 0) {
      return "Results were found, but targeting filters removed them. Broaden location, seniority, active status, or strict targeting.";
    }
    if (lastSearchView.at) {
      return "No matching roles came back from the available feeds. Try broader keywords, a wider region, or import a posting from a big board.";
    }
    return "Run a search to scan available feeds. LinkedIn and Indeed are opened as handoff sources, then imported into CareerBoost when you choose a role.";
  }

  // Returns the next-broader strictness tier if the empty result was likely
  // caused by a tight location match, or null when there's nothing to relax.
  // Called from renderNoResultsHtml to decide whether to surface the
  // "Broaden location match" one-click action.
  function suggestedBroadenStrictness() {
    if (!lastSearchView.at) return null;
    const filters = (lastSearchView.filters && typeof lastSearchView.filters === "object")
      ? lastSearchView.filters
      : (window.CBV2.store.getJobSearchState() || {}).lastFilters || {};
    const loc = String((filters && filters.location) || "").trim();
    if (!loc) return null;
    const cur = String((filters && filters.locationStrictness) || "balanced");
    if (cur === "strict")   return "balanced";
    if (cur === "balanced") return "broad";
    return null;
  }

  function renderNoResultsHtml(st) {
    const ran = !!lastSearchView.at;
    const diagHtml = renderDiagnosticsHtml(st, lastSearchView.diagnostics);
    const sourceStripHtml = renderSourceStripHtml(st, lastSearchView.sources);
    const title = ran ? "No roles matched this run" : "Search, handoff, or import";
    const body = noResultAdvice();
    const broadenTo = suggestedBroadenStrictness();
    const broadenLabel = broadenTo === "broad"
      ? "Broaden to any keyword overlap"
      : "Broaden to same area / region";
    const broadenBtn = broadenTo
      ? '<button type="button" class="btn-primary btn-sm" data-action="broaden-strictness" data-target="' + st(broadenTo) + '">' +
        '<i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i> ' + st(broadenLabel) +
        "</button>"
      : "";
    return (
      '<div class="job-search-results-empty">' +
      (diagHtml || "") +
      (sourceStripHtml || "") +
      '<div class="job-search-empty-panel">' +
      '<span class="chip ' + (ran ? "warning" : "cyan") + '">' +
      (ran ? '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Needs broader signal' : '<i class="fa-solid fa-route" aria-hidden="true"></i> Ready') +
      "</span>" +
      "<h3>" + st(title) + "</h3>" +
      "<p>" + st(body) + "</p>" +
      '<div class="job-search-empty-actions">' +
      broadenBtn +
      '<button type="button" class="btn-secondary btn-sm" data-board-search="linkedin"><i class="fa-brands fa-linkedin" aria-hidden="true"></i> Search LinkedIn</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-board-search="indeed"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search Indeed</button>' +
      '<a class="btn-ghost btn-sm" href="#/settings"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Review targeting</a>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  function currentBoardSearchState() {
    const form = document.getElementById("job-search-form");
    const input = document.getElementById("job-search-query");
    const js = window.CBV2.store.getJobSearchState() || {};
    const filters = form ? readFiltersFromForm(form) : js.lastFilters || {};
    return {
      query: input ? String(input.value || "").trim() : String(js.lastQuery || "").trim(),
      location: String((filters && filters.location) || "").trim(),
      remoteOnly: !!(filters && filters.remoteOnly),
      postedWithinDays: Number((filters && filters.postedWithinDays) || 0) || 0
    };
  }

  function bigBoardUrl(board) {
    const state = currentBoardSearchState();
    const q = (state.query || "jobs") + (state.remoteOnly && !/remote/i.test(state.query || "") ? " remote" : "");
    if (board === "indeed") {
      const u = new URL("https://www.indeed.com/jobs");
      u.searchParams.set("q", q);
      if (state.location) u.searchParams.set("l", state.location);
      if (state.postedWithinDays > 0) u.searchParams.set("fromage", String(state.postedWithinDays));
      return u.toString();
    }
    const u = new URL("https://www.linkedin.com/jobs/search/");
    u.searchParams.set("keywords", q);
    if (state.location) u.searchParams.set("location", state.location);
    if (state.remoteOnly) u.searchParams.set("f_WT", "2");
    if (state.postedWithinDays > 0) {
      u.searchParams.set("f_TPR", "r" + String(Math.max(1, state.postedWithinDays) * 86400));
    }
    return u.toString();
  }

  function openBigBoard(board) {
    const url = bigBoardUrl(board);
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      window.location.href = url;
    }
    if (window.CBV2.toast) {
      const name = board === "indeed" ? "Indeed" : "LinkedIn";
      const msg = "Opened " + name + ". Paste the listing URL back here when you find a role.";
      if (typeof window.CBV2.toast.info === "function") window.CBV2.toast.info(msg);
      else window.CBV2.toast.success(msg);
    }
  }

  function renderBigBoardPanel(st) {
    return (
      '<section class="card panel-lg job-search-board-panel" id="job-search-board-panel" aria-label="Big job board workflow">' +
      '<div class="job-search-board-copy">' +
      '<p class="eyebrow">Big Board Workflow</p>' +
      "<h2>Use LinkedIn and Indeed without making the system fragile.</h2>" +
      "<p>" +
      st("CareerBoost opens the right search on the board, then imports the chosen listing into your pipeline so Resume Lab, Cover Letters, Interview Prep, and Analytics can work on it.") +
      "</p>" +
      '<div class="job-search-board-actions">' +
      '<button type="button" class="btn-primary btn-sm" data-board-search="linkedin"><i class="fa-brands fa-linkedin" aria-hidden="true"></i> Search LinkedIn</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-board-search="indeed"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search Indeed</button>' +
      "</div>" +
      "</div>" +
      '<form class="job-search-import-form" id="job-search-import-form" autocomplete="off">' +
      '<label class="job-search-query-label" for="job-search-import-url"><span>Import listing URL</span><span class="job-search-query-wrap"><input id="job-search-import-url" type="url" placeholder="Paste LinkedIn, Indeed, Glassdoor, Greenhouse, Lever..." /></span></label>' +
      '<div class="job-search-import-grid">' +
      '<label class="job-search-query-label" for="job-search-import-company"><span>Company optional</span><span class="job-search-query-wrap"><input id="job-search-import-company" type="text" placeholder="Company name" /></span></label>' +
      '<label class="job-search-query-label" for="job-search-import-role"><span>Role optional</span><span class="job-search-query-wrap"><input id="job-search-import-role" type="text" placeholder="Job title" /></span></label>' +
      "</div>" +
      '<button type="submit" class="btn-secondary btn-sm"><i class="fa-solid fa-link" aria-hidden="true"></i> Import to pipeline</button>' +
      '<p class="ai-meta">No passwords. No automated applications. You choose the role; CareerBoost organizes and prepares the application.</p>' +
      "</form>" +
      "</section>"
    );
  }

  function nlqSummaryLine(nlq) {
    if (!nlq || typeof nlq !== "object") return "";
    const bits = [];
    if (nlq.remote) bits.push("remote");
    if (typeof nlq.seniority === "string" && nlq.seniority && nlq.seniority !== "any") bits.push(nlq.seniority);
    if (typeof nlq.postedWithinDays === "number" && nlq.postedWithinDays > 0) {
      bits.push("≤" + nlq.postedWithinDays + "d");
    }
    if (nlq.location != null && String(nlq.location).trim()) bits.push(String(nlq.location).trim());
    if (Array.isArray(nlq.keywords) && nlq.keywords.length) {
      bits.push(nlq.keywords.slice(0, 6).join(", "));
    }
    return bits.length ? bits.join(" · ") : "";
  }

  function fetchQueryParseNlq(query) {
    const q = String(query || "").trim();
    if (!q) return Promise.resolve(null);
    const ai = window.CBAI;
    if (!ai || typeof ai.runSkill !== "function") return Promise.resolve(null);
    return ai
      .runSkill("query-parse", { text: q })
      .then(function (env) {
        return env && env.data && typeof env.data === "object" ? env.data : null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Phase 4 — user-assisted discovery only (not ingested by CBJobs.search). */
  function wrapXrayTerm(raw) {
    const t = String(raw || "").trim();
    if (!t) return "";
    if (/[\s"]/.test(t)) return '"' + t.replace(/"/g, '\\"') + '"';
    return t;
  }

  function uniqueLowerStrings(arr, max) {
    const out = [];
    const seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (x) {
      const s = String(x || "").trim();
      if (!s) return;
      const k = s.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(s);
    });
    return out.slice(0, max || 24);
  }

  function collectLinkedInDiscoveryState() {
    const form = document.getElementById("job-search-form");
    const input = document.getElementById("job-search-query");
    const js = window.CBV2.store.getJobSearchState() || {};
    const rp = js.roleProfile && typeof js.roleProfile === "object" ? js.roleProfile : {};
    const filters = form ? readFiltersFromForm(form) : js.lastFilters || {};
    return {
      query: input ? String(input.value || "").trim() : String(js.lastQuery || "").trim(),
      remoteOnly: !!(filters && filters.remoteOnly),
      postedWithinDays: Number((filters && filters.postedWithinDays) || 0) || 0,
      targetTitles: uniqueLowerStrings(rp.targetTitles, 6),
      mustHaveSkills: uniqueLowerStrings(rp.mustHaveSkills, 8),
      excludeKeywords: uniqueLowerStrings(rp.excludeKeywords, 10),
      seniority: String(rp.seniority || "any").toLowerCase().trim() || "any"
    };
  }

  function seniorityXrayFragment(sen) {
    const s = String(sen || "any").toLowerCase();
    if (s === "junior") return "(junior OR jr OR entry OR graduate)";
    if (s === "mid") return "(mid OR intermediate)";
    if (s === "senior") return "(senior OR sr OR snr)";
    if (s === "lead") return "(lead OR principal OR staff)";
    return "";
  }

  function buildLinkedInGoogleXrayQuery(state) {
    state = state || {};
    const parts = [];
    parts.push("site:linkedin.com/jobs/view");

    const titleTerms = [];
    if (state.query) titleTerms.push(wrapXrayTerm(state.query));
    (state.targetTitles || []).forEach(function (t) {
      const w = wrapXrayTerm(t);
      if (w && titleTerms.indexOf(w) < 0) titleTerms.push(w);
    });
    if (titleTerms.length) {
      parts.push("(" + titleTerms.join(" OR ") + ")");
    }

    parts.push("(job OR jobs OR career OR hiring)");

    if (state.remoteOnly) {
      parts.push("(remote OR \"work from home\" OR wfh)");
    }

    const senFrag = seniorityXrayFragment(state.seniority);
    if (senFrag) parts.push(senFrag);

    (state.mustHaveSkills || []).forEach(function (sk) {
      const w = wrapXrayTerm(sk);
      if (w) parts.push(w);
    });

    (state.excludeKeywords || []).forEach(function (ex) {
      const t = String(ex || "").trim();
      if (!t) return;
      parts.push("-" + wrapXrayTerm(t));
    });

    if ((Number(state.postedWithinDays) || 0) > 0) {
      parts.push("(\"past week\" OR \"last 7 days\" OR \"this week\")");
    }

    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function refreshLinkedInDiscoveryPreview() {
    const ta = document.getElementById("job-search-xray-preview");
    if (!ta) return;
    const q = buildLinkedInGoogleXrayQuery(collectLinkedInDiscoveryState());
    ta.value = q || 'site:linkedin.com/jobs/view (job OR jobs OR career OR hiring)';
  }

  function openLinkedInGoogleSearch(silentToast) {
    const ta = document.getElementById("job-search-xray-preview");
    const text = ta && ta.value ? String(ta.value).trim() : buildLinkedInGoogleXrayQuery(collectLinkedInDiscoveryState());
    const url = "https://www.google.com/search?q=" + encodeURIComponent(text || "site:linkedin.com/jobs/view");
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      window.location.href = url;
    }
    if (!silentToast && window.CBV2.toast) {
      const msg = "Opened Google in a new tab. Results stay on Google/LinkedIn — not imported automatically.";
      if (typeof window.CBV2.toast.info === "function") window.CBV2.toast.info(msg);
      else window.CBV2.toast.success(msg);
    }
  }

  function copyLinkedInDiscoveryQuery() {
    const ta = document.getElementById("job-search-xray-preview");
    const text = ta && ta.value ? String(ta.value) : "";
    if (!text.trim()) {
      if (window.CBV2.toast) window.CBV2.toast.error("Nothing to copy.");
      return;
    }
    function done(ok) {
      if (window.CBV2.toast) {
        if (ok) window.CBV2.toast.success("Query copied to clipboard.");
        else window.CBV2.toast.error("Could not copy. Select the text and copy manually.");
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
      return;
    }
    try {
      ta.focus();
      ta.select();
      done(document.execCommand("copy"));
    } catch (e) {
      done(false);
    }
  }

  function bindLinkedInDiscoveryLane() {
    const root = document.getElementById("job-search-discovery-lane");
    if (!root || root.getAttribute("data-bound") === "1") return;
    root.setAttribute("data-bound", "1");
    const form = document.getElementById("job-search-form");
    const refreshBtn = document.getElementById("job-search-xray-refresh");
    const copyBtn = document.getElementById("job-search-xray-copy");
    const googleBtn = document.getElementById("job-search-xray-google");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refreshLinkedInDiscoveryPreview(); });
    if (copyBtn) copyBtn.addEventListener("click", function () { copyLinkedInDiscoveryQuery(); });
    if (googleBtn) googleBtn.addEventListener("click", function () { openLinkedInGoogleSearch(false); });
    if (form) {
      form.addEventListener("input", function (ev) {
        if (ev.target && ev.target.id === "job-search-query") refreshLinkedInDiscoveryPreview();
      });
    }
    refreshLinkedInDiscoveryPreview();
  }

  function escapeCsvCell(val) {
    const s = String(val == null ? "" : val);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadResultsCsv() {
    const jobs = lastSearchView.jobs || [];
    if (!jobs.length) return;
    const headers = ["title", "company", "location", "remote", "source", "postedAt", "url", "roleFitScore"];
    const lines = [headers.join(",")];
    jobs.forEach(function (j) {
      const score = j && j.roleIntent && typeof j.roleIntent.score === "number" ? j.roleIntent.score : "";
      const row = [
        j.title,
        j.company,
        j.location,
        j.remote ? "yes" : "no",
        j.source,
        j.postedAt,
        j.url,
        score
      ].map(escapeCsvCell);
      lines.push(row.join(","));
    });
    const csv = "\uFEFF" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "careerboost-job-search-results.csv";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function scrollJobSearchResultsIntoView() {
    const el = document.getElementById("job-search-results-section");
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderSavedRow(s, st) {
    const fl = (s && s.filters) || {};
    const q = String((fl.query || s.query || "") || "").trim();
    const bits = [];
    if (fl.remoteOnly) bits.push("Remote only");
    if (fl.location) bits.push(String(fl.location));
    if (Array.isArray(fl.jobType) && fl.jobType.length) bits.push("Type: " + fl.jobType.join(", "));
    if (Array.isArray(fl.experienceLevel) && fl.experienceLevel.length) bits.push("Exp: " + fl.experienceLevel.join(", "));
    if (fl.activeOnly !== false) bits.push("Active only");
    if (fl.searchRegion) bits.push("Region: " + String(fl.searchRegion));
    if (fl.locationStrictness) bits.push("Loc: " + String(fl.locationStrictness));
    const days = Number(fl.postedWithinDays) || 0;
    if (days > 0) bits.push("≤ " + days + "d");
    bits.push(sortLabel(fl.sort));
    const lastLine =
      typeof s.lastCount === "number"
        ? "Last digest: " + s.lastCount + " matches"
        : "Dashboard digest not run yet for this pick";
    const when = s.lastRunAt ? " · " + formatShortDate(s.lastRunAt) : "";

      return (
      '<li class="job-search-saved-row" data-saved-id="' +
      st(s.id || "") +
      '">' +
      '<div class="job-search-saved-row__main">' +
      "<strong>" +
      st(s.name || q || "Saved search") +
      "</strong>" +
      '<p class="job-search-saved-row__query muted">' +
      st(q || "(no query)") +
      "</p>" +
      '<p class="job-search-saved-row__filters ai-meta">' +
      st(bits.join(" · ")) +
      "</p>" +
        "</div>" +
      '<div class="job-search-saved-row__side">' +
      '<span class="chip subtle">' +
      st(lastLine + when) +
      "</span>" +
      '<div class="job-search-saved-row__actions">' +
      '<a class="btn-secondary btn-sm" href="#/job-search?ss=' +
      encodeURIComponent(s.id || "") +
      '"><i class="fa-solid fa-folder-open" aria-hidden="true"></i> Load</a>' +
      '<a class="btn-primary btn-sm" href="#/job-search?ss=' +
      encodeURIComponent(s.id || "") +
      '&run=1"><i class="fa-solid fa-play" aria-hidden="true"></i> Run</a>' +
      '<button type="button" class="btn-ghost btn-sm" data-delete-saved="' +
      st(s.id || "") +
      '"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>' +
      "</div>" +
      "</div>" +
      "</li>"
    );
  }

  function renderSavedWorkspace(st) {
    const rows = (window.CBV2.store.getSavedSearches && window.CBV2.store.getSavedSearches()) || [];
    const head =
      '<div class="resume-section-head job-search-saved-head">' +
      '<h2><i class="fa-solid fa-bookmark" aria-hidden="true"></i> Saved searches</h2>' +
      '<span class="chip subtle">' +
      st(String(rows.length) + " pick" + (rows.length === 1 ? "" : "s") + " · dashboard digest uses these") +
                  "</span>" +
      "</div>";

    let body = "";
    if (!rows.length) {
      body =
        '<div class="job-search-saved-empty muted">' +
        st(
          "No saved searches yet. Switch to Search, enter a query, then use “Save search” — they power the dashboard digest and show up here."
        ) +
        "</div>";
    } else {
      body =
        '<ul class="job-search-saved-list" id="job-search-saved-list">' +
        rows.map(function (row) {
          return renderSavedRow(row, st);
        }).join("") +
        "</ul>";
    }

    return (
      '<div class="job-search-saved-workspace" id="job-search-saved-root">' +
      '<article class="card panel-lg job-search-saved-card">' +
      head +
      body +
      "</article>" +
      "</div>"
    );
  }

  function renderJobCard(job, st) {
    const store = window.CBV2.store;
    const bookmarked = store && typeof store.isJobBookmarked === "function" && job.id ? store.isJobBookmarked(job.id) : false;
    const inPipeline = isDuplicateInPipeline(job);
    const score = job.roleIntent && typeof job.roleIntent.score === "number" ? job.roleIntent.score : null;
    const chip = fitChipLabel(score);
    const posted = formatPostedLine(job.postedAt);
    const sourceLabel = effectiveSourceLabel(job);
    const sourceKey = String(sourceLabel || "").toLowerCase();
    const tags = Array.isArray(job.tags)
      ? job.tags
          .map(function (t) { return String(t || "").trim(); })
          .filter(Boolean)
          .filter(function (t) {
            const k = t.toLowerCase();
            if (k === sourceKey) return false;
            if (k === "linkedin" || k === "indeed" || k === "adzuna" || k.indexOf("rapidapi") >= 0) return false;
            return true;
          })
          .slice(0, 5)
      : [];
    const tagsHtml = tags
      .map(function (t) {
        return '<span class="chip subtle">' + st(t) + "</span>";
        })
        .join("");
    const remoteChip = job.remote
      ? '<span class="chip blue"><i class="fa-solid fa-house-laptop" aria-hidden="true"></i> Remote</span>'
      : "";
    const desc = snippet(job.descriptionText, 140);
    const ri = job.roleIntent;
    const reasons = ri && Array.isArray(ri.reasons) ? ri.reasons.filter(Boolean) : [];
    // Phase 2: AI-driven fit explanation (when an AI score is attached to
    // this job). Falls back to the regex `roleIntent.reasons` when no AI
    // score has arrived yet.
    const ai = job.aiScore;
    const aiHasScore = ai && typeof ai.score === "number";
    const aiReasons = ai && Array.isArray(ai.reasons) ? ai.reasons.filter(Boolean) : [];
    const aiMissing = ai && Array.isArray(ai.missingSkills) ? ai.missingSkills.filter(Boolean) : [];
    const explainHtml = aiHasScore
      ? '<details class="job-search-fit-details job-search-fit-details--ai" open>' +
        '<summary class="muted"><i class="fa-solid fa-robot" aria-hidden="true"></i> ' +
        st("AI fit · " + ai.score + "/100") +
        (ai.fitSummary ? " · " + st(ai.fitSummary) : "") +
        "</summary>" +
        (aiReasons.length
          ? '<p class="job-search-fit-label muted">Strengths</p><ul class="job-search-fit-reasons">' +
            aiReasons.slice(0, 4).map(function (r) { return "<li>" + st(r) + "</li>"; }).join("") +
            "</ul>"
          : "") +
        (aiMissing.length
          ? '<p class="job-search-fit-label muted">Gaps to address</p><ul class="job-search-fit-reasons">' +
            aiMissing.slice(0, 4).map(function (r) { return "<li>" + st(r) + "</li>"; }).join("") +
            "</ul>"
          : "") +
        "</details>"
      : isSearchExplainabilityOn() && reasons.length
      ? '<details class="job-search-fit-details">' +
        '<summary class="muted">' +
        st("Why this fit score?") +
        "</summary>" +
        '<ul class="job-search-fit-reasons">' +
        reasons.slice(0, 8).map(function (r) { return "<li>" + st(r) + "</li>"; }).join("") +
        "</ul>" +
        "</details>"
      : "";

    // AI score chip — replaces (or augments) the regex score chip when available.
    const aiChipHtml = aiHasScore
      ? '<span class="chip violet job-search-ai-chip" title="AI match score against your resume"><i class="fa-solid fa-robot" aria-hidden="true"></i> AI ' +
        st(String(ai.score)) +
        "</span>"
      : "";

    // Phase 5B: semantic-match indicator when embedding similarity is high.
    // 0.55+ is meaningful for text-embedding-3-small on resume↔job pairs.
    const sim = typeof job.embeddingSimilarity === "number" ? job.embeddingSimilarity : null;
    const simChipHtml = (sim != null && sim >= 0.55)
      ? '<span class="chip cyan job-search-sim-chip" title="Cosine similarity to your resume (text-embedding-3-small)"><i class="fa-solid fa-wave-square" aria-hidden="true"></i> ' +
        st((sim * 100).toFixed(0) + "%") +
        " semantic</span>"
      : "";
    const warning = sourceWarningText(job);
    const sourceWarningHtml =
      warning
        ? '<p class="job-search-source-warning ai-meta"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ' +
          st(warning) +
          "</p>"
        : "";

      return (
      '<article class="job-search-job-card" data-job-id="' +
      st(job.id || "") +
        '">' +
      '<div class="job-search-job-card__top">' +
      '<div class="job-search-job-card__titles">' +
      '<h3 class="job-search-job-card__title">' +
      st(job.title || "Untitled role") +
        "</h3>" +
      '<p class="job-search-job-card__company">' +
      st(job.company || "—") +
        "</p>" +
      "</div>" +
      '<div class="job-search-job-card__chips">' +
      aiChipHtml +
      simChipHtml +
      (score != null && !aiHasScore
        ? '<span class="chip ' + chip.cls + '" title="Role targeting score">' + st(String(score)) + " · " + st(chip.text) + "</span>"
        : "") +
      remoteChip +
      (sourceLabel
        ? '<span class="chip subtle job-search-source-chip" title="' + st(sourceChipTitle(job)) + '">' + st(sourceLabel) + "</span>"
        : "") +
      "</div>" +
      "</div>" +
      '<p class="job-search-job-card__meta">' +
      '<span><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ' +
      st(job.location || "—") +
      "</span>" +
      (posted ? '<span class="job-search-job-card__posted">' + st(posted) + "</span>" : "") +
      (job.salary ? '<span class="job-search-job-card__salary">' + st(job.salary) + "</span>" : "") +
      "</p>" +
      (tagsHtml ? '<div class="job-search-job-card__tags">' + tagsHtml + "</div>" : "") +
      (desc ? '<p class="job-search-job-card__snippet">' + st(desc) + "</p>" : "") +
      sourceWarningHtml +
      explainHtml +
      '<div class="job-search-job-card__actions">' +
      (job.url
        ? '<a class="btn-secondary btn-sm" href="' +
          st(job.url) +
          '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open</a>'
        : '<span class="job-search-job-card__no-link muted">No posting URL</span>') +
      '<button type="button" class="btn-ghost btn-sm"' +
      (bookmarked ? " disabled" : "") +
      ' data-bookmark-job="1" data-job-id="' +
      st(job.id || "") +
      '"><i class="fa-solid fa-bookmark" aria-hidden="true"></i> ' +
      (bookmarked ? "Saved" : "Save") +
      "</button>" +
      '<button type="button" class="btn-ghost btn-sm"' +
      (inPipeline ? " disabled" : "") +
      ' data-pipeline-job="1" data-job-id="' +
      st(job.id || "") +
      '"><i class="fa-solid fa-briefcase" aria-hidden="true"></i> ' +
      (inPipeline ? "In pipeline" : "Pipeline") +
      "</button>" +
      // Phase 2: Apply-with-AI runs the 4-step workflow already built in
      // CBJobs.runApplyWorkflow (save → tailor resume → cover letter → interview prep).
      '<button type="button" class="btn-primary btn-sm" data-apply-workflow="1" data-job-id="' +
      st(job.id || "") +
      '"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Apply with AI</button>' +
      "</div>" +
      "</article>"
    );
  }

  function renderResultsMountInner(st) {
    const jobs = lastSearchView.jobs || [];
    if (!jobs.length) {
      return renderNoResultsHtml(st);
    }

    const groups = groupJobsForDisplay(jobs, lastSearchView.roleProfile);
    const diagHtml = renderDiagnosticsHtml(st, lastSearchView.diagnostics);
    const sourceStripHtml = renderSourceStripHtml(st, lastSearchView.sources);
    const head =
      '<div class="job-search-results-head-row">' +
      '<div class="resume-section-head job-search-results-head">' +
      "<h2><i class=\"fa-solid fa-table-cells-large\" aria-hidden=\"true\"></i> Results</h2>" +
      '<span class="chip subtle">' +
      st(
        String(lastSearchView.total || jobs.length) +
          " roles · " +
          sortLabel(lastSearchView.sort || "newest") +
          " · " +
          (lastSearchView.query || "last query")
      ) +
      "</span>" +
      "</div>" +
      '<button type="button" class="btn-ghost btn-sm" data-clear-results="1">' +
      '<i class="fa-solid fa-trash-can" aria-hidden="true"></i> Clear results' +
      "</button>" +
      '<button type="button" class="btn-secondary btn-sm" data-export-csv="1">' +
      '<i class="fa-solid fa-download" aria-hidden="true"></i> Export CSV' +
      "</button>" +
      "</div>" +
      diagHtml +
      sourceStripHtml;

    const tiers = groups
      .map(function (g) {
        const cards = g.jobs
          .map(function (job) {
            return renderJobCard(job, st);
          })
          .join("");
    return (
          '<section class="job-search-tier" aria-label="' +
          st(g.title) +
          '">' +
          '<h3 class="job-search-tier-title">' +
          st(g.title) +
          "</h3>" +
          '<div class="job-search-results-grid">' +
          cards +
      "</div>" +
      "</section>"
    );
      })
      .join("");

    return head + tiers;
  }

  function repaintJobSearchResults() {
    const mount = document.getElementById("job-search-results-mount");
    if (!mount) return;
    mount.innerHTML = renderResultsMountInner(getSt());
  }

  // Phase 2: AI re-rank — runs against the top N visible jobs after each
  // search completes. Non-blocking: results appear progressively as each
  // job-match-score call returns. We only attempt this when:
  //   - CBJobs.scoreJobs is available (job.matcher.js loaded)
  //   - The user has a non-empty resume in store
  //   - The backend AI orchestrator is active
  // On any failure we silently continue with the regex-only ranking.
  let aiRerankInFlight = false;
  function triggerAiRerankAfterSearch() {
    if (aiRerankInFlight) return;
    if (!window.CBJobs || typeof window.CBJobs.scoreJobs !== "function") return;
    if (typeof window.CBJobs.hasResume === "function" && !window.CBJobs.hasResume()) return;
    const jobs = (lastSearchView && lastSearchView.jobs) || [];
    if (!jobs.length) return;

    const session = lastSearchView; // Capture by reference so a later search invalidates this one.
    aiRerankInFlight = true;

    // Per-card live update — rerender only the card whose AI score arrived.
    function updateOneCard(jobId) {
      const card = document.querySelector('.job-search-job-card[data-job-id="' + jobId + '"]');
      if (!card) return;
      const job = (session.jobs || []).find(function (j) { return j && j.id === jobId; });
      if (!job) return;
      try {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = renderJobCard(job, getSt());
        const fresh = wrapper.firstElementChild;
        if (fresh) card.replaceWith(fresh);
      } catch (e) { /* ignore — full repaint will heal */ }
    }

    window.CBJobs.scoreJobs(jobs, {
      topN: 30,
      onProgress: function (result) {
        if (!result || !result.jobId || result.error) return;
        if (lastSearchView !== session) return; // user re-searched in the meantime
        const job = (session.jobs || []).find(function (j) { return j && j.id === result.jobId; });
        if (!job) return;
        job.aiScore = {
          score: typeof result.score === "number" ? result.score : null,
          fitSummary: result.fitSummary || "",
          reasons: Array.isArray(result.reasons) ? result.reasons : [],
          missingSkills: Array.isArray(result.missingSkills) ? result.missingSkills : []
        };
        updateOneCard(job.id);
      },
      onMeta: function (meta) {
        if (lastSearchView !== session) return;
        updateAiScoringProgress(meta);
      }
    }).then(function (summary) {
      aiRerankInFlight = false;
      clearAiScoringProgress(summary);
      if (lastSearchView !== session) return;
      // After all scores arrive, re-sort: AI score (when present) > regex score.
      const scored = (session.jobs || []).slice().sort(function (a, b) {
        const aiA = a.aiScore && typeof a.aiScore.score === "number" ? a.aiScore.score : null;
        const aiB = b.aiScore && typeof b.aiScore.score === "number" ? b.aiScore.score : null;
        if (aiA != null && aiB != null) return aiB - aiA;
        if (aiA != null) return -1;
        if (aiB != null) return 1;
        return 0;
      });
      session.jobs = scored;
      repaintJobSearchResults();
      if (summary && summary.scored && window.CBV2.toast) {
        const msg = summary.scored === 1
          ? "AI ranked 1 role to your resume."
          : "AI ranked " + summary.scored + " roles to your resume.";
        window.CBV2.toast.info(msg);
      }
      // Phase 5B: layer cosine-similarity rerank on top. Cheap (cached resume
      // vector + tiny per-job embeddings cost), runs after the AI score so
      // the user sees scores first then a tighter ordering moments later.
      triggerEmbeddingRerankAfterScore(session);
    }).catch(function () {
      aiRerankInFlight = false;
      clearAiScoringProgress(null);
    });
  }

  // Fix #4: live progress indicator while AI scores stream in. Mounted into
  // the results section header on first onMeta event, updates in place, then
  // fades out a beat after the final score lands. Failure path (catch) calls
  // clearAiScoringProgress(null) so the chip doesn't get stuck on screen.
  function ensureAiScoringChip() {
    let chip = document.getElementById("job-search-ai-progress");
    if (chip) return chip;
    const section = document.getElementById("job-search-results-section");
    if (!section) return null;
    chip = document.createElement("div");
    chip.id = "job-search-ai-progress";
    chip.className = "job-search-ai-progress chip cyan";
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-live", "polite");
    section.insertBefore(chip, section.firstChild);
    return chip;
  }

  function updateAiScoringProgress(meta) {
    if (!meta || typeof meta.total !== "number" || meta.total <= 0) return;
    const chip = ensureAiScoringChip();
    if (!chip) return;
    const failedSuffix = meta.failed > 0 ? " · " + meta.failed + " failed" : "";
    const inner = meta.done >= meta.total
      ? '<i class="fa-solid fa-check" aria-hidden="true"></i> AI ranked ' + meta.succeeded + " / " + meta.total + " roles" + failedSuffix
      : '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> AI ranking ' + meta.done + " / " + meta.total + " roles…" + failedSuffix;
    chip.innerHTML = inner;
    chip.classList.toggle("is-done", meta.done >= meta.total);
  }

  function clearAiScoringProgress(summary) {
    const chip = document.getElementById("job-search-ai-progress");
    if (!chip) return;
    if (summary && summary.scored) {
      // Show the final tally for a moment so the user notices it, then fade.
      chip.classList.add("is-done");
      setTimeout(function () {
        const stillThere = document.getElementById("job-search-ai-progress");
        if (stillThere) stillThere.remove();
      }, 3000);
    } else {
      chip.remove();
    }
  }

  // Phase 5B: embedding-based re-rank — fires after the AI score pass.
  // Combines AI score (coarse 0-100) with cosine similarity (fine-grained
  // 0-1) into a single composite ranking. Most repeat searches hit the
  // 30-day embeddings cache so this is essentially free.
  let embeddingRerankInFlight = false;
  function triggerEmbeddingRerankAfterScore(session) {
    if (embeddingRerankInFlight) return;
    if (!window.CBJobs || typeof window.CBJobs.rerankJobs !== "function") return;
    if (typeof window.CBJobs.hasResume === "function" && !window.CBJobs.hasResume()) return;
    const jobs = (session && session.jobs) || [];
    if (!jobs.length) return;

    embeddingRerankInFlight = true;
    window.CBJobs.rerankJobs(jobs, { topN: 12 })
      .then(function (result) {
        embeddingRerankInFlight = false;
        if (lastSearchView !== session) return;
        if (!result || !Array.isArray(result.ranked) || !result.ranked.length) return;

        // Attach embedding similarity to each job so future renders can
        // surface it (e.g. as a "semantic match" pip in the AI fit panel).
        const simByJobId = {};
        result.ranked.forEach(function (r) {
          if (r && r.id) simByJobId[r.id] = r.similarity;
        });
        (session.jobs || []).forEach(function (j) {
          if (!j) return;
          if (typeof simByJobId[j.id] === "number") {
            j.embeddingSimilarity = simByJobId[j.id];
            if (j.aiScore) j.aiScore.embeddingSimilarity = simByJobId[j.id];
          }
        });

        // Compose a composite score = AI score (0-100) + cosine boost (0-15).
        // The cosine value is ~0..1 in practice; multiplying by 15 gives a
        // gentle nudge that lets embedding signal break ties in AI scoring
        // without overwhelming it.
        const reordered = (session.jobs || []).slice().sort(function (a, b) {
          const ai = function (j) { return j && j.aiScore && typeof j.aiScore.score === "number" ? j.aiScore.score : null; };
          const sim = function (j) { return typeof j.embeddingSimilarity === "number" ? j.embeddingSimilarity : 0; };
          const ca = (ai(a) != null ? ai(a) : 0) + sim(a) * 15;
          const cb = (ai(b) != null ? ai(b) : 0) + sim(b) * 15;
          if (cb !== ca) return cb - ca;
          // Tie-break: cosine alone, then unchanged.
          return sim(b) - sim(a);
        });
        session.jobs = reordered;
        repaintJobSearchResults();
      })
      .catch(function () {
        embeddingRerankInFlight = false;
      });
  }

  // Phase 2: Apply-with-AI — runs CBJobs.runApplyWorkflow (save → tailor →
  // cover → interview prep). Updates the button label per step so the user
  // sees real progress, then opens the drawer for the saved application.
  async function runApplyWithAi(job, button) {
    if (!window.CBJobs || typeof window.CBJobs.runApplyWorkflow !== "function") {
      if (window.CBV2.toast) window.CBV2.toast.error("AI workflow service not loaded.");
      return;
    }
    const originalLabel = button.innerHTML;
    button.disabled = true;
    let savedApp = null;
    let stepCount = 0;
    let succeeded = 0;
    button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Working…';

    try {
      const js = (window.CBV2.store && window.CBV2.store.getJobSearchState && window.CBV2.store.getJobSearchState()) || {};
      const result = await window.CBJobs.runApplyWorkflow(job, {
        roleProfile: js.roleProfile || null,
        stopOnError: false,
        onStep: function (info) {
          if (!info || !info.step) return;
          stepCount += 1;
          if (info.status === "running") {
            button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ' + info.step.label + "…";
          } else if (info.status === "success") {
            succeeded += 1;
            if (info.step.id === "save" && info.data) savedApp = info.data;
          } else if (info.status === "failed") {
            // Surface step failures in the toast at the end; keep the workflow going.
          }
        }
      });
      if (window.CBV2.toast) {
        const failed = stepCount - succeeded;
        if (failed === 0) {
          window.CBV2.toast.success("Apply with AI · saved + resume tailored + cover drafted + interview prep ready.");
        } else {
          window.CBV2.toast.info("Apply with AI · " + succeeded + "/" + stepCount + " steps completed.");
        }
      }
      // Open the drawer on the saved application so the user sees results.
      const appId = (savedApp && savedApp.id) || (result && result.results && result.results.save && result.results.save.id);
      if (appId && window.CBV2.drawer && typeof window.CBV2.drawer.openApplication === "function") {
        window.CBV2.drawer.openApplication(appId);
      }
      repaintJobSearchResults();
    } catch (err) {
      if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Apply workflow failed.");
      button.disabled = false;
      button.innerHTML = originalLabel;
    }
  }

  function resortCurrentResultsFromSortControl() {
    const sortSel = document.getElementById("job-search-sort");
    if (!sortSel || !lastSearchView.jobs || !lastSearchView.jobs.length) return;
    const sort = normalizeSortValue(sortSel.value);
    const params = { query: lastSearchView.query || "" };
    let next = lastSearchView.jobs.slice();
    if (window.CBJobs && typeof window.CBJobs.sortJobsInMemory === "function") {
      next = window.CBJobs.sortJobsInMemory(next, sort, params);
    }
    lastSearchView = Object.assign({}, lastSearchView, { jobs: next, sort: sort });
    const store = window.CBV2.store;
    if (store && typeof store.getJobSearchState === "function" && typeof store.setJobSearchState === "function") {
      const js = store.getJobSearchState() || {};
      const lf = Object.assign({}, js.lastFilters || {}, { sort: sort });
      store.setJobSearchState({ lastFilters: lf });
    }
    publishJobSearchMemory();
    repaintJobSearchResults();
  }

  window.CBV2.routes["job-search"] = function () {
    // Phase 4.5: removed restoreLastSearchView() — auto-restore happened on
    // every navigation here, which made refresh/sign-in always show stale
    // results. The in-memory `lastSearchView` still preserves results during
    // the same session via the module-scoped variable, so navigating away
    // and back inside one tab keeps the current search visible.
    const st = getSt();
    const params = (window.CBV2.getRouteParams && window.CBV2.getRouteParams()) || {};
    const savedTab = isSavedTabParams(params);
    const historyTab = isHistoryTabParams(params);
    const savedCount = window.CBV2.store.getSavedJobs().length;
    let js = window.CBV2.store.getJobSearchState() || {};
    const cloud = isCloudJobSearchPrimary();
    const forced = isForceClientJobSearch();
    const pathChip = cloud
      ? '<span class="chip blue"><i class="fa-solid fa-cloud" aria-hidden="true"></i> CareerBoost Cloud</span>'
      : '<span class="chip violet"><i class="fa-solid fa-bolt" aria-hidden="true"></i> Browser feeds</span>';
    const diagChip =
      forced && !cloud
        ? '<span class="chip warning"><i class="fa-solid fa-flask" aria-hidden="true"></i> Diagnostic</span>'
        : "";
    const bookmarkChip =
      '<span class="chip cyan"><i class="fa-solid fa-bookmark" aria-hidden="true"></i> ' +
      st(String(savedCount)) +
      " saved</span>";

    // Phase 4.5: keyword input starts blank on each session. Only pre-fill
    // when the user explicitly asks for it — via ?rerunq=... (re-run a recent
    // search) or ?ss=... (open a saved search). The persisted js.lastQuery
    // is still written by other features (resume tailor uses it as context),
    // but we don't pull it into the form here anymore.
    let q = "";
    if (params.rerunq) {
      const rq = String(params.rerunq || "").trim();
      if (rq) q = rq;
    }
    if (params.ss) {
      const searches = window.CBV2.store.getSavedSearches();
      const pick = searches.find(function (x) {
        return x && x.id === params.ss;
      });
      if (pick) {
        const fq = (pick.filters && pick.filters.query) || pick.query || "";
        q = fq || q;
        if (pick.filters && typeof pick.filters === "object") {
          const lf = pick.filters;
          window.CBV2.store.setJobSearchState({
            lastQuery: q,
            lastFilters: {
              remoteOnly: !!lf.remoteOnly,
              postedWithinDays: Number(lf.postedWithinDays) || 0,
              sort: normalizeSortValue(lf.sort || "newest"),
              location: String(lf.location || "").trim(),
              jobType: Array.isArray(lf.jobType) ? lf.jobType.slice(0, 8) : [],
              experienceLevel: Array.isArray(lf.experienceLevel) ? lf.experienceLevel.slice(0, 8) : [],
              activeOnly: lf.activeOnly !== false,
              searchRegion: String(lf.searchRegion || "global"),
              locationStrictness: String(lf.locationStrictness || "balanced")
            }
          });
          js = window.CBV2.store.getJobSearchState() || {};
        }
      }
    }

    const f = js.lastFilters || {};
    const posted = Number(f.postedWithinDays) || 0;
    const sortCur = normalizeSortValue(f.sort || "relevance");
    const locationCur = String(f.location || "").trim();
    const jobTypeCur = Array.isArray(f.jobType) ? f.jobType : [];
    const expCur = Array.isArray(f.experienceLevel) ? f.experienceLevel : [];
    const activeOnlyOn = f.activeOnly !== false;
    const searchRegionCur = String(f.searchRegion || "global");
    const locationStrictnessCur = String(f.locationStrictness || "balanced");
    const updatedLabel = formatShortDate(new Date().toISOString()) || "—";

    const lr = lastRun(js);
    const lastTotal = lr && typeof lr.total === "number" ? lr.total : null;
    const ringScore = ringScoreFromTotal(lastTotal);
    const hint =
      lr && typeof lr.total === "number"
        ? st("Latest scan surfaced " + lr.total + " matches after dedupe.")
        : st("Run a query to scan your feeds. Strong matches group appears when role targeting is set.");
    const lastQ = lr && typeof lr.query === "string" ? lr.query : "";
    const footLeft = lr ? st(lastQ.slice(0, 48) + (lastQ.length > 48 ? "…" : "")) : "—";
    const footRight = lr && typeof lr.latencyMs === "number" ? st(String(lr.latencyMs) + " ms") : "—";

    const ssHint =
      params.ss
        ? '<p class="ai-meta job-search-ss-hint" role="status"><i class="fa-solid fa-star" aria-hidden="true"></i> Loaded from saved search shortcut.</p>'
        : "";

    const tabSearchActive = !savedTab && !historyTab;
    const toolbar =
      '<section class="resume-toolbar">' +
      '<div class="resume-toolbar-title">' +
      '<p class="eyebrow">Job Search</p>' +
      '<h1 class="page-title">Discover roles</h1>' +
      '<p class="page-subtitle resume-meta-line">' +
      pathChip +
      diagChip +
      bookmarkChip +
      '<span class="resume-meta-updated">Phase 4 · ' +
      st(updatedLabel) +
      "</span>" +
      "</p>" +
      "</div>" +
      '<div class="resume-mode-toggle job-search-mode-toggle" role="tablist" aria-label="Job search workspace">' +
      '<button type="button" role="tab" class="mode-btn' +
      (tabSearchActive ? " is-active" : "") +
      '" data-job-search-tab="search" aria-selected="' +
      (tabSearchActive ? "true" : "false") +
      '">' +
      '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search' +
      "</button>" +
      '<button type="button" role="tab" class="mode-btn' +
      (savedTab ? " is-active" : "") +
      '" data-job-search-tab="saved" aria-selected="' +
      (savedTab ? "true" : "false") +
      '">' +
      '<i class="fa-solid fa-bell" aria-hidden="true"></i> Saved' +
      "</button>" +
      '<button type="button" role="tab" class="mode-btn' +
      (historyTab ? " is-active" : "") +
      '" data-job-search-tab="history" aria-selected="' +
      (historyTab ? "true" : "false") +
      '">' +
      '<i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> History' +
      "</button>" +
      "</div>" +
      '<div class="resume-toolbar-actions">' +
      '<a class="btn-secondary" href="#/settings"><i class="fa-solid fa-user-tag" aria-hidden="true"></i> Targeting</a>' +
      '<button class="btn-secondary" type="button" id="job-search-save"' +
      (savedTab || historyTab ? " disabled" : "") +
      '><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save search</button>' +
      '<button class="btn-primary" type="button" id="job-search-run"' +
      (savedTab || historyTab ? " disabled" : "") +
      '><i class="fa-solid fa-play" aria-hidden="true"></i> Run search</button>' +
      '<button class="btn-ghost" type="button" id="job-search-clear"' +
      (savedTab || historyTab ? " disabled" : "") +
      '><i class="fa-solid fa-eraser" aria-hidden="true"></i> Clear</button>' +
      '<a class="btn-ghost" href="#/applications"><i class="fa-solid fa-briefcase" aria-hidden="true"></i> Pipeline</a>' +
      "</div>" +
      "</section>";

    if (savedTab) {
      return '<section class="page-container job-search-page">' + toolbar + renderSavedWorkspace(st) + "</section>";
    }
    if (historyTab) {
      return '<section class="page-container job-search-page">' + toolbar + renderHistoryWorkspace(st) + "</section>";
    }

    const queryVal = st(q);
    const remoteMode = f.remoteOnly ? "remote_only" : "any";
    const remoteAnySel = remoteMode === "any" ? " selected" : "";
    const remoteOnlySel = remoteMode === "remote_only" ? " selected" : "";
    const postedAnySel = posted === 0 ? " selected" : "";
    const posted7Sel = posted === 7 ? " selected" : "";
    const posted14Sel = posted === 14 ? " selected" : "";
    const activeOnlySel = activeOnlyOn ? "active_only" : "any";
    const activeAnySel = activeOnlySel === "any" ? " selected" : "";
    const activeOnlyDropSel = activeOnlySel === "active_only" ? " selected" : "";
    const jobTypeCurSingle = jobTypeCur[0] || "any";
    const expCurSingle = expCur[0] || "any";

    const selNewest = sortCur === "newest" ? " selected" : "";
    const selOldest = sortCur === "oldest" ? " selected" : "";
    const selRole = sortCur === "role-fit" ? " selected" : "";
    const selRel = sortCur === "relevance" ? " selected" : "";

    const rp = js.roleProfile && typeof js.roleProfile === "object" ? js.roleProfile : {};
    const strictOn = !!rp.strictMode;
    const strictRow = isSearchStrictConstraintsOn()
      ? '<label class="job-search-chip-toggle"><input type="checkbox" id="job-search-strict-mode"' +
        (strictOn ? " checked" : "") +
        " /> Strict targeting (titles + skills)</label>"
      : "";
    const nlqOn = !!js.nlqEnabled;
    const nlqRow =
      '<label class="job-search-chip-toggle" title="Runs query-parse before each search to enrich keyword relevance (offline mock or your AI provider).">' +
      '<input type="checkbox" id="job-search-nlq-enabled"' +
      (nlqOn ? " checked" : "") +
      " /> Smart query parse (NLQ)</label>";
    const advancedRow =
      '<div class="job-search-advanced-row" role="group" aria-label="Search options">' +
      nlqRow +
      '<label class="job-search-chip-toggle"><input type="checkbox" id="job-search-bypass-cache" /> Fresh fetch (skip cache)</label>' +
      strictRow +
      "</div>";

    const scoreHead =
      lastTotal == null
        ? "—<span class=\"resume-scorecard-max\"> matches</span>"
        : st(String(lastTotal)) + '<span class="resume-scorecard-max"> matches</span>';

    const mainCard =
      '<div class="job-search-layout">' +
      '<article class="card panel-lg resume-section job-search-query-card">' +
      '<div class="resume-section-head">' +
      '<h2><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search command</h2>' +
      '<span class="chip subtle">' +
      st("Constraints enforced - " + sortLabel(sortCur)) +
      "</span>" +
      "</div>" +
      '<form id="job-search-form" class="job-search-form" autocomplete="off">' +
      ssHint +
      '<div class="job-search-core-panel">' +
      '<label class="job-search-query-label" for="job-search-query">' +
      "<span>Keywords &amp; titles</span>" +
      '<span class="job-search-query-wrap">' +
      '<input id="job-search-query" name="q" type="text" value="' +
      queryVal +
      '" placeholder="e.g. Senior frontend engineer react typescript" />' +
      "</span>" +
      "</label>" +
      '<div class="job-search-priority-grid">' +
      '<label class="job-search-query-label" for="job-search-location">' +
      "<span>Location constraint</span>" +
      '<span class="job-search-query-wrap">' +
      '<input id="job-search-location" name="location" type="text" value="' +
      st(locationCur) +
      '" placeholder="e.g. Pretoria, Gauteng / Cape Town / Remote" />' +
      "</span>" +
      "</label>" +
      '<label class="job-search-field" for="job-search-location-strictness">' +
      '<span class="job-search-target-title">Location match</span>' +
      '<select id="job-search-location-strictness" name="locationStrictness" class="job-search-sort-select" aria-describedby="job-search-location-strictness-hint">' +
      '<option value="strict"' + (locationStrictnessCur === "strict" ? " selected" : "") + ' title="City + country must match">Strict — exact city only</option>' +
      '<option value="balanced"' + (locationStrictnessCur === "balanced" ? " selected" : "") + ' title="Same city, metro, or region">Balanced — same area or region</option>' +
      '<option value="broad"' + (locationStrictnessCur === "broad" ? " selected" : "") + ' title="Any keyword overlap counts">Broad — any keyword overlap</option>' +
      "</select>" +
      "</label>" +
      '<label class="job-search-field" for="job-search-remote">' +
      '<span class="job-search-target-title">Work mode</span>' +
      '<select id="job-search-remote" name="remoteMode" class="job-search-sort-select">' +
      '<option value="any"' + remoteAnySel + ">Any work mode</option>" +
      '<option value="remote_only"' + remoteOnlySel + ">Remote only</option>" +
      "</select>" +
      "</label>" +
      '<label class="job-search-field" for="job-search-posted">' +
      '<span class="job-search-target-title">Posted</span>' +
      '<select id="job-search-posted" name="postedWithinDays" class="job-search-sort-select">' +
      '<option value="0"' + postedAnySel + ">Any time</option>" +
      '<option value="7"' + posted7Sel + ">Last 7 days</option>" +
      '<option value="14"' + posted14Sel + ">Last 14 days</option>" +
      "</select>" +
      "</label>" +
      "</div>" +
      "</div>" +
      '<details class="job-search-manual-panel">' +
      '<summary><span><i class="fa-solid fa-sliders" aria-hidden="true"></i> Manual filters</span><small>Job type, experience, region, sorting</small></summary>' +
      '<div class="job-search-filter-grid">' +
      '<label class="job-search-field" for="job-search-job-type">' +
      '<span class="job-search-target-title">Job type</span>' +
      '<select id="job-search-job-type" name="jobType" class="job-search-sort-select">' +
      '<option value="any"' + (jobTypeCurSingle === "any" ? " selected" : "") + ">Any type</option>" +
      '<option value="full_time"' + (jobTypeCurSingle === "full_time" ? " selected" : "") + ">Full-time</option>" +
      '<option value="part_time"' + (jobTypeCurSingle === "part_time" ? " selected" : "") + ">Part-time</option>" +
      '<option value="contract"' + (jobTypeCurSingle === "contract" ? " selected" : "") + ">Contract</option>" +
      '<option value="internship"' + (jobTypeCurSingle === "internship" ? " selected" : "") + ">Internship</option>" +
      '<option value="temporary"' + (jobTypeCurSingle === "temporary" ? " selected" : "") + ">Temporary</option>" +
      "</select>" +
      "</label>" +
      '<label class="job-search-field" for="job-search-experience">' +
      '<span class="job-search-target-title">Experience level</span>' +
      '<select id="job-search-experience" name="experienceLevel" class="job-search-sort-select">' +
      '<option value="any"' + (expCurSingle === "any" ? " selected" : "") + ">Any level</option>" +
      '<option value="internship"' + (expCurSingle === "internship" ? " selected" : "") + ">Internship</option>" +
      '<option value="entry"' + (expCurSingle === "entry" ? " selected" : "") + ">Entry</option>" +
      '<option value="associate"' + (expCurSingle === "associate" ? " selected" : "") + ">Associate</option>" +
      '<option value="mid_senior"' + (expCurSingle === "mid_senior" ? " selected" : "") + ">Mid-Senior</option>" +
      '<option value="director_plus"' + (expCurSingle === "director_plus" ? " selected" : "") + ">Director+</option>" +
      "</select>" +
      "</label>" +
      '<label class="job-search-field" for="job-search-active-only">' +
      '<span class="job-search-target-title">Recruiting status</span>' +
      '<select id="job-search-active-only" name="activeOnly" class="job-search-sort-select">' +
      '<option value="any"' + activeAnySel + ">Any status</option>" +
      '<option value="active_only"' + activeOnlyDropSel + ">Only active recruiting</option>" +
      "</select>" +
      "</label>" +
      '<label class="job-search-field" for="job-search-region">' +
      '<span class="job-search-target-title">Search region</span>' +
      '<select id="job-search-region" name="searchRegion" class="job-search-sort-select">' +
      '<option value="global"' + (searchRegionCur === "global" ? " selected" : "") + ">Global</option>" +
      '<option value="africa"' + (searchRegionCur === "africa" ? " selected" : "") + ">Africa</option>" +
      '<option value="europe"' + (searchRegionCur === "europe" ? " selected" : "") + ">Europe</option>" +
      '<option value="north_america"' + (searchRegionCur === "north_america" ? " selected" : "") + ">North America</option>" +
      '<option value="asia_pacific"' + (searchRegionCur === "asia_pacific" ? " selected" : "") + ">Asia Pacific</option>" +
      "</select>" +
      "</label>" +
      "</div>" +
      '<div class="job-search-sort-row">' +
      "<label for=\"job-search-sort\" class=\"job-search-sort-label\">Sort results</label>" +
      '<select id="job-search-sort" name="sort" class="job-search-sort-select" aria-label="Sort results">' +
      '<option value="newest"' +
      selNewest +
      ">Newest first</option>" +
      '<option value="oldest"' +
      selOldest +
      ">Oldest first</option>" +
      '<option value="role-fit"' +
      selRole +
      ">Role fit</option>" +
      '<option value="relevance"' +
      selRel +
      ">Keyword relevance</option>" +
      "</select>" +
      "</div>" +
      advancedRow +
      "</details>" +
      '<p id="job-search-run-meta" class="job-search-run-meta" aria-live="polite"></p>' +
      "</form>" +
      "</article>" +
      '<article class="card resume-scorecard job-search-signal-card">' +
      '<div class="resume-scorecard-head">' +
      "<div>" +
      '<p class="eyebrow">Signal</p>' +
      '<h3 class="num-font">' +
      scoreHead +
      "</h3>" +
      "</div>" +
      '<div class="resume-ring" aria-hidden="true">' +
      '<svg viewBox="0 0 36 36" width="64" height="64">' +
      '<circle cx="18" cy="18" r="15.9" class="ring-track" />' +
      '<circle cx="18" cy="18" r="15.9" class="ring-fill" style="stroke-dasharray: ' +
      ringScore +
      ', 100;" />' +
      "</svg>" +
      "</div>" +
      "</div>" +
      '<p class="job-search-signal-hint"><em>' +
      hint +
      "</em></p>" +
      '<div class="resume-stats">' +
      '<div><span class="num-font">' +
      footLeft +
      "</span> last query snippet</div>" +
      '<div><span class="num-font">' +
      footRight +
      "</span> client latency</div>" +
      "</div>" +
      "</article>" +
      "</div>";

    const resultsSection =
      '<section class="card panel-lg job-search-results" id="job-search-results-section" aria-label="Job search results">' +
      '<div id="job-search-results-mount">' +
      renderResultsMountInner(st) +
      "</div>" +
      "</section>";

    const boardPanel = renderBigBoardPanel(st);

    return '<section class="page-container job-search-page">' + toolbar + mainCard + boardPanel + resultsSection + "</section>";
  };

  function readFiltersFromForm(form) {
    const remoteEl = form.querySelector("#job-search-remote");
    const postedEl = form.querySelector("#job-search-posted");
    const sortEl = form.querySelector("#job-search-sort");
    const locationEl = form.querySelector("#job-search-location");
    const activeOnlyEl = form.querySelector("#job-search-active-only");
    const regionEl = form.querySelector("#job-search-region");
    const strictnessEl = form.querySelector("#job-search-location-strictness");
    const jobTypeEl = form.querySelector("#job-search-job-type");
    const expEl = form.querySelector("#job-search-experience");
    const postedWithinDays = postedEl && postedEl.value ? Number(postedEl.value) : 0;
    const jobTypeValue = jobTypeEl && jobTypeEl.value ? String(jobTypeEl.value) : "any";
    const expValue = expEl && expEl.value ? String(expEl.value) : "any";
    const sort = normalizeSortValue(sortEl && sortEl.value);
    return {
      remoteOnly: !!(remoteEl && remoteEl.value === "remote_only"),
      postedWithinDays: Number.isFinite(postedWithinDays) ? postedWithinDays : 0,
      sort: sort,
      location: locationEl && locationEl.value ? String(locationEl.value).trim() : "",
      jobType: jobTypeValue === "any" ? [] : [jobTypeValue],
      experienceLevel: expValue === "any" ? [] : [expValue],
      activeOnly: !!(activeOnlyEl && activeOnlyEl.value === "active_only"),
      searchRegion: regionEl && regionEl.value ? String(regionEl.value) : "global",
      locationStrictness: strictnessEl && strictnessEl.value ? String(strictnessEl.value) : "balanced"
    };
  }

  function setLoading(loading) {
    const runBtn = document.getElementById("job-search-run");
    const meta = document.getElementById("job-search-run-meta");
    if (runBtn) {
      runBtn.disabled = !!loading;
      runBtn.setAttribute("aria-busy", loading ? "true" : "false");
    }
    if (meta && loading) meta.textContent = "Scanning feeds…";
  }

  function cloneRoleProfile(rp) {
    if (!rp || typeof rp !== "object") return null;
    try {
      return JSON.parse(JSON.stringify(rp));
    } catch (e) {
      return null;
    }
  }

  function updateSignalCard(total, query, latencyMs) {
    const headNum = document.querySelector(".job-search-signal-card .resume-scorecard-head h3.num-font");
    const ringFill = document.querySelector(".job-search-signal-card .ring-fill");
    const hintEl = document.querySelector(".job-search-signal-hint em");
    const stats = document.querySelectorAll(".job-search-signal-card .resume-stats .num-font");
    if (headNum) {
      headNum.innerHTML =
        String(total) + '<span class="resume-scorecard-max"> matches</span>';
    }
    if (ringFill) {
      const score = Math.min(100, Math.round(20 + Math.min(80, total * 2)));
      ringFill.setAttribute("style", "stroke-dasharray: " + score + ", 100;");
    }
    if (hintEl) {
      hintEl.textContent =
        total === 0
          ? "No roles matched this run. Try broader keywords or relax filters."
          : "Latest scan surfaced " + total + " matches after dedupe.";
    }
    if (stats && stats[0]) {
      const qv = (query || "(empty)").slice(0, 48) + (query.length > 48 ? "…" : "");
      stats[0].textContent = qv;
    }
    if (stats && stats[1] && typeof latencyMs === "number") {
      stats[1].textContent = String(latencyMs) + " ms";
    }
  }

  function runJobSearch() {
    const form = document.getElementById("job-search-form");
    const input = document.getElementById("job-search-query");
    const meta = document.getElementById("job-search-run-meta");
    if (!form || !input) return;

    const query = (input.value || "").trim();
    const filters = readFiltersFromForm(form);
    const js = window.CBV2.store.getJobSearchState() || {};
    const roleProfile = js.roleProfile || null;
    const bypassEl = document.getElementById("job-search-bypass-cache");
    const bypassCache = !!(bypassEl && bypassEl.checked);
    const nlqEl = document.getElementById("job-search-nlq-enabled");
    const nlqEnabled = !!(nlqEl && nlqEl.checked);
    window.CBV2.store.setJobSearchState({
      lastQuery: query,
      lastFilters: filters,
      nlqEnabled: nlqEnabled
    });

    if (!window.CBJobs || typeof window.CBJobs.search !== "function") {
      if (meta) meta.textContent = "Job search engine is not available.";
      return;
    }

    setLoading(true);
    const t0 = Date.now();
    const parsePromise =
      nlqEnabled && query
        ? (function () {
            if (meta) meta.textContent = "Parsing query…";
            return fetchQueryParseNlq(query);
          })()
        : Promise.resolve(null);

    parsePromise
      .then(function (nlqData) {
        const searchPayload = Object.assign({}, filters, {
          query: query,
          roleProfile: roleProfile,
          bypassCache: bypassCache
        });
        if (nlqData) searchPayload.nlq = nlqData;
        return window.CBJobs.search(searchPayload).then(function (out) {
          return { out: out, nlqData: nlqData };
        });
      })
      .then(function (packed) {
        const out = packed.out;
        const nlqData = packed.nlqData;
        const latencyMs = Date.now() - t0;
        const total = typeof out.total === "number" ? out.total : (out.jobs && out.jobs.length) || 0;
        const jobs = (out.jobs || []).slice();
        const sort = normalizeSortValue(filters.sort);

        lastSearchView = {
          jobs: jobs,
          query: query,
          at: Date.now(),
          total: total,
          roleProfile: cloneRoleProfile(roleProfile),
          sort: sort,
          // Capture the filters used for this run so the empty-state can
          // suggest the right "broaden" action based on the actual strictness
          // applied (not whatever the user has typed since).
          filters: filters && typeof filters === "object" ? Object.assign({}, filters) : null,
          diagnostics: out.diagnostics && typeof out.diagnostics === "object" ? out.diagnostics : null,
          sources: out.sources && typeof out.sources === "object" ? out.sources : null,
          nlq: out.nlq && typeof out.nlq === "object" ? out.nlq : nlqData || null
        };
        publishJobSearchMemory();

        if (window.CBV2.store.recordJobSearchRun) {
          window.CBV2.store.recordJobSearchRun({
            query: query,
            total: total,
            latencyMs: latencyMs
          });
        }

        if (meta) {
          const nlqLine = nlqEnabled && nlqData ? nlqSummaryLine(nlqData) : "";
          const base =
            total === 0
              ? "No matches this run. Adjust keywords or filters and try again."
              : "Showing " + total + " roles below (deduped).";
          meta.textContent = nlqLine ? base + " · NLQ: " + nlqLine : base;
        }
        updateSignalCard(total, query, latencyMs);
        repaintJobSearchResults();
        if (total > 0) scrollJobSearchResultsIntoView();
        if (window.CBV2.toast) {
          window.CBV2.toast.success(total === 0 ? "Search complete · no matches" : "Search complete · " + total + " matches");
        }
        // Phase 2: kick off AI re-rank on the top results — non-blocking. The
        // initial page is already rendered; AI scores trickle in over the next
        // few seconds and re-paint individual cards.
        triggerAiRerankAfterSearch();
      })
      .catch(function (err) {
        const msg = err && err.message ? err.message : "Search failed";
        if (meta) meta.textContent = msg;
        if (window.CBV2.toast) window.CBV2.toast.error(msg);
      })
      .finally(function () {
        setLoading(false);
      });
  }

  function bindJobSearchResultsSection() {
    const section = document.getElementById("job-search-results-section");
    if (!section || section.getAttribute("data-job-search-results-bound") === "1") return;
    section.setAttribute("data-job-search-results-bound", "1");
    section.addEventListener("click", function (e) {
      const clearResultsBtn = e.target && e.target.closest ? e.target.closest("[data-clear-results]") : null;
      if (clearResultsBtn) {
        e.preventDefault();
        lastSearchView = {
          jobs: [],
          query: "",
          at: 0,
          total: 0,
          roleProfile: null,
          sort: "newest",
          diagnostics: null,
          sources: null,
          nlq: null
        };
        clearPersistedLastSearchView();
        publishJobSearchMemory();
        repaintJobSearchResults();
        updateSignalCard(0, "", null);
        if (window.CBV2.toast) window.CBV2.toast.success("Search results cleared.");
        return;
      }

      const exportBtn = e.target && e.target.closest ? e.target.closest("[data-export-csv]") : null;
      if (exportBtn) {
        e.preventDefault();
        if (!(lastSearchView.jobs && lastSearchView.jobs.length)) {
          if (window.CBV2.toast) window.CBV2.toast.error("Run a search with results before exporting.");
          return;
        }
        downloadResultsCsv();
        if (window.CBV2.toast) window.CBV2.toast.success("Exported current results to CSV.");
        return;
      }

      const pipeBtn = e.target && e.target.closest ? e.target.closest("[data-pipeline-job]") : null;
      if (pipeBtn && !pipeBtn.disabled) {
        const id = pipeBtn.getAttribute("data-job-id");
        if (!id) return;
        const job = (lastSearchView.jobs || []).find(function (j) {
          return j && j.id === id;
        });
        if (!job) return;
        if (isDuplicateInPipeline(job)) {
          if (window.CBV2.toast) window.CBV2.toast.info("Already in your pipeline.");
          return;
        }
        const store = window.CBV2.store;
        if (!store || typeof store.saveJobAsApplication !== "function") return;
        try {
          const app = store.saveJobAsApplication(job);
          if (window.CBV2.toast) window.CBV2.toast.success("Added to your pipeline.");
          if (app && window.CBV2.drawer && typeof window.CBV2.drawer.openApplication === "function") {
            window.CBV2.drawer.openApplication(app.id);
          }
          repaintJobSearchResults();
        } catch (err) {
          if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Could not add.");
        }
        return;
      }

      // Phase 2: Apply-with-AI button — runs the 4-step workflow.
      const applyBtn = e.target && e.target.closest ? e.target.closest("[data-apply-workflow]") : null;
      if (applyBtn && !applyBtn.disabled) {
        const id = applyBtn.getAttribute("data-job-id");
        if (!id) return;
        const job = (lastSearchView.jobs || []).find(function (j) { return j && j.id === id; });
        if (!job) return;
        runApplyWithAi(job, applyBtn);
        return;
      }

      const btn = e.target && e.target.closest ? e.target.closest("[data-bookmark-job]") : null;
      if (!btn || btn.disabled) return;
      const id = btn.getAttribute("data-job-id");
      if (!id) return;
      const job = (lastSearchView.jobs || []).find(function (j) {
        return j && j.id === id;
      });
      if (!job) return;
      const store = window.CBV2.store;
      if (!store || typeof store.bookmarkJob !== "function") return;
      try {
        const js = store.getJobSearchState() || {};
        const enriched = Object.assign({}, job, { roleProfile: js.roleProfile || null });
        const before = store.getSavedJobs().length;
        store.bookmarkJob(enriched);
        const after = store.getSavedJobs().length;
        if (window.CBV2.toast) {
          if (after > before) window.CBV2.toast.success("Saved to your bookmarks.");
          else if (typeof window.CBV2.toast.info === "function") {
            window.CBV2.toast.info("Already in your bookmarks.");
          } else {
            window.CBV2.toast.success("Already in your bookmarks.");
          }
        }
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-bookmark" aria-hidden="true"></i> Saved';
      } catch (err) {
        if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Could not save.");
      }
    });
  }

  function bindBigBoardPanel() {
    const page = document.querySelector(".job-search-page");
    if (!page || page.getAttribute("data-job-board-bound") === "1") return;
    page.setAttribute("data-job-board-bound", "1");
    page.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest ? e.target.closest("[data-board-search]") : null;
      if (!btn) return;
      e.preventDefault();
      openBigBoard(btn.getAttribute("data-board-search") || "linkedin");
    });

    // "Broaden location match" action surfaced in the empty-results panel.
    // Flips the strictness <select> to the next-broader tier and re-submits
    // the search form so the user doesn't have to re-type anything.
    page.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action="broaden-strictness"]') : null;
      if (!btn) return;
      e.preventDefault();
      const target = String(btn.getAttribute("data-target") || "balanced");
      const sel = document.getElementById("job-search-location-strictness");
      if (sel) sel.value = target;
      const form = document.getElementById("job-search-form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else if (form) form.dispatchEvent(new Event("submit", { cancelable: true }));
    });

    const form = document.getElementById("job-search-import-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const urlEl = document.getElementById("job-search-import-url");
      const companyEl = document.getElementById("job-search-import-company");
      const roleEl = document.getElementById("job-search-import-role");
      const rawUrl = urlEl ? String(urlEl.value || "").trim() : "";
      const meta = {
        company: companyEl ? String(companyEl.value || "").trim() : "",
        role: roleEl ? String(roleEl.value || "").trim() : ""
      };
      const store = window.CBV2.store;
      if (!store || typeof store.saveApplicationFromJobUrl !== "function") return;
      const res = store.saveApplicationFromJobUrl(rawUrl, meta);
      if (!res || !res.ok) {
        if (window.CBV2.toast) window.CBV2.toast.error((res && res.error) || "Could not import this listing.");
        return;
      }
      if (urlEl) urlEl.value = "";
      if (companyEl) companyEl.value = "";
      if (roleEl) roleEl.value = "";
      if (window.CBV2.toast) window.CBV2.toast.success("Imported to your pipeline.");
      if (res.application && window.CBV2.drawer && typeof window.CBV2.drawer.openApplication === "function") {
        window.CBV2.drawer.openApplication(res.application.id);
      }
    });
  }

  function bindSavedWorkspaceDelegation() {
    const root = document.getElementById("job-search-saved-root");
    if (!root || root.getAttribute("data-job-search-saved-bound") === "1") return;
    root.setAttribute("data-job-search-saved-bound", "1");
    root.addEventListener("click", async function (e) {
      const btn = e.target && e.target.closest ? e.target.closest("[data-delete-saved]") : null;
      if (!btn) return;
      const id = btn.getAttribute("data-delete-saved");
      if (!id) return;
      // Phase 4.5: in-app modal replaces native confirm.
      const modal = window.CBV2 && window.CBV2.modal;
      const ok = modal && modal.confirm
        ? await modal.confirm({
            title: "Remove saved search?",
            body: "It will be removed from your picks and from the digest email list. You can save it again later.",
            confirmLabel: "Remove",
            tone: "danger",
          })
        : window.confirm("Remove this saved search from your picks and digest list?");
      if (!ok) return;
      const store = window.CBV2.store;
      if (!store || typeof store.deleteSavedSearch !== "function") return;
      store.deleteSavedSearch(id);
      if (window.CBV2.toast) window.CBV2.toast.success("Saved search removed.");
      window.CBV2.renderCurrentRoute();
    });
  }

  function bindWorkspaceTabs() {
    document.querySelectorAll("[data-job-search-tab]").forEach(function (btn) {
      if (btn.getAttribute("data-job-search-tab-bound") === "1") return;
      btn.setAttribute("data-job-search-tab-bound", "1");
      btn.addEventListener("click", function () {
        const t = btn.getAttribute("data-job-search-tab");
        if (t === "saved") {
          window.location.hash = "#/job-search?tab=saved";
        } else if (t === "history") {
          window.location.hash = "#/job-search?tab=history";
        } else {
          window.location.hash = "#/job-search";
        }
        window.CBV2.renderCurrentRoute();
      });
    });
  }

  window.CBV2.afterRender["job-search"] = function (params) {
    params = params || (window.CBV2.getRouteParams && window.CBV2.getRouteParams()) || {};
    bindWorkspaceTabs();

    const savedTab = isSavedTabParams(params);
    const historyTab = isHistoryTabParams(params);
    if (savedTab) {
      bindSavedWorkspaceDelegation();
      return;
    }
    if (historyTab) {
      return;
    }

    if (params.run === "1" && params.ss) {
      try {
        history.replaceState(null, "", "#/job-search?ss=" + encodeURIComponent(params.ss));
      } catch (e) {
        /* non-fatal */
      }
      setTimeout(function () {
        runJobSearch();
      }, 0);
    } else if (params.run === "1" && params.rerunq) {
      try {
        history.replaceState(null, "", "#/job-search?rerunq=" + encodeURIComponent(params.rerunq));
      } catch (e) {
        /* non-fatal */
      }
      setTimeout(function () {
        runJobSearch();
      }, 0);
    }

    const form = document.getElementById("job-search-form");
    const runBtn = document.getElementById("job-search-run");
    const clearBtn = document.getElementById("job-search-clear");
    const saveBtn = document.getElementById("job-search-save");

    if (form) {
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        runJobSearch();
      });
    }
    if (runBtn) {
      runBtn.addEventListener("click", function () {
        runJobSearch();
      });
    }
    const queryInput = document.getElementById("job-search-query");
    if (queryInput && queryInput.getAttribute("data-enter-bound") !== "1") {
      queryInput.setAttribute("data-enter-bound", "1");
      queryInput.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        runJobSearch();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        const input = document.getElementById("job-search-query");
        if (input) input.value = "";
        const sortSel = document.getElementById("job-search-sort");
        if (sortSel) sortSel.value = "relevance";
        const remoteSel = document.getElementById("job-search-remote");
        if (remoteSel) remoteSel.value = "any";
        const postedSel = document.getElementById("job-search-posted");
        if (postedSel) postedSel.value = "0";
        const locationEl = document.getElementById("job-search-location");
        if (locationEl) locationEl.value = "";
        const jtSel = document.getElementById("job-search-job-type");
        if (jtSel) jtSel.value = "any";
        const expSel = document.getElementById("job-search-experience");
        if (expSel) expSel.value = "any";
        const activeOnlyEl = document.getElementById("job-search-active-only");
        if (activeOnlyEl) activeOnlyEl.value = "active_only";
        const regionEl = document.getElementById("job-search-region");
        if (regionEl) regionEl.value = "global";
        const strictnessEl = document.getElementById("job-search-location-strictness");
        if (strictnessEl) strictnessEl.value = "balanced";
        const bypassEl = document.getElementById("job-search-bypass-cache");
        if (bypassEl) bypassEl.checked = false;
        window.CBV2.store.setJobSearchState({
          lastQuery: "",
          lastFilters: {
            remoteOnly: false,
            postedWithinDays: 0,
            sort: "relevance",
            location: "",
            jobType: [],
            experienceLevel: [],
            activeOnly: true,
            searchRegion: "global",
            locationStrictness: "balanced"
          }
        });
        const meta = document.getElementById("job-search-run-meta");
        if (meta) meta.textContent = "";
        lastSearchView = {
          jobs: [],
          query: "",
          at: 0,
          total: 0,
          roleProfile: null,
          sort: "newest",
          diagnostics: null,
          sources: null,
          nlq: null
        };
        clearPersistedLastSearchView();
        publishJobSearchMemory();
        repaintJobSearchResults();
      });
    }
    if (saveBtn && form) {
      saveBtn.addEventListener("click", function () {
        const input = document.getElementById("job-search-query");
        const q = input ? (input.value || "").trim() : "";
        if (!q) {
          if (window.CBV2.toast) window.CBV2.toast.error("Enter a query to save.");
          return;
        }
        const filters = readFiltersFromForm(form);
        const js = window.CBV2.store.getJobSearchState() || {};
        const roleProfile = js.roleProfile || null;
        const id = "ss_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 10000);
        const name = q.length > 48 ? q.slice(0, 45) + "…" : q;
        const saved = window.CBV2.store.upsertSavedSearch({
          id: id,
          name: name,
          filters: Object.assign({}, filters, { query: q, roleProfile: roleProfile })
        });
        if (saved && window.CBV2.toast) {
          window.CBV2.toast.success("Saved search added for dashboard digest.");
        }
      });
    }

    if (form) {
      form.addEventListener("change", function (ev) {
        const input = document.getElementById("job-search-query");
        const filters = readFiltersFromForm(form);
        window.CBV2.store.setJobSearchState({
          lastQuery: input ? (input.value || "").trim() : "",
          lastFilters: filters
        });
        const t = ev && ev.target;
        if (t && t.id === "job-search-sort") {
          resortCurrentResultsFromSortControl();
        }
        if (t && t.id === "job-search-strict-mode") {
          const js2 = window.CBV2.store.getJobSearchState() || {};
          const nextRp = Object.assign({}, js2.roleProfile || {}, { strictMode: !!t.checked });
          window.CBV2.store.setJobSearchState({ roleProfile: nextRp });
        }
        if (t && t.id === "job-search-nlq-enabled") {
          window.CBV2.store.setJobSearchState({ nlqEnabled: !!t.checked });
        }
      });
    }

    bindJobSearchResultsSection();
    bindBigBoardPanel();
  };
})();
