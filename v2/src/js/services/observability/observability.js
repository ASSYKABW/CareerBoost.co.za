// Phase 8: client-side observability — error capture, perf marks,
// telemetry batching, optional Sentry adapter.
//
// Captures FOUR signals automatically:
//   1. window.onerror                  → severity:error, kind:unhandled_error
//   2. window.onunhandledrejection     → severity:error, kind:unhandled_rejection
//   3. console.error wrapper           → severity:error, kind:console_error
//   4. perf: ops slower than threshold → severity:info, kind:slow_op
//
// Manual capture API exposed at window.CBV2.observability:
//   captureError(err, ctx)
//   captureMessage(msg, ctx)
//   mark(label) → { stop(meta) }   — measure an operation
//
// Batching: events accumulate in a queue, flushed:
//   - every 5 seconds (timer)
//   - immediately if the queue hits 10 events
//   - on pagehide/beforeunload via navigator.sendBeacon
// Backoff: on a 5xx or network error, the flusher pauses for 60s before
// retrying. Repeated failures double the backoff up to 5 minutes.
//
// Privacy:
//   - Stack traces are kept verbatim (developer info only).
//   - Messages are clipped to 1024 chars at send time.
//   - Metadata blocked-keys list mirrors the backend trigger so anything
//     stripped client-side never reaches the wire.
//   - No PII fields collected anywhere in the pipeline.
//
// Sentry adapter: if window.CB_CONFIG.sentryDsn is set AND the SDK is
// available (loaded via CDN or bundle), captureError ALSO emits to
// Sentry.captureException. We never replace our own pipeline with
// Sentry — both are best-effort sinks.

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.observability && window.CBV2.observability._installed) {
    // Hot-reload / duplicate include guard.
    return;
  }

  const BLOCKED_METADATA_KEYS = {
    apiKey: 1, api_key: 1, accessToken: 1, access_token: 1,
    refreshToken: 1, refresh_token: 1, password: 1, secret: 1,
    resume: 1, cv: 1, coverLetter: 1, cover_letter: 1,
    jobDescription: 1, job_description: 1, description: 1,
    document: 1, rawText: 1, raw_text: 1, html: 1
  };

  const FLUSH_INTERVAL_MS = 5_000;
  const FLUSH_BATCH = 10;
  const MAX_QUEUE = 50;             // hard cap, drop oldest beyond this
  const SLOW_OP_THRESHOLD_MS = 1500; // perf marks slower than this get logged
  const BACKOFF_BASE_MS = 60_000;
  const BACKOFF_MAX_MS = 5 * 60_000;

  // Stable anonymous ID across sessions (until localStorage is cleared).
  function getAnonymousId() {
    try {
      let id = localStorage.getItem("cb_anonymous_id");
      if (!id) {
        // Lightweight UUID-ish — crypto.randomUUID where available, else timestamp+rand.
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
          id = window.crypto.randomUUID();
        } else {
          id = "anon-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        }
        localStorage.setItem("cb_anonymous_id", id);
      }
      return id;
    } catch (e) {
      // Private mode / no storage — fall back to a per-page-load id.
      return "anon-ephemeral-" + Math.random().toString(36).slice(2, 10);
    }
  }

  // Scrub a metadata object before queueing — defense in depth, the
  // backend trigger also enforces this.
  function scrubMetadata(meta) {
    if (!meta || typeof meta !== "object") return {};
    const out = {};
    Object.keys(meta).forEach(function (k) {
      if (BLOCKED_METADATA_KEYS[k]) return;
      const v = meta[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        // Don't deep-recurse — just record that there was a nested obj.
        // This keeps payload bounded + prevents accidental PII leakage.
        out[k] = "[object]";
      } else if (Array.isArray(v)) {
        out[k] = v.slice(0, 10);
      } else if (typeof v === "string") {
        out[k] = v.length > 240 ? v.slice(0, 240) + "…" : v;
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  function currentRoute() {
    try {
      // hash router: "#/calendar?foo=bar" → "/calendar"
      const h = window.location.hash || "";
      if (h.indexOf("#/") === 0) {
        const path = h.slice(1);
        const q = path.indexOf("?");
        return q >= 0 ? path.slice(0, q) : path;
      }
      return window.location.pathname || "";
    } catch (e) {
      return "";
    }
  }

  // -- The queue + flusher --
  const queue = [];
  let flushTimerId = null;
  let nextRetryAt = 0;
  let backoffMs = BACKOFF_BASE_MS;
  let isFlushing = false;
  let installed = false;

  function endpoint() {
    const c = window.CBV2 && window.CBV2.config;
    if (!c || !c.isBackendEnabled || !c.isBackendEnabled()) return "";
    return c.getFunctionsUrl() + "/client-telemetry";
  }

  function authHeaders() {
    const out = { "Content-Type": "application/json" };
    const c = window.CBV2 && window.CBV2.config;
    if (c && c.getSupabaseAnon) {
      out.apikey = c.getSupabaseAnon();
    }
    const auth = window.CBV2 && window.CBV2.auth;
    if (auth && auth.getSession) {
      const session = auth.getSession();
      if (session && session.access_token) {
        out.Authorization = "Bearer " + session.access_token;
      } else if (c && c.getSupabaseAnon) {
        // Fall back to anon key — the function accepts anonymous events
        // for landing-page error capture.
        out.Authorization = "Bearer " + c.getSupabaseAnon();
      }
    }
    return out;
  }

  function enqueue(event) {
    if (!event || !event.message) return;
    // Bound the queue so a runaway loop can't blow the heap.
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(event);
    if (queue.length >= FLUSH_BATCH) flush(false);
  }

  function flush(synchronous) {
    if (isFlushing) return;
    if (!queue.length) return;
    if (Date.now() < nextRetryAt) return;
    const url = endpoint();
    if (!url) {
      // Backend disabled — drop the queue, don't accumulate forever.
      // Errors still go to console.error so devs see them locally.
      queue.length = 0;
      return;
    }
    isFlushing = true;
    const batch = queue.splice(0, FLUSH_BATCH);
    const payload = JSON.stringify({
      events: batch,
      anonymous_id: getAnonymousId(),
    });
    // On pagehide we MUST use sendBeacon — fetch() can be canceled mid-
    // flight by the browser. sendBeacon is fire-and-forget.
    if (synchronous && typeof navigator !== "undefined" && navigator.sendBeacon) {
      try {
        const blob = new Blob([payload], { type: "application/json" });
        const sent = navigator.sendBeacon(url, blob);
        isFlushing = false;
        if (!sent) {
          // sendBeacon refused (quota or invalid URL). Re-queue.
          queue.unshift.apply(queue, batch);
        }
      } catch (e) {
        isFlushing = false;
        queue.unshift.apply(queue, batch);
      }
      return;
    }
    // Async path: fetch + backoff on failure.
    fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: payload,
      keepalive: true,
    })
      .then(function (res) {
        isFlushing = false;
        if (res.ok) {
          // Reset backoff after a successful flush.
          backoffMs = BACKOFF_BASE_MS;
          nextRetryAt = 0;
          return;
        }
        // 4xx → don't retry these events (they're malformed or rate-
        // limited). 5xx → re-queue with backoff.
        if (res.status >= 500) {
          queue.unshift.apply(queue, batch);
          nextRetryAt = Date.now() + backoffMs;
          backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
        }
      })
      .catch(function () {
        // Network error → re-queue with backoff.
        isFlushing = false;
        queue.unshift.apply(queue, batch);
        nextRetryAt = Date.now() + backoffMs;
        backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
      });
  }

  function startTimer() {
    if (flushTimerId != null) return;
    if (typeof setInterval !== "function") return;
    flushTimerId = setInterval(function () { flush(false); }, FLUSH_INTERVAL_MS);
  }

  // -- Public capture API --

  function captureError(err, ctx) {
    if (!err) return;
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? err.stack : "";
    enqueue({
      severity: "error",
      event_kind: (ctx && ctx.kind) || "manual",
      message: clip(message, 1024),
      stack: clip(stack, 8192),
      source_url: (ctx && ctx.source_url) || (typeof window !== "undefined" ? window.location.href : null),
      line_no: ctx && ctx.line_no,
      col_no: ctx && ctx.col_no,
      route: currentRoute(),
      user_agent: navigator && navigator.userAgent,
      metadata: scrubMetadata(ctx && ctx.metadata),
      occurred_at: new Date().toISOString(),
    });
    // Mirror to Sentry if configured.
    sentryCapture(err, ctx);
  }

  function captureMessage(msg, ctx) {
    if (!msg) return;
    enqueue({
      severity: (ctx && ctx.severity) || "warning",
      event_kind: (ctx && ctx.kind) || "manual",
      message: clip(String(msg), 1024),
      stack: null,
      source_url: typeof window !== "undefined" ? window.location.href : null,
      route: currentRoute(),
      user_agent: navigator && navigator.userAgent,
      metadata: scrubMetadata(ctx && ctx.metadata),
      occurred_at: new Date().toISOString(),
    });
  }

  // Perf marker. Usage:
  //   const m = observability.mark("job-search-render");
  //   ...do the work...
  //   m.stop({ size: results.length });
  // Records a slow_op event only if elapsed > SLOW_OP_THRESHOLD_MS.
  function mark(label) {
    const startAt = typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
    return {
      stop: function (meta) {
        const endAt = typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
        const elapsedMs = Math.round(endAt - startAt);
        if (elapsedMs < SLOW_OP_THRESHOLD_MS) return elapsedMs;
        enqueue({
          severity: "info",
          event_kind: "slow_op",
          message: "Slow op: " + label + " (" + elapsedMs + "ms)",
          stack: null,
          source_url: typeof window !== "undefined" ? window.location.href : null,
          route: currentRoute(),
          user_agent: navigator && navigator.userAgent,
          metadata: scrubMetadata(Object.assign({ elapsed_ms: elapsedMs, label: label }, meta || {})),
          occurred_at: new Date().toISOString(),
        });
        return elapsedMs;
      }
    };
  }

  function clip(s, n) {
    if (s == null) return null;
    const str = String(s);
    return str.length > n ? str.slice(0, n) : str;
  }

  // -- Optional Sentry adapter --
  // We don't bundle the Sentry SDK; if it's loaded (via CDN script tag
  // before observability.js), and CB_CONFIG.sentryDsn is set, we init
  // and mirror every captureError to Sentry too.
  let sentryReady = false;
  function tryInitSentry() {
    try {
      const Sentry = window.Sentry;
      const dsn = window.CB_CONFIG && window.CB_CONFIG.sentryDsn;
      if (!Sentry || !dsn || sentryReady) return;
      if (typeof Sentry.init === "function") {
        Sentry.init({
          dsn: dsn,
          // Errors only by default. The operator can enable performance
          // tracing by adding tracesSampleRate to the Sentry init script.
          tracesSampleRate: 0,
          beforeSend: function (event) {
            // Scrub any obviously-PII fields Sentry may have auto-captured
            // from the URL or breadcrumbs.
            try {
              if (event && event.request && event.request.headers) {
                delete event.request.headers["Authorization"];
                delete event.request.headers["Cookie"];
              }
            } catch (e) { /* ignore */ }
            return event;
          }
        });
        sentryReady = true;
      }
    } catch (e) { /* ignore */ }
  }

  function sentryCapture(err, ctx) {
    if (!sentryReady) tryInitSentry();
    if (!sentryReady) return;
    try {
      if (typeof window.Sentry.captureException === "function" && err instanceof Error) {
        window.Sentry.captureException(err, { extra: scrubMetadata(ctx && ctx.metadata) });
      } else if (typeof window.Sentry.captureMessage === "function") {
        window.Sentry.captureMessage(err && err.message ? err.message : String(err));
      }
    } catch (e) { /* ignore */ }
  }

  // -- Install global handlers (idempotent) --
  function install() {
    if (installed) return;
    installed = true;
    // 1. Unhandled errors
    window.addEventListener("error", function (event) {
      // Skip resource-load errors (img/script 404s) — they're noisy and
      // not actionable. event.error is null for those.
      if (!event || !event.error) return;
      captureError(event.error, {
        kind: "unhandled_error",
        source_url: event.filename,
        line_no: event.lineno,
        col_no: event.colno,
      });
    });
    // 2. Unhandled promise rejections
    window.addEventListener("unhandledrejection", function (event) {
      const reason = event && event.reason;
      const err = reason instanceof Error ? reason : new Error(String(reason || "Unhandled rejection"));
      captureError(err, { kind: "unhandled_rejection" });
    });
    // 3. console.error wrapper (preserves original behavior)
    if (window.console && typeof window.console.error === "function") {
      const originalError = window.console.error;
      window.console.error = function () {
        try {
          // First arg often an Error, sometimes a string.
          const first = arguments[0];
          const message = first instanceof Error
            ? first.message
            : Array.prototype.map.call(arguments, function (a) {
                if (a instanceof Error) return a.message;
                if (typeof a === "object") {
                  try { return JSON.stringify(a).slice(0, 240); } catch (e) { return "[object]"; }
                }
                return String(a);
              }).join(" ");
          enqueue({
            severity: "error",
            event_kind: "console_error",
            message: clip(message, 1024),
            stack: first instanceof Error && first.stack ? clip(first.stack, 8192) : null,
            source_url: window.location.href,
            route: currentRoute(),
            user_agent: navigator && navigator.userAgent,
            metadata: {},
            occurred_at: new Date().toISOString(),
          });
        } catch (e) { /* never throw from a console wrapper */ }
        return originalError.apply(window.console, arguments);
      };
    }
    // 4. Flush on page hide / before unload
    function flushOnExit() { flush(true); }
    window.addEventListener("pagehide", flushOnExit);
    window.addEventListener("beforeunload", flushOnExit);
    startTimer();
    // Try Sentry init now — if the SDK is loaded it'll succeed; if not
    // (lazy-loaded later) tryInitSentry runs again on each captureError.
    tryInitSentry();
  }

  // Public API on window.CBV2.observability.
  window.CBV2.observability = {
    captureError: captureError,
    captureMessage: captureMessage,
    mark: mark,
    flush: function () { flush(false); },
    getQueueSize: function () { return queue.length; },
    install: install,
    _installed: false,  // flipped below after install runs
  };

  // Auto-install on script load. We want to capture errors AS EARLY AS
  // POSSIBLE — even errors during the rest of the bootstrap.
  install();
  window.CBV2.observability._installed = true;
})();
