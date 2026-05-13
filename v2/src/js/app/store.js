(function () {
  window.CBV2 = window.CBV2 || {};

  const KEY = "cbv2_store_v1";

  function buildPipelineNotesFromJob(job) {
    job = job || {};
    const notes = window.CBV2.jobNotes;
    if (notes && typeof notes.buildImportedNotes === "function") {
      return notes.buildImportedNotes(job, { maxDescription: 24000 });
    }
    const parts = [];
    if (job.url) parts.push("Source: " + job.url);
    if (job.location) parts.push("Location: " + job.location);
    if (job.descriptionText || job.description) {
      parts.push("");
      parts.push("Job description snapshot:");
      parts.push(String(job.descriptionText || job.description || "").trim());
    }
    return parts.join("\n").trim();
  }

  function seedDefaults() {
    return {
      applications: [
        {
          id: "app_1",
          company: "Nova Labs",
          role: "Product Manager",
          stage: "applied",
          priority: "high",
          appliedAt: "2026-04-10",
          nextAction: "Follow up with hiring manager",
          notes: "Referred by Sam"
        },
        {
          id: "app_2",
          company: "Orbit Works",
          role: "Frontend Engineer",
          stage: "saved",
          priority: "medium",
          appliedAt: "2026-04-14",
          nextAction: "Tailor resume",
          notes: "React + TypeScript"
        },
        {
          id: "app_3",
          company: "Apex Systems",
          role: "Full Stack Developer",
          stage: "interview",
          priority: "high",
          appliedAt: "2026-04-05",
          nextAction: "Prep behavioral + coding round",
          notes: "Interview on Monday"
        },
        {
          id: "app_4",
          company: "Flux AI",
          role: "Senior Engineer",
          stage: "offer",
          priority: "high",
          appliedAt: "2026-03-22",
          nextAction: "Negotiate salary",
          notes: "Offer valid 7 days"
        },
        {
          id: "app_5",
          company: "Quantum Retail",
          role: "UI Engineer",
          stage: "rejected",
          priority: "low",
          appliedAt: "2026-03-18",
          nextAction: "Request feedback",
          notes: ""
        }
      ],
      events: [
        { id: "evt_1", date: "2026-04-20", title: "Apex Systems interview", type: "interview" },
        { id: "evt_2", date: "2026-04-22", title: "Follow up: Nova Labs", type: "followup" },
        { id: "evt_3", date: "2026-04-25", title: "Offer deadline: Flux AI", type: "deadline" }
      ],
      resume: {
        base: "",
        tailored: null,
        structured: null,
        tailor: null,
        // Saved reusable CV snapshots (for quick apply flows)
        savedCVs: [],
        defaultSavedCvId: "",
        // Phase 6: reusable resume building blocks
        careerAssets: [],
        updatedAt: ""
      },
      coverLetter: {
        lastResult: null,
        variants: [],
        activeVariantId: "",
        sentLog: [],
        rolePacks: [],
        activeRolePackId: ""
      },
      interview: {
        lastSet: null,
        mockSession: null,
        intelSession: null
      },
      savedJobs: [],
      savedSearches: [],
      jobSearch: {
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
          locationStrictness: "strict"
        },
        nlqEnabled: true,
        openGoogleAfterSearch: false,
        roleProfile: {
          targetTitles: [],
          seniority: "any",
          mustHaveSkills: [],
          excludeKeywords: [],
          strictMode: false
        },
        analytics: {
          runs: []
        },
        lastResultSet: null,
        apiKeys: {
          adzunaAppId: "",
          adzunaAppKey: "",
          adzunaCountry: "gb",
          museKey: ""
        }
      }
    };
  }

  function ensureShape(data) {
    if (!data.savedJobs) data.savedJobs = [];
    if (!data.savedSearches) data.savedSearches = [];
    if (!data.resume) data.resume = { base: "", tailored: null, structured: null, tailor: null, savedCVs: [], defaultSavedCvId: "", careerAssets: [], updatedAt: "" };
    if (data.resume.structured === undefined) data.resume.structured = null;
    if (data.resume.tailor === undefined) data.resume.tailor = null;
    if (!Array.isArray(data.resume.savedCVs)) data.resume.savedCVs = [];
    if (typeof data.resume.defaultSavedCvId !== "string") data.resume.defaultSavedCvId = "";
    if (!Array.isArray(data.resume.careerAssets)) data.resume.careerAssets = [];
    if (!data.coverLetter || typeof data.coverLetter !== "object") {
      data.coverLetter = { lastResult: null, variants: [], activeVariantId: "", sentLog: [], rolePacks: [], activeRolePackId: "" };
    }
    if (!Array.isArray(data.coverLetter.variants)) data.coverLetter.variants = [];
    if (!Array.isArray(data.coverLetter.sentLog)) data.coverLetter.sentLog = [];
    if (!Array.isArray(data.coverLetter.rolePacks)) data.coverLetter.rolePacks = [];
    if (typeof data.coverLetter.activeVariantId !== "string") data.coverLetter.activeVariantId = "";
    if (typeof data.coverLetter.activeRolePackId !== "string") data.coverLetter.activeRolePackId = "";
    if (!data.jobSearch) {
      data.jobSearch = {
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
          locationStrictness: "strict"
        },
        nlqEnabled: true,
        openGoogleAfterSearch: false,
        roleProfile: { targetTitles: [], seniority: "any", mustHaveSkills: [], excludeKeywords: [], strictMode: false },
        analytics: { runs: [] },
        lastResultSet: null,
        apiKeys: { adzunaAppId: "", adzunaAppKey: "", adzunaCountry: "gb", museKey: "" }
      };
    }
    if (!data.jobSearch.lastFilters || typeof data.jobSearch.lastFilters !== "object") {
      data.jobSearch.lastFilters = {};
    }
    if (typeof data.jobSearch.lastFilters.remoteOnly !== "boolean") data.jobSearch.lastFilters.remoteOnly = false;
    if (!Number.isFinite(Number(data.jobSearch.lastFilters.postedWithinDays))) data.jobSearch.lastFilters.postedWithinDays = 0;
    if (typeof data.jobSearch.lastFilters.sort !== "string") data.jobSearch.lastFilters.sort = "relevance";
    if (typeof data.jobSearch.lastFilters.location !== "string") data.jobSearch.lastFilters.location = "";
    if (!Array.isArray(data.jobSearch.lastFilters.jobType)) data.jobSearch.lastFilters.jobType = [];
    if (!Array.isArray(data.jobSearch.lastFilters.experienceLevel)) data.jobSearch.lastFilters.experienceLevel = [];
    if (typeof data.jobSearch.lastFilters.activeOnly !== "boolean") data.jobSearch.lastFilters.activeOnly = true;
    if (typeof data.jobSearch.lastFilters.searchRegion !== "string") data.jobSearch.lastFilters.searchRegion = "global";
    if (typeof data.jobSearch.lastFilters.locationStrictness !== "string") data.jobSearch.lastFilters.locationStrictness = "strict";
    if (typeof data.jobSearch.nlqEnabled !== "boolean") {
      data.jobSearch.nlqEnabled = true;
    }
    if (typeof data.jobSearch.openGoogleAfterSearch !== "boolean") {
      data.jobSearch.openGoogleAfterSearch = false;
    }
    if (!data.jobSearch.roleProfile || typeof data.jobSearch.roleProfile !== "object") {
      data.jobSearch.roleProfile = {
        targetTitles: [],
        seniority: "any",
        mustHaveSkills: [],
        excludeKeywords: [],
        strictMode: false
      };
    }
    if (typeof data.jobSearch.roleProfile.strictMode !== "boolean") {
      data.jobSearch.roleProfile.strictMode = false;
    }
    if (!data.jobSearch.analytics || typeof data.jobSearch.analytics !== "object") {
      data.jobSearch.analytics = { runs: [] };
    }
    if (!Array.isArray(data.jobSearch.analytics.runs)) {
      data.jobSearch.analytics.runs = [];
    }
    if (data.jobSearch.lastResultSet && typeof data.jobSearch.lastResultSet === "object") {
      data.jobSearch.lastResultSet = normalizeJobSearchResultSet(data.jobSearch.lastResultSet);
    } else {
      data.jobSearch.lastResultSet = null;
    }
    if (!data.jobSearch.apiKeys) {
      data.jobSearch.apiKeys = { adzunaAppId: "", adzunaAppKey: "", adzunaCountry: "gb", museKey: "" };
    }
    // Phase C: backfill stage_history for pre-existing apps. We can't know
    // prior transitions retroactively, so we seed with a single entry for the
    // current stage using appliedAt (or today) as a best-effort timestamp.
    if (Array.isArray(data.applications)) {
      data.applications.forEach(function (a) {
        if (!Array.isArray(a.stageHistory) || !a.stageHistory.length) {
          a.stageHistory = [{
            stage: a.stage || "saved",
            at: (a.appliedAt || new Date().toISOString().slice(0, 10))
          }];
        }
      });
    }
    if (Array.isArray(data.events)) {
      data.events = data.events.map(function (e) {
        const normalized = normalizeEvent(e || {});
        if (normalized.appId === undefined) normalized.appId = null;
        return normalized;
      });
    }
    if (!data.interview || typeof data.interview !== "object") {
      data.interview = { lastSet: null, mockSession: null, intelSession: null };
    } else {
      if (data.interview.mockSession === undefined) {
        data.interview.mockSession = null;
      }
      if (data.interview.intelSession === undefined) {
        data.interview.intelSession = null;
      }
    }
    return data;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        const seed = seedDefaults();
        localStorage.setItem(KEY, JSON.stringify(seed));
        return seed;
      }
      return ensureShape(JSON.parse(raw));
    } catch (error) {
      return seedDefaults();
    }
  }

  // Phase 3: debounced persist. Drag-drop on a 200-app pipeline, rapid form
  // edits, and chat-style interview transcripts all hit persist() many times
  // per second. Each call re-serializes the ENTIRE store to JSON and writes
  // to localStorage (~40KB+ for active users). Debouncing batches bursts
  // into a single trailing write.
  //
  // Flushed synchronously on `pagehide` / `beforeunload` so unsaved bursts
  // aren't lost when the user closes the tab. Falls back to synchronous
  // persist when running in a sandboxed environment without setTimeout
  // (the vm-context unit-test runner).
  const HAS_TIMERS = typeof setTimeout === "function" && typeof clearTimeout === "function";
  let persistTimer = null;
  let persistPending = null;
  const PERSIST_DEBOUNCE_MS = 200;

  function persistNow(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (error) {
      // ignore (quota / privacy mode)
    }
  }

  function persist(data) {
    if (!HAS_TIMERS) {
      persistNow(data);
      return;
    }
    persistPending = data;
    if (persistTimer != null) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      const snap = persistPending;
      persistPending = null;
      if (snap) persistNow(snap);
    }, PERSIST_DEBOUNCE_MS);
  }

  function flushPersist() {
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (persistPending) {
      persistNow(persistPending);
      persistPending = null;
    }
  }

  // Survive tab close / mobile backgrounding without losing pending writes.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flushPersist);
    window.addEventListener("beforeunload", flushPersist);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") flushPersist();
      });
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

  function normalizeListingUrl(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      var u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.href.split("#")[0];
    } catch (e) {
      return "";
    }
  }

  function urlKeyForDedup(url) {
    try {
      var u = new URL(url);
      return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
    } catch (e) {
      return String(url || "").toLowerCase().trim();
    }
  }

  function guessMetaFromJobUrl(url) {
    var host = "";
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return { company: "", role: "" };
    }
    if (host.indexOf("linkedin.com") >= 0) {
      return { company: "LinkedIn", role: "Job listing" };
    }
    if (host.indexOf("indeed.") >= 0 || host === "indeed.com") {
      return { company: "Indeed", role: "Job listing" };
    }
    if (host.indexOf("glassdoor.com") >= 0) {
      return { company: "Glassdoor", role: "Job listing" };
    }
    if (host.indexOf("greenhouse.io") >= 0 || host.indexOf("lever.co") >= 0) {
      return { company: "ATS posting", role: "Job listing" };
    }
    return { company: host.split(".")[0] || "Employer", role: "Role from link" };
  }

  window.CBV2.jobListingUrlHelpers = {
    normalizeListingUrl: normalizeListingUrl,
    urlKeyForDedup: urlKeyForDedup,
    guessMetaFromJobUrl: guessMetaFromJobUrl
  };

  let cache = load();

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

  window.CBV2.store = {
    getAll: function () {
      return cache;
    },
    getApplications: function () {
      return cache.applications.slice();
    },
    upsertApplication: function (app) {
      const idx = cache.applications.findIndex(function (a) {
        return a.id === app.id;
      });
      if (!Array.isArray(app.stageHistory) || !app.stageHistory.length) {
        app.stageHistory = [{
          stage: app.stage || "saved",
          at: new Date().toISOString()
        }];
      }
      if (idx >= 0) {
        // Keep history from the existing row if the caller didn't provide one.
        const prev = cache.applications[idx];
        if ((!app.stageHistory || !app.stageHistory.length) && prev.stageHistory) {
          app.stageHistory = prev.stageHistory;
        }
        // If stage changed, append a transition entry.
        if (prev && prev.stage !== app.stage) {
          app.stageHistory = (app.stageHistory || []).concat({
            stage: app.stage, at: new Date().toISOString(), from: prev.stage
          });
        }
        cache.applications[idx] = app;
      } else {
        cache.applications.push(app);
      }
      persist(cache);
      trackUsage(idx >= 0 ? "application_updated" : "application_created", {
        stage: app.stage || "saved",
        priority: app.priority || "medium",
        hasSource: Boolean(app.jobUrl),
        sourceHost: sourceHost(app.jobUrl)
      }, { module: "pipeline", route: "applications" });
    },
    deleteApplication: function (id) {
      cache.applications = cache.applications.filter(function (a) {
        return a.id !== id;
      });
      // Unlink any events previously attached to this app.
      cache.events.forEach(function (e) { if (e.appId === id) e.appId = null; });
      persist(cache);
    },
    updateApplicationStage: function (id, stage) {
      const app = cache.applications.find(function (a) {
        return a.id === id;
      });
      if (app && app.stage !== stage) {
        const from = app.stage;
        app.stage = stage;
        app.stageHistory = (app.stageHistory || []).concat({
          stage: stage, at: new Date().toISOString(), from: from
        });
        persist(cache);
        trackUsage("application_stage_changed", {
          fromStage: from,
          toStage: stage
        }, { module: "pipeline", route: "applications" });
      }
    },
    getApplicationById: function (id) {
      return cache.applications.find(function (a) { return a.id === id; }) || null;
    },
    updateApplicationFields: function (id, patch) {
      const app = cache.applications.find(function (a) { return a.id === id; });
      if (!app || !patch) return null;
      Object.assign(app, patch);
      persist(cache);
      return app;
    },
    getEventsForApplication: function (id) {
      return cache.events.filter(function (e) { return e.appId === id; });
    },
    addEvent: function (event) {
      if (!event) return null;
      const created = normalizeEvent(event);
      cache.events.push(created);
      persist(cache);
      trackUsage("calendar_event_created", {
        eventType: created.type || "other",
        hasApplication: Boolean(created.appId)
      }, { module: "calendar", route: "calendar" });
      return created;
    },
    updateEvent: function (id, patch) {
      const idx = cache.events.findIndex(function (e) { return e.id === id; });
      if (idx < 0) return null;
      cache.events[idx] = normalizeEvent(Object.assign({}, cache.events[idx], patch || {}, { id: id }));
      persist(cache);
      return cache.events[idx];
    },
    deleteEvent: function (id) {
      cache.events = cache.events.filter(function (e) { return e.id !== id; });
      persist(cache);
    },
    getEvents: function () {
      return cache.events.slice().sort(function (a, b) {
        return a.date.localeCompare(b.date);
      });
    },
    setResumeBase: function (text) {
      cache.resume.base = text;
      cache.resume.updatedAt = new Date().toISOString();
      persist(cache);
      trackUsage("resume_base_saved", {
        characterCount: String(text || "").length,
        hasContent: String(text || "").trim().length > 0
      }, { module: "resume", route: "resume" });
    },
    setResumeTailored: function (result) {
      cache.resume.tailored = result;
      // Tailoring counts as "touched" — keep the freshness indicator green
      // when the user is actively working on the resume.
      cache.resume.updatedAt = new Date().toISOString();
      persist(cache);
      trackUsage("resume_tailored_saved", {
        hasResult: Boolean(result)
      }, { module: "resume", route: "resume" });
    },
    getResumeStructured: function () {
      return cache.resume.structured || null;
    },
    setResumeStructured: function (resume) {
      if (resume) {
        resume.updatedAt = new Date().toISOString();
      }
      cache.resume.structured = resume || null;
      cache.resume.updatedAt = new Date().toISOString();
      persist(cache);
      trackUsage("resume_structured_saved", {
        hasStructuredResume: Boolean(resume)
      }, { module: "resume", route: "resume" });
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
      persist(cache);
    },
    getResumeTailor: function () {
      return cache.resume.tailor || null;
    },
    setResumeTailor: function (state) {
      cache.resume.tailor = state || null;
      cache.resume.updatedAt = new Date().toISOString();
      persist(cache);
    },
    clearResumeTailor: function () {
      cache.resume.tailor = null;
      persist(cache);
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
      persist(cache);
      trackUsage("resume_version_saved", {
        source: item.source || "resume-lab",
        hasStructuredResume: Boolean(item.structured),
        characterCount: String(item.baseText || "").length
      }, { module: "resume", route: "resume" });
      return item;
    },
    deleteSavedCV: function (id) {
      cache.resume.savedCVs = (cache.resume.savedCVs || []).filter(function (x) { return x.id !== id; });
      if (cache.resume.defaultSavedCvId === id) {
        cache.resume.defaultSavedCvId = (cache.resume.savedCVs[0] && cache.resume.savedCVs[0].id) || "";
      }
      persist(cache);
    },
    getDefaultSavedCVId: function () {
      return cache.resume.defaultSavedCvId || "";
    },
    setDefaultSavedCV: function (id) {
      const exists = (cache.resume.savedCVs || []).some(function (x) { return x.id === id; });
      cache.resume.defaultSavedCvId = exists ? id : "";
      persist(cache);
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
      persist(cache);
      return item;
    },
    deleteCareerAsset: function (id) {
      cache.resume.careerAssets = (cache.resume.careerAssets || []).filter(function (x) { return x.id !== id; });
      persist(cache);
    },
    setCoverLetterResult: function (result) {
      cache.coverLetter.lastResult = result;
      persist(cache);
      trackUsage("cover_letter_generated", {
        hasResult: Boolean(result),
        provider: result && result.provider || ""
      }, { module: "cover-letter", route: "cover-letter" });
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
      persist(cache);
      trackUsage("cover_letter_variant_saved", {
        template: item.template,
        tone: item.tone,
        hasSubject: Boolean(item.subject)
      }, { module: "cover-letter", route: "cover-letter" });
      return item;
    },
    setActiveCoverLetterVariant: function (id) {
      const exists = (cache.coverLetter.variants || []).some(function (x) { return x.id === id; });
      cache.coverLetter.activeVariantId = exists ? id : "";
      persist(cache);
    },
    deleteCoverLetterVariant: function (id) {
      cache.coverLetter.variants = (cache.coverLetter.variants || []).filter(function (x) { return x.id !== id; });
      if (cache.coverLetter.activeVariantId === id) {
        cache.coverLetter.activeVariantId = (cache.coverLetter.variants[0] && cache.coverLetter.variants[0].id) || "";
      }
      persist(cache);
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
      persist(cache);
      trackUsage("cover_letter_sent_logged", {
        channel: entry.channel,
        status: entry.status
      }, { module: "cover-letter", route: "cover-letter" });
      return entry;
    },
    updateCoverLetterSentStatus: function (id, status) {
      const row = (cache.coverLetter.sentLog || []).find(function (x) { return x.id === id; });
      if (!row) return;
      row.status = String(status || "sent");
      persist(cache);
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
      persist(cache);
      return item;
    },
    setActiveCoverLetterRolePack: function (id) {
      const exists = (cache.coverLetter.rolePacks || []).some(function (x) { return x.id === id; });
      cache.coverLetter.activeRolePackId = exists ? id : "";
      persist(cache);
    },
    deleteCoverLetterRolePack: function (id) {
      cache.coverLetter.rolePacks = (cache.coverLetter.rolePacks || []).filter(function (x) { return x.id !== id; });
      if (cache.coverLetter.activeRolePackId === id) {
        cache.coverLetter.activeRolePackId = (cache.coverLetter.rolePacks[0] && cache.coverLetter.rolePacks[0].id) || "";
      }
      persist(cache);
    },
    setInterviewSet: function (result) {
      cache.interview.lastSet = result;
      persist(cache);
      trackUsage("interview_questions_generated", {
        hasResult: Boolean(result),
        provider: result && result.provider || ""
      }, { module: "interview", route: "interview" });
    },
    /** Persisted Phase B mock interview (transcript snapshot + optional debrief). */
    getInterviewMockSession: function () {
      const s = cache.interview.mockSession;
      return s && typeof s === "object" ? JSON.parse(JSON.stringify(s)) : null;
    },
    setInterviewMockSession: function (session) {
      const hadSession = Boolean(cache.interview.mockSession);
      cache.interview.mockSession =
        session && typeof session === "object" ? JSON.parse(JSON.stringify(session)) : null;
      persist(cache);
      if (!hadSession && cache.interview.mockSession) {
        trackUsage("mock_interview_started", {
          turnCount: Array.isArray(cache.interview.mockSession.transcript) ? cache.interview.mockSession.transcript.length : 0
        }, { module: "interview", route: "interview" });
      }
    },
    /** Phase A grounded company research + AI pack snapshot. */
    getInterviewIntelSession: function () {
      const s = cache.interview.intelSession;
      return s && typeof s === "object" ? JSON.parse(JSON.stringify(s)) : null;
    },
    setInterviewIntelSession: function (session) {
      cache.interview.intelSession =
        session && typeof session === "object" ? JSON.parse(JSON.stringify(session)) : null;
      persist(cache);
      trackUsage("interview_research_generated", {
        hasSession: Boolean(cache.interview.intelSession)
      }, { module: "interview", route: "interview" });
    },
    reset: function () {
      cache = seedDefaults();
      persist(cache);
    },
    getSavedJobs: function () {
      return cache.savedJobs.slice();
    },
    isJobBookmarked: function (jobId) {
      return cache.savedJobs.some(function (j) {
        return j.id === jobId;
      });
    },
    bookmarkJob: function (job) {
      if (!job || !job.id) return;
      if (cache.savedJobs.some(function (j) { return j.id === job.id; })) return;
      cache.savedJobs.unshift({
        id: job.id,
        source: job.source,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        remote: !!job.remote,
        postedAt: job.postedAt,
        savedAt: new Date().toISOString(),
        roleFitScore: job.roleIntent && typeof job.roleIntent.score === "number" ? job.roleIntent.score : null,
        roleReasons: job.roleIntent && Array.isArray(job.roleIntent.reasons) ? job.roleIntent.reasons.slice(0, 3) : [],
        roleProfile: job.roleProfile || null
      });
      persist(cache);
      trackUsage("job_saved", {
        source: job.source || "",
        sourceHost: sourceHost(job.url),
        hasRemoteSignal: Boolean(job.remote),
        hasRoleFit: Boolean(job.roleIntent)
      }, { module: "job-search", route: "job-search" });
    },
    unbookmarkJob: function (jobId) {
      cache.savedJobs = cache.savedJobs.filter(function (j) {
        return j.id !== jobId;
      });
      persist(cache);
    },
    getJobSearchState: function () {
      return cache.jobSearch;
    },
    setJobSearchState: function (next) {
      cache.jobSearch = Object.assign({}, cache.jobSearch, next || {});
      persist(cache);
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
      persist(cache);
    },
    clearLastJobSearchResults: function () {
      cache.jobSearch.lastResultSet = null;
      persist(cache);
    },
    recordJobSearchRun: function (entry) {
      if (!entry || typeof entry !== "object") return;
      cache.jobSearch.analytics = cache.jobSearch.analytics || { runs: [] };
      cache.jobSearch.analytics.runs = cache.jobSearch.analytics.runs || [];
      cache.jobSearch.analytics.runs.unshift(Object.assign({}, entry, { at: new Date().toISOString() }));
      if (cache.jobSearch.analytics.runs.length > 120) {
        cache.jobSearch.analytics.runs = cache.jobSearch.analytics.runs.slice(0, 120);
      }
      persist(cache);
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
    getSavedSearches: function () {
      return (cache.savedSearches || []).slice();
    },
    upsertSavedSearch: function (search) {
      if (!search || !search.id) return null;
      const idx = cache.savedSearches.findIndex(function (s) { return s.id === search.id; });
      if (idx >= 0) cache.savedSearches[idx] = search;
      else cache.savedSearches.push(search);
      persist(cache);
      trackUsage(idx >= 0 ? "saved_search_updated" : "saved_search_created", {
        hasFilters: Boolean(search.filters),
        queryLength: String(search.query || "").length
      }, { module: "job-search", route: "job-search" });
      return search;
    },
    deleteSavedSearch: function (id) {
      cache.savedSearches = cache.savedSearches.filter(function (s) { return s.id !== id; });
      persist(cache);
    },
    markSavedSearchRun: function (id, info) {
      const s = cache.savedSearches.find(function (x) { return x.id === id; });
      if (!s) return;
      s.lastRunAt = new Date().toISOString();
      if (info && typeof info.lastCount === "number") s.lastCount = info.lastCount;
      if (info && info.lastTopIds) s.lastTopIds = info.lastTopIds;
      if (info && typeof info.lastNewCount === "number") s.lastNewCount = info.lastNewCount;
      persist(cache);
      trackUsage("saved_search_run", {
        lastCount: s.lastCount || 0,
        lastNewCount: s.lastNewCount || 0
      }, { module: "job-search", route: "job-search" });
    },
    getApiKeys: function () {
      return Object.assign({}, cache.jobSearch.apiKeys || {});
    },
    setApiKeys: function (next) {
      cache.jobSearch.apiKeys = Object.assign({}, cache.jobSearch.apiKeys || {}, next || {});
      persist(cache);
    },
    saveJobAsApplication: function (job) {
      if (!job) return null;
      const id = window.CBV2.createId("app");
      const application = {
        id: id,
        company: job.company || "",
        role: job.title || "",
        stage: "saved",
        priority: "medium",
        appliedAt: new Date().toISOString().slice(0, 10),
        nextAction: "Tailor resume and apply",
        notes: buildPipelineNotesFromJob(job),
        jobUrl: job.url || "",
        stageHistory: [{ stage: "saved", at: new Date().toISOString() }]
      };
      cache.applications.push(application);
      persist(cache);
      trackUsage("job_moved_to_pipeline", {
        source: job.source || "",
        sourceHost: sourceHost(job.url),
        hasCapturedPosting: Boolean(job.descriptionText || job.description || job.summary || job.snippet)
      }, { module: "pipeline", route: "job-search" });
      return application;
    },
    /** Tier C — user-pasted listing URL; no server-side fetch of third-party pages. */
    saveApplicationFromJobUrl: function (rawUrl, meta) {
      meta = meta || {};
      const url = normalizeListingUrl(rawUrl);
      if (!url) {
        return { ok: false, error: "Enter a valid http(s) URL." };
      }
      const key = urlKeyForDedup(url);
      const dup = cache.applications.some(function (a) {
        if (a.jobUrl && urlKeyForDedup(a.jobUrl) === key) return true;
        return a.notes && String(a.notes).indexOf(url) >= 0;
      });
      if (dup) {
        return { ok: false, error: "That URL is already in your pipeline." };
      }
      const guess = guessMetaFromJobUrl(url);
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
      cache.applications.push(application);
      persist(cache);
      trackUsage("job_moved_to_pipeline", {
        source: "pasted-url",
        sourceHost: sourceHost(url),
        origin: "manual-url"
      }, { module: "pipeline", route: "applications" });
      return { ok: true, application: application };
    }
  };

  window.CBV2.createId = function (prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };
})();
