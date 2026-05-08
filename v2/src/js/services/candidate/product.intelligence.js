(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.productIntel && window.CBV2.productIntel.version >= 1) return;

  const DAY_MS = 86400000;
  const STOPWORDS = new Set([
    "about", "after", "again", "against", "all", "also", "and", "any", "apply",
    "are", "based", "been", "before", "being", "both", "candidate", "careerboost",
    "company", "could", "date", "description", "does", "each", "engineer",
    "engineering", "every", "field", "from", "have", "into", "job", "join",
    "looking", "more", "must", "needs", "posted", "profile", "project", "role",
    "roles", "source", "south", "stage", "summary", "team", "their", "this",
    "through", "with", "work", "years", "your"
  ]);

  function clamp(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function text(value) {
    return String(value || "").trim();
  }

  function normalize(value) {
    return text(value)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9+#.\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function unique(values, limit) {
    const seen = {};
    const out = [];
    (values || []).forEach(function (value) {
      const raw = text(value);
      const key = raw.toLowerCase();
      if (!raw || seen[key]) return;
      seen[key] = true;
      out.push(raw);
    });
    return out.slice(0, limit || 80);
  }

  function wordCount(value) {
    return text(value).split(/\s+/).filter(Boolean).length;
  }

  function hasMetric(value) {
    return /(\d+|%|\$|million|thousand|reduced|increased|improved|saved|delivered|led|managed|designed|implemented)/i.test(value || "");
  }

  function ageDays(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS));
  }

  function getStoreAll() {
    const store = window.CBV2.store;
    return store && typeof store.getAll === "function" ? (store.getAll() || {}) : {};
  }

  function getApplications(all) {
    if (all && Array.isArray(all.applications)) return all.applications;
    const store = window.CBV2.store;
    return store && typeof store.getApplications === "function" ? store.getApplications() : [];
  }

  function parseJob(app) {
    const notes = text(app && app.notes);
    const helper = window.CBV2.jobNotes;
    let parsed = null;
    if (helper && typeof helper.parseImportedNotes === "function") {
      parsed = helper.parseImportedNotes(notes) || null;
    }
    if (!parsed) {
      const marker = notes.match(/Job description snapshot\s*:\s*([\s\S]*)$/i);
      parsed = {
        intro: "",
        source: ((notes.match(/^Source\s*:\s*(.+)$/im) || [])[1] || text(app && app.jobUrl)),
        location: ((notes.match(/^Location\s*:\s*(.+)$/im) || [])[1] || text(app && app.location)),
        description: marker ? marker[1].trim() : notes
      };
    }
    return {
      source: text(parsed.source || (app && app.jobUrl)),
      location: text(parsed.location || (app && app.location)),
      description: text(parsed.description || notes),
      intro: text(parsed.intro)
    };
  }

  function candidateCorpus() {
    const intel = window.CBV2.candidateIntel;
    if (intel && typeof intel.getCandidateCorpus === "function") {
      const c = intel.getCandidateCorpus() || {};
      return {
        raw: text(c.raw),
        normalized: c.normalized || normalize(c.raw),
        hasResume: !!c.hasResume,
        hasStructured: !!c.hasStructured,
        hasTailored: !!c.hasTailored
      };
    }
    const all = getStoreAll();
    const resume = all.resume || {};
    const pieces = [
      resume.base || "",
      JSON.stringify(resume.structured || {}),
      JSON.stringify(resume.tailored || {})
    ];
    (resume.savedCVs || []).forEach(function (cv) {
      pieces.push(cv.baseText || "");
      pieces.push(JSON.stringify(cv.structured || {}));
    });
    (resume.careerAssets || []).forEach(function (asset) {
      pieces.push(asset && asset.text ? asset.text : "");
    });
    const raw = pieces.join("\n");
    return {
      raw: raw,
      normalized: normalize(raw),
      hasResume: raw.trim().length > 80,
      hasStructured: !!resume.structured,
      hasTailored: !!resume.tailored
    };
  }

  function importantTerms(value, limit) {
    const intel = window.CBV2.candidateIntel;
    if (intel && typeof intel.importantTerms === "function") {
      return intel.importantTerms(value, limit || 18);
    }
    const counts = {};
    normalize(value).split(/\s+/).forEach(function (word) {
      if (!word || word.length < 4 || STOPWORDS.has(word) || /^\d+$/.test(word)) return;
      counts[word] = (counts[word] || 0) + 1;
    });
    return Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); })
      .slice(0, limit || 18);
  }

  function termInCorpus(term, corpus) {
    const intel = window.CBV2.candidateIntel;
    if (intel && typeof intel.termInCorpus === "function") {
      return intel.termInCorpus(term, corpus);
    }
    const hay = corpus && corpus.normalized ? corpus.normalized : "";
    const t = normalize(term);
    if (!t) return false;
    if (hay.indexOf(t) >= 0) return true;
    const parts = t.split(/\s+/).filter(Boolean);
    return parts.length > 1 && parts.every(function (part) {
      return part.length < 4 || hay.indexOf(part) >= 0;
    });
  }

  function formatTerm(term) {
    const intel = window.CBV2.candidateIntel;
    if (intel && typeof intel.formatSkill === "function") return intel.formatSkill(term);
    return text(term).split(/\s+/).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function jobFitTerms(app, corpus) {
    const job = parseJob(app);
    const terms = importantTerms([app && app.role, job.description, app && app.nextAction].join("\n"), 18);
    const matched = [];
    const missing = [];
    terms.forEach(function (term) {
      if (termInCorpus(term, corpus)) matched.push(term);
      else missing.push(term);
    });
    return {
      job: job,
      terms: terms,
      matched: unique(matched, 8),
      missing: unique(missing, 8)
    };
  }

  function sourceRowsFromIntel(session) {
    const out = [];
    const pack = session && session.intelPackEnvelope && session.intelPackEnvelope.data;
    if (pack && Array.isArray(pack.citedInsights)) {
      pack.citedInsights.forEach(function (row) {
        if (!row || !row.url) return;
        out.push({
          title: text(row.sourceTitle || "Source"),
          url: text(row.url),
          insight: text(row.insight),
          kind: "cited"
        });
      });
    }
    if (pack && Array.isArray(pack.recommendedReads)) {
      pack.recommendedReads.forEach(function (row) {
        if (!row || !row.url) return;
        out.push({
          title: text(row.title || "Recommended read"),
          url: text(row.url),
          insight: text(row.reason),
          kind: "read"
        });
      });
    }
    if (session && Array.isArray(session.hits)) {
      session.hits.forEach(function (row) {
        if (!row || !row.url) return;
        out.push({
          title: text(row.title || "Public result"),
          url: text(row.url),
          insight: text(row.snippet),
          kind: "search"
        });
      });
    }
    const seen = {};
    return out.filter(function (row) {
      const key = row.url.toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, 8);
  }

  function interviewPrep(target, opts) {
    opts = opts || {};
    const all = opts.all || getStoreAll();
    const interview = all.interview || {};
    const app = opts.app || (target && target.app) || target || {};
    const corpus = opts.candidate || candidateCorpus();
    const fit = jobFitTerms(app, corpus);
    const role = text((target && target.role) || app.role || "the role");
    const company = text((target && target.company) || app.company || "the company");
    const stage = text((target && target.stage) || (opts.form && opts.form.stage) || "first");
    const intelSession = opts.intelSession || interview.intelSession || null;
    const mockDebrief = opts.mockDebrief || (interview.mockSession && interview.mockSession.debrief) || null;
    const sources = sourceRowsFromIntel(intelSession);
    const pack = intelSession && intelSession.intelPackEnvelope && intelSession.intelPackEnvelope.data;
    const sourceBacked = sources.some(function (row) { return row.kind === "cited" || row.kind === "read"; });
    const questionThemes = pack && Array.isArray(pack.suggestedQuestionThemes)
      ? pack.suggestedQuestionThemes.slice(0, 6)
      : [];
    const debriefGaps = mockDebrief && mockDebrief.data && Array.isArray(mockDebrief.data.topGaps)
      ? mockDebrief.data.topGaps.slice(0, 4)
      : [];

    const questionBank = unique([
      "Walk me through your experience that best proves you can succeed as " + role + ".",
      "Why " + company + ", and why this role now?",
      "Tell me about a difficult stakeholder or delivery challenge and how you handled it.",
      "Which result in your resume would you want this interviewer to remember?",
      "What would you need to learn quickly in your first 30 days?",
      "How do you prioritize when quality, speed, and limited information collide?"
    ].concat(fit.matched.slice(0, 3).map(function (term) {
      return "Give a concrete example of your work with " + formatTerm(term) + ".";
    })).concat(fit.missing.slice(0, 3).map(function (term) {
      return "If asked about " + formatTerm(term) + ", what honest adjacent experience can you explain?";
    })).concat(questionThemes), 12);

    const likelyProcess = [
      {
        name: "Recruiter screen",
        focus: "Motivation, availability, compensation/logistics, communication clarity.",
        readiness: stage === "screen" ? 78 : 62
      },
      {
        name: "Hiring manager or technical round",
        focus: "Role depth, examples, judgement, and how your past work maps to this job.",
        readiness: fit.matched.length ? 76 : 48
      },
      {
        name: "Evidence validation",
        focus: "Specific achievements, metrics, tradeoffs, failures, and lessons learned.",
        readiness: corpus.hasResume ? 72 : 38
      },
      {
        name: "Final decision",
        focus: "Team fit, risks, references, follow-up questions, and confidence to hire.",
        readiness: mockDebrief ? 80 : 46
      }
    ];

    const weakDrills = unique([]
      .concat(fit.missing.slice(0, 4).map(function (term) {
        return "Prepare one truthful STAR example that touches " + formatTerm(term) + ", or state the learning plan clearly.";
      }))
      .concat(debriefGaps.map(function (gap) {
        return "Redo the weak-area answer: " + gap;
      }))
      .concat(corpus.hasResume ? [] : ["Add resume context so the mock interviewer can ask evidence-based follow-ups."])
      .concat(sourceBacked ? [] : ["Run company research and capture at least three source-backed signals before the mock."])
      .concat(["Practice a 60-second opening pitch, one failure story, and three smart questions for the interviewer."]),
      7
    );

    return {
      company: company,
      role: role,
      sourceConfidence: sourceBacked ? "Source-backed" : (fit.job.description.length > 160 ? "Posting-based" : "Needs research"),
      sources: sources,
      likelyProcess: likelyProcess,
      questionBank: questionBank,
      weakDrills: weakDrills,
      matched: fit.matched,
      missing: fit.missing,
      mockRubric: [
        { label: "Specific evidence", weight: 30, check: "Uses real projects, scope, numbers, or constraints." },
        { label: "Role alignment", weight: 25, check: "Connects answers to the job's core responsibilities." },
        { label: "Clarity under pressure", weight: 25, check: "Answers directly, then adds context." },
        { label: "Self-awareness", weight: 20, check: "Names gaps honestly and explains the learning plan." }
      ],
      recommendedReads: pack && Array.isArray(pack.recommendedReads) ? pack.recommendedReads.slice(0, 5) : [],
      processOverview: pack && pack.processOverview ? text(pack.processOverview) : ""
    };
  }

  function structuredText(resume) {
    if (!resume || typeof resume !== "object") return "";
    const pieces = [];
    if (resume.header) pieces.push([resume.header.name, resume.header.title, resume.header.email, resume.header.phone, resume.header.location].join(" "));
    pieces.push(resume.summary || "");
    (resume.experience || []).forEach(function (exp) {
      pieces.push([exp.role, exp.company, exp.location, exp.startDate, exp.endDate].join(" "));
      (exp.bullets || []).forEach(function (b) { pieces.push(typeof b === "string" ? b : (b && b.text) || ""); });
    });
    const groups = resume.skills && Array.isArray(resume.skills.groups) ? resume.skills.groups : [];
    groups.forEach(function (g) { pieces.push([g.label].concat(g.items || []).join(" ")); });
    (resume.projects || []).forEach(function (p) { pieces.push([p.name, p.description].join(" ")); });
    return pieces.join("\n");
  }

  function resumeLab(resume, opts) {
    opts = opts || {};
    const all = opts.all || getStoreAll();
    const r = resume || (all.resume && all.resume.structured) || null;
    const health = opts.health || null;
    const savedCVs = (all.resume && Array.isArray(all.resume.savedCVs)) ? all.resume.savedCVs : [];
    const raw = text((r && r.rawText) || (all.resume && all.resume.base) || "");
    const current = structuredText(r);
    const summary = text(r && r.summary);
    const bullets = [];
    (r && r.experience || []).forEach(function (exp) {
      (exp.bullets || []).forEach(function (b) {
        bullets.push(typeof b === "string" ? b : (b && b.text) || "");
      });
    });
    const quantified = bullets.filter(hasMetric).length;
    const long = bullets.filter(function (b) { return text(b).length > 220; }).length;
    const checks = [
      { label: "Contact header is complete", ok: !!(r && r.header && r.header.name && r.header.email) },
      { label: "Professional summary is recruiter-ready", ok: summary.length >= 90 },
      { label: "Experience section has achievement bullets", ok: bullets.length >= 6 },
      { label: "At least three bullets show measurable proof", ok: quantified >= 3 },
      { label: "No bullets are too long for scanning", ok: long === 0 },
      { label: "ATS score is 80+", ok: !health || !health.ats || health.ats.score >= 80 },
      { label: "Role match is checked against a real JD", ok: !health || health.roleMatch === null ? false : health.roleMatch >= 65 }
    ];
    const readyCount = checks.filter(function (c) { return c.ok; }).length;
    const versions = [{ id: "current", name: "Live editor", score: health ? health.score : readyCount * 12, source: "current" }]
      .concat(savedCVs.slice(0, 5).map(function (cv) {
        const age = ageDays(cv.updatedAt || cv.createdAt);
        return {
          id: cv.id,
          name: cv.name || "Saved CV",
          score: clamp(58 + (cv.structured ? 22 : 0) + (cv.baseText && cv.baseText.length > 800 ? 12 : 0) - Math.min(14, age == null ? 0 : age / 14)),
          source: cv.source || "saved",
          updatedAt: cv.updatedAt || cv.createdAt || ""
        };
      }));
    return {
      readiness: clamp(health ? health.score : (readyCount / checks.length) * 100),
      readyChecks: checks,
      readyCount: readyCount,
      versionCount: savedCVs.length,
      versions: versions,
      beforeAfter: {
        beforeLabel: raw ? "Original source" : "Before",
        before: raw ? raw.slice(0, 420) : "No original source text is saved yet.",
        afterLabel: "Current professional summary",
        after: summary || current.slice(0, 420) || "No structured resume content yet.",
        improvements: unique([
          raw && current ? "Original content is now structured into editable sections." : "",
          quantified ? quantified + " quantified proof point" + (quantified === 1 ? "" : "s") + " detected." : "",
          savedCVs.length ? savedCVs.length + " reusable CV snapshot" + (savedCVs.length === 1 ? "" : "s") + " saved." : "",
          health && health.roleMatch !== null ? "Role match is currently " + health.roleMatch + "%." : "Analyze a JD to expose role-specific gaps."
        ], 4)
      },
      diagnostics: [
        { label: "Completeness", value: health && health.comp ? health.comp.score : clamp(readyCount * 14) },
        { label: "ATS health", value: health && health.ats ? health.ats.score : 0 },
        { label: "Evidence", value: bullets.length ? clamp((quantified / Math.max(1, bullets.length)) * 100) : 0 },
        { label: "Role match", value: health && health.roleMatch !== null ? health.roleMatch : 0 }
      ],
      nextAction: checks.find(function (c) { return !c.ok; }) || { label: "Save a final version and export", ok: true }
    };
  }

  function coverStudio(state, opts) {
    opts = opts || {};
    const subject = text(opts.subject || (state && state.subject));
    const body = text(opts.body || (state && state.body));
    const company = text(opts.company);
    const role = text(opts.role);
    const variants = (state && Array.isArray(state.variants) ? state.variants : []).slice(0, 20);
    const rolePacks = (state && Array.isArray(state.rolePacks) ? state.rolePacks : []).slice(0, 20);
    const sentLog = (state && Array.isArray(state.sentLog) ? state.sentLog : []).slice(0, 20);
    const lowerBody = body.toLowerCase();
    const paras = body ? body.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean) : [];
    const checks = [
      { label: "Company is named", ok: !company || lowerBody.indexOf(company.toLowerCase()) >= 0 },
      { label: "Role is named", ok: !role || lowerBody.indexOf(role.toLowerCase()) >= 0 },
      { label: "Evidence or metric appears", ok: hasMetric(body) },
      { label: "Readable length", ok: wordCount(body) >= 120 && wordCount(body) <= 390 },
      { label: "Clean paragraph structure", ok: paras.length >= 3 && !paras.some(function (p) { return p.length > 800; }) },
      { label: "Closing is present", ok: /(thank you|looking forward|sincerely|best regards|kind regards)/i.test(body) }
    ];
    const score = clamp((checks.filter(function (c) { return c.ok; }).length / checks.length) * 100);
    const scoredVariants = variants.map(function (v) {
      return {
        id: v.id,
        label: v.label || "Variant",
        template: v.template || "template",
        score: coverStudio({ variants: [], rolePacks: [], sentLog: [] }, {
          subject: v.subject,
          body: v.body,
          company: company,
          role: role
        }).quality.score,
        updatedAt: v.updatedAt || v.createdAt || ""
      };
    }).sort(function (a, b) { return b.score - a.score; });
    return {
      quality: {
        score: score,
        band: score >= 85 ? "Submit-ready" : score >= 70 ? "Needs polish" : "Needs work",
        checks: checks,
        issues: checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.label; }),
        nextAction: (checks.find(function (c) { return !c.ok; }) || { label: "Mark sent and track outcome" }).label
      },
      variants: scoredVariants,
      rolePacks: rolePacks.map(function (p) {
        const filled = [p.role, p.tone, p.length, p.strengths].filter(function (x) { return text(x); }).length;
        return {
          id: p.id,
          name: p.name || "Role Pack",
          role: p.role || "",
          completeness: clamp((filled / 4) * 100),
          tone: p.tone || "professional"
        };
      }),
      sent: sentLog,
      bestVariant: scoredVariants[0] || null
    };
  }

  function analyticsRecommendations(apps, opts) {
    opts = opts || {};
    const all = opts.all || getStoreAll();
    const list = apps || getApplications(all);
    const recs = [];
    const candidate = candidateCorpus();
    const scored = window.CBV2.candidateIntel && typeof window.CBV2.candidateIntel.scoreSavedApplications === "function"
      ? window.CBV2.candidateIntel.scoreSavedApplications(list)
      : null;
    const top = scored && scored.scored && scored.scored[0];
    const saved = list.filter(function (a) { return text(a.stage).toLowerCase() === "saved"; });
    const applied = list.filter(function (a) { return text(a.stage).toLowerCase() === "applied" || text(a.stage).toLowerCase() === "interview"; });
    const thinSource = saved.find(function (app) {
      const job = parseJob(app);
      return !job.source || job.description.length < 160;
    });
    const stale = applied.map(function (app) {
      const hist = Array.isArray(app.stageHistory) && app.stageHistory.length ? app.stageHistory[app.stageHistory.length - 1] : null;
      return { app: app, days: ageDays((hist && hist.at) || app.appliedAt) || 0 };
    }).filter(function (row) { return row.days >= 7; }).sort(function (a, b) { return b.days - a.days; })[0];
    if (top) {
      recs.push({
        title: "Apply priority: " + (top.app.company || "Saved role"),
        reason: "Highest saved-role probability at " + top.score + "/100.",
        evidence: (top.strengths || []).concat(top.risks || []).slice(0, 3),
        action: top.score >= 70 ? "Tailor resume and apply first" : "Close evidence gaps before applying",
        href: "#/resume",
        appId: top.app.id,
        tone: top.score >= 70 ? "green" : "warning"
      });
    }
    if (thinSource) {
      recs.push({
        title: "Improve source truth for " + (thinSource.company || "a saved role"),
        reason: "The job capture is missing a source URL or a full description, which lowers confidence.",
        evidence: ["Probability, resume tailoring, cover letters, and interview prep all depend on a complete posting."],
        action: "Open the application and attach the real posting",
        appId: thinSource.id,
        tone: "warning"
      });
    }
    if (!candidate.hasResume) {
      recs.push({
        title: "Build the candidate evidence base",
        reason: "Probability scoring is capped when no strong resume baseline is available.",
        evidence: ["Add a resume, structure it, and save reusable career assets."],
        action: "Open Resume Lab",
        href: "#/resume",
        tone: "rose"
      });
    }
    if (stale) {
      recs.push({
        title: "Follow up: " + (stale.app.company || "application"),
        reason: "This role has been waiting " + stale.days + " days in " + (stale.app.stage || "pipeline") + ".",
        evidence: ["Stale stages reduce pipeline clarity and make next actions harder to trust."],
        action: "Send follow-up or update stage",
        appId: stale.app.id,
        tone: "cyan"
      });
    }
    if (!recs.length) {
      recs.push({
        title: "Keep the system current",
        reason: "No urgent analytics risks are visible right now.",
        evidence: ["Continue saving source-backed roles, moving stages, and logging outcomes."],
        action: "Review pipeline",
        href: "#/applications",
        tone: "green"
      });
    }
    return recs.slice(0, 5);
  }

  window.CBV2.productIntel = {
    version: 1,
    interviewPrep: interviewPrep,
    resumeLab: resumeLab,
    coverStudio: coverStudio,
    analyticsRecommendations: analyticsRecommendations,
    parseJob: parseJob,
    importantTerms: importantTerms,
    termInCorpus: termInCorpus
  };
})();
