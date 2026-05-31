(function () {
  window.CBJobs = window.CBJobs || {};

  const STEP_DEFS = [
    { id: "save", label: "Save to Pipeline", icon: "fa-list-check" },
    { id: "resume", label: "Tailor Resume", icon: "fa-file-lines", skill: "resume-tailor" },
    { id: "cover", label: "Draft Cover Letter", icon: "fa-envelope-open-text", skill: "cover-letter-generate" },
    { id: "interview", label: "Prepare Interview", icon: "fa-comments", skill: "interview-coach" }
  ];

  function getResumeText() {
    const store = window.CBV2 && window.CBV2.store;
    if (!store) return "";
    if (typeof store.getEffectiveResumeBaseText === "function") {
      const preferred = store.getEffectiveResumeBaseText();
      if (preferred && preferred.trim()) return preferred;
    }
    const all = store.getAll();
    return (all && all.resume && all.resume.base) || "";
  }

  function getStrengths() {
    const text = getResumeText();
    if (!text) return ["Frontend", "Product thinking", "Shipping velocity"];
    return text
      .toLowerCase()
      .match(/\b[a-z+#\.\-]{3,}\b/g)
      .filter(function (w) {
        return ["react", "typescript", "python", "node", "aws", "kubernetes", "java", "go", "product", "design", "vue", "angular", "css", "html", "accessibility", "performance", "testing"].indexOf(w) >= 0;
      })
      .slice(0, 6);
  }

  function roleProfileContext(roleProfile) {
    const rp = roleProfile || {};
    return {
      targetTitles: Array.isArray(rp.targetTitles) ? rp.targetTitles.slice(0, 5) : [],
      seniority: rp.seniority || "any",
      mustHaveSkills: Array.isArray(rp.mustHaveSkills) ? rp.mustHaveSkills.slice(0, 8) : [],
      excludeKeywords: Array.isArray(rp.excludeKeywords) ? rp.excludeKeywords.slice(0, 8) : [],
      strictMode: !!rp.strictMode
    };
  }

  // The full posting lives on job.descriptionText (providers store up to
  // 24k chars). Cap what we forward so token cost stays bounded — the
  // backend prompts further slice the JD (6k for cover letter / interview).
  function getJobDescription(job) {
    const text = String((job && (job.descriptionText || job.description)) || "").trim();
    if (!text) return "";
    return text.length > 8000 ? text.slice(0, 8000) : text;
  }

  function buildInput(skill, job, roleProfile) {
    const roleCtx = roleProfileContext(roleProfile);
    // The candidate's real resume + the actual job posting are the two
    // signals that turn tailoring from generic into role-specific. The
    // backend prompts already read `resume`/`candidate`/`background` and
    // `jobDescription` — the one-click "Apply with AI" path just never sent
    // them before, so it tailored blind off the job title alone.
    const resumeText = getResumeText();
    const jobDescription = getJobDescription(job);
    if (skill === "resume-tailor") {
      return {
        targetRole: job.title || "",
        marketFocus: job.company || "",
        strengths: getStrengths(),
        resume: resumeText,
        jobDescription: jobDescription,
        roleProfile: roleCtx
      };
    }
    if (skill === "cover-letter-generate") {
      return {
        company: job.company || "",
        role: job.title || "",
        tone: "Professional, warm, and concise",
        strengths: getStrengths(),
        candidate: resumeText,
        jobDescription: jobDescription,
        roleProfile: roleCtx
      };
    }
    if (skill === "interview-coach") {
      return {
        role: job.title || "",
        company: job.company || "",
        stage: "First interview",
        focus: "Behavioral + technical communication",
        background: resumeText,
        jobDescription: jobDescription,
        roleProfile: roleCtx
      };
    }
    return { job: job, roleProfile: roleCtx };
  }

  window.CBJobs.applyWorkflowSteps = function () {
    return STEP_DEFS.slice();
  };

  window.CBJobs.runApplyWorkflow = async function (job, options) {
    options = options || {};
    const onStep = typeof options.onStep === "function" ? options.onStep : function () {};
    const ai = window.CBAI;
    const store = window.CBV2 && window.CBV2.store;
    if (!store) throw new Error("Store unavailable");

    const results = {};

    for (let i = 0; i < STEP_DEFS.length; i += 1) {
      const step = STEP_DEFS[i];
      onStep({ step: step, status: "running", index: i });

      try {
        if (step.id === "save") {
          const app = store.saveJobAsApplication(job);
          results.save = app;
          onStep({ step: step, status: "success", index: i, data: app });
        } else if (step.skill) {
          if (!ai || typeof ai.runSkill !== "function") {
            throw new Error("AI orchestrator unavailable");
          }
          const envelope = await ai.runSkill(step.skill, buildInput(step.skill, job, options.roleProfile));
          results[step.id] = envelope;
          if (step.id === "resume") store.setResumeTailored(envelope);
          else if (step.id === "cover") store.setCoverLetterResult(envelope);
          else if (step.id === "interview") store.setInterviewSet(envelope);
          onStep({ step: step, status: "success", index: i, data: envelope });
        }
      } catch (err) {
        onStep({
          step: step,
          status: "failed",
          index: i,
          error: err && err.message ? err.message : "Step failed"
        });
        if (options.stopOnError) {
          return { results: results, stoppedAt: step.id };
        }
      }
    }

    return { results: results, stoppedAt: null };
  };
})();
