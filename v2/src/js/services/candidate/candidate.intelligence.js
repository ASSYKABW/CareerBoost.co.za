(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.candidateIntel) return;

  const DAY_MS = 86400000;

  const SKILL_ALIAS = {
    js: "javascript",
    ts: "typescript",
    node: "node.js",
    nodejs: "node.js",
    reactjs: "react",
    nextjs: "next.js",
    postgres: "postgresql",
    postgresql: "postgresql",
    mongo: "mongodb",
    k8s: "kubernetes",
    cicd: "ci/cd",
    sprinklers: "sprinkler systems",
    sprinkler: "sprinkler systems"
  };

  const SKILL_LEXICON = new Set([
    "javascript", "typescript", "python", "java", "c#", "c++", "go", "rust", "php", "ruby",
    "react", "next.js", "vue", "angular", "node.js", "express", "nestjs",
    "html", "css", "sass", "tailwind",
    "sql", "postgresql", "mysql", "mongodb", "redis",
    "aws", "gcp", "azure", "docker", "kubernetes", "terraform", "ci/cd",
    "graphql", "rest", "microservices",
    "git", "github", "linux",
    "machine learning", "deep learning", "statistical modeling", "nlp", "tensorflow", "pytorch", "pandas", "numpy",
    "product management", "a/b testing", "analytics",
    "fire protection", "fire detection", "fire alarms", "sprinkler systems", "sprinkler design",
    "suppression systems", "smoke control", "hydraulic calculations", "rational fire design",
    "site assessments", "site visits", "building codes", "compliance reports", "cost estimates",
    "technical knowledge", "technical oversight", "quality assurance", "project engineering",
    "stakeholder communication", "field operations", "asset reliability", "customer service"
  ]);

  const STOPWORDS = new Set([
    "about", "above", "after", "again", "against", "all", "also", "and", "any", "apply",
    "are", "around", "available", "based", "been", "before", "being", "below", "between",
    "both", "candidate", "careerboost", "client", "company", "could", "date", "description",
    "different", "does", "dynamic", "each", "engineer", "engineering", "essential", "etc",
    "every", "field", "first", "from", "gauteng", "have", "high", "hire", "into", "job",
    "join", "looking", "more", "must", "needs", "posted", "profile", "project", "projects",
    "qualified", "ready", "recruiter", "ref", "relevant", "role", "roles", "source", "south",
    "stage", "strong", "summary", "team", "their", "there", "this", "through", "with", "work",
    "working", "years", "your", "africa", "centurion", "pretoria", "johannesburg", "cape", "town"
  ]);

  const DISPLAY_SINGLE_NOISE = new Set([
    "alarm", "alarms", "deep", "detection", "fire", "learning", "machine", "protection",
    "site", "sprinkler", "sprinklers", "system", "systems"
  ]);

  function clamp(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9+#.\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitCsv(value) {
    return (Array.isArray(value) ? value : String(value || "").split(","))
      .map(function (x) { return String(x || "").trim(); })
      .filter(Boolean)
      .slice(0, 40);
  }

  function unique(values, max) {
    const seen = {};
    const out = [];
    (values || []).forEach(function (value) {
      const raw = String(value || "").trim();
      if (!raw) return;
      const key = raw.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(raw);
    });
    return out.slice(0, max || 80);
  }

  function canonicalSkill(raw) {
    const s = normalizeText(raw);
    if (!s) return "";
    return SKILL_ALIAS[s] || s;
  }

  function formatSkill(skill) {
    const s = String(skill || "");
    if (!s) return "";
    if (s === "javascript") return "JavaScript";
    if (s === "typescript") return "TypeScript";
    if (s === "node.js") return "Node.js";
    if (s === "next.js") return "Next.js";
    if (s === "graphql") return "GraphQL";
    if (s === "postgresql") return "PostgreSQL";
    if (s === "ci/cd") return "CI/CD";
    if (s === "nlp") return "NLP";
    if (s === "aws") return "AWS";
    if (s === "gcp") return "GCP";
    return s.split(/\s+/).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function skillTokens(text) {
    return normalizeText(text)
      .split(/\s+/)
      .filter(function (x) { return x && x.length > 1; });
  }

  function extractSkills(text) {
    const toks = skillTokens(text);
    const out = [];
    toks.forEach(function (t, i) {
      const one = canonicalSkill(t);
      const two = i < toks.length - 1 ? canonicalSkill(t + " " + toks[i + 1]) : "";
      const three = i < toks.length - 2 ? canonicalSkill(t + " " + toks[i + 1] + " " + toks[i + 2]) : "";
      if (three && SKILL_LEXICON.has(three)) out.push(three);
      if (two && SKILL_LEXICON.has(two)) out.push(two);
      if (one && SKILL_LEXICON.has(one)) out.push(one);
    });
    return unique(out, 60);
  }

  function profileData() {
    const auth = window.CBV2.auth;
    const user = auth && typeof auth.getUser === "function" ? auth.getUser() : null;
    const profile = window.CBV2.profile && typeof window.CBV2.profile.get === "function"
      ? window.CBV2.profile.get()
      : null;
    const prefs = profile && profile.preferences && typeof profile.preferences === "object" ? profile.preferences : {};
    const personal = prefs.profile && typeof prefs.profile === "object" ? prefs.profile : {};
    const jobPrefs = prefs.jobPreferences && typeof prefs.jobPreferences === "object" ? prefs.jobPreferences : {};
    return { user: user, profile: profile, prefs: prefs, personal: personal, jobPrefs: jobPrefs };
  }

  function storeData() {
    const store = window.CBV2.store;
    const all = store && typeof store.getAll === "function" ? store.getAll() : {};
    const jobSearch = store && typeof store.getJobSearchState === "function"
      ? store.getJobSearchState()
      : (all.jobSearch || {});
    return { store: store, all: all || {}, jobSearch: jobSearch || {} };
  }

  function effectiveRoleProfile(jobSearch, jobPrefs) {
    const storeRp = jobSearch && jobSearch.roleProfile ? jobSearch.roleProfile : {};
    const prefRp = jobPrefs && jobPrefs.roleProfile ? jobPrefs.roleProfile : {};
    return {
      targetTitles: unique([].concat(storeRp.targetTitles || [], prefRp.targetTitles || []), 20),
      mustHaveSkills: unique([].concat(storeRp.mustHaveSkills || [], prefRp.mustHaveSkills || []), 30),
      excludeKeywords: unique([].concat(storeRp.excludeKeywords || [], prefRp.excludeKeywords || []), 30),
      seniority: String(prefRp.seniority || storeRp.seniority || jobPrefs.seniority || "any"),
      strictMode: !!(prefRp.strictMode || storeRp.strictMode || jobPrefs.strictMode)
    };
  }

  function structuredResumeText(structured) {
    if (!structured || typeof structured !== "object") return "";
    const pieces = [];
    ["name", "title", "summary"].forEach(function (key) {
      if (structured[key]) pieces.push(structured[key]);
    });
    if (Array.isArray(structured.skills)) pieces.push(structured.skills.join(" "));
    if (Array.isArray(structured.experience)) {
      structured.experience.forEach(function (exp) {
        pieces.push([exp.role, exp.company, exp.summary].join(" "));
        if (Array.isArray(exp.bullets)) {
          exp.bullets.forEach(function (b) {
            pieces.push(typeof b === "string" ? b : (b && b.text) || "");
          });
        }
      });
    }
    if (Array.isArray(structured.projects)) {
      structured.projects.forEach(function (p) {
        pieces.push([p.name, p.description].join(" "));
      });
    }
    return pieces.join("\n");
  }

  function resumePieces(store, all) {
    const resume = all.resume || {};
    const pieces = [];
    const effectiveBase = store && typeof store.getEffectiveResumeBaseText === "function"
      ? store.getEffectiveResumeBaseText()
      : "";
    pieces.push(effectiveBase || "");
    pieces.push(resume.base || "");
    pieces.push(structuredResumeText(resume.structured));
    pieces.push(JSON.stringify(resume.tailored || {}));
    (resume.savedCVs || []).forEach(function (cv) {
      pieces.push(cv.baseText || "");
      pieces.push(structuredResumeText(cv.structured));
    });
    (resume.careerAssets || []).forEach(function (asset) {
      pieces.push(asset && asset.text ? asset.text : "");
      if (asset && Array.isArray(asset.tags)) pieces.push(asset.tags.join(" "));
    });
    return pieces;
  }

  function daysSince(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / DAY_MS));
  }

  function extractMaxYears(text) {
    const raw = String(text || "");
    let max = 0;
    raw.replace(/(\d+)\s*(?:[-+]\s*(\d+))?\+?\s*(?:years?|yrs?)/gi, function (m, a, b) {
      const n = Math.max(Number(a) || 0, Number(b) || 0);
      if (n > max) max = n;
      return m;
    });
    return max;
  }

  function evidenceFromResume(text, assets) {
    const rows = String(text || "")
      .split(/\r?\n|(?<=\.)\s+(?=[A-Z0-9])/)
      .map(function (x) { return x.replace(/^[\-*•\s]+/, "").trim(); })
      .filter(function (x) { return x.length >= 35; });
    const evidence = [];
    (assets || []).forEach(function (asset) {
      if (!asset || !asset.text) return;
      evidence.push({
        text: String(asset.text || "").trim(),
        source: asset.source || "career-asset",
        tags: Array.isArray(asset.tags) ? asset.tags.slice(0, 8) : [],
        quantified: /(\d+|%|\$|million|thousand|reduced|increased|improved|saved|delivered|led|managed)/i.test(asset.text || "")
      });
    });
    rows.forEach(function (row) {
      if (!/(\d+|%|\$|million|thousand|reduced|increased|improved|saved|delivered|led|managed|built|designed|implemented)/i.test(row)) return;
      evidence.push({
        text: row,
        source: "resume",
        tags: extractSkills(row).slice(0, 5),
        quantified: /(\d+|%|\$|million|thousand)/i.test(row)
      });
    });
    return evidence.slice(0, 40);
  }

  function importantTerms(text, limit) {
    const tokens = normalizeText(text)
      .split(/\s+/)
      .filter(function (word) {
        if (!word || word.length < 3) return false;
        if (STOPWORDS.has(word)) return false;
        if (/^\d+$/.test(word)) return false;
        return true;
      });
    const counts = {};
    tokens.forEach(function (word, i) {
      counts[word] = (counts[word] || 0) + 1;
      const two = i < tokens.length - 1 ? canonicalSkill(word + " " + tokens[i + 1]) : "";
      const three = i < tokens.length - 2 ? canonicalSkill(word + " " + tokens[i + 1] + " " + tokens[i + 2]) : "";
      if (two && SKILL_LEXICON.has(two)) counts[two] = (counts[two] || 0) + 4;
      if (three && SKILL_LEXICON.has(three)) counts[three] = (counts[three] || 0) + 4;
    });
    extractSkills(text).forEach(function (skill) {
      counts[skill] = (counts[skill] || 0) + 8;
    });
    return Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); })
      .slice(0, limit || 24);
  }

  function termInCorpus(term, corpus) {
    const hay = corpus.normalized || "";
    const t = normalizeText(term);
    if (!t) return false;
    const variants = [t];
    variants.push(t.replace(/\bsystems\b/g, "system"));
    variants.push(t.replace(/\bcalculations\b/g, "calculation"));
    variants.push(t.replace(/\bassessments\b/g, "assessment"));
    variants.push(t.replace(/\breports\b/g, "report"));
    variants.push(t.replace(/\bcodes\b/g, "code"));
    variants.push(t.replace(/\balarms\b/g, "alarm"));
    variants.push(t.replace(/\bsprinklers\b/g, "sprinkler"));
    if (/s$/.test(t) && t.length > 4 && !/css$/.test(t)) variants.push(t.slice(0, -1));
    if (variants.some(function (variant) { return variant && hay.indexOf(variant) >= 0; })) return true;
    const parts = t.split(/\s+/).filter(Boolean);
    return parts.length > 1 && parts.every(function (p) { return p.length < 4 || hay.indexOf(p) >= 0; });
  }

  function compactTerms(terms, limit) {
    const raw = (terms || []).map(function (term) { return normalizeText(term); }).filter(Boolean);
    const seen = {};
    const out = [];
    raw.forEach(function (term) {
      if (seen[term]) return;
      const isSingle = term.split(/\s+/).length === 1;
      if (isSingle && DISPLAY_SINGLE_NOISE.has(term)) return;
      if (isSingle && raw.some(function (other) {
        return other !== term && other.split(/\s+/).indexOf(term) >= 0;
      })) return;
      seen[term] = true;
      out.push(term);
    });
    return out.slice(0, limit || 8);
  }

  function trimText(value, max) {
    const str = String(value || "").replace(/\s+/g, " ").trim();
    const limit = typeof max === "number" ? max : 240;
    return str.length > limit ? str.slice(0, limit - 1).replace(/\s+\S*$/, "") + "." : str;
  }

  function formatListForBrief(items, formatter, limit) {
    const list = (items || []).slice(0, limit || 6).map(function (item) {
      return formatter ? formatter(item) : String(item || "");
    }).filter(Boolean);
    return list.length ? list.join(", ") : "none yet";
  }

  function inputJobText(input) {
    if (!input || typeof input !== "object") return "";
    return [
      input.company,
      input.companyName,
      input.role,
      input.targetRole,
      input.job,
      input.jobDescription,
      input.jobPosting,
      input.jd,
      input.description,
      input.focus,
      input.focusAreas
    ].map(function (value) {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        try { return JSON.stringify(value); } catch (_) { return ""; }
      }
      return "";
    }).filter(Boolean).join("\n");
  }

  function summarizeForAi(skill, input) {
    const candidate = buildCandidate();
    const jobText = inputJobText(input);
    const jobTerms = jobText ? compactTerms(importantTerms(jobText, 28), 12) : [];
    const jobMatched = jobTerms.filter(function (term) {
      return termInCorpus(term, candidate.corpus || { normalized: "" });
    });
    const jobMissing = jobTerms.filter(function (term) {
      return !termInCorpus(term, candidate.corpus || { normalized: "" });
    });
    const evidenceItems = (candidate.evidence.items || []).slice(0, 8).map(function (item) {
      return {
        text: trimText(item.text, 260),
        source: item.source || "candidate-record",
        tags: (item.tags || []).slice(0, 5).map(formatSkill),
        quantified: !!item.quantified
      };
    });
    const targetRoles = (candidate.roleProfile.targetTitles || []).slice(0, 6);
    const targetSkills = (candidate.skills.target || []).slice(0, 10).map(formatSkill);
    const matchedTarget = (candidate.skills.matchedTarget || []).slice(0, 8).map(formatSkill);
    const missingTarget = (candidate.skills.missingTarget || []).slice(0, 8).map(formatSkill);
    const topSkills = (candidate.skills.top || []).slice(0, 12).map(formatSkill);
    const gaps = (candidate.gaps || []).slice(0, 6).map(function (gap) {
      return {
        label: gap.label,
        severity: gap.severity || "medium"
      };
    });
    const guardrails = [
      "Use this context to personalize the output, but treat the explicit resume, job description, and user instructions as the source of truth.",
      "Never invent employers, titles, certifications, metrics, dates, tools, or achievements that are not present in the resume, career assets, job text, or user input.",
      "If a target skill is missing, frame it as an honest gap or a topic to prepare, not as claimed experience."
    ];

    const briefLines = [
      "Readiness: " + candidate.scores.readiness + "/100.",
      "Target roles: " + formatListForBrief(targetRoles, null, 6) + ".",
      "Top skills/evidence themes: " + formatListForBrief(topSkills, null, 8) + ".",
      "Matched target evidence: " + formatListForBrief(matchedTarget, null, 6) + ".",
      "Missing target evidence: " + formatListForBrief(missingTarget, null, 6) + ".",
      "Reusable proof points: " + candidate.evidence.count + " total, " + candidate.evidence.quantifiedCount + " quantified.",
      jobTerms.length
        ? "Current job lens matched: " + formatListForBrief(jobMatched.map(formatSkill), null, 6) +
          "; missing or weak: " + formatListForBrief(jobMissing.map(formatSkill), null, 6) + "."
        : ""
    ].filter(Boolean);

    return {
      version: 1,
      skill: skill || "",
      generatedAt: candidate.generatedAt,
      readiness: candidate.scores.readiness,
      identity: {
        name: candidate.identity.name || "",
        headline: candidate.identity.headline || "",
        experienceYears: candidate.identity.experienceYears || 0,
        industries: (candidate.identity.industries || []).slice(0, 6)
      },
      target: {
        roles: targetRoles,
        seniority: candidate.roleProfile.seniority || "any",
        location: candidate.filters.location || "",
        mustHaveSkills: targetSkills,
        matchedSkills: matchedTarget,
        missingSkills: missingTarget
      },
      resume: {
        hasBase: candidate.resume.hasBase,
        hasStructured: candidate.resume.hasStructured,
        hasTailored: candidate.resume.hasTailored,
        savedCvCount: candidate.resume.savedCvCount,
        assetCount: candidate.resume.assetCount,
        freshnessDays: candidate.resume.freshnessDays,
        wordCount: candidate.resume.wordCount
      },
      skills: topSkills,
      evidence: evidenceItems,
      gaps: gaps,
      jobLens: jobTerms.length ? {
        terms: jobTerms.map(formatSkill),
        matched: jobMatched.map(formatSkill),
        missing: jobMissing.map(formatSkill)
      } : null,
      guardrails: guardrails,
      promptBrief: briefLines.join("\n")
    };
  }

  function parseJobNotes(app) {
    const notes = app && app.notes ? app.notes : "";
    const helper = window.CBV2.jobNotes;
    if (helper && typeof helper.parseImportedNotes === "function") {
      const parsed = helper.parseImportedNotes(notes);
      if (parsed) {
        return {
          source: parsed.source || app.jobUrl || "",
          location: parsed.location || "",
          description: parsed.description || parsed.rawDescription || ""
        };
      }
    }
    const source = (String(notes).match(/Source:\s*(.+)/i) || [])[1] || app.jobUrl || "";
    const location = (String(notes).match(/Location:\s*(.+)/i) || [])[1] || "";
    return { source: source, location: location, description: notes || "" };
  }

  function fitBand(score) {
    if (score >= 82) return { label: "High probability", tone: "green", action: "Apply first" };
    if (score >= 70) return { label: "Strong fit", tone: "cyan", action: "Tailor and apply" };
    if (score >= 55) return { label: "Promising", tone: "violet", action: "Improve evidence" };
    if (score >= 40) return { label: "Reach", tone: "warning", action: "Research before applying" };
    return { label: "Low-fit", tone: "rose", action: "Deprioritize" };
  }

  function stageReachedScore(stage) {
    const s = String(stage || "").toLowerCase();
    if (s === "offer") return 100;
    if (s === "interview") return 78;
    if (s === "applied") return 54;
    if (s === "rejected") return 24;
    if (s === "withdrawn") return 18;
    return 36;
  }

  function outcomeMemoryFor(app, apps) {
    const targetTerms = importantTerms((app.role || "") + " " + (app.company || ""), 6);
    const related = (apps || []).filter(function (item) {
      if (!item || item.id === app.id || item.stage === "saved") return false;
      const hay = normalizeText((item.role || "") + " " + (item.company || ""));
      return targetTerms.some(function (term) { return hay.indexOf(normalizeText(term)) >= 0; });
    });
    if (!related.length) return { score: 50, count: 0 };
    const avg = related.reduce(function (sum, item) {
      return sum + stageReachedScore(item.stage);
    }, 0) / related.length;
    return { score: clamp(avg), count: related.length };
  }

  function buildCandidate() {
    const pd = profileData();
    const sd = storeData();
    const all = sd.all || {};
    const resume = all.resume || {};
    const apps = Array.isArray(all.applications) ? all.applications : [];
    const events = Array.isArray(all.events) ? all.events : [];
    const savedJobs = Array.isArray(all.savedJobs) ? all.savedJobs : [];
    const jobSearch = sd.jobSearch || {};
    const roleProfile = effectiveRoleProfile(jobSearch, pd.jobPrefs);
    const filters = Object.assign({}, jobSearch.lastFilters || {}, {
      location: (pd.jobPrefs && pd.jobPrefs.location) || (jobSearch.lastFilters && jobSearch.lastFilters.location) || "",
      remoteOnly: !!((pd.jobPrefs && pd.jobPrefs.remoteOnly) || (jobSearch.lastFilters && jobSearch.lastFilters.remoteOnly))
    });

    const pieces = resumePieces(sd.store, all);
    const profilePieces = [
      pd.profile && pd.profile.full_name,
      pd.profile && pd.profile.headline,
      pd.personal.about,
      splitCsv(pd.personal.skills).join(" "),
      splitCsv(pd.personal.industries).join(" ")
    ];
    const raw = pieces.concat(profilePieces).join("\n");
    const normalized = normalizeText(raw);
    const resumeRaw = pieces.join("\n");
    const assets = Array.isArray(resume.careerAssets) ? resume.careerAssets : [];
    const evidence = evidenceFromResume(resumeRaw, assets);
    const profileSkills = splitCsv(pd.personal.skills).map(canonicalSkill).filter(Boolean);
    const resumeSkills = extractSkills(resumeRaw);
    const targetSkills = roleProfile.mustHaveSkills.map(canonicalSkill).filter(Boolean);
    const topSkills = unique([].concat(profileSkills, resumeSkills, targetSkills), 30);
    const missingTargetSkills = targetSkills.filter(function (skill) {
      return skill && !termInCorpus(skill, { normalized: normalized });
    });
    const matchedTargetSkills = targetSkills.filter(function (skill) {
      return skill && termInCorpus(skill, { normalized: normalized });
    });
    const resumeWordCount = resumeRaw.trim() ? resumeRaw.trim().split(/\s+/).length : 0;
    const freshnessDays = daysSince(resume.updatedAt);
    const experienceYears = Number(pd.personal.experienceYears || extractMaxYears(resumeRaw) || 0) || 0;

    const identityScore = clamp(
      (pd.user && pd.user.email ? 20 : 0) +
      (pd.profile && pd.profile.full_name ? 25 : 0) +
      (pd.profile && pd.profile.headline ? 25 : 0) +
      (pd.personal.about ? 15 : 0) +
      (experienceYears ? 15 : 0)
    );
    const targetScore = clamp(
      (roleProfile.targetTitles.length ? 35 : 0) +
      (roleProfile.mustHaveSkills.length ? 35 : 0) +
      (filters.location ? 15 : 0) +
      (roleProfile.seniority && roleProfile.seniority !== "any" ? 15 : 5)
    );
    const resumeScore = clamp(
      (resumeRaw.trim().length > 80 ? 35 : 0) +
      (resume.structured ? 25 : 0) +
      (resume.tailored ? 15 : 0) +
      ((resume.savedCVs || []).length ? 10 : 0) +
      (freshnessDays == null ? 0 : freshnessDays <= 21 ? 15 : freshnessDays <= 60 ? 8 : 0)
    );
    const evidenceScore = clamp(
      Math.min(40, evidence.length * 5) +
      Math.min(25, evidence.filter(function (x) { return x.quantified; }).length * 8) +
      Math.min(20, topSkills.length * 2) +
      (assets.length ? 15 : 0)
    );
    const workflowScore = clamp(
      Math.min(35, apps.length * 7) +
      Math.min(20, savedJobs.length * 5) +
      Math.min(25, events.length * 5) +
      (apps.some(function (a) { return a.stage === "interview"; }) ? 20 : 0)
    );
    const readinessScore = clamp(
      identityScore * 0.18 +
      targetScore * 0.22 +
      resumeScore * 0.24 +
      evidenceScore * 0.22 +
      workflowScore * 0.14
    );

    const gaps = [];
    if (!roleProfile.targetTitles.length) gaps.push({ id: "target_roles", label: "Add target roles", href: "#/settings?tab=job-preferences", severity: "high" });
    if (!roleProfile.mustHaveSkills.length) gaps.push({ id: "target_skills", label: "Add must-have skills", href: "#/settings?tab=job-preferences", severity: "medium" });
    if (resumeRaw.trim().length <= 80) gaps.push({ id: "resume", label: "Add or build your resume", href: "#/resume", severity: "high" });
    if (!resume.structured) gaps.push({ id: "structured_resume", label: "Structure your resume in Resume Lab", href: "#/resume", severity: "medium" });
    if (evidence.length < 5) gaps.push({ id: "evidence", label: "Save more proof bullets and career assets", href: "#/resume", severity: "high" });
    if (missingTargetSkills.length) gaps.push({ id: "missing_skills", label: "Add evidence for " + missingTargetSkills.slice(0, 3).map(formatSkill).join(", "), href: "#/resume", severity: "high" });
    if (freshnessDays != null && freshnessDays > 45) gaps.push({ id: "freshness", label: "Refresh stale resume evidence", href: "#/resume", severity: "medium" });

    const nextActions = gaps.slice(0, 4).map(function (gap) {
      return { label: gap.label, href: gap.href, severity: gap.severity };
    });
    if (!nextActions.length && apps.some(function (a) { return a.stage === "saved"; })) {
      nextActions.push({ label: "Tailor a resume for your strongest saved role", href: "#/analytics", severity: "medium" });
    }
    if (!nextActions.length) {
      nextActions.push({ label: "Keep adding role outcomes so analytics can learn", href: "#/applications", severity: "low" });
    }

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      identity: {
        email: pd.user && pd.user.email ? pd.user.email : "",
        name: pd.profile && pd.profile.full_name ? pd.profile.full_name : "",
        headline: pd.profile && pd.profile.headline ? pd.profile.headline : "",
        experienceYears: experienceYears,
        industries: splitCsv(pd.personal.industries),
        links: pd.personal.links || {}
      },
      roleProfile: roleProfile,
      filters: filters,
      resume: {
        hasBase: resumeRaw.trim().length > 80,
        hasStructured: !!resume.structured,
        hasTailored: !!resume.tailored,
        savedCvCount: (resume.savedCVs || []).length,
        assetCount: assets.length,
        freshnessDays: freshnessDays,
        wordCount: resumeWordCount
      },
      skills: {
        profile: unique(profileSkills, 30),
        resume: unique(resumeSkills, 30),
        target: unique(targetSkills, 30),
        matchedTarget: unique(matchedTargetSkills, 30),
        missingTarget: unique(missingTargetSkills, 30),
        top: unique(topSkills, 30)
      },
      evidence: {
        count: evidence.length,
        quantifiedCount: evidence.filter(function (x) { return x.quantified; }).length,
        items: evidence
      },
      scores: {
        readiness: readinessScore,
        identity: identityScore,
        target: targetScore,
        resume: resumeScore,
        evidence: evidenceScore,
        workflow: workflowScore
      },
      gaps: gaps,
      nextActions: nextActions,
      corpus: {
        raw: raw,
        normalized: normalized,
        hasResume: resumeRaw.trim().length > 80,
        hasStructured: !!resume.structured,
        hasTailored: !!resume.tailored,
        experienceYears: experienceYears,
        skills: unique(topSkills, 30),
        evidenceCount: evidence.length
      }
    };
  }

  function scoreApplicationFit(app, apps, candidate) {
    candidate = candidate || buildCandidate();
    const parsed = parseJobNotes(app || {});
    const jobText = [
      (app && app.company) || "",
      (app && app.role) || "",
      (app && app.nextAction) || "",
      parsed.location || "",
      parsed.description || "",
      (app && app.notes) || ""
    ].join("\n");
    const corpus = candidate.corpus || { normalized: "" };
    const roleTerms = importantTerms((app && app.role) || "", 8);
    const jobTerms = importantTerms(jobText, 30);
    const matched = jobTerms.filter(function (term) { return termInCorpus(term, corpus); });
    const missing = jobTerms.filter(function (term) { return !termInCorpus(term, corpus); });
    const displayedMatched = compactTerms(matched, 8);
    const displayedMissing = compactTerms(missing, 8);
    const titleMatched = roleTerms.filter(function (term) { return termInCorpus(term, corpus); });
    const requiredYears = extractMaxYears(jobText);
    const candidateYears = Number(candidate.identity && candidate.identity.experienceYears) || extractMaxYears(corpus.raw || "");
    const outcome = outcomeMemoryFor(app || {}, apps || []);
    const hasDescription = (parsed.description || "").trim().length > 120;

    const skillScore = jobTerms.length ? clamp((matched.length / jobTerms.length) * 100) : 45;
    const titleScore = roleTerms.length ? clamp((titleMatched.length / roleTerms.length) * 100) : 52;
    const experienceScore = requiredYears
      ? clamp(Math.min(1.15, candidateYears / requiredYears) * 86)
      : (candidate.resume && candidate.resume.hasBase ? 66 : 34);
    const evidenceScore = clamp(
      (candidate.resume && candidate.resume.hasBase ? 26 : 0) +
      (candidate.resume && candidate.resume.hasStructured ? 18 : 0) +
      (candidate.resume && candidate.resume.hasTailored ? 12 : 0) +
      (Math.min(1, matched.length / 8) * 24) +
      (Math.min(1, (candidate.evidence && candidate.evidence.count || 0) / 8) * 20)
    );
    const roleProfileScore = clamp(
      (candidate.roleProfile && candidate.roleProfile.targetTitles && candidate.roleProfile.targetTitles.length ? 38 : 0) +
      (candidate.skills && candidate.skills.matchedTarget && candidate.skills.matchedTarget.length ? Math.min(42, candidate.skills.matchedTarget.length * 12) : 0) +
      (candidate.skills && candidate.skills.missingTarget && candidate.skills.missingTarget.length ? -12 : 12)
    );
    const readinessScore = clamp(
      (hasDescription ? 30 : 12) +
      (app && app.jobUrl ? 14 : 0) +
      (app && app.nextAction ? 12 : 0) +
      (candidate.resume && candidate.resume.hasBase ? 18 : 0) +
      (candidate.evidence && candidate.evidence.count >= 5 ? 16 : 0) +
      (parsed.source ? 10 : 0)
    );

    let score = clamp(
      (skillScore * 0.28) +
      (experienceScore * 0.18) +
      (titleScore * 0.14) +
      (evidenceScore * 0.16) +
      (roleProfileScore * 0.10) +
      (readinessScore * 0.08) +
      (outcome.score * 0.06)
    );
    if (!(candidate.resume && candidate.resume.hasBase)) score = Math.min(score, 48);
    if (!hasDescription) score = Math.min(score, 64);

    const strengths = [];
    const risks = [];
    const actions = [];
    if (displayedMatched.length) strengths.push("Resume evidence overlaps with " + displayedMatched.slice(0, 4).map(formatSkill).join(", ") + ".");
    if (candidate.evidence && candidate.evidence.count >= 5) strengths.push("Candidate evidence bank has " + candidate.evidence.count + " reusable proof points.");
    if (candidateYears && requiredYears) strengths.push("Experience signal: profile shows about " + candidateYears + " years against a " + requiredYears + "-year ask.");
    if (outcome.count) strengths.push("Past pipeline data includes " + outcome.count + " related role signal" + (outcome.count === 1 ? "" : "s") + ".");
    if (!(candidate.resume && candidate.resume.hasBase)) risks.push("No strong resume baseline is available, so confidence is capped.");
    if (displayedMissing.length) risks.push("Missing or weak resume evidence: " + displayedMissing.slice(0, 5).map(formatSkill).join(", ") + ".");
    if (candidate.skills && candidate.skills.missingTarget && candidate.skills.missingTarget.length) {
      risks.push("Target-profile evidence gap: " + candidate.skills.missingTarget.slice(0, 4).map(formatSkill).join(", ") + ".");
    }
    if (!hasDescription) risks.push("Job description capture is thin, so the model has less evidence.");
    actions.push(score >= 70 ? "Tailor the resume and apply while the role is fresh." : "Strengthen the resume evidence before applying.");
    if (displayedMissing.length) actions.push("Add proof for " + displayedMissing.slice(0, 3).map(formatSkill).join(", ") + " if it is true to your experience.");
    actions.push("Use Cover Letters to frame the strongest matched evidence.");

    return {
      app: app,
      score: score,
      band: fitBand(score),
      subScores: {
        skills: skillScore,
        experience: experienceScore,
        role: titleScore,
        evidence: evidenceScore,
        readiness: readinessScore
      },
      matched: displayedMatched,
      missing: displayedMissing,
      strengths: strengths.slice(0, 3),
      risks: risks.slice(0, 3),
      actions: actions.slice(0, 3),
      confidence: (candidate.resume && candidate.resume.hasBase && hasDescription) ? "Moderate" : "Low",
      requiredYears: requiredYears,
      candidateYears: candidateYears,
      hasDescription: hasDescription
    };
  }

  function scoreSavedApplications(apps) {
    const list = Array.isArray(apps) ? apps : [];
    const saved = list.filter(function (app) {
      return String((app && app.stage) || "").toLowerCase() === "saved";
    });
    const candidate = buildCandidate();
    const scored = saved.map(function (app) {
      return scoreApplicationFit(app, list, candidate);
    }).sort(function (a, b) { return b.score - a.score; });
    const average = scored.length
      ? Math.round(scored.reduce(function (sum, item) { return sum + item.score; }, 0) / scored.length)
      : 0;
    return { saved: saved, scored: scored, average: average, candidate: candidate };
  }

  window.CBV2.candidateIntel = {
    build: buildCandidate,
    getCandidateCorpus: function () { return buildCandidate().corpus; },
    scoreApplicationFit: scoreApplicationFit,
    scoreSavedApplications: scoreSavedApplications,
    summarizeForAi: summarizeForAi,
    extractSkills: extractSkills,
    formatSkill: formatSkill,
    importantTerms: importantTerms,
    termInCorpus: termInCorpus
  };
})();
