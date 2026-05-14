// Supabase-backed implementation of the window.CBV2.store interface.
// Strategy: write-through cache. All reads return from an in-memory cache
// hydrated on sign-in; writes update the cache immediately (keeping the
// synchronous interface the rest of the app expects) and push to Supabase
// in the background. Sync failures surface via window.CBV2.syncErrors.
(function () {
  window.CBV2 = window.CBV2 || {};

  const emptyCache = function () {
    return {
      applications: [],
      events: [],
      resume: {
        base: "",
        tailored: null,
        structured: null,
        tailor: null,
        savedCVs: [],
        defaultSavedCvId: "",
        careerAssets: [],
        updatedAt: ""
      },
      coverLetter: { lastResult: null, variants: [], activeVariantId: "", sentLog: [], rolePacks: [], activeRolePackId: "" },
      interview: { lastSet: null, mockSession: null, intelSession: null },
      savedJobs: [],
      savedSearches: [],
      jobSearch: {
        lastQuery: "",
        lastFilters: { remoteOnly: false, postedWithinDays: 0, sort: "newest" },
        nlqEnabled: true,
        openGoogleAfterSearch: false,
        roleProfile: {
          targetTitles: [],
          seniority: "any",
          mustHaveSkills: [],
          excludeKeywords: [],
          strictMode: false
        },
        analytics: { runs: [] },
        lastResultSet: null,
        apiKeys: { adzunaAppId: "", adzunaAppKey: "", adzunaCountry: "gb", museKey: "" }
      }
    };
  };

  let cache = emptyCache();
  let client = null;
  let userId = null;
  let hydrated = false;
  const errors = [];
  const JOB_SEARCH_RESULTS_KEY = "cbv2_job_search_results_v1";
  let applicationsPollTimer = null;
  let applicationsChannel = null;
  let refreshingApplications = false;
  let lastApplicationsSignature = "";

  function buildPipelineNotesFromJob(job) {
    job = job || {};
    const notes = window.CBV2.jobNotes;
    if (notes && typeof notes.buildImportedNotes === "function") {
      return notes.buildImportedNotes(job, { maxDescription: 24000 });
    }
    const parts = [];
    if (job.url) parts.push("Source: " + job.url);
    if (job.location) parts.push("Location: " + job.location);
    if (job.descriptionText || job.description || job.summary || job.snippet) {
      parts.push("");
      parts.push("Job description snapshot:");
      parts.push(String(job.descriptionText || job.description || job.summary || job.snippet || "").trim());
    } else {
      parts.push("");
      parts.push("Job description snapshot:");
      parts.push("No job description text was captured for this listing. Open the source listing and paste the full description here before tailoring materials.");
    }
    return parts.join("\n").trim();
  }

  function recordError(label, err) {
    const msg = (err && err.message) || String(err || "sync failed");
    errors.push({ when: new Date().toISOString(), label: label, error: msg });
    if (errors.length > 50) errors.shift();
    console.warn("[store.remote] " + label + ":", msg);
  }

  function fireAndForget(promise, label) {
    if (!promise) return;
    // Supabase's PostgrestBuilder is a thenable (has `.then`) but does NOT
    // implement `.catch` — calling it directly throws synchronously. Route
    // both paths through Promise.resolve + two-arg .then so we work with
    // real Promises, thenables, and any sync errors from the builder itself.
    try {
      if (typeof promise.then === "function") {
        promise.then(
          function () {},
          function (err) { recordError(label, err); }
        );
      } else {
        Promise.resolve(promise).catch(function (err) { recordError(label, err); });
      }
    } catch (err) {
      recordError(label, err);
    }
  }

  function trackUsage(eventName, metadata, options) {
    const usage = window.CBV2 && window.CBV2.usage;
    if (usage && typeof usage.track === "function") {
      usage.track(eventName, metadata || {}, options || {});
    }
  }

  function sourceHost(url) {
    try {
      return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
    } catch (err) {
      return "";
    }
  }

  function trimText(value, max) {
    const text = String(value == null ? "" : value);
    if (!max || text.length <= max) return text;
    return text.slice(0, max).trimEnd();
  }

  function compactJobSearchJob(job) {
    job = job || {};
    const copy = {};
    Object.keys(job).forEach(function (key) {
      const value = job[key];
      if (typeof value === "function") return;
      if (key === "descriptionText" || key === "description") {
        copy[key] = trimText(value, 18000);
        return;
      }
      if (key === "raw" || key === "payload" || key === "html") return;
      copy[key] = value;
    });
    return copy;
  }

  function normalizeJobSearchResultSet(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.slice(0, 120).map(compactJobSearchJob) : [];
    if (!jobs.length && !snapshot.at) return null;
    return {
      jobs: jobs,
      query: String(snapshot.query || ""),
      at: Number(snapshot.at || Date.now()),
      total: Number(snapshot.total || jobs.length || 0),
      roleProfile: snapshot.roleProfile || null,
      sort: String(snapshot.sort || "newest"),
      diagnostics: snapshot.diagnostics || null,
      sources: snapshot.sources || null,
      nlq: snapshot.nlq || null,
      filters: snapshot.filters && typeof snapshot.filters === "object" ? snapshot.filters : null
    };
  }

  function jobSearchResultsStorageKey() {
    return JOB_SEARCH_RESULTS_KEY + ":" + (userId || "anonymous");
  }

  function readStoredJobSearchResults() {
    try {
      if (!window.localStorage) return null;
      const raw = window.localStorage.getItem(jobSearchResultsStorageKey());
      return raw ? normalizeJobSearchResultSet(JSON.parse(raw)) : null;
    } catch (err) {
      return null;
    }
  }

  function writeStoredJobSearchResults(snapshot) {
    try {
      if (!window.localStorage) return;
      const clean = normalizeJobSearchResultSet(snapshot);
      if (!clean) {
        window.localStorage.removeItem(jobSearchResultsStorageKey());
        return;
      }
      window.localStorage.setItem(jobSearchResultsStorageKey(), JSON.stringify(clean));
    } catch (err) {
      recordError("persist job search results", err);
    }
  }

  function clearStoredJobSearchResults() {
    try {
      if (window.localStorage) window.localStorage.removeItem(jobSearchResultsStorageKey());
    } catch (err) {
      // ignore
    }
  }

  // --------- Row <-> app object mapping -----------------------------------
  function rowToApp(r) {
    const history = Array.isArray(r.stage_history) && r.stage_history.length
      ? r.stage_history
      : [{ stage: r.stage || "saved", at: r.applied_at || r.created_at || new Date().toISOString() }];
    return {
      id: r.id,
      company: r.company || "",
      role: r.role || "",
      stage: r.stage || "saved",
      priority: r.priority || "medium",
      appliedAt: r.applied_at || "",
      nextAction: r.next_action || "",
      notes: r.notes || "",
      jobUrl: r.source_url || "",
      stageHistory: history
    };
  }
  function appToRow(a) {
    return {
      id: a.id && a.id.indexOf("app_") === 0 ? undefined : a.id,
      user_id: userId,
      company: a.company || "",
      role: a.role || "",
      stage: a.stage || "saved",
      priority: a.priority || "medium",
      applied_at: a.appliedAt || null,
      next_action: a.nextAction || "",
      notes: a.notes || "",
      source_url: a.jobUrl || null,
      stage_history: Array.isArray(a.stageHistory) ? a.stageHistory : []
    };
  }

  function applicationRowsSignature(rows) {
    return (rows || []).map(function (r) {
      return [
        r.id || "",
        r.updated_at || "",
        r.company || "",
        r.role || "",
        r.stage || "",
        r.priority || "",
        r.applied_at || "",
        r.source_url || "",
        String(r.notes || "").length
      ].join("|");
    }).join("\n");
  }

  function applicationsSignature(apps) {
    return (apps || []).map(function (a) {
      return [
        a.id || "",
        a.company || "",
        a.role || "",
        a.stage || "",
        a.priority || "",
        a.appliedAt || "",
        a.jobUrl || "",
        String(a.notes || "").length
      ].join("|");
    }).join("\n");
  }

  function notifyStoreChange(area, detail) {
    try {
      window.dispatchEvent(new CustomEvent("cbv2:store-change", {
        detail: Object.assign({ area: area }, detail || {})
      }));
    } catch (err) {
      // Older embedded browsers can miss CustomEvent; route refresh still works.
    }

    if (area !== "applications") return;
    const state = window.CBV2.getState && window.CBV2.getState();
    const route = state && state.route;
    const liveRoutes = ["applications", "dashboard", "analytics", "interview", "resume", "cover-letter", "job-search"];
    if (liveRoutes.indexOf(route) < 0) return;
    if (typeof window.CBV2.renderCurrentRoute !== "function") return;
    setTimeout(function () {
      try {
        window.CBV2.renderCurrentRoute();
      } catch (err) {
        recordError("render after application sync", err);
      }
    }, 0);
  }

  async function refreshApplicationsFromRemote(options) {
    options = options || {};
    if (!client || !userId || refreshingApplications) return false;
    refreshingApplications = true;
    try {
      const result = await client.from("applications").select("*").order("updated_at", { ascending: false });
      if (result && result.error) {
        recordError("refresh applications", result.error);
        return false;
      }
      const rows = result && Array.isArray(result.data) ? result.data : [];
      const sig = applicationRowsSignature(rows);
      if (sig === lastApplicationsSignature) return false;
      cache.applications = rows.map(rowToApp);
      lastApplicationsSignature = sig || applicationsSignature(cache.applications);
      if (options.notify !== false) {
        notifyStoreChange("applications", { source: options.source || "remote" });
      }
      return true;
    } catch (err) {
      recordError("refresh applications", err);
      return false;
    } finally {
      refreshingApplications = false;
    }
  }

  function handleApplicationsFocus() {
    refreshApplicationsFromRemote({ source: "focus" });
  }

  function handleApplicationsVisibility() {
    if (document.visibilityState === "visible") {
      refreshApplicationsFromRemote({ source: "visible" });
    }
  }

  function stopApplicationsLiveSync() {
    if (applicationsPollTimer) {
      clearInterval(applicationsPollTimer);
      applicationsPollTimer = null;
    }
    window.removeEventListener("focus", handleApplicationsFocus);
    document.removeEventListener("visibilitychange", handleApplicationsVisibility);
    if (applicationsChannel && client) {
      try {
        if (typeof client.removeChannel === "function") {
          client.removeChannel(applicationsChannel);
        } else if (typeof applicationsChannel.unsubscribe === "function") {
          applicationsChannel.unsubscribe();
        }
      } catch (err) {
        recordError("stop application realtime", err);
      }
    }
    applicationsChannel = null;
  }

  function startApplicationsLiveSync() {
    stopApplicationsLiveSync();
    if (!client || !userId) return;
    try {
      if (typeof client.channel === "function") {
        applicationsChannel = client
          .channel("careerboost-applications-" + userId)
          .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: "applications",
            filter: "user_id=eq." + userId
          }, function () {
            refreshApplicationsFromRemote({ source: "realtime" });
          })
          .subscribe();
      }
    } catch (err) {
      recordError("start application realtime", err);
    }
    applicationsPollTimer = setInterval(function () {
      if (document.visibilityState === "hidden") return;
      refreshApplicationsFromRemote({ source: "poll" });
    }, 5000);
    window.addEventListener("focus", handleApplicationsFocus);
    document.addEventListener("visibilitychange", handleApplicationsVisibility);
  }

  function rowToEvent(r) {
    const start = r.start_at || r.event_date;
    const end = r.end_at || start;
    return {
      id: r.id,
      date: r.event_date || (start ? String(start).slice(0, 10) : ""),
      start: start,
      end: end,
      allDay: !!r.all_day,
      title: r.title,
      type: r.type,
      status: r.status || "planned",
      location: r.location || "",
      notes: r.notes || "",
      reminder: r.reminder || "none",
      appId: r.application_id || null
    };
  }

  function normalizeEvent(event) {
    const start = event.start || event.date || new Date().toISOString().slice(0, 16);
    const end = event.end || start;
    return {
      id: event.id || window.CBV2.createId("evt"),
      date: event.date || String(start).slice(0, 10),
      start: start,
      end: end,
      allDay: !!event.allDay,
      title: event.title || "",
      type: event.type || "other",
      status: event.status || "planned",
      location: event.location || "",
      notes: event.notes || "",
      reminder: event.reminder || "none",
      recurrence: event.recurrence || "none",
      recurrenceUntil: event.recurrenceUntil || "",
      appId: event.appId || null
    };
  }

  function eventToBaseRow(event) {
    return {
      user_id: userId,
      event_date: event.date,
      title: event.title,
      type: event.type,
      application_id: event.appId
    };
  }

  function eventToRichRow(event) {
    const base = eventToBaseRow(event);
    base.start_at = event.start || null;
    base.end_at = event.end || null;
    base.all_day = !!event.allDay;
    base.status = event.status || "planned";
    base.location = event.location || null;
    base.notes = event.notes || null;
    base.reminder = event.reminder || "none";
    base.recurrence = event.recurrence || "none";
    base.recurrence_until = event.recurrenceUntil || null;
    return base;
  }

  function insertEventWithFallback(event, onSuccess) {
    const rich = eventToRichRow(event);
    const base = eventToBaseRow(event);
    return client.from("events").insert(rich).select().single().then(function (r) {
      if (!r || !r.error) {
        if (onSuccess) onSuccess(r);
        return r;
      }
      return client.from("events").insert(base).select().single().then(function (fallback) {
        if (onSuccess) onSuccess(fallback);
        return fallback;
      });
    });
  }

  function updateEventWithFallback(id, event) {
    const rich = eventToRichRow(event);
    delete rich.user_id;
    const base = {
      event_date: event.date,
      title: event.title,
      type: event.type,
      application_id: event.appId
    };
    return client.from("events").update(rich).eq("id", id).then(function (r) {
      if (!r || !r.error) return r;
      return client.from("events").update(base).eq("id", id);
    });
  }
  function rowToSavedJob(r) {
    return {
      id: r.external_id,
      source: r.source,
      title: r.title,
      company: r.company,
      location: r.location,
      url: r.url,
      remote: !!r.remote,
      postedAt: r.posted_at,
      savedAt: r.saved_at
    };
  }
  function rowToSavedSearch(r) {
    return {
      id: r.id,
      name: r.name,
      query: r.query || "",
      filters: r.filters || {},
      lastRunAt: r.last_run_at,
      lastCount: r.last_count,
      lastTopIds: r.last_top_ids || []
    };
  }

  function resumeEnvelope(structured, result, tailor, savedCVs, defaultSavedCvId, careerAssets) {
    return {
      structured: structured || null,
      result: result || null,
      tailor: tailor || null,
      savedCVs: Array.isArray(savedCVs) ? savedCVs : [],
      defaultSavedCvId: defaultSavedCvId || "",
      careerAssets: Array.isArray(careerAssets) ? careerAssets : []
    };
  }

  // --------- Hydration ---------------------------------------------------
  async function hydrate() {
    if (!client || !userId) {
      cache = emptyCache();
      hydrated = false;
      return;
    }

    cache = emptyCache();

    const [apps, evts, res, cover, interview, saved, searches, keys] = await Promise.all([
      client.from("applications").select("*").order("updated_at", { ascending: false }),
      client.from("events").select("*").order("event_date", { ascending: true }),
      client.from("resumes").select("*").eq("user_id", userId).maybeSingle(),
      client.from("cover_letters").select("*").eq("user_id", userId).maybeSingle(),
      client.from("interview_sets").select("*").eq("user_id", userId).maybeSingle(),
      client.from("saved_jobs").select("*").order("saved_at", { ascending: false }),
      client.from("saved_searches").select("*").order("created_at", { ascending: false }),
      client.from("api_keys").select("*").eq("user_id", userId).maybeSingle()
    ]);

    if (apps.error) recordError("load applications", apps.error);
    else {
      cache.applications = (apps.data || []).map(rowToApp);
      lastApplicationsSignature = applicationRowsSignature(apps.data || []);
    }

    if (evts.error) recordError("load events", evts.error);
    else cache.events = (evts.data || []).map(rowToEvent);

    if (res.data) {
      // The `tailored` jsonb column now holds either the legacy tailor
      // result directly, or the envelope { structured, result, tailor }.
      const rawTailored = res.data.tailored || null;
      let structured = null;
      let tailored = rawTailored;
      let tailor = null;
      let savedCVs = [];
      let defaultSavedCvId = "";
      let careerAssets = [];
      if (rawTailored && typeof rawTailored === "object" && !Array.isArray(rawTailored) &&
          ("structured" in rawTailored || "result" in rawTailored || "tailor" in rawTailored || "savedCVs" in rawTailored || "defaultSavedCvId" in rawTailored || "careerAssets" in rawTailored)) {
        structured = rawTailored.structured || null;
        tailored = rawTailored.result || null;
        tailor = rawTailored.tailor || null;
        savedCVs = Array.isArray(rawTailored.savedCVs) ? rawTailored.savedCVs : [];
        defaultSavedCvId = typeof rawTailored.defaultSavedCvId === "string" ? rawTailored.defaultSavedCvId : "";
        careerAssets = Array.isArray(rawTailored.careerAssets) ? rawTailored.careerAssets : [];
      }
      cache.resume = {
        base: res.data.base_text || "",
        tailored: tailored,
        structured: structured,
        tailor: tailor,
        savedCVs: savedCVs,
        defaultSavedCvId: defaultSavedCvId,
        careerAssets: careerAssets,
        updatedAt: res.data.updated_at || ""
      };
    }
    if (cover.data) {
      const raw = cover.data.last_result || null;
      if (raw && typeof raw === "object" && !Array.isArray(raw) && ("lastResult" in raw || "variants" in raw || "sentLog" in raw)) {
        cache.coverLetter = {
          lastResult: raw.lastResult || null,
          variants: Array.isArray(raw.variants) ? raw.variants : [],
          activeVariantId: typeof raw.activeVariantId === "string" ? raw.activeVariantId : "",
          sentLog: Array.isArray(raw.sentLog) ? raw.sentLog : [],
          rolePacks: Array.isArray(raw.rolePacks) ? raw.rolePacks : [],
          activeRolePackId: typeof raw.activeRolePackId === "string" ? raw.activeRolePackId : ""
        };
      } else {
        cache.coverLetter = { lastResult: raw, variants: [], activeVariantId: "", sentLog: [], rolePacks: [], activeRolePackId: "" };
      }
    }
    if (interview.data) {
      cache.interview.lastSet = interview.data.last_set || null;
    }
    if (saved.data) cache.savedJobs = saved.data.map(rowToSavedJob);
    if (searches.data) cache.savedSearches = searches.data.map(rowToSavedSearch);
    if (keys.data) {
      cache.jobSearch.apiKeys = {
        adzunaAppId: keys.data.adzuna_app_id || "",
        adzunaAppKey: keys.data.adzuna_app_key || "",
        adzunaCountry: keys.data.adzuna_country || "gb",
        museKey: keys.data.muse_key || ""
      };
    }
    const rememberedResults = readStoredJobSearchResults();
    if (rememberedResults) {
      cache.jobSearch.lastResultSet = rememberedResults;
      cache.jobSearch.lastQuery = rememberedResults.query || cache.jobSearch.lastQuery || "";
      if (rememberedResults.filters) {
        cache.jobSearch.lastFilters = Object.assign({}, cache.jobSearch.lastFilters || {}, rememberedResults.filters);
      }
    }

    hydrated = true;
  }

  // --------- Public API (matches store.js) --------------------------------
  const remoteStore = {
    isRemote: true,
    isHydrated: function () { return hydrated; },

    getAll: function () { return cache; },

    getApplications: function () { return cache.applications.slice(); },
    refreshApplications: function () {
      return refreshApplicationsFromRemote({ source: "manual" });
    },
    getApplicationById: function (id) {
      return cache.applications.find(function (a) { return a.id === id; }) || null;
    },
    upsertApplication: function (app) {
      const idx = cache.applications.findIndex(function (a) { return a.id === app.id; });
      if (!Array.isArray(app.stageHistory) || !app.stageHistory.length) {
        app.stageHistory = [{ stage: app.stage || "saved", at: new Date().toISOString() }];
      }
      if (idx >= 0) {
        const prev = cache.applications[idx];
        if (prev && prev.stage !== app.stage) {
          app.stageHistory = (app.stageHistory || []).concat({
            stage: app.stage, at: new Date().toISOString(), from: prev.stage
          });
        }
        cache.applications[idx] = app;
      } else {
        cache.applications.unshift(app);
      }
      trackUsage(idx >= 0 ? "application_updated" : "application_created", {
        stage: app.stage || "saved",
        priority: app.priority || "medium",
        hasSource: Boolean(app.jobUrl),
        sourceHost: sourceHost(app.jobUrl)
      }, { module: "pipeline", route: "applications" });
      const row = appToRow(app);
      if (!row.id) {
        fireAndForget(
          client.from("applications").insert(row).select().single().then(function (r) {
            if (r.data && r.data.id) {
              app.id = r.data.id;
              const i = cache.applications.findIndex(function (a) { return a === app; });
              if (i >= 0) cache.applications[i] = rowToApp(r.data);
            }
          }),
          "upsertApplication(insert)"
        );
      } else {
        fireAndForget(
          client.from("applications").upsert(row).then(function () {}),
          "upsertApplication(update)"
        );
      }
    },
    updateApplicationFields: function (id, patch) {
      const app = cache.applications.find(function (a) { return a.id === id; });
      if (!app || !patch) return null;
      Object.assign(app, patch);
      const row = {};
      if (patch.company != null) row.company = patch.company;
      if (patch.role != null) row.role = patch.role;
      if (patch.priority != null) row.priority = patch.priority;
      if (patch.appliedAt != null) row.applied_at = patch.appliedAt || null;
      if (patch.nextAction != null) row.next_action = patch.nextAction;
      if (patch.notes != null) row.notes = patch.notes;
      if (patch.jobUrl != null) row.source_url = patch.jobUrl || null;
      if (Object.keys(row).length) {
        fireAndForget(
          client.from("applications").update(row).eq("id", id),
          "updateApplicationFields"
        );
      }
      return app;
    },
    deleteApplication: function (id) {
      cache.applications = cache.applications.filter(function (a) { return a.id !== id; });
      cache.events.forEach(function (e) { if (e.appId === id) e.appId = null; });
      fireAndForget(client.from("applications").delete().eq("id", id), "deleteApplication");
    },
    updateApplicationStage: function (id, stage) {
      const app = cache.applications.find(function (a) { return a.id === id; });
      if (!app || app.stage === stage) return;
      const from = app.stage;
      app.stage = stage;
      app.stageHistory = (app.stageHistory || []).concat({
        stage: stage, at: new Date().toISOString(), from: from
      });
      fireAndForget(
        client.from("applications").update({
          stage: stage,
          stage_history: app.stageHistory
        }).eq("id", id),
        "updateApplicationStage"
      );
      trackUsage("application_stage_changed", {
        fromStage: from,
        toStage: stage
      }, { module: "pipeline", route: "applications" });

      // Phase E3: auto-record a milestone in interview_outcomes when the
      // candidate moves an app to interview or offer. This is what makes
      // the admin North Star ("active placements 30d") a real, attributed
      // metric instead of a derived-from-stage approximation. We dedupe
      // by checking if an outcome of the same type for this application
      // already exists this calendar day — drag-and-drop oopses don't
      // create duplicate rows. Other outcome types (rejected_after_*,
      // withdrew_after_*) are NOT auto-recorded because they're richer
      // milestones the candidate adds explicitly.
      if (stage === "interview" || stage === "offer") {
        // userId is the module-level variable captured on signin — same
        // one used by every other remote-store operation in this file.
        if (!userId) return;
        const ownerUserId = userId;
        // sourceChannel: prefer host of source_url (acquisition channel
        // attribution for the placement). Falls back to null.
        let sourceChannel = null;
        try {
          if (app.sourceUrl || app.source_url) {
            const u = new URL(app.sourceUrl || app.source_url);
            sourceChannel = u.host.replace(/^www\./, "").toLowerCase().slice(0, 256);
          }
        } catch (e) { /* invalid URL — fine */ }
        const occurredAt = new Date().toISOString();
        const todayPrefix = occurredAt.slice(0, 10); // YYYY-MM-DD
        // Check-then-insert. Soft race condition (two stage flips in same
        // second) is harmless: at worst two rows for the same milestone,
        // which the rollup view dedups per outcome_type per window. Not
        // worth a server-side UNIQUE constraint.
        fireAndForget((async function () {
          const { data: existing } = await client
            .from("interview_outcomes")
            .select("id")
            .eq("user_id", ownerUserId)
            .eq("application_id", id)
            .eq("outcome_type", stage)
            .gte("occurred_at", todayPrefix + "T00:00:00Z")
            .limit(1);
          if (existing && existing.length) return null;
          return client.from("interview_outcomes").insert({
            user_id: ownerUserId,
            application_id: id,
            outcome_type: stage,
            occurred_at: occurredAt,
            company: app.company || null,
            role: app.role || null,
            source_channel: sourceChannel,
            notes: null
          });
        })(), "recordOutcome");
      }
    },
    getEventsForApplication: function (id) {
      return cache.events.filter(function (e) { return e.appId === id; });
    },
    addEvent: function (event) {
      if (!event) return null;
      const local = normalizeEvent(event);
      cache.events.push(local);
      trackUsage("calendar_event_created", {
        eventType: local.type || "other",
        hasApplication: Boolean(local.appId)
      }, { module: "calendar", route: "calendar" });
      fireAndForget(
        insertEventWithFallback(local, function (r) {
          if (r.data && r.data.id) {
            local.id = r.data.id;
          }
        }),
        "addEvent"
      );
      return local;
    },
    updateEvent: function (id, patch) {
      const idx = cache.events.findIndex(function (e) { return e.id === id; });
      if (idx < 0) return null;
      cache.events[idx] = normalizeEvent(Object.assign({}, cache.events[idx], patch || {}, { id: id }));
      const e = cache.events[idx];
      fireAndForget(
        updateEventWithFallback(id, e),
        "updateEvent"
      );
      return e;
    },
    deleteEvent: function (id) {
      cache.events = cache.events.filter(function (e) { return e.id !== id; });
      fireAndForget(client.from("events").delete().eq("id", id), "deleteEvent");
    },

    getEvents: function () {
      return cache.events.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    },

    setResumeBase: function (text) {
      cache.resume.base = text;
      cache.resume.updatedAt = new Date().toISOString();
      trackUsage("resume_base_saved", {
        characterCount: String(text || "").length,
        hasContent: String(text || "").trim().length > 0
      }, { module: "resume", route: "resume" });
      fireAndForget(
        client.from("resumes").upsert({ user_id: userId, base_text: text }),
        "setResumeBase"
      );
    },
    setResumeTailored: function (result) {
      cache.resume.tailored = result;
      cache.resume.updatedAt = new Date().toISOString();
      trackUsage("resume_tailored_saved", {
        hasResult: Boolean(result)
      }, { module: "resume", route: "resume" });
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            result,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "setResumeTailored"
      );
    },
    getResumeStructured: function () {
      return cache.resume.structured || null;
    },
    setResumeStructured: function (resume) {
      if (resume) resume.updatedAt = new Date().toISOString();
      cache.resume.structured = resume || null;
      cache.resume.updatedAt = new Date().toISOString();
      trackUsage("resume_structured_saved", {
        hasStructuredResume: Boolean(resume)
      }, { module: "resume", route: "resume" });
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          tailored: resumeEnvelope(
            resume || null,
            cache.resume.tailored || null,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "setResumeStructured"
      );
    },
    getResumeTailor: function () {
      return cache.resume.tailor || null;
    },
    setResumeTailor: function (state) {
      cache.resume.tailor = state || null;
      cache.resume.updatedAt = new Date().toISOString();
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            state || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "setResumeTailor"
      );
    },
    clearResumeTailor: function () {
      cache.resume.tailor = null;
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "clearResumeTailor"
      );
    },
    clearResume: function () {
      cache.resume = {
        base: "",
        tailored: null,
        structured: null,
        tailor: null,
        savedCVs: cache.resume.savedCVs || [],
        defaultSavedCvId: cache.resume.defaultSavedCvId || "",
        careerAssets: cache.resume.careerAssets || [],
        updatedAt: ""
      };
      fireAndForget(
        client.from("resumes").update({
          base_text: "",
          tailored: resumeEnvelope(
            null,
            null,
            null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }).eq("user_id", userId),
        "clearResume"
      );
    },
    getSavedCVs: function () {
      return (cache.resume.savedCVs || []).slice();
    },
    saveCurrentResumeAsSavedCV: function (payload) {
      payload = payload || {};
      const id = payload.id || window.CBV2.createId("cv");
      const now = new Date().toISOString();
      const item = {
        id: id,
        name: (payload.name || "").trim() || ("CV " + new Date(now).toLocaleDateString()),
        baseText: payload.baseText || cache.resume.base || "",
        structured: payload.structured || cache.resume.structured || null,
        source: payload.source || "resume-lab",
        createdAt: payload.createdAt || now,
        updatedAt: now
      };
      cache.resume.savedCVs = cache.resume.savedCVs || [];
      const idx = cache.resume.savedCVs.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) cache.resume.savedCVs[idx] = item;
      else cache.resume.savedCVs.unshift(item);
      if (!cache.resume.defaultSavedCvId) cache.resume.defaultSavedCvId = id;
      trackUsage("resume_version_saved", {
        source: item.source || "resume-lab",
        hasStructuredResume: Boolean(item.structured),
        characterCount: String(item.baseText || "").length
      }, { module: "resume", route: "resume" });
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          base_text: cache.resume.base || "",
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "saveCurrentResumeAsSavedCV"
      );
      return item;
    },
    deleteSavedCV: function (id) {
      cache.resume.savedCVs = (cache.resume.savedCVs || []).filter(function (x) { return x.id !== id; });
      if (cache.resume.defaultSavedCvId === id) {
        cache.resume.defaultSavedCvId = (cache.resume.savedCVs[0] && cache.resume.savedCVs[0].id) || "";
      }
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          base_text: cache.resume.base || "",
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "deleteSavedCV"
      );
    },
    getDefaultSavedCVId: function () {
      return cache.resume.defaultSavedCvId || "";
    },
    setDefaultSavedCV: function (id) {
      const exists = (cache.resume.savedCVs || []).some(function (x) { return x.id === id; });
      cache.resume.defaultSavedCvId = exists ? id : "";
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          base_text: cache.resume.base || "",
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "setDefaultSavedCV"
      );
    },
    getEffectiveResumeBaseText: function () {
      const id = cache.resume.defaultSavedCvId || "";
      if (id) {
        const match = (cache.resume.savedCVs || []).find(function (x) { return x.id === id; });
        if (match && match.baseText && match.baseText.trim()) return match.baseText;
      }
      return cache.resume.base || "";
    },
    getCareerAssets: function () {
      return (cache.resume.careerAssets || []).slice();
    },
    saveCareerAsset: function (payload) {
      payload = payload || {};
      const id = payload.id || window.CBV2.createId("asset");
      const now = new Date().toISOString();
      const item = {
        id: id,
        name: (payload.name || "").trim() || "Untitled asset",
        type: payload.type || "bullet",
        text: (payload.text || "").trim(),
        tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 8) : [],
        source: payload.source || "resume-lab",
        createdAt: payload.createdAt || now,
        updatedAt: now
      };
      if (!item.text) return null;
      cache.resume.careerAssets = cache.resume.careerAssets || [];
      const idx = cache.resume.careerAssets.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) cache.resume.careerAssets[idx] = item;
      else cache.resume.careerAssets.unshift(item);
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          base_text: cache.resume.base || "",
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "saveCareerAsset"
      );
      return item;
    },
    deleteCareerAsset: function (id) {
      cache.resume.careerAssets = (cache.resume.careerAssets || []).filter(function (x) { return x.id !== id; });
      fireAndForget(
        client.from("resumes").upsert({
          user_id: userId,
          base_text: cache.resume.base || "",
          tailored: resumeEnvelope(
            cache.resume.structured || null,
            cache.resume.tailored || null,
            cache.resume.tailor || null,
            cache.resume.savedCVs || [],
            cache.resume.defaultSavedCvId || "",
            cache.resume.careerAssets || []
          )
        }),
        "deleteCareerAsset"
      );
    },

    setCoverLetterResult: function (result) {
      cache.coverLetter.lastResult = result;
      trackUsage("cover_letter_generated", {
        hasResult: Boolean(result),
        provider: result && result.provider || ""
      }, { module: "cover-letter", route: "cover-letter" });
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "setCoverLetterResult"
      );
    },
    getCoverLetterState: function () {
      return cache.coverLetter || { lastResult: null, variants: [], activeVariantId: "", sentLog: [], rolePacks: [], activeRolePackId: "" };
    },
    saveCoverLetterVariant: function (payload) {
      payload = payload || {};
      const id = payload.id || window.CBV2.createId("clv");
      const now = new Date().toISOString();
      const item = {
        id: id,
        label: (payload.label || "").trim() || "Variant",
        subject: String(payload.subject || "").trim(),
        body: String(payload.body || "").trim(),
        template: String(payload.template || "professional-clean"),
        tone: String(payload.tone || "professional"),
        createdAt: payload.createdAt || now,
        updatedAt: now
      };
      cache.coverLetter.variants = cache.coverLetter.variants || [];
      const idx = cache.coverLetter.variants.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) cache.coverLetter.variants[idx] = item;
      else cache.coverLetter.variants.unshift(item);
      if (!cache.coverLetter.activeVariantId) cache.coverLetter.activeVariantId = id;
      trackUsage("cover_letter_variant_saved", {
        template: item.template,
        tone: item.tone,
        hasSubject: Boolean(item.subject)
      }, { module: "cover-letter", route: "cover-letter" });
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "saveCoverLetterVariant"
      );
      return item;
    },
    setActiveCoverLetterVariant: function (id) {
      const exists = (cache.coverLetter.variants || []).some(function (x) { return x.id === id; });
      cache.coverLetter.activeVariantId = exists ? id : "";
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "setActiveCoverLetterVariant"
      );
    },
    deleteCoverLetterVariant: function (id) {
      cache.coverLetter.variants = (cache.coverLetter.variants || []).filter(function (x) { return x.id !== id; });
      if (cache.coverLetter.activeVariantId === id) {
        cache.coverLetter.activeVariantId = (cache.coverLetter.variants[0] && cache.coverLetter.variants[0].id) || "";
      }
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "deleteCoverLetterVariant"
      );
    },
    logCoverLetterSent: function (payload) {
      payload = payload || {};
      const now = new Date().toISOString();
      const entry = {
        id: payload.id || window.CBV2.createId("cls"),
        variantId: String(payload.variantId || ""),
        variantLabel: String(payload.variantLabel || ""),
        company: String(payload.company || "").trim(),
        role: String(payload.role || "").trim(),
        channel: String(payload.channel || "portal"),
        sentAt: payload.sentAt || now,
        status: String(payload.status || "sent")
      };
      cache.coverLetter.sentLog = cache.coverLetter.sentLog || [];
      cache.coverLetter.sentLog.unshift(entry);
      trackUsage("cover_letter_sent_logged", {
        channel: entry.channel,
        status: entry.status
      }, { module: "cover-letter", route: "cover-letter" });
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "logCoverLetterSent"
      );
      return entry;
    },
    updateCoverLetterSentStatus: function (id, status) {
      const row = (cache.coverLetter.sentLog || []).find(function (x) { return x.id === id; });
      if (!row) return;
      row.status = String(status || "sent");
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "updateCoverLetterSentStatus"
      );
    },
    saveCoverLetterRolePack: function (payload) {
      payload = payload || {};
      const id = payload.id || window.CBV2.createId("clp");
      const now = new Date().toISOString();
      const item = {
        id: id,
        name: String(payload.name || "").trim() || "Role Pack",
        role: String(payload.role || "").trim(),
        tone: String(payload.tone || "professional"),
        length: String(payload.length || "medium"),
        strengths: String(payload.strengths || "").trim(),
        createdAt: payload.createdAt || now,
        updatedAt: now
      };
      cache.coverLetter.rolePacks = cache.coverLetter.rolePacks || [];
      const idx = cache.coverLetter.rolePacks.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) cache.coverLetter.rolePacks[idx] = item;
      else cache.coverLetter.rolePacks.unshift(item);
      if (!cache.coverLetter.activeRolePackId) cache.coverLetter.activeRolePackId = id;
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "saveCoverLetterRolePack"
      );
      return item;
    },
    setActiveCoverLetterRolePack: function (id) {
      const exists = (cache.coverLetter.rolePacks || []).some(function (x) { return x.id === id; });
      cache.coverLetter.activeRolePackId = exists ? id : "";
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "setActiveCoverLetterRolePack"
      );
    },
    deleteCoverLetterRolePack: function (id) {
      cache.coverLetter.rolePacks = (cache.coverLetter.rolePacks || []).filter(function (x) { return x.id !== id; });
      if (cache.coverLetter.activeRolePackId === id) {
        cache.coverLetter.activeRolePackId = (cache.coverLetter.rolePacks[0] && cache.coverLetter.rolePacks[0].id) || "";
      }
      fireAndForget(
        client.from("cover_letters").upsert({
          user_id: userId,
          last_result: {
            lastResult: cache.coverLetter.lastResult || null,
            variants: cache.coverLetter.variants || [],
            activeVariantId: cache.coverLetter.activeVariantId || "",
            sentLog: cache.coverLetter.sentLog || [],
            rolePacks: cache.coverLetter.rolePacks || [],
            activeRolePackId: cache.coverLetter.activeRolePackId || ""
          }
        }),
        "deleteCoverLetterRolePack"
      );
    },

    setInterviewSet: function (result) {
      cache.interview.lastSet = result;
      trackUsage("interview_questions_generated", {
        hasResult: Boolean(result),
        provider: result && result.provider || ""
      }, { module: "interview", route: "interview" });
      fireAndForget(
        client.from("interview_sets").upsert({ user_id: userId, last_set: result }),
        "setInterviewSet"
      );
    },
    getInterviewMockSession: function () {
      const s = cache.interview.mockSession;
      return s && typeof s === "object" ? JSON.parse(JSON.stringify(s)) : null;
    },
    setInterviewMockSession: function (session) {
      const hadSession = Boolean(cache.interview.mockSession);
      cache.interview.mockSession =
        session && typeof session === "object" ? JSON.parse(JSON.stringify(session)) : null;
      if (!hadSession && cache.interview.mockSession) {
        trackUsage("mock_interview_started", {
          turnCount: Array.isArray(cache.interview.mockSession.transcript) ? cache.interview.mockSession.transcript.length : 0
        }, { module: "interview", route: "interview" });
      }
    },
    getInterviewIntelSession: function () {
      const s = cache.interview.intelSession;
      return s && typeof s === "object" ? JSON.parse(JSON.stringify(s)) : null;
    },
    setInterviewIntelSession: function (session) {
      cache.interview.intelSession =
        session && typeof session === "object" ? JSON.parse(JSON.stringify(session)) : null;
      trackUsage("interview_research_generated", {
        hasSession: Boolean(cache.interview.intelSession)
      }, { module: "interview", route: "interview" });
    },

    reset: function () {
      fireAndForget(
        Promise.all([
          client.from("applications").delete().eq("user_id", userId),
          client.from("events").delete().eq("user_id", userId),
          client.from("saved_jobs").delete().eq("user_id", userId),
          client.from("saved_searches").delete().eq("user_id", userId),
          client.from("resumes").update({ base_text: "", tailored: null }).eq("user_id", userId),
          client.from("cover_letters").update({ last_result: null }).eq("user_id", userId),
          client.from("interview_sets").update({ last_set: null }).eq("user_id", userId)
        ]).then(function () { hydrate(); }),
        "reset"
      );
      cache = emptyCache();
    },

    getSavedJobs: function () { return cache.savedJobs.slice(); },
    isJobBookmarked: function (jobId) {
      return cache.savedJobs.some(function (j) { return j.id === jobId; });
    },
    bookmarkJob: function (job) {
      if (!job || !job.id) return;
      if (cache.savedJobs.some(function (j) { return j.id === job.id; })) return;
      const record = {
        id: job.id, source: job.source, title: job.title, company: job.company,
        location: job.location, url: job.url, remote: !!job.remote,
        postedAt: job.postedAt, savedAt: new Date().toISOString()
      };
      cache.savedJobs.unshift(record);
      trackUsage("job_saved", {
        source: job.source || "",
        sourceHost: sourceHost(job.url),
        hasRemoteSignal: Boolean(job.remote),
        hasRoleFit: Boolean(job.roleIntent)
      }, { module: "job-search", route: "job-search" });
      fireAndForget(
        client.from("saved_jobs").upsert({
          user_id: userId,
          external_id: job.id,
          source: job.source || "",
          title: job.title || "",
          company: job.company || "",
          location: job.location || "",
          url: job.url || "",
          remote: !!job.remote,
          posted_at: job.postedAt || null,
          payload: job
        }, { onConflict: "user_id,external_id" }),
        "bookmarkJob"
      );
    },
    unbookmarkJob: function (jobId) {
      cache.savedJobs = cache.savedJobs.filter(function (j) { return j.id !== jobId; });
      fireAndForget(
        client.from("saved_jobs").delete()
          .eq("user_id", userId).eq("external_id", jobId),
        "unbookmarkJob"
      );
    },

    getJobSearchState: function () { return cache.jobSearch; },
    setJobSearchState: function (next) {
      cache.jobSearch = Object.assign({}, cache.jobSearch, next || {});
      // lastQuery/lastFilters are transient UX state — keep in memory only.
    },
    getLastJobSearchResults: function () {
      return normalizeJobSearchResultSet(cache.jobSearch.lastResultSet);
    },
    setLastJobSearchResults: function (snapshot) {
      cache.jobSearch.lastResultSet = normalizeJobSearchResultSet(snapshot);
      if (cache.jobSearch.lastResultSet) {
        cache.jobSearch.lastQuery = cache.jobSearch.lastResultSet.query || cache.jobSearch.lastQuery || "";
        if (cache.jobSearch.lastResultSet.filters) {
          cache.jobSearch.lastFilters = Object.assign({}, cache.jobSearch.lastFilters || {}, cache.jobSearch.lastResultSet.filters);
        }
      }
      writeStoredJobSearchResults(cache.jobSearch.lastResultSet);
    },
    clearLastJobSearchResults: function () {
      cache.jobSearch.lastResultSet = null;
      clearStoredJobSearchResults();
    },
    recordJobSearchRun: function (entry) {
      if (!entry || typeof entry !== "object") return;
      cache.jobSearch.analytics = cache.jobSearch.analytics || { runs: [] };
      cache.jobSearch.analytics.runs = cache.jobSearch.analytics.runs || [];
      cache.jobSearch.analytics.runs.unshift(Object.assign({}, entry, { at: new Date().toISOString() }));
      if (cache.jobSearch.analytics.runs.length > 120) {
        cache.jobSearch.analytics.runs = cache.jobSearch.analytics.runs.slice(0, 120);
      }
      trackUsage("job_search_run", {
        total: Number(entry.total || entry.count || 0),
        queryLength: String(entry.query || "").length,
        sourceCount: entry.sources && typeof entry.sources === "object" ? Object.keys(entry.sources).length : 0,
        strictMode: Boolean(entry.strictMode)
      }, { module: "job-search", route: "job-search" });
    },
    getJobSearchAnalytics: function () {
      const a = cache.jobSearch.analytics || { runs: [] };
      return { runs: (a.runs || []).slice() };
    },

    getSavedSearches: function () { return (cache.savedSearches || []).slice(); },
    upsertSavedSearch: function (search) {
      if (!search) return null;
      const existing = search.id
        ? cache.savedSearches.find(function (s) { return s.id === search.id; })
        : null;
      if (existing) Object.assign(existing, search);
      else cache.savedSearches.unshift(search);
      trackUsage(existing ? "saved_search_updated" : "saved_search_created", {
        hasFilters: Boolean(search.filters),
        queryLength: String(search.query || "").length
      }, { module: "job-search", route: "job-search" });

      const row = {
        user_id: userId,
        name: search.name || "Untitled",
        query: search.query || "",
        filters: search.filters || {},
        last_run_at: search.lastRunAt || null,
        last_count: search.lastCount || null,
        last_top_ids: search.lastTopIds || []
      };
      if (search.id && /^[0-9a-f]{8}-/.test(search.id)) {
        row.id = search.id;
      }
      fireAndForget(
        client.from("saved_searches").upsert(row).select().single().then(function (r) {
          if (r.data && r.data.id && r.data.id !== search.id) {
            search.id = r.data.id;
          }
        }),
        "upsertSavedSearch"
      );
      return search;
    },
    deleteSavedSearch: function (id) {
      cache.savedSearches = cache.savedSearches.filter(function (s) { return s.id !== id; });
      fireAndForget(client.from("saved_searches").delete().eq("id", id), "deleteSavedSearch");
    },
    markSavedSearchRun: function (id, info) {
      const s = cache.savedSearches.find(function (x) { return x.id === id; });
      if (!s) return;
      s.lastRunAt = new Date().toISOString();
      if (info && typeof info.lastCount === "number") s.lastCount = info.lastCount;
      if (info && info.lastTopIds) s.lastTopIds = info.lastTopIds;
      if (info && typeof info.lastNewCount === "number") s.lastNewCount = info.lastNewCount;
      trackUsage("saved_search_run", {
        lastCount: s.lastCount || 0,
        lastNewCount: s.lastNewCount || 0
      }, { module: "job-search", route: "job-search" });
      fireAndForget(
        client.from("saved_searches").update({
          last_run_at: s.lastRunAt,
          last_count: s.lastCount,
          last_top_ids: s.lastTopIds || []
        }).eq("id", id),
        "markSavedSearchRun"
      );
    },

    getApiKeys: function () {
      return Object.assign({}, cache.jobSearch.apiKeys || {});
    },
    setApiKeys: function (next) {
      cache.jobSearch.apiKeys = Object.assign({}, cache.jobSearch.apiKeys || {}, next || {});
      fireAndForget(
        client.from("api_keys").upsert({
          user_id: userId,
          adzuna_app_id: cache.jobSearch.apiKeys.adzunaAppId || null,
          adzuna_app_key: cache.jobSearch.apiKeys.adzunaAppKey || null,
          adzuna_country: cache.jobSearch.apiKeys.adzunaCountry || "gb",
          muse_key: cache.jobSearch.apiKeys.museKey || null
        }),
        "setApiKeys"
      );
    },

    saveJobAsApplication: function (job) {
      if (!job) return null;
      const application = {
        id: window.CBV2.createId("app"),
        company: job.company || "",
        role: job.title || "",
        stage: "saved",
        priority: "medium",
        appliedAt: new Date().toISOString().slice(0, 10),
        nextAction: "Tailor resume and apply",
        notes: buildPipelineNotesFromJob(job),
        jobUrl: job.url || ""
      };
      // Reuse upsert path (strips client-side id, then adopts DB id).
      remoteStore.upsertApplication(application);
      trackUsage("job_moved_to_pipeline", {
        source: job.source || "",
        sourceHost: sourceHost(job.url),
        hasCapturedPosting: Boolean(job.descriptionText || job.description || job.summary || job.snippet)
      }, { module: "pipeline", route: "job-search" });
      return application;
    },
    saveApplicationFromJobUrl: function (rawUrl, meta) {
      meta = meta || {};
      const H = window.CBV2.jobListingUrlHelpers || {};
      const norm = typeof H.normalizeListingUrl === "function" ? H.normalizeListingUrl(rawUrl) : "";
      const urlKey = typeof H.urlKeyForDedup === "function" ? H.urlKeyForDedup : function (u) {
        try {
          var x = new URL(u);
          return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
        } catch (e0) {
          return String(u || "").toLowerCase().trim();
        }
      };
      const guessFn = typeof H.guessMetaFromJobUrl === "function" ? H.guessMetaFromJobUrl : function () {
        return { company: "Employer", role: "Role" };
      };
      const url = norm || (function () {
        var s = String(rawUrl || "").trim();
        if (!s) return "";
        if (!/^https?:\/\//i.test(s)) s = "https://" + s;
        try {
          var u = new URL(s);
          if (u.protocol !== "http:" && u.protocol !== "https:") return "";
          return u.href.split("#")[0];
        } catch (e1) {
          return "";
        }
      })();
      if (!url) {
        return { ok: false, error: "Enter a valid http(s) URL." };
      }
      const key = urlKey(url);
      const dup = cache.applications.some(function (a) {
        if (a.jobUrl && urlKey(a.jobUrl) === key) return true;
        return a.notes && String(a.notes).indexOf(url) >= 0;
      });
      if (dup) {
        return { ok: false, error: "That URL is already in your pipeline." };
      }
      const guess = guessFn(url);
      const company = String(meta.company || "").trim() || guess.company || "Employer";
      const role = String(meta.role || "").trim() || guess.role || "Role";
      const application = {
        id: window.CBV2.createId("app"),
        company: company,
        role: role,
        stage: "saved",
        priority: "medium",
        appliedAt: new Date().toISOString().slice(0, 10),
        nextAction: "Open posting, tailor materials, apply",
        notes: "Added from pasted URL (Tier C).\n" + url,
        jobUrl: url,
        stageHistory: [{ stage: "saved", at: new Date().toISOString() }]
      };
      remoteStore.upsertApplication(application);
      trackUsage("job_moved_to_pipeline", {
        source: "pasted-url",
        sourceHost: sourceHost(url),
        origin: "manual-url"
      }, { module: "pipeline", route: "applications" });
      return { ok: true, application: application };
    }
  };

  async function activate(supabaseClient, user) {
    stopApplicationsLiveSync();
    client = supabaseClient;
    userId = user.id;
    await hydrate();
    window.CBV2.store = remoteStore;
    window.CBV2.syncErrors = errors;
    startApplicationsLiveSync();
  }

  function deactivate() {
    stopApplicationsLiveSync();
    client = null;
    userId = null;
    hydrated = false;
    cache = emptyCache();
    lastApplicationsSignature = "";
  }

  // Import everything from the local store into Supabase (one-shot migration).
  async function importLocal(localCache) {
    if (!client || !userId || !localCache) return;

    if (Array.isArray(localCache.applications) && localCache.applications.length) {
      const rows = localCache.applications
        .filter(function (a) { return a && a.id && a.id.indexOf("app_") !== 0; })
        .map(appToRow);
      const seededRows = localCache.applications
        .filter(function (a) { return a && (!a.id || a.id.indexOf("app_") === 0); })
        .map(function (a) { const r = appToRow(a); delete r.id; return r; });
      if (rows.length) await client.from("applications").upsert(rows);
      if (seededRows.length) await client.from("applications").insert(seededRows);
    }

    if (Array.isArray(localCache.events) && localCache.events.length) {
      const rows = localCache.events.map(function (e) {
        return eventToRichRow(normalizeEvent(e || {}));
      });
      const richInsert = await client.from("events").insert(rows);
      if (richInsert && richInsert.error) {
        const fallbackRows = localCache.events.map(function (e) {
          return eventToBaseRow(normalizeEvent(e || {}));
        });
        await client.from("events").insert(fallbackRows);
      }
    }

    if (localCache.resume) {
      await client.from("resumes").upsert({
        user_id: userId,
        base_text: localCache.resume.base || "",
        tailored: resumeEnvelope(
          localCache.resume.structured || null,
          localCache.resume.tailored || null,
          localCache.resume.tailor || null,
          localCache.resume.savedCVs || [],
          localCache.resume.defaultSavedCvId || "",
          localCache.resume.careerAssets || []
        )
      });
    }

    if (localCache.coverLetter && (localCache.coverLetter.lastResult || (localCache.coverLetter.variants || []).length || (localCache.coverLetter.sentLog || []).length)) {
      await client.from("cover_letters").upsert({
        user_id: userId,
        last_result: {
          lastResult: localCache.coverLetter.lastResult || null,
          variants: localCache.coverLetter.variants || [],
          activeVariantId: localCache.coverLetter.activeVariantId || "",
          sentLog: localCache.coverLetter.sentLog || [],
          rolePacks: localCache.coverLetter.rolePacks || [],
          activeRolePackId: localCache.coverLetter.activeRolePackId || ""
        }
      });
    }

    if (localCache.interview && localCache.interview.lastSet) {
      await client.from("interview_sets").upsert({
        user_id: userId,
        last_set: localCache.interview.lastSet
      });
    }

    if (Array.isArray(localCache.savedJobs) && localCache.savedJobs.length) {
      const rows = localCache.savedJobs.map(function (j) {
        return {
          user_id: userId,
          external_id: j.id,
          source: j.source || "",
          title: j.title || "",
          company: j.company || "",
          location: j.location || "",
          url: j.url || "",
          remote: !!j.remote,
          posted_at: j.postedAt || null,
          payload: j
        };
      });
      await client.from("saved_jobs").upsert(rows, { onConflict: "user_id,external_id" });
    }

    if (Array.isArray(localCache.savedSearches) && localCache.savedSearches.length) {
      const rows = localCache.savedSearches.map(function (s) {
        return {
          user_id: userId,
          name: s.name || "Untitled",
          query: s.query || "",
          filters: s.filters || {},
          last_run_at: s.lastRunAt || null,
          last_count: s.lastCount || null,
          last_top_ids: s.lastTopIds || []
        };
      });
      await client.from("saved_searches").insert(rows);
    }

    if (localCache.jobSearch && localCache.jobSearch.apiKeys) {
      const k = localCache.jobSearch.apiKeys;
      if (k.adzunaAppId || k.adzunaAppKey || k.museKey) {
        await client.from("api_keys").upsert({
          user_id: userId,
          adzuna_app_id: k.adzunaAppId || null,
          adzuna_app_key: k.adzunaAppKey || null,
          adzuna_country: k.adzunaCountry || "gb",
          muse_key: k.museKey || null
        });
      }
    }

    await hydrate();
  }

  window.CBV2.remoteStore = {
    activate,
    deactivate,
    hydrate,
    refreshApplications: function () { return refreshApplicationsFromRemote({ source: "manual" }); },
    importLocal,
    getErrors: function () { return errors.slice(); }
  };
})();
