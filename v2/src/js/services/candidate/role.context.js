(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.roleContext) return;

  const KEY = "cbv2.activeRoleContext";
  let memoryValue = null;

  function clip(value, max) {
    const text = String(value || "").trim();
    if (!max || text.length <= max) return text;
    return text.slice(0, max).replace(/\s+\S*$/g, "").trim();
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function readStorage() {
    try {
      if (!window.localStorage) return null;
      return safeJsonParse(window.localStorage.getItem(KEY) || "");
    } catch (_) {
      return memoryValue;
    }
  }

  function writeStorage(value) {
    memoryValue = value;
    try {
      if (window.localStorage) {
        window.localStorage.setItem(KEY, JSON.stringify(value));
      }
    } catch (_) {
      // Keep the in-memory copy for restricted browser contexts.
    }
  }

  function removeStorage() {
    memoryValue = null;
    try {
      if (window.localStorage) window.localStorage.removeItem(KEY);
    } catch (_) {
      // Ignore storage failures.
    }
  }

  function normalizePayload(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    return {
      version: 1,
      appId: clip(p.appId || p.id, 120),
      company: clip(p.company, 160),
      role: clip(p.role || p.title, 180),
      stage: clip(p.stage, 40),
      priority: clip(p.priority, 40),
      location: clip(p.location, 220),
      source: clip(p.source, 420),
      jobUrl: clip(p.jobUrl || p.url || p.source, 420),
      nextAction: clip(p.nextAction, 500),
      notes: clip(p.notes, 9000),
      jobDescription: clip(p.jobDescription || p.description, 14000),
      destination: clip(p.destination, 40),
      origin: clip(p.origin || "pipeline", 60),
      capturedAt: p.capturedAt || new Date().toISOString()
    };
  }

  function parseApplicationNotes(app) {
    const helper = window.CBV2.jobNotes;
    if (helper && typeof helper.parseImportedNotes === "function") {
      const parsed = helper.parseImportedNotes(app && app.notes);
      if (parsed) return parsed;
    }
    return null;
  }

  function fromApplication(app, options) {
    const a = app && typeof app === "object" ? app : {};
    const parsed = parseApplicationNotes(a) || {};
    const notes = String(a.notes || "");
    return normalizePayload({
      appId: a.id,
      company: a.company,
      role: a.role,
      stage: a.stage,
      priority: a.priority,
      location: parsed.location || a.location || "",
      source: parsed.source || a.jobUrl || "",
      jobUrl: a.jobUrl || parsed.source || "",
      nextAction: a.nextAction || "",
      notes: notes,
      jobDescription: parsed.description || "",
      destination: options && options.destination,
      origin: options && options.origin || "pipeline"
    });
  }

  function set(payload) {
    const value = normalizePayload(payload);
    writeStorage(value);
    return value;
  }

  function useApplication(app, options) {
    return set(fromApplication(app, options || {}));
  }

  function get() {
    const value = readStorage();
    if (!value || typeof value !== "object") return null;
    if (!value.company && !value.role && !value.jobDescription && !value.notes) return null;
    return normalizePayload(value);
  }

  function clear() {
    removeStorage();
  }

  function keyFor(value) {
    const v = value || get();
    if (!v) return "";
    return [
      v.appId || "",
      v.company || "",
      v.role || "",
      v.capturedAt || ""
    ].join("|");
  }

  function findApplication(apps, context) {
    const ctx = context || get();
    const list = Array.isArray(apps) ? apps : [];
    if (!ctx) return null;
    if (ctx.appId) {
      const byId = list.find(function (app) {
        return String(app && app.id || "") === String(ctx.appId);
      });
      if (byId) return byId;
    }
    const company = String(ctx.company || "").toLowerCase();
    const role = String(ctx.role || "").toLowerCase();
    return list.find(function (app) {
      const appCompany = String(app && app.company || "").toLowerCase();
      const appRole = String(app && app.role || "").toLowerCase();
      return (!company || appCompany === company) && (!role || appRole === role);
    }) || null;
  }

  window.CBV2.roleContext = {
    key: KEY,
    get: get,
    set: set,
    clear: clear,
    fromApplication: fromApplication,
    useApplication: useApplication,
    keyFor: keyFor,
    findApplication: findApplication
  };
})();
