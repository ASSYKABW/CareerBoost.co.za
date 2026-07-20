(function () {
  window.CBV2 = window.CBV2 || {};

  const SESSION_KEY = "cbv2_usage_session_v1";
  const SESSION_META_KEY = "cbv2_usage_session_meta_v2";
  const ANON_KEY = "cbv2_usage_anon_v1";
  const MAX_QUEUE = 80;
  const MAX_LIST_ITEMS = 32;
  const FLUSH_DELAY_MS = 600;
  const SESSION_FLUSH_DELAY_MS = 1200;
  const HEARTBEAT_MS = 30 * 1000;
  const DISABLE_AFTER_ERROR_MS = 60 * 1000;
  const UNSAFE_KEY = /(resume|cover|letter|description|note|body|text|html|password|token|secret|api_?key|access_?key|email|phone|content|transcript)/i;

  let queue = [];
  let flushTimer = null;
  let sessionFlushTimer = null;
  let heartbeatTimer = null;
  let inFlight = false;
  let sessionInFlight = false;
  let disabledUntil = 0;
  let sessionDisabledUntil = 0;
  let lastRouteKey = "";
  let lastRouteAt = 0;

  function makeId(prefix) {
    const random = (window.crypto && window.crypto.getRandomValues)
      ? Array.prototype.map.call(window.crypto.getRandomValues(new Uint8Array(8)), function (x) {
        return x.toString(16).padStart(2, "0");
      }).join("")
      : Math.random().toString(36).slice(2, 14);
    return prefix + "_" + Date.now().toString(36) + "_" + random;
  }

  function storageGet(area, key) {
    try {
      const store = area === "session" ? window.sessionStorage : window.localStorage;
      return store ? store.getItem(key) : "";
    } catch (err) {
      return "";
    }
  }

  function storageSet(area, key, value) {
    try {
      const store = area === "session" ? window.sessionStorage : window.localStorage;
      if (store) store.setItem(key, value);
    } catch (err) {
      // Ignore privacy-mode storage failures.
    }
  }

  function parseJson(value) {
    try {
      return value ? JSON.parse(value) : null;
    } catch (err) {
      return null;
    }
  }

  function getSessionId() {
    let id = storageGet("session", SESSION_KEY);
    if (!id) {
      id = makeId("sess");
      storageSet("session", SESSION_KEY, id);
    }
    return id;
  }

  function getAnonymousId() {
    let id = storageGet("local", ANON_KEY);
    if (!id) {
      id = makeId("anon");
      storageSet("local", ANON_KEY, id);
    }
    return id;
  }

  function currentRoute() {
    try {
      const raw = String(window.location && window.location.hash || "").replace(/^#\//, "");
      return (raw.split("?")[0] || "dashboard").trim() || "dashboard";
    } catch (err) {
      return "dashboard";
    }
  }

  function moduleFromRoute(route) {
    const name = String(route || "").toLowerCase();
    if (name.indexOf("job-search") >= 0) return "job-search";
    if (name.indexOf("application") >= 0 || name.indexOf("pipeline") >= 0) return "pipeline";
    if (name.indexOf("resume") >= 0) return "resume";
    if (name.indexOf("cover") >= 0) return "cover-letter";
    if (name.indexOf("interview") >= 0) return "interview";
    if (name.indexOf("analytics") >= 0) return "analytics";
    if (name.indexOf("calendar") >= 0) return "calendar";
    if (name.indexOf("settings") >= 0) return "settings";
    if (name.indexOf("admin") >= 0) return "admin";
    if (name.indexOf("auth") >= 0) return "auth";
    if (name.indexOf("welcome") >= 0) return "marketing";
    return name || "workspace";
  }

  function categoryFor(eventName) {
    const name = String(eventName || "");
    if (name.indexOf("session_") === 0) return "session";
    if (name.indexOf("sign_") === 0 || name.indexOf("auth_") === 0) return "auth";
    if (name.indexOf("view_") === 0) return "navigation";
    if (name.indexOf("ai_") === 0) return "ai";
    if (name.indexOf("job_") === 0 || name.indexOf("saved_search") === 0) return "job-search";
    if (name.indexOf("application") === 0 || name.indexOf("pipeline") >= 0) return "pipeline";
    if (name.indexOf("resume") === 0) return "resume";
    if (name.indexOf("cover_letter") === 0) return "cover-letter";
    if (name.indexOf("interview") === 0 || name.indexOf("mock_interview") === 0) return "interview";
    if (name.indexOf("calendar") === 0) return "calendar";
    return "workflow";
  }

  function isSafeKey(key) {
    return !UNSAFE_KEY.test(String(key || ""));
  }

  function safeScalar(value) {
    if (value == null) return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value);
    return text.length > 180 ? text.slice(0, 180) : text;
  }

  function sanitizeMetadata(value, depth) {
    if (!value || typeof value !== "object") return {};
    const out = {};
    Object.keys(value).slice(0, 24).forEach(function (key) {
      if (!isSafeKey(key)) return;
      const item = value[key];
      if (item == null || typeof item === "boolean" || typeof item === "number" || typeof item === "string") {
        out[key] = safeScalar(item);
      } else if (Array.isArray(item)) {
        out[key] = item.slice(0, 10).map(safeScalar);
      } else if (depth < 1) {
        out[key] = sanitizeMetadata(item, depth + 1);
      }
    });
    return out;
  }

  function authContext() {
    const auth = window.CBV2 && window.CBV2.auth;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) return null;
    const client = auth.getClient && auth.getClient();
    const user = auth.getUser && auth.getUser();
    if (!client || !user || !user.id) return null;
    return { client: client, user: user };
  }

  function previewMode() {
    const ctx = authContext();
    if (ctx) return "signed_in";
    const config = window.CBV2 && window.CBV2.config;
    if ((window.CB_CONFIG && window.CB_CONFIG.forceLocal) ||
      (config && typeof config.isBackendEnabled === "function" && !config.isBackendEnabled())) {
      return "local_preview";
    }
    return "anonymous";
  }

  function detectClient() {
    const nav = window.navigator || {};
    const ua = String(nav.userAgent || "");
    const width = Number(window.innerWidth || (window.screen && window.screen.width) || 0);
    const height = Number(window.innerHeight || (window.screen && window.screen.height) || 0);
    const lower = ua.toLowerCase();
    const browser = lower.indexOf("edg/") >= 0 ? "Edge"
      : lower.indexOf("firefox/") >= 0 ? "Firefox"
        : lower.indexOf("chrome/") >= 0 || lower.indexOf("chromium/") >= 0 ? "Chrome"
          : lower.indexOf("safari/") >= 0 ? "Safari"
            : "Unknown";
    const os = lower.indexOf("windows") >= 0 ? "Windows"
      : lower.indexOf("android") >= 0 ? "Android"
        : lower.indexOf("iphone") >= 0 || lower.indexOf("ipad") >= 0 ? "iOS"
          : lower.indexOf("mac os") >= 0 ? "macOS"
            : lower.indexOf("linux") >= 0 ? "Linux"
              : "Unknown";
    const deviceType = width && width <= 760 ? "mobile" : (width && width <= 1100 ? "tablet" : "desktop");
    let timezone = "";
    try {
      timezone = typeof Intl !== "undefined" && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || ""
        : "";
    } catch (err) {
      timezone = "";
    }
    return {
      browser: browser,
      os: os,
      deviceType: deviceType,
      viewportWidth: width || null,
      viewportHeight: height || null,
      locale: nav.language || "",
      timezone: timezone
    };
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function durationSeconds(start, end) {
    const startMs = Date.parse(String(start || ""));
    const endMs = Date.parse(String(end || ""));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
    return Math.max(0, Math.round((endMs - startMs) / 1000));
  }

  function addUnique(list, value) {
    const label = String(value || "").trim();
    if (!label) return list || [];
    const arr = Array.isArray(list) ? list.slice() : [];
    if (arr.indexOf(label) < 0) arr.push(label);
    return arr.slice(Math.max(0, arr.length - MAX_LIST_ITEMS));
  }

  function saveSessionMeta(meta) {
    storageSet("session", SESSION_META_KEY, JSON.stringify(meta || {}));
  }

  function getSessionMeta() {
    const sessionId = getSessionId();
    const anonymousId = getAnonymousId();
    const stored = parseJson(storageGet("session", SESSION_META_KEY));
    if (stored && stored.sessionId === sessionId) {
      stored.anonymousId = stored.anonymousId || anonymousId;
      stored.routes = Array.isArray(stored.routes) ? stored.routes : [];
      stored.modules = Array.isArray(stored.modules) ? stored.modules : [];
      stored.eventCount = Number(stored.eventCount || 0);
      stored.routeCount = Number(stored.routeCount || 0);
      return stored;
    }
    const client = detectClient();
    const route = currentRoute();
    const mode = previewMode();
    const meta = {
      sessionId: sessionId,
      anonymousId: anonymousId,
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      durationSeconds: 0,
      eventCount: 0,
      routeCount: 0,
      entryRoute: route,
      exitRoute: route,
      routes: [],
      modules: [],
      source: "web",
      browser: client.browser,
      os: client.os,
      deviceType: client.deviceType,
      viewportWidth: client.viewportWidth,
      viewportHeight: client.viewportHeight,
      locale: client.locale,
      timezone: client.timezone,
      startedInPreview: mode !== "signed_in",
      previewMode: mode,
      startEventTracked: false
    };
    saveSessionMeta(meta);
    return meta;
  }

  function createEvent(eventName, metadata, options) {
    const name = String(eventName || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80);
    if (!name) return null;
    const opts = options || {};
    const route = opts.route || currentRoute();
    return {
      event_name: name,
      event_category: opts.category || categoryFor(name),
      module: opts.module || moduleFromRoute(route),
      route: route,
      session_id: getSessionId(),
      anonymous_id: getAnonymousId(),
      source: opts.source || "web",
      metadata: sanitizeMetadata(metadata || {}, 0),
      occurred_at: nowIso()
    };
  }

  function touchSession(event, isRouteView) {
    if (!event) return null;
    const meta = getSessionMeta();
    meta.lastActivityAt = event.occurred_at || nowIso();
    meta.durationSeconds = durationSeconds(meta.startedAt, meta.lastActivityAt);
    meta.eventCount = Number(meta.eventCount || 0) + 1;
    if (isRouteView) meta.routeCount = Number(meta.routeCount || 0) + 1;
    meta.exitRoute = event.route || meta.exitRoute || meta.entryRoute;
    meta.routes = addUnique(meta.routes, event.route);
    meta.modules = addUnique(meta.modules, event.module);
    meta.previewMode = previewMode();
    saveSessionMeta(meta);
    scheduleSessionFlush();
    return meta;
  }

  // Where this visit came from. Captured at session start only — document
  // .referrer is the landing referrer and is gone once they navigate, so a
  // later read would just say "internal". Hostname only: no paths, no query
  // strings, nothing that could carry someone's personal data.
  function landingReferrer() {
    try {
      const raw = String((typeof document !== "undefined" && document.referrer) || "").trim();
      if (!raw) return "direct";
      const u = new URL(raw);
      if (!u.hostname) return "direct";
      if (u.hostname === window.location.hostname) return "internal";
      return u.hostname.replace(/^www\./, "").slice(0, 80);
    } catch (e) {
      return "direct";
    }
  }

  // Read a UTM tag from the querystring OR from inside the hash route
  // (#/welcome?utm_source=…), since this app is hash-routed.
  function utmParam(name) {
    try {
      let v = new URLSearchParams(window.location.search || "").get(name);
      if (!v) {
        const h = String(window.location.hash || "");
        const q = h.indexOf("?");
        if (q >= 0) v = new URLSearchParams(h.slice(q + 1)).get(name);
      }
      return v ? String(v).slice(0, 60) : "";
    } catch (e) {
      return "";
    }
  }

  function ensureSessionStart(route, module, source) {
    const meta = getSessionMeta();
    if (meta.startEventTracked) return;
    meta.startEventTracked = true;
    saveSessionMeta(meta);
    const event = createEvent("session_start", {
      entryRoute: route || meta.entryRoute,
      deviceType: meta.deviceType,
      browser: meta.browser,
      os: meta.os,
      previewMode: meta.previewMode,
      startedInPreview: Boolean(meta.startedInPreview),
      // Acquisition: which channel produced this visit.
      referrer: landingReferrer(),
      utmSource: utmParam("utm_source"),
      utmMedium: utmParam("utm_medium"),
      utmCampaign: utmParam("utm_campaign")
    }, {
      route: route || meta.entryRoute,
      module: module || moduleFromRoute(route || meta.entryRoute),
      category: "session",
      source: source || meta.source || "web"
    });
    touchSession(event, false);
    enqueue(event);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, FLUSH_DELAY_MS);
  }

  function scheduleSessionFlush() {
    if (sessionFlushTimer) return;
    sessionFlushTimer = setTimeout(function () {
      sessionFlushTimer = null;
      flushSession();
    }, SESSION_FLUSH_DELAY_MS);
  }

  function enqueue(event) {
    if (!event) return;
    queue.push(event);
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    scheduleFlush();
  }

  // Mark this browser as ours so it never shows up as website traffic.
  //
  // The Console already drops any anonymous id that has been seen with an admin
  // account, which covers browsers we've signed into. It cannot cover a browser
  // we only ever browse signed-out from — and it can never cover a private
  // window, which has no persistent identity by definition. This is the manual
  // escape hatch for those: nothing is queued, so nothing is sent at all, which
  // is cleaner than filtering it back out server-side afterwards.
  const INTERNAL_KEY = "cbv2_internal_traffic_v1";
  function isInternalBrowser() {
    return storageGet("local", INTERNAL_KEY) === "1";
  }
  function setInternalBrowser(on) {
    if (on) storageSet("local", INTERNAL_KEY, "1");
    else { try { window.localStorage.removeItem(INTERNAL_KEY); } catch (e) { /* ignore */ } }
    return isInternalBrowser();
  }

  function track(eventName, metadata, options) {
    if (isInternalBrowser()) return null;
    const opts = options || {};
    const route = opts.route || currentRoute();
    const module = opts.module || moduleFromRoute(route);
    ensureSessionStart(route, module, opts.source || "web");
    const event = createEvent(eventName, metadata, Object.assign({}, opts, { route: route, module: module }));
    if (!event) return null;
    touchSession(event, event.event_name === "view_route");
    enqueue(event);
    // P1: removed the [CB usage] console.log — was only gated by the
    // __CAREERBOOST_USAGE_DEBUG global, which is too easy to forget
    // toggled on. If you need to inspect events locally, the queue is
    // accessible via the network tab (look for /client-telemetry POSTs)
    // or attach a tap: window.CBV2.usage.onEnqueue = e => console.log(e).
    return event;
  }

  function trackRoute(route, params) {
    const name = route || currentRoute();
    const key = name + ":" + JSON.stringify(Object.keys(params || {}).sort());
    const now = Date.now();
    if (key === lastRouteKey && now - lastRouteAt < 1200) return null;
    lastRouteKey = key;
    lastRouteAt = now;
    return track("view_route", {
      route: name,
      paramKeys: Object.keys(params || {}).sort()
    }, {
      route: name,
      module: moduleFromRoute(name),
      category: "navigation"
    });
  }

  function sessionPayload(ctx) {
    const meta = getSessionMeta();
    const client = detectClient();
    meta.durationSeconds = durationSeconds(meta.startedAt, meta.lastActivityAt);
    meta.viewportWidth = client.viewportWidth || meta.viewportWidth || null;
    meta.viewportHeight = client.viewportHeight || meta.viewportHeight || null;
    meta.previewMode = previewMode();
    saveSessionMeta(meta);
    return {
      session_id: meta.sessionId,
      user_id: ctx.user.id,
      anonymous_id: meta.anonymousId,
      source: meta.source || "web",
      started_at: meta.startedAt,
      last_activity_at: meta.lastActivityAt || meta.startedAt,
      duration_seconds: Math.max(0, Number(meta.durationSeconds || 0)),
      route_count: Math.max(0, Number(meta.routeCount || 0)),
      event_count: Math.max(0, Number(meta.eventCount || 0)),
      entry_route: meta.entryRoute || "",
      exit_route: meta.exitRoute || meta.entryRoute || "",
      routes: Array.isArray(meta.routes) ? meta.routes.slice(-MAX_LIST_ITEMS) : [],
      modules: Array.isArray(meta.modules) ? meta.modules.slice(-MAX_LIST_ITEMS) : [],
      device_type: meta.deviceType || client.deviceType || "",
      browser: meta.browser || client.browser || "",
      os: meta.os || client.os || "",
      viewport_width: meta.viewportWidth || null,
      viewport_height: meta.viewportHeight || null,
      locale: meta.locale || client.locale || "",
      timezone: meta.timezone || client.timezone || "",
      signed_in: true,
      started_in_preview: Boolean(meta.startedInPreview),
      preview_mode: meta.previewMode || "signed_in",
      metadata: sanitizeMetadata({
        startedMode: meta.startedInPreview ? "preview" : "signed_in"
      }, 0)
    };
  }

  function flushSession() {
    if (sessionInFlight) return Promise.resolve(false);
    if (Date.now() < sessionDisabledUntil) return Promise.resolve(false);
    const ctx = authContext();
    if (!ctx) return Promise.resolve(false);

    const payload = sessionPayload(ctx);
    sessionInFlight = true;
    return Promise.resolve(ctx.client.from("usage_sessions").upsert(payload, { onConflict: "session_id" })).then(function (result) {
      sessionInFlight = false;
      if (result && result.error) {
        sessionDisabledUntil = Date.now() + DISABLE_AFTER_ERROR_MS;
        if (window.__CAREERBOOST_USAGE_DEBUG) console.warn("[CB usage] session upsert failed", result.error);
        return false;
      }
      return true;
    }, function (err) {
      sessionInFlight = false;
      sessionDisabledUntil = Date.now() + DISABLE_AFTER_ERROR_MS;
      if (window.__CAREERBOOST_USAGE_DEBUG) console.warn("[CB usage] session upsert failed", err);
      return false;
    });
  }

  // Anonymous visitors cannot insert into usage_events: RLS is owner-scoped and
  // (before migration 0053) user_id was NOT NULL. That constraint — not a
  // missing feature — is why the product only ever saw people from sign-in
  // onward. Logged-out batches go to the usage-ingest edge function, which
  // writes them service-side as user_id = NULL + this visitor's anonymous_id.
  // Because the same persistent anonymous_id is stamped on their signed-in
  // events too, their pre-signup journey stitches to the account by a join.
  function flushAnonymous(batch) {
    const c = window.CBV2 && window.CBV2.config;
    if (!c || typeof c.isBackendEnabled !== "function" || !c.isBackendEnabled()) return Promise.resolve(false);
    if (typeof c.getFunctionsUrl !== "function") return Promise.resolve(false);
    const headers = { "Content-Type": "application/json" };
    if (typeof c.getSupabaseAnon === "function") {
      const anon = c.getSupabaseAnon();
      headers.apikey = anon;
      headers.Authorization = "Bearer " + anon;
    }
    return fetch(c.getFunctionsUrl() + "/usage-ingest", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ anonymous_id: getAnonymousId(), events: batch }),
      // Survive the unload that usually follows the last page view.
      keepalive: true
    }).then(function (res) {
      return !!(res && res.ok);
    }, function () {
      return false;
    });
  }

  function flush() {
    if (inFlight || !queue.length) {
      return flushSession();
    }
    if (Date.now() < disabledUntil) return Promise.resolve(false);
    const ctx = authContext();
    if (!ctx) {
      // Anonymous visitor: send via the ingest endpoint. No session row —
      // usage_sessions is still user-scoped; page views are the signal here.
      const anonBatch = queue.splice(0, 25);
      inFlight = true;
      return flushAnonymous(anonBatch).then(function (ok) {
        inFlight = false;
        if (!ok) {
          queue = anonBatch.concat(queue).slice(0, MAX_QUEUE);
          disabledUntil = Date.now() + DISABLE_AFTER_ERROR_MS;
          return false;
        }
        if (queue.length) scheduleFlush();
        return true;
      });
    }

    const batch = queue.splice(0, 25).map(function (event) {
      return Object.assign({}, event, { user_id: ctx.user.id });
    });
    inFlight = true;
    return Promise.resolve(ctx.client.from("usage_events").insert(batch)).then(function (result) {
      inFlight = false;
      if (result && result.error) {
        queue = batch.map(function (event) {
          const copy = Object.assign({}, event);
          delete copy.user_id;
          return copy;
        }).concat(queue).slice(0, MAX_QUEUE);
        disabledUntil = Date.now() + DISABLE_AFTER_ERROR_MS;
        if (window.__CAREERBOOST_USAGE_DEBUG) console.warn("[CB usage] insert failed", result.error);
        return false;
      }
      if (queue.length) scheduleFlush();
      flushSession();
      return true;
    }, function (err) {
      inFlight = false;
      queue = batch.map(function (event) {
        const copy = Object.assign({}, event);
        delete copy.user_id;
        return copy;
      }).concat(queue).slice(0, MAX_QUEUE);
      disabledUntil = Date.now() + DISABLE_AFTER_ERROR_MS;
      if (window.__CAREERBOOST_USAGE_DEBUG) console.warn("[CB usage] insert failed", err);
      return false;
    });
  }

  function markActivity() {
    const meta = getSessionMeta();
    meta.lastActivityAt = nowIso();
    meta.durationSeconds = durationSeconds(meta.startedAt, meta.lastActivityAt);
    meta.previewMode = previewMode();
    saveSessionMeta(meta);
    scheduleSessionFlush();
  }

  function pendingCount() {
    return queue.length;
  }

  function getSessionSnapshot() {
    return Object.assign({}, getSessionMeta());
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", function () {
      markActivity();
      flushSession();
      flush();
    });
    window.addEventListener("focus", function () {
      markActivity();
      flush();
    });
  }

  if (typeof setInterval === "function") {
    heartbeatTimer = setInterval(function () {
      try {
        if (!window.document || window.document.visibilityState !== "hidden") markActivity();
      } catch (err) {
        markActivity();
      }
    }, HEARTBEAT_MS);
  }

  window.CBV2.usage = {
    track: track,
    trackRoute: trackRoute,
    flush: flush,
    flushSession: flushSession,
    pendingCount: pendingCount,
    getSessionId: getSessionId,
    getAnonymousId: getAnonymousId,
    getSessionSnapshot: getSessionSnapshot,
    isInternalBrowser: isInternalBrowser,
    setInternalBrowser: setInternalBrowser,
    sanitizeMetadata: function (metadata) { return sanitizeMetadata(metadata || {}, 0); }
  };
})();
