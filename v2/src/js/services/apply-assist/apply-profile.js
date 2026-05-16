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

  // Phase 1 stub for the pipeline + saved-job-card gating. Phase 2 wires the
  // real "tailored resume exists for this job" check via the resume store.
  // Always returns false today so the button stays greyed out until the
  // adapter ships.
  function isReadyForJob(job) {
    if (!hasMinimal()) return { ready: false, reason: "complete-apply-profile" };
    const store = window.CBV2 && window.CBV2.store;
    const tailored = store && typeof store.getTailoredResumeForJob === "function"
      ? store.getTailoredResumeForJob(job && job.id)
      : null;
    if (!tailored) return { ready: false, reason: "tailor-resume-first" };
    // V2 will flip this to true once the Greenhouse adapter is wired. Until
    // then we keep returning false-with-coming-soon so the button never lies.
    return { ready: false, reason: "coming-soon" };
  }

  window.CBV2.applyAssist = {
    DEFAULTS: DEFAULTS,
    getProfile: getProfile,
    hasMinimal: hasMinimal,
    missingMinimalFields: missingMinimalFields,
    isReadyForJob: isReadyForJob
  };
})();
