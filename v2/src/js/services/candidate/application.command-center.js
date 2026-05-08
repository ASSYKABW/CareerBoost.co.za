(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.applicationCommand && window.CBV2.applicationCommand.version >= 1) return;

  const STAGE_LABELS = {
    saved: "Saved",
    applied: "Applied",
    interview: "Interview",
    offer: "Offer",
    rejected: "Rejected",
    withdrawn: "Withdrawn"
  };

  function clamp(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function lower(value) {
    return String(value || "").toLowerCase().trim();
  }

  function hasText(value, min) {
    return String(value || "").trim().length >= (min || 1);
  }

  function sameish(a, b) {
    const aa = lower(a);
    const bb = lower(b);
    if (!aa || !bb) return false;
    return aa === bb || aa.indexOf(bb) >= 0 || bb.indexOf(aa) >= 0;
  }

  function daysSince(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  }

  function hostFromUrl(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  }

  function sourceNameFromHost(host) {
    if (!host) return "Manual";
    if (host.indexOf("linkedin.") >= 0) return "LinkedIn";
    if (host.indexOf("indeed.") >= 0) return "Indeed";
    if (host.indexOf("adzuna.") >= 0) return "Adzuna";
    if (host.indexOf("glassdoor.") >= 0) return "Glassdoor";
    if (host.indexOf("greenhouse.") >= 0) return "Greenhouse";
    if (host.indexOf("lever.") >= 0) return "Lever";
    return host.split(".")[0].replace(/[-_]+/g, " ");
  }

  function getAll() {
    const store = window.CBV2.store;
    if (!store || typeof store.getAll !== "function") return {};
    return store.getAll() || {};
  }

  function parseNotes(app) {
    const helper = window.CBV2.jobNotes;
    if (helper && typeof helper.parseImportedNotes === "function") {
      return helper.parseImportedNotes(app && app.notes) || null;
    }
    return null;
  }

  function sourceModel(app) {
    const parsed = parseNotes(app) || {};
    const notes = String(app && app.notes || "");
    const parsedUrl = String(parsed.source || "").trim();
    const appUrl = String(app && app.jobUrl || "").trim();
    const url = parsedUrl || appUrl;
    const host = hostFromUrl(url);
    const sourceName = sourceNameFromHost(host);
    const importedByExtension = /CareerBoost extension/i.test(notes);
    const description = String(parsed.description || "").trim();
    const hasDescription = description.length > 120;
    const hasUrl = !!url;
    let status = "missing";
    let detail = "No source URL is attached yet.";
    if (hasUrl && hasDescription) {
      status = "ready";
      detail = "Source URL and captured job description are available.";
    } else if (hasUrl) {
      status = "partial";
      detail = "Source URL exists, but the captured description is thin.";
    } else if (description) {
      status = "partial";
      detail = "Description exists, but the original source URL is missing.";
    }
    return {
      status: status,
      name: sourceName,
      url: url,
      host: host,
      method: importedByExtension ? "Imported via CareerBoost extension" : (hasUrl ? "Saved with source URL" : "Manual entry"),
      description: description,
      hasDescription: hasDescription,
      detail: detail,
      location: parsed.location || app.location || ""
    };
  }

  function statusWeight(status) {
    if (status === "ready") return 100;
    if (status === "partial") return 58;
    return 0;
  }

  function fitModel(app, apps) {
    const intel = window.CBV2.candidateIntel;
    if (!intel || typeof intel.scoreApplicationFit !== "function") return null;
    try {
      const candidate = typeof intel.build === "function" ? intel.build() : null;
      return intel.scoreApplicationFit(app, apps || [], candidate);
    } catch (_) {
      return null;
    }
  }

  function resumeMaterial(app, all) {
    const resume = all.resume || {};
    const baseReady = hasText(resume.base, 120) || !!resume.structured;
    const tailor = resume.tailor || {};
    const tailored = resume.tailored || null;
    const roleSpecific =
      !!tailored &&
      (sameish(tailor.jdRole, app.role) || sameish(tailor.targetRole, app.role) || hasText(tailor.jdText, 180));
    if (roleSpecific) {
      return {
        id: "resume",
        label: "Resume",
        status: "ready",
        icon: "fa-file-lines",
        destination: "resume",
        href: "#/resume",
        detail: "Role-specific tailoring exists for this application context."
      };
    }
    if (baseReady) {
      return {
        id: "resume",
        label: "Resume",
        status: "partial",
        icon: "fa-file-lines",
        destination: "resume",
        href: "#/resume",
        detail: "Base resume is ready. Tailor it to this job before applying."
      };
    }
    return {
      id: "resume",
      label: "Resume",
      status: "missing",
      icon: "fa-file-circle-plus",
      destination: "resume",
      href: "#/resume",
      detail: "Build or upload a resume before preparing this application."
    };
  }

  function coverMaterial(app, all) {
    const c = all.coverLetter || {};
    const sent = (c.sentLog || []).find(function (row) {
      return sameish(row.company, app.company) && (!row.role || sameish(row.role, app.role));
    });
    const rolePack = (c.rolePacks || []).find(function (pack) {
      return sameish(pack.role, app.role) || sameish(pack.name, app.company);
    });
    const result = c.lastResult && c.lastResult.data ? c.lastResult.data : null;
    const variantCount = Array.isArray(c.variants) ? c.variants.length : 0;
    if (sent) {
      return {
        id: "cover",
        label: "Cover letter",
        status: "ready",
        icon: "fa-envelope-circle-check",
        destination: "cover",
        href: "#/cover-letter",
        detail: "A cover letter has been logged for this company."
      };
    }
    if (rolePack || hasText(result && result.body, 160) || variantCount) {
      return {
        id: "cover",
        label: "Cover letter",
        status: "partial",
        icon: "fa-envelope-open-text",
        destination: "cover",
        href: "#/cover-letter",
        detail: rolePack ? "A reusable role pack exists. Generate or finalize the draft." : "A draft or saved variant exists. Confirm it matches this role."
      };
    }
    return {
      id: "cover",
      label: "Cover letter",
      status: "missing",
      icon: "fa-envelope",
      destination: "cover",
      href: "#/cover-letter",
      detail: "No role-specific letter is ready yet."
    };
  }

  function interviewMaterial(app, all, events) {
    const interview = all.interview || {};
    const hasInterviewEvent = (events || []).some(function (ev) {
      return lower(ev.type) === "interview";
    });
    const hasIntel = !!(interview.intelSession && (
      interview.intelSession.intelPackEnvelope ||
      (Array.isArray(interview.intelSession.hits) && interview.intelSession.hits.length)
    ));
    const hasMock = !!(interview.mockSession && (
      interview.mockSession.debrief ||
      (Array.isArray(interview.mockSession.transcript) && interview.mockSession.transcript.length)
    ));
    const hasQuestions = !!(interview.lastSet && interview.lastSet.data && Array.isArray(interview.lastSet.data.questions) && interview.lastSet.data.questions.length);
    if (hasInterviewEvent && (hasIntel || hasMock || hasQuestions)) {
      return {
        id: "interview",
        label: "Interview prep",
        status: "ready",
        icon: "fa-comments",
        destination: "interview",
        href: "#/interview",
        detail: "Interview is scheduled and prep material exists."
      };
    }
    if (hasInterviewEvent || hasIntel || hasMock || hasQuestions || lower(app.stage) === "interview") {
      return {
        id: "interview",
        label: "Interview prep",
        status: "partial",
        icon: "fa-comments",
        destination: "interview",
        href: "#/interview",
        detail: hasInterviewEvent ? "Interview event exists. Complete research, questions, or a mock." : "Prep material exists, but no interview event is linked."
      };
    }
    return {
      id: "interview",
      label: "Interview prep",
      status: "missing",
      icon: "fa-user-tie",
      destination: "interview",
      href: "#/interview",
      detail: "No interview plan is attached to this application yet."
    };
  }

  function followupMaterial(app, events) {
    const stage = lower(app.stage || "saved");
    const hasFollowup = (events || []).some(function (ev) {
      return lower(ev.type) === "followup";
    });
    const hasNextAction = hasText(app.nextAction, 8);
    if (stage === "saved") {
      return {
        id: "followup",
        label: "Next action",
        status: hasNextAction ? "ready" : "partial",
        icon: "fa-route",
        detail: hasNextAction ? app.nextAction : "Decide whether to tailor, apply, or archive."
      };
    }
    if (hasFollowup) {
      return {
        id: "followup",
        label: "Follow-up",
        status: "ready",
        icon: "fa-envelope-circle-check",
        detail: "A follow-up event is already linked."
      };
    }
    if (hasNextAction) {
      return {
        id: "followup",
        label: "Follow-up",
        status: "partial",
        icon: "fa-envelope",
        detail: "Next action is recorded. Add a dated follow-up if needed."
      };
    }
    return {
      id: "followup",
      label: "Follow-up",
      status: "missing",
      icon: "fa-envelope",
      detail: "No follow-up or next action is recorded."
    };
  }

  function sourceMaterial(source) {
    return {
      id: "source",
      label: "Source truth",
      status: source.status,
      icon: source.status === "ready" ? "fa-shield-halved" : "fa-link",
      detail: source.detail,
      url: source.url
    };
  }

  function pickNext(app, materials, fit, source) {
    const byId = {};
    materials.forEach(function (item) { byId[item.id] = item; });
    const stage = lower(app.stage || "saved");
    const staleApplied = stage === "applied" && (daysSince(app.appliedAt) || 0) >= 5;
    if (source.status !== "ready") {
      return {
        label: "Verify source and posting",
        detail: source.detail,
        icon: "fa-shield-halved",
        destination: "",
        href: source.url || ""
      };
    }
    if (byId.resume && byId.resume.status !== "ready") {
      return {
        label: byId.resume.status === "missing" ? "Build resume" : "Tailor resume",
        detail: byId.resume.detail,
        icon: "fa-file-lines",
        destination: "resume",
        href: "#/resume"
      };
    }
    if (byId.cover && byId.cover.status === "missing" && stage === "saved") {
      return {
        label: "Draft cover letter",
        detail: byId.cover.detail,
        icon: "fa-envelope-open-text",
        destination: "cover",
        href: "#/cover-letter"
      };
    }
    if (stage === "saved") {
      return {
        label: "Apply and move forward",
        detail: fit && fit.score >= 70 ? "Fit is strong enough to prioritize this application." : "Review the risks, then decide whether to apply.",
        icon: "fa-paper-plane",
        stage: "applied"
      };
    }
    if (stage === "interview" && byId.interview && byId.interview.status !== "ready") {
      return {
        label: "Complete interview prep",
        detail: byId.interview.detail,
        icon: "fa-comments",
        destination: "interview",
        href: "#/interview"
      };
    }
    if (staleApplied || (byId.followup && byId.followup.status === "missing")) {
      return {
        label: "Draft follow-up",
        detail: "This application needs a clear follow-up plan.",
        icon: "fa-envelope-circle-check",
        action: "followup"
      };
    }
    return {
      label: "Review application",
      detail: "Everything important is visible. Keep the stage, next action, and timeline current.",
      icon: "fa-list-check"
    };
  }

  function build(app, options) {
    const a = app || {};
    const all = (options && options.all) || getAll();
    const apps = (options && options.apps) || all.applications || [];
    const events = (options && options.events) || [];
    const source = sourceModel(a);
    const fit = fitModel(a, apps);
    const materials = [
      sourceMaterial(source),
      resumeMaterial(a, all),
      coverMaterial(a, all),
      interviewMaterial(a, all, events),
      followupMaterial(a, events)
    ];
    const readiness = clamp(
      statusWeight(materials[0].status) * 0.18 +
      (fit ? fit.score : 40) * 0.20 +
      statusWeight(materials[1].status) * 0.22 +
      statusWeight(materials[2].status) * 0.14 +
      statusWeight(materials[3].status) * 0.14 +
      statusWeight(materials[4].status) * 0.12
    );
    const readyCount = materials.filter(function (item) { return item.status === "ready"; }).length;
    const partialCount = materials.filter(function (item) { return item.status === "partial"; }).length;
    const missingCount = materials.filter(function (item) { return item.status === "missing"; }).length;
    return {
      version: 1,
      appId: a.id || "",
      company: a.company || "",
      role: a.role || "",
      stage: a.stage || "saved",
      stageLabel: STAGE_LABELS[a.stage] || a.stage || "Saved",
      readiness: readiness,
      readinessLabel: readiness >= 82 ? "Application-ready" : readiness >= 65 ? "Almost ready" : readiness >= 45 ? "Needs work" : "Not ready",
      source: source,
      fit: fit,
      materials: materials,
      counts: {
        ready: readyCount,
        partial: partialCount,
        missing: missingCount
      },
      next: pickNext(a, materials, fit, source)
    };
  }

  window.CBV2.applicationCommand = {
    version: 1,
    build: build,
    _private: {
      sourceModel: sourceModel,
      resumeMaterial: resumeMaterial,
      coverMaterial: coverMaterial,
      interviewMaterial: interviewMaterial,
      followupMaterial: followupMaterial,
      pickNext: pickNext
    }
  };
})();
