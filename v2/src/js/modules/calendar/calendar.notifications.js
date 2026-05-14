// Phase 7: Browser notifications for upcoming events.
//
// Three responsibilities:
//   1. Request + track Notification permission (user-gesture initiated)
//   2. Scan upcoming events on a 60s ticker, fire reminders
//   3. Persist a per-event "fired" marker so we don't double-notify
//
// Design:
//   - Reads events from window.CBV2.store
//   - Computes reminder lead times from event.reminder (10min, 30min,
//     1h, 1d, 1w) — same vocabulary as ICS export
//   - Fires Notification with title + body + click action that focuses
//     the window and navigates to #/calendar
//   - Marks fired notifications in localStorage so a refresh doesn't
//     replay the entire history
//
// We're deliberately conservative: notifications fire ONLY for events
// in the next 7 days, and only if user opted in via settings. No
// background service worker — this module runs while the tab is open.
// That's enough for "I'm working on my job search, remind me my call
// is in 15 minutes" but we don't pretend to be a push system.

(function () {
  window.CBV2 = window.CBV2 || {};

  const FIRED_KEY = "cb_calendar_notif_fired";
  const PREF_KEY = "cb_calendar_notif_enabled";
  const TICK_MS = 60_000; // check every minute
  const LOOK_AHEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  // Window in which a reminder fires: ±60 seconds around the scheduled
  // moment. That makes the ticker robust to slight clock drift and
  // ensures we never miss a reminder by being 1s late.
  const FIRE_WINDOW_MS = 60_000;

  // Lead-time map (must match calendar.ics.js buildReminderLines).
  const LEAD_MS = {
    "10min": 10 * 60_000,
    "30min": 30 * 60_000,
    "1h":    60 * 60_000,
    "1hr":   60 * 60_000,
    "2h":    2  * 60 * 60_000,
    "1d":    24 * 60 * 60_000,
    "1day":  24 * 60 * 60_000,
    "1w":    7  * 24 * 60 * 60_000,
    "1week": 7  * 24 * 60 * 60_000,
  };

  let tickerId = null;

  function isSupported() {
    return typeof window !== "undefined" && typeof window.Notification !== "undefined";
  }

  function getPermission() {
    if (!isSupported()) return "unsupported";
    return window.Notification.permission || "default";
  }

  function safeRead(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeWrite(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function isEnabled() {
    // Default: ON when the user has granted permission, OFF otherwise.
    // Explicit user choice (via settings toggle) overrides.
    const pref = safeRead(PREF_KEY);
    if (pref === "1") return true;
    if (pref === "0") return false;
    return getPermission() === "granted";
  }

  function setEnabled(enabled) {
    safeWrite(PREF_KEY, enabled ? "1" : "0");
    if (enabled) {
      // Trigger an immediate scan so we catch anything due in the next
      // minute. The ticker will pick up subsequent reminders.
      tick();
      ensureTicker();
    } else {
      stopTicker();
    }
  }

  // Request permission. Must be called from a user gesture (button click).
  // Returns a promise resolving to the new permission state.
  function requestPermission() {
    if (!isSupported()) return Promise.resolve("unsupported");
    if (window.Notification.permission === "granted") return Promise.resolve("granted");
    if (window.Notification.permission === "denied") return Promise.resolve("denied");
    // The callback form is needed for Safari which hasn't supported the
    // promise form everywhere historically. Both API shapes return the
    // same state.
    return new Promise(function (resolve) {
      try {
        const p = window.Notification.requestPermission(function (state) { resolve(state); });
        if (p && typeof p.then === "function") {
          p.then(resolve).catch(function () { resolve("denied"); });
        }
      } catch (e) {
        resolve("denied");
      }
    });
  }

  function readFired() {
    try {
      const raw = safeRead(FIRED_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeFired(map) {
    safeWrite(FIRED_KEY, JSON.stringify(map || {}));
  }

  // Prune entries older than 30 days so the localStorage payload doesn't
  // grow unbounded.
  function pruneFired(map) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const out = {};
    Object.keys(map || {}).forEach(function (key) {
      if (typeof map[key] === "number" && map[key] > cutoff) {
        out[key] = map[key];
      }
    });
    return out;
  }

  function makeFireKey(eventId, leadKey, targetMs) {
    // Floor to the minute so two ticks ~60s apart don't both pass the
    // "not fired" check. That gives us at most one notification per
    // (event, lead-time) pair per minute window.
    const floored = Math.floor(targetMs / 60_000);
    return String(eventId || "x") + ":" + leadKey + ":" + floored;
  }

  function fireNotification(event, leadLabel) {
    if (!isSupported() || getPermission() !== "granted") return;
    const title = "Upcoming: " + (event.title || "CareerBoost event");
    const when = event.start
      ? new Date(event.start).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : (event.date || "");
    const body = leadLabel + " · " + when + (event.location ? " · " + event.location : "");
    try {
      const notif = new window.Notification(title, {
        body: body,
        tag: "cb-event-" + (event.id || event.sourceId || event.date),
        // Re-issuing with the same tag silently replaces an existing
        // notification rather than spawning duplicates.
        renotify: false,
        icon: "/v2/src/styles/favicon.svg",
      });
      notif.onclick = function () {
        try {
          window.focus();
          if (typeof window.location.hash === "string") {
            window.location.hash = "#/calendar";
          }
          notif.close();
        } catch (e) { /* ignore */ }
      };
    } catch (e) {
      // Notification constructor can throw on some browsers in iframes
      // or insecure contexts. Best-effort only.
    }
  }

  // Map "10min" / "1h" / "1d" labels to display strings.
  function leadLabelFor(leadKey) {
    const map = {
      "10min": "in 10 minutes", "30min": "in 30 minutes",
      "1h": "in 1 hour", "1hr": "in 1 hour", "2h": "in 2 hours",
      "1d": "tomorrow", "1day": "tomorrow",
      "1w": "in 1 week", "1week": "in 1 week",
    };
    return map[leadKey] || "soon";
  }

  function tick() {
    if (!isEnabled()) return;
    if (!isSupported() || getPermission() !== "granted") return;
    const store = window.CBV2.store;
    if (!store || typeof store.getEvents !== "function") return;

    const now = Date.now();
    const horizon = now + LOOK_AHEAD_MS;
    const fired = pruneFired(readFired());

    const events = store.getEvents() || [];
    events.forEach(function (event) {
      if (!event || event.status === "completed" || event.status === "cancelled" || event.status === "canceled") return;
      const startSrc = event.start || (event.date ? event.date + "T09:00:00" : null);
      if (!startSrc) return;
      const startMs = Date.parse(startSrc);
      if (!Number.isFinite(startMs)) return;
      if (startMs > horizon) return; // too far out
      const leadKey = String((event.reminder || "none")).toLowerCase();
      if (!leadKey || leadKey === "none") return;
      const leadMs = LEAD_MS[leadKey];
      if (!leadMs) return;
      const target = startMs - leadMs;
      // Fire when we're within FIRE_WINDOW_MS of the target moment AND
      // we haven't fired this key yet.
      if (Math.abs(now - target) > FIRE_WINDOW_MS) return;
      const fireKey = makeFireKey(event.id || event.sourceId, leadKey, target);
      if (fired[fireKey]) return;
      fireNotification(event, leadLabelFor(leadKey));
      fired[fireKey] = now;
    });
    writeFired(fired);
  }

  function ensureTicker() {
    if (tickerId != null) return;
    if (typeof setInterval !== "function") return;
    tickerId = setInterval(tick, TICK_MS);
  }

  function stopTicker() {
    if (tickerId == null) return;
    if (typeof clearInterval === "function") clearInterval(tickerId);
    tickerId = null;
  }

  function init() {
    if (isEnabled() && getPermission() === "granted") {
      ensureTicker();
      // Run one scan immediately so a user opening the tab at exactly
      // T-10min for a meeting doesn't have to wait up to 60s.
      tick();
    }
  }

  if (typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      // Defer so other modules' bootstrap finishes first.
      setTimeout(init, 0);
    }
  }

  window.CBV2.calendarNotifications = {
    isSupported: isSupported,
    permission: getPermission,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    requestPermission: requestPermission,
    tick: tick, // exposed for tests + manual refresh after settings change
    _readFired: readFired,
    _writeFired: writeFired,
    _makeFireKey: makeFireKey,
    _leadMs: LEAD_MS,
  };
})();
