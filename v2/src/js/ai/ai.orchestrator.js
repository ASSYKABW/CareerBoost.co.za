(function () {
  function createRequestId() {
    return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function normalizeError(error) {
    if (!error) {
      return "Unknown AI error";
    }
    return error.message || String(error);
  }

  function getProfile() {
    return (window.CBV2 && window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
  }

  function getAiPreferences() {
    const profile = getProfile();
    const prefs = profile && profile.preferences && typeof profile.preferences === "object" ? profile.preferences : null;
    const ai = prefs && prefs.aiPreferences && typeof prefs.aiPreferences === "object" ? prefs.aiPreferences : {};
    const modules = ai.modules && typeof ai.modules === "object" ? ai.modules : {};
    return {
      personalizedMode: ai.personalizedMode !== false,
      tone: ai.tone || "professional",
      responseLength: ai.responseLength || "balanced",
      localeStyle: ai.localeStyle || "global",
      modules: {
        jobSearch: modules.jobSearch !== false,
        resume: modules.resume !== false,
        coverLetter: modules.coverLetter !== false,
        interview: modules.interview !== false
      }
    };
  }

  function resolveSkillModule(skill) {
    if (skill === "query-parse" || skill === "job-match-score" || skill === "jd-analyze") return "jobSearch";
    if (skill === "resume-tailor" || skill === "resume-critique" || skill === "resume-parse" || skill === "tailor-plan") return "resume";
    if (skill === "cover-letter-generate" || skill === "followup-email") return "coverLetter";
    if (
      skill === "interview-coach" ||
      skill === "interview-score" ||
      skill === "interview-session-step" ||
      skill === "interview-session-debrief" ||
      skill === "interview-intel-pack"
    ) {
      return "interview";
    }
    return "jobSearch";
  }

  function buildAiContext(skill, input) {
    const aiPrefs = getAiPreferences();
    const module = resolveSkillModule(skill);
    if (!aiPrefs.personalizedMode || !aiPrefs.modules[module]) return null;
    const profile = getProfile() || {};
    const profilePrefs = profile.preferences && profile.preferences.profile && typeof profile.preferences.profile === "object"
      ? profile.preferences.profile
      : {};
    const rolePrefs = profile.preferences && profile.preferences.jobPreferences && typeof profile.preferences.jobPreferences === "object"
      ? profile.preferences.jobPreferences
      : {};
    let candidate = null;
    try {
      const api = window.CBV2 && window.CBV2.candidateIntel;
      if (api && typeof api.summarizeForAi === "function") {
        candidate = api.summarizeForAi(skill, input || {});
      }
    } catch (error) {
      candidate = null;
    }

    return {
      tone: aiPrefs.tone,
      responseLength: aiPrefs.responseLength,
      localeStyle: aiPrefs.localeStyle,
      module: module,
      profile: {
        fullName: profile.full_name || "",
        headline: profile.headline || "",
        about: profilePrefs.about || "",
        skills: Array.isArray(profilePrefs.skills) ? profilePrefs.skills.slice(0, 12) : [],
        targetRoles: rolePrefs.roleProfile && Array.isArray(rolePrefs.roleProfile.targetTitles)
          ? rolePrefs.roleProfile.targetTitles.slice(0, 6)
          : []
      },
      candidate: candidate,
      contextRules: [
        "Use CareerBoost context only for personalization and prioritization.",
        "Do not invent facts, metrics, titles, credentials, or experience.",
        "When candidate evidence is missing, call it a gap or preparation topic."
      ]
    };
  }

  async function runSkill(skill, input) {
    const schemas = (window.CBAI && window.CBAI.schemas) || {};
    const promptVersions = (window.CBAI && window.CBAI.promptVersions) || {};
    const providers = (window.CBAI && window.CBAI.providers) || [];
    const telemetry = window.CBAI && window.CBAI.telemetry;

    const schemaValidator = schemas[skill];
    if (!schemaValidator) {
      throw new Error("Unknown AI skill: " + skill);
    }
    if (!providers.length) {
      throw new Error("No AI providers configured");
    }

    const requestId = createRequestId();
    const aiContext = buildAiContext(skill, input || {});
    const enhancedInput = aiContext
      ? Object.assign({}, input || {}, { __aiContext: aiContext })
      : (input || {});
    const payload = {
      requestId: requestId,
      skill: skill,
      promptVersion: promptVersions[skill] || "unknown",
      input: enhancedInput
    };

    let lastError = null;
    for (let p = 0; p < providers.length; p += 1) {
      const provider = providers[p];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const startedAt = Date.now();
        try {
          const result = await provider.run(payload);
          if (!result || !result.ok) {
            throw new Error("Provider returned invalid response envelope.");
          }
          if (!schemaValidator(result.data)) {
            throw new Error("Provider returned schema-invalid AI data.");
          }

          const envelope = {
            provider: provider.name,
            requestId: result.requestId || requestId,
            model: result.model || "unknown",
            promptVersion: payload.promptVersion,
            latencyMs: Number(result.latencyMs || Date.now() - startedAt),
            confidence: Number(result.confidence || 0),
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
            data: result.data
          };

          if (telemetry) {
            telemetry.track({
              requestId: envelope.requestId,
              skill: skill,
              provider: provider.name,
              status: "success",
              latencyMs: envelope.latencyMs,
              promptVersion: envelope.promptVersion
            });
          }
          if (window.CBV2 && window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
            window.CBV2.usage.track("ai_action_completed", {
              skill: skill,
              provider: provider.name,
              model: envelope.model,
              latencyMs: envelope.latencyMs,
              promptVersion: envelope.promptVersion
            }, { module: resolveSkillModule(skill), category: "ai" });
          }
          return envelope;
        } catch (error) {
          lastError = error;
          if (telemetry) {
            telemetry.track({
              requestId: requestId,
              skill: skill,
              provider: provider.name,
              status: "failed",
              latencyMs: Date.now() - startedAt,
              error: normalizeError(error),
              attempt: attempt,
              promptVersion: payload.promptVersion
            });
          }
          if (window.CBV2 && window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
            window.CBV2.usage.track("ai_action_failed", {
              skill: skill,
              provider: provider.name,
              attempt: attempt,
              promptVersion: payload.promptVersion
            }, { module: resolveSkillModule(skill), category: "ai" });
          }
          if (attempt === 2) {
            break;
          }
        }
      }
    }

    throw lastError || new Error("All AI providers failed");
  }

  // Streaming variant — currently supports only `interview-session-step`.
  // Builds the same __aiContext as runSkill, then invokes the SSE consumer
  // exposed on window.CBAI.runSkillStream. Caller provides per-token callbacks
  // for the typing-indicator UX.
  async function runSkillStream(skill, input, callbacks) {
    if (skill !== "interview-session-step") {
      throw new Error("Streaming is currently only available for interview-session-step.");
    }
    const streamFn = window.CBAI && window.CBAI.runSkillStream;
    if (typeof streamFn !== "function") {
      throw new Error("Streaming consumer not available.");
    }
    const schemas = (window.CBAI && window.CBAI.schemas) || {};
    const promptVersions = (window.CBAI && window.CBAI.promptVersions) || {};
    const schemaValidator = schemas[skill];
    if (!schemaValidator) {
      throw new Error("Unknown AI skill: " + skill);
    }

    const requestId = createRequestId();
    const aiContext = buildAiContext(skill, input || {});
    const enhancedInput = aiContext
      ? Object.assign({}, input || {}, { __aiContext: aiContext })
      : (input || {});
    const payload = {
      requestId: requestId,
      skill: skill,
      promptVersion: promptVersions[skill] || "unknown",
      input: enhancedInput
    };
    return streamFn(payload, callbacks);
  }

  window.CBAI = window.CBAI || {};
  window.CBAI.runSkill = runSkill;
  // NOTE: ai.providers.js sets window.CBAI.runSkillStream first; assigning
  // here would shadow it. We expose the orchestrator wrapper under a different
  // name so both layers remain accessible.
  window.CBAI.runSkillStreamed = runSkillStream;
})();
