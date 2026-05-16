// Apply Assist — profile schema + gating helpers (Phase 1).
//
// Stores everything the Greenhouse adapter (Phase 2) will need to auto-fill
// an application: identity, links, work authorization, comp expectations,
// preferences, optional EEO, and a screening-question answer library.
//
// Storage: lives inside profile.preferences.applyAssist (existing JSONB
// column on public.profiles). No migration needed — same plumbing the
// AI personalization and job preferences sections already use.
//
// Public API:
//   CBV2.applyAssist.getProfile()                — hydrated apply profile (always full shape)
//   CBV2.applyAssist.hasMinimal()                — true if the minimum fields are filled
//   CBV2.applyAssist.missingMinimalFields()      — array of human-readable missing fields
//   CBV2.applyAssist.isReadyForJob(job)          — minimal + tailored resume for THIS job exists
//   CBV2.applyAssist.DEFAULTS                    — the default shape (for forms)

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.applyAssist) return;

  // Default empty shape — used by hydrate() and the Settings form.
  // Keep this in sync with the matching Phase 1 settings UI block; the
  // settings binder reads/writes the same keys.
  const DEFAULTS = Object.freeze({
    identity: {
      legalFirstName: "",
      legalLastName: "",
      preferredName: "",
      phone: "",
      email: "",
      location: { city: "", state: "", country: "", postal: "" }
    },
    links: {
      linkedin: "",
      github: "",
      portfolio: "",
      website: ""
    },
    workAuth: {
      visaStatus: "",            // citizen | permanent_resident | work_visa | needs_sponsorship | other
      countriesAuthorized: [],   // ISO-3166 alpha-2 codes preferred; freeform accepted
      needsSponsorshipFor: [],
      earliestStart: "",         // YYYY-MM-DD
      noticePeriodDays: 0
    },
    compensation: {
      targetMin: 0,
      targetMax: 0,
      currency: "USD",
      openToNegotiate: true
    },
    preferences: {
      relocate: "depends",       // yes | no | depends
      relocateLocations: [],
      workMode: "any",           // remote | hybrid | onsite | any
      travelOkPercent: 0
    },
    eeo: {
      // All optional. Only sent to ATSes when consentToShare is true AND
      // the ATS form explicitly asks for the field.
      gender: "",
      race: "",
      veteran: "",
      disability: "",
      consentToShare: false
    },
    // Phase 3 fills this when the user accepts AI suggestions. Each entry:
    //   { questionText, normalized, answer, confidence, lastUsedAt, timesUsed }
    screeningAnswers: [],
    updatedAt: null
  });

  function deepMergeDefaults(target, defaults) {
    if (!target || typeof target !== "object") return cloneDefaults(defaults);
    const out = Array.isArray(defaults) ? [] : {};
    Object.keys(defaults).forEach(function (key) {
      const def = defaults[key];
      const src = target[key];
      if (def && typeof def === "object" && !Array.isArray(def)) {
        out[key] = deepMergeDefaults(src, def);
      } else if (Array.isArray(def)) {
        out[key] = Array.isArray(src) ? src.slice() : def.slice();
      } else {
        out[key] = src !== undefined && src !== null ? src : def;
      }
    });
    // Preserve any extra keys the user might have (forward-compatible).
    if (target && typeof target === "object") {
      Object.keys(target).forEach(function (key) {
        if (!(key in out)) out[key] = target[key];
      });
    }
    return out;
  }

  function cloneDefaults(defaults) {
    return JSON.parse(JSON.stringify(defaults));
  }

  function readPreferences() {
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    if (!profile || !profile.preferences || typeof profile.preferences !== "object") return {};
    return profile.preferences;
  }

  function getProfile() {
    const prefs = readPreferences();
    const raw = (prefs.applyAssist && typeof prefs.applyAssist === "object") ? prefs.applyAssist : {};
    return deepMergeDefaults(raw, DEFAULTS);
  }

  // The bare minimum needed for the Greenhouse adapter to auto-fill anything
  // useful. Without these, we can't even fill name + contact, so Apply Assist
  // stays gated.
  function missingMinimalFields() {
    const p = getProfile();
    const missing = [];
    if (!String(p.identity.legalFirstName || "").trim()) missing.push("Legal first name");
    if (!String(p.identity.legalLastName  || "").trim()) missing.push("Legal last name");
    if (!String(p.identity.email          || "").trim()) missing.push("Email");
    if (!String(p.identity.phone          || "").trim()) missing.push("Phone");
    if (!String(p.workAuth.visaStatus     || "").trim()) missing.push("Work authorization");
    return missing;
  }

  function hasMinimal() {
    return missingMinimalFields().length === 0;
  }

  // ----- ATS support detection ------------------------------------------
  //
  // Phase 2c only knows how to drive Greenhouse. Returning false for
  // anything else surfaces a clear "unsupported-ats" reason in the gating
  // helper so the pipeline button can show "Apply Assist (Greenhouse only)".
  // Future phases extend this with Lever / Workday / etc.
  function isApplyAssistSupportedUrl(jobUrl) {
    if (!jobUrl) return false;
    try {
      const host = new URL(jobUrl).hostname.toLowerCase().replace(/^www\./, "");
      return host === "greenhouse.io" ||
        host.endsWith(".greenhouse.io") ||
        host === "boards.greenhouse.io" ||
        host === "job-boards.greenhouse.io";
    } catch (e) { return false; }
  }

  // Converts a Greenhouse job-listing URL into its apply-form URL.
  //   boards.greenhouse.io/<co>/jobs/<id>          → +/apply
  //   <co>.greenhouse.io/jobs/<id>                  → +/apply
  //   job-boards.greenhouse.io/<co>/jobs/<id>       → unchanged (apply form
  //                                                   is embedded in the
  //                                                   listing on this host)
  //   anything already ending in /apply             → unchanged
  function deriveGreenhouseApplyUrl(jobUrl) {
    try {
      const u = new URL(jobUrl);
      if (!isApplyAssistSupportedUrl(jobUrl)) return null;
      if (u.pathname.endsWith("/apply")) return u.toString();
      if (u.hostname === "job-boards.greenhouse.io") return u.toString();
      if (/\/jobs\/\d+/.test(u.pathname)) {
        return u.origin + u.pathname.replace(/\/+$/, "") + "/apply" + (u.search || "");
      }
      return u.toString();
    } catch (e) { return null; }
  }

  // Pipeline + saved-job-card gating. Returns a structured decision so the
  // button can render "Complete Apply Profile" / "Build resume first" /
  // "Greenhouse only" / "Apply Assist" labels without re-deriving the
  // reason itself.
  function isReadyForJob(app) {
    if (!hasMinimal()) {
      return { ready: false, reason: "complete-apply-profile", label: "Complete Apply Profile first" };
    }
    const jobUrl = (app && (app.jobUrl || app.url)) || "";
    if (!jobUrl) {
      return { ready: false, reason: "no-job-url", label: "No job URL on this application" };
    }
    if (!isApplyAssistSupportedUrl(jobUrl)) {
      return { ready: false, reason: "unsupported-ats", label: "Apply Assist (Greenhouse only for now)" };
    }
    const store = window.CBV2 && window.CBV2.store;
    const structured = store && typeof store.getResumeStructured === "function"
      ? store.getResumeStructured()
      : null;
    if (!structured) {
      return { ready: false, reason: "no-resume", label: "Build your resume first" };
    }
    return { ready: true, reason: "ready", label: "Apply Assist", applyUrl: deriveGreenhouseApplyUrl(jobUrl) };
  }

  // ----- launch flow ----------------------------------------------------
  //
  // Click → build intent → handshake with extension via postMessage →
  // open apply URL in a new tab. The bridge content script (loaded on
  // careerboost.app / localhost / 127.0.0.1) relays the intent to
  // background.js which stashes it in chrome.storage. The Greenhouse
  // content script reads it on the apply tab and auto-fills.

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () { reject(reader.error || new Error("base64 encode failed")); };
      reader.readAsDataURL(blob);
    });
  }

  // postMessage handshake with the bridge content script. Resolves with
  // the ACK payload, or rejects on timeout. Timeout has to be tolerant
  // of the bridge not being installed at all — that path resolves with
  // a clear error so the caller can show "install the extension" copy.
  function sendIntentToExtension(payload, timeoutMs) {
    const requestId = "aa_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    return new Promise(function (resolve) {
      let settled = false;
      function onMsg(ev) {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.type !== "CB_APPLY_INTENT_ACK") return;
        if (d.requestId !== requestId) return;
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMsg);
        resolve(d);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ type: "CB_APPLY_INTENT", requestId: requestId, payload: payload }, "*");
      setTimeout(function () {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMsg);
        resolve({
          ok: false,
          requestId: requestId,
          error: "no-extension"
        });
      }, Math.max(500, Number(timeoutMs) || 2500));
    });
  }

  async function buildResumeBlob() {
    const store = window.CBV2 && window.CBV2.store;
    const structured = store && typeof store.getResumeStructured === "function"
      ? store.getResumeStructured()
      : null;
    if (!structured) throw new Error("No structured resume available.");
    const docx = window.CBV2 && window.CBV2.resume && window.CBV2.resume.docx;
    if (!docx || typeof docx.toBlob !== "function") {
      throw new Error("Resume DOCX exporter not loaded.");
    }
    return docx.toBlob(structured, {}, "classic");
  }

  // Returns one of:
  //   { ok: true, intentId, openedUrl }
  //   { ok: false, error, reason }       (e.g. "no-extension", "ats-unsupported", "no-resume")
  async function launch(app) {
    const decision = isReadyForJob(app);
    if (!decision.ready) {
      return { ok: false, error: decision.label, reason: decision.reason };
    }
    const applyUrl = decision.applyUrl || deriveGreenhouseApplyUrl(app && app.jobUrl);
    if (!applyUrl) {
      return { ok: false, error: "Could not derive an apply URL from this listing.", reason: "no-apply-url" };
    }

    let resumeBlob;
    try {
      resumeBlob = await buildResumeBlob();
    } catch (err) {
      return { ok: false, error: (err && err.message) || "Resume export failed.", reason: "resume-export-failed" };
    }
    const base64 = await blobToBase64(resumeBlob);

    const intent = {
      applyUrl: applyUrl,
      jobId: app.id,
      company: app.company || "",
      role: app.role || "",
      resume: {
        filename: ((app.company || "resume") + "-" + (app.role || "application"))
          .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) + ".docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        base64: base64
      },
      profile: getProfile()
    };

    const ack = await sendIntentToExtension(intent, 2500);
    if (!ack.ok) {
      if (ack.error === "no-extension") {
        return {
          ok: false,
          error: "Couldn't reach the CareerBoost extension. Install it from Settings → Extension and try again.",
          reason: "no-extension"
        };
      }
      return { ok: false, error: ack.error || "Extension rejected the apply intent.", reason: "extension-rejected" };
    }

    try {
      window.open(applyUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      return { ok: false, error: "Browser blocked opening the apply tab. Allow pop-ups for this site.", reason: "popup-blocked" };
    }
    return { ok: true, intentId: ack.intentId, openedUrl: applyUrl };
  }

  window.CBV2.applyAssist = {
    DEFAULTS: DEFAULTS,
    getProfile: getProfile,
    hasMinimal: hasMinimal,
    missingMinimalFields: missingMinimalFields,
    isApplyAssistSupportedUrl: isApplyAssistSupportedUrl,
    deriveGreenhouseApplyUrl: deriveGreenhouseApplyUrl,
    isReadyForJob: isReadyForJob,
    launch: launch
  };
})();
