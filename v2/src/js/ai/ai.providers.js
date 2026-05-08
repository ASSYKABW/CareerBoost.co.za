(function () {
  function withTimeout(promise, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error("AI request timed out"));
      }, timeoutMs);
      promise
        .then(function (result) {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(function (error) {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  const STOPWORDS = new Set([
    "the","a","an","and","or","of","in","on","at","to","for","with","by","from","as","is","are","be","was","were","you","your","we","our","i","me","my","they","them","their","this","that","these","those","it","its","will","have","has","had","but","not","no","yes","so","if","then","than","also","just","too","very","more","most","less","least","any","all","some","each","per","via","into","out","up","down","over","under"
  ]);

  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9+.#\-\s]/g, " ")
      .split(/\s+/)
      .filter(function (w) {
        return w && w.length > 1 && !STOPWORDS.has(w);
      });
  }

  function uniqueTokens(text, limit) {
    const seen = new Set();
    const out = [];
    tokenize(text).forEach(function (t) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    });
    return typeof limit === "number" ? out.slice(0, limit) : out;
  }

  function getCandidateContext(input) {
    const ctx = input && input.__aiContext;
    return ctx && ctx.candidate && typeof ctx.candidate === "object" ? ctx.candidate : null;
  }

  function contextList(candidate, keyPath, limit) {
    let value = candidate || {};
    keyPath.split(".").forEach(function (key) {
      value = value && typeof value === "object" ? value[key] : null;
    });
    const list = Array.isArray(value) ? value : [];
    const out = [];
    list.forEach(function (item) {
      const text = String(item || "").trim();
      if (!text) return;
      if (out.some(function (x) { return x.toLowerCase() === text.toLowerCase(); })) return;
      out.push(text);
    });
    return typeof limit === "number" ? out.slice(0, limit) : out;
  }

  function contextEvidence(candidate, limit) {
    const rows = candidate && Array.isArray(candidate.evidence) ? candidate.evidence : [];
    return rows
      .map(function (item) {
        return String((item && item.text) || "").trim();
      })
      .filter(Boolean)
      .slice(0, typeof limit === "number" ? limit : 4);
  }

  function computeJobMatch(resumeText, job) {
    const resumeTokens = new Set(tokenize(resumeText || ""));
    const jobTagTokens = (job.tags || []).map(function (t) { return String(t).toLowerCase(); });
    const jobDescTokens = tokenize((job.title || "") + " " + (job.descriptionText || ""));
    const jobKeyTokens = new Set(jobTagTokens.concat(jobDescTokens));

    if (!resumeTokens.size || !jobKeyTokens.size) {
      return {
        score: 50,
        fitSummary: "Resume not provided or too short — add content in Resume Lab to enable rich match scoring.",
        reasons: ["Baseline score applied."],
        missingSkills: jobTagTokens.slice(0, 4)
      };
    }

    let matched = 0;
    const missing = [];
    const matchedList = [];
    jobKeyTokens.forEach(function (t) {
      if (resumeTokens.has(t)) {
        matched += 1;
        matchedList.push(t);
      }
    });
    jobTagTokens.forEach(function (t) {
      if (!resumeTokens.has(t)) missing.push(t);
    });

    const overlap = matched / Math.max(1, jobKeyTokens.size);
    const tagBoost = jobTagTokens.length
      ? jobTagTokens.filter(function (t) { return resumeTokens.has(t); }).length / jobTagTokens.length
      : 0;
    const raw = overlap * 0.55 + tagBoost * 0.45;
    const score = Math.max(20, Math.min(98, Math.round(raw * 100)));

    const topMatches = matchedList.slice(0, 3);
    const reasons = [];
    if (topMatches.length) {
      reasons.push("Resume contains key terms: " + topMatches.join(", "));
    }
    if (score >= 75) {
      reasons.push("Strong overlap between your profile and this role.");
    } else if (score >= 55) {
      reasons.push("Partial overlap — a tailored resume could lift this match.");
    } else {
      reasons.push("Low overlap — consider whether this role is on your path.");
    }
    if (missing.length) {
      reasons.push("Close the gap on: " + missing.slice(0, 3).join(", ") + ".");
    }

    const fitSummary =
      score >= 80
        ? "Strong fit — apply with a tailored resume for best results."
        : score >= 60
        ? "Moderate fit — your core skills align; emphasize transferable strengths."
        : "Light fit — consider whether to pursue or upskill key gaps first.";

    return {
      score: score,
      fitSummary: fitSummary,
      reasons: reasons,
      missingSkills: missing.slice(0, 6)
    };
  }

  // Offline / pre-backend heuristic resume parser. Used as a fallback when
  // the backend AI isn't available. It is intentionally conservative: it
  // never invents data, just extracts what's unambiguous from the raw text.
  function heuristicParseResume(text) {
    const result = {
      header: { name: "", title: "", email: "", phone: "", location: "", links: [] },
      summary: "",
      experience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: []
    };
    if (!text) return result;

    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) result.header.email = emailMatch[0];
    const phoneMatch = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
    if (phoneMatch) result.header.phone = phoneMatch[0].trim();
    const linkMatches = text.match(/https?:\/\/[^\s)]+|www\.[^\s)]+|linkedin\.com\/[^\s)]+|github\.com\/[^\s)]+/gi) || [];
    result.header.links = linkMatches.slice(0, 5).map(function (u) {
      let label = "Link";
      if (/linkedin/i.test(u)) label = "LinkedIn";
      else if (/github/i.test(u)) label = "GitHub";
      else if (/portfolio|\.me|\.dev/i.test(u)) label = "Portfolio";
      return { label: label, url: u };
    });

    // First non-empty line is usually the candidate name.
    const lines = text.split(/\n/).map(function (l) { return l.trim(); });
    const firstLine = lines.find(function (l) { return l && !/@/.test(l) && l.length < 80; });
    if (firstLine && /[A-Z]/.test(firstLine) && firstLine.split(/\s+/).length <= 6) {
      result.header.name = firstLine;
    }

    // Best-effort skills: pull a "Skills" block up to the next ALL-CAPS heading.
    const skillsMatch = text.match(/(skills|technical skills|core competencies)[:\n]([\s\S]*?)(?:\n\n|\n[A-Z][A-Z\s]{3,}\n|$)/i);
    if (skillsMatch) {
      result.skills = skillsMatch[2]
        .split(/[,•·|\n]/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s && s.length < 40; })
        .slice(0, 30);
    }

    // We don't try to invent experience entries from text heuristically; that's
    // what the real AI skill is for.
    return result;
  }

  // Offline heuristic critique — used when the backend AI isn't available.
  // Not as nuanced as a real LLM but gives the user actionable, real
  // feedback without hitting the network.
  function heuristicCritiqueResume(resume) {
    const out = {
      score: 60,
      subscores: { impact: 60, clarity: 65, ats: 60, presentation: 70, voice: 60 },
      strengths: [],
      issues: []
    };
    if (!resume || typeof resume !== "object") {
      out.score = 0;
      out.issues.push({
        severity: "critical", section: "overall",
        message: "No resume found — upload or paste one to get a critique.",
        suggestion: "Upload your CV using the dropzone at the top of Resume Lab."
      });
      return out;
    }

    let tmp;
    const h = resume.header || {};
    const exps = Array.isArray(resume.experience) ? resume.experience : [];
    const edus = Array.isArray(resume.education) ? resume.education : [];
    const skillGroups = resume.skills && Array.isArray(resume.skills.groups) ? resume.skills.groups : [];
    const skillCount = skillGroups.reduce(function (n, g) {
      return n + (Array.isArray(g.items) ? g.items.length : 0);
    }, 0);

    // Header completeness
    if (!h.name) out.issues.push({ severity: "critical", section: "header", message: "Your name isn't in the header.", suggestion: "Add your full name to the header section." });
    if (!h.email) out.issues.push({ severity: "critical", section: "header", message: "No email in the header.", suggestion: "Add a professional email address recruiters can reply to." });
    if (!h.title) out.issues.push({ severity: "minor", section: "header", message: "No headline under your name.", suggestion: "Add a short role headline (e.g. \"Senior Frontend Engineer\")." });
    if (!(h.links && h.links.length)) out.issues.push({ severity: "minor", section: "header", message: "No links in your header.", suggestion: "Add LinkedIn, GitHub, or a portfolio link." });

    // Summary
    if (!resume.summary) {
      out.issues.push({ severity: "major", section: "summary", message: "Missing a summary paragraph.", suggestion: "Write 2-3 sentences capturing who you are, what you do, and the impact you drive." });
    } else if (resume.summary.length < 80) {
      out.issues.push({ severity: "minor", section: "summary", message: "Summary is very short.", suggestion: "Aim for 2-3 sentences (120-200 chars) covering years of experience, focus, and one signature result." });
    } else {
      out.strengths.push("Summary is present and substantial.");
    }

    // Experience analysis
    if (!exps.length) {
      out.issues.push({ severity: "critical", section: "experience", message: "No work experience entries.", suggestion: "Add at least one role — even internships or contract work count." });
    } else {
      out.strengths.push("Work experience is documented (" + exps.length + " role" + (exps.length === 1 ? "" : "s") + ").");
    }

    let totalBullets = 0;
    let quantifiedBullets = 0;
    const weakVerbRe = /^(responsible for|worked on|helped|assisted|involved in|participated in|duties included|tasked with)\b/i;
    const startsWithNonVerbRe = /^(i |my |the |a |an )/i;
    exps.forEach(function (e) {
      const bullets = Array.isArray(e.bullets) ? e.bullets : [];
      if (!bullets.length) {
        out.issues.push({
          severity: "major", section: "experience",
          message: "No bullets for " + (e.role || e.company || "one of your roles") + ".",
          suggestion: "Add 3-5 bullets describing what you shipped and its impact."
        });
        return;
      }
      bullets.forEach(function (b) {
        totalBullets += 1;
        const t = (b && b.text) || "";
        const hasNumber = /\d/.test(t);
        if (hasNumber) quantifiedBullets += 1;
        if (weakVerbRe.test(t)) {
          const variants = buildBulletVariants(t);
          out.issues.push({
            severity: "major", section: "experience",
            message: "Weak bullet phrasing in \"" + (e.role || e.company || "role") + "\".",
            suggestion: "Lead with a strong action verb instead of \"Responsible for\" / \"Worked on\".",
            target: { type: "bullet", id: b.id || "", replacement: variants[0] || strengthenBullet(t), alternatives: variants.slice(1) }
          });
        } else if (startsWithNonVerbRe.test(t)) {
          const variants = buildBulletVariants(t);
          out.issues.push({
            severity: "minor", section: "experience",
            message: "Bullet doesn't start with a verb.",
            suggestion: "Start bullets with a strong action verb — drop \"I\" / articles.",
            target: { type: "bullet", id: b.id || "", replacement: variants[0] || strengthenBullet(t), alternatives: variants.slice(1) }
          });
        } else if (!hasNumber && t.length > 24 && !hasImpactLanguage(t)) {
          const variants = buildBulletVariants(t);
          out.issues.push({
            severity: "minor", section: "experience",
            message: "Bullet could better describe scope or impact.",
            suggestion: "Clarify what changed, who benefited, or what outcome improved — metrics are optional if you don't have exact numbers.",
            target: { type: "bullet", id: b.id || "", replacement: variants[0] || t, alternatives: variants.slice(1) }
          });
        }
        if (t.length > 260) {
          const variants = buildBulletVariants(shortenBullet(t));
          out.issues.push({
            severity: "minor", section: "experience",
            message: "Bullet is long (" + t.length + " chars).",
            suggestion: "Tighten to 1 sentence, ~28 words or fewer.",
            target: { type: "bullet", id: b.id || "", replacement: variants[0] || shortenBullet(t), alternatives: variants.slice(1) }
          });
        }
      });
    });

    const quantRatio = totalBullets ? quantifiedBullets / totalBullets : 0;
    if (totalBullets > 0 && quantRatio >= 0.5) {
      out.strengths.push(Math.round(quantRatio * 100) + "% of bullets include metrics — strong evidence where available.");
    }

    // Education
    if (!edus.length) {
      out.issues.push({ severity: "minor", section: "education", message: "No education entries.", suggestion: "Add your highest degree or relevant program." });
    }

    // Skills
    if (skillCount === 0) {
      out.issues.push({ severity: "major", section: "skills", message: "No skills listed.", suggestion: "Group your skills (Languages, Frameworks, Tools) — this helps ATS match." });
    } else if (skillCount < 6) {
      out.issues.push({ severity: "minor", section: "skills", message: "Only " + skillCount + " skill" + (skillCount === 1 ? "" : "s") + " listed.", suggestion: "Add 8-15 specific skills to improve keyword coverage." });
    } else {
      out.strengths.push(skillCount + " skills listed — good keyword coverage.");
    }

    // Length heuristic (plain-text length as proxy)
    tmp = JSON.stringify(resume);
    if (tmp.length < 800) {
      out.issues.push({ severity: "minor", section: "overall", message: "Resume looks quite short.", suggestion: "Add more context: accomplishments, tools used, scope of projects." });
    } else if (tmp.length > 9000) {
      out.issues.push({ severity: "minor", section: "overall", message: "Resume is dense — may exceed 2 pages.", suggestion: "Trim older roles to 1-2 bullets and remove low-signal detail." });
    }

    // Sub-scores
    const impactSignals = exps.reduce(function (n, e) {
      return n + ((e.bullets || []).filter(function (b) { return hasImpactLanguage((b && b.text) || ""); }).length);
    }, 0);
    const impactRatio = totalBullets ? (impactSignals / totalBullets) : 0;
    out.subscores.impact = clamp(Math.round(35 + Math.max(quantRatio, impactRatio) * 65));
    const clarityHits = out.issues.filter(function (i) {
      return i.section === "experience" && (i.severity === "major" || i.severity === "minor");
    }).length;
    out.subscores.clarity = clamp(Math.round(90 - clarityHits * 6));
    out.subscores.ats = clamp(Math.round(40 + Math.min(skillCount, 15) * 4));
    out.subscores.presentation = clamp(Math.round(tmp.length > 800 && tmp.length < 7000 ? 82 : 65));
    const weakVerbCount = out.issues.filter(function (i) { return /weak bullet/i.test(i.message); }).length;
    out.subscores.voice = clamp(Math.round(85 - weakVerbCount * 8));

    // Overall = weighted avg
    out.score = clamp(Math.round(
      out.subscores.impact * 0.28 +
      out.subscores.clarity * 0.22 +
      out.subscores.ats * 0.22 +
      out.subscores.voice * 0.18 +
      out.subscores.presentation * 0.10
    ));

    if (!out.strengths.length) {
      out.strengths.push("Structured sections in place — a solid foundation to iterate on.");
    }
    return out;
  }

  function clamp(n) { return Math.max(0, Math.min(100, n)); }

  function strengthenBullet(text) {
    if (!text) return "";
    let t = String(text).trim();
    t = t.replace(/^(responsible for|worked on|helped|assisted|involved in|participated in|duties included|tasked with)\s+/i, "");
    t = t.replace(/^(i |my |the |a |an )/i, "");
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  }
  function shortenBullet(text) {
    if (!text) return "";
    const firstSentence = String(text).split(/(?<=[.!?])\s+/)[0] || String(text);
    const words = firstSentence.split(/\s+/);
    if (words.length <= 28) return firstSentence;
    return words.slice(0, 28).join(" ") + (firstSentence.endsWith(".") ? "" : ".");
  }

  function buildBulletVariants(text) {
    const base = strengthenBullet(text || "");
    if (!base) return [];
    const clean = base.replace(/\s+/g, " ").trim();
    const concise = shortenBullet(clean).replace(/\.$/, "");
    const balanced = addOutcomeCue(clean).replace(/\.$/, "");
    const detailed = (addOutcomeCue(clean).replace(/\.$/, "") + ", with clear ownership from planning through execution and delivery.").trim();
    const out = [];
    const seen = {};
    [concise, balanced, detailed].forEach(function (v) {
      const t = String(v || "").trim();
      if (!t) return;
      const key = t.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(t);
    });
    return out.slice(0, 3);
  }

  function hasImpactLanguage(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return /(improv|reduc|increas|accelerat|streamlin|enabled|supported|delivered|launched|optimized|resolved|strengthened|improved|outcome|efficien|quality|reliab)/.test(t);
  }

  function addOutcomeCue(text) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (hasImpactLanguage(t)) return t;
    return t.replace(/\.$/, "") + ", improving delivery quality and team effectiveness.";
  }

  // ---------------------------------------------------------------------------
  // JD analyzer — offline heuristic
  // ---------------------------------------------------------------------------
  const KNOWN_SKILLS = [
    "javascript","typescript","python","java","c++","c#","go","golang","rust","ruby","php","swift","kotlin","scala","r","sql","nosql","bash","shell",
    "react","next.js","vue","angular","svelte","redux","node.js","express","nestjs","django","flask","fastapi","spring","laravel","rails",".net",
    "html","css","sass","tailwind","graphql","rest","grpc","webpack","vite","rollup","babel",
    "postgres","postgresql","mysql","mongodb","redis","elasticsearch","snowflake","bigquery","databricks","kafka","rabbitmq",
    "aws","gcp","azure","kubernetes","docker","terraform","ansible","jenkins","github actions","ci/cd","linux",
    "figma","jira","confluence","notion","git","github","gitlab",
    "agile","scrum","kanban","tdd","bdd",
    "machine learning","deep learning","nlp","tensorflow","pytorch","scikit-learn","pandas","numpy",
    "product management","project management","stakeholder","okrs","kpis","a/b testing","analytics","tableau","power bi","excel","looker"
  ];

  function heuristicAnalyzeJd(jd) {
    const out = {
      role: "",
      seniority: "unspecified",
      company: "",
      location: "",
      remote: "unspecified",
      requiredSkills: [],
      preferredSkills: [],
      keywords: [],
      responsibilities: [],
      redFlags: []
    };
    if (!jd) return out;
    const lower = jd.toLowerCase();

    // Title detection — first non-empty line is usually the title.
    const lines = jd.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length) {
      // Try matching "Role: X" first, otherwise take the first line if it's
      // short enough to be a title.
      const m = jd.match(/(?:position|role|job\s*title)[\s:]+([^\n]+)/i);
      if (m) {
        out.role = m[1].trim().slice(0, 80);
      } else if (lines[0].length <= 80) {
        out.role = lines[0];
      }
    }

    // Seniority
    const seniorityRules = [
      [/\b(vp|vice\s*president)\b/i, "executive"],
      [/\b(director)\b/i, "director"],
      [/\b(head\s+of|engineering\s+manager|manager)\b/i, "manager"],
      [/\b(principal)\b/i, "principal"],
      [/\b(staff)\b/i, "staff"],
      [/\b(senior|sr\.?|lead)\b/i, "senior"],
      [/\b(mid[-\s]level|intermediate)\b/i, "mid"],
      [/\b(junior|jr\.?|entry[-\s]level)\b/i, "junior"],
      [/\b(intern|internship)\b/i, "intern"]
    ];
    for (let i = 0; i < seniorityRules.length; i += 1) {
      if (seniorityRules[i][0].test(jd)) { out.seniority = seniorityRules[i][1]; break; }
    }

    // Remote / hybrid / onsite
    if (/\b(fully\s+remote|remote[- ]first|work\s+from\s+anywhere)\b/i.test(jd)) out.remote = "remote";
    else if (/\bhybrid\b/i.test(jd)) out.remote = "hybrid";
    else if (/\b(on[- ]?site|in[- ]?office)\b/i.test(jd)) out.remote = "onsite";
    else if (/\bremote\b/i.test(jd)) out.remote = "remote";

    // Company
    const cm = jd.match(/\b(?:at|for|join)\s+([A-Z][A-Za-z0-9&.\-\s]{2,40})(?:[,.\n])/);
    if (cm) out.company = cm[1].trim();

    // Known skills lookup
    const found = [];
    KNOWN_SKILLS.forEach(function (sk) {
      const re = new RegExp("\\b" + sk.replace(/[.+#]/g, "\\$&").replace(/\s+/g, "\\s+") + "\\b", "i");
      if (re.test(jd)) found.push(sk);
    });
    // Dedup with canonical casing
    const canon = {
      "javascript": "JavaScript", "typescript": "TypeScript", "node.js": "Node.js",
      "next.js": "Next.js", "graphql": "GraphQL", "postgresql": "PostgreSQL",
      "postgres": "PostgreSQL", "aws": "AWS", "gcp": "GCP", "ci/cd": "CI/CD",
      "tdd": "TDD", "bdd": "BDD", "nlp": "NLP", "okrs": "OKRs", "kpis": "KPIs",
      "a/b testing": "A/B testing", "power bi": "Power BI", "github actions": "GitHub Actions"
    };
    const canonize = function (s) {
      const k = s.toLowerCase();
      if (canon[k]) return canon[k];
      return s.split(/\s+/).map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      }).join(" ");
    };
    const seen = new Set();
    const skillList = [];
    found.forEach(function (s) {
      const c = canonize(s);
      if (!seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); skillList.push(c); }
    });

    // Split required vs preferred using sentence proximity.
    const reqRe = /(required|must\s*have|must\s*-\s*have|requirements?)/i;
    const prefRe = /(preferred|nice\s*to\s*have|bonus|plus)/i;
    skillList.forEach(function (s) {
      const idx = lower.indexOf(s.toLowerCase());
      if (idx < 0) return;
      const window = jd.slice(Math.max(0, idx - 200), idx + s.length + 80);
      if (prefRe.test(window) && !reqRe.test(window)) out.preferredSkills.push(s);
      else out.requiredSkills.push(s);
    });

    // Keywords = skills + a few high-signal tokens
    const extra = [];
    ["scalable","distributed","microservices","cloud","production","performance","security","accessibility","mobile","frontend","backend","fullstack","data","analytics","growth","b2b","b2c","saas","ai","ml","llm"]
      .forEach(function (k) {
        if (new RegExp("\\b" + k + "\\b", "i").test(jd)) extra.push(k);
      });
    const kw = new Set();
    skillList.forEach(function (s) { kw.add(s.toLowerCase()); });
    extra.forEach(function (s) { kw.add(s.toLowerCase()); });
    out.keywords = Array.from(kw).slice(0, 20);

    // Responsibilities — look for bullet lines after "Responsibilities" or "What you'll do".
    const respSection = jd.match(/(?:responsibilities|what\s+you(?:'ll|\s+will)\s+do|the\s+role)[^\n]*\n([\s\S]{0,1500})/i);
    if (respSection) {
      const chunk = respSection[1];
      const bullets = chunk.split(/\n+/)
        .map(function (l) { return l.replace(/^[\s\-\*\u2022\u25E6\u2023\d.)]+/, "").trim(); })
        .filter(function (l) { return l.length >= 20 && l.length <= 240; })
        .slice(0, 8);
      out.responsibilities = bullets;
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Tailor plan — offline heuristic
  // ---------------------------------------------------------------------------
  function heuristicTailorPlan(resume, jdAny, targetRole) {
    const out = {
      summary: "",
      bullets: [],
      addSkills: [],
      coverage: { matched: [], missing: [] },
      overallFitNotes: ""
    };
    if (!resume || typeof resume !== "object") return out;

    // Derive a structured JD — jdAny may be text or an already-parsed object.
    let jdStruct;
    if (jdAny && typeof jdAny === "object" && !Array.isArray(jdAny) && (jdAny.requiredSkills || jdAny.keywords)) {
      jdStruct = jdAny;
    } else {
      jdStruct = heuristicAnalyzeJd(String(jdAny || ""));
    }

    const jdKeywords = (jdStruct.keywords || []).map(function (k) { return String(k).toLowerCase(); });
    const jdReq = (jdStruct.requiredSkills || []).map(function (k) { return String(k).toLowerCase(); });
    const allJdTerms = Array.from(new Set(jdKeywords.concat(jdReq)));

    const resumeText = JSON.stringify(resume).toLowerCase();
    const matched = [];
    const missing = [];
    allJdTerms.forEach(function (t) {
      if (!t) return;
      const re = new RegExp("\\b" + t.replace(/[.+#\-\/]/g, "\\$&") + "\\b", "i");
      if (re.test(resumeText)) matched.push(t);
      else missing.push(t);
    });
    out.coverage.matched = matched;
    out.coverage.missing = missing;

    // Suggest adding top missing skills (up to 5)
    out.addSkills = missing.slice(0, 5).map(function (t) {
      return {
        skill: t.split(/\s+/).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" "),
        group: "Other",
        evidence: "" // offline mode: we can't infer evidence — user must confirm
      };
    });

    // Tailored summary — pull from existing summary + inject top 2-3 missing keywords.
    const origSummary = resume.summary || "";
    const firstMissing = missing.slice(0, 3).map(function (t) {
      return t.split(/\s+/).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
    });
    if (origSummary) {
      out.summary = origSummary +
        (firstMissing.length ? " Skilled with " + firstMissing.join(", ") + " and aligned to the " + (targetRole || jdStruct.role || "target") + " role." : "");
    } else {
      out.summary = (targetRole || jdStruct.role || "Experienced professional") + " with a track record of delivering impactful work" +
        (firstMissing.length ? ", experienced with " + firstMissing.join(", ") + "." : ".");
    }

    out.summaryAlternatives = [];
    if (out.summary && out.summary.length > 90) {
      const parts = out.summary.split(/(?<=[.!?])\s+/).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length >= 3) {
        out.summaryAlternatives.push(parts.slice(0, 2).join(" "));
      }
      if (parts.length >= 2) {
        const rot = [parts[1], parts[0]].concat(parts.slice(2)).join(" ");
        if (rot.toLowerCase() !== out.summary.toLowerCase()) {
          out.summaryAlternatives.push(rot);
        }
      }
    }

    // Bullet rewrites — find bullets not already strong, rewrite with stronger verb
    // and append a missing keyword when appropriate.
    const rewriteVerbs = ["Led","Drove","Shipped","Architected","Scaled","Launched","Optimized"];
    const bullets = [];
    let rCount = 0;
    const exps = Array.isArray(resume.experience) ? resume.experience : [];
    for (let i = 0; i < exps.length && rCount < 6; i += 1) {
      const e = exps[i];
      const bs = Array.isArray(e.bullets) ? e.bullets : [];
      for (let j = 0; j < bs.length && rCount < 6; j += 1) {
        const b = bs[j];
        const orig = (b && b.text) || "";
        if (!orig || !b.id) continue;
        const weak = /^(responsible for|worked on|helped|assisted|involved in|participated in|duties included|tasked with)\b/i.test(orig)
          || /^(i |my |the |a |an )/i.test(orig)
          || orig.length > 260;
        if (!weak && /\d/.test(orig)) continue; // skip already-strong quantified bullets

        let rewrite = orig
          .replace(/^(responsible for|worked on|helped|assisted|involved in|participated in|duties included|tasked with)\s+/i, "")
          .replace(/^(i |my |the |a |an )/i, "")
          .trim();
        if (!/^[A-Z]/.test(rewrite)) {
          rewrite = rewriteVerbs[rCount % rewriteVerbs.length] + " " + rewrite;
        }
        if (rewrite.length > 200) rewrite = shortenBullet(rewrite);

        // Inject a missing JD keyword only if it's plausibly related (first 3)
        const keywordsSurfaced = [];
        for (let m = 0; m < Math.min(2, missing.length); m += 1) {
          const mk = missing[m];
          if (!rewrite.toLowerCase().includes(mk)) keywordsSurfaced.push(mk);
        }

        bullets.push({
          targetBulletId: b.id,
          original: orig,
          rewrite: rewrite,
          rationale: "Strengthen the verb and tighten phrasing" + (keywordsSurfaced.length ? "; consider referencing " + keywordsSurfaced.join(", ") + " if accurate." : "."),
          keywords: keywordsSurfaced
        });
        rCount += 1;
      }
    }
    out.bullets = bullets;

    // Overall notes
    const coverageRatio = allJdTerms.length ? matched.length / allJdTerms.length : 0;
    if (coverageRatio >= 0.7) {
      out.overallFitNotes = "Strong match — " + Math.round(coverageRatio * 100) + "% keyword coverage. Focus on sharpening bullets and summary.";
    } else if (coverageRatio >= 0.4) {
      out.overallFitNotes = "Moderate fit — " + Math.round(coverageRatio * 100) + "% keyword coverage. Close gaps in the bullets or explain them in the cover letter.";
    } else {
      out.overallFitNotes = "Weak match — " + Math.round(coverageRatio * 100) + "% coverage. Be honest about missing skills or consider a different role.";
    }
    return out;
  }

  function parseNaturalQuery(text) {
    const src = String(text || "");
    const low = src.toLowerCase();

    const remote = /\bremote\b|\banywhere\b|\bwfh\b|\bwork from home\b/.test(low);

    let postedWithinDays = 0;
    if (/\btoday\b|\blast 24|\bpast 24|\bday\b/.test(low)) postedWithinDays = 1;
    else if (/\bthis week\b|\blast 7|\bpast 7|\b7 days\b|\bweek\b/.test(low)) postedWithinDays = 7;
    else if (/\blast 14|\bpast 14|\b14 days\b|\btwo weeks\b|\bfortnight\b/.test(low)) postedWithinDays = 14;
    else if (/\blast 30|\bpast 30|\b30 days\b|\bthis month\b|\bmonth\b/.test(low)) postedWithinDays = 30;

    let seniority = "any";
    if (/\b(lead|principal|staff)\b/.test(low)) seniority = "lead";
    else if (/\b(senior|sr\.?|snr)\b/.test(low)) seniority = "senior";
    else if (/\b(mid|intermediate)\b/.test(low)) seniority = "mid";
    else if (/\b(junior|jr\.?|entry|intern|graduate|new grad)\b/.test(low)) seniority = "junior";

    let location = null;
    const inMatch = src.match(/\bin ([A-Z][A-Za-z]+(?:[ ,][A-Z][A-Za-z]+){0,2})\b/);
    if (inMatch) location = inMatch[1];
    else {
      const regions = ["europe","emea","apac","americas","usa","us","uk","canada","germany","france","spain","portugal","netherlands","india","remote"];
      for (let i = 0; i < regions.length; i += 1) {
        const re = new RegExp("\\b" + regions[i] + "\\b", "i");
        if (re.test(low) && regions[i] !== "remote") {
          location = regions[i].toUpperCase();
          break;
        }
      }
    }

    const noise = [
      "remote","anywhere","wfh","today","this","week","last","past","days","day","month","fortnight","two","weeks","hybrid","on-site","onsite","senior","junior","lead","principal","staff","intermediate","mid","sr","jr","entry","intern","graduate","new","grad","jobs","job","role","roles","position","positions","work","in","near","around","worldwide"
    ];
    const noiseSet = new Set(noise);
    const keywords = uniqueTokens(src, 30).filter(function (t) {
      return !noiseSet.has(t) && !/^\d+$/.test(t);
    }).slice(0, 8);

    return {
      keywords: keywords,
      location: location,
      remote: remote,
      postedWithinDays: postedWithinDays,
      seniority: seniority
    };
  }

  function createMockData(skill, input) {
    const candidateCtx = getCandidateContext(input);
    const ctxRoles = contextList(candidateCtx, "target.roles", 3);
    const ctxSkills = contextList(candidateCtx, "skills", 12);
    const ctxTargetSkills = contextList(candidateCtx, "target.mustHaveSkills", 12);
    const ctxMissing = contextList(candidateCtx, "target.missingSkills", 8);
    const ctxEvidence = contextEvidence(candidateCtx, 5);
    const targetRole = (input && input.targetRole) || (input && input.role) || ctxRoles[0] || "Frontend Engineer";
    const company = (input && input.company) || "the company";

    if (skill === "job-match-score") {
      return computeJobMatch(
        (input && input.resume) || (candidateCtx && candidateCtx.promptBrief) || "",
        (input && input.job) || {}
      );
    }
    if (skill === "query-parse") {
      return parseNaturalQuery((input && input.text) || "");
    }

    if (skill === "resume-tailor") {
      const keywords = ctxTargetSkills.concat(ctxSkills).slice(0, 10);
      const evidenceBullets = ctxEvidence.slice(0, 4).map(function (item) {
        return item.replace(/[. ]+$/g, ".") || "";
      }).filter(Boolean);
      return {
        summary:
          "Tailored for a " +
          targetRole +
          " role. Emphasize verified candidate evidence, role-specific keywords, and a clear contribution story without inventing experience.",
        keywords: keywords.length ? keywords : ["React", "TypeScript", "Performance", "A/B Testing", "Accessibility"],
        bullets: evidenceBullets.length ? evidenceBullets.concat([
          "Connected the strongest resume evidence to the role requirements while keeping every claim grounded in the candidate record."
        ]).slice(0, 6) : [
          "Led rebuild of checkout flow that lifted conversion by 18% in 6 weeks.",
          "Cut first paint time by 42% using code splitting and lazy hydration.",
          "Mentored 3 engineers and owned the design-system migration roadmap."
        ]
      };
    }
    if (skill === "cover-letter-generate") {
      let strengths = Array.isArray(input && input.strengths)
        ? input.strengths.map(function (s) { return String(s || "").trim(); }).filter(Boolean).slice(0, 4)
        : ctxSkills.slice(0, 4);
      if (!strengths.length) strengths = ctxSkills.slice(0, 4);
      let evidence = Array.isArray(input && input.evidenceAssets)
        ? input.evidenceAssets.map(function (s) { return String(s || "").trim(); }).filter(Boolean).slice(0, 2)
        : ctxEvidence.slice(0, 2);
      if (!evidence.length) evidence = ctxEvidence.slice(0, 2);
      const posting = String((input && (input.jobDescription || input.jobPosting)) || "").trim();
      const postingSignals = uniqueTokens(posting, 8).slice(0, 5);
      const whyRaw = String((input && input.why) || "").split("|")[0].trim();
      const whyLine = whyRaw || ("I am interested in " + company + " because the role fits the kind of practical, high-ownership work I want to contribute to.");
      const strengthLine = strengths.length
        ? "My strongest fit is in " + strengths.join(", ") + ", which I can apply directly to the needs of this role."
        : "My strongest fit is the ability to bring structure, clear communication, and disciplined follow-through to important work.";
      const postingLine = postingSignals.length
        ? "The posting emphasizes " + postingSignals.join(", ") + ", so I would focus first on showing value in those areas."
        : "The role calls for someone who can understand the team context quickly and contribute with care, speed, and sound judgment.";
      const evidenceLine = evidence.length
        ? "A specific example from my background: " + evidence[0] + (evidence[1] ? " I would bring that same evidence-backed approach to " + company + "." : "")
        : "I would bring a careful, measurable approach to the work, making sure each contribution is tied to the team's priorities.";
      const closing = "Thank you for considering my application. I would welcome the opportunity to discuss how my background can support " + company + " in this role.";
      const length = String((input && input.length) || "medium").toLowerCase();
      const signoffName = String((candidateCtx && candidateCtx.identity && candidateCtx.identity.name) || "Jonathan").trim() || "Jonathan";
      const bodyParts = [
        "Dear Hiring Team,",
        "I am excited to apply for the " + targetRole + " role at " + company + ". " + whyLine,
        strengthLine + " " + postingLine,
        evidenceLine,
        closing,
        "Best regards,\n" + signoffName
      ];
      if (length === "short") {
        bodyParts.splice(3, 1);
      }
      return {
        subject: "Application - " + targetRole + " at " + company,
        body: bodyParts.join("\n\n")
      };
    }
    if (skill === "interview-coach") {
      const gapLine = ctxMissing.length
        ? " Be ready to discuss or honestly frame gaps around " + ctxMissing.slice(0, 3).join(", ") + "."
        : "";
      return {
        questions: [
          "Tell me about a project where you shipped measurable impact relevant to " + targetRole + ".",
          "Describe a disagreement with a teammate and how you resolved it.",
          "Walk through a performance problem you debugged end to end.",
          "How do you prioritize work when multiple stakeholders disagree?",
          "What are you looking for in your next role?",
          "Which part of your background best proves you can succeed in this role?"
        ],
        feedback: [
          "Use STAR format and lead with the measurable outcome.",
          "Quantify everything: time saved, revenue impact, users affected.",
          "Keep answers under 2 minutes. Pause for follow-up questions." + gapLine
        ]
      };
    }
    if (skill === "interview-score") {
      return {
        score: 78,
        strengths: ["Clear structure", "Used concrete metrics"],
        improvements: ["Add a specific result number", "Shorten setup by 20%"]
      };
    }
    if (skill === "resume-parse") {
      // Best-effort offline parser: use regex heuristics on the raw text so
      // users without backend credentials still see a populated editor.
      const text = (input && (input.text || input.resumeText || input.rawText)) || "";
      return heuristicParseResume(String(text));
    }
    if (skill === "resume-critique") {
      const resumeJson = (input && (input.resume || input.resumeJson || input.structured)) || null;
      return heuristicCritiqueResume(resumeJson);
    }
    if (skill === "jd-analyze") {
      const jdText = (input && (input.jd || input.jobDescription || input.description || input.text)) || "";
      return heuristicAnalyzeJd(String(jdText));
    }
    if (skill === "tailor-plan") {
      const resumeJson = (input && (input.resume || input.resumeJson || input.structured)) || null;
      const jdAny = (input && (input.jd || input.jobDescription || input.jdAnalyzed || input.jdStructured)) || "";
      const role = (input && (input.targetRole || input.role)) || targetRole || "";
      return heuristicTailorPlan(resumeJson, jdAny, role);
    }
    if (skill === "followup-email") {
      const daysSince = (input && input.daysSince) || 7;
      return {
        subject: "Quick follow-up: " + (targetRole || "role") + " at " + (company || "your team"),
        body:
          "Hi " + ((input && (input.recipient || input.contact)) || "team") + ",\n\n" +
          "I wanted to follow up on my application for the " + (targetRole || "role") +
          " role, which I submitted " + daysSince + " days ago. I remain very interested " +
          "in what " + (company || "your team") + " is building and would love to share how " +
          "my recent work lines up with the problems you're solving.\n\n" +
          "Is there a good time this week or next to chat briefly, or would it help " +
          "if I shared additional context first?\n\n" +
          "Thanks for considering — looking forward to hearing from you.",
        openers: [
          "Hope your week is going well — wanted to briefly check in on my application.",
          "Circling back on the " + (targetRole || "role") + " role at " + (company || "your team") + ".",
          "Following up on my application from " + daysSince + " days ago."
        ]
      };
    }
    return {
      headline: "Focus on 3 high-signal roles this week",
      recommendations: [
        "Follow up on applications older than 5 days.",
        "Tailor your resume for roles mentioning React + TypeScript.",
        "Reach out to 2 referrals for your top target companies."
      ]
    };
  }

  function resolveAiEndpoint() {
    if (window.__CAREERBOOST_AI_URL) return window.__CAREERBOOST_AI_URL;
    if (
      window.CBV2 &&
      window.CBV2.config &&
      window.CBV2.config.isBackendEnabled() &&
      window.CBV2.auth &&
      window.CBV2.auth.isAuthenticated()
    ) {
      return window.CBV2.config.getFunctionsUrl() + "/ai-run";
    }
    return "";
  }

  async function resolveAuthHeaders() {
    if (!window.CBV2 || !window.CBV2.auth) return null;
    const token = await window.CBV2.auth.getAccessToken();
    if (!token) return null;
    return {
      Authorization: "Bearer " + token,
      apikey: window.CBV2.config.getSupabaseAnon()
    };
  }

  // When backend is enabled AND the user is signed in we skip the local
  // fallback mock entirely, so broken AI surfaces as a real error instead of
  // silently returning canned mock data that looks fine but isn't real.
  function isBackendActive() {
    return Boolean(
      window.CBV2 &&
        window.CBV2.config &&
        window.CBV2.config.isBackendEnabled() &&
        window.CBV2.auth &&
        window.CBV2.auth.isAuthenticated()
    );
  }

  function truncate(s, n) {
    const str = String(s || "");
    return str.length > n ? str.slice(0, n) + "…" : str;
  }

  async function parseErrorBody(response) {
    try {
      const txt = await response.text();
      try {
        const j = JSON.parse(txt);
        if (j && typeof j.error === "string") return j.error;
      } catch (e) { /* non-JSON */ }
      return truncate(txt, 240);
    } catch (e) {
      return "HTTP " + response.status;
    }
  }

  async function invokeViaSdk(payload) {
    const auth = window.CBV2 && window.CBV2.auth;
    const client = auth && auth.getClient && auth.getClient();
    if (!client || !client.functions || typeof client.functions.invoke !== "function") {
      return null; // caller falls back to manual fetch
    }
    const { data, error } = await client.functions.invoke("ai-run", { body: payload });
    if (error) {
      let msg = error.message || "Edge function error";
      try {
        if (error.context && typeof error.context.text === "function") {
          const t = await error.context.text();
          try {
            const j = JSON.parse(t);
            msg = j.error || j.message || msg;
            if (Array.isArray(j.warnings) && j.warnings.length) {
              msg += " — " + j.warnings.join(" · ");
            }
          } catch (e) { if (t) msg = t.slice(0, 240); }
        }
      } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return data;
  }

  const backendProvider = {
    name: "backend-primary",
    async run(payload) {
      if (!isBackendActive()) {
        throw new Error("Backend not configured or not signed in.");
      }

      // Prefer the SDK which attaches auth headers automatically and refreshes
      // the token if needed. If the SDK isn't available (older build), fall
      // back to a hand-rolled fetch that at least surfaces the body.
      const sdkResult = await withTimeout(invokeViaSdk(payload), 30000);
      if (sdkResult !== null) {
        if (!sdkResult || sdkResult.ok === false) {
          var sdkFailMsg = (sdkResult && sdkResult.error) || "AI backend returned an invalid response.";
          if (sdkResult && Array.isArray(sdkResult.warnings) && sdkResult.warnings.length) {
            sdkFailMsg += " — " + sdkResult.warnings.join(" · ");
          }
          throw new Error(sdkFailMsg);
        }
        return sdkResult;
      }

      const endpoint = resolveAiEndpoint();
      const authHeaders = await resolveAuthHeaders();
      if (!endpoint || !authHeaders) {
        throw new Error("Backend not configured or not signed in.");
      }
      const response = await withTimeout(
        fetch(endpoint, {
          method: "POST",
          headers: Object.assign(
            { "Content-Type": "application/json" },
            authHeaders
          ),
          body: JSON.stringify(payload)
        }),
        30000
      );
      if (!response.ok) {
        const detail = await parseErrorBody(response);
        throw new Error("AI " + response.status + ": " + detail);
      }
      const data = await response.json();
      if (!data || data.ok === false) {
        var fetchFailMsg = (data && data.error) || "AI backend returned an invalid response.";
        if (data && Array.isArray(data.warnings) && data.warnings.length) {
          fetchFailMsg += " — " + data.warnings.join(" · ");
        }
        throw new Error(fetchFailMsg);
      }
      return data;
    }
  };

  const localMockProvider = {
    name: "local-fallback",
    async run(payload) {
      return withTimeout(
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve({
              ok: true,
              requestId: payload.requestId,
              model: "fallback-mock",
              latencyMs: 420,
              confidence: 0.78,
              warnings: ["Using local fallback (mock) provider."],
              data: createMockData(payload.skill, payload.input)
            });
          }, 380);
        }),
        3000
      );
    }
  };

  // Exposed as a getter so the orchestrator always sees the current
  // sign-in state. When backend is active we refuse to silently mock.
  Object.defineProperty(window, "__CBAI_providers", {
    get: function () {
      return isBackendActive()
        ? [backendProvider]
        : [backendProvider, localMockProvider];
    }
  });

  // -------------------------------------------------------------------------
  // Streaming consumer (Phase 1) — SSE reader for `interview-session-step`.
  // Backend emits events: meta, delta, done, error, warn.
  // Caller passes { onMeta, onDelta, onDone, onError } and gets progressive
  // tokens for the typing-indicator UX. Falls back to runSkill if backend is
  // not active or streaming fails.
  // -------------------------------------------------------------------------
  async function runSkillStream(payload, callbacks) {
    callbacks = callbacks || {};
    if (!isBackendActive()) {
      throw new Error("Streaming requires an active backend session.");
    }
    const endpoint = resolveAiEndpoint();
    const authHeaders = await resolveAuthHeaders();
    if (!endpoint || !authHeaders) {
      throw new Error("Streaming requires backend + signed-in user.");
    }

    const body = Object.assign({}, payload, { stream: true });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: Object.assign(
        {
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
        },
        authHeaders
      ),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await parseErrorBody(response);
      throw new Error("AI " + response.status + ": " + detail);
    }
    if (!response.body) {
      throw new Error("Streaming not supported by browser/runtime.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalEnvelope = null;
    let aborted = false;

    function dispatch(eventName, data) {
      try {
        if (eventName === "meta" && callbacks.onMeta) callbacks.onMeta(data);
        else if (eventName === "delta" && callbacks.onDelta) callbacks.onDelta(data);
        else if (eventName === "warn" && callbacks.onWarn) callbacks.onWarn(data);
        else if (eventName === "done") {
          finalEnvelope = data;
          if (callbacks.onDone) callbacks.onDone(data);
        } else if (eventName === "error") {
          aborted = true;
          if (callbacks.onError) callbacks.onError(data);
        }
      } catch (e) { /* user callback error must not break the stream */ }
    }

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = block.split("\n");
        let eventName = "message";
        let dataPayload = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataPayload += line.slice(5).trim();
        }
        if (!dataPayload) continue;
        let parsed;
        try { parsed = JSON.parse(dataPayload); }
        catch (e) { continue; }
        dispatch(eventName, parsed);
        if (eventName === "done" || eventName === "error") {
          // Backend closed the stream.
          break;
        }
      }
      if (aborted) break;
    }

    if (!finalEnvelope) {
      throw new Error("Stream ended without a `done` event.");
    }
    return finalEnvelope;
  }

  window.CBAI = window.CBAI || {};
  Object.defineProperty(window.CBAI, "providers", {
    get: function () { return window.__CBAI_providers; }
  });
  window.CBAI.runSkillStream = runSkillStream;
})();
