(function () {
  window.CBJobs = window.CBJobs || {};

  const SENIORITY_PATTERNS = {
    junior: /\b(junior|jr\.?|entry[-\s]?level|graduate|intern)\b/i,
    mid: /\b(mid|mid[-\s]?level|intermediate)\b/i,
    senior: /\b(senior|sr\.?|lead)\b/i,
    lead: /\b(staff|principal|head|director|manager)\b/i
  };

  function toTokens(value) {
    return String(value || "")
      .split(",")
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  function uniqueLower(values) {
    const out = [];
    const seen = {};
    (values || []).forEach(function (v) {
      const k = String(v || "").trim().toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(k);
    });
    return out;
  }

  function normalizeRoleProfile(roleProfile) {
    roleProfile = roleProfile || {};
    const targetTitles = uniqueLower(roleProfile.targetTitles || toTokens(roleProfile.targetTitlesCsv || ""));
    const mustHaveSkills = uniqueLower(roleProfile.mustHaveSkills || toTokens(roleProfile.mustHaveSkillsCsv || ""));
    const excludeKeywords = uniqueLower(roleProfile.excludeKeywords || toTokens(roleProfile.excludeKeywordsCsv || ""));
    const seniority = String(roleProfile.seniority || "any").toLowerCase();
    const strictMode = !!roleProfile.strictMode;
    return {
      targetTitles: targetTitles,
      mustHaveSkills: mustHaveSkills,
      excludeKeywords: excludeKeywords,
      seniority: ["any", "junior", "mid", "senior", "lead"].indexOf(seniority) >= 0 ? seniority : "any",
      strictMode: strictMode
    };
  }

  function toSearchText(job) {
    if (job && job.__cbIntentText) return job.__cbIntentText;
    const text = [
      job && job.title,
      job && job.company,
      job && job.location,
      ((job && job.tags) || []).join(" "),
      job && job.descriptionText
    ].join(" ").toLowerCase();
    if (job) job.__cbIntentText = text;
    return text;
  }

  function detectSeniority(job) {
    const text = toSearchText(job);
    if (SENIORITY_PATTERNS.lead.test(text)) return "lead";
    if (SENIORITY_PATTERNS.senior.test(text)) return "senior";
    if (SENIORITY_PATTERNS.junior.test(text)) return "junior";
    if (SENIORITY_PATTERNS.mid.test(text)) return "mid";
    return "any";
  }

  function titleMatches(job, intent) {
    if (!intent.targetTitles.length) return true;
    const title = String((job && job.title) || "").toLowerCase();
    return intent.targetTitles.some(function (t) {
      return title.indexOf(t) >= 0;
    });
  }

  function matchedTitle(job, intent) {
    if (!intent.targetTitles.length) return "";
    const title = String((job && job.title) || "").toLowerCase();
    const hit = intent.targetTitles.find(function (t) {
      return title.indexOf(t) >= 0;
    });
    return hit || "";
  }

  function includesMustHaveSkills(job, intent) {
    if (!intent.mustHaveSkills.length) return true;
    const text = toSearchText(job);
    // Phase 1 strictness: all required skills must appear in title/tags/description.
    return intent.mustHaveSkills.every(function (s) {
      return text.indexOf(s) >= 0;
    });
  }

  function matchedSkills(job, intent) {
    const text = toSearchText(job);
    return (intent.mustHaveSkills || []).filter(function (s) {
      return text.indexOf(s) >= 0;
    });
  }

  function hasExcludedKeywords(job, intent) {
    if (!intent.excludeKeywords.length) return false;
    const text = toSearchText(job);
    return intent.excludeKeywords.some(function (k) {
      return text.indexOf(k) >= 0;
    });
  }

  function seniorityMatches(job, intent) {
    if (!intent.seniority || intent.seniority === "any") return true;
    const detected = detectSeniority(job);
    if (detected === "any") return true;
    if (intent.seniority === "lead") return detected === "lead";
    if (intent.seniority === "senior") return detected === "senior" || detected === "lead";
    if (intent.seniority === "mid") return detected === "mid";
    if (intent.seniority === "junior") return detected === "junior";
    return true;
  }

  function matchesRoleIntent(job, roleProfile) {
    return evaluateJobIntent(job, roleProfile).pass;
  }

  function evaluateJobIntent(job, roleProfile) {
    const intent = normalizeRoleProfile(roleProfile);
    const hasTitleConstraint = intent.targetTitles.length > 0;
    const hasSkillConstraint = intent.mustHaveSkills.length > 0;
    const titleOk = titleMatches(job, intent);
    const titleHit = matchedTitle(job, intent);
    const skillsMatched = matchedSkills(job, intent);
    const skillAllOk = includesMustHaveSkills(job, intent);
    const skillAnyOk = !hasSkillConstraint || skillsMatched.length > 0;
    const excluded = hasExcludedKeywords(job, intent);
    const seniorityOk = seniorityMatches(job, intent);
    const detectedSeniority = detectSeniority(job);
    const constrained = hasTitleConstraint || hasSkillConstraint || intent.seniority !== "any";

    let pass = true;
    if (excluded || !seniorityOk) pass = false;
    else if (constrained && intent.strictMode) {
      pass = (!hasTitleConstraint || titleOk) && (!hasSkillConstraint || skillAllOk);
    } else if (constrained) {
      const broadTitlePass = !hasTitleConstraint || titleOk || (hasSkillConstraint && skillAnyOk);
      const broadSkillPass = !hasSkillConstraint || skillAnyOk;
      pass = broadTitlePass && broadSkillPass;
    }

    const reasons = [];
    if (titleHit) reasons.push("Title aligned: " + titleHit);
    if (skillsMatched.length) reasons.push("Skills matched: " + skillsMatched.slice(0, 4).join(", "));
    if (intent.seniority !== "any") reasons.push("Seniority: " + (seniorityOk ? "aligned" : "mismatch"));
    if (intent.strictMode) reasons.push("Mode: strict");
    const missingSkills = intent.mustHaveSkills.filter(function (s) { return skillsMatched.indexOf(s) < 0; });
    if (missingSkills.length) reasons.push("Missing skills: " + missingSkills.slice(0, 4).join(", "));
    if (excluded) reasons.push("Excluded by keyword");

    let score = 0;
    if (titleOk) score += 55;
    if (skillsMatched.length) score += Math.min(35, skillsMatched.length * 10);
    if (seniorityOk) score += (intent.seniority === "any" ? 10 : 20);
    if (detectedSeniority !== "any" && intent.seniority !== "any" && !seniorityOk) score -= 25;
    if (excluded) score -= 50;
    score = Math.max(0, Math.min(100, score));

    return {
      pass: pass,
      score: score,
      reasons: reasons,
      matchedTitle: titleHit,
      matchedSkills: skillsMatched,
      missingSkills: missingSkills,
      strictMode: intent.strictMode
    };
  }

  window.CBJobs.intent = {
    normalizeRoleProfile: normalizeRoleProfile,
    matchesRoleIntent: matchesRoleIntent,
    evaluateJobIntent: evaluateJobIntent
  };
})();
