// Resume Lab — Phase 1: Upload, Parse, Structured Editor, Tailor.
// The route has three visual states:
//   1. Empty      — onboarding dropzone (no structured resume yet)
//   2. Parsing    — progress ribbon while we extract text + call the AI parser
//   3. Editor     — structured sections (inline editable) + tailor sidebar
//
// State lives in `view`. On structural changes we rerender; on text edits we
// persist `onblur` so the caret doesn't jump between keystrokes.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const model = window.CBV2.resume && window.CBV2.resume.model;
  const parser = window.CBV2.resume && window.CBV2.resume.parser;
  const quality = window.CBV2.resume && window.CBV2.resume.quality;

  const view = {
    mode: "auto", // auto | empty | parsing | editor
    progress: null,
    parseError: "",
    tailorBusy: false,
    tailorError: "",
    tailorResult: null,
    rawTextPreviewOpen: false,
    critiqueBusy: false,
    critiqueError: "",
    critiqueResult: null,
    critiqueAppliedIds: {},
    critiqueDismissedIds: {},
    critiqueExpandedIds: {},
    critiqueTargetRole: "",
    assetSuggestions: [],
    atsDetailsOpen: false,
    // Resume Lab #1: the detailed scoreboards (Completeness, ATS Simulation,
    // Version & Submit Lab) live behind one disclosure, collapsed by default —
    // the command bar already shows the headline scores, so this kills the
    // duplicate-scoreboard clutter. In-memory UI pref (resets per load).
    diagnosticsOpen: false,
    // Phase 3 — Two workflows
    workMode: "edit", // edit | tailor
    jdText: "",
    jdRole: "",
    jdBusy: false,
    jdError: "",
    jdAnalyzed: null,
    planBusy: false,
    planError: "",
    tailorPlan: null,
    tailorAppliedIds: {},
    tailorDismissedIds: {},
    summaryApplied: false,
    appliedSkills: {},
    // R1: union of bullet IDs the user has already accepted an AI rewrite
    // for, via critique OR tailor. Sent to the AI on the next critique /
    // tailor-plan call so the model can skip them and avoid suggesting the
    // same change twice. Maps bulletId → true. Lives for the session;
    // cleared when a fresh resume is loaded or critique/tailor is re-run
    // against new content.
    appliedAiBulletIds: {},
    // R3: which bullet's inline AI suggestion popover is open. Only one at
    // a time. null when none. Click chip → set; click outside / Apply /
    // Dismiss → null.
    bulletPopoverOpenId: null,
    // R4: track-changes preview. When set, the matching bullet renders
    // an inline before/after view (struck old + new highlighted) with
    // explicit Accept / Cancel buttons. Lives in view, not in the
    // resume document — preview never mutates the actual bullet text
    // until the user clicks Accept.
    //   { bulletId, text, source: "tailor"|"critique", optionIndex,
    //     issueKey?, optionLabel? }
    preview: null,
    // R5: "Review all" walkthrough — walks the user through the unified
    // AI Review Queue one bullet at a time. Each step scrolls to the
    // bullet, opens its chip popover, and stages option A as a preview.
    // Accept / Cancel / Skip advances; finishing or pressing End closes
    // the walkthrough.
    //   { active: bool, idx: number, queueSnapshot: [item, ...] }
    // The queue is snapshotted at start so a mid-walk apply doesn't
    // shift remaining indices under us.
    walkthrough: null,
    // Strengthen-bullet results, keyed by bulletId. Generated on-demand
    // by the wand icon (calls the bullet-strengthen AI skill). Same
    // shape as a tailor-plan bullet so the inline popover + queue can
    // render them uniformly. Cleared on Apply / Dismiss / bullet delete.
    //   { [bulletId]: { rewrites: string[], optionMeta?: [...], generatedAt } }
    strengthenResults: {},
    // bulletId currently being processed by bullet-strengthen (shows
    // a spinner on the wand icon while the AI call is in flight).
    strengthenLoadingId: null,
    // Phase 4 — Export dialog
    exportOpen: false,
    exportTemplate: "classic",
    exportAccent: "",
    exportFontSize: 10.5,
    exportPageSize: "a4",
    exportQuality: "balanced",
    exportBusy: false,
    exportError: "",
    exportPreflightOpen: true,
    activeRoleContextKey: ""
  };

  function hydrateTailorView() {
    const saved = window.CBV2.store.getResumeTailor && window.CBV2.store.getResumeTailor();
    if (!saved) return;
    if (saved.jdText) view.jdText = saved.jdText;
    if (saved.jdRole) view.jdRole = saved.jdRole;
    if (saved.jdAnalyzed) view.jdAnalyzed = saved.jdAnalyzed;
    if (saved.tailorPlan) view.tailorPlan = saved.tailorPlan;
    if (saved.appliedIds) view.tailorAppliedIds = saved.appliedIds;
    if (saved.dismissedIds) view.tailorDismissedIds = saved.dismissedIds;
    if (typeof saved.summaryApplied === "boolean") view.summaryApplied = saved.summaryApplied;
    if (saved.appliedSkills) view.appliedSkills = saved.appliedSkills;
  }

  function persistTailorView() {
    if (!window.CBV2.store.setResumeTailor) return;
    window.CBV2.store.setResumeTailor({
      jdText: view.jdText || "",
      jdRole: view.jdRole || "",
      jdAnalyzed: view.jdAnalyzed || null,
      tailorPlan: view.tailorPlan || null,
      appliedIds: view.tailorAppliedIds || {},
      dismissedIds: view.tailorDismissedIds || {},
      summaryApplied: !!view.summaryApplied,
      appliedSkills: view.appliedSkills || {}
    });
  }

  function st(s) {
    return window.CBV2.sanitizeText(s == null ? "" : String(s));
  }

  function toast(kind, msg) {
    const t = window.CBV2 && window.CBV2.toast;
    if (!t) return;
    if (typeof t[kind] === "function") t[kind](msg);
    else if (typeof t.show === "function") t.show(msg, kind);
  }

  function currentResume() {
    const s = window.CBV2.store;
    const r = (s && s.getResumeStructured && s.getResumeStructured()) || null;
    if (r && model && model.ensureShape) model.ensureShape(r);
    return r;
  }

  function getActiveRoleContext() {
    const svc = window.CBV2.roleContext;
    if (!svc || typeof svc.get !== "function") return null;
    return svc.get();
  }

  function roleContextJobText(ctx) {
    if (!ctx) return "";
    return String(ctx.jobDescription || ctx.notes || "").trim();
  }

  function applyActiveRoleContextToTailor(force) {
    const svc = window.CBV2.roleContext;
    const ctx = getActiveRoleContext();
    if (!ctx) return null;
    const key = svc && typeof svc.keyFor === "function"
      ? svc.keyFor(ctx)
      : [ctx.appId || "", ctx.company || "", ctx.role || "", ctx.capturedAt || ""].join("|");
    const text = roleContextJobText(ctx);
    const explicitResumeHandoff = ctx.destination === "resume";
    if (force || view.activeRoleContextKey !== key) {
      if (explicitResumeHandoff || force) view.workMode = "tailor";
      if ((force || explicitResumeHandoff || !view.jdRole) && ctx.role) view.jdRole = ctx.role;
      if ((force || explicitResumeHandoff || !view.jdText) && text) view.jdText = text;
      if ((force || explicitResumeHandoff) && view.jdAnalyzed) {
        view.jdAnalyzed = null;
        view.tailorPlan = null;
      }
      view.activeRoleContextKey = key;
      persistTailorView();
    }
    return ctx;
  }

  function renderActiveRoleContextBanner(ctx, variant) {
    if (!ctx) return "";
    const text = roleContextJobText(ctx);
    const compact = variant === "compact" ? " role-context-banner--compact" : "";
    const action = variant === "empty"
      ? "Upload or build a resume, then match it to this role."
      : "Use this job post as the tailoring target.";
    return (
      '<div class="role-context-banner' + compact + '">' +
        '<i class="fa-solid fa-crosshairs" aria-hidden="true"></i>' +
        '<div>' +
          '<span>Active role context</span>' +
          '<strong>' + st((ctx.company || "Company") + " - " + (ctx.role || "Role")) + '</strong>' +
          '<small>' + st(action + (text ? " Job description captured." : " Add a full job description for stronger matching.")) + '</small>' +
        '</div>' +
        (variant === "empty"
          ? ""
          : '<button class="btn-secondary btn-sm" type="button" id="fill-active-role"><i class="fa-solid fa-wand-magic-sparkles"></i> Use context</button>') +
        '<button class="btn-ghost btn-sm" type="button" id="clear-active-role"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>'
    );
  }

  function inferTargetRoleFromResume(r) {
    if (!r) return "";
    const h = r.header || {};
    const title = String(h.title || "").trim();
    if (title) return title;
    const exps = r.experience || [];
    for (let i = 0; i < exps.length; i += 1) {
      const role = String((exps[i] && exps[i].role) || "").trim();
      if (role) return role;
    }
    const projects = r.projects || [];
    for (let i = 0; i < projects.length; i += 1) {
      const name = String((projects[i] && projects[i].name) || "").trim();
      if (name) return name + " role";
    }
    return "";
  }

  function resolveMode() {
    if (view.mode !== "auto") return view.mode;
    return currentResume() ? "editor" : "empty";
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric"
      });
    } catch (e) {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // AI payload sizing helpers (prevent provider token overflows)
  // ---------------------------------------------------------------------------
  const AI_LIMITS = {
    jdAnalyzeChars: 12000,
    jdPlanChars: 14000,
    resumeJsonChars: 18000,
    summaryChars: 1800,
    bulletChars: 280,
    bulletsPerEntry: 8,
    entriesPerSection: 16
  };

  function clipText(v, max) {
    const s = String(v || "");
    if (!max || s.length <= max) return s;
    return s.slice(0, max);
  }

  function safeHeaderForAi(h) {
    const header = h || {};
    return {
      name: clipText(header.name, 120),
      title: clipText(header.title, 140),
      email: clipText(header.email, 140),
      phone: clipText(header.phone, 80),
      location: clipText(header.location, 160),
      // Never include photo/base64 in AI payloads.
      links: (header.links || []).slice(0, 6).map(function (l) {
        return { label: clipText(l && l.label, 60), url: clipText(l && l.url, 180) };
      })
    };
  }

  function compactResumeForAi(r, includeEdu) {
    if (!r) return {};
    const compact = {
      header: safeHeaderForAi(r.header),
      summary: clipText(r.summary, AI_LIMITS.summaryChars),
      experience: (r.experience || []).slice(0, AI_LIMITS.entriesPerSection).map(function (e) {
        return {
          role: clipText(e.role, 120),
          company: clipText(e.company, 140),
          startDate: clipText(e.startDate, 40),
          endDate: clipText(e.endDate, 40),
          location: clipText(e.location, 120),
          bullets: (e.bullets || []).slice(0, AI_LIMITS.bulletsPerEntry).map(function (b) {
            return { id: b.id || "", text: clipText(b.text, AI_LIMITS.bulletChars) };
          })
        };
      }),
      skills: {
        groups: (((r.skills && r.skills.groups) || []).slice(0, 8)).map(function (g) {
          return {
            label: clipText(g.label, 80),
            items: (g.items || []).slice(0, 20).map(function (s) { return clipText(s, 40); })
          };
        })
      },
      projects: (r.projects || []).slice(0, 10).map(function (p) {
        return {
          name: clipText(p.name, 120),
          description: clipText(p.description, 320),
          bullets: (p.bullets || []).slice(0, 6).map(function (b) {
            return { id: b.id || "", text: clipText(b.text, AI_LIMITS.bulletChars) };
          })
        };
      }),
      certifications: (r.certifications || []).slice(0, 12).map(function (c) {
        return { name: clipText(c.name, 120), issuer: clipText(c.issuer, 120), date: clipText(c.date, 40) };
      }),
      languages: (r.languages || []).slice(0, 10).map(function (l) {
        return { name: clipText(l.name, 60), level: clipText(l.level, 40) };
      })
    };
    if (includeEdu) {
      compact.education = (r.education || []).slice(0, 12).map(function (e) {
        return {
          school: clipText(e.school, 140),
          degree: clipText(e.degree, 120),
          field: clipText(e.field, 120),
          startDate: clipText(e.startDate, 40),
          endDate: clipText(e.endDate, 40)
        };
      });
    }
    return compact;
  }

  function compactJdAnalyzedForAi(a) {
    const d = a || {};
    return {
      role: clipText(d.role, 120),
      seniority: clipText(d.seniority, 60),
      responsibilities: (d.responsibilities || []).slice(0, 20).map(function (x) { return clipText(x, 220); }),
      requiredSkills: (d.requiredSkills || []).slice(0, 24).map(function (x) { return clipText(x, 60); }),
      preferredSkills: (d.preferredSkills || []).slice(0, 18).map(function (x) { return clipText(x, 60); }),
      keywords: (d.keywords || []).slice(0, 28).map(function (x) { return clipText(x, 60); })
    };
  }

  function clampScore(n) {
    if (quality && typeof quality.clampScore === "function") return quality.clampScore(n);
    return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  }

  function scoreTone(score) {
    if (quality && typeof quality.scoreTone === "function") return quality.scoreTone(score);
    if (score >= 86) return "green";
    if (score >= 70) return "warning";
    return "rose";
  }

  function getResumeHealth(r) {
    const comp = model.completeness(r);
    const ats = computeAtsSimulation(r, view.jdAnalyzed);
    const coverage = view.jdAnalyzed ? computeCoverage(view.jdAnalyzed, r) : null;
    const roleMatch = coverage && coverage.total
      ? clampScore((coverage.matched.length / coverage.total) * 100)
      : null;
    const evidenceScore = ats.totalBullets
      ? clampScore((ats.quantifiedBullets / Math.max(ats.totalBullets, 1)) * 100)
      : 0;
    const roleWeight = roleMatch === null ? 74 : roleMatch;
    const score = clampScore((comp.score * 0.28) + (ats.score * 0.42) + (evidenceScore * 0.12) + (roleWeight * 0.18));
    const ready = score >= 88 && ats.score >= 82 && (!coverage || roleMatch >= 68) && ats.longBullets === 0;
    const status = ready
      ? "Ready to submit"
      : score >= 74
        ? "Almost ready"
        : score >= 54
          ? "Needs focused rebuild"
          : "Draft intake";

    const fixes = buildResumeFixQueue(r, comp, ats, coverage, roleMatch);
    const questions = buildResumeQuestionPrompts(r, comp, ats);
    return {
      comp: comp,
      ats: ats,
      coverage: coverage,
      roleMatch: roleMatch,
      evidenceScore: evidenceScore,
      score: score,
      status: status,
      ready: ready,
      fixes: fixes,
      questions: questions
    };
  }

  function buildResumeFixQueue(r, comp, ats, coverage, roleMatch) {
    const fixes = [];
    const missing = comp.missing || [];
    if (missing.indexOf("full name") >= 0 || missing.indexOf("email") >= 0) {
      fixes.push({ icon: "fa-id-card", label: "Complete contact header", detail: "Recruiters need a clean name, title, email, phone, and location.", action: "jump", section: "header" });
    }
    if (missing.indexOf("summary") >= 0 || String(r.summary || "").trim().length < 120) {
      fixes.push({ icon: "fa-quote-left", label: "Rewrite the professional summary", detail: "Open with target role, years/context, strongest strengths, and proof.", action: "jump", section: "summary" });
    }
    if (!r.experience || !r.experience.length) {
      fixes.push({ icon: "fa-briefcase", label: "Add at least one experience entry", detail: "A submit-ready resume needs role, company, dates, and achievement bullets.", action: "jump", section: "experience" });
    }
    if ((ats.totalBullets || 0) < 6) {
      fixes.push({ icon: "fa-list-check", label: "Build more achievement bullets", detail: "Aim for 6+ strong bullets across recent roles before exporting.", action: "jump", section: "experience" });
    }
    if ((ats.quantifiedBullets || 0) < 3) {
      fixes.push({ icon: "fa-chart-line", label: "Add measurable impact", detail: "Turn tasks into proof using numbers, scale, frequency, quality, or speed.", action: "add-metrics" });
    }
    if (ats.longBullets > 0) {
      fixes.push({ icon: "fa-scissors", label: "Shorten long bullets", detail: "Keep bullets scannable so ATS and recruiters can read them quickly.", action: "trim-bullets" });
    }
    if (!view.critiqueResult && !view.critiqueBusy) {
      fixes.push({ icon: "fa-bullseye", label: "Run recruiter-grade critique", detail: "Get targeted risks, strengths, and paste-ready rewrites.", action: "run-critique" });
    }
    if (!view.jdAnalyzed) {
      fixes.push({ icon: "fa-crosshairs", label: "Match this resume to a real job", detail: "Paste a job description to expose missing keywords and proof gaps.", action: "open-tailor" });
    } else if (coverage && coverage.missing && coverage.missing.length) {
      fixes.push({ icon: "fa-key", label: "Close role-match gaps", detail: "Missing " + coverage.missing.slice(0, 4).join(", ") + (coverage.missing.length > 4 ? "..." : "") + ".", action: "open-tailor" });
    } else if (roleMatch !== null && roleMatch >= 70) {
      fixes.push({ icon: "fa-file-export", label: "Export final resume", detail: "Run the export preflight and download an ATS-friendly version.", action: "export" });
    }
    return fixes.slice(0, 6);
  }

  function buildResumeQuestionPrompts(r, comp, ats) {
    const questions = [];
    if ((comp.missing || []).indexOf("summary") >= 0 || String(r.summary || "").trim().length < 120) {
      questions.push("What role are you targeting, and what 2-3 strengths should a recruiter remember first?");
    }
    if ((ats.quantifiedBullets || 0) < 3) {
      questions.push("Which achievements affected speed, revenue, cost, quality, risk, users, customers, or team output?");
    }
    const weak = [];
    (r.experience || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) {
        const t = String((b && b.text) || "").trim();
        if (weak.length < 3 && t && !/\d/.test(t) && /(worked|helped|assisted|responsible|made|created)/i.test(t)) {
          weak.push(t);
        }
      });
    });
    weak.forEach(function (t) {
      questions.push('For "' + t.slice(0, 72) + (t.length > 72 ? "..." : "") + '", what changed because of your work?');
    });
    if (!((r.skills && r.skills.groups) || []).some(function (g) { return (g.items || []).length; })) {
      questions.push("Which tools, platforms, methods, and domain skills should be visible for your target role?");
    }
    if (!questions.length) {
      questions.push("Which role are you applying for next, so the lab can tune keywords, summary, and bullet evidence?");
    }
    return questions.slice(0, 5);
  }

  function renderWorkflowRail(health) {
    const steps = [
      { id: "import", label: "Import", done: true, icon: "fa-file-arrow-up" },
      { id: "diagnose", label: "Diagnose", done: health.score >= 45, icon: "fa-stethoscope" },
      { id: "rebuild", label: "Rebuild", done: health.evidenceScore >= 35 && health.comp.score >= 75, icon: "fa-wand-magic-sparkles" },
      { id: "match", label: "Role match", done: health.roleMatch !== null && health.roleMatch >= 65, icon: "fa-crosshairs" },
      { id: "review", label: "Final review", done: health.ats.score >= 82 && health.fixes.length <= 2, icon: "fa-list-check" },
      { id: "export", label: "Export", done: health.ready, icon: "fa-download" }
    ];
    let activeFound = false;
    return '<div class="resume-workflow-rail" aria-label="Resume Lab workflow">' + steps.map(function (s) {
      const active = !s.done && !activeFound;
      if (active) activeFound = true;
      const cls = "resume-workflow-step" + (s.done ? " is-done" : "") + (active ? " is-active" : "");
      return '<div class="' + cls + '"><span><i class="fa-solid ' + s.icon + '"></i></span><strong>' + st(s.label) + '</strong></div>';
    }).join("") + "</div>";
  }

  function renderResumeLabCommand(r, isEdit) {
    const health = getResumeHealth(r);
    const firstFix = health.fixes[0] || { label: "Export final resume", detail: "Run preflight and download a clean final version.", action: "export", icon: "fa-download" };
    const roleText = health.roleMatch === null ? "Not matched" : (health.roleMatch + "%");
    const targetRole = view.jdAnalyzed && (view.jdAnalyzed.role || view.jdRole)
      ? view.jdAnalyzed.role || view.jdRole
      : inferTargetRoleFromResume(r) || "Target role";
    return `
      <section class="resume-lab-command card">
        <div class="resume-command-head">
          <div class="resume-readiness-score ${scoreTone(health.score)}">
            <span class="num-font">${health.score}</span>
            <small>/100</small>
          </div>
          <div class="resume-command-title">
            <p class="eyebrow">Resume transformation lab</p>
            <h2>${st(health.status)}</h2>
            <p>Convert a blank, weak, incomplete, or mismatched resume into a professional version built for ${st(targetRole)}.</p>
          </div>
          <button class="btn-primary resume-next-action" type="button" data-lab-action="${st(firstFix.action)}" data-section="${st(firstFix.section || "")}">
            <i class="fa-solid ${st(firstFix.icon || "fa-wand-magic-sparkles")}"></i>
            <span>${st(firstFix.label)}</span>
          </button>
        </div>

        <div class="resume-command-metrics">
          <div><span class="num-font">${health.comp.score}</span><small>Completeness</small></div>
          <div><span class="num-font">${health.ats.score}</span><small>ATS health</small></div>
          <div><span class="num-font">${roleText}</span><small>Role match</small></div>
          <div><span class="num-font">${health.evidenceScore}</span><small>Evidence strength</small></div>
        </div>

        ${renderWorkflowRail(health)}
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------
  function renderEmpty() {
    const activeRole = getActiveRoleContext();
    return `
      <section class="resume-empty resume-empty-lab">
        <div class="resume-empty-copy">
          <p class="eyebrow">Resume Lab</p>
          <h1 class="page-title">Build or improve your resume, your way.</h1>
          <p class="page-subtitle resume-lab-subtitle">Upload an existing CV for quick editing, paste a rough draft, or start from zero. CareerBoost gives you a clean editor, smart checks, and professional rewrites when you need them.</p>
          ${renderActiveRoleContextBanner(activeRole, "empty")}
          <p class="page-subtitle">Drop a PDF or Word file — we extract the text, parse every section with AI, and open a structured editor you can polish in seconds.</p>
          <ul class="resume-empty-bullets">
            <li><i class="fa-solid fa-file-pdf"></i> PDF, <span class="num-font">.docx</span>, <span class="num-font">.txt</span> — all handled locally</li>
            <li><i class="fa-solid fa-wand-magic-sparkles"></i> AI fills every field — header, experience, skills, education</li>
            <li><i class="fa-solid fa-lock"></i> Your CV never leaves your browser until you sign in</li>
          </ul>
          <div class="resume-intake-options" aria-label="Resume starting points">
            <button class="resume-intake-card" id="resume-quick-draft" type="button">
              <i class="fa-solid fa-bolt"></i>
              <strong>I do not have a resume yet</strong>
              <span>Create a guided first draft from your name, target role, experience, and wins.</span>
            </button>
            <button class="resume-intake-card" id="resume-paste" type="button">
              <i class="fa-solid fa-paste"></i>
              <strong>I want quick editing</strong>
              <span>Paste a resume draft and open it in a structured editor for fast cleanup.</span>
            </button>
            <button class="resume-intake-card" id="resume-blank" type="button">
              <i class="fa-solid fa-plus"></i>
              <strong>I want a blank editor</strong>
              <span>Start with a clean editor and add each section yourself.</span>
            </button>
          </div>
          <div class="resume-empty-note">
            <i class="fa-solid fa-shield-halved"></i>
            <span>You can keep it simple: upload, edit, export. Advanced critique and role matching stay available only when you need them.</span>
          </div>
        </div>

        <div class="resume-drop" id="resume-drop">
          <input type="file" id="resume-file" accept=".pdf,.docx,.txt,.md,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden />
          <div class="resume-drop-inner">
            <div class="resume-drop-preview" aria-hidden="true">
              <div class="resume-paper-preview">
                <span class="paper-name"></span>
                <span></span>
                <span></span>
                <span class="paper-short"></span>
                <i></i>
                <span></span>
                <span class="paper-short"></span>
              </div>
              <div class="resume-drop-icon">
                <i class="fa-solid fa-cloud-arrow-up"></i>
              </div>
            </div>
            <h3>Quick edit an existing resume</h3>
            <p class="resume-drop-hint">or click to browse · PDF, DOCX, TXT · up to 10&nbsp;MB</p>
            <button class="btn-primary" id="resume-browse" type="button">
              <i class="fa-solid fa-upload"></i> Browse resume
            </button>
            <div class="resume-drop-proof">
              <span><i class="fa-solid fa-shield-halved"></i> Private workspace</span>
              <span><i class="fa-solid fa-microchip"></i> ATS checks</span>
              <span><i class="fa-solid fa-wand-magic-sparkles"></i> AI rewrites</span>
            </div>
            <div class="resume-drop-divider"><span>or</span></div>
            <button class="btn-secondary resume-drop-secondary-action" id="resume-paste-inline" type="button">
              <i class="fa-solid fa-paste"></i> Paste resume text
            </button>
            <button class="btn-primary resume-drop-secondary-action" id="resume-quick-draft-inline" type="button">
              <i class="fa-solid fa-bolt"></i> Create guided draft
            </button>
            <button class="btn-ghost resume-drop-secondary-action" id="resume-blank-inline" type="button">
              <i class="fa-solid fa-plus"></i> Blank editor
            </button>
          </div>
          ${view.parseError ? '<p class="resume-drop-error">' + st(view.parseError) + "</p>" : ""}
        </div>
      </section>

      <dialog id="resume-paste-dialog" class="resume-dialog">
        <form method="dialog" class="resume-dialog-inner">
          <header>
            <h3>Paste your resume text</h3>
            <button type="button" class="icon-btn" data-close-dialog aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
          </header>
          <p class="resume-dialog-sub">Paste from any source — a PDF, Word, Notion. We'll run the same AI parser.</p>
          <textarea id="resume-paste-text" rows="14" placeholder="Paste your resume here..." autofocus></textarea>
          <footer>
            <button type="button" class="btn-secondary" data-close-dialog>Cancel</button>
            <button type="button" class="btn-primary" id="resume-paste-confirm">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Parse with AI
            </button>
          </footer>
        </form>
      </dialog>

      <dialog id="resume-quick-dialog" class="resume-dialog">
        <form method="dialog" class="resume-dialog-inner">
          <header>
            <h3>Quick draft (60 seconds)</h3>
            <button type="button" class="icon-btn" data-close-quick-dialog aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
          </header>
          <p class="resume-dialog-sub">Share just the essentials. We'll create a complete first draft you can polish fast.</p>
          <label>Full name
            <input id="quick-name" type="text" placeholder="Jane Doe" />
          </label>
          <label>Target role
            <input id="quick-role" type="text" placeholder="Senior Frontend Engineer" />
          </label>
          <label>Years of experience
            <input id="quick-years" type="text" placeholder="5" />
          </label>
          <label>Top wins (one per line)
            <textarea id="quick-wins" rows="6" placeholder="Reduced page load time by 42% across checkout
Led migration to TypeScript for 4 repos
Built analytics dashboard used by 3 teams"></textarea>
          </label>
          <label class="quick-critique-toggle">
            <input id="quick-run-critique" type="checkbox" checked />
            <span>Run AI critique right after draft creation</span>
          </label>
          <footer>
            <button type="button" class="btn-secondary" data-close-quick-dialog>Cancel</button>
            <button type="button" class="btn-primary" id="resume-quick-confirm">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Create quick draft
            </button>
          </footer>
        </form>
      </dialog>
    `;
  }

  // ---------------------------------------------------------------------------
  // Parsing state
  // ---------------------------------------------------------------------------
  function renderParsing() {
    const p = view.progress || {};
    const steps = [
      { id: "extract", label: "Extracting text", icon: "fa-file-arrow-up" },
      { id: "parse", label: "Parsing with AI", icon: "fa-wand-magic-sparkles" },
      { id: "structure", label: "Structuring sections", icon: "fa-layer-group" }
    ];
    const stepHtml = steps.map(function (s) {
      let cls = "resume-step";
      if (p.done && p.done.indexOf(s.id) !== -1) cls += " done";
      if (p.current === s.id) cls += " active";
      const iconInner = (p.done && p.done.indexOf(s.id) !== -1)
        ? '<i class="fa-solid fa-check"></i>'
        : ('<i class="fa-solid ' + s.icon + '"></i>');
      return '<li class="' + cls + '"><span class="resume-step-icon">' + iconInner + '</span><span>' + st(s.label) + "</span></li>";
    }).join("");

    const detail = p.detail ? '<p class="resume-parsing-detail">' + st(p.detail) + "</p>" : "";

    return `
      <section class="resume-parsing">
        <div class="resume-parsing-card">
          <div class="resume-parsing-spinner">
            <i class="fa-solid fa-circle-notch fa-spin"></i>
          </div>
          <h2>Reading your CV...</h2>
          <p class="resume-parsing-sub">${st(p.fileName || "")}</p>
          <ol class="resume-steps">${stepHtml}</ol>
          ${detail}
        </div>
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // Editor state
  // ---------------------------------------------------------------------------
  function renderHeaderSection(r) {
    const h = r.header || {};
    const links = (h.links || []).map(function (l, i) {
      return `
        <div class="link-row">
          <input type="text" data-link-label data-idx="${i}" placeholder="Label" value="${st(l.label)}" />
          <input type="url" data-link-url data-idx="${i}" placeholder="https://..." value="${st(l.url)}" />
          <button type="button" class="icon-btn danger" data-link-remove data-idx="${i}" aria-label="Remove link"><i class="fa-solid fa-xmark"></i></button>
        </div>
      `;
    }).join("");

    const mono = templatesMod() ? (templatesMod().monogramFrom ? templatesMod().monogramFrom(h.name) : "") : "";
    const photoPreview = h.photo
      ? `<img src="${st(h.photo)}" alt="" />`
      : (mono ? `<span class="photo-mono">${st(mono)}</span>` : `<span class="photo-placeholder"><i class="fa-solid fa-user"></i></span>`);

    return `
      <article class="card resume-section" data-section="header">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-id-card"></i> Header</h2>
          <span class="chip subtle">Photo & extras are optional — only used by photo-enabled templates.</span>
        </div>

        <div class="resume-header-top">
          <div class="photo-picker">
            <div class="photo-frame ${h.photo ? "has-photo" : ""}">${photoPreview}</div>
            <div class="photo-actions">
              <label class="btn-ghost btn-sm photo-upload-btn">
                <i class="fa-solid fa-camera"></i> ${h.photo ? "Change photo" : "Upload photo"}
                <input type="file" id="resume-photo-input" accept="image/png,image/jpeg,image/webp" hidden />
              </label>
              ${h.photo ? `<button type="button" class="btn-ghost btn-sm danger" id="resume-photo-remove"><i class="fa-solid fa-trash"></i> Remove</button>` : ""}
              <p class="muted tiny">JPG, PNG or WebP · &lt; 2 MB · square looks best</p>
            </div>
          </div>

          <div class="resume-header-fields">
            <div class="resume-grid-2">
              <label>Full name<input type="text" data-field="header.name" value="${st(h.name)}" placeholder="Jane Doe" /></label>
              <label>Role / headline<input type="text" data-field="header.title" value="${st(h.title)}" placeholder="Senior Frontend Engineer" /></label>
              <label>Email<input type="email" data-field="header.email" value="${st(h.email)}" placeholder="you@email.com" /></label>
              <label>Phone<input type="tel" data-field="header.phone" value="${st(h.phone)}" placeholder="+1 555 0100" /></label>
              <label class="resume-grid-full">Location<input type="text" data-field="header.location" value="${st(h.location)}" placeholder="Berlin, Germany · Remote" /></label>
            </div>
          </div>
        </div>

        <details class="resume-extras">
          <summary><i class="fa-solid fa-chevron-right"></i> Personal details <span class="muted">(optional — shown on sidebar templates)</span></summary>
          <div class="resume-grid-3">
            <label>Date of birth<input type="text" data-field="header.dateOfBirth" value="${st(h.dateOfBirth)}" placeholder="01/09/2000" /></label>
            <label>Nationality<input type="text" data-field="header.nationality" value="${st(h.nationality)}" placeholder="Canadian" /></label>
            <label>Driving licence<input type="text" data-field="header.drivingLicense" value="${st(h.drivingLicense)}" placeholder="B · full" /></label>
          </div>
        </details>

        <div class="resume-links">
          <div class="resume-links-head">
            <span>Links</span>
            <button type="button" class="btn-ghost btn-sm" data-link-add><i class="fa-solid fa-plus"></i> Add link</button>
          </div>
          ${links || '<p class="muted">Add LinkedIn, GitHub, portfolio, or any relevant URL.</p>'}
        </div>
      </article>
    `;
  }

  function renderSummarySection(r) {
    return `
      <article class="card resume-section" data-section="summary">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-quote-left"></i> Summary</h2>
          <span class="chip subtle">${(r.summary || "").length} chars</span>
        </div>
        <textarea data-field="summary" rows="4" placeholder="One paragraph: who you are, what you do, the impact you drive.">${st(r.summary)}</textarea>
      </article>
    `;
  }

  function renderExperienceSection(r) {
    const items = (r.experience || []).map(function (e, i) {
      const bullets = (e.bullets || []).map(function (b) {
        const isPreviewing = !!(view.preview && view.preview.bulletId === b.id);
        const rowCls = isPreviewing ? "bullet-row is-previewing" : "bullet-row";
        return `
          <li class="${rowCls}" data-bullet-id="${st(b.id)}">
            <i class="fa-solid fa-circle-dot bullet-dot"></i>
            ${renderBulletInlineContent(b, e.id, "experience")}
            ${renderBulletAiAffordance(b.id)}
          </li>
        `;
      }).join("");

      return `
        <div class="resume-entry" data-entry-id="${st(e.id)}">
          <div class="resume-entry-head">
            <div class="resume-entry-title-group">
              <input type="text" data-field="experience.${i}.role" value="${st(e.role)}" placeholder="Role" class="resume-entry-title" />
              <input type="text" data-field="experience.${i}.company" value="${st(e.company)}" placeholder="Company" class="resume-entry-subtitle" />
            </div>
            <div class="resume-entry-actions">
              <button type="button" class="icon-btn" data-entry-up data-entry-id="${st(e.id)}" data-entry-type="experience" aria-label="Move up"><i class="fa-solid fa-chevron-up"></i></button>
              <button type="button" class="icon-btn" data-entry-down data-entry-id="${st(e.id)}" data-entry-type="experience" aria-label="Move down"><i class="fa-solid fa-chevron-down"></i></button>
              <button type="button" class="icon-btn danger" data-entry-remove data-entry-id="${st(e.id)}" data-entry-type="experience" aria-label="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          <div class="resume-grid-3">
            <label>Location<input type="text" data-field="experience.${i}.location" value="${st(e.location)}" placeholder="City, Country or Remote" /></label>
            <label>Start<input type="text" data-field="experience.${i}.startDate" value="${st(e.startDate)}" placeholder="Jan 2022" /></label>
            <label>End<input type="text" data-field="experience.${i}.endDate" value="${st(e.endDate)}" placeholder="${e.current ? "Present" : "Mar 2025"}" ${e.current ? "disabled" : ""} /></label>
          </div>
          <label class="resume-current-row">
            <input type="checkbox" data-field="experience.${i}.current" ${e.current ? "checked" : ""} />
            <span>I currently work here</span>
          </label>
          <ul class="bullet-list">${bullets}</ul>
          <button type="button" class="btn-ghost btn-sm" data-bullet-add data-exp-id="${st(e.id)}"><i class="fa-solid fa-plus"></i> Add bullet</button>
        </div>
      `;
    }).join("");

    return `
      <article class="card resume-section" data-section="experience">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-briefcase"></i> Experience</h2>
          <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="experience"><i class="fa-solid fa-plus"></i> Add role</button>
        </div>
        ${items || '<p class="muted">No experience entries yet. Click "Add role" to start.</p>'}
      </article>
    `;
  }

  function renderEducationSection(r) {
    const items = (r.education || []).map(function (e, i) {
      return `
        <div class="resume-entry" data-entry-id="${st(e.id)}">
          <div class="resume-entry-head">
            <div class="resume-entry-title-group">
              <input type="text" data-field="education.${i}.degree" value="${st(e.degree)}" placeholder="Degree" class="resume-entry-title" />
              <input type="text" data-field="education.${i}.school" value="${st(e.school)}" placeholder="School / University" class="resume-entry-subtitle" />
            </div>
            <div class="resume-entry-actions">
              <button type="button" class="icon-btn danger" data-entry-remove data-entry-id="${st(e.id)}" data-entry-type="education" aria-label="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          <div class="resume-grid-3">
            <label>Field<input type="text" data-field="education.${i}.field" value="${st(e.field)}" placeholder="Computer Science" /></label>
            <label>Start<input type="text" data-field="education.${i}.startDate" value="${st(e.startDate)}" placeholder="2016" /></label>
            <label>End<input type="text" data-field="education.${i}.endDate" value="${st(e.endDate)}" placeholder="2020" /></label>
          </div>
          <label>Notes<textarea rows="2" data-field="education.${i}.notes" placeholder="Relevant coursework, GPA, honors...">${st(e.notes)}</textarea></label>
        </div>
      `;
    }).join("");

    return `
      <article class="card resume-section" data-section="education">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-graduation-cap"></i> Education</h2>
          <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="education"><i class="fa-solid fa-plus"></i> Add school</button>
        </div>
        ${items || '<p class="muted">No education yet.</p>'}
      </article>
    `;
  }

  function renderSkillsSection(r) {
    const groups = (r.skills && r.skills.groups) || [];
    const groupHtml = groups.map(function (g, gi) {
      const chips = (g.items || []).map(function (item, ii) {
        return `<span class="skill-chip"><span>${st(item)}</span><button type="button" class="skill-chip-remove" data-skill-save-asset data-group-idx="${gi}" data-item-idx="${ii}" title="Save as reusable skill"><i class="fa-solid fa-bookmark"></i></button><button type="button" class="skill-chip-remove" data-skill-remove data-group-idx="${gi}" data-item-idx="${ii}" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button></span>`;
      }).join("");
      return `
        <div class="skill-group" data-group-idx="${gi}">
          <div class="skill-group-head">
            <input type="text" class="skill-group-label" data-skill-group-label data-group-idx="${gi}" value="${st(g.label)}" placeholder="Group name" />
            <button type="button" class="icon-btn danger btn-sm" data-skill-group-remove data-group-idx="${gi}" aria-label="Remove group"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="skill-chips">${chips}</div>
          <div class="skill-add-row">
            <input type="text" data-skill-input data-group-idx="${gi}" placeholder="Type a skill and press Enter..." />
          </div>
        </div>
      `;
    }).join("");

    return `
      <article class="card resume-section" data-section="skills">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-bolt"></i> Skills</h2>
          <button type="button" class="btn-ghost btn-sm" data-skill-group-add><i class="fa-solid fa-plus"></i> Add group</button>
        </div>
        ${groupHtml || '<p class="muted">Group your skills (e.g. Languages, Frameworks, Tools).</p>'}
      </article>
    `;
  }

  function renderProjectsSection(r) {
    if (!r.projects || !r.projects.length) {
      return `
        <article class="card resume-section resume-section-collapsible" data-section="projects">
          <div class="resume-section-head">
            <h2><i class="fa-solid fa-rocket"></i> Projects</h2>
            <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="projects"><i class="fa-solid fa-plus"></i> Add project</button>
          </div>
          <p class="muted">Showcase side projects, portfolio pieces, open source work.</p>
        </article>
      `;
    }
    const items = r.projects.map(function (p, i) {
      const bullets = (p.bullets || []).map(function (b) {
        const isPreviewing = !!(view.preview && view.preview.bulletId === b.id);
        const rowCls = isPreviewing ? "bullet-row is-previewing" : "bullet-row";
        return `
          <li class="${rowCls}" data-bullet-id="${st(b.id)}">
            <i class="fa-solid fa-circle-dot bullet-dot"></i>
            ${renderBulletInlineContent(b, p.id, "projects")}
            ${renderBulletAiAffordance(b.id)}
          </li>
        `;
      }).join("");
      return `
        <div class="resume-entry" data-entry-id="${st(p.id)}">
          <div class="resume-entry-head">
            <div class="resume-entry-title-group">
              <input type="text" data-field="projects.${i}.name" value="${st(p.name)}" placeholder="Project name" class="resume-entry-title" />
              <input type="url" data-field="projects.${i}.url" value="${st(p.url)}" placeholder="https://..." class="resume-entry-subtitle" />
            </div>
            <div class="resume-entry-actions">
              <button type="button" class="icon-btn danger" data-entry-remove data-entry-id="${st(p.id)}" data-entry-type="projects" aria-label="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          <label>Description<textarea rows="2" data-field="projects.${i}.description" placeholder="What it does and your role on it.">${st(p.description)}</textarea></label>
          <ul class="bullet-list">${bullets}</ul>
          <button type="button" class="btn-ghost btn-sm" data-bullet-add data-exp-id="${st(p.id)}" data-scope="projects"><i class="fa-solid fa-plus"></i> Add bullet</button>
        </div>
      `;
    }).join("");

    return `
      <article class="card resume-section" data-section="projects">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-rocket"></i> Projects</h2>
          <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="projects"><i class="fa-solid fa-plus"></i> Add project</button>
        </div>
        ${items}
      </article>
    `;
  }

  function renderCertificationsSection(r) {
    const items = (r.certifications || []).map(function (c, i) {
      return `
        <div class="resume-entry" data-entry-id="${st(c.id)}">
          <div class="resume-grid-3">
            <label>Name<input type="text" data-field="certifications.${i}.name" value="${st(c.name)}" placeholder="AWS Solutions Architect" /></label>
            <label>Issuer<input type="text" data-field="certifications.${i}.issuer" value="${st(c.issuer)}" placeholder="Amazon" /></label>
            <label>Date<input type="text" data-field="certifications.${i}.date" value="${st(c.date)}" placeholder="2024" /></label>
          </div>
          <button type="button" class="icon-btn danger" data-entry-remove data-entry-id="${st(c.id)}" data-entry-type="certifications" aria-label="Remove"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;
    }).join("");
    return `
      <article class="card resume-section" data-section="certifications">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-certificate"></i> Certifications</h2>
          <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="certifications"><i class="fa-solid fa-plus"></i> Add certification</button>
        </div>
        ${items || '<p class="muted">No certifications yet.</p>'}
      </article>
    `;
  }

  function renderLanguagesSection(r) {
    const items = (r.languages || []).map(function (l, i) {
      return `
        <div class="resume-entry resume-entry-row" data-entry-id="${st(l.id)}">
          <label>Language<input type="text" data-field="languages.${i}.name" value="${st(l.name)}" placeholder="English" /></label>
          <label>Level<input type="text" data-field="languages.${i}.level" value="${st(l.level)}" placeholder="Native · Fluent · B2" /></label>
          <button type="button" class="icon-btn danger" data-entry-remove data-entry-id="${st(l.id)}" data-entry-type="languages" aria-label="Remove"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;
    }).join("");
    return `
      <article class="card resume-section" data-section="languages">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-language"></i> Languages</h2>
          <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="languages"><i class="fa-solid fa-plus"></i> Add language</button>
        </div>
        ${items || '<p class="muted">No languages yet.</p>'}
      </article>
    `;
  }

  function renderInterestsSection(r) {
    const items = (r.interests || []);
    const chips = items.map(function (i) {
      return `<span class="interest-chip" data-interest-id="${st(i.id)}">
        ${st(i.label)}
        <button type="button" class="chip-remove" data-interest-remove data-interest-id="${st(i.id)}" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button>
      </span>`;
    }).join("");
    return `
      <article class="card resume-section" data-section="interests">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-heart"></i> Interests <span class="chip subtle">optional</span></h2>
        </div>
        <div class="interest-chip-list">${chips || '<p class="muted">No interests added yet.</p>'}</div>
        <div class="interest-add-row">
          <input type="text" id="interest-input" placeholder="Photography, chess, trail running..." />
          <button type="button" class="btn-ghost btn-sm" id="interest-add-btn"><i class="fa-solid fa-plus"></i> Add</button>
        </div>
      </article>
    `;
  }

  function renderReferencesSection(r) {
    const items = (r.references || []).map(function (ref, i) {
      return `
        <div class="resume-entry" data-entry-id="${st(ref.id)}">
          <div class="resume-entry-head">
            <div class="resume-entry-title-group">
              <input type="text" data-field="references.${i}.name" value="${st(ref.name)}" placeholder="Reference name" class="resume-entry-title" />
              <input type="text" data-field="references.${i}.role" value="${st(ref.role)}" placeholder="Role / title" class="resume-entry-subtitle" />
            </div>
            <div class="resume-entry-actions">
              <button type="button" class="icon-btn danger" data-entry-remove data-entry-id="${st(ref.id)}" data-entry-type="references" aria-label="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          <div class="resume-grid-2">
            <label>Company<input type="text" data-field="references.${i}.company" value="${st(ref.company)}" placeholder="Company / organization" /></label>
            <label>Relationship<input type="text" data-field="references.${i}.note" value="${st(ref.note)}" placeholder="Former manager, colleague, client..." /></label>
            <label>Email<input type="email" data-field="references.${i}.email" value="${st(ref.email)}" placeholder="they@company.com" /></label>
            <label>Phone<input type="tel" data-field="references.${i}.phone" value="${st(ref.phone)}" placeholder="+1 555 0100" /></label>
          </div>
        </div>
      `;
    }).join("");
    return `
      <article class="card resume-section" data-section="references">
        <div class="resume-section-head">
          <h2><i class="fa-solid fa-address-card"></i> References <span class="chip subtle">optional</span></h2>
          <button type="button" class="btn-ghost btn-sm" data-entry-add data-entry-type="references"><i class="fa-solid fa-plus"></i> Add reference</button>
        </div>
        ${items || '<p class="muted">No references yet. Add 1-3 professional references, each with name, role, and contact details.</p>'}
      </article>
    `;
  }

  function renderSidebar(r) {
    const comp = model.completeness(r);
    const missingHtml = comp.missing.length
      ? '<ul class="resume-missing-list">' + comp.missing.map(function (m) {
          return '<li><i class="fa-solid fa-circle-exclamation"></i> ' + st("Add " + m) + "</li>";
        }).join("") + "</ul>"
      : '<p class="muted">All key sections are filled in. Nice work.</p>';

    const ats = computeAtsSimulation(r, view.jdAnalyzed);
    const health = getResumeHealth(r);

    const completenessCard = `
        <article class="card resume-scorecard">
          <div class="resume-scorecard-head">
            <div>
              <p class="eyebrow">Completeness</p>
              <h3 class="num-font">${comp.score}<span class="resume-scorecard-max">/100</span></h3>
            </div>
            <div class="resume-ring" data-score="${comp.score}" aria-hidden="true">
              <svg viewBox="0 0 36 36" width="64" height="64">
                <circle cx="18" cy="18" r="15.9" class="ring-track" />
                <circle cx="18" cy="18" r="15.9" class="ring-fill" style="stroke-dasharray: ${comp.score}, 100;" />
              </svg>
            </div>
          </div>
          ${missingHtml}
          <div class="resume-stats">
            <div><span class="num-font">${comp.totalBullets || 0}</span> bullets</div>
            <div><span class="num-font">${comp.quantifiedBullets || 0}</span> with metrics</div>
          </div>
        </article>`;

    // Resume Lab #1: the headline scores already live in the command bar at
    // the top of the page, so the detailed scoreboards collapse behind one
    // disclosure instead of stacking three duplicate score cards.
    const diagnosticsBody = view.diagnosticsOpen
      ? renderPhase4ResumeIntelligence(r, health) + completenessCard + renderAtsCard(ats)
      : "";
    const diagnostics = `
        <article class="card resume-diagnostics-card">
          <button type="button" class="resume-diagnostics-toggle" id="resume-diagnostics-toggle" aria-expanded="${view.diagnosticsOpen ? "true" : "false"}">
            <span class="resume-diagnostics-label"><i class="fa-solid fa-gauge-high"></i> Resume diagnostics</span>
            <span class="resume-diagnostics-meta">
              <span class="chip ${scoreTone(health.score)}">${health.score}/100</span>
              <i class="fa-solid fa-chevron-${view.diagnosticsOpen ? "up" : "down"}" aria-hidden="true"></i>
            </span>
          </button>
          <p class="muted resume-diagnostics-hint">${view.diagnosticsOpen ? "Completeness, ATS simulation, and saved versions." : "Completeness, ATS &amp; version details — your headline scores are summarised above."}</p>
        </article>
        ${diagnosticsBody}`;

    return `
      <aside class="resume-sidebar">
        ${renderFixQueueCard(health)}
        ${diagnostics}
        ${renderAiReviewQueueCard(r)}
        ${renderCritiqueCard(r)}
        ${renderCareerAssetCard(r)}

        <article class="card resume-tailor-hint">
          <div class="resume-section-head">
            <h3><i class="fa-solid fa-bullseye"></i> Match to Role</h3>
          </div>
          <p class="muted">Paste a job description and let AI align your summary, bullets, skills, and proof to the role.</p>
          <button class="btn-primary btn-sm" type="button" data-mode-switch="tailor">
            <i class="fa-solid fa-arrow-right"></i> Open role-match workspace
          </button>
        </article>

        <article class="card resume-raw-card">
          <div class="resume-section-head">
            <h3><i class="fa-solid fa-file-lines"></i> Raw text</h3>
            <button type="button" class="btn-ghost btn-sm" id="resume-raw-toggle">
              ${view.rawTextPreviewOpen ? "Hide" : "Show"}
            </button>
          </div>
          ${view.rawTextPreviewOpen ? '<pre class="resume-raw-text">' + st(r.rawText || "(no raw text saved)") + "</pre>" : '<p class="muted">The original text we extracted from your upload.</p>'}
        </article>
      </aside>
    `;
  }

  function renderCareerAssetCard(r) {
    const store = window.CBV2.store;
    const items = (store && typeof store.getCareerAssets === "function")
      ? store.getCareerAssets()
      : [];
    const top = items.slice(0, 6);
    const rows = top.map(function (a) {
      return (
        '<li class="career-asset-row" data-asset-id="' + st(a.id) + '">' +
          '<div>' +
            '<strong>' + st(a.name || "Untitled asset") + '</strong>' +
            '<p class="ai-meta">' + st(a.type || "bullet") + "</p>" +
          "</div>" +
          '<div class="career-asset-actions">' +
            '<button class="btn-ghost btn-sm" type="button" data-asset-action="apply" data-asset-id="' + st(a.id) + '"><i class="fa-solid fa-plus"></i> Use</button>' +
            '<button class="btn-ghost btn-sm" type="button" data-asset-action="delete" data-asset-id="' + st(a.id) + '"><i class="fa-solid fa-trash"></i></button>' +
          "</div>" +
        "</li>"
      );
    }).join("");

    // Resume Lab #2: the AI "Suggested Assets" card was folded into the Vault —
    // suggestions to save live right next to the things you've already saved.
    const suggestions = r ? getAiAssetSuggestions(r) : [];
    view.assetSuggestions = suggestions;
    const suggestionRows = suggestions.map(function (s) {
      return (
        '<li class="career-asset-row career-asset-suggestion-row">' +
          '<div>' +
            '<strong>' + st(s.name || "AI suggestion") + '</strong> ' +
            '<span class="chip subtle">' + st(s.type || "bullet") + '</span>' +
            '<p class="ai-meta">' + st((s.text || "").slice(0, 160)) + "</p>" +
          "</div>" +
          '<div class="career-asset-actions">' +
            '<button class="btn-primary btn-sm" type="button" data-asset-suggest-action="save" data-asset-suggestion-id="' + st(s.id) + '"><i class="fa-solid fa-bookmark"></i> Save</button>' +
          "</div>" +
        "</li>"
      );
    }).join("");
    const suggestionsBlock = suggestions.length
      ? '<div class="career-asset-suggested">' +
          '<p class="career-asset-suggested-head"><i class="fa-solid fa-sparkles"></i> Suggested to save <span class="ai-meta">— from Tailor Plan &amp; AI Critique</span></p>' +
          '<ul class="career-asset-list">' + suggestionRows + "</ul>" +
        "</div>"
      : "";

    return `
      <article class="card resume-career-assets">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-box-archive"></i> Career Asset Vault</h3>
          <span class="chip subtle">${items.length} saved</span>
        </div>
        ${top.length
          ? '<ul class="career-asset-list">' + rows + "</ul>"
          : '<p class="muted">Save your strongest bullets and skills, then reuse them instantly across CV versions.</p>'}
        ${suggestionsBlock}
      </article>
    `;
  }

  function getAiAssetSuggestions(r) {
    const out = [];
    const seen = new Set();
    const existing = ((window.CBV2.store.getCareerAssets && window.CBV2.store.getCareerAssets()) || [])
      .map(function (a) { return String((a && a.text) || "").trim().toLowerCase(); });
    existing.forEach(function (x) { if (x) seen.add(x); });

    const plan = view.tailorPlan && (view.tailorPlan.data || view.tailorPlan);
    if (plan && Array.isArray(plan.bullets)) {
      plan.bullets.forEach(function (b, i) {
        const rewrites = getRewriteOptions(b && b.rewrite, b && b.alternatives);
        rewrites.forEach(function (text, optIdx) {
          if (!text || text.length < 35) return;
          const key = text.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          out.push({
            id: "tpb_" + i + "_" + optIdx + "_" + (b.targetBulletId || ""),
            type: "bullet",
            name: "Tailor rewrite",
            text: text,
            tags: Array.isArray(b.keywords) ? b.keywords.slice(0, 4) : ["tailor-plan"]
          });
        });
      });
    }
    if (plan && Array.isArray(plan.addSkills)) {
      plan.addSkills.forEach(function (s, i) {
        const text = String((s && s.skill) || "").trim();
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          id: "tps_" + i + "_" + key,
          type: "skill",
          name: text,
          text: text,
          tags: [String((s && s.group) || "skills")]
        });
      });
    }

    const critique = view.critiqueResult && (view.critiqueResult.data || view.critiqueResult);
    if (critique && Array.isArray(critique.issues)) {
      critique.issues.forEach(function (issue, i) {
        const reps = getRewriteOptions(
          ((issue && issue.target) && issue.target.replacement) || "",
          ((issue && issue.target) && issue.target.alternatives) || []
        );
        reps.forEach(function (rep, optIdx) {
          if (!rep || rep.length < 35) return;
          const key = rep.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          out.push({
            id: "cri_" + i + "_" + optIdx,
            type: "bullet",
            name: "Critique rewrite",
            text: rep,
            tags: [String((issue && issue.section) || "critique")]
          });
        });
      });
    }

    return out.slice(0, 8);
  }

  function renderAiAssetSuggestionsCard(r) {
    const suggestions = getAiAssetSuggestions(r);
    view.assetSuggestions = suggestions;
    if (!suggestions.length) return "";
    const rows = suggestions.map(function (s) {
      return (
        '<li class="career-asset-row">' +
          '<div>' +
            '<strong>' + st(s.name || "AI suggestion") + '</strong> ' +
            '<span class="chip subtle">' + st(s.type || "bullet") + '</span>' +
            '<p class="ai-meta">' + st((s.text || "").slice(0, 180)) + "</p>" +
          "</div>" +
          '<div class="career-asset-actions">' +
            '<button class="btn-primary btn-sm" type="button" data-asset-suggest-action="save" data-asset-suggestion-id="' + st(s.id) + '"><i class="fa-solid fa-bookmark"></i> Save</button>' +
          "</div>" +
        "</li>"
      );
    }).join("");
    return `
      <article class="card resume-career-assets">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-sparkles"></i> Suggested Assets</h3>
          <span class="chip cyan">AI-powered</span>
        </div>
        <p class="muted">Picked from Tailor Plan and AI Critique so you can reuse high-impact lines later.</p>
        <ul class="career-asset-list">${rows}</ul>
      </article>
    `;
  }

  function computeAtsSimulation(r, jdAnalyzed) {
    const issues = [];
    const breakdown = {
      parseability: 25,
      keywordCoverage: 25,
      completeness: 25,
      bulletQuality: 25
    };
    let score = 100;
    const h = r.header || {};
    if (!h.name) { issues.push("Missing full name in header."); score -= 8; breakdown.parseability -= 6; }
    if (!h.email) { issues.push("Missing email in header."); score -= 8; breakdown.parseability -= 6; }
    if (!h.phone) { issues.push("Missing phone in header."); score -= 5; breakdown.parseability -= 4; }
    if (!r.summary || r.summary.trim().length < 80) { issues.push("Summary is too short for recruiter context."); score -= 8; breakdown.completeness -= 5; }
    const exps = r.experience || [];
    if (!exps.length) { issues.push("No work experience entries."); score -= 18; breakdown.completeness -= 12; }
    const edus = r.education || [];
    if (!edus.length) { issues.push("No education entries."); score -= 8; breakdown.completeness -= 6; }
    const skills = ((r.skills && r.skills.groups) || []).some(function (g) { return (g.items || []).length; });
    if (!skills) { issues.push("Skills section is empty."); score -= 10; breakdown.completeness -= 7; }

    let totalBullets = 0;
    let quantified = 0;
    let longBullets = 0;
    exps.forEach(function (e) {
      (e.bullets || []).forEach(function (b) {
        const t = String((b && b.text) || "");
        totalBullets += 1;
        if (/\d/.test(t)) quantified += 1;
        if (t.length > 220) longBullets += 1;
      });
    });
    if (totalBullets < 6) { issues.push("Add more achievement bullets (aim for 6+)."); score -= 8; breakdown.bulletQuality -= 6; }
    if (longBullets > 0) {
      issues.push(longBullets + " bullet(s) are too long and may be skipped by ATS/recruiters.");
      const penalty = Math.min(10, longBullets * 2);
      score -= penalty;
      breakdown.bulletQuality -= Math.min(8, penalty);
    }
    const quantRatio = totalBullets ? quantified / totalBullets : 0;
    if (quantRatio < 0.35) {
      issues.push("Low quantified impact; include metrics in more bullets.");
      score -= 10;
      breakdown.bulletQuality -= 8;
    }

    // Phase 5: JD alignment check now uses synonym-aware semanticHas() so
    // "TypeScript" matches "TS", "Postgres" matches "PostgreSQL", and tokens
    // sitting inside URLs/tooling labels don't false-positive a real skill.
    const req = (jdAnalyzed && jdAnalyzed.requiredSkills) || [];
    let missingReq = [];
    if (req.length) {
      const sm = window.CBV2 && window.CBV2.semanticMatch;
      const corpus = buildResumeCorpus(r);
      if (sm && typeof sm.semanticHas === "function") {
        const tokens = sm.tokenize(corpus);
        missingReq = req.filter(function (s) {
          const term = String(s || "").trim();
          return term && !sm.semanticHas(tokens.length ? tokens : corpus, term);
        }).slice(0, 8);
      } else {
        // Legacy fallback for environments without the helper.
        const lower = corpus.toLowerCase();
        missingReq = req.filter(function (s) {
          const term = String(s || "").trim().toLowerCase();
          return term && !lower.includes(term);
        }).slice(0, 8);
      }
      if (missingReq.length) {
        issues.push("JD alignment gap: missing " + missingReq.length + " required skill keyword(s).");
        const gapPenalty = Math.min(16, missingReq.length * 3);
        score -= gapPenalty;
        breakdown.keywordCoverage -= Math.min(14, gapPenalty);
      }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    Object.keys(breakdown).forEach(function (k) {
      breakdown[k] = Math.max(0, Math.min(25, Math.round(breakdown[k])));
    });
    const confidence = score >= 85 ? "High" : score >= 70 ? "Medium" : "Low";
    return {
      score: score,
      confidence: confidence,
      totalBullets: totalBullets,
      quantifiedBullets: quantified,
      longBullets: longBullets,
      issues: issues,
      breakdown: breakdown,
      missingRequiredSkills: missingReq,
      ready: score >= 80 && issues.length <= 3
    };
  }

  function renderAtsCard(ats) {
    const issues = (ats.issues || []).slice(0, 6);
    const tone = ats.score >= 85 ? "green" : (ats.score >= 70 ? "warning" : "rose");
    const issuesHtml = issues.length
      ? '<ul class="resume-missing-list ats-issues">' + issues.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul>"
      : '<p class="muted">No major ATS blockers detected.</p>';
    const b = ats.breakdown || { parseability: 0, keywordCoverage: 0, completeness: 0, bulletQuality: 0 };
    const bars = [
      { id: "parseability", label: "Parseability", score: b.parseability || 0 },
      { id: "keywordCoverage", label: "Keyword coverage", score: b.keywordCoverage || 0 },
      { id: "completeness", label: "Section completeness", score: b.completeness || 0 },
      { id: "bulletQuality", label: "Bullet quality", score: b.bulletQuality || 0 }
    ];
    const breakdownHtml = `
      <div class="ats-breakdown ${view.atsDetailsOpen ? "is-open" : ""}">
        ${bars.map(function (x) {
          const pct = Math.round((x.score / 25) * 100);
          return '<div class="ats-breakdown-row">' +
            '<span>' + st(x.label) + '</span>' +
            '<span class="num-font">' + x.score + '/25</span>' +
            '<div class="ats-breakdown-bar"><i style="width:' + pct + '%"></i></div>' +
          '</div>';
        }).join("")}
      </div>
    `;
    // Quick-fix buttons removed in Resume Lab #2 — those actions (add metrics,
    // shorten bullets, add JD keywords) now live once in the "Next steps" list.
    return `
      <article class="card resume-ats-card">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-microchip"></i> ATS Simulation</h3>
          <div class="ats-head-actions">
            <span class="chip ${tone}">${ats.confidence}</span>
            <button type="button" class="btn-ghost btn-sm" id="ats-toggle-details">${view.atsDetailsOpen ? "Hide details" : "Why this score?"}</button>
          </div>
        </div>
        <div class="resume-ats-score"><span class="num-font">${ats.score}</span><span>/100</span></div>
        <div class="resume-stats">
          <div><span class="num-font">${ats.quantifiedBullets}</span> quantified bullets</div>
          <div><span class="num-font">${ats.longBullets}</span> overlong bullets</div>
        </div>
        ${view.atsDetailsOpen ? breakdownHtml : ""}
        ${issuesHtml}
      </article>
    `;
  }

  function getPhase4ResumeIntel(r, health) {
    const svc = window.CBV2.productIntel;
    if (!svc || typeof svc.resumeLab !== "function") return null;
    const store = window.CBV2.store;
    const all = store && typeof store.getAll === "function" ? store.getAll() : {};
    return svc.resumeLab(r, {
      all: all,
      health: health,
      jdAnalyzed: view.jdAnalyzed,
      jdText: view.jdText
    });
  }

  function renderPhase4ResumeIntelligence(r, health) {
    const intel = getPhase4ResumeIntel(r, health);
    if (!intel) return "";
    const versionRows = (intel.versions || []).slice(0, 4).map(function (v) {
      return (
        '<li>' +
          '<div><strong>' + st(v.name || "CV version") + '</strong><span>' + st(v.source || "saved") + '</span></div>' +
          '<b class="num-font">' + st(String(Math.max(0, Math.min(100, Math.round(v.score || 0))))) + '</b>' +
        '</li>'
      );
    }).join("");
    const checks = (intel.readyChecks || []).slice(0, 7).map(function (c) {
      return '<li class="' + (c.ok ? "ok" : "todo") + '"><i class="fa-solid ' + (c.ok ? "fa-check" : "fa-circle") + '"></i><span>' + st(c.label) + "</span></li>";
    }).join("");
    const diagnostics = (intel.diagnostics || []).map(function (d) {
      const val = Math.max(0, Math.min(100, Math.round(d.value || 0)));
      return '<span class="phase4-mini-meter"><small>' + st(d.label) + '</small><b><i style="width:' + val + '%"></i></b><strong>' + val + '</strong></span>';
    }).join("");
    const improvements = (intel.beforeAfter && intel.beforeAfter.improvements || []).map(function (x) {
      return '<li>' + st(x) + '</li>';
    }).join("");
    return `
      <article class="card phase4-resume-card">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-layer-group"></i> Version & Submit Lab</h3>
          <span class="chip ${intel.readiness >= 88 ? "green" : intel.readiness >= 70 ? "warning" : "rose"}">${intel.readiness}/100</span>
        </div>
        <div class="phase4-version-list">
          <div class="phase4-version-head">
            <span>${st(String(intel.versionCount))} saved version${intel.versionCount === 1 ? "" : "s"}</span>
            <button class="btn-ghost btn-sm" type="button" data-lab-action="save-version"><i class="fa-solid fa-book-bookmark"></i> Save snapshot</button>
          </div>
          <ul>${versionRows}</ul>
        </div>
        <div class="phase4-before-after">
          <div><span>${st(intel.beforeAfter.beforeLabel)}</span><p>${st(intel.beforeAfter.before)}</p></div>
          <div><span>${st(intel.beforeAfter.afterLabel)}</span><p>${st(intel.beforeAfter.after)}</p></div>
        </div>
        ${improvements ? '<ul class="phase4-improvement-list">' + improvements + "</ul>" : ""}
        <div class="phase4-diagnostic-grid">${diagnostics}</div>
        <ul class="ready-checks phase4-ready-checks">${checks}</ul>
      </article>
    `;
  }

  // R5: sidebar card listing every pending AI suggestion across critique
  // and tailor, ordered by impact. Each row has a Review button that
  // scrolls the bullet into view + opens its inline popover + stages
  // option A as a track-changes preview. The "Review all" button at the
  // top kicks off the walkthrough mode that auto-advances on Accept /
  // Cancel.
  function renderAiReviewQueueCard(r) {
    const queue = buildAiReviewQueue(r);
    const inWalkthrough = !!(view.walkthrough && view.walkthrough.active);
    const total = queue.length;
    if (total === 0 && !inWalkthrough) {
      // Empty state still rendered (so the user knows where suggestions
      // will appear once they run critique / tailor), but compact.
      const hasAiContext = !!view.critiqueResult || !!view.tailorPlan;
      const emptyMsg = hasAiContext
        ? "No pending AI rewrites for individual bullets. Critique a section or tailor against a JD to populate."
        : "Run Critique or Tailor to generate per-bullet AI suggestions. They'll queue here for quick review.";
      return (
        '<article class="card resume-review-queue-card resume-review-queue-card--empty">' +
          '<div class="resume-section-head">' +
            '<h3><i class="fa-solid fa-list-check"></i> AI Review Queue</h3>' +
            '<span class="chip subtle">0 pending</span>' +
          '</div>' +
          '<p class="muted">' + st(emptyMsg) + '</p>' +
        '</article>'
      );
    }

    const walkthroughHeader = inWalkthrough
      ? '<div class="resume-review-walkthrough">' +
          '<span class="chip cyan"><i class="fa-solid fa-circle-play"></i> Step ' +
          st(String((view.walkthrough.idx || 0) + 1)) + ' of ' +
          st(String(view.walkthrough.queueSnapshot.length)) + '</span>' +
          '<button class="btn-ghost btn-sm" type="button" data-walk-skip>' +
            '<i class="fa-solid fa-forward-step"></i> Skip' +
          '</button>' +
          '<button class="btn-ghost btn-sm" type="button" data-walk-end>' +
            '<i class="fa-solid fa-xmark"></i> End walkthrough' +
          '</button>' +
        '</div>'
      : (total > 0
        ? '<div class="resume-review-actions">' +
            '<button class="btn-primary btn-sm" type="button" data-walk-start>' +
              '<i class="fa-solid fa-circle-play"></i> Review all (' + st(String(total)) + ')' +
            '</button>' +
          '</div>'
        : '');

    const rows = queue.map(function (item, i) {
      const snippet = bulletTextSnippet(r, item.bulletId, 64);
      const srcIcon = item.source === "tailor"
        ? "fa-bullseye"
        : (item.source === "strengthen" ? "fa-wand-magic-sparkles" : "fa-triangle-exclamation");
      const sevChip = (function () {
        if (item.severity === "critical")   return '<span class="chip warning">CRITICAL</span>';
        if (item.severity === "major")      return '<span class="chip amber">MAJOR</span>';
        if (item.severity === "strengthen") return '<span class="chip cyan">STRENGTHEN</span>';
        if (item.severity === "tailor")     return '<span class="chip cyan">TAILOR</span>';
        return '<span class="chip subtle">MINOR</span>';
      })();
      const labelHint = item.firstOptionLabel
        ? '<span class="resume-review-label-hint">→ ' + st(item.firstOptionLabel) + '</span>'
        : "";
      return (
        '<li class="resume-review-row" data-review-idx="' + st(String(i)) + '">' +
          '<i class="resume-review-icon fa-solid ' + srcIcon + '"></i>' +
          '<div class="resume-review-body">' +
            '<div class="resume-review-meta">' + sevChip + labelHint + '</div>' +
            '<p class="resume-review-snippet">' + (snippet ? st(snippet) : '<em class="muted">(bullet not found)</em>') + '</p>' +
            '<p class="resume-review-headline">' + st(String(item.headline || "").slice(0, 120)) + '</p>' +
          '</div>' +
          '<button class="btn-ghost btn-sm" type="button" data-review-jump' +
            ' data-bullet-id="' + st(item.bulletId) + '"' +
            ' data-source="' + st(item.source) + '"' +
            (item.issueKey ? ' data-issue-key="' + st(item.issueKey) + '"' : '') +
            '><i class="fa-solid fa-magnifying-glass"></i> Review</button>' +
        '</li>'
      );
    }).join("");

    return (
      '<article class="card resume-review-queue-card">' +
        '<div class="resume-section-head">' +
          '<h3><i class="fa-solid fa-list-check"></i> AI Review Queue</h3>' +
          '<span class="chip ' + (total > 0 ? "cyan" : "subtle") + '">' + st(String(total)) + ' pending</span>' +
        '</div>' +
        walkthroughHeader +
        (rows ? '<ul class="resume-review-list">' + rows + '</ul>' : '') +
      '</article>'
    );
  }

  // R5: walkthrough helpers ---------------------------------------------------

  function startWalkthrough(r) {
    const queue = buildAiReviewQueue(r);
    if (!queue.length) return;
    view.walkthrough = { active: true, idx: 0, queueSnapshot: queue };
    stepWalkthroughTo(0);
  }

  function endWalkthrough() {
    view.walkthrough = null;
    view.preview = null;
    rerenderEditor();
  }

  function advanceWalkthrough() {
    if (!view.walkthrough || !view.walkthrough.active) return;
    const next = (view.walkthrough.idx || 0) + 1;
    if (next >= view.walkthrough.queueSnapshot.length) {
      endWalkthrough();
      if (window.CBV2 && window.CBV2.toast) {
        window.CBV2.toast.success("Walkthrough complete.");
      }
      return;
    }
    view.walkthrough.idx = next;
    stepWalkthroughTo(next);
  }

  // Shared helper used by both "Review" (single item) and walkthrough steps.
  // Scrolls to the bullet, opens its chip popover, stages option A as a
  // preview. Re-renders THEN scrolls because jumpToBullet relies on the
  // DOM being current.
  function reviewQueueItem(item) {
    if (!item || !item.bulletId) return;
    view.bulletPopoverOpenId = item.bulletId;
    const text = computePreviewText(item.bulletId, item.source, 0, item.issueKey);
    if (text) {
      view.preview = {
        bulletId: item.bulletId,
        text: text,
        source: item.source,
        optionIndex: 0,
        issueKey: item.issueKey || null,
        optionLabel: item.firstOptionLabel || ""
      };
    } else {
      view.preview = null;
    }
    rerenderEditor();
    // jumpToBullet scrolls the textarea (or preview view) into view.
    // requestAnimationFrame so the just-rerendered DOM is queryable.
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () { jumpToBullet(item.bulletId); });
    } else {
      jumpToBullet(item.bulletId);
    }
  }

  function stepWalkthroughTo(idx) {
    if (!view.walkthrough || !view.walkthrough.queueSnapshot) return;
    const item = view.walkthrough.queueSnapshot[idx];
    if (!item) { endWalkthrough(); return; }
    reviewQueueItem(item);
  }

  function renderFixQueueCard(health) {
    const rows = (health.fixes || []).map(function (f, i) {
      const primary = i === 0 ? " btn-primary" : " btn-ghost";
      return `
        <li class="resume-fix-item">
          <span class="resume-fix-icon"><i class="fa-solid ${st(f.icon || "fa-wand-magic-sparkles")}"></i></span>
          <div>
            <strong>${st(f.label)}</strong>
            <p>${st(f.detail || "")}</p>
          </div>
          <button class="btn-sm${primary}" type="button" data-lab-action="${st(f.action || "jump")}" data-section="${st(f.section || "")}">
            ${i === 0 ? "Start" : "Fix"}
          </button>
        </li>
      `;
    }).join("");
    const taskCount = (health.fixes || []).length;
    return `
      <article class="card resume-fix-queue-card resume-next-steps-card">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-list-check"></i> Next steps</h3>
          <span class="chip ${taskCount ? "cyan" : "green"}">${taskCount ? taskCount + (taskCount === 1 ? " task" : " tasks") : "All clear"}</span>
        </div>
        ${rows ? '<ul class="resume-fix-queue">' + rows + "</ul>" : '<p class="muted">No urgent fixes — your resume covers the essentials. Run the export preflight when ready.</p>'}
      </article>
    `;
  }

  function renderCritiqueCard(r) {
    const result = view.critiqueResult;
    const subscoreOrder = [
      { id: "impact", label: "Impact" },
      { id: "clarity", label: "Clarity" },
      { id: "ats", label: "ATS" },
      { id: "voice", label: "Voice" },
      { id: "presentation", label: "Presentation" }
    ];

    const head = `
      <div class="resume-section-head">
        <h3><i class="fa-solid fa-bullseye"></i> AI Critique</h3>
        ${result ? '<span class="chip subtle">' + (view.critiqueTargetRole ? st(view.critiqueTargetRole) : "General review") + "</span>" : ""}
      </div>
    `;

    if (view.critiqueBusy) {
      return `
        <article class="card resume-critique">
          ${head}
          <p class="ai-meta"><i class="fa-solid fa-circle-notch fa-spin"></i> AI is reviewing your resume against ${view.critiqueTargetRole ? st(view.critiqueTargetRole) + " standards…" : "recruiter best practices…"}</p>
        </article>
      `;
    }

    if (view.critiqueError && !result) {
      return `
        <article class="card resume-critique">
          ${head}
          <p class="ai-error">${st(view.critiqueError)}</p>
          <div class="critique-actions">
            <button class="btn-secondary btn-sm" type="button" id="critique-retry"><i class="fa-solid fa-rotate"></i> Try again</button>
          </div>
        </article>
      `;
    }

    if (!result) {
      return `
        <article class="card resume-critique resume-critique-empty">
          ${head}
          <p class="muted">Get a recruiter-grade scorecard — strengths, risks, and targeted rewrites for each weak bullet.</p>
          <div class="critique-run-row">
            <input type="text" id="critique-target-role" placeholder="Optional: target role (e.g. Senior Frontend)" value="${st(view.critiqueTargetRole)}" />
            <button class="btn-primary" type="button" id="run-critique">
              <i class="fa-solid fa-bullseye"></i> Run AI critique
            </button>
          </div>
        </article>
      `;
    }

    normalizeCritiqueIssues(result);

    const data = result.data || result;
    const score = Math.round(Number(data.score) || 0);
    const subscores = data.subscores || {};
    const sub = subscoreOrder.map(function (s) {
      const v = Math.round(Number(subscores[s.id]) || 0);
      const cls = v >= 80 ? "is-good" : v >= 60 ? "is-ok" : "is-bad";
      return `
        <div class="subscore-row ${cls}">
          <span class="subscore-label">${st(s.label)}</span>
          <div class="subscore-bar"><div class="subscore-fill" style="width:${v}%"></div></div>
          <span class="subscore-value num-font">${v}</span>
        </div>
      `;
    }).join("");

    const strengthsHtml = (data.strengths || []).length
      ? '<ul class="critique-strengths">' + data.strengths.map(function (s) {
          return '<li><i class="fa-solid fa-circle-check"></i> ' + st(s) + "</li>";
        }).join("") + "</ul>"
      : '<p class="muted">No specific strengths flagged yet.</p>';

    const issuesHtml = renderCritiqueIssues(data.issues || [], r);

    const providerChip = result.provider
      ? '<span class="chip subtle">' + st(result.provider) + "</span>"
      : "";
    const scoreCls = score >= 80 ? "is-good" : score >= 60 ? "is-ok" : "is-bad";

    return `
      <article class="card resume-critique has-result">
        ${head}
        <div class="critique-score-row">
          <div class="critique-score-ring ${scoreCls}" aria-hidden="true">
            <svg viewBox="0 0 36 36" width="84" height="84">
              <circle cx="18" cy="18" r="15.9" class="ring-track" />
              <circle cx="18" cy="18" r="15.9" class="ring-fill" style="stroke-dasharray: ${score}, 100;" />
            </svg>
            <span class="critique-score-num num-font">${score}</span>
          </div>
          <div class="critique-subscores">${sub}</div>
        </div>
        ${providerChip ? '<div class="critique-meta">' + providerChip + "</div>" : ""}
        <h4 class="critique-section-title">Strengths</h4>
        ${strengthsHtml}
        <h4 class="critique-section-title">Issues &amp; fixes <span class="chip-sm">${(data.issues || []).filter(function (i) { return !view.critiqueDismissedIds[issueKey(i)]; }).length}</span></h4>
        ${issuesHtml}
        <div class="critique-actions">
          <button class="btn-primary btn-sm" type="button" id="critique-apply-safe"><i class="fa-solid fa-check-double"></i> Apply all safe</button>
          <button class="btn-ghost btn-sm" type="button" id="critique-rerun"><i class="fa-solid fa-rotate"></i> Re-run</button>
          <button class="btn-ghost btn-sm" type="button" id="critique-clear"><i class="fa-solid fa-xmark"></i> Clear</button>
        </div>
      </article>
    `;
  }

  function issueKey(issue) {
    if (!issue) return "";
    const t = issue.target || {};
    return [issue.severity || "", issue.section || "", t.id || "", (issue.message || "").slice(0, 40)].join("|");
  }

  function renderCritiqueIssues(issues, r) {
    if (!issues.length) {
      return '<p class="muted">No issues flagged — clean resume.</p>';
    }
    const visible = issues.filter(function (i) {
      return i && typeof i === "object" && !view.critiqueDismissedIds[issueKey(i)];
    });
    if (!visible.length) {
      return '<p class="muted">All issues acknowledged.</p>';
    }

    // Sort by severity: critical > major > minor
    const weight = { critical: 0, major: 1, minor: 2 };
    visible.sort(function (a, b) {
      return (weight[a.severity] || 3) - (weight[b.severity] || 3);
    });

    return '<ul class="critique-issues">' + visible.map(function (issue, issueIdx) {
      const key = issueKey(issue);
      const toggleId = String(issueIdx);
      const applied = Boolean(view.critiqueAppliedIds[key]);
      const target = issue.target || null;
      const canApplyDirect = !!(
        target &&
        (
          (target.type === "bullet" && target.id) ||
          (target.type === "field" && target.id) ||
          (target.type === "section" && issue.section === "summary")
        )
      );
      let bulletPreview = "";
      if (target && target.type === "bullet" && target.id && r) {
        const b = findBulletById(r, target.id);
        if (b) {
          bulletPreview =
            '<div class="critique-bullet-before">' +
              '<span class="critique-bullet-label">Current</span>' +
              '<p>' + st(b.text || "") + '</p>' +
            '</div>';
        }
      }
      const replacements = canApplyDirect ? buildCritiqueRewriteOptions(issue) : [];
      // R2: pull rich (text + meta) versions in parallel. The text list is
      // the same as `replacements` above — we just attach optionMeta from
      // issue.target when present so the renderer can show real labels.
      // Reuses the outer-scope `target` (line ~1642) — re-deriving from
      // it as a defensive {} so the destructure-like reads are safe.
      const richTarget = target || {};
      const richReplacements = canApplyDirect
        ? getRewriteOptionsRich(richTarget.replacement, richTarget.alternatives, richTarget.optionMeta)
        : [];
      const expanded = !!view.critiqueExpandedIds[toggleId];
      const shown = expanded ? replacements : replacements.slice(0, 1);
      const replacementHtml = shown.length
        ? shown.map(function (text, idx) {
            const labelIdx = expanded ? idx : 0;
            // Walk the rich array by text match so labels stay aligned
            // even if buildCritiqueRewriteOptions dedupes or reorders.
            const richMatch = richReplacements.find(function (r) { return r.text === text; });
            const meta = richMatch ? richMatch.meta : null;
            return renderRewriteOptionCard(text, meta, String.fromCharCode(65 + labelIdx), st);
          }).join("")
        : "";

      const actions = [];
      if (canApplyDirect && replacements.length) {
        actions.push(
          applied
            ? '<span class="chip green critique-applied-chip"><i class="fa-solid fa-check"></i> Applied</span>'
            : shown.map(function (_, idx) {
                const optionIndex = expanded ? idx : 0;
                const label = replacements.length > 1 ? ("Apply " + (optionIndex + 1)) : "Apply fix";
                return '<button type="button" class="btn-primary btn-sm" data-critique-apply data-issue-key="' + st(key) + '" data-option-index="' + optionIndex + '"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + label + '</button>';
              }).join("")
        );
      }
      if (replacements.length > 1) {
        const hiddenCount = Math.max(0, replacements.length - 1);
        actions.push(
          '<button type="button" class="btn-ghost btn-sm" data-critique-toggle-options data-issue-toggle-id="' + st(toggleId) + '">' +
          '<i class="fa-solid fa-list"></i> ' +
          (expanded ? "Hide other suggestions" : ("Show " + hiddenCount + " more suggestion" + (hiddenCount > 1 ? "s" : ""))) +
          "</button>"
        );
      }
      if (issue.section && issue.section !== "overall") {
        actions.push(
          '<button type="button" class="btn-ghost btn-sm" data-critique-jump data-section="' + st(issue.section) + '"><i class="fa-solid fa-arrow-right"></i> Jump</button>'
        );
      }
      actions.push(
        '<button type="button" class="btn-ghost btn-sm" data-critique-dismiss data-issue-key="' + st(key) + '" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>'
      );

      return `
        <li class="critique-issue sev-${st(issue.severity || "minor")}">
          <div class="critique-issue-head">
            <span class="critique-sev sev-${st(issue.severity || "minor")}">${st((issue.severity || "minor").toUpperCase())}</span>
            <span class="critique-section">${st(sectionLabel(issue.section))}</span>
          </div>
          <p class="critique-message">${st(issue.message || "")}</p>
          <p class="critique-suggestion"><i class="fa-solid fa-lightbulb"></i> ${st(displayCritiqueSuggestion(issue))}</p>
          ${bulletPreview}
          ${replacementHtml}
          <div class="critique-issue-actions">${actions.join("")}</div>
        </li>
      `;
    }).join("") + "</ul>";
  }

  function sectionLabel(s) {
    const map = {
      header: "Header", summary: "Summary", experience: "Experience",
      education: "Education", skills: "Skills", projects: "Projects",
      certifications: "Certifications", languages: "Languages", overall: "Overall"
    };
    return map[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Overall");
  }

  /** Multi-sentence resume text: dedupe without treating common words as "instructions". */
  function getSummaryVariantOptions(primary, alternatives) {
    const out = [];
    const seen = new Set();
    const pushIf = function (v) {
      const t = String(v || "").replace(/\s+/g, " ").trim();
      if (!t || t.length < 50) return;
      const key = t.toLowerCase().slice(0, 500);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    pushIf(primary);
    if (Array.isArray(alternatives)) alternatives.forEach(pushIf);
    return out.slice(0, 3);
  }

  function synthesizeSummaryVariantsFromPrimary(primary) {
    const base = String(primary || "").replace(/\s+/g, " ").trim();
    if (!base || base.length < 80) return [];
    const parts = base.split(/(?<=[.!?])\s+/).map(function (p) { return p.trim(); }).filter(Boolean);
    const cand = [];
    if (parts.length >= 3) {
      const v = parts.slice(0, 2).join(" ");
      if (v.length >= 50) cand.push(v);
    }
    if (parts.length >= 2) {
      cand.push([parts[1], parts[0]].concat(parts.slice(2)).join(" "));
    }
    const trimmed = base
      .replace(/\b(very|really|highly|significantly|extremely)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (trimmed.length >= 50 && trimmed.toLowerCase() !== base.toLowerCase()) cand.push(trimmed);
    const filtered = cand.filter(function (c) {
      return c && c.length >= 50 && c.toLowerCase() !== base.toLowerCase();
    });
    return getSummaryVariantOptions("", filtered).slice(0, 2);
  }

  function getTailorSummaryOptions(data) {
    if (!data || typeof data.summary !== "string") return [];
    const primary = data.summary.trim();
    const raw = Array.isArray(data.summaryAlternatives) ? data.summaryAlternatives : [];
    let merged = getSummaryVariantOptions(primary, raw);
    if (merged.length < 3) {
      merged = getSummaryVariantOptions(primary, raw.concat(synthesizeSummaryVariantsFromPrimary(primary)));
    }
    return merged.slice(0, 3);
  }

  function ensureTailorPlanSummaryVariants(data) {
    if (!data || typeof data !== "object" || typeof data.summary !== "string") return;
    const opts = getTailorSummaryOptions(data);
    if (!opts.length) return;
    data.summary = opts[0];
    data.summaryAlternatives = opts.slice(1, 3);
  }

  function getRewriteOptions(primary, alternatives) {
    const out = [];
    const seen = new Set();
    const isInstruction = function (text) {
      const t = String(text || "").trim();
      if (!t) return true;
      return /^(add|use|try|rewrite|condense|focus|include|highlight|improve|avoid)\b/i.test(t);
    };
    const pushIf = function (v) {
      const t = String(v || "").trim();
      if (!t) return;
      if (isInstruction(t)) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    pushIf(primary);
    if (Array.isArray(alternatives)) {
      alternatives.forEach(pushIf);
    }
    return out.slice(0, 3);
  }

  // R2: rich variant of getRewriteOptions. Returns array of
  // { text, meta? } where meta = { label, summary, improvements[] }
  // when the AI emitted optionMeta. Falls back gracefully when meta is
  // missing (R1 "Option A/B/C" labels handled by the renderer).
  //
  // Important: we re-derive index by matching the option text back to the
  // raw [primary, ...alternatives] list, because getRewriteOptions filters
  // empties / instruction-like strings / dupes. Without this remapping the
  // meta would silently misalign when the AI emits a borderline-filtered
  // string in the middle of the list.
  function getRewriteOptionsRich(primary, alternatives, optionMeta) {
    const texts = getRewriteOptions(primary, alternatives);
    const rawList = [primary].concat(Array.isArray(alternatives) ? alternatives : []);
    const metaList = Array.isArray(optionMeta) ? optionMeta : [];
    return texts.map(function (text) {
      const idx = rawList.findIndex(function (raw) {
        return String(raw || "").trim() === text;
      });
      const meta = idx >= 0 && metaList[idx] && typeof metaList[idx] === "object" ? metaList[idx] : null;
      return { text: text, meta: meta };
    });
  }

  // Renders one rewrite option as a card. When `meta` is present (R2 AI
  // emitted optionMeta), the card shows the AI's label + improvement chips
  // + a one-line summary. When absent (legacy / cached results), it falls
  // back to "Option A/B/C" with no extras.
  function renderRewriteOptionCard(text, meta, indexLetter, st) {
    const fallbackLabel = "Option " + indexLetter;
    const label = meta && typeof meta.label === "string" && meta.label.trim()
      ? meta.label.trim()
      : fallbackLabel;
    const improvements = meta && Array.isArray(meta.improvements) ? meta.improvements : [];
    const improvementsHtml = improvements.length
      ? '<div class="rewrite-improvements">' +
        improvements.slice(0, 4).map(function (tag) {
          const t = String(tag || "").trim();
          if (!t) return "";
          const isAddition = /^\+/.test(t);
          return '<span class="rewrite-chip ' + (isAddition ? "rewrite-chip--add" : "rewrite-chip--qual") + '">' + st(t) + '</span>';
        }).filter(Boolean).join("") +
        '</div>'
      : "";
    const summary = meta && typeof meta.summary === "string" && meta.summary.trim();
    const summaryHtml = summary
      ? '<p class="rewrite-why"><i class="fa-solid fa-lightbulb"></i> ' + st(summary) + '</p>'
      : "";
    return (
      '<div class="critique-bullet-after">' +
        '<div class="rewrite-head">' +
          '<span class="critique-bullet-label">' + st(label) + '</span>' +
          improvementsHtml +
        '</div>' +
        '<p>' + st(text) + '</p>' +
        summaryHtml +
      '</div>'
    );
  }

  function normalizeSentence(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    return /[.!?]$/.test(t) ? t : (t + ".");
  }

  function generateFallbackAlternatives(text) {
    const base = normalizeSentence(text);
    if (!base) return [];
    const out = [];
    const add = function (v) {
      const t = normalizeSentence(v);
      if (!t) return;
      if (t.toLowerCase() === base.toLowerCase()) return;
      if (out.some(function (x) { return x.toLowerCase() === t.toLowerCase(); })) return;
      out.push(t);
    };

    // Generate style variants (not instructional rewording).
    const concise = base
      .replace(/\b(very|really|highly|significantly)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    add(concise);

    const balanced = base
      .replace(/\bparticipated in\b/i, "Contributed to")
      .replace(/\bworked on\b/i, "Delivered")
      .trim();
    add(balanced);

    const detailed = base
      .replace(/\.$/, "") +
      ", with clear ownership across planning, execution, and delivery.";
    add(detailed);
    return out.slice(0, 2);
  }

  function coerceCritiqueSuggestionInput(issue) {
    if (!issue || typeof issue !== "object") return "";
    function fromVal(v) {
      if (v == null) return "";
      if (typeof v === "string") return v.trim();
      if (typeof v === "number" && isFinite(v)) return String(v).trim();
      if (Array.isArray(v)) {
        const parts = [];
        for (let i = 0; i < v.length; i += 1) {
          const p = fromVal(v[i]);
          if (p) parts.push(p);
        }
        return parts.join(" ").trim();
      }
      if (typeof v === "object" && typeof v.text === "string") return v.text.trim();
      return "";
    }
    const keys = [
      "suggestion", "fix", "recommendation", "advice", "remediation", "hint",
      "action", "improvement", "guidance", "guide", "nextStep", "tip",
      "suggested_fix", "suggestedFix", "help", "resolution", "mitigation"
    ];
    for (let i = 0; i < keys.length; i += 1) {
      const got = fromVal(issue[keys[i]]);
      if (got) return got;
    }
    if (issue.details && typeof issue.details === "object") {
      const d = issue.details;
      const dGot = fromVal(d.suggestion) || fromVal(d.fix) || fromVal(d.note) || fromVal(d.guidance);
      if (dGot) return dGot;
    }
    if (Array.isArray(issue.suggestions)) {
      const s0 = fromVal(issue.suggestions[0]);
      if (s0) return s0;
    }
    return "";
  }

  function defaultCritiqueSuggestion(issue) {
    const sec = (issue && issue.section) || "overall";
    const map = {
      header: "Complete the header with name, professional email, phone if appropriate, location, and 1–2 relevant links (LinkedIn, portfolio).",
      summary: "Rewrite the summary as 2–3 sentences: who you are, what you build/do, and one proof point already on this resume.",
      experience: "Tighten each role: clearer company context where missing, stronger verbs, and bullets that end with outcomes or scope—not task lists alone.",
      education: "Add degree, field, school, and dates; include honors or coursework only when they support your target role.",
      skills: "Group skills into scannable clusters (e.g. Languages, Frameworks, Cloud) and mirror phrasing from postings you want.",
      projects: "For each project: one line on goal, your role, stack, and impact (metric or qualitative).",
      certifications: "List credential, issuer, and date; spell acronyms once if recruiters might not know them.",
      languages: "State level honestly (e.g. native / professional working / B2) if the role needs it.",
      overall: "Work section by section: align every paragraph and bullet to one target role and remove anything that does not support that story."
    };
    const base = map[sec] || map.overall;
    const msg = issue && typeof issue.message === "string"
      ? issue.message.replace(/\s+/g, " ").trim()
      : "";
    if (msg) {
      return (
        base +
        " Apply it directly to this note: \"" +
        msg.slice(0, 220) +
        (msg.length > 220 ? "…" : "") +
        "\"."
      );
    }
    return base;
  }

  function displayCritiqueSuggestion(issue) {
    const fromModel = coerceCritiqueSuggestionInput(issue);
    if (fromModel) return fromModel;
    return defaultCritiqueSuggestion(issue);
  }

  function normalizeCritiqueIssues(result) {
    if (!result || typeof result !== "object") return result;
    const data = result.data && typeof result.data === "object" ? result.data : result;
    if (!data || !Array.isArray(data.issues)) return result;
    data.issues = data.issues.filter(function (x) { return x != null; });
    data.issues = data.issues.map(function (issue) {
      if (typeof issue === "string") {
        const m = issue.trim();
        return {
          severity: "minor",
          section: "overall",
          message: m || "Resume issue",
          suggestion: ""
        };
      }
      return issue;
    });
    data.issues.forEach(function (issue) {
      if (!issue || typeof issue !== "object") return;
      const fromModel = coerceCritiqueSuggestionInput(issue);
      issue.suggestion = fromModel || defaultCritiqueSuggestion(issue);
    });
    return result;
  }

  function ensureCritiqueAlternatives(result) {
    if (!result) return result;
    const data = result.data || result;
    if (!data || !Array.isArray(data.issues)) return result;
    data.issues.forEach(function (issue) {
      if (!issue || typeof issue !== "object") return;
      if (!issue.target || typeof issue.target !== "object") return;
      const target = issue.target;
      if (!target.replacement) return;
      if (issue.section === "summary" && target.type === "section") {
        if (!Array.isArray(target.alternatives)) target.alternatives = [];
        let merged = getSummaryVariantOptions(target.replacement, target.alternatives);
        if (merged.length < 3) {
          merged = getSummaryVariantOptions(
            target.replacement,
            target.alternatives.concat(synthesizeSummaryVariantsFromPrimary(target.replacement))
          );
        }
        if (merged.length) {
          target.replacement = merged[0];
          target.alternatives = merged.slice(1, 3);
        }
        return;
      }
      if (!Array.isArray(target.alternatives)) target.alternatives = [];
      const existing = getRewriteOptions(target.replacement, target.alternatives);
      if (existing.length >= 3) return;
      const fallback = generateFallbackAlternatives(target.replacement)
        .concat(generateFallbackAlternatives(issue.suggestion || ""));
      target.alternatives = target.alternatives.concat(fallback);
      const finalSet = getRewriteOptions(target.replacement, target.alternatives);
      target.alternatives = finalSet.slice(1);
    });
    return result;
  }

  function buildCritiqueRewriteOptions(issue) {
    const target = (issue && issue.target) || {};
    const primary = target.replacement || "";
    const useSummary = issue && issue.section === "summary" && target.type === "section";
    const aggregate = useSummary ? getSummaryVariantOptions : getRewriteOptions;
    let options = aggregate(primary, target.alternatives);
    if (options.length >= 3) return options.slice(0, 3);
    const extra = useSummary
      ? synthesizeSummaryVariantsFromPrimary(primary)
      : generateFallbackAlternatives(primary)
        .concat(generateFallbackAlternatives(issue && issue.suggestion))
        .concat(generateFallbackAlternatives(issue && issue.message));
    options = aggregate(primary, (target.alternatives || []).concat(extra));
    return options.slice(0, 3);
  }

  function findBulletById(r, id) {
    if (!r || !id) return null;
    const pools = [r.experience, r.projects];
    for (let i = 0; i < pools.length; i += 1) {
      const list = pools[i] || [];
      for (let j = 0; j < list.length; j += 1) {
        const bullets = list[j].bullets || [];
        for (let k = 0; k < bullets.length; k += 1) {
          if (bullets[k].id === id) return bullets[k];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // R3: inline per-bullet AI suggestion affordance.
  //
  // Before R3, every tailor / critique suggestion lived in the right sidebar.
  // The user had to mentally bridge "I see suggestion in sidebar → find bullet
  // in editor → click apply → trust the right thing changed". With R3, every
  // bullet that has a pending AI suggestion grows a small chip at the end of
  // its row, and clicking the chip expands a popover with the R2 option cards
  // anchored AT the bullet. The sidebar still lists everything for users who
  // want an overview, but the primary interaction surface is now inline.
  // ---------------------------------------------------------------------------

  // Returns the pending tailor bullet (if any) targeting this bullet, or null.
  // Pending = exists in tailorPlan AND not already applied AND not dismissed.
  function getPendingTailorForBullet(bulletId) {
    if (!bulletId) return null;
    const plan = view.tailorPlan;
    if (!plan) return null;
    const data = plan.data || plan;
    const bullets = (data && Array.isArray(data.bullets)) ? data.bullets : [];
    const match = bullets.find(function (b) { return b && b.targetBulletId === bulletId; });
    if (!match) return null;
    if (view.tailorAppliedIds[bulletId]) return null;
    if (view.tailorDismissedIds[bulletId]) return null;
    return match;
  }

  // Returns the array of pending critique issues whose target is this bullet.
  // Same filter logic (not applied, not dismissed).
  function getPendingCritiqueIssuesForBullet(bulletId) {
    if (!bulletId) return [];
    const result = view.critiqueResult;
    if (!result) return [];
    const data = result.data || result;
    const issues = (data && Array.isArray(data.issues)) ? data.issues : [];
    return issues.filter(function (issue) {
      const t = issue && issue.target;
      if (!t || t.type !== "bullet" || t.id !== bulletId) return false;
      const key = issueKey(issue);
      if (!key) return false;
      if (view.critiqueAppliedIds[key]) return false;
      if (view.critiqueDismissedIds[key]) return false;
      return true;
    });
  }

  // Total count of pending suggestions for the chip badge.
  function pendingSuggestionCountForBullet(bulletId) {
    const tailorCount = getPendingTailorForBullet(bulletId) ? 1 : 0;
    const critiqueCount = getPendingCritiqueIssuesForBullet(bulletId).length;
    const strengthenCount = getPendingStrengthenForBullet(bulletId) ? 1 : 0;
    return tailorCount + critiqueCount + strengthenCount;
  }

  // Short headline summarizing what the AI is offering, surfaced on the
  // closed chip. Format: "3 rewrites · +2 keywords" — count + the first
  // strong improvement from the first suggestion, so the user gets a
  // signal of *what's good about it* without clicking.
  function bulletChipHeadline(bulletId) {
    const tailor = getPendingTailorForBullet(bulletId);
    const critiques = getPendingCritiqueIssuesForBullet(bulletId);
    const totalSuggestions = (tailor ? 1 : 0) + critiques.length;
    const totalOptions = (tailor ? getRewriteOptions(tailor.rewrite, tailor.alternatives).length : 0) +
      critiques.reduce(function (s, i) { return s + buildCritiqueRewriteOptions(i).length; }, 0);

    // Pull the first improvement tag we can find (tailor takes precedence).
    let topImprovement = "";
    const pickFirstImprovement = function (meta) {
      if (!meta || !Array.isArray(meta.improvements)) return "";
      for (let i = 0; i < meta.improvements.length; i += 1) {
        const t = String(meta.improvements[i] || "").trim();
        if (t) return t;
      }
      return "";
    };
    if (tailor && Array.isArray(tailor.optionMeta)) {
      for (let i = 0; i < tailor.optionMeta.length && !topImprovement; i += 1) {
        topImprovement = pickFirstImprovement(tailor.optionMeta[i]);
      }
    }
    if (!topImprovement) {
      for (let i = 0; i < critiques.length && !topImprovement; i += 1) {
        const t = critiques[i] && critiques[i].target;
        const meta = t && Array.isArray(t.optionMeta) ? t.optionMeta : [];
        for (let j = 0; j < meta.length && !topImprovement; j += 1) {
          topImprovement = pickFirstImprovement(meta[j]);
        }
      }
    }

    const countLabel = totalSuggestions === 1
      ? (totalOptions === 1 ? "1 rewrite" : totalOptions + " options")
      : (totalSuggestions + " suggestions");
    return topImprovement ? (countLabel + " · " + topImprovement) : countLabel;
  }

  // ---------------------------------------------------------------------------
  // R5: unified AI Review Queue.
  //
  // Merges every pending bullet-targeted suggestion from tailor + critique
  // into one ordered list. Severity order: critical critique > major
  // critique > tailor rewrites > minor critique. This is the data behind
  // the new sidebar card AND the "Review all" walkthrough.
  //
  // Critique issues WITHOUT a bullet target (summary, section, field) are
  // out of scope here — they stay in the existing critique card. R5 is
  // about replacing the bullet-suggestion experience, not the whole panel.
  // ---------------------------------------------------------------------------
  function buildAiReviewQueue(r) {
    if (!r) return [];
    const out = [];

    const allBulletIds = collectAllBulletIds(r);

    // Critique issues (bullet target only)
    const critiqueData = view.critiqueResult ? (view.critiqueResult.data || view.critiqueResult) : null;
    const critiqueIssues = critiqueData && Array.isArray(critiqueData.issues) ? critiqueData.issues : [];
    critiqueIssues.forEach(function (issue) {
      const t = issue && issue.target;
      if (!t || t.type !== "bullet" || !t.id) return;
      if (!allBulletIds[t.id]) return;
      const key = issueKey(issue);
      if (!key) return;
      if (view.critiqueAppliedIds[key]) return;
      if (view.critiqueDismissedIds[key]) return;
      out.push({
        source: "critique",
        bulletId: t.id,
        issueKey: key,
        severity: String(issue.severity || "minor").toLowerCase(),
        headline: issue.message || displayCritiqueSuggestion(issue) || "Critique suggestion",
        firstOptionLabel: firstOptionLabelFromMeta(t.optionMeta) || ""
      });
    });

    // Tailor bullets
    const tailorData = view.tailorPlan ? (view.tailorPlan.data || view.tailorPlan) : null;
    const tailorBullets = tailorData && Array.isArray(tailorData.bullets) ? tailorData.bullets : [];
    tailorBullets.forEach(function (b) {
      if (!b || !b.targetBulletId) return;
      if (!allBulletIds[b.targetBulletId]) return;
      if (view.tailorAppliedIds[b.targetBulletId]) return;
      if (view.tailorDismissedIds[b.targetBulletId]) return;
      out.push({
        source: "tailor",
        bulletId: b.targetBulletId,
        severity: "tailor",
        headline: b.rationale || "JD-aligned rewrite",
        firstOptionLabel: firstOptionLabelFromMeta(b.optionMeta) || ""
      });
    });

    // Strengthen results (user-triggered per-bullet AI rewrites)
    const strengthenMap = view.strengthenResults || {};
    Object.keys(strengthenMap).forEach(function (bulletId) {
      if (!allBulletIds[bulletId]) return;
      const row = strengthenMap[bulletId];
      if (!row || !Array.isArray(row.rewrites) || !row.rewrites.length) return;
      out.push({
        source: "strengthen",
        bulletId: bulletId,
        severity: "strengthen",
        headline: "On-demand AI rewrite",
        firstOptionLabel: firstOptionLabelFromMeta(row.optionMeta) || ""
      });
    });

    // Severity ordering: critical > major > strengthen (user-asked) > tailor > minor.
    // Strengthen ranks ahead of tailor because the user explicitly clicked
    // the wand on that bullet — they want to see those results first.
    const rank = { critical: 0, major: 1, strengthen: 2, tailor: 3, minor: 4 };
    out.sort(function (a, b) {
      return (rank[a.severity] != null ? rank[a.severity] : 4) -
             (rank[b.severity] != null ? rank[b.severity] : 4);
    });
    return out;
  }

  function collectAllBulletIds(r) {
    const ids = {};
    [r.experience, r.projects].forEach(function (pool) {
      (pool || []).forEach(function (entry) {
        (entry.bullets || []).forEach(function (b) { if (b && b.id) ids[b.id] = true; });
      });
    });
    return ids;
  }

  function firstOptionLabelFromMeta(metaArr) {
    if (!Array.isArray(metaArr)) return "";
    for (let i = 0; i < metaArr.length; i += 1) {
      const m = metaArr[i];
      if (m && typeof m.label === "string" && m.label.trim()) return m.label.trim();
    }
    return "";
  }

  function bulletTextSnippet(r, bulletId, max) {
    const b = findBulletById(r, bulletId);
    if (!b) return "";
    const t = String(b.text || "").replace(/\s+/g, " ").trim();
    const lim = max || 70;
    return t.length > lim ? (t.slice(0, lim - 1) + "…") : t;
  }

  // R4: resolves the proposed rewrite text for a (bulletId, source,
  // optionIndex, issueKey?) tuple. Returns "" when no match — caller
  // skips activating the preview in that case. Resolution uses the same
  // getRewriteOptions ordering the popover renders from, so optionIndex
  // is consistent between Preview button and Accept callback.
  function computePreviewText(bulletId, source, optionIndex, key) {
    if (!bulletId) return "";
    const idx = Math.max(0, Number(optionIndex) || 0);
    if (source === "tailor") {
      const tailor = getPendingTailorForBullet(bulletId);
      if (!tailor) return "";
      const opts = getRewriteOptions(tailor.rewrite, tailor.alternatives);
      return opts[idx] || opts[0] || "";
    }
    if (source === "critique" && key) {
      const issues = getPendingCritiqueIssuesForBullet(bulletId);
      // issueKey() is the function defined at module scope; comparing its
      // derived value to the caller's key string locates the right issue.
      const issue = issues.find(function (i) { return issueKey(i) === key; });
      if (!issue) return "";
      const opts = buildCritiqueRewriteOptions(issue);
      return opts[idx] || opts[0] || "";
    }
    if (source === "strengthen") {
      const pending = getPendingStrengthenForBullet(bulletId);
      if (!pending) return "";
      return pending.rewrites[idx] || pending.rewrites[0] || "";
    }
    return "";
  }

  // Renders the inline chip (always visible when ≥1 pending suggestion)
  // plus the expanded popover when this bullet is the active one. Returns
  // an empty string when there's nothing pending so existing layout is
  // untouched.
  function renderBulletAiAffordance(bulletId) {
    if (!bulletId) return "";
    const count = pendingSuggestionCountForBullet(bulletId);
    if (count === 0) return "";
    const isOpen = view.bulletPopoverOpenId === bulletId;
    const headline = bulletChipHeadline(bulletId);
    const chipCls = isOpen ? "bullet-ai-chip is-open" : "bullet-ai-chip";
    const chip =
      '<button type="button" class="' + chipCls + '"' +
      ' data-bullet-ai-toggle data-bullet-id="' + st(bulletId) + '"' +
      ' title="AI suggestion for this bullet — click to expand">' +
        '<i class="fa-solid fa-wand-magic-sparkles"></i>' +
        '<span class="bullet-ai-chip-label">' + st(headline) + '</span>' +
        '<i class="fa-solid fa-chevron-' + (isOpen ? "up" : "down") + ' bullet-ai-chip-caret"></i>' +
      '</button>';
    if (!isOpen) return chip;
    return chip + renderBulletAiPopover(bulletId);
  }

  // The inline popover shown when the chip is open. Lists every pending
  // suggestion for this bullet (tailor first if present, then critique
  // issues), each rendered with the R2 cards. Apply buttons delegate to
  // the existing data-apply-bullet / data-critique-apply handlers, so the
  // accept logic is shared with the sidebar entry points.
  function renderBulletAiPopover(bulletId) {
    const tailor = getPendingTailorForBullet(bulletId);
    const critiques = getPendingCritiqueIssuesForBullet(bulletId);
    const strengthen = getPendingStrengthenForBullet(bulletId);
    const sections = [];

    // Strengthen section — placed FIRST when present because the user
    // explicitly clicked the wand to summon it; they expect to see it
    // immediately, not buried under tailor/critique.
    if (strengthen) {
      const meta = Array.isArray(strengthen.optionMeta) ? strengthen.optionMeta : [];
      const optionsHtml = strengthen.rewrites.map(function (text, idx) {
        const letter = String.fromCharCode(65 + idx);
        const m = meta[idx] && typeof meta[idx] === "object" ? meta[idx] : null;
        const card = renderRewriteOptionCard(text, m, letter, st);
        const isCurrentPreview = !!(view.preview &&
          view.preview.bulletId === bulletId &&
          view.preview.source === "strengthen" &&
          view.preview.optionIndex === idx);
        const optionLabel = (m && m.label) ? m.label : ("Option " + letter);
        const previewBtn = isCurrentPreview
          ? '<span class="chip cyan"><i class="fa-solid fa-eye"></i> Previewing</span>'
          : '<button type="button" class="btn-secondary btn-sm" data-preview-bullet' +
            ' data-bullet-id="' + st(bulletId) + '"' +
            ' data-source="strengthen"' +
            ' data-option-index="' + idx + '"' +
            ' data-option-label="' + st(optionLabel) + '">' +
            '<i class="fa-solid fa-eye"></i> Preview</button>';
        const wrapCls = isCurrentPreview ? 'bullet-ai-option is-previewing' : 'bullet-ai-option';
        return '<div class="' + wrapCls + '">' + card +
          '<div class="bullet-ai-option-actions">' + previewBtn + '</div></div>';
      }).join("");
      sections.push(
        '<section class="bullet-ai-section">' +
          '<div class="bullet-ai-section-head">' +
            '<span class="chip cyan"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Strengthen</span>' +
          '</div>' +
          optionsHtml +
          '<div class="bullet-ai-section-foot">' +
            '<button type="button" class="btn-ghost btn-sm" data-dismiss-strengthen data-id="' + st(bulletId) + '">' +
              '<i class="fa-solid fa-xmark"></i> Discard rewrites' +
            '</button>' +
          '</div>' +
        '</section>'
      );
    }

    if (tailor) {
      const richRewrites = getRewriteOptionsRich(tailor.rewrite, tailor.alternatives, tailor.optionMeta);
      const optionsHtml = richRewrites.map(function (item, idx) {
        const letter = String.fromCharCode(65 + idx);
        const card = renderRewriteOptionCard(item.text, item.meta, letter, st);
        // R4: Preview-first flow. The button stages a preview in the bullet
        // (struck old + new highlighted) and the user confirms with Accept
        // there. The is-previewing class on the OPTION card makes it visually
        // clear which one is currently staged when the popover stays open.
        const isCurrentPreview = !!(view.preview &&
          view.preview.bulletId === bulletId &&
          view.preview.source === "tailor" &&
          view.preview.optionIndex === idx);
        const optionLabel = (item.meta && item.meta.label) ? item.meta.label : ("Option " + letter);
        const previewBtn = isCurrentPreview
          ? '<span class="chip cyan"><i class="fa-solid fa-eye"></i> Previewing</span>'
          : '<button type="button" class="btn-secondary btn-sm" data-preview-bullet' +
            ' data-bullet-id="' + st(bulletId) + '"' +
            ' data-source="tailor"' +
            ' data-option-index="' + idx + '"' +
            ' data-option-label="' + st(optionLabel) + '">' +
            '<i class="fa-solid fa-eye"></i> Preview</button>';
        const wrapCls = isCurrentPreview ? 'bullet-ai-option is-previewing' : 'bullet-ai-option';
        return '<div class="' + wrapCls + '">' + card +
          '<div class="bullet-ai-option-actions">' + previewBtn + '</div></div>';
      }).join("");
      const rationale = tailor.rationale
        ? '<p class="critique-suggestion"><i class="fa-solid fa-lightbulb"></i> ' + st(tailor.rationale) + '</p>'
        : "";
      sections.push(
        '<section class="bullet-ai-section">' +
          '<div class="bullet-ai-section-head"><span class="chip cyan"><i class="fa-solid fa-bullseye"></i> Tailor rewrite</span></div>' +
          rationale +
          optionsHtml +
          '<div class="bullet-ai-section-foot">' +
            '<button type="button" class="btn-ghost btn-sm" data-dismiss-bullet data-id="' + st(bulletId) + '">' +
              '<i class="fa-solid fa-xmark"></i> Dismiss this rewrite' +
            '</button>' +
          '</div>' +
        '</section>'
      );
    }

    critiques.forEach(function (issue) {
      const key = issueKey(issue) || "";
      const target = issue.target || {};
      const richReplacements = getRewriteOptionsRich(target.replacement, target.alternatives, target.optionMeta);
      const optionsHtml = richReplacements.map(function (item, idx) {
        const letter = String.fromCharCode(65 + idx);
        const card = renderRewriteOptionCard(item.text, item.meta, letter, st);
        const isCurrentPreview = !!(view.preview &&
          view.preview.bulletId === bulletId &&
          view.preview.source === "critique" &&
          view.preview.issueKey === key &&
          view.preview.optionIndex === idx);
        const optionLabel = (item.meta && item.meta.label) ? item.meta.label : ("Option " + letter);
        const previewBtn = isCurrentPreview
          ? '<span class="chip cyan"><i class="fa-solid fa-eye"></i> Previewing</span>'
          : '<button type="button" class="btn-secondary btn-sm" data-preview-bullet' +
            ' data-bullet-id="' + st(bulletId) + '"' +
            ' data-source="critique"' +
            ' data-issue-key="' + st(key) + '"' +
            ' data-option-index="' + idx + '"' +
            ' data-option-label="' + st(optionLabel) + '">' +
            '<i class="fa-solid fa-eye"></i> Preview</button>';
        const wrapCls = isCurrentPreview ? 'bullet-ai-option is-previewing' : 'bullet-ai-option';
        return '<div class="' + wrapCls + '">' + card +
          '<div class="bullet-ai-option-actions">' + previewBtn + '</div></div>';
      }).join("");
      const sevTone = issue.severity === "critical" ? "warning"
        : (issue.severity === "major" ? "amber" : "subtle");
      const sevLabel = String(issue.severity || "minor").toUpperCase();
      sections.push(
        '<section class="bullet-ai-section">' +
          '<div class="bullet-ai-section-head">' +
            '<span class="chip ' + sevTone + '"><i class="fa-solid fa-triangle-exclamation"></i> Critique · ' + st(sevLabel) + '</span>' +
          '</div>' +
          '<p class="critique-message">' + st(issue.message || "") + '</p>' +
          '<p class="critique-suggestion"><i class="fa-solid fa-lightbulb"></i> ' + st(displayCritiqueSuggestion(issue)) + '</p>' +
          optionsHtml +
          '<div class="bullet-ai-section-foot">' +
            '<button type="button" class="btn-ghost btn-sm" data-critique-dismiss data-issue-key="' + st(key) + '">' +
              '<i class="fa-solid fa-xmark"></i> Dismiss this issue' +
            '</button>' +
          '</div>' +
        '</section>'
      );
    });

    return (
      '<div class="bullet-ai-popover" data-bullet-ai-popover="' + st(bulletId) + '">' +
        '<button type="button" class="bullet-ai-popover-close" data-bullet-ai-close aria-label="Close suggestions">' +
          '<i class="fa-solid fa-xmark"></i>' +
        '</button>' +
        sections.join("") +
      '</div>'
    );
  }

  // R4: returns the inline content for a bullet row — either the normal
  // textarea + icon buttons, OR a track-changes preview view (struck
  // original + highlighted new text + Accept/Cancel). The preview is
  // session state (view.preview), never persisted; Accept commits via
  // the existing apply paths, Cancel restores the textarea.
  //
  // Used by both renderExperienceSection and renderProjectsSection so
  // the preview UX is identical across both bullet pools.
  function renderBulletInlineContent(b, parentId, scope) {
    // Defensive: if the preview targets this bullet but the underlying
    // suggestion has since been applied / dismissed / wiped by a fresh
    // critique or tailor run, computePreviewText returns "" and we
    // self-clean. Without this the user could see a stale before/after
    // long after the source suggestion is gone.
    if (view.preview && view.preview.bulletId === b.id) {
      const stillThere = computePreviewText(
        view.preview.bulletId,
        view.preview.source,
        view.preview.optionIndex,
        view.preview.issueKey
      );
      if (!stillThere) view.preview = null;
    }
    const isPreviewing = !!(view.preview && view.preview.bulletId === b.id);
    if (isPreviewing) {
      const newText = String(view.preview.text || "");
      const optionLabel = view.preview.optionLabel || "Preview";
      const sourceLabel = view.preview.source === "tailor" ? "Tailor" : "Critique";
      return (
        '<div class="bullet-preview" data-bullet-preview-id="' + st(b.id) + '">' +
          '<div class="bullet-preview-head">' +
            '<span class="chip cyan"><i class="fa-solid fa-eye"></i> Preview · ' + st(sourceLabel) + ' · ' + st(optionLabel) + '</span>' +
          '</div>' +
          '<div class="bullet-preview-diff">' +
            '<div class="bullet-preview-old">' +
              '<span class="bullet-preview-label">Current</span>' +
              '<p><s>' + st(b.text || "") + '</s></p>' +
            '</div>' +
            '<div class="bullet-preview-new">' +
              '<span class="bullet-preview-label">After Accept</span>' +
              '<p>' + st(newText) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="bullet-preview-actions">' +
            '<button type="button" class="btn-primary btn-sm" data-preview-accept data-bullet-id="' + st(b.id) + '">' +
              '<i class="fa-solid fa-check"></i> Accept' +
            '</button>' +
            '<button type="button" class="btn-ghost btn-sm" data-preview-cancel>' +
              '<i class="fa-solid fa-rotate-left"></i> Cancel' +
            '</button>' +
          '</div>' +
        '</div>'
      );
    }
    // Normal mode — original textarea + 3 icon buttons.
    // Wand icon shows a spinner while bullet-strengthen is in flight for
    // this bullet, and gets disabled to prevent double-fires.
    const scopeAttr = scope === "projects" ? ' data-scope="projects"' : '';
    const isLoading = view.strengthenLoadingId === b.id;
    const wandIcon = isLoading
      ? '<i class="fa-solid fa-spinner fa-spin"></i>'
      : '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    const wandTitle = isLoading ? "Generating rewrites…" : "Strengthen with AI";
    return (
      '<textarea rows="2" data-bullet-text data-exp-id="' + st(parentId) + '" data-bullet-id="' + st(b.id) + '"' + scopeAttr +
        ' placeholder="' + (scope === "projects" ? '' : '• Shipped X that lifted Y by Z%...') + '">' + st(b.text) + '</textarea>' +
      '<button type="button" class="icon-btn" data-bullet-strengthen data-exp-id="' + st(parentId) + '" data-bullet-id="' + st(b.id) + '"' + scopeAttr +
        ' aria-label="' + wandTitle + '" title="' + wandTitle + '"' +
        (isLoading ? ' disabled' : '') + '>' + wandIcon + '</button>' +
      '<button type="button" class="icon-btn" data-bullet-save-asset data-exp-id="' + st(parentId) + '" data-bullet-id="' + st(b.id) + '"' + scopeAttr + ' title="Save to Career Assets"><i class="fa-solid fa-bookmark"></i></button>' +
      '<button type="button" class="icon-btn danger" data-bullet-remove data-exp-id="' + st(parentId) + '" data-bullet-id="' + st(b.id) + '"' + scopeAttr + ' aria-label="Remove ' + (scope === "projects" ? '' : 'bullet') + '"><i class="fa-solid fa-xmark"></i></button>'
    );
  }

  // ---------------------------------------------------------------------------
  // Tailor workspace (Phase 3 — Tailor-for-a-Job mode)
  // ---------------------------------------------------------------------------
  function renderTailorWorkspace(r) {
    return `
      <aside class="resume-tailor-workspace">
        ${renderTailorJdCard()}
        ${view.jdAnalyzed ? renderJdAnalysisCard(view.jdAnalyzed, r) : ""}
        ${view.tailorPlan ? renderTailorPlanCard(view.tailorPlan, r) : renderPlanEmptyCta()}
        ${renderAiAssetSuggestionsCard(r)}
      </aside>
    `;
  }

  function renderTailorJdCard() {
    const busy = view.jdBusy;
    const err = view.jdError;
    const inferredRole = inferTargetRoleFromResume(currentResume());
    const activeRole = getActiveRoleContext();
    return `
      <article class="card tailor-jd-card">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-file-lines"></i> Job description</h3>
          ${view.jdAnalyzed ? '<span class="chip subtle">Analyzed</span>' : ""}
        </div>
        ${renderActiveRoleContextBanner(activeRole, "compact")}
        <form id="tailor-jd-form" class="form-grid">
          <label class="form-row-full">Target role (optional)
            <input type="text" name="targetRole" id="tailor-target-role" placeholder="e.g. Senior Frontend Engineer" value="${st(view.jdRole)}" />
          </label>
          ${!view.jdRole && inferredRole
            ? '<p class="tailor-role-hint">Using inferred role from your resume: <span class="chip subtle">' + st(inferredRole) + '</span> <button type="button" class="btn-ghost btn-sm" id="fill-inferred-role">Use in field</button></p>'
            : ""}
          <label class="form-row-full">Paste the JD
            <textarea id="tailor-jd-text" name="jdText" rows="8" placeholder="Paste the full job description here...">${st(view.jdText)}</textarea>
          </label>
          <div class="form-actions form-row-full tailor-jd-actions">
            <button class="btn-primary" type="submit" id="run-jd-analyze" ${busy ? "disabled" : ""}>
              ${busy ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Analyzing…' : '<i class="fa-solid fa-magnifying-glass"></i> Analyze JD'}
            </button>
            ${view.jdAnalyzed ? '<button class="btn-ghost btn-sm" type="button" id="clear-jd"><i class="fa-solid fa-xmark"></i> Clear</button>' : ""}
          </div>
        </form>
        ${err ? '<p class="ai-error">' + st(err) + '</p>' : ''}
      </article>
    `;
  }

  function renderJdAnalysisCard(jd, r) {
    const role = jd.role || view.jdRole || "(role not detected)";
    const seniority = jd.seniority && jd.seniority !== "unspecified" ? jd.seniority : "";
    const remote = jd.remote && jd.remote !== "unspecified" ? jd.remote : "";
    const meta = [
      seniority ? '<span class="chip subtle">' + st(seniority.charAt(0).toUpperCase() + seniority.slice(1)) + "</span>" : "",
      remote ? '<span class="chip subtle">' + st(remote) + "</span>" : "",
      jd.company ? '<span class="chip subtle">' + st(jd.company) + "</span>" : "",
      jd.location ? '<span class="chip subtle">' + st(jd.location) + "</span>" : ""
    ].filter(Boolean).join(" ");

    // Coverage computed against current resume
    const coverage = computeCoverage(jd, r);
    const covPct = coverage.total ? Math.round((coverage.matched.length / coverage.total) * 100) : 0;
    const covCls = covPct >= 70 ? "is-good" : covPct >= 40 ? "is-ok" : "is-bad";

    const matchedChips = coverage.matched.map(function (k) {
      return '<span class="coverage-chip coverage-matched"><i class="fa-solid fa-check"></i> ' + st(k) + '</span>';
    }).join(" ");
    const missingChips = coverage.missing.map(function (k) {
      return '<span class="coverage-chip coverage-missing"><i class="fa-solid fa-circle-exclamation"></i> ' + st(k) + '</span>';
    }).join(" ");

    return `
      <article class="card tailor-jd-analysis">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-briefcase"></i> ${st(role)}</h3>
          ${meta ? '<div class="chip-cluster">' + meta + '</div>' : ""}
        </div>

        <div class="coverage-summary ${covCls}">
          <div class="coverage-bar"><div class="coverage-fill" style="width:${covPct}%"></div></div>
          <p class="coverage-label">
            <span class="num-font">${covPct}%</span> keyword coverage
            <span class="muted">· ${coverage.matched.length}/${coverage.total} JD terms present</span>
          </p>
        </div>

        ${coverage.matched.length ? '<h4 class="critique-section-title">Matched</h4><div class="coverage-chip-cluster">' + matchedChips + '</div>' : ''}
        ${coverage.missing.length ? '<h4 class="critique-section-title">Missing <span class="chip-sm">' + coverage.missing.length + '</span></h4><div class="coverage-chip-cluster">' + missingChips + '</div>' : ''}

        <div class="tailor-plan-cta">
          <button class="btn-primary" type="button" id="run-tailor-plan" ${view.planBusy ? "disabled" : ""}>
            ${view.planBusy ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Generating plan…' : '<i class="fa-solid fa-wand-magic-sparkles"></i> ' + (view.tailorPlan ? 'Regenerate plan' : 'Generate tailoring plan')}
          </button>
        </div>
        ${view.planError ? '<p class="ai-error">' + st(view.planError) + '</p>' : ''}
      </article>
    `;
  }

  function renderPlanEmptyCta() {
    if (!view.jdAnalyzed) {
      return `
        <article class="card tailor-plan-empty">
          <p class="muted">No JD yet? Generate a general optimization plan now, or analyze a JD for role-specific rewrites.</p>
          <div class="tailor-plan-cta">
            <button class="btn-primary btn-sm" type="button" id="run-tailor-plan" ${view.planBusy ? "disabled" : ""}>
              ${view.planBusy ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Generating…' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate general plan'}
            </button>
          </div>
        </article>
      `;
    }
    return "";
  }

  function renderTailorPlanCard(plan, r) {
    const data = plan.data || plan;
    if (data && typeof data === "object") ensureTailorPlanSummaryVariants(data);
    const bullets = Array.isArray(data.bullets) ? data.bullets : [];
    const addSkills = Array.isArray(data.addSkills) ? data.addSkills : [];
    const fit = data.overallFitNotes || "";

    const summaryOpts = data.summary ? getTailorSummaryOptions(data) : [];
    const summaryLabels = ["Primary · JD-aligned", "Tighter read", "Alternate lead"];
    const summaryBlock = summaryOpts.length
      ? (function () {
          const applied = view.summaryApplied;
          return `
            <section class="plan-section">
              <div class="plan-section-head">
                <h4><i class="fa-solid fa-star"></i> Tailored summary</h4>
                <span class="chip subtle">${summaryOpts.length} options</span>
              </div>
              <p class="muted tailor-summary-hint">Each paragraph is paste-ready and grounded in your resume — pick the voice that fits you best.</p>
              <div class="critique-bullet-before">
                <span class="critique-bullet-label">Current</span>
                <p>${st(r.summary || "(no current summary)")}</p>
              </div>
              ${summaryOpts.map(function (text, idx) {
                return (
                  '<div class="critique-bullet-after">' +
                  '<span class="critique-bullet-label">Suggested · ' + st(summaryLabels[idx] || ("Option " + (idx + 1))) + "</span>" +
                  "<p>" + st(text) + "</p>" +
                  "</div>"
                );
              }).join("")}
              <div class="critique-issue-actions">
                ${applied
                  ? '<span class="chip green critique-applied-chip"><i class="fa-solid fa-check"></i> Applied</span>'
                  : summaryOpts.map(function (_, idx) {
                    const label = summaryOpts.length > 1 ? ("Apply " + (idx + 1)) : "Apply summary";
                    return '<button type="button" class="btn-primary btn-sm" data-apply-tailor-summary data-option-index="' + idx + '"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + label + "</button>";
                  }).join("")}
              </div>
            </section>
          `;
        })()
      : "";

    const visibleBullets = bullets.filter(function (b) {
      return !view.tailorDismissedIds[b.targetBulletId];
    });

    const bulletsBlock = visibleBullets.length ? `
      <section class="plan-section">
        <div class="plan-section-head">
          <h4><i class="fa-solid fa-list-check"></i> Bullet rewrites <span class="chip-sm">${visibleBullets.length}</span></h4>
        </div>
        <ul class="critique-issues tailor-bullets">
          ${visibleBullets.map(function (b) { return renderTailorBulletItem(b, r); }).join("")}
        </ul>
      </section>
    ` : "";

    const visibleSkills = addSkills.filter(function (s) {
      const key = (s.skill || "").toLowerCase();
      return key && !view.appliedSkills[key];
    });

    const skillsBlock = visibleSkills.length ? `
      <section class="plan-section">
        <div class="plan-section-head">
          <h4><i class="fa-solid fa-plus-minus"></i> Skills to consider adding <span class="chip-sm">${visibleSkills.length}</span></h4>
        </div>
        <ul class="tailor-skills-list">
          ${visibleSkills.map(function (s) {
            const key = (s.skill || "").toLowerCase();
            const evidence = s.evidence ? '<p class="tailor-skill-evidence"><i class="fa-solid fa-quote-left"></i> ' + st(s.evidence) + "</p>" : '<p class="tailor-skill-evidence warn"><i class="fa-solid fa-triangle-exclamation"></i> No resume evidence — only add if you genuinely have this skill.</p>';
            return `
              <li class="tailor-skill-item">
                <div>
                  <strong>${st(s.skill)}</strong>
                  <span class="chip subtle">${st(s.group || "Other")}</span>
                </div>
                ${evidence}
                <div class="critique-issue-actions">
                  <button type="button" class="btn-primary btn-sm" data-apply-skill data-key="${st(key)}" data-skill="${st(s.skill)}" data-group="${st(s.group || "Other")}"><i class="fa-solid fa-plus"></i> Add to resume</button>
                  <button type="button" class="btn-ghost btn-sm" data-dismiss-skill data-key="${st(key)}"><i class="fa-solid fa-xmark"></i></button>
                </div>
              </li>
            `;
          }).join("")}
        </ul>
      </section>
    ` : "";

    const provider = plan.provider ? '<span class="chip subtle">' + st(plan.provider) + "</span>" : "";

    return `
      <article class="card tailor-plan-card">
        <div class="resume-section-head">
          <h3><i class="fa-solid fa-wand-magic-sparkles"></i> Tailoring plan</h3>
          ${provider}
        </div>
        ${fit ? '<p class="tailor-fit-notes"><i class="fa-solid fa-gauge-high"></i> ' + st(fit) + '</p>' : ''}
        ${summaryBlock}
        ${bulletsBlock}
        ${skillsBlock}
        ${(!visibleBullets.length && !visibleSkills.length && view.summaryApplied) ? '<p class="muted">All suggestions applied or dismissed. Regenerate the plan to see more.</p>' : ''}
        <div class="critique-actions">
          <button class="btn-primary btn-sm" type="button" id="apply-tailor-safe"><i class="fa-solid fa-check-double"></i> Apply all safe</button>
          <button class="btn-ghost btn-sm" type="button" id="regen-tailor-plan"><i class="fa-solid fa-rotate"></i> Regenerate</button>
          <button class="btn-ghost btn-sm" type="button" id="clear-tailor-plan"><i class="fa-solid fa-xmark"></i> Clear plan</button>
        </div>
      </article>
    `;
  }

  function renderTailorBulletItem(b, r) {
    const bullet = findBulletById(r, b.targetBulletId);
    const current = bullet ? (bullet.text || "") : (b.original || "");
    const applied = !!view.tailorAppliedIds[b.targetBulletId];
    const kw = (b.keywords || []).map(function (k) { return '<span class="chip subtle">' + st(k) + "</span>"; }).join(" ");
    const rewrites = getRewriteOptions(b.rewrite, b.alternatives);
    // R2: rich variants carrying optionMeta. The text list is still
    // `rewrites` (used by the Apply buttons below); `richRewrites` is
    // used by the card renderer to show labels + improvement chips.
    const richRewrites = getRewriteOptionsRich(b.rewrite, b.alternatives, b.optionMeta);
    return `
      <li class="critique-issue sev-minor tailor-bullet">
        <div class="critique-issue-head">
          <span class="critique-sev sev-minor">REWRITE</span>
          ${kw ? '<div class="chip-cluster">' + kw + '</div>' : ''}
        </div>
        <div class="critique-bullet-before">
          <span class="critique-bullet-label">Current</span>
          <p>${st(current)}</p>
        </div>
        ${rewrites.map(function (text, idx) {
          const richMatch = richRewrites.find(function (r) { return r.text === text; });
          const meta = richMatch ? richMatch.meta : null;
          return renderRewriteOptionCard(text, meta, String.fromCharCode(65 + idx), st);
        }).join("")}
        ${b.rationale ? '<p class="critique-suggestion"><i class="fa-solid fa-lightbulb"></i> ' + st(b.rationale) + "</p>" : ""}
        <div class="critique-issue-actions">
          ${applied
            ? '<span class="chip green critique-applied-chip"><i class="fa-solid fa-check"></i> Applied</span>'
            : rewrites.map(function (_, idx) {
                const label = rewrites.length > 1 ? ("Apply " + (idx + 1)) : "Apply";
                return '<button type="button" class="btn-primary btn-sm" data-apply-bullet data-id="' + st(b.targetBulletId) + '" data-option-index="' + idx + '"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + label + '</button>';
              }).join("")}
          <button type="button" class="btn-ghost btn-sm" data-jump-bullet data-id="${st(b.targetBulletId)}"><i class="fa-solid fa-arrow-right"></i> Jump</button>
          <button type="button" class="btn-ghost btn-sm" data-dismiss-bullet data-id="${st(b.targetBulletId)}" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </li>
    `;
  }

  // Phase 5: synonym-aware coverage. The legacy version did
  //   `JSON.stringify(resume).toLowerCase()` + regex word-boundary tests,
  // which meant "TypeScript" never matched "TS", "Postgres" never matched
  // "PostgreSQL", and a token sitting in a URL or tooling label still counted
  // as a real skill match. The new version walks the resume structure to
  // build a clean corpus, then uses semanticHas() (handles synonyms +
  // singular/plural + multi-word terms).
  function buildResumeCorpus(r) {
    if (!r || typeof r !== "object") return "";
    const out = [];
    if (r.summary) out.push(r.summary);
    (r.skills || []).forEach(function (s) {
      if (typeof s === "string") out.push(s);
      else if (s && typeof s === "object" && s.name) out.push(s.name);
    });
    (r.experience || []).forEach(function (e) {
      if (!e) return;
      if (e.role) out.push(e.role);
      if (e.company) out.push(e.company);
      (e.bullets || []).forEach(function (b) {
        if (typeof b === "string") out.push(b);
        else if (b && b.text) out.push(b.text);
      });
    });
    (r.projects || []).forEach(function (p) {
      if (!p) return;
      if (p.name) out.push(p.name);
      if (p.description) out.push(p.description);
      (p.bullets || []).forEach(function (b) {
        if (typeof b === "string") out.push(b);
        else if (b && b.text) out.push(b.text);
      });
    });
    (r.certifications || []).forEach(function (c) {
      if (c && c.name) out.push(c.name);
    });
    (r.languages || []).forEach(function (l) {
      if (l && l.name) out.push(l.name);
    });
    return out.join("\n");
  }

  function computeCoverage(jd, r) {
    const terms = [];
    const seen = new Set();
    (jd.keywords || []).concat(jd.requiredSkills || []).forEach(function (t) {
      const s = String(t || "").trim();
      const k = s.toLowerCase();
      if (s && !seen.has(k)) { seen.add(k); terms.push(s); }
    });
    const resumeCorpus = buildResumeCorpus(r);
    const sm = window.CBV2 && window.CBV2.semanticMatch;
    const matched = [];
    const missing = [];
    if (sm && typeof sm.semanticHas === "function") {
      // Tokenize once, then membership-check each term against the synonym-
      // expanded set. Multi-word terms ("machine learning") fall through to
      // word-boundary substring inside semanticHas.
      const tokens = sm.tokenize(resumeCorpus);
      terms.forEach(function (t) {
        if (sm.semanticHas(tokens.length ? tokens : resumeCorpus, t)) matched.push(t);
        else missing.push(t);
      });
    } else {
      // Legacy fallback for environments without the helper (test runner).
      const lower = resumeCorpus.toLowerCase();
      terms.forEach(function (t) {
        const re = new RegExp("\\b" + t.toLowerCase().replace(/[.+#\-\/]/g, "\\$&") + "\\b", "i");
        if (re.test(lower)) matched.push(t);
        else missing.push(t);
      });
    }
    return { matched: matched, missing: missing, total: terms.length };
  }

  function renderTailorResult() {
    const store = window.CBV2.store;
    const saved = store.getAll().resume.tailored;
    const active = view.tailorResult || saved;
    if (!active) {
      return '<p class="muted resume-tailor-empty">Fill the target role and run tailor — we align your bullets, keywords, and summary.</p>';
    }
    const d = active.data || active;
    const bullets = (d.bullets || []).map(function (b) { return "<li>" + st(b) + "</li>"; }).join("");
    const keywords = (d.keywords || []).map(function (k) { return '<span class="chip subtle">' + st(k) + "</span>"; }).join(" ");
    const provider = active.provider ? '<span class="chip cyan">' + st(active.provider) + "</span>" : "";
    return `
      <div class="resume-tailor-result">
        <div class="resume-tailor-meta">${provider}</div>
        <h4>Tailored summary</h4>
        <p>${st(d.summary || "")}</p>
        <h4>Keywords</h4>
        <div class="chip-cluster">${keywords}</div>
        <h4>Suggested bullets</h4>
        <ul class="task-list">${bullets}</ul>
        <div class="resume-tailor-actions">
          <button class="btn-ghost btn-sm" type="button" id="tailor-copy"><i class="fa-solid fa-copy"></i> Copy all</button>
          <button class="btn-ghost btn-sm" type="button" id="tailor-merge"><i class="fa-solid fa-code-merge"></i> Apply summary</button>
        </div>
      </div>
    `;
  }

  function renderEditor() {
    const r = currentResume();
    if (!r) return renderEmpty();
    const updated = r.updatedAt ? "Last updated " + formatDate(r.updatedAt) : "";
    const source = r.source && r.source !== "blank"
      ? '<span class="chip subtle">Source: ' + st(r.source.replace(/^upload-/, "").toUpperCase()) + "</span>"
      : "";

    const isEdit = view.workMode !== "tailor";
    const tailorBadge = view.tailorPlan
      ? '<span class="mode-dot mode-dot-active" title="Tailoring plan ready"></span>'
      : "";

    const rightPanel = isEdit
      ? '<div class="resume-side" id="resume-side">' + renderSidebar(r) + '</div>'
      : '<div class="resume-side resume-side-tailor" id="resume-side">' + renderTailorWorkspace(r) + '</div>';

    return `
      <section class="resume-toolbar">
        <div class="resume-toolbar-title">
          <p class="eyebrow">Resume Lab</p>
          <h1 class="page-title">${st(r.name || "My resume")}</h1>
          <p class="page-subtitle resume-meta-line">
            ${source}
            <span class="resume-meta-updated">${st(updated)}</span>
          </p>
        </div>
        <div class="resume-mode-toggle" role="tablist" aria-label="Resume workflow">
          <button type="button" role="tab" class="mode-btn ${isEdit ? "is-active" : ""}" data-mode="edit" aria-selected="${isEdit ? "true" : "false"}">
            <i class="fa-solid fa-pen-to-square"></i> Build &amp; Improve
          </button>
          <button type="button" role="tab" class="mode-btn ${!isEdit ? "is-active" : ""}" data-mode="tailor" aria-selected="${!isEdit ? "true" : "false"}">
            <i class="fa-solid fa-bullseye"></i> Match to Role ${tailorBadge}
          </button>
        </div>
        <div class="resume-toolbar-actions">
          <button class="btn-secondary" type="button" id="resume-save-library"><i class="fa-solid fa-book-bookmark"></i> Save CV</button>
          <button class="btn-primary" type="button" id="resume-export"><i class="fa-solid fa-download"></i> Final export</button>
          <button class="btn-ghost" type="button" id="resume-reupload"><i class="fa-solid fa-arrow-rotate-left"></i> Upload new</button>
          <button class="btn-ghost" type="button" id="resume-reset"><i class="fa-solid fa-trash"></i> Clear</button>
        </div>
      </section>

      ${renderResumeLabCommand(r, isEdit)}

      <div class="resume-layout ${isEdit ? "is-edit-mode" : "is-tailor-mode"}">
        <div class="resume-main" id="resume-main">
          ${renderHeaderSection(r)}
          ${renderSummarySection(r)}
          ${renderExperienceSection(r)}
          ${renderEducationSection(r)}
          ${renderSkillsSection(r)}
          ${renderProjectsSection(r)}
          ${renderCertificationsSection(r)}
          ${renderLanguagesSection(r)}
          ${renderInterestsSection(r)}
          ${renderReferencesSection(r)}
        </div>
        ${rightPanel}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Root view
  // ---------------------------------------------------------------------------
  function renderView() {
    applyActiveRoleContextToTailor(false);
    const mode = resolveMode();
    const exportDialog = (mode === "editor" && view.exportOpen) ? renderExportDialog() : "";
    if (mode === "parsing") {
      return '<section class="page-container resume-page">' + renderParsing() + "</section>";
    }
    if (mode === "editor") {
      return '<section class="page-container resume-page">' + renderEditor() + "</section>" + exportDialog;
    }
    return '<section class="page-container resume-page">' + renderEmpty() + "</section>";
  }

  function rerender() {
    const host = document.getElementById("route-view");
    if (!host) return;
    host.innerHTML = renderView();
    bindAll();
  }

  function rerenderEditor() {
    const host = document.getElementById("route-view");
    if (!host) return;
    host.innerHTML = renderView();
    bindAll();
  }

  function rerenderSidebar() {
    const side = document.getElementById("resume-side");
    if (!side) return;
    const r = currentResume();
    if (!r) return;
    side.innerHTML = renderSidebar(r);
    bindSidebar();
  }

  // ---------------------------------------------------------------------------
  // Data mutation helpers
  // ---------------------------------------------------------------------------
  function updateField(path, value) {
    const r = currentResume();
    if (!r) return;
    const parts = path.split(".");
    let node = r;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      const asIdx = Number(key);
      const nextKey = parts[i + 1];
      const childIsArr = !isNaN(Number(nextKey));
      if (!isNaN(asIdx)) {
        if (!Array.isArray(node)) return;
        if (!node[asIdx]) node[asIdx] = childIsArr ? [] : {};
        node = node[asIdx];
      } else {
        if (node[key] === undefined || node[key] === null) {
          node[key] = childIsArr ? [] : {};
        }
        node = node[key];
      }
    }
    const last = parts[parts.length - 1];
    const lastIdx = Number(last);
    if (!isNaN(lastIdx)) node[lastIdx] = value;
    else node[last] = value;
    window.CBV2.store.setResumeStructured(r);
  }

  function saveResume(r) {
    window.CBV2.store.setResumeStructured(r);
  }

  // ---------------------------------------------------------------------------
  // Event binding
  // ---------------------------------------------------------------------------
  function bindRoleContextControls() {
    document.querySelectorAll("#fill-active-role").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!applyActiveRoleContextToTailor(true)) return;
        rerenderEditor();
        toast("success", "Loaded the active role into Resume Lab.");
      });
    });
    document.querySelectorAll("#clear-active-role").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const svc = window.CBV2.roleContext;
        if (svc && typeof svc.clear === "function") svc.clear();
        view.activeRoleContextKey = "";
        rerender();
      });
    });
  }

  function bindEmptyState() {
    const drop = document.getElementById("resume-drop");
    const fileInput = document.getElementById("resume-file");
    const browseBtn = document.getElementById("resume-browse");
    const pasteBtn = document.getElementById("resume-paste");
    const pasteInlineBtn = document.getElementById("resume-paste-inline");
    const quickBtn = document.getElementById("resume-quick-draft");
    const quickInlineBtn = document.getElementById("resume-quick-draft-inline");
    const blankBtn = document.getElementById("resume-blank");
    const blankInlineBtn = document.getElementById("resume-blank-inline");

    if (browseBtn && fileInput) {
      browseBtn.addEventListener("click", function () { fileInput.click(); });
    }
    if (drop && fileInput) {
      drop.addEventListener("click", function (e) {
        if (e.target.closest("button") || e.target.closest("dialog")) return;
        fileInput.click();
      });
      ["dragenter", "dragover"].forEach(function (evt) {
        drop.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
          drop.classList.add("is-dragover");
        });
      });
      ["dragleave", "drop"].forEach(function (evt) {
        drop.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
          drop.classList.remove("is-dragover");
        });
      });
      drop.addEventListener("drop", function (e) {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) {
          handleFile(files[0]);
        }
      });
    }
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
      });
    }
    [pasteBtn, pasteInlineBtn].forEach(function (btn) {
      if (btn) btn.addEventListener("click", openPasteDialog);
    });
    [quickBtn, quickInlineBtn].forEach(function (btn) {
      if (btn) btn.addEventListener("click", openQuickDialog);
    });
    [blankBtn, blankInlineBtn].forEach(function (btn) {
      if (!btn) return;
      btn.addEventListener("click", function () {
        const fresh = model.emptyResume();
        fresh.source = "blank";
        saveResume(fresh);
        view.mode = "editor";
        rerender();
      });
    });

    const dialog = document.getElementById("resume-paste-dialog");
    if (dialog) {
      dialog.querySelectorAll("[data-close-dialog]").forEach(function (btn) {
        btn.addEventListener("click", function () { dialog.close(); });
      });
      const confirm = document.getElementById("resume-paste-confirm");
      if (confirm) {
        confirm.addEventListener("click", function () {
          const ta = document.getElementById("resume-paste-text");
          const text = (ta && ta.value || "").trim();
          if (!text) {
            toast("error", "Paste some text first.");
            return;
          }
          dialog.close();
          runParse({ text: text, source: "paste", fileName: "Pasted text" });
        });
      }
    }

    const quickDialog = document.getElementById("resume-quick-dialog");
    if (quickDialog) {
      quickDialog.querySelectorAll("[data-close-quick-dialog]").forEach(function (btn) {
        btn.addEventListener("click", function () { quickDialog.close(); });
      });
      const quickConfirm = document.getElementById("resume-quick-confirm");
      if (quickConfirm) {
        quickConfirm.addEventListener("click", function () {
          const name = String((document.getElementById("quick-name") || {}).value || "").trim();
          const role = String((document.getElementById("quick-role") || {}).value || "").trim();
          const years = String((document.getElementById("quick-years") || {}).value || "").trim();
          const winsText = String((document.getElementById("quick-wins") || {}).value || "").trim();
          const runCritiqueAfter = !!((document.getElementById("quick-run-critique") || {}).checked);
          const wins = winsText
            .split(/\r?\n/)
            .map(function (x) { return x.trim(); })
            .filter(Boolean)
            .slice(0, 6);

          const fresh = model.emptyResume();
          fresh.source = "quick-draft";
          fresh.name = "Quick draft";
          fresh.header.name = name;
          fresh.header.title = role;
          fresh.summary = role
            ? ("Results-focused " + role + (years ? (" with " + years + " years of experience") : "") + ". Delivers measurable outcomes through ownership, collaboration, and execution.")
            : ("Results-focused professional" + (years ? (" with " + years + " years of experience") : "") + ". Delivers measurable outcomes through ownership, collaboration, and execution.");

          if (role || wins.length) {
            fresh.experience.push({
              id: model.newId("exp"),
              company: "",
              role: role || "Recent role",
              location: "",
              startDate: "",
              endDate: "",
              current: false,
              bullets: wins.map(function (w) { return { id: model.newId("blt"), text: w }; })
            });
          }

          saveResume(fresh);
          quickDialog.close();
          view.mode = "editor";
          rerender();
          toast("success", "Quick draft ready.");
          if (runCritiqueAfter) {
            view.critiqueTargetRole = role || inferTargetRoleFromResume(fresh) || "";
            setTimeout(function () { runCritiqueNow(); }, 120);
          }
        });
      }
    }
  }

  function openPasteDialog() {
    const dialog = document.getElementById("resume-paste-dialog");
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else if (dialog) dialog.setAttribute("open", "");
  }

  function openQuickDialog() {
    const dialog = document.getElementById("resume-quick-dialog");
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else if (dialog) dialog.setAttribute("open", "");
  }

  function handleLabAction(action, btn) {
    const section = btn && btn.getAttribute("data-section");
    if (action === "jump") {
      if (section) jumpToSection(section);
      return;
    }
    if (action === "add-metrics") {
      applyAtsQuickFix("add-metrics");
      return;
    }
    if (action === "trim-bullets") {
      applyAtsQuickFix("trim-long-bullets");
      return;
    }
    if (action === "run-critique") {
      const r = currentResume();
      if (!view.critiqueTargetRole) view.critiqueTargetRole = inferTargetRoleFromResume(r) || "";
      runCritiqueNow();
      return;
    }
    if (action === "open-tailor") {
      switchWorkMode("tailor");
      return;
    }
    if (action === "export") {
      openExportDialog();
      return;
    }
    if (action === "save-version") {
      const saveBtn = document.getElementById("resume-save-library");
      if (saveBtn) saveBtn.click();
      return;
    }
    if (section) jumpToSection(section);
  }

  function bindEditor() {
    const main = document.getElementById("resume-main");
    if (!main) return;

    const page = document.querySelector(".resume-page");
    if (page) {
      page.addEventListener("click", function (e) {
        const btn = e.target.closest("[data-lab-action]");
        if (!btn) return;
        e.preventDefault();
        handleLabAction(btn.getAttribute("data-lab-action"), btn);
      });
    }

    // Persist on blur for text fields (avoids caret jumps)
    main.addEventListener("blur", function (e) {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches("[data-field]")) {
        const path = t.getAttribute("data-field");
        const value = t.type === "checkbox" ? t.checked : t.value;
        updateField(path, value);
        rerenderSidebar();
      }
    }, true);

    // Checkbox toggles need immediate re-render (to disable endDate)
    main.addEventListener("change", function (e) {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-field$=".current"]')) {
        const path = t.getAttribute("data-field");
        updateField(path, t.checked);
        rerenderEditor();
      }
    });

    // Header links
    main.addEventListener("click", function (e) {
      const btn = e.target.closest("button");
      if (!btn) return;

      if (btn.matches("[data-link-add]")) {
        const r = currentResume();
        r.header.links = r.header.links || [];
        r.header.links.push({ label: "", url: "" });
        saveResume(r);
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-link-remove]")) {
        const idx = Number(btn.getAttribute("data-idx"));
        const r = currentResume();
        r.header.links.splice(idx, 1);
        saveResume(r);
        rerenderEditor();
        return;
      }

      // Photo remove
      if (btn.id === "resume-photo-remove") {
        const r = currentResume();
        if (r) {
          r.header.photo = "";
          saveResume(r);
          rerenderEditor();
        }
        return;
      }

      // Interests
      if (btn.id === "interest-add-btn") {
        addInterestFromInput();
        return;
      }
      if (btn.matches("[data-interest-remove]")) {
        const id = btn.getAttribute("data-interest-id");
        const r = currentResume();
        if (r && r.interests) {
          r.interests = r.interests.filter(function (i) { return i.id !== id; });
          saveResume(r);
          rerenderEditor();
        }
        return;
      }

      // Entry add / remove / move
      if (btn.matches("[data-entry-add]")) {
        const type = btn.getAttribute("data-entry-type");
        addEntry(type);
        return;
      }
      if (btn.matches("[data-entry-remove]")) {
        removeEntry(btn.getAttribute("data-entry-type"), btn.getAttribute("data-entry-id"));
        return;
      }
      if (btn.matches("[data-entry-up]")) {
        moveEntry(btn.getAttribute("data-entry-type"), btn.getAttribute("data-entry-id"), -1);
        return;
      }
      if (btn.matches("[data-entry-down]")) {
        moveEntry(btn.getAttribute("data-entry-type"), btn.getAttribute("data-entry-id"), 1);
        return;
      }

      // Bullets
      if (btn.matches("[data-bullet-add]")) {
        const expId = btn.getAttribute("data-exp-id");
        const scope = btn.getAttribute("data-scope") || "experience";
        addBullet(scope, expId);
        return;
      }
      if (btn.matches("[data-bullet-remove]")) {
        const expId = btn.getAttribute("data-exp-id");
        const bId = btn.getAttribute("data-bullet-id");
        const scope = btn.getAttribute("data-scope") || "experience";
        removeBullet(scope, expId, bId);
        return;
      }
      if (btn.matches("[data-bullet-strengthen]")) {
        const expId = btn.getAttribute("data-exp-id");
        const bId = btn.getAttribute("data-bullet-id");
        const scope = btn.getAttribute("data-scope") || "experience";
        strengthenBullet(scope, expId, bId);
        return;
      }
      if (btn.matches("[data-bullet-save-asset]")) {
        const expId = btn.getAttribute("data-exp-id");
        const bId = btn.getAttribute("data-bullet-id");
        const scope = btn.getAttribute("data-scope") || "experience";
        saveBulletAsCareerAsset(scope, expId, bId);
        return;
      }

      // R3: inline AI suggestion popover handlers. The popover is rendered
      // inside the bullet <li> so clicks bubble through #resume-main, not
      // the sidebar — we wire the same apply/dismiss verbs here so the
      // inline path uses the same accept logic the sidebar already uses.
      if (btn.matches("[data-bullet-ai-toggle]")) {
        const bId = btn.getAttribute("data-bullet-id");
        view.bulletPopoverOpenId = view.bulletPopoverOpenId === bId ? null : bId;
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-bullet-ai-close]")) {
        view.bulletPopoverOpenId = null;
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-apply-bullet]")) {
        applyTailorBullet(
          btn.getAttribute("data-id"),
          Number(btn.getAttribute("data-option-index") || "0")
        );
        return;
      }
      if (btn.matches("[data-critique-apply]")) {
        applyCritiqueFix(
          btn.getAttribute("data-issue-key"),
          Number(btn.getAttribute("data-option-index") || "0")
        );
        return;
      }
      if (btn.matches("[data-dismiss-bullet]")) {
        view.tailorDismissedIds[btn.getAttribute("data-id")] = true;
        persistTailorView();
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-critique-dismiss]")) {
        view.critiqueDismissedIds[btn.getAttribute("data-issue-key")] = true;
        rerenderEditor();
        return;
      }

      // R4: track-changes preview lifecycle.
      //   Preview → stage the proposed text in view.preview, rerender.
      //   Accept  → delegate to the existing apply path (applyTailorBullet
      //             or applyCritiqueFix), clear preview. Note: the apply
      //             functions already call rerenderEditor themselves.
      //   Cancel  → clear preview, rerender. Popover stays open so the
      //             user can try a different option.
      if (btn.matches("[data-preview-bullet]")) {
        const bulletId = btn.getAttribute("data-bullet-id");
        const source = btn.getAttribute("data-source") || "tailor";
        const optionIndex = Number(btn.getAttribute("data-option-index") || "0");
        const optionLabel = btn.getAttribute("data-option-label") || "";
        // Local var name avoids shadowing the module-scope issueKey()
        // function used by computePreviewText.
        const critiqueKey = btn.getAttribute("data-issue-key") || null;
        const text = computePreviewText(bulletId, source, optionIndex, critiqueKey);
        if (!text) return;
        view.preview = {
          bulletId: bulletId,
          text: text,
          source: source,
          optionIndex: optionIndex,
          issueKey: critiqueKey,
          optionLabel: optionLabel
        };
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-preview-accept]")) {
        const p = view.preview;
        if (!p) return;
        const inWalk = !!(view.walkthrough && view.walkthrough.active);
        // Clear preview FIRST so the upcoming rerender shows the new
        // textarea text (committed by the apply call) rather than the
        // diff view. The apply functions call rerenderEditor for us.
        view.preview = null;
        view.bulletPopoverOpenId = null;
        if (p.source === "tailor") {
          applyTailorBullet(p.bulletId, p.optionIndex);
        } else if (p.source === "critique" && p.issueKey) {
          applyCritiqueFix(p.issueKey, p.optionIndex);
        } else if (p.source === "strengthen") {
          applyStrengthenBullet(p.bulletId, p.optionIndex);
        }
        // R5: auto-advance the walkthrough on Accept.
        if (inWalk) advanceWalkthrough();
        return;
      }
      // Discard the AI-strengthen results for this bullet (chip + popover
      // disappear; bullet text stays as-is).
      if (btn.matches("[data-dismiss-strengthen]")) {
        const id = btn.getAttribute("data-id");
        dismissStrengthenBullet(id);
        return;
      }
      if (btn.matches("[data-preview-cancel]")) {
        const inWalk = !!(view.walkthrough && view.walkthrough.active);
        view.preview = null;
        if (inWalk) {
          // R5: in walkthrough mode, Cancel = skip this option, move on.
          advanceWalkthrough();
        } else {
          rerenderEditor();
        }
        return;
      }

      // Skills
      if (btn.matches("[data-skill-group-add]")) {
        const r = currentResume();
        r.skills = r.skills || { groups: [] };
        r.skills.groups.push({ id: model.newId("skg"), label: "New group", items: [] });
        saveResume(r);
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-skill-group-remove]")) {
        const idx = Number(btn.getAttribute("data-group-idx"));
        const r = currentResume();
        r.skills.groups.splice(idx, 1);
        saveResume(r);
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-skill-remove]")) {
        const gi = Number(btn.getAttribute("data-group-idx"));
        const ii = Number(btn.getAttribute("data-item-idx"));
        const r = currentResume();
        r.skills.groups[gi].items.splice(ii, 1);
        saveResume(r);
        rerenderEditor();
        return;
      }
      if (btn.matches("[data-skill-save-asset]")) {
        const gi = Number(btn.getAttribute("data-group-idx"));
        const ii = Number(btn.getAttribute("data-item-idx"));
        saveSkillAsCareerAsset(gi, ii);
        return;
      }
    });

    // Bullet text edits
    main.addEventListener("blur", function (e) {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches("[data-bullet-text]")) {
        const scope = t.getAttribute("data-scope") || "experience";
        const expId = t.getAttribute("data-exp-id");
        const bId = t.getAttribute("data-bullet-id");
        const r = currentResume();
        const entry = (r[scope] || []).find(function (x) { return x.id === expId; });
        if (!entry) return;
        const bullet = (entry.bullets || []).find(function (b) { return b.id === bId; });
        if (bullet) {
          bullet.text = t.value;
          saveResume(r);
          rerenderSidebar();
        }
      }
      if (t.matches("[data-skill-group-label]")) {
        const gi = Number(t.getAttribute("data-group-idx"));
        const r = currentResume();
        if (r.skills && r.skills.groups[gi]) {
          r.skills.groups[gi].label = t.value;
          saveResume(r);
        }
      }
    }, true);

    // Skill add via Enter key
    main.addEventListener("keydown", function (e) {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches("[data-skill-input]") && e.key === "Enter") {
        e.preventDefault();
        const gi = Number(t.getAttribute("data-group-idx"));
        const r = currentResume();
        const v = (t.value || "").trim();
        if (v && r.skills && r.skills.groups[gi]) {
          r.skills.groups[gi].items.push(v);
          saveResume(r);
          rerenderEditor();
          // Refocus the same input after re-render
          setTimeout(function () {
            const again = document.querySelector('[data-skill-input][data-group-idx="' + gi + '"]');
            if (again) again.focus();
          }, 0);
        }
      }
    });

    // Toolbar buttons
    const reupload = document.getElementById("resume-reupload");
    if (reupload) {
      reupload.addEventListener("click", async function () {
        // Phase 4.5: in-app modal replaces native confirm.
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Upload a new CV?",
              body: "Your current structured resume will be replaced. Tailored variants stay in your career assets.",
              confirmLabel: "Replace",
              tone: "danger",
            })
          : confirm("Upload a new CV? Your current structured resume will be replaced.");
        if (!ok) return;
        window.CBV2.store.clearResume && window.CBV2.store.clearResume();
        view.mode = "empty";
        view.tailorResult = null;
        rerender();
      });
    }
    const reset = document.getElementById("resume-reset");
    if (reset) {
      reset.addEventListener("click", async function () {
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Clear your resume?",
              body: "This wipes the base resume from your account. Tailored variants stay in your career assets. This cannot be undone.",
              confirmLabel: "Clear",
              tone: "danger",
            })
          : confirm("Clear your resume? This cannot be undone.");
        if (!ok) return;
        window.CBV2.store.clearResume && window.CBV2.store.clearResume();
        view.mode = "empty";
        view.tailorResult = null;
        rerender();
      });
    }

    // Mode toggle (Quick Edit ↔ Tailor)
    document.querySelectorAll(".resume-mode-toggle .mode-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const target = btn.getAttribute("data-mode");
        switchWorkMode(target);
      });
    });

    // Export button
    const saveCvBtn = document.getElementById("resume-save-library");
    if (saveCvBtn) {
      saveCvBtn.addEventListener("click", function () {
        const r = currentResume();
        if (!r) return;
        const defaultName = (r.header && r.header.title)
          ? (r.header.title + " CV")
          : ((r.name || "My CV"));
        const name = window.prompt("Name this reusable CV", defaultName);
        if (!name || !name.trim()) return;
        const baseText = model.toPlainText(r);
        window.CBV2.store.setResumeBase(baseText);
        const saved = window.CBV2.store.saveCurrentResumeAsSavedCV({
          name: name.trim(),
          baseText: baseText,
          structured: r,
          source: "resume-lab"
        });
        if (saved && typeof window.CBV2.store.setDefaultSavedCV === "function") {
          window.CBV2.store.setDefaultSavedCV(saved.id);
        }
        toast("success", "CV saved to your library and set as default.");
      });
    }

    // Export button
    const exportBtn = document.getElementById("resume-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        openExportDialog();
      });
    }

    // Export dialog (if currently open)
    if (view.exportOpen) {
      bindExportDialog();
    }

    // Photo upload
    const photoInput = document.getElementById("resume-photo-input");
    if (photoInput) {
      photoInput.addEventListener("change", function () {
        const file = photoInput.files && photoInput.files[0];
        if (!file) return;
        handlePhotoUpload(file);
      });
    }

    // Interest Enter-to-add
    const intInput = document.getElementById("interest-input");
    if (intInput) {
      intInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          addInterestFromInput();
        }
      });
    }

    // Right-panel bindings depend on current workMode
    if (view.workMode === "tailor") {
      bindTailorWorkspace();
    } else {
      bindSidebar();
    }
  }

  function addInterestFromInput() {
    const input = document.getElementById("interest-input");
    if (!input) return;
    const val = (input.value || "").trim();
    if (!val) return;
    const r = currentResume();
    if (!r) return;
    r.interests = r.interests || [];
    r.interests.push({ id: model.newId("int"), label: val });
    input.value = "";
    saveResume(r);
    rerenderEditor();
    // Refocus the new input after rerender
    setTimeout(function () {
      const newInput = document.getElementById("interest-input");
      if (newInput) newInput.focus();
    }, 10);
  }

  function handlePhotoUpload(file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      toast("error", "Please choose a PNG, JPG, or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast("error", "Image is larger than 2 MB. Please resize and try again.");
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      const dataUrl = String(reader.result || "");
      if (!dataUrl) {
        toast("error", "Could not read that image.");
        return;
      }
      // Compress + resize to max 400×400 via canvas to keep the data URL small.
      compressImage(dataUrl, 400, 0.85).then(function (compressed) {
        const r = currentResume();
        if (!r) return;
        r.header.photo = compressed;
        saveResume(r);
        rerenderEditor();
        toast("success", "Photo added.");
      }).catch(function () {
        // If compression fails, fall back to raw data URL
        const r = currentResume();
        if (!r) return;
        r.header.photo = dataUrl;
        saveResume(r);
        rerenderEditor();
      });
    };
    reader.onerror = function () { toast("error", "Could not read that image."); };
    reader.readAsDataURL(file);
  }

  function compressImage(dataUrl, maxSize, quality) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const target = Math.min(maxSize, side);
        const canvas = document.createElement("canvas");
        canvas.width = target;
        canvas.height = target;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("canvas unavailable")); return; }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);
        try {
          resolve(canvas.toDataURL("image/jpeg", quality || 0.85));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error("image load failed")); };
      img.src = dataUrl;
    });
  }

  function bindSidebar() {
    const form = document.getElementById("resume-tailor-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        runTailor();
      });
    }
    const rawToggle = document.getElementById("resume-raw-toggle");
    if (rawToggle) {
      rawToggle.addEventListener("click", function () {
        view.rawTextPreviewOpen = !view.rawTextPreviewOpen;
        rerenderSidebar();
      });
    }
    const atsToggleDetails = document.getElementById("ats-toggle-details");
    if (atsToggleDetails) {
      atsToggleDetails.addEventListener("click", function () {
        view.atsDetailsOpen = !view.atsDetailsOpen;
        rerenderSidebar();
      });
    }
    const copyBtn = document.getElementById("tailor-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        const active = view.tailorResult || window.CBV2.store.getAll().resume.tailored;
        if (!active) return;
        const d = active.data || active;
        const text =
          "Summary:\n" + (d.summary || "") +
          "\n\nKeywords:\n" + ((d.keywords || []).join(", ")) +
          "\n\nBullets:\n- " + ((d.bullets || []).join("\n- "));
        navigator.clipboard.writeText(text).then(function () {
          toast("success", "Copied tailored content.");
        }).catch(function () {
          toast("error", "Copy failed.");
        });
      });
    }
    const mergeBtn = document.getElementById("tailor-merge");
    if (mergeBtn) {
      mergeBtn.addEventListener("click", function () {
        const active = view.tailorResult || window.CBV2.store.getAll().resume.tailored;
        if (!active) return;
        const d = active.data || active;
        const r = currentResume();
        if (!r || !d.summary) return;
        r.summary = d.summary;
        saveResume(r);
        toast("success", "Tailored summary applied to your resume.");
        rerenderEditor();
      });
    }

    // Critique card handlers
    const runCritique = document.getElementById("run-critique");
    const retryCritique = document.getElementById("critique-retry");
    const rerunCritique = document.getElementById("critique-rerun");
    const applySafeCritique = document.getElementById("critique-apply-safe");
    const clearCritique = document.getElementById("critique-clear");
    const targetRoleInput = document.getElementById("critique-target-role");

    if (targetRoleInput) {
      targetRoleInput.addEventListener("input", function () {
        view.critiqueTargetRole = targetRoleInput.value;
      });
    }
    if (runCritique) runCritique.addEventListener("click", function () { runCritiqueNow(); });
    if (retryCritique) retryCritique.addEventListener("click", function () { runCritiqueNow(); });
    if (rerunCritique) rerunCritique.addEventListener("click", function () { runCritiqueNow(); });
    if (applySafeCritique) applySafeCritique.addEventListener("click", function () { applyAllSafeCritiqueFixes(); });
    if (clearCritique) {
      clearCritique.addEventListener("click", function () {
        view.critiqueResult = null;
        view.critiqueError = "";
        view.critiqueAppliedIds = {};
        view.critiqueDismissedIds = {};
        view.critiqueExpandedIds = {};
        rerenderSidebar();
      });
    }

    // Per-issue actions
    const side = document.getElementById("resume-side");
    if (side && side.getAttribute("data-critique-bound") !== "1") {
      side.setAttribute("data-critique-bound", "1");
      side.addEventListener("click", function (e) {
        const btn = e.target.closest("button");
        if (!btn) return;
        if (btn.id === "resume-diagnostics-toggle") {
          view.diagnosticsOpen = !view.diagnosticsOpen;
          rerenderSidebar();
          return;
        }
        if (btn.matches("[data-mode-switch]")) {
          switchWorkMode(btn.getAttribute("data-mode-switch"));
          return;
        }
        if (btn.matches("[data-critique-apply]")) {
          applyCritiqueFix(
            btn.getAttribute("data-issue-key"),
            Number(btn.getAttribute("data-option-index") || "0")
          );
          return;
        }
        if (btn.matches("[data-critique-toggle-options]")) {
          const toggleId = btn.getAttribute("data-issue-toggle-id");
          if (toggleId === null || toggleId === undefined || toggleId === "") return;
          if (view.critiqueExpandedIds[toggleId]) delete view.critiqueExpandedIds[toggleId];
          else view.critiqueExpandedIds[toggleId] = true;
          rerenderSidebar();
          return;
        }
        if (btn.matches("[data-critique-jump]")) {
          jumpToSection(btn.getAttribute("data-section"));
          return;
        }
        if (btn.matches("[data-critique-dismiss]")) {
          view.critiqueDismissedIds[btn.getAttribute("data-issue-key")] = true;
          rerenderSidebar();
          return;
        }
        // R5: AI Review Queue actions (single-item review + walkthrough)
        if (btn.matches("[data-review-jump]")) {
          // Per-row "Review" button. Builds an item from the dataset and
          // delegates to the shared reviewQueueItem helper so the visual
          // behavior matches a walkthrough step (scroll + open + preview).
          const item = {
            bulletId: btn.getAttribute("data-bullet-id"),
            source: btn.getAttribute("data-source") || "tailor",
            issueKey: btn.getAttribute("data-issue-key") || null
          };
          // Pull firstOptionLabel from the live queue for nicer UX.
          const r = currentResume();
          const queue = r ? buildAiReviewQueue(r) : [];
          const match = queue.find(function (q) {
            return q.bulletId === item.bulletId &&
                   q.source === item.source &&
                   (q.issueKey || null) === item.issueKey;
          });
          if (match) item.firstOptionLabel = match.firstOptionLabel;
          reviewQueueItem(item);
          return;
        }
        if (btn.matches("[data-walk-start]")) {
          const r = currentResume();
          if (r) startWalkthrough(r);
          return;
        }
        if (btn.matches("[data-walk-skip]")) {
          // Skip = drop the preview without applying, then advance.
          view.preview = null;
          advanceWalkthrough();
          return;
        }
        if (btn.matches("[data-walk-end]")) {
          endWalkthrough();
          return;
        }
        if (btn.matches("[data-ats-fix]")) {
          applyAtsQuickFix(btn.getAttribute("data-ats-fix"));
          return;
        }
        if (btn.matches("[data-asset-action]")) {
          const action = btn.getAttribute("data-asset-action");
          const id = btn.getAttribute("data-asset-id");
          if (action === "apply") applyCareerAsset(id);
          else if (action === "delete") deleteCareerAsset(id);
          return;
        }
        if (btn.matches("[data-asset-suggest-action]")) {
          const action = btn.getAttribute("data-asset-suggest-action");
          const id = btn.getAttribute("data-asset-suggestion-id");
          if (action === "save") saveSuggestedAsset(id);
          return;
        }
      });
    }
  }

  function saveBulletAsCareerAsset(scope, expId, bId) {
    const r = currentResume();
    const entry = (r && r[scope] || []).find(function (x) { return x.id === expId; });
    if (!entry) return;
    const bullet = (entry.bullets || []).find(function (b) { return b.id === bId; });
    const text = String((bullet && bullet.text) || "").trim();
    if (!text) {
      toast("warning", "Cannot save an empty bullet.");
      return;
    }
    const store = window.CBV2.store;
    if (!store || typeof store.saveCareerAsset !== "function") return;
    const label = scope === "projects"
      ? (entry.name || "Project bullet")
      : (entry.role || "Experience bullet");
    store.saveCareerAsset({
      name: label,
      type: "bullet",
      text: text,
      tags: [scope],
      source: "resume-lab"
    });
    toast("success", "Saved to Career Asset Vault.");
    rerenderSidebar();
  }

  function saveSkillAsCareerAsset(groupIdx, itemIdx) {
    const r = currentResume();
    const group = r && r.skills && r.skills.groups && r.skills.groups[groupIdx];
    if (!group) return;
    const skill = String((group.items && group.items[itemIdx]) || "").trim();
    if (!skill) return;
    const store = window.CBV2.store;
    if (!store || typeof store.saveCareerAsset !== "function") return;
    store.saveCareerAsset({
      name: skill,
      type: "skill",
      text: skill,
      tags: [group.label || "skills"],
      source: "resume-lab"
    });
    toast("success", "Skill saved to Career Asset Vault.");
    rerenderSidebar();
  }

  function applyCareerAsset(id) {
    const store = window.CBV2.store;
    if (!store || typeof store.getCareerAssets !== "function") return;
    const asset = (store.getCareerAssets() || []).find(function (x) { return x.id === id; });
    if (!asset) return;
    const r = currentResume();
    if (!r) return;
    const type = String(asset.type || "bullet");
    if (type === "skill") {
      r.skills = r.skills || { groups: [] };
      r.skills.groups = r.skills.groups || [];
      let group = r.skills.groups.find(function (g) {
        return String((g && g.label) || "").toLowerCase() === "core skills";
      });
      if (!group) {
        group = { id: model.newId("skg"), label: "Core Skills", items: [] };
        r.skills.groups.unshift(group);
      }
      group.items = group.items || [];
      if (!group.items.some(function (x) { return String(x || "").toLowerCase() === String(asset.text || "").toLowerCase(); })) {
        group.items.push(asset.text);
      }
    } else {
      r.experience = r.experience || [];
      if (!r.experience.length) {
        r.experience.unshift({
          id: model.newId("exp"),
          company: "",
          role: "Key Experience",
          location: "",
          startDate: "",
          endDate: "",
          current: false,
          bullets: []
        });
      }
      r.experience[0].bullets = r.experience[0].bullets || [];
      r.experience[0].bullets.unshift({ id: model.newId("blt"), text: asset.text });
    }
    saveResume(r);
    toast("success", "Asset applied to your resume.");
    rerenderEditor();
  }

  async function deleteCareerAsset(id) {
    const store = window.CBV2.store;
    if (!store || typeof store.deleteCareerAsset !== "function") return;
    // Phase 4.5: in-app modal replaces native confirm.
    const modal = window.CBV2 && window.CBV2.modal;
    const ok = modal && modal.confirm
      ? await modal.confirm({
          title: "Delete this career asset?",
          body: "The tailored resume / cover letter / interview pack will be removed from your assets. The base resume is unaffected.",
          confirmLabel: "Delete",
          tone: "danger",
        })
      : window.confirm("Delete this career asset?");
    if (!ok) return;
    store.deleteCareerAsset(id);
    toast("success", "Career asset deleted.");
    rerenderSidebar();
  }

  function saveSuggestedAsset(id) {
    const store = window.CBV2.store;
    if (!store || typeof store.saveCareerAsset !== "function") return;
    const s = (view.assetSuggestions || []).find(function (x) { return x.id === id; });
    if (!s) return;
    const saved = store.saveCareerAsset({
      name: s.name || "AI suggestion",
      type: s.type || "bullet",
      text: s.text || "",
      tags: s.tags || ["ai"],
      source: "ai-suggestion"
    });
    if (!saved) {
      toast("warning", "Could not save that suggestion.");
      return;
    }
    toast("success", "Saved suggestion to Career Asset Vault.");
    view.assetSuggestions = (view.assetSuggestions || []).filter(function (x) { return x.id !== id; });
    if (view.workMode === "tailor") rerenderTailorSide();
    else rerenderSidebar();
  }

  function applyAtsQuickFix(kind) {
    const r = currentResume();
    if (!r) return;
    const ats = computeAtsSimulation(r, view.jdAnalyzed);
    if (kind === "trim-long-bullets") {
      const changed = shortenLongBullets(r);
      if (!changed) {
        toast("warning", "No long bullets found to shorten.");
        return;
      }
      saveResume(r);
      toast("success", "Shortened " + changed + " long bullet(s).");
      rerenderEditor();
      return;
    }
    if (kind === "add-metrics") {
      const metric = window.prompt("Metric to apply in placeholders (e.g. 18%, 2 days, 250 users):", "X%");
      const changed = addMetricPlaceholders(r, metric || "X%");
      if (!changed) {
        toast("warning", "No bullets needed metric placeholders.");
        return;
      }
      saveResume(r);
      toast("success", "Added metric placeholders to " + changed + " bullet(s).");
      rerenderEditor();
      return;
    }
    if (kind === "add-jd-keywords") {
      const changed = addMissingJdKeywords(r, ats.missingRequiredSkills || []);
      if (!changed) {
        toast("warning", "No missing JD keywords to add.");
        return;
      }
      saveResume(r);
      toast("success", "Added " + changed + " JD keyword(s) to Skills.");
      rerenderEditor();
    }
  }

  function shortenLongBullets(r) {
    let changed = 0;
    const maxLen = 210;
    (r.experience || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) {
        const t = String((b && b.text) || "").replace(/\s+/g, " ").trim();
        if (!t || t.length <= maxLen) return;
        let cut = t.slice(0, maxLen);
        const lastSpace = cut.lastIndexOf(" ");
        if (lastSpace > 140) cut = cut.slice(0, lastSpace);
        b.text = cut.replace(/[,:;\- ]+$/g, "") + ".";
        changed += 1;
      });
    });
    return changed;
  }

  function addMetricPlaceholders(r, metricText) {
    let changed = 0;
    const metric = String(metricText || "X%").trim() || "X%";
    (r.experience || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) {
        if (changed >= 3) return;
        const t = String((b && b.text) || "").trim();
        if (!t || /\d/.test(t) || /\(impact:/i.test(t)) return;
        b.text = t.replace(/[.!?]*$/, "") + " (impact: " + metric + ").";
        changed += 1;
      });
    });
    return changed;
  }

  function addMissingJdKeywords(r, missingKeywords) {
    const kws = (missingKeywords || [])
      .map(function (k) { return String(k || "").trim(); })
      .filter(Boolean)
      .slice(0, 8);
    if (!kws.length) return 0;
    r.skills = r.skills || { groups: [] };
    r.skills.groups = r.skills.groups || [];
    let group = r.skills.groups.find(function (g) {
      return String((g && g.label) || "").toLowerCase() === "jd keywords";
    });
    if (!group) {
      group = { id: model.newId("skg"), label: "JD Keywords", items: [] };
      r.skills.groups.unshift(group);
    }
    group.items = group.items || [];
    const existing = new Set(group.items.map(function (x) { return String(x || "").toLowerCase(); }));
    let added = 0;
    kws.forEach(function (k) {
      const norm = k.toLowerCase();
      if (existing.has(norm)) return;
      group.items.push(k);
      existing.add(norm);
      added += 1;
    });
    return added;
  }

  function bindAll() {
    const mode = resolveMode();
    if (mode === "empty") {
      bindEmptyState();
      bindRoleContextControls();
      return;
    }
    if (mode === "editor") {
      bindEditor();
      bindRoleContextControls();
      return;
    }
    // Parsing state has no interactive handlers
  }

  // ---------------------------------------------------------------------------
  // Entry operations
  // ---------------------------------------------------------------------------
  function addEntry(type) {
    const r = currentResume();
    if (!r) return;
    r[type] = r[type] || [];
    let entry;
    if (type === "experience") {
      entry = { id: model.newId("exp"), company: "", role: "", location: "", startDate: "", endDate: "", current: false, bullets: [] };
    } else if (type === "education") {
      entry = { id: model.newId("edu"), school: "", degree: "", field: "", startDate: "", endDate: "", notes: "" };
    } else if (type === "projects") {
      entry = { id: model.newId("prj"), name: "", description: "", bullets: [], url: "" };
    } else if (type === "certifications") {
      entry = { id: model.newId("cert"), name: "", issuer: "", date: "" };
    } else if (type === "languages") {
      entry = { id: model.newId("lng"), name: "", level: "" };
    } else if (type === "references") {
      entry = { id: model.newId("ref"), name: "", role: "", company: "", email: "", phone: "", note: "" };
    } else {
      return;
    }
    r[type].unshift(entry);
    saveResume(r);
    rerenderEditor();
  }

  function removeEntry(type, id) {
    const r = currentResume();
    if (!r || !r[type]) return;
    r[type] = r[type].filter(function (x) { return x.id !== id; });
    saveResume(r);
    rerenderEditor();
  }

  function moveEntry(type, id, delta) {
    const r = currentResume();
    if (!r || !r[type]) return;
    const idx = r[type].findIndex(function (x) { return x.id === id; });
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= r[type].length) return;
    const tmp = r[type][idx];
    r[type][idx] = r[type][next];
    r[type][next] = tmp;
    saveResume(r);
    rerenderEditor();
  }

  function addBullet(scope, expId) {
    const r = currentResume();
    const entry = (r[scope] || []).find(function (x) { return x.id === expId; });
    if (!entry) return;
    entry.bullets = entry.bullets || [];
    entry.bullets.push({ id: model.newId("blt"), text: "" });
    saveResume(r);
    rerenderEditor();
    setTimeout(function () {
      const last = document.querySelector(
        '[data-bullet-text][data-exp-id="' + expId + '"]:last-of-type'
      );
      if (last) last.focus();
    }, 0);
  }

  function removeBullet(scope, expId, bId) {
    const r = currentResume();
    const entry = (r[scope] || []).find(function (x) { return x.id === expId; });
    if (!entry) return;
    entry.bullets = (entry.bullets || []).filter(function (b) { return b.id !== bId; });
    saveResume(r);
    rerenderEditor();
  }

  // Strengthen-bullet (rewritten): replaces the old 4-window.prompt +
  // string-template stub with a real AI skill (bullet-strengthen) whose
  // 3 rewrites land in view.strengthenResults[bId]. Same inline popover
  // and track-changes preview as tailor/critique — the user clicks the
  // wand, the popover slides open with 3 labelled options, hits Preview
  // to see before/after, Accept to commit. Consistent with R1-R5.
  async function strengthenBullet(scope, expId, bId) {
    const r = currentResume();
    const entry = (r && r[scope] || []).find(function (x) { return x.id === expId; });
    if (!entry) return;
    const bullet = (entry.bullets || []).find(function (b) { return b.id === bId; });
    if (!bullet) return;
    const current = String(bullet.text || "").trim();
    if (!current) {
      toast("warning", "Write the bullet first, then strengthen it.");
      return;
    }
    const ai = window.CBAI;
    if (!ai || typeof ai.runSkill !== "function") {
      toast("error", "AI orchestrator unavailable.");
      return;
    }

    // Day 4.0 — client-side advisory gate. Mirrors the server-side
    // consume_quota check that ai-run does. If exhausted, the upgrade
    // modal is shown and we bail before firing the AI call. Server is
    // the source of truth — this is purely for "block before the spin"
    // UX so users don't see a brief spinner just to get rejected.
    const gate = window.CBV2 && window.CBV2.entitlementGate;
    if (gate) {
      const ok = await gate.checkQuota("ai_bullets");
      if (!ok) return;
    }

    // Mark this bullet as "generating" so the chip shows a spinner state.
    view.strengthenLoadingId = bId;
    rerenderEditor();
    try {
      // Pull voice context from the broader resume so the rewrite reads
      // in the candidate's tone, not a generic AI tone.
      const role = inferTargetRoleFromResume(r) || "";
      const resumeContext = String(r.summary || "").slice(0, 1500);
      const envelope = await ai.runSkill("bullet-strengthen", {
        bullet: current,
        role: role,
        resume: resumeContext
      });
      const data = (envelope && (envelope.data || envelope)) || {};
      const rewrites = Array.isArray(data.rewrites) ? data.rewrites.filter(function (x) { return typeof x === "string" && x.trim(); }) : [];
      if (!rewrites.length) {
        toast("error", "AI didn't return any rewrites — please try again.");
        return;
      }
      view.strengthenResults = view.strengthenResults || {};
      view.strengthenResults[bId] = {
        rewrites: rewrites.slice(0, 3),
        optionMeta: Array.isArray(data.optionMeta) ? data.optionMeta.slice(0, 3) : null,
        generatedAt: Date.now()
      };
      // Auto-open the chip popover so the user sees results immediately.
      view.bulletPopoverOpenId = bId;
      // Day 4.0 — optimistic local-cache decrement so the next click
      // sees the new remaining count without waiting for the next
      // entitlements.load(). Server already committed atomically.
      const ent = window.CBV2 && window.CBV2.entitlements;
      if (ent && ent.recordConsumption) ent.recordConsumption("ai_bullets");
      toast("success", "AI generated " + rewrites.length + " rewrite" + (rewrites.length === 1 ? "" : "s") + ".");
    } catch (err) {
      const msg = (err && err.message) ? err.message : "AI rewrite failed.";
      toast("error", msg);
    } finally {
      view.strengthenLoadingId = null;
      rerenderEditor();
    }
  }

  // ---------------------------------------------------------------------------
  // Strengthen results — same shape as a single tailor bullet so the
  // popover + queue can render uniformly. Cleared on Apply / Dismiss /
  // bullet deletion.
  // ---------------------------------------------------------------------------
  function getPendingStrengthenForBullet(bulletId) {
    if (!bulletId) return null;
    const map = view.strengthenResults || {};
    const r = map[bulletId];
    if (!r || !Array.isArray(r.rewrites) || !r.rewrites.length) return null;
    return r;
  }

  // Apply path — commits the chosen rewrite to bullet.text, clears the
  // strengthen entry + any preview/popover state, persists.
  function applyStrengthenBullet(bulletId, optionIndex) {
    const r = currentResume();
    if (!r) return;
    const bullet = findBulletById(r, bulletId);
    if (!bullet) return;
    const pending = getPendingStrengthenForBullet(bulletId);
    if (!pending) return;
    const idx = Math.max(0, Number(optionIndex) || 0);
    const text = pending.rewrites[idx] || pending.rewrites[0];
    if (!text) return;
    bullet.text = text;
    if (view.strengthenResults) delete view.strengthenResults[bulletId];
    saveResume(r);
    toast("success", "Bullet strengthened.");
    rerenderEditor();
  }

  function dismissStrengthenBullet(bulletId) {
    if (view.strengthenResults) delete view.strengthenResults[bulletId];
    if (view.preview && view.preview.bulletId === bulletId && view.preview.source === "strengthen") {
      view.preview = null;
    }
    rerenderEditor();
  }

  // ---------------------------------------------------------------------------
  // Upload → parse pipeline
  // ---------------------------------------------------------------------------
  function handleFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      view.parseError = "File is larger than 10 MB. Please upload a smaller file.";
      rerender();
      return;
    }
    view.parseError = "";
    view.mode = "parsing";
    view.progress = {
      fileName: file.name,
      current: "extract",
      done: [],
      detail: "Reading " + file.name + "..."
    };
    rerender();

    parser.extractText(file, function (progress) {
      if (progress && progress.page && progress.pages) {
        view.progress.detail = "Parsing page " + progress.page + " of " + progress.pages + "...";
        const el = document.querySelector(".resume-parsing-detail");
        if (el) el.textContent = view.progress.detail;
      }
    }).then(function (out) {
      view.progress.done = ["extract"];
      view.progress.current = "parse";
      view.progress.detail = "AI is analyzing the structure...";
      rerender();
      return runParse({ text: out.text, source: "upload-" + out.kind, fileName: file.name });
    }).catch(function (err) {
      view.parseError = (err && err.message) || "Could not read the file.";
      view.mode = "empty";
      view.progress = null;
      rerender();
      toast("error", view.parseError);
    });
  }

  async function runParse(opts) {
    const text = (opts && opts.text) || "";
    const source = (opts && opts.source) || "paste";
    const fileName = (opts && opts.fileName) || "";

    if (!text.trim()) {
      view.parseError = "No readable text found in that file.";
      view.mode = "empty";
      rerender();
      return;
    }

    view.mode = "parsing";
    view.progress = {
      fileName: fileName,
      current: "parse",
      done: ["extract"],
      detail: "AI is analyzing the structure..."
    };
    rerender();

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }
      const result = await ai.runSkill("resume-parse", { text: text });
      view.progress.done = ["extract", "parse"];
      view.progress.current = "structure";
      view.progress.detail = "Populating sections...";
      rerender();

      const parsed = (result && result.data) || result;
      const structured = model.normalizeParsed(parsed, {
        source: source,
        rawText: text,
        name: (fileName || "My resume").replace(/\.[^.]+$/, "")
      });
      window.CBV2.store.setResumeStructured(structured);
      // Also populate the legacy `base` text so other modules (cover letter,
      // interview prep) can still read from it without knowing about the
      // structured shape yet.
      window.CBV2.store.setResumeBase(model.toPlainText(structured));

      view.progress.done = ["extract", "parse", "structure"];
      view.mode = "editor";
      view.tailorResult = null;

      // Surface a gentler warning if the parser returned an empty-ish resume
      // (valid schema but no usable fields) — so users know why the editor
      // looks blank and can retry or paste text.
      const populated =
        (structured.header && (structured.header.name || structured.header.email)) ||
        (structured.experience && structured.experience.length) ||
        (structured.education && structured.education.length) ||
        (structured.skills && structured.skills.groups.some(function (g) { return g.items && g.items.length; }));

      setTimeout(function () {
        rerender();
        if (populated) {
          toast("success", "Resume imported. Review the sections below.");
        } else {
          toast("warning", "We couldn't extract much from that file. Try pasting the text or start from scratch.");
        }
      }, 250);
    } catch (err) {
      view.parseError = (err && err.message) || "AI parsing failed.";
      view.mode = "empty";
      view.progress = null;
      rerender();
      toast("error", view.parseError);
    }
  }

  // ---------------------------------------------------------------------------
  // Tailor
  // ---------------------------------------------------------------------------
  async function runTailor() {
    const form = document.getElementById("resume-tailor-form");
    if (!form) return;
    const fd = new FormData(form);
    const targetRole = String(fd.get("targetRole") || "").trim();
    const industry = String(fd.get("industry") || "").trim();
    const jd = String(fd.get("jd") || "").trim();

    const r = currentResume();
    const resolvedRole = targetRole || inferTargetRoleFromResume(r);
    if (!targetRole && resolvedRole) {
      toast("info", "Using inferred target role: " + resolvedRole);
    }
    const resumeText = r ? model.toPlainText(r) : "";

    // Phase Billing: entitlement gate. Returns false if quota
    // exhausted; the upgrade modal has already been shown.
    const gate = window.CBV2 && window.CBV2.entitlementGate;
    if (gate) {
      const ok = await gate.checkQuota("ai_resumes");
      if (!ok) return;
    }

    view.tailorBusy = true;
    view.tailorError = "";
    rerenderSidebar();

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") throw new Error("AI orchestrator not available.");
      const result = await ai.runSkill("resume-tailor", {
        targetRole: resolvedRole,
        industry: industry,
        resume: resumeText,
        jobDescription: jd
      });
      view.tailorResult = result;
      window.CBV2.store.setResumeTailored(result);
      // Phase Billing: optimistic decrement so the next click sees the
      // new remaining count without waiting for backend reconciliation.
      const ent = window.CBV2 && window.CBV2.entitlements;
      if (ent && ent.recordConsumption) ent.recordConsumption("ai_resumes");
      toast("success", "Tailor complete — review the suggestions on the right.");
    } catch (err) {
      view.tailorError = (err && err.message) || "AI tailor failed.";
    } finally {
      view.tailorBusy = false;
      rerenderSidebar();
    }
  }

  async function runCritiqueNow() {
    const r = currentResume();
    if (!r) {
      toast("warning", "No resume to critique yet — upload one first.");
      return;
    }

    view.critiqueBusy = true;
    view.critiqueError = "";
    rerenderSidebar();

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") throw new Error("AI orchestrator not available.");
      const compact = compactResumeForAi(r, true);
      const result = await ai.runSkill("resume-critique", {
        targetRole: view.critiqueTargetRole || "",
        resume: clipText(JSON.stringify(compact), AI_LIMITS.resumeJsonChars),
        // R1: send the bullet IDs whose rewrites the user already accepted
        // so the model doesn't re-flag them on a second run.
        appliedBulletIds: Object.keys(view.appliedAiBulletIds || {})
      });
      const isBackendResult = result && result.provider === "backend-primary";
      let critiqueOut = normalizeCritiqueIssues(result);
      critiqueOut = isBackendResult ? critiqueOut : ensureCritiqueAlternatives(critiqueOut);
      view.critiqueResult = critiqueOut;
      view.critiqueAppliedIds = {};
      view.critiqueDismissedIds = {};
      view.critiqueExpandedIds = {};
      toast("success", "Critique ready.");
    } catch (err) {
      view.critiqueError = (err && err.message) || "AI critique failed.";
      toast("error", view.critiqueError);
    } finally {
      view.critiqueBusy = false;
      rerenderSidebar();
    }
  }

  // R1: record that the user accepted an AI rewrite for this bullet. The
  // ID is sent on the next critique / tailor-plan call so the model skips
  // already-fixed bullets. Idempotent and safe to call with falsy values.
  function recordAppliedAiBulletId(bulletId) {
    if (!bulletId || typeof bulletId !== "string") return;
    view.appliedAiBulletIds = view.appliedAiBulletIds || {};
    view.appliedAiBulletIds[bulletId] = true;
  }

  function applyCritiqueFix(issueKeyStr, optionIndex) {
    if (!view.critiqueResult) return;
    const data = view.critiqueResult.data || view.critiqueResult;
    const issues = data.issues || [];
    const issue = issues.find(function (i) { return issueKey(i) === issueKeyStr; });
    if (!issue || !issue.target) return;
    const target = issue.target;
    const options = buildCritiqueRewriteOptions(issue);
    const selected = options[Math.max(0, Number(optionIndex) || 0)] || options[0] || "";
    if (!selected) return;

    const r = currentResume();
    if (!r) return;
    if (target.type === "bullet" && target.id) {
      const bullet = findBulletById(r, target.id);
      if (!bullet) {
        toast("warning", "Couldn't locate that bullet — it may have been removed.");
        return;
      }
      bullet.text = selected;
    } else if (target.type === "field" && target.id) {
      updateField(target.id, selected);
    } else if (target.type === "section" && issue.section === "summary") {
      r.summary = selected;
    } else {
      toast("warning", "This suggestion cannot be auto-applied yet.");
      return;
    }
    if (!(target.type === "field" && target.id)) saveResume(r);
    view.critiqueAppliedIds[issueKeyStr] = true;
    if (target.type === "bullet") recordAppliedAiBulletId(target.id);
    toast("success", "Fix applied.");
    rerenderEditor();
  }

  function applyAllSafeCritiqueFixes() {
    if (!view.critiqueResult) return;
    const r = currentResume();
    if (!r) return;
    const data = view.critiqueResult.data || view.critiqueResult;
    const issues = Array.isArray(data.issues) ? data.issues : [];
    let applied = 0;
    issues.forEach(function (issue) {
      const key = issueKey(issue);
      if (!key || view.critiqueDismissedIds[key] || view.critiqueAppliedIds[key]) return;
      const target = issue && issue.target;
      const options = buildCritiqueRewriteOptions(issue);
      if (!options.length || !target) return;
      const selected = options[0];
      if (target.type === "bullet" && target.id) {
        const bullet = findBulletById(r, target.id);
        if (!bullet) return;
        bullet.text = selected;
      } else if (target.type === "field" && target.id) {
        updateField(target.id, selected);
      } else if (target.type === "section" && issue.section === "summary") {
        r.summary = selected;
      } else {
        return;
      }
      view.critiqueAppliedIds[key] = true;
      if (target.type === "bullet" && target.id) recordAppliedAiBulletId(target.id);
      applied += 1;
    });
    if (!applied) {
      toast("warning", "No safe critique fixes available.");
      return;
    }
    saveResume(r);
    toast("success", "Applied " + applied + " critique fixes.");
    rerenderEditor();
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — Tailor workspace handlers
  // ---------------------------------------------------------------------------
  function switchWorkMode(mode) {
    if (mode !== "edit" && mode !== "tailor") return;
    if (view.workMode === mode) return;
    view.workMode = mode;
    if (mode === "tailor") hydrateTailorView();
    rerenderEditor();
  }

  function bindTailorWorkspace() {
    const side = document.getElementById("resume-side");
    if (!side) return;

    const jdForm = document.getElementById("tailor-jd-form");
    if (jdForm) {
      jdForm.addEventListener("submit", function (e) {
        e.preventDefault();
        runJdAnalyze();
      });
    }

    const textArea = document.getElementById("tailor-jd-text");
    if (textArea) {
      textArea.addEventListener("input", function () {
        view.jdText = textArea.value;
      });
    }
    const roleInput = document.getElementById("tailor-target-role");
    if (roleInput) {
      roleInput.addEventListener("input", function () {
        view.jdRole = roleInput.value;
      });
    }

    // Delegated click handler for buttons inside the workspace
    side.addEventListener("click", function (e) {
      const btn = e.target.closest("button");
      if (!btn) return;

      if (btn.id === "run-jd-analyze") return; // handled via form submit
      if (btn.matches("[data-asset-suggest-action]")) {
        const action = btn.getAttribute("data-asset-suggest-action");
        const id = btn.getAttribute("data-asset-suggestion-id");
        if (action === "save") saveSuggestedAsset(id);
        return;
      }
      if (btn.id === "clear-jd") {
        view.jdAnalyzed = null;
        view.jdText = "";
        view.jdRole = "";
        view.jdError = "";
        view.tailorPlan = null;
        view.tailorAppliedIds = {};
        view.tailorDismissedIds = {};
        view.summaryApplied = false;
        view.appliedSkills = {};
        persistTailorView();
        rerenderTailorSide();
        return;
      }
      if (btn.id === "run-tailor-plan" || btn.id === "regen-tailor-plan") {
        runTailorPlan();
        return;
      }
      if (btn.id === "fill-inferred-role") {
        const inferred = inferTargetRoleFromResume(currentResume());
        if (inferred) {
          view.jdRole = inferred;
          persistTailorView();
          rerenderTailorSide();
        }
        return;
      }
      if (btn.id === "apply-tailor-safe") {
        applyAllSafeTailorSuggestions();
        return;
      }
      if (btn.id === "clear-tailor-plan") {
        view.tailorPlan = null;
        view.tailorAppliedIds = {};
        view.tailorDismissedIds = {};
        view.summaryApplied = false;
        view.appliedSkills = {};
        persistTailorView();
        rerenderTailorSide();
        return;
      }
      if (btn.matches("[data-apply-tailor-summary]")) {
        applyTailorSummary(Number(btn.getAttribute("data-option-index") || "0"));
        return;
      }
      if (btn.matches("[data-apply-bullet]")) {
        applyTailorBullet(
          btn.getAttribute("data-id"),
          Number(btn.getAttribute("data-option-index") || "0")
        );
        return;
      }
      if (btn.matches("[data-jump-bullet]")) {
        jumpToBullet(btn.getAttribute("data-id"));
        return;
      }
      if (btn.matches("[data-dismiss-bullet]")) {
        view.tailorDismissedIds[btn.getAttribute("data-id")] = true;
        persistTailorView();
        rerenderTailorSide();
        return;
      }
      if (btn.matches("[data-apply-skill]")) {
        applyTailorSkill(btn.getAttribute("data-key"), btn.getAttribute("data-skill"), btn.getAttribute("data-group"));
        return;
      }
      if (btn.matches("[data-dismiss-skill]")) {
        view.appliedSkills[btn.getAttribute("data-key")] = "dismissed";
        persistTailorView();
        rerenderTailorSide();
        return;
      }
    });
  }

  function rerenderTailorSide() {
    const side = document.getElementById("resume-side");
    if (!side) return;
    const r = currentResume();
    if (!r) return;
    side.innerHTML = renderTailorWorkspace(r);
    bindTailorWorkspace();
  }

  async function runJdAnalyze() {
    const text = (view.jdText || "").trim();
    if (!text) {
      view.jdError = "Paste a job description first.";
      rerenderTailorSide();
      return;
    }
    view.jdBusy = true;
    view.jdError = "";
    rerenderTailorSide();

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") throw new Error("AI orchestrator not available.");
      const jdForAi = clipText(text, AI_LIMITS.jdAnalyzeChars);
      if (jdForAi.length < text.length) {
        toast("warning", "JD is long — analyzed first part to stay within model limits.");
      }
      const result = await ai.runSkill("jd-analyze", { jd: jdForAi });
      const data = result.data || result;
      view.jdAnalyzed = data;
      if (!view.jdRole && data.role) view.jdRole = data.role;
      persistTailorView();
      toast("success", "Job description analyzed.");
    } catch (err) {
      view.jdError = (err && err.message) || "JD analysis failed.";
      toast("error", view.jdError);
    } finally {
      view.jdBusy = false;
      rerenderTailorSide();
    }
  }

  async function runTailorPlan() {
    const r = currentResume();
    if (!r) {
      toast("warning", "Upload a resume first.");
      return;
    }
    view.planBusy = true;
    view.planError = "";
    rerenderTailorSide();

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") throw new Error("AI orchestrator not available.");
      const compact = compactResumeForAi(r, false);
      const jdRaw = view.jdText || "";
      const jdForAi = clipText(jdRaw, AI_LIMITS.jdPlanChars);
      const analyzedForAi = compactJdAnalyzedForAi(view.jdAnalyzed);
      const roleForAi = view.jdRole || (view.jdAnalyzed && view.jdAnalyzed.role) || inferTargetRoleFromResume(r) || "";
      if (!jdForAi && !view.jdAnalyzed) {
        toast("info", "No JD provided — generating a general optimization plan.");
      }
      const result = await ai.runSkill("tailor-plan", {
        resume: clipText(JSON.stringify(compact), AI_LIMITS.resumeJsonChars),
        jd: jdForAi,
        jdAnalyzed: view.jdAnalyzed
          ? clipText(JSON.stringify(analyzedForAi), AI_LIMITS.resumeJsonChars)
          : "",
        targetRole: roleForAi,
        // R1: bullet IDs the user already accepted an AI rewrite for
        // (union of critique + earlier tailor applies). The prompt skips
        // these so the user doesn't see the same bullet flagged twice.
        appliedBulletIds: Object.keys(view.appliedAiBulletIds || {})
      });
      const planData = result.data || result;
      if (planData && typeof planData === "object") ensureTailorPlanSummaryVariants(planData);
      view.tailorPlan = result;
      view.tailorAppliedIds = {};
      view.tailorDismissedIds = {};
      view.summaryApplied = false;
      view.appliedSkills = {};
      persistTailorView();
      toast("success", "Tailoring plan ready.");
    } catch (err) {
      view.planError = (err && err.message) || "Tailor plan failed.";
      toast("error", view.planError);
    } finally {
      view.planBusy = false;
      rerenderTailorSide();
    }
  }

  function applyTailorSummary(optionIndex) {
    if (!view.tailorPlan) return;
    const data = view.tailorPlan.data || view.tailorPlan;
    const r = currentResume();
    const opts = getTailorSummaryOptions(data);
    const idx = Math.max(0, Math.min(Number(optionIndex) || 0, Math.max(0, opts.length - 1)));
    const chosen = opts[idx];
    if (!r || !chosen) return;
    r.summary = chosen;
    saveResume(r);
    view.summaryApplied = true;
    persistTailorView();
    toast("success", "Summary applied.");
    rerenderEditor();
  }

  function applyTailorBullet(id, optionIndex) {
    if (!view.tailorPlan || !id) return;
    const data = view.tailorPlan.data || view.tailorPlan;
    const bullets = data.bullets || [];
    const match = bullets.find(function (b) { return b.targetBulletId === id; });
    if (!match) return;
    const r = currentResume();
    if (!r) return;
    const bullet = findBulletById(r, id);
    if (!bullet) {
      toast("warning", "Bullet not found — it may have been removed.");
      return;
    }
    const options = getRewriteOptions(match.rewrite, match.alternatives);
    const selected = options[Math.max(0, Number(optionIndex) || 0)] || options[0] || "";
    if (!selected) return;
    bullet.text = selected;
    saveResume(r);
    view.tailorAppliedIds[id] = true;
    recordAppliedAiBulletId(id);
    persistTailorView();
    toast("success", "Bullet rewritten.");
    rerenderEditor();
  }

  function applyTailorSkill(key, skill, group) {
    if (!skill) return;
    const r = currentResume();
    if (!r) return;
    r.skills = r.skills || { groups: [] };
    r.skills.groups = r.skills.groups || [];
    const groupName = group || "Other";
    let targetGroup = r.skills.groups.find(function (g) {
      return (g.label || "").toLowerCase() === groupName.toLowerCase();
    });
    if (!targetGroup) {
      targetGroup = { id: model.newId("skg"), label: groupName, items: [] };
      r.skills.groups.push(targetGroup);
    }
    // Avoid duplicates (case-insensitive)
    const exists = (targetGroup.items || []).some(function (s) {
      return String(s).toLowerCase() === String(skill).toLowerCase();
    });
    if (!exists) targetGroup.items.push(skill);
    saveResume(r);
    view.appliedSkills[key] = "applied";
    persistTailorView();
    toast("success", "Added " + skill + " to Skills.");
    rerenderEditor();
  }

  function applyAllSafeTailorSuggestions() {
    if (!view.tailorPlan) return;
    const r = currentResume();
    if (!r) return;
    const data = view.tailorPlan.data || view.tailorPlan;
    let appliedSummary = false;
    let appliedBullets = 0;
    let appliedSkills = 0;

    if (!view.summaryApplied) {
      const sumOpts = getTailorSummaryOptions(data);
      if (sumOpts.length) {
        r.summary = sumOpts[0];
        view.summaryApplied = true;
        appliedSummary = true;
      }
    }

    (data.bullets || []).forEach(function (b) {
      const id = b && b.targetBulletId;
      if (!id || view.tailorAppliedIds[id] || view.tailorDismissedIds[id]) return;
      const bullet = findBulletById(r, id);
      const options = getRewriteOptions(b && b.rewrite, b && b.alternatives);
      if (!bullet || !options.length) return;
      bullet.text = options[0];
      view.tailorAppliedIds[id] = true;
      recordAppliedAiBulletId(id);
      appliedBullets += 1;
    });

    r.skills = r.skills || { groups: [] };
    r.skills.groups = r.skills.groups || [];
    (data.addSkills || []).forEach(function (s) {
      const skill = String((s && s.skill) || "").trim();
      const evidence = String((s && s.evidence) || "").trim();
      const groupName = String((s && s.group) || "Other").trim() || "Other";
      const key = skill.toLowerCase();
      if (!skill || !evidence || view.appliedSkills[key] === "dismissed" || view.appliedSkills[key] === "applied") return;
      let group = r.skills.groups.find(function (g) {
        return String((g && g.label) || "").toLowerCase() === groupName.toLowerCase();
      });
      if (!group) {
        group = { id: model.newId("skg"), label: groupName, items: [] };
        r.skills.groups.push(group);
      }
      const exists = (group.items || []).some(function (item) {
        return String(item || "").toLowerCase() === key;
      });
      if (exists) {
        view.appliedSkills[key] = "applied";
        return;
      }
      group.items.push(skill);
      view.appliedSkills[key] = "applied";
      appliedSkills += 1;
    });

    if (!appliedSummary && !appliedBullets && !appliedSkills) {
      toast("warning", "No safe tailoring suggestions available.");
      return;
    }
    saveResume(r);
    persistTailorView();
    toast("success", "Applied safe suggestions: " + [appliedSummary ? "summary" : "", appliedBullets ? (appliedBullets + " bullets") : "", appliedSkills ? (appliedSkills + " skills") : ""].filter(Boolean).join(", ") + ".");
    rerenderEditor();
  }

  function jumpToBullet(id) {
    if (!id) return;
    const el = document.querySelector('[data-bullet-id="' + id + '"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("section-flash");
      setTimeout(function () { el.classList.remove("section-flash"); }, 1600);
      return;
    }
    // Fallback — jump to the experience section at least
    jumpToSection("experience");
  }

  function jumpToSection(section) {
    if (!section) return;
    // Each section uses data-section="<section>" on its header wrapper.
    const el = document.querySelector('[data-section="' + section + '"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("section-flash");
      setTimeout(function () { el.classList.remove("section-flash"); }, 1600);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — Export dialog (templates, preview, download)
  // ---------------------------------------------------------------------------
  function templatesMod() { return window.CBV2.resume && window.CBV2.resume.templates; }
  function exportMod() { return window.CBV2.resume && window.CBV2.resume.export; }

  function currentExportOpts() {
    const t = templatesMod();
    if (!t) return {};
    const defaults = t.defaultsFor(view.exportTemplate);
    return {
      accent: view.exportAccent || defaults.accent,
      fontSize: view.exportFontSize || 10.5,
      pageSize: view.exportPageSize || "a4",
      quality: view.exportQuality === "high" ? "high" : "balanced"
    };
  }

  function computeExportPreflight(r, opts) {
    const issues = [];
    const blockers = [];
    let suggestedFontSize = opts.fontSize || 10.5;
    const bullets = [];
    (r.experience || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) { bullets.push(String((b && b.text) || "")); });
    });
    (r.projects || []).forEach(function (p) {
      (p.bullets || []).forEach(function (b) { bullets.push(String((b && b.text) || "")); });
    });
    const longBullets = bullets.filter(function (b) { return b.length > 220; }).length;
    const veryLongBullets = bullets.filter(function (b) { return b.length > 320; }).length;
    if (longBullets) issues.push(longBullets + " bullet(s) are long; may wrap badly in PDF.");
    if (veryLongBullets) blockers.push(veryLongBullets + " bullet(s) are extremely long and likely to break layout.");

    const expCount = (r.experience || []).length;
    const projCount = (r.projects || []).length;
    const certCount = (r.certifications || []).length;
    const totalEntries = expCount + projCount + certCount;
    if (totalEntries > 24) {
      issues.push("High content density; consider trimming less relevant entries.");
      suggestedFontSize = Math.max(9, Math.min(suggestedFontSize, 10));
    }
    if (bullets.length > 40) {
      issues.push("Very high bullet count; document may run long.");
      suggestedFontSize = Math.max(9, Math.min(suggestedFontSize, 9.5));
    }
    const missingHeader = [];
    if (!(r.header && r.header.name)) missingHeader.push("name");
    if (!(r.header && r.header.email)) missingHeader.push("email");
    if (missingHeader.length) blockers.push("Header missing " + missingHeader.join(" + ") + ".");

    if (String(opts.pageSize || "a4") === "letter" && totalEntries > 20) {
      issues.push("Letter page may be tight for this content; A4 is safer.");
    }

    return {
      ok: blockers.length === 0,
      issues: issues,
      blockers: blockers,
      suggested: {
        fontSize: Math.round(suggestedFontSize * 2) / 2,
        pageSize: totalEntries > 22 ? "a4" : (opts.pageSize || "a4")
      }
    };
  }

  function openExportDialog() {
    const r = currentResume();
    if (!r) {
      toast("warning", "Upload or create a resume before exporting.");
      return;
    }
    view.exportOpen = true;
    view.exportError = "";
    const t = templatesMod();
    if (t) {
      const d = t.defaultsFor(view.exportTemplate);
      if (!view.exportAccent) view.exportAccent = d.accent;
    }
    rerender();
  }

  function closeExportDialog() {
    view.exportOpen = false;
    rerender();
  }

  function renderExportDialog() {
    const r = currentResume();
    if (!r) return "";
    const t = templatesMod();
    if (!t) return "";
    const opts = currentExportOpts();
    const preflight = computeExportPreflight(r, opts);
    const tpls = t.list();
    const fileBase = exportMod() ? exportMod().baseFilename(r, view.exportTemplate) : "resume";

    const cards = tpls.map(function (tpl) {
      const isActive = tpl.id === view.exportTemplate;
      return `
        <button type="button" class="tpl-card ${isActive ? "is-active" : ""}" data-tpl="${st(tpl.id)}">
          <div class="tpl-card-thumb tpl-thumb-${st(tpl.id)}" aria-hidden="true">
            ${renderTemplateThumb(tpl.id, view.exportAccent)}
          </div>
          <div class="tpl-card-body">
            <h4>${st(tpl.name)}</h4>
            <p class="tpl-tagline">${st(tpl.tagline)}</p>
            <p class="tpl-description muted">${st(tpl.description)}</p>
          </div>
          ${isActive ? '<div class="tpl-card-check"><i class="fa-solid fa-check"></i></div>' : ""}
        </button>
      `;
    }).join("");

    const busyHtml = view.exportBusy
      ? '<p class="export-status"><i class="fa-solid fa-circle-notch fa-spin"></i> Preparing file…</p>'
      : "";
    const errHtml = view.exportError
      ? '<p class="ai-error export-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(view.exportError) + "</p>"
      : "";
    const preflightHtml = `
      <div class="export-option export-preflight">
        <label>Preflight QA</label>
        <div class="export-preflight-head">
          <span class="chip ${preflight.ok ? "green" : "warning"}">${preflight.ok ? "Pass" : "Needs attention"}</span>
          <button type="button" class="btn-ghost btn-sm" id="export-autofix">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Auto-fix layout
          </button>
        </div>
        ${preflight.blockers.length
          ? '<ul class="export-preflight-list export-preflight-blockers">' + preflight.blockers.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul>"
          : ""}
        ${preflight.issues.length
          ? '<ul class="export-preflight-list">' + preflight.issues.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul>"
          : '<p class="muted">No major layout risks detected.</p>'}
      </div>
    `;

    return `
      <div class="export-dialog-overlay" id="export-dialog-overlay">
        <div class="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
          <header class="export-dialog-head">
            <div>
              <p class="eyebrow">Export</p>
              <h2 id="export-dialog-title">Download your resume</h2>
              <p class="muted">Pick a template, preview it live, tune the details, then download as PDF or Word.</p>
            </div>
            <button class="icon-btn" id="export-dialog-close" aria-label="Close" type="button"><i class="fa-solid fa-xmark"></i></button>
          </header>

          <div class="export-dialog-body">
            <aside class="export-templates">
              <h3 class="export-panel-title">Template</h3>
              <div class="tpl-card-list">${cards}</div>
            </aside>

            <section class="export-preview">
              <div class="export-preview-head">
                <h3 class="export-panel-title">Live preview</h3>
                <span class="chip subtle">${st(view.exportPageSize === "letter" ? "Letter" : "A4")} · ${st(view.exportFontSize)}pt · ${view.exportQuality === "high" ? "HQ" : "Balanced"}</span>
              </div>
              <div class="export-preview-frame">
                <iframe id="export-preview-iframe" title="Resume preview" sandbox="allow-same-origin"></iframe>
              </div>
            </section>

            <aside class="export-options">
              <h3 class="export-panel-title">Options</h3>

              <div class="export-option">
                <label for="export-page-size">Page size</label>
                <div class="seg-control" role="radiogroup" aria-label="Page size">
                  <button type="button" role="radio" aria-checked="${view.exportPageSize === "a4" ? "true" : "false"}" class="seg-btn ${view.exportPageSize === "a4" ? "is-active" : ""}" data-page-size="a4">A4</button>
                  <button type="button" role="radio" aria-checked="${view.exportPageSize === "letter" ? "true" : "false"}" class="seg-btn ${view.exportPageSize === "letter" ? "is-active" : ""}" data-page-size="letter">Letter</button>
                </div>
              </div>

              <div class="export-option">
                <label>Quality mode</label>
                <div class="seg-control" role="radiogroup" aria-label="Export quality">
                  <button type="button" role="radio" aria-checked="${view.exportQuality !== "high" ? "true" : "false"}" class="seg-btn ${view.exportQuality !== "high" ? "is-active" : ""}" data-export-quality="balanced">Balanced</button>
                  <button type="button" role="radio" aria-checked="${view.exportQuality === "high" ? "true" : "false"}" class="seg-btn ${view.exportQuality === "high" ? "is-active" : ""}" data-export-quality="high">High Quality (Best)</button>
                </div>
                <p class="muted" style="margin:6px 0 0;">High quality adds safer print margins and stricter anti-break rules for cleaner exports on dense resumes.</p>
              </div>

              <div class="export-option">
                <label for="export-font-size">Font size <span class="muted num-font">${st(view.exportFontSize)}pt</span></label>
                <input type="range" id="export-font-size" min="9" max="12" step="0.5" value="${st(view.exportFontSize)}" />
              </div>

              <div class="export-option">
                <label for="export-accent">Accent color</label>
                <div class="accent-row">
                  <input type="color" id="export-accent" value="${st(view.exportAccent || opts.accent)}" />
                  <code class="accent-code">${st((view.exportAccent || opts.accent).toUpperCase())}</code>
                  <button type="button" class="btn-ghost btn-sm" id="export-accent-reset" title="Reset to template default"><i class="fa-solid fa-rotate-left"></i></button>
                </div>
                <div class="accent-swatches" role="list">
                  ${["#0F172A","#1F5FFF","#0EA5E9","#16A34A","#9333EA","#E11D48","#F97316","#111111"].map(function (c) {
                    return '<button type="button" class="swatch ' + ((view.exportAccent || opts.accent).toLowerCase() === c.toLowerCase() ? "is-active" : "") + '" data-swatch="' + c + '" style="background:' + c + '" aria-label="Use ' + c + '"></button>';
                  }).join("")}
                </div>
              </div>

              <div class="export-option export-filename-row">
                <label>File name</label>
                <code class="export-filename">${st(fileBase)}</code>
              </div>

              ${preflightHtml}
              ${errHtml}
              ${busyHtml}

              <div class="export-actions">
                <button class="btn-primary" type="button" id="export-download-pdf" ${view.exportBusy ? "disabled" : ""}>
                  <i class="fa-solid fa-file-pdf"></i> Download PDF
                </button>
                <button class="btn-secondary" type="button" id="export-download-docx" ${view.exportBusy ? "disabled" : ""}>
                  <i class="fa-solid fa-file-word"></i> Download Word
                </button>
                <button class="btn-ghost" type="button" id="export-download-txt" title="Plain text — best format for ATS uploads">
                  <i class="fa-solid fa-file-lines"></i> Plain text (.txt)
                </button>
              </div>
              <p class="muted export-tip"><i class="fa-solid fa-circle-info"></i> PDF opens your browser's print dialog — choose "Save as PDF" as the destination. <strong>.txt</strong> is the most reliable format for ATS uploads.</p>
            </aside>
          </div>
        </div>
      </div>
    `;
  }

  // Tiny inline SVG thumbs for each template so the picker is instantly readable.
  function renderTemplateThumb(tplId, accent) {
    const a = accent || "#0F172A";
    const bars = function (x, y, w, count, gap) {
      gap = gap || 4;
      let out = "";
      for (let i = 0; i < count; i++) {
        out += '<rect x="' + x + '" y="' + (y + i * gap) + '" width="' + (w - Math.random() * 10).toFixed(0) + '" height="2" rx="1" fill="#e5e7eb"/>';
      }
      return out;
    };

    if (tplId === "metro-dark") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="120" height="34" fill="#343A40"/>' +
          '<rect x="8" y="10" width="46" height="5" fill="#fff"/>' +
          '<rect x="8" y="19" width="32" height="2" fill="#d1d5db"/>' +
          '<rect x="0" y="34" width="40" height="126" fill="#f3f4f6"/>' +
          '<rect x="5" y="42" width="20" height="3" fill="#374151"/>' +
          bars(5, 50, 30, 5, 4) +
          '<line x1="52" y1="44" x2="52" y2="150" stroke="#d1d5db" stroke-width="1"/>' +
          '<circle cx="52" cy="52" r="3" fill="#374151"/>' +
          '<circle cx="52" cy="82" r="3" fill="#374151"/>' +
          '<circle cx="52" cy="112" r="3" fill="#374151"/>' +
          '<rect x="60" y="48" width="48" height="3" fill="#111827"/>' +
          bars(60, 56, 50, 5, 4) +
        '</svg>'
      );
    }
    if (tplId === "soft-blue") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="42" height="160" fill="#f4f5f7"/>' +
          '<circle cx="21" cy="20" r="12" fill="#d1d5db"/>' +
          '<rect x="6" y="38" width="30" height="3" fill="#9FB4DB"/>' +
          bars(6, 46, 30, 6, 4) +
          '<rect x="48" y="12" width="24" height="3" fill="#9FB4DB"/>' +
          '<rect x="48" y="18" width="34" height="6" fill="#9FB4DB"/>' +
          '<rect x="48" y="28" width="50" height="2" fill="#6b7280"/>' +
          '<rect x="48" y="38" width="56" height="3" fill="#9FB4DB"/>' +
          bars(48, 46, 56, 10, 4) +
        '</svg>'
      );
    }
    if (tplId === "horizon-blue") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="120" height="14" fill="#AFCFE5"/>' +
          '<rect x="14" y="22" width="68" height="5" fill="#111827"/>' +
          '<rect x="14" y="31" width="36" height="2" fill="#6b7280"/>' +
          '<rect x="10" y="40" width="100" height="1.2" fill="#AFCFE5"/>' +
          '<rect x="10" y="46" width="24" height="3" fill="#111827"/>' +
          bars(36, 46, 72, 4, 4) +
          '<rect x="10" y="66" width="24" height="3" fill="#111827"/>' +
          bars(36, 66, 72, 7, 4) +
        '</svg>'
      );
    }
    if (tplId === "mint-line") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<line x1="14" y1="10" x2="14" y2="150" stroke="#2AB7A9" stroke-width="1.5"/>' +
          '<circle cx="14" cy="26" r="2.8" fill="#e6fffb" stroke="#2AB7A9" stroke-width="1.2"/>' +
          '<circle cx="14" cy="56" r="2.8" fill="#e6fffb" stroke="#2AB7A9" stroke-width="1.2"/>' +
          '<circle cx="14" cy="88" r="2.8" fill="#e6fffb" stroke="#2AB7A9" stroke-width="1.2"/>' +
          '<rect x="22" y="12" width="52" height="6" fill="#1f2937"/>' +
          '<rect x="22" y="22" width="36" height="2" fill="#6b7280"/>' +
          '<rect x="22" y="30" width="42" height="3" fill="#2AB7A9"/>' +
          bars(22, 38, 86, 4, 4) +
          '<rect x="22" y="58" width="42" height="3" fill="#2AB7A9"/>' +
          bars(22, 66, 86, 8, 4) +
        '</svg>'
      );
    }
    if (tplId === "clean-pro") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="120" height="24" fill="#f7f7f7"/>' +
          '<rect x="6" y="8" width="38" height="4" fill="#4b5563"/>' +
          '<circle cx="106" cy="12" r="7" fill="#e5e7eb"/>' +
          '<rect x="0" y="24" width="36" height="136" fill="#fff"/>' +
          '<line x1="36" y1="26" x2="36" y2="156" stroke="#ececec" stroke-width="1"/>' +
          '<rect x="6" y="32" width="20" height="3" fill="#6b7280"/>' +
          bars(6, 40, 24, 6, 4) +
          '<rect x="42" y="32" width="36" height="3" fill="#6b7280"/>' +
          bars(42, 40, 66, 10, 4) +
        '</svg>'
      );
    }

    if (tplId === "executive") {
      // Dark hero with gold monogram + split body
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="120" height="42" fill="#1F2E4A"/>' +
          '<circle cx="60" cy="13" r="5" fill="#B8935C"/>' +
          '<text x="60" y="16" text-anchor="middle" font-size="5" font-weight="700" fill="#1F2E4A" font-family="serif">AR</text>' +
          '<rect x="38" y="22" width="44" height="5" rx="0.5" fill="#B8935C"/>' +
          '<rect x="44" y="30" width="32" height="2" rx="0.5" fill="rgba(255,255,255,0.8)"/>' +
          '<rect x="0" y="42" width="42" height="118" fill="#F7F5F0"/>' +
          '<rect x="5" y="50" width="18" height="3" fill="#1F2E4A"/>' +
          '<rect x="5" y="56" width="32" height="1" fill="#1F2E4A"/>' +
          bars(5, 62, 30, 3, 4) +
          '<rect x="5" y="80" width="14" height="3" fill="#1F2E4A"/>' +
          '<rect x="5" y="86" width="32" height="1" fill="#1F2E4A"/>' +
          bars(5, 92, 28, 4, 4) +
          '<rect x="5" y="115" width="18" height="3" fill="#1F2E4A"/>' +
          '<rect x="5" y="121" width="32" height="1" fill="#1F2E4A"/>' +
          bars(5, 127, 30, 4, 4) +
          '<rect x="48" y="50" width="26" height="3" fill="#1F2E4A"/>' +
          '<rect x="48" y="56" width="68" height="0.8" fill="' + a + '"/>' +
          bars(48, 62, 66, 3, 4) +
          '<rect x="48" y="80" width="34" height="3" fill="#1F2E4A"/>' +
          '<rect x="48" y="86" width="68" height="0.8" fill="' + a + '"/>' +
          '<rect x="48" y="92" width="24" height="2" fill="#1F2E4A"/>' +
          '<rect x="48" y="96" width="40" height="2" fill="' + a + '"/>' +
          bars(48, 102, 66, 4, 4) +
        '</svg>'
      );
    }

    if (tplId === "timeline") {
      // Two-col with timeline dots on the right
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fafaf7"/>' +
          '<rect x="0" y="0" width="120" height="28" fill="#fff"/>' +
          '<rect x="8" y="8" width="60" height="5" fill="#0f172a"/>' +
          '<rect x="8" y="16" width="36" height="2" fill="' + a + '"/>' +
          '<rect x="8" y="22" width="16" height="1.5" fill="' + a + '"/>' +
          '<rect x="0" y="28" width="120" height="1" fill="#e5e7eb"/>' +
          '<rect x="0" y="29" width="40" height="131" fill="#F2EFE6"/>' +
          '<rect x="4" y="36" width="16" height="3" fill="#0f172a"/>' +
          '<rect x="4" y="42" width="12" height="1.5" fill="' + a + '"/>' +
          bars(4, 48, 32, 4, 4) +
          '<rect x="4" y="72" width="14" height="3" fill="#0f172a"/>' +
          bars(4, 80, 30, 4, 4) +
          '<rect x="4" y="105" width="18" height="3" fill="#0f172a"/>' +
          bars(4, 113, 32, 4, 4) +
          '<line x1="52" y1="44" x2="52" y2="150" stroke="#d4d4d8" stroke-width="0.6"/>' +
          '<circle cx="52" cy="44" r="4" fill="#0f172a"/>' +
          '<rect x="60" y="40" width="30" height="3" fill="#0f172a"/>' +
          bars(60, 48, 52, 3, 4) +
          '<circle cx="52" cy="74" r="4" fill="#0f172a"/>' +
          '<rect x="60" y="70" width="40" height="3" fill="#0f172a"/>' +
          '<rect x="60" y="76" width="52" height="0.6" fill="' + a + '"/>' +
          bars(60, 80, 52, 4, 4) +
          '<circle cx="52" cy="114" r="4" fill="#0f172a"/>' +
          '<rect x="60" y="110" width="30" height="3" fill="#0f172a"/>' +
          bars(60, 118, 52, 4, 4) +
        '</svg>'
      );
    }

    if (tplId === "sidebar") {
      // Dark left sidebar with photo/monogram circle
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="44" height="160" fill="' + a + '"/>' +
          '<circle cx="22" cy="22" r="13" fill="#E5E5E5"/>' +
          '<circle cx="22" cy="18" r="4" fill="#A3A3A3"/>' +
          '<path d="M13 30 Q22 25 31 30 L31 32 L13 32 Z" fill="#A3A3A3"/>' +
          '<rect x="4" y="42" width="36" height="3" fill="#fff"/>' +
          '<rect x="10" y="48" width="24" height="1.5" fill="rgba(255,255,255,0.7)"/>' +
          '<line x1="4" y1="54" x2="40" y2="54" stroke="rgba(255,255,255,0.25)" stroke-width="0.4"/>' +
          '<circle cx="7" cy="62" r="1.5" fill="#fff"/>' +
          '<rect x="11" y="60" width="28" height="1.5" fill="#fff"/>' +
          '<rect x="11" y="63.5" width="22" height="1.5" fill="rgba(255,255,255,0.6)"/>' +
          '<circle cx="7" cy="72" r="1.5" fill="#fff"/>' +
          '<rect x="11" y="70" width="28" height="1.5" fill="#fff"/>' +
          '<rect x="11" y="73.5" width="20" height="1.5" fill="rgba(255,255,255,0.6)"/>' +
          '<circle cx="7" cy="82" r="1.5" fill="#fff"/>' +
          '<rect x="11" y="80" width="24" height="1.5" fill="#fff"/>' +
          '<rect x="11" y="83.5" width="18" height="1.5" fill="rgba(255,255,255,0.6)"/>' +
          '<rect x="4" y="96" width="16" height="2.5" fill="#fff"/>' +
          '<rect x="4" y="102" width="30" height="1.5" fill="rgba(255,255,255,0.7)"/>' +
          '<rect x="4" y="106" width="26" height="1.5" fill="rgba(255,255,255,0.7)"/>' +
          '<rect x="4" y="110" width="32" height="1.5" fill="rgba(255,255,255,0.7)"/>' +
          '<rect x="4" y="124" width="20" height="2.5" fill="#fff"/>' +
          '<rect x="4" y="130" width="28" height="1.5" fill="rgba(255,255,255,0.7)"/>' +
          '<rect x="4" y="134" width="24" height="1.5" fill="rgba(255,255,255,0.7)"/>' +
          bars(52, 12, 60, 2, 4) +
          '<rect x="52" y="26" width="30" height="3" fill="' + a + '"/>' +
          '<rect x="52" y="32" width="60" height="0.8" fill="' + a + '"/>' +
          '<rect x="52" y="38" width="12" height="1.5" fill="' + a + '"/>' +
          '<rect x="70" y="38" width="26" height="1.5" fill="#0f172a"/>' +
          '<rect x="70" y="42" width="20" height="1.5" fill="#6b7280"/>' +
          bars(70, 47, 40, 3, 4) +
          '<rect x="52" y="66" width="12" height="1.5" fill="' + a + '"/>' +
          '<rect x="70" y="66" width="26" height="1.5" fill="#0f172a"/>' +
          '<rect x="70" y="70" width="22" height="1.5" fill="#6b7280"/>' +
          bars(70, 75, 40, 3, 4) +
          '<rect x="52" y="94" width="22" height="3" fill="' + a + '"/>' +
          '<rect x="52" y="100" width="60" height="0.8" fill="' + a + '"/>' +
          bars(52, 106, 58, 3, 4) +
        '</svg>'
      );
    }

    if (tplId === "editorial") {
      // Dark hero bar + monogram box right
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="0" y="0" width="120" height="32" fill="' + a + '"/>' +
          '<rect x="6" y="10" width="60" height="7" fill="#fff"/>' +
          '<rect x="6" y="20" width="36" height="2" fill="rgba(255,255,255,0.7)"/>' +
          '<rect x="96" y="6" width="18" height="20" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="0.6"/>' +
          '<text x="105" y="20" text-anchor="middle" font-size="7" fill="#fff" font-family="serif">M/W</text>' +
          '<rect x="0" y="32" width="38" height="128" fill="#F7F5F0"/>' +
          '<rect x="4" y="40" width="18" height="2.5" fill="' + a + '"/>' +
          '<rect x="4" y="46" width="30" height="0.6" fill="#d6d3cc"/>' +
          bars(4, 52, 28, 3, 4) +
          '<rect x="4" y="72" width="20" height="2.5" fill="' + a + '"/>' +
          '<rect x="4" y="78" width="30" height="0.6" fill="#d6d3cc"/>' +
          bars(4, 84, 28, 3, 4) +
          '<rect x="4" y="106" width="14" height="2.5" fill="' + a + '"/>' +
          '<rect x="4" y="112" width="30" height="0.6" fill="#d6d3cc"/>' +
          bars(4, 118, 28, 3, 4) +
          '<rect x="44" y="40" width="30" height="2.5" fill="' + a + '"/>' +
          '<rect x="44" y="46" width="70" height="0.6" fill="#d6d3cc"/>' +
          bars(44, 52, 68, 3, 4) +
          '<rect x="44" y="70" width="30" height="2.5" fill="' + a + '"/>' +
          '<rect x="44" y="76" width="70" height="0.6" fill="#d6d3cc"/>' +
          '<rect x="44" y="82" width="24" height="1.5" fill="#0f172a"/>' +
          '<rect x="44" y="86" width="40" height="1.5" fill="#525252"/>' +
          bars(44, 92, 68, 3, 4) +
          '<rect x="44" y="110" width="24" height="1.5" fill="#0f172a"/>' +
          '<rect x="44" y="114" width="40" height="1.5" fill="#525252"/>' +
          bars(44, 120, 68, 3, 4) +
        '</svg>'
      );
    }

    if (tplId === "modern") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="8" y="10" width="4" height="30" fill="' + a + '"/>' +
          '<rect x="18" y="14" width="60" height="6" rx="1" fill="#111827"/>' +
          '<rect x="18" y="24" width="38" height="4" rx="1" fill="' + a + '"/>' +
          '<rect x="18" y="32" width="80" height="3" rx="1" fill="#d4d4d8"/>' +
          '<rect x="10" y="50" width="30" height="3" rx="1" fill="' + a + '"/>' +
          bars(10, 58, 95, 3, 4) +
          '<rect x="10" y="82" width="30" height="3" rx="1" fill="' + a + '"/>' +
          '<rect x="10" y="90" width="14" height="5" rx="2" fill="' + a + '33"/>' +
          '<rect x="28" y="90" width="18" height="5" rx="2" fill="' + a + '33"/>' +
          '<rect x="50" y="90" width="12" height="5" rx="2" fill="' + a + '33"/>' +
          '<rect x="66" y="90" width="16" height="5" rx="2" fill="' + a + '33"/>' +
          '<rect x="10" y="105" width="30" height="3" rx="1" fill="' + a + '"/>' +
          bars(10, 113, 100, 4, 4) +
        '</svg>'
      );
    }

    if (tplId === "minimal") {
      return (
        '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<rect width="120" height="160" fill="#fff"/>' +
          '<rect x="15" y="16" width="55" height="8" rx="1" fill="' + a + '"/>' +
          '<rect x="15" y="28" width="30" height="3" rx="1" fill="#a3a3a3"/>' +
          '<rect x="15" y="38" width="80" height="2" rx="1" fill="#d4d4d8"/>' +
          '<rect x="15" y="52" width="20" height="2" rx="1" fill="#a3a3a3"/>' +
          '<rect x="15" y="60" width="90" height="0.5" fill="#e5e5e5"/>' +
          bars(15, 66, 90, 3, 6) +
          '<rect x="15" y="92" width="20" height="2" rx="1" fill="#a3a3a3"/>' +
          '<rect x="15" y="98" width="90" height="0.5" fill="#e5e5e5"/>' +
          bars(15, 104, 88, 2, 6) +
          '<rect x="15" y="124" width="20" height="2" rx="1" fill="#a3a3a3"/>' +
          '<rect x="15" y="130" width="90" height="0.5" fill="#e5e5e5"/>' +
          bars(15, 136, 50, 1) +
        '</svg>'
      );
    }

    // Fallback — classic-like
    return (
      '<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect width="120" height="160" fill="#fff"/>' +
        '<rect x="35" y="14" width="50" height="8" rx="1" fill="#111"/>' +
        '<rect x="42" y="24" width="36" height="3" rx="1" fill="#555"/>' +
        '<rect x="10" y="36" width="100" height="1" fill="#111"/>' +
        '<rect x="10" y="44" width="30" height="4" rx="1" fill="' + a + '"/>' +
        bars(10, 52, 100, 4, 4) +
        '<rect x="10" y="74" width="30" height="4" rx="1" fill="' + a + '"/>' +
        bars(10, 82, 100, 5, 4) +
      '</svg>'
    );
  }

  function updateExportPreview() {
    const iframe = document.getElementById("export-preview-iframe");
    if (!iframe) return;
    const r = currentResume();
    const ex = exportMod();
    if (!r || !ex) return;
    const html = ex.previewHtml(r, view.exportTemplate, currentExportOpts());
    // Use srcdoc so same-origin sandbox still renders the content
    iframe.srcdoc = html;
  }

  function bindExportDialog() {
    const overlay = document.getElementById("export-dialog-overlay");
    if (!overlay) return;

    // Click-outside dismiss
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeExportDialog();
    });

    const close = document.getElementById("export-dialog-close");
    if (close) close.addEventListener("click", closeExportDialog);

    // Template selection
    document.querySelectorAll(".tpl-card").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-tpl");
        if (!id || id === view.exportTemplate) return;
        view.exportTemplate = id;
        // Reset accent to the new template's default (user can still override)
        const t = templatesMod();
        if (t) view.exportAccent = t.defaultsFor(id).accent;
        rerender();
      });
    });

    // Page size segment
    document.querySelectorAll("[data-page-size]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        view.exportPageSize = btn.getAttribute("data-page-size");
        rerender();
      });
    });
    document.querySelectorAll("[data-export-quality]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        view.exportQuality = btn.getAttribute("data-export-quality") === "high" ? "high" : "balanced";
        rerender();
      });
    });

    const fs = document.getElementById("export-font-size");
    if (fs) {
      fs.addEventListener("input", function () {
        view.exportFontSize = Number(fs.value);
        const label = overlay.querySelector('label[for="export-font-size"] .num-font');
        if (label) label.textContent = view.exportFontSize + "pt";
        // Throttle preview refresh slightly via rAF
        if (fs._raf) cancelAnimationFrame(fs._raf);
        fs._raf = requestAnimationFrame(updateExportPreview);
      });
    }

    const color = document.getElementById("export-accent");
    if (color) {
      color.addEventListener("input", function () {
        view.exportAccent = color.value;
        const codeEl = overlay.querySelector(".accent-code");
        if (codeEl) codeEl.textContent = view.exportAccent.toUpperCase();
        overlay.querySelectorAll(".swatch").forEach(function (s) {
          const on = s.getAttribute("data-swatch") && s.getAttribute("data-swatch").toLowerCase() === view.exportAccent.toLowerCase();
          s.classList.toggle("is-active", on);
        });
        if (color._raf) cancelAnimationFrame(color._raf);
        color._raf = requestAnimationFrame(updateExportPreview);
      });
    }

    document.querySelectorAll(".swatch").forEach(function (btn) {
      btn.addEventListener("click", function () {
        view.exportAccent = btn.getAttribute("data-swatch") || view.exportAccent;
        rerender();
      });
    });

    const accentReset = document.getElementById("export-accent-reset");
    if (accentReset) {
      accentReset.addEventListener("click", function () {
        const t = templatesMod();
        if (t) view.exportAccent = t.defaultsFor(view.exportTemplate).accent;
        rerender();
      });
    }

    const autoFix = document.getElementById("export-autofix");
    if (autoFix) {
      autoFix.addEventListener("click", function () {
        const r = currentResume();
        if (!r) return;
        const pf = computeExportPreflight(r, currentExportOpts());
        view.exportFontSize = pf.suggested.fontSize || view.exportFontSize;
        view.exportPageSize = pf.suggested.pageSize || view.exportPageSize;
        if (pf.blockers.length) view.exportQuality = "high";
        toast("success", "Applied safe layout defaults.");
        rerender();
      });
    }

    const pdfBtn = document.getElementById("export-download-pdf");
    if (pdfBtn) pdfBtn.addEventListener("click", function () { exportAsPdf(); });
    const docxBtn = document.getElementById("export-download-docx");
    if (docxBtn) docxBtn.addEventListener("click", function () { exportAsDocx(); });
    // Phase 4: plain-text (.txt) export for ATS uploads.
    const txtBtn = document.getElementById("export-download-txt");
    if (txtBtn) txtBtn.addEventListener("click", function () { exportAsTxt(); });

    // ESC dismiss
    function onKey(e) {
      if (e.key === "Escape") {
        closeExportDialog();
        document.removeEventListener("keydown", onKey);
      }
    }
    document.addEventListener("keydown", onKey);

    updateExportPreview();
  }

  function exportAsPdf() {
    const r = currentResume();
    const ex = exportMod();
    if (!r || !ex) return;
    try {
      const pf = computeExportPreflight(r, currentExportOpts());
      if (pf.blockers.length) {
        const proceed = window.confirm(
          "Preflight warning:\n- " + pf.blockers.join("\n- ") + "\n\nContinue export anyway?"
        );
        if (!proceed) return;
      }
      view.exportError = "";
      ex.downloadPdf(r, view.exportTemplate, currentExportOpts());
      toast("success", "Opening print dialog — choose 'Save as PDF'.");
    } catch (err) {
      view.exportError = (err && err.message) || "PDF export failed.";
      rerender();
      toast("error", view.exportError);
    }
  }

  async function exportAsDocx() {
    const r = currentResume();
    const ex = exportMod();
    if (!r || !ex) return;
    view.exportBusy = true;
    view.exportError = "";
    rerender();
    try {
      const pf = computeExportPreflight(r, currentExportOpts());
      if (pf.blockers.length) {
        const proceed = window.confirm(
          "Preflight warning:\n- " + pf.blockers.join("\n- ") + "\n\nContinue export anyway?"
        );
        if (!proceed) {
          view.exportBusy = false;
          rerender();
          return;
        }
      }
      await ex.downloadDocx(r, view.exportTemplate, currentExportOpts());
      toast("success", "Word document downloaded.");
    } catch (err) {
      view.exportError = (err && err.message) || "Word export failed.";
      toast("error", view.exportError);
    } finally {
      view.exportBusy = false;
      rerender();
    }
  }

  // Phase 4: plain-text (.txt) export — most reliable format for ATS systems
  // that re-parse uploaded resumes. Skips the docx/PDF preflight (formatting
  // doesn't apply to plain text).
  function exportAsTxt() {
    const r = currentResume();
    const ex = exportMod();
    if (!r || !ex || typeof ex.downloadTxt !== "function") {
      toast("error", "Plain-text export not available.");
      return;
    }
    try {
      view.exportError = "";
      ex.downloadTxt(r, view.exportTemplate);
      toast("success", "Plain-text resume downloaded — best for ATS uploads.");
    } catch (err) {
      view.exportError = (err && err.message) || "Plain-text export failed.";
      toast("error", view.exportError);
      rerender();
    }
  }
  // Expose for binding from the export panel.
  window.CBV2.resume._exportAsTxt = exportAsTxt;

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  window.CBV2.routes.resume = renderView;
  window.CBV2.afterRender.resume = function () {
    // Reset transient view state on each fresh navigation into the route.
    if (view.mode === "parsing") view.mode = "auto";
    // Clear any stale error banner from a previous failed upload.
    view.parseError = "";
    view.jdError = "";
    view.planError = "";
    // Hydrate tailor state from persistence (Phase 3).
    hydrateTailorView();
    bindAll();
  };

  // R3: document-level handlers for the inline AI suggestion popover.
  // Attached once at module load (not per-render) so they don't stack.
  //   • click outside any open popover/chip → close
  //   • ESC → close
  document.addEventListener("click", function (e) {
    if (!view.bulletPopoverOpenId) return;
    if (!e.target || !e.target.closest) return;
    // Click was inside the popover or on its trigger — let the dedicated
    // editor handler run.
    if (e.target.closest("[data-bullet-ai-popover]")) return;
    if (e.target.closest("[data-bullet-ai-toggle]")) return;
    view.bulletPopoverOpenId = null;
    rerenderEditor();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!view.bulletPopoverOpenId) return;
    view.bulletPopoverOpenId = null;
    rerenderEditor();
  });
})();
