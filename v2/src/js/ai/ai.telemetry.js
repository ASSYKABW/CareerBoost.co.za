(function () {
  const STORAGE_KEY = "cb_ai_telemetry_v1";
  const MAX_EVENTS = 120;

  function isTelemetryAllowed() {
    try {
      const profile = (window.CBV2 && window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
      const prefs = profile && profile.preferences && typeof profile.preferences === "object" ? profile.preferences : null;
      const ai = prefs && prefs.aiPreferences && typeof prefs.aiPreferences === "object" ? prefs.aiPreferences : null;
      if (!ai) return true;
      return ai.consentTelemetry !== false;
    } catch (error) {
      return true;
    }
  }

  function loadEvents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveEvents(events) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
    } catch (error) {
      // Ignore storage failures in local mode.
    }
  }

  function track(event) {
    if (!isTelemetryAllowed()) return;
    const events = loadEvents();
    events.push({
      timestamp: new Date().toISOString(),
      ...event
    });
    saveEvents(events);
    if (window.__CAREERBOOST_AI_DEBUG) {
      console.log("[CBAI telemetry]", event);
    }
  }

  function clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Ignore storage failures in local mode.
    }
  }

  function getSummary() {
    const events = loadEvents();
    let success = 0;
    let failed = 0;
    let totalLatency = 0;
    let countLatency = 0;

    events.forEach(function (event) {
      if (event.status === "success") {
        success += 1;
      }
      if (event.status === "failed") {
        failed += 1;
      }
      if (typeof event.latencyMs === "number") {
        totalLatency += event.latencyMs;
        countLatency += 1;
      }
    });

    return {
      totalEvents: events.length,
      success: success,
      failed: failed,
      avgLatencyMs: countLatency ? Math.round(totalLatency / countLatency) : 0
    };
  }

  window.CBAI = window.CBAI || {};
  window.CBAI.telemetry = { track, getSummary, clear, isTelemetryAllowed };
})();
