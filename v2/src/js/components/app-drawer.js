// Application Detail Drawer (Phase C).
//
// A single right-hand slide-in panel used by the Applications and Dashboard
// views to surface full details, a stage transition timeline, linked events,
// inline edits and quick actions for a single application.
//
// The drawer mounts a persistent DOM node on the body and re-renders its
// contents on each open/refresh. It intentionally lives *outside* the
// router so it survives route re-renders triggered by store mutations.
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.drawer) return;

  const STAGES = [
    { id: "saved", label: "Saved", tone: "cyan" },
    { id: "applied", label: "Applied", tone: "violet" },
    { id: "interview", label: "Interview", tone: "blue" },
    { id: "offer", label: "Offer", tone: "green" },
    { id: "rejected", label: "Rejected", tone: "warning" },
    { id: "withdrawn", label: "Withdrawn", tone: "rose" }
  ];
  const STAGE_LABEL = STAGES.reduce(function (m, s) { m[s.id] = s; return m; }, {});
  const PRIORITY_TONE = { high: "warning", medium: "violet", low: "cyan" };

  let container = null;
  let currentId = null;
  let lastActiveEl = null;
  // AI follow-up draft state keyed by application id so re-renders keep the
  // draft visible while the user edits other fields.
  const followupDrafts = {};

  function st(value) {
    const fn = window.CBV2.sanitizeText;
    return fn ? fn(value) : String(value == null ? "" : value);
  }

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement("div");
    container.className = "drawer-root";
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-modal", "true");
    container.setAttribute("aria-hidden", "true");
    container.hidden = true;
    container.innerHTML =
      '<div class="drawer-backdrop" data-drawer-close></div>' +
      '<aside class="drawer-panel" tabindex="-1" aria-label="Application details"></aside>';
    document.body.appendChild(container);

    container.addEventListener("click", function (e) {
      if (e.target.closest("[data-drawer-close]")) close();
    });

    document.addEventListener("keydown", function (e) {
      if (!container || container.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
    });

    return container;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function formatRelative(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const diff = Math.round((Date.now() - d.getTime()) / 86400000);
    if (diff <= 0) return "today";
    if (diff === 1) return "yesterday";
    if (diff < 7) return diff + " days ago";
    if (diff < 30) return Math.round(diff / 7) + " weeks ago";
    if (diff < 365) return Math.round(diff / 30) + " months ago";
    return Math.round(diff / 365) + " years ago";
  }

  function currentStageEntry(app) {
    const history = Array.isArray(app.stageHistory) ? app.stageHistory : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i] && history[i].stage === app.stage) return history[i];
    }
    return null;
  }

  function stageStatusLine(app) {
    const meta = STAGE_LABEL[app.stage] || { label: app.stage || "Stage" };
    const entry = currentStageEntry(app);
    const when = (entry && entry.at) || app.appliedAt || "";
    if (!when) return "Current phase: " + meta.label;
    const relative = formatRelative(when);
    return meta.label + " since " + formatDate(when) + (relative ? " - " + relative : "");
  }

  function buildTimeline(app, events) {
    const items = [];
    (app.stageHistory || []).forEach(function (h) {
      const meta = STAGE_LABEL[h.stage] || { label: h.stage, tone: "cyan" };
      items.push({
        kind: "stage",
        when: h.at || "",
        tone: meta.tone,
        icon: "fa-arrow-right",
        title: "Moved to " + meta.label,
        detail: h.from ? "from " + (STAGE_LABEL[h.from] ? STAGE_LABEL[h.from].label : h.from) : "Initial stage"
      });
    });
    (events || []).forEach(function (ev) {
      const icon =
        ev.type === "interview" ? "fa-comments" :
        ev.type === "deadline"  ? "fa-flag-checkered" :
        ev.type === "followup"  ? "fa-envelope-circle-check" : "fa-calendar-day";
      const tone =
        ev.type === "interview" ? "blue" :
        ev.type === "deadline"  ? "warning" :
        ev.type === "followup"  ? "violet" : "cyan";
      items.push({
        kind: "event",
        id: ev.id,
        when: ev.date,
        tone: tone,
        icon: icon,
        title: ev.title || "Event",
        detail: ev.type ? ev.type.charAt(0).toUpperCase() + ev.type.slice(1) : ""
      });
    });
    items.sort(function (a, b) {
      return new Date(b.when).getTime() - new Date(a.when).getTime();
    });
    return items;
  }

  function renderStageMenu(current) {
    return STAGES.map(function (s) {
      const active = s.id === current ? " is-active" : "";
      return (
        '<button type="button" class="drawer-stage-btn chip ' + s.tone + active + '" ' +
        'data-set-stage="' + s.id + '">' + st(s.label) + '</button>'
      );
    }).join("");
  }

  function renderTimeline(items) {
    if (!items.length) {
      return '<p class="ai-meta drawer-timeline-empty">No activity recorded yet.</p>';
    }
    return (
      '<ol class="drawer-timeline">' +
      items.map(function (it) {
        const delBtn = it.kind === "event" && it.id
          ? '<button class="drawer-timeline-del" type="button" data-delete-event="' + st(it.id) + '" aria-label="Remove event">' +
              '<i class="fa-solid fa-xmark"></i></button>'
          : "";
        return (
          '<li class="drawer-timeline-item">' +
            '<span class="drawer-timeline-dot ' + it.tone + '">' +
              '<i class="fa-solid ' + it.icon + '" aria-hidden="true"></i>' +
            '</span>' +
            '<div class="drawer-timeline-body">' +
              '<strong class="drawer-timeline-title">' + st(it.title) + '</strong>' +
              '<span class="drawer-timeline-meta">' +
                (it.detail ? st(it.detail) + ' · ' : '') +
                st(formatDate(it.when)) +
                (formatRelative(it.when) ? ' · ' + st(formatRelative(it.when)) : '') +
              '</span>' +
            '</div>' +
            delBtn +
          '</li>'
        );
      }).join("") +
      '</ol>'
    );
  }

  function renderImportedSnapshot(app, options) {
    const helper = window.CBV2.jobNotes;
    if (!helper || typeof helper.renderImportedSnapshot !== "function") return "";
    return helper.renderImportedSnapshot(app, options || {});
  }

  function extractLineValue(notes, label) {
    const rx = new RegExp("^" + label + "\\s*:\\s*(.+)$", "im");
    const m = String(notes || "").match(rx);
    return m ? m[1].trim() : "";
  }

  function hasUsefulImportedDescription(notes) {
    const helper = window.CBV2.jobNotes;
    if (!helper || typeof helper.parseImportedNotes !== "function") return false;
    const parsed = helper.parseImportedNotes(notes);
    if (!parsed) return false;
    const desc = String(parsed.description || "").replace(/\s+/g, " ").trim();
    if (!desc || /No job description text was captured/i.test(desc)) return false;
    return desc.length >= 80;
  }

  function shouldRepairImportedNotes(app) {
    if (!app) return false;
    const notes = String(app.notes || "").trim();
    if (hasUsefulImportedDescription(notes)) return false;
    if (app.jobUrl) return true;
    if (/^Source\s*:/mi.test(notes)) return true;
    return false;
  }

  function repairImportedNotesFromSearchMemory(app) {
    if (!shouldRepairImportedNotes(app)) return app;
    const memory = window.CBV2.jobSearchMemory;
    const helper = window.CBV2.jobNotes;
    if (!memory || typeof memory.findJobForApplication !== "function") return app;
    if (!helper || typeof helper.buildImportedNotes !== "function") return app;
    const job = memory.findJobForApplication(app);
    if (!job) return app;

    const enrichedJob = Object.assign({}, job, {
      title: job.title || app.role || "",
      company: job.company || app.company || "",
      url: job.url || app.jobUrl || extractLineValue(app.notes, "Source"),
      location: job.location || extractLineValue(app.notes, "Location") || ""
    });
    const nextNotes = helper.buildImportedNotes(enrichedJob, { maxDescription: 24000 });
    if (!nextNotes || nextNotes === app.notes) return app;

    const patch = { notes: nextNotes };
    if (!app.jobUrl && enrichedJob.url) patch.jobUrl = enrichedJob.url;
    Object.assign(app, patch);
    const store = window.CBV2.store;
    if (store && typeof store.updateApplicationFields === "function" && app.id) {
      store.updateApplicationFields(app.id, patch);
    }
    return app;
  }

  function scoreRoleFit(app) {
    const intel = window.CBV2.candidateIntel;
    const store = window.CBV2.store;
    if (!intel || typeof intel.scoreApplicationFit !== "function") return null;
    try {
      const apps = store && typeof store.getApplications === "function"
        ? store.getApplications()
        : ((store && store.getAll && store.getAll().applications) || []);
      const candidate = typeof intel.build === "function" ? intel.build() : null;
      return intel.scoreApplicationFit(app, apps, candidate);
    } catch (_) {
      return null;
    }
  }

  function renderRoleList(items, emptyText, icon) {
    const list = (items || []).filter(Boolean).slice(0, 3);
    if (!list.length) {
      return '<p class="drawer-role-empty">' + st(emptyText) + '</p>';
    }
    return (
      '<ul class="drawer-role-list">' +
      list.map(function (item) {
        return '<li><i class="fa-solid ' + icon + '" aria-hidden="true"></i><span>' + st(item) + '</span></li>';
      }).join("") +
      '</ul>'
    );
  }

  function commandTone(score) {
    if (score >= 82) return "green";
    if (score >= 65) return "cyan";
    if (score >= 45) return "warning";
    return "rose";
  }

  function statusTone(status) {
    if (status === "ready") return "green";
    if (status === "partial") return "warning";
    return "rose";
  }

  function statusLabel(status) {
    if (status === "ready") return "Ready";
    if (status === "partial") return "Needs review";
    return "Missing";
  }

  function materialTag(item) {
    const tone = statusTone(item.status);
    return '<span class="chip ' + tone + '">' + st(statusLabel(item.status)) + '</span>';
  }

  function renderCommandMaterial(item) {
    const inner =
      '<i class="fa-solid ' + st(item.icon || "fa-circle-info") + '" aria-hidden="true"></i>' +
      '<span class="app-command-material-copy">' +
        '<strong>' + st(item.label) + '</strong>' +
        '<small>' + st(item.detail || "") + '</small>' +
      '</span>' +
      materialTag(item);
    const classes = "app-command-material app-command-material--" + st(item.status || "missing");
    if (item.destination && item.href) {
      return '<a class="' + classes + '" href="' + st(item.href) + '" data-role-handoff="' + st(item.destination) + '">' + inner + '</a>';
    }
    if (item.url) {
      return '<a class="' + classes + '" href="' + st(item.url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
    }
    return '<div class="' + classes + '">' + inner + '</div>';
  }

  function renderCommandPrimaryAction(next) {
    const n = next || {};
    const label = n.label || "Review application";
    const detail = n.detail || "Keep this application moving.";
    const icon = n.icon || "fa-arrow-right";
    const inner =
      '<i class="fa-solid ' + st(icon) + '" aria-hidden="true"></i>' +
      '<span><strong>' + st(label) + '</strong><small>' + st(detail) + '</small></span>';
    if (n.destination && n.href) {
      return '<a class="app-command-primary-action" href="' + st(n.href) + '" data-role-handoff="' + st(n.destination) + '">' + inner + '</a>';
    }
    if (n.stage) {
      return '<button class="app-command-primary-action" type="button" data-command-stage="' + st(n.stage) + '">' + inner + '</button>';
    }
    if (n.action === "followup") {
      return '<button class="app-command-primary-action" type="button" data-command-followup>' + inner + '</button>';
    }
    if (n.href) {
      return '<a class="app-command-primary-action" href="' + st(n.href) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
    }
    return '<div class="app-command-primary-action is-static">' + inner + '</div>';
  }

  function renderSourceTruth(source) {
    const s = source || {};
    const url = s.url
      ? '<a href="' + st(s.url) + '" target="_blank" rel="noopener noreferrer">' + st(s.host || s.url) + '</a>'
      : '<span>No source URL</span>';
    return (
      '<article class="app-command-source">' +
        '<span class="drawer-role-score-label">Source truth</span>' +
        '<strong>' + st(s.name || "Manual") + '</strong>' +
        '<p>' + st(s.method || "Manual entry") + '</p>' +
        '<div class="app-command-source-url">' + url + '</div>' +
      '</article>'
    );
  }

  function renderApplicationCommandCenter(app, events) {
    const api = window.CBV2.applicationCommand;
    if (!api || typeof api.build !== "function") return renderRoleCommandPlan(app);
    const store = window.CBV2.store;
    const all = store && typeof store.getAll === "function" ? store.getAll() : {};
    const apps = store && typeof store.getApplications === "function"
      ? store.getApplications()
      : (all.applications || []);
    const model = api.build(app, { all: all, apps: apps, events: events || [] });
    const tone = commandTone(model.readiness);
    const fit = model.fit || {};
    const fitTone = fit.band && fit.band.tone ? fit.band.tone : "cyan";
    const fitLabel = fit.band ? fit.score + "% - " + fit.band.label : "Fit pending";
    const strengths = fit.strengths || [];
    const risks = fit.risks || [];
    const sourceLabel = model.source && model.source.hasDescription ? "Posting captured" : "Needs source review";

    return (
      '<section class="drawer-section app-command-center">' +
        '<div class="app-command-head">' +
          '<div>' +
            '<span class="drawer-role-score-label">Application command center</span>' +
            '<h3 class="drawer-section-title">One workspace for this job.</h3>' +
            '<p>Job truth, probability, resume, cover letter, interview prep, notes, events, and next action stay connected here.</p>' +
          '</div>' +
          '<div class="app-command-readiness ' + tone + '">' +
            '<strong>' + st(String(model.readiness)) + '</strong>' +
            '<span>' + st(model.readinessLabel) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="app-command-grid">' +
          '<article class="app-command-next">' +
            '<div class="app-command-next-top">' +
              '<span class="chip ' + fitTone + '">' + st(fitLabel) + '</span>' +
              '<span class="chip cyan">' + st(sourceLabel) + '</span>' +
            '</div>' +
            '<span class="drawer-role-score-label">Next best action</span>' +
            renderCommandPrimaryAction(model.next) +
            '<div class="app-command-counts">' +
              '<span><strong>' + st(String(model.counts.ready)) + '</strong><small>ready</small></span>' +
              '<span><strong>' + st(String(model.counts.partial)) + '</strong><small>review</small></span>' +
              '<span><strong>' + st(String(model.counts.missing)) + '</strong><small>missing</small></span>' +
            '</div>' +
          '</article>' +
          renderSourceTruth(model.source) +
        '</div>' +
        '<div class="app-command-materials">' +
          model.materials.map(renderCommandMaterial).join("") +
        '</div>' +
        '<div class="app-command-evidence">' +
          '<article>' +
            '<span class="drawer-role-score-label">Why this can work</span>' +
            renderRoleList(strengths, "Add a fuller resume and posting to expose positive signals.", "fa-check") +
          '</article>' +
          '<article>' +
            '<span class="drawer-role-score-label">Risks to close</span>' +
            renderRoleList(risks, "No major risks detected yet.", "fa-triangle-exclamation") +
          '</article>' +
        '</div>' +
      '</section>'
    );
  }

  function renderRoleCommandPlan(app) {
    const fit = scoreRoleFit(app);
    const tone = fit && fit.band ? fit.band.tone : "cyan";
    const fitLabel = fit && fit.band
      ? fit.score + "% - " + fit.band.label
      : "Role context ready";
    const fitAction = fit && fit.band ? fit.band.action : "Activate role";
    const missing = fit && fit.missing && fit.missing.length
      ? "Close gaps around " + fit.missing.slice(0, 3).map(function (x) {
          return window.CBV2.candidateIntel && window.CBV2.candidateIntel.formatSkill
            ? window.CBV2.candidateIntel.formatSkill(x)
            : x;
        }).join(", ") + "."
      : "Tailor your resume to the captured requirements.";
    const descriptionReady = fit && fit.hasDescription ? "Posting captured" : "Add a fuller job description";
    const actions = [
      {
        destination: "resume",
        href: "#/resume",
        icon: "fa-file-lines",
        label: "Tailor resume",
        detail: missing,
        status: descriptionReady
      },
      {
        destination: "cover",
        href: "#/cover-letter",
        icon: "fa-envelope-open-text",
        label: "Draft cover letter",
        detail: "Use the same role, company, posting, and matched evidence.",
        status: "Specific draft"
      },
      {
        destination: "interview",
        href: "#/interview",
        icon: "fa-comments",
        label: "Prep interview",
        detail: "Turn the role and notes into research, questions, and a mock.",
        status: "Practice plan"
      }
    ];

    const subScores = fit && fit.subScores ? [
      { label: "Skills", value: fit.subScores.skills },
      { label: "Evidence", value: fit.subScores.evidence },
      { label: "Readiness", value: fit.subScores.readiness }
    ] : [];

    return (
      '<section class="drawer-section drawer-role-command">' +
        '<div class="drawer-role-command-head">' +
          '<div>' +
            '<h3 class="drawer-section-title">Role action workspace</h3>' +
            '<p>Make this job the active context across Resume Lab, Cover Letters, and Interview Prep.</p>' +
          '</div>' +
          '<span class="chip ' + tone + '">' + st(fitLabel) + '</span>' +
        '</div>' +
        '<div class="drawer-role-command-grid">' +
          '<article class="drawer-role-score-card">' +
            '<span class="drawer-role-score-label">Next best move</span>' +
            '<strong>' + st(fitAction) + '</strong>' +
            (subScores.length
              ? '<div class="drawer-role-bars">' + subScores.map(function (row) {
                  return '<div><span>' + st(row.label) + '</span><i><b style="width:' + Math.max(0, Math.min(100, row.value || 0)) + '%"></b></i><em>' + st(row.value || 0) + '</em></div>';
                }).join("") + '</div>'
              : '<p class="drawer-role-empty">Add a resume and job description to unlock fit diagnostics.</p>') +
          '</article>' +
          '<article class="drawer-role-evidence-card">' +
            '<div><span class="drawer-role-score-label">Matched evidence</span>' +
              renderRoleList(fit && fit.strengths, "No matched evidence yet.", "fa-check") +
            '</div>' +
            '<div><span class="drawer-role-score-label">Risks to close</span>' +
              renderRoleList(fit && fit.risks, "No major risks detected yet.", "fa-triangle-exclamation") +
            '</div>' +
          '</article>' +
        '</div>' +
        '<div class="drawer-role-action-list">' +
          actions.map(function (action) {
            return (
              '<a class="drawer-role-action" href="' + st(action.href) + '" data-role-handoff="' + st(action.destination) + '">' +
                '<i class="fa-solid ' + action.icon + '" aria-hidden="true"></i>' +
                '<span><strong>' + st(action.label) + '</strong><small>' + st(action.detail) + '</small></span>' +
                '<em>' + st(action.status) + '</em>' +
              '</a>'
            );
          }).join("") +
          '<button class="drawer-role-action drawer-role-action--button" type="button" data-role-handoff="active">' +
            '<i class="fa-solid fa-crosshairs" aria-hidden="true"></i>' +
            '<span><strong>Set active role</strong><small>Keep this context ready while you move around the app.</small></span>' +
            '<em>Pin</em>' +
          '</button>' +
        '</div>' +
      '</section>'
    );
  }

  function render(app) {
    const panel = container.querySelector(".drawer-panel");
    if (!app) {
      panel.innerHTML =
        '<header class="drawer-head">' +
          '<h2>Application not found</h2>' +
          '<button class="btn-ghost drawer-close-btn" data-drawer-close aria-label="Close">' +
            '<i class="fa-solid fa-xmark"></i></button>' +
        '</header>' +
        '<p class="ai-meta">It may have been deleted. Close this drawer and refresh.</p>';
      return;
    }

    app = repairImportedNotesFromSearchMemory(app) || app;

    const store = window.CBV2.store;
    const events = typeof store.getEventsForApplication === "function"
      ? store.getEventsForApplication(app.id)
      : (store.getAll().events || []).filter(function (e) { return e.appId === app.id; });
    const timeline = buildTimeline(app, events);

    const priorityTone = PRIORITY_TONE[app.priority] || "cyan";
    const stageTone = (STAGE_LABEL[app.stage] && STAGE_LABEL[app.stage].tone) || "cyan";
    const logoHtml = (window.CBV2.logos && window.CBV2.logos.badge)
      ? window.CBV2.logos.badge(app.company, "lg")
      : "";
    const importedSnapshot = renderImportedSnapshot(app);
    const notesEditor = importedSnapshot
      ? ""
      : '<textarea class="drawer-input drawer-input--notes" data-field="notes" rows="6" ' +
          'placeholder="Contacts, interview panel, salary band, anything you want to remember.">' +
          st(app.notes || "") + '</textarea>';

    panel.innerHTML =
      '<header class="drawer-head">' +
        '<div class="drawer-head-main">' +
          '<div class="drawer-head-id">' +
            logoHtml +
            '<div class="drawer-head-text">' +
              '<h2 class="drawer-title">' + st(app.company) + '</h2>' +
              '<p class="drawer-subtitle">' + st(app.role) + '</p>' +
            '</div>' +
          '</div>' +
          '<p class="drawer-eyebrow">' +
            '<span class="chip ' + stageTone + '">' + st((STAGE_LABEL[app.stage] || {}).label || app.stage) + '</span>' +
            '<span class="chip ' + priorityTone + '">' + st(app.priority || "medium") + ' priority</span>' +
          '</p>' +
          '<p class="drawer-applied">' + st(stageStatusLine(app)) + '</p>' +
        '</div>' +
        '<button class="btn-ghost drawer-close-btn" data-drawer-close aria-label="Close">' +
          '<i class="fa-solid fa-xmark"></i></button>' +
      '</header>' +

      renderApplicationCommandCenter(app, events) +

      (app.jobUrl
        ? '<section class="drawer-section">' +
          '<h3 class="drawer-section-title">Job posting</h3>' +
          '<p class="drawer-job-url-wrap">' +
          '<a class="btn-secondary drawer-job-url" href="' + st(app.jobUrl) + '" target="_blank" rel="noopener noreferrer">' +
          '<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open listing' +
          '<span class="visually-hidden"> (opens in new tab)</span></a>' +
          "</p></section>"
        : "") +

      '<section class="drawer-section">' +
        '<h3 class="drawer-section-title">Stage</h3>' +
        '<div class="drawer-stage-row">' + renderStageMenu(app.stage) + '</div>' +
      '</section>' +

      '<section class="drawer-section">' +
        '<h3 class="drawer-section-title">Next action</h3>' +
        '<textarea class="drawer-input" data-field="nextAction" rows="2" ' +
          'placeholder="e.g. Follow up with recruiter, tailor resume, prep interview...">' +
          st(app.nextAction || "") + '</textarea>' +
      '</section>' +

      '<section class="drawer-section drawer-section--notes">' +
        '<div class="drawer-section-head">' +
          '<h3 class="drawer-section-title">' + (importedSnapshot ? "Job details" : "Notes") + '</h3>' +
          (importedSnapshot ? '<span class="chip cyan">Captured from job board</span>' : '') +
        '</div>' +
        importedSnapshot +
        notesEditor +
      '</section>' +

      '<section class="drawer-section">' +
        '<div class="drawer-section-head">' +
          '<h3 class="drawer-section-title">Activity</h3>' +
          '<div class="drawer-section-tools">' +
            '<span class="chip cyan">' + timeline.length + ' ' + (timeline.length === 1 ? 'entry' : 'entries') + '</span>' +
            '<button class="btn-ghost drawer-mini-btn" type="button" data-toggle-event-form aria-label="Add event">' +
              '<i class="fa-solid fa-plus"></i> Add event</button>' +
          '</div>' +
        '</div>' +
        renderEventForm(app) +
        renderTimeline(timeline, events) +
      '</section>' +

      renderFollowupSection(app) +

      '<section class="drawer-section drawer-actions">' +
        '<h3 class="drawer-section-title">Quick actions</h3>' +
        '<div class="drawer-action-grid">' +
          '<a class="btn-secondary" href="#/resume" data-role-handoff="resume"><i class="fa-solid fa-file-lines"></i> Tailor resume</a>' +
          '<a class="btn-secondary" href="#/cover-letter" data-role-handoff="cover"><i class="fa-solid fa-envelope-open-text"></i> Cover letter</a>' +
          '<a class="btn-secondary" href="#/interview" data-role-handoff="interview"><i class="fa-solid fa-comments"></i> Prep interview</a>' +
          '<button class="btn-ghost drawer-danger" type="button" data-drawer-delete>' +
            '<i class="fa-solid fa-trash"></i> Delete application</button>' +
        '</div>' +
      '</section>';

    bindPanel(app);
  }

  // Inline event creation form. Hidden until the user clicks "+ Add event".
  function renderEventForm(app) {
    const today = new Date().toISOString().slice(0, 10);
    return (
      '<form class="drawer-event-form" data-event-form hidden>' +
        '<label class="drawer-event-field">' +
          '<span>Type</span>' +
          '<select name="type">' +
            '<option value="interview">Interview</option>' +
            '<option value="followup">Follow-up</option>' +
            '<option value="deadline">Deadline</option>' +
            '<option value="other">Other</option>' +
          '</select>' +
        '</label>' +
        '<label class="drawer-event-field">' +
          '<span>Date</span>' +
          '<input type="date" name="date" value="' + today + '" required />' +
        '</label>' +
        '<label class="drawer-event-field drawer-event-field--full">' +
          '<span>Title</span>' +
          '<input type="text" name="title" placeholder="e.g. On-site with ' + st(app.company) + '" required />' +
        '</label>' +
        '<div class="drawer-event-actions">' +
          '<button class="btn-primary" type="submit"><i class="fa-solid fa-check"></i> Save event</button>' +
          '<button class="btn-ghost" type="button" data-event-cancel>Cancel</button>' +
        '</div>' +
      '</form>'
    );
  }

  // Follow-up email section. Shows button until a draft is generated, then the
  // draft itself with copy/regenerate buttons.
  function renderFollowupSection(app) {
    const state = followupDrafts[app.id] || { status: "idle" };
    let inner = "";
    if (state.status === "loading") {
      inner =
        '<p class="ai-meta"><i class="fa-solid fa-spinner fa-spin"></i> ' +
        'Drafting a personalized follow-up…</p>';
    } else if (state.status === "error") {
      inner =
        '<p class="ai-error">' + st(state.error || "Couldn't draft an email.") + '</p>' +
        '<button class="btn-secondary" type="button" data-followup-run>' +
          '<i class="fa-solid fa-rotate"></i> Try again</button>';
    } else if (state.status === "ready" && state.data) {
      const d = state.data;
      const openers = (d.openers || []).map(function (o) {
        return '<li class="followup-opener" data-opener="' + st(o) + '"><i class="fa-solid fa-arrow-right-long"></i> ' + st(o) + '</li>';
      }).join("");
      inner =
        '<div class="followup-result">' +
          '<label class="drawer-event-field drawer-event-field--full">' +
            '<span>Subject</span>' +
            '<input type="text" data-followup-subject value="' + st(d.subject || "") + '" />' +
          '</label>' +
          '<label class="drawer-event-field drawer-event-field--full">' +
            '<span>Body</span>' +
            '<textarea data-followup-body rows="8">' + st(d.body || "") + '</textarea>' +
          '</label>' +
          (openers ? '<p class="drawer-section-title" style="margin-top:8px;">Alternate openers (click to swap in)</p><ul class="followup-openers">' + openers + '</ul>' : "") +
          '<div class="drawer-event-actions">' +
            '<button class="btn-primary" type="button" data-followup-copy><i class="fa-solid fa-copy"></i> Copy email</button>' +
            '<button class="btn-ghost" type="button" data-followup-run><i class="fa-solid fa-rotate"></i> Regenerate</button>' +
          '</div>' +
          (state.meta ? '<p class="ai-meta followup-meta">' + st(state.meta) + '</p>' : '') +
        '</div>';
    } else {
      inner =
        '<p class="ai-meta">Draft a concise follow-up email using the role, notes, ' +
        'and this application\'s stage history as context.</p>' +
        '<button class="btn-primary" type="button" data-followup-run>' +
          '<i class="fa-solid fa-wand-magic-sparkles"></i> Draft follow-up</button>';
    }
    return (
      '<section class="drawer-section drawer-followup">' +
        '<div class="drawer-section-head">' +
          '<h3 class="drawer-section-title">Follow-up email</h3>' +
          '<span class="chip cyan">AI</span>' +
        '</div>' +
        inner +
      '</section>'
    );
  }

  function commitField(app, field) {
    const panel = container.querySelector(".drawer-panel");
    if (!panel) return;
    const el = panel.querySelector('[data-field="' + field + '"]');
    if (!el) return;
    const value = String(el.value || "").trim();
    if ((app[field] || "") === value) return;
    const patch = {};
    patch[field] = value;
    if (typeof window.CBV2.store.updateApplicationFields === "function") {
      window.CBV2.store.updateApplicationFields(app.id, patch);
    } else {
      app[field] = value;
      window.CBV2.store.upsertApplication(app);
    }
    if (window.CBV2.toast) window.CBV2.toast.success("Saved.");
  }

  function getCurrentApp(id) {
    const store = window.CBV2.store;
    return typeof store.getApplicationById === "function"
      ? store.getApplicationById(id)
      : store.getApplications().find(function (a) { return a.id === id; });
  }

  function refresh(app) {
    render(getCurrentApp(app.id));
    if (window.CBV2.renderCurrentRoute) {
      window.CBV2.renderCurrentRoute();
    }
  }

  function bindPanel(app) {
    const panel = container.querySelector(".drawer-panel");
    if (!panel) return;

    panel.querySelectorAll("[data-set-stage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const next = btn.getAttribute("data-set-stage");
        if (!next || next === app.stage) return;
        window.CBV2.store.updateApplicationStage(app.id, next);
        refresh(app);
      });
    });

    panel.querySelectorAll("[data-field]").forEach(function (el) {
      el.addEventListener("blur", function () {
        commitField(app, el.getAttribute("data-field"));
      });
    });

    const del = panel.querySelector("[data-drawer-delete]");
    if (del) {
      del.addEventListener("click", async function () {
        // Phase 4.5: in-app modal replaces native confirm.
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Delete this application?",
              body: "This removes the application from your pipeline. Linked events stay on your calendar without the application link. This cannot be undone.",
              confirmLabel: "Delete",
              tone: "danger",
            })
          : confirm("Delete this application? This cannot be undone.");
        if (!ok) return;
        window.CBV2.store.deleteApplication(app.id);
        if (window.CBV2.toast) window.CBV2.toast.info("Application deleted.");
        close();
        if (window.CBV2.renderCurrentRoute) window.CBV2.renderCurrentRoute();
      });
    }

    bindEventForm(app);
    bindEventDeletes(app);
    bindFollowup(app);
    bindCommandCenter(app);
    bindRoleHandoffs(app);
  }

  function bindCommandCenter(app) {
    const panel = container.querySelector(".drawer-panel");
    if (!panel) return;
    panel.querySelectorAll("[data-command-stage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const stage = btn.getAttribute("data-command-stage") || "";
        if (!stage || stage === app.stage) return;
        window.CBV2.store.updateApplicationStage(app.id, stage);
        if (window.CBV2.toast) window.CBV2.toast.success("Moved to " + stage + ".");
        refresh(app);
      });
    });
    panel.querySelectorAll("[data-command-followup]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        runFollowupDraft(app);
      });
    });
  }

  function activateRoleContext(app, destination) {
    const svc = window.CBV2.roleContext;
    if (!svc || typeof svc.useApplication !== "function") return null;
    const ctx = svc.useApplication(app, {
      destination: destination || "active",
      origin: "application-drawer"
    });
    if (window.CBV2.toast && destination === "active") {
      window.CBV2.toast.success("Active role set for " + (app.company || "this company") + ".");
    }
    return ctx;
  }

  function bindRoleHandoffs(app) {
    const panel = container.querySelector(".drawer-panel");
    if (!panel) return;
    panel.querySelectorAll("[data-role-handoff]").forEach(function (el) {
      el.addEventListener("click", function () {
        const destination = el.getAttribute("data-role-handoff") || "active";
        activateRoleContext(app, destination);
        if (destination !== "active") {
          setTimeout(close, 0);
        }
      });
    });
  }

  function bindEventForm(app) {
    const panel = container.querySelector(".drawer-panel");
    const form = panel.querySelector("[data-event-form]");
    const toggle = panel.querySelector("[data-toggle-event-form]");
    const cancel = panel.querySelector("[data-event-cancel]");
    if (!form || !toggle) return;

    toggle.addEventListener("click", function () {
      form.hidden = !form.hidden;
      if (!form.hidden) {
        const titleInput = form.querySelector('input[name="title"]');
        if (titleInput) titleInput.focus();
      }
    });
    if (cancel) {
      cancel.addEventListener("click", function () {
        form.hidden = true;
        form.reset();
      });
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get("title") || "").trim();
      const date = String(fd.get("date") || "").trim();
      const type = String(fd.get("type") || "other");
      if (!title || !date) return;
      if (typeof window.CBV2.store.addEvent !== "function") {
        if (window.CBV2.toast) window.CBV2.toast.error("Events not supported in this build.");
        return;
      }
      window.CBV2.store.addEvent({
        title: title, date: date, type: type, appId: app.id
      });
      if (window.CBV2.toast) window.CBV2.toast.success("Event added.");
      refresh(app);
    });
  }

  function bindEventDeletes(app) {
    const panel = container.querySelector(".drawer-panel");
    panel.querySelectorAll("[data-delete-event]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const id = btn.getAttribute("data-delete-event");
        if (!id) return;
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Remove this event?",
              body: "The event will be removed from this application's timeline and from your calendar.",
              confirmLabel: "Remove",
              tone: "danger",
            })
          : confirm("Remove this event from the timeline?");
        if (!ok) return;
        if (typeof window.CBV2.store.deleteEvent === "function") {
          window.CBV2.store.deleteEvent(id);
          if (window.CBV2.toast) window.CBV2.toast.info("Event removed.");
          refresh(app);
        }
      });
    });
  }

  function daysSinceApplied(app) {
    if (!app.appliedAt) return null;
    const d = new Date(app.appliedAt);
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  }

  async function runFollowupDraft(app) {
    followupDrafts[app.id] = { status: "loading" };
    render(getCurrentApp(app.id));
    try {
      if (!window.CBAI || typeof window.CBAI.runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }
      const resumeBase = (window.CBV2.store.getAll().resume || {}).base || "";
      const history = (app.stageHistory || []).map(function (h) {
        return h.stage + (h.at ? " (" + String(h.at).slice(0, 10) + ")" : "");
      });
      const days = daysSinceApplied(app);
      const input = {
        company: app.company || "",
        role: app.role || "",
        stage: app.stage || "applied",
        appliedAt: app.appliedAt || "",
        daysSince: days == null ? undefined : String(days),
        notes: app.notes || "",
        history: history,
        candidate: resumeBase.slice(0, 1200),
        tone: "warm, professional",
        purpose: app.stage === "interview" ? "post-interview follow-up"
          : app.stage === "offer"    ? "thank-you and confirmation"
          : "application follow-up"
      };
      const result = await window.CBAI.runSkill("followup-email", input);
      const data = (result && result.data) || result;
      const meta = result && result.provider
        ? "Drafted with " + result.provider + " · " + Math.round((result.confidence || 0.8) * 100) + "% confidence"
        : "";
      followupDrafts[app.id] = { status: "ready", data: data, meta: meta };
    } catch (err) {
      followupDrafts[app.id] = {
        status: "error",
        error: (err && err.message) || "Couldn't draft an email."
      };
    }
    render(getCurrentApp(app.id));
  }

  function bindFollowup(app) {
    const panel = container.querySelector(".drawer-panel");
    const run = panel.querySelector("[data-followup-run]");
    if (run) {
      run.addEventListener("click", function () { runFollowupDraft(app); });
    }
    const copy = panel.querySelector("[data-followup-copy]");
    if (copy) {
      copy.addEventListener("click", function () {
        const subj = panel.querySelector("[data-followup-subject]");
        const body = panel.querySelector("[data-followup-body]");
        const text = (subj ? "Subject: " + subj.value + "\n\n" : "") + (body ? body.value : "");
        if (!text.trim()) return;
        const onCopy = function () {
          if (window.CBV2.toast) window.CBV2.toast.success("Copied to clipboard.");
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onCopy).catch(function () {
            if (window.CBV2.toast) window.CBV2.toast.error("Clipboard unavailable.");
          });
        } else {
          // Legacy fallback.
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); onCopy(); } catch (e) { /* ignore */ }
          document.body.removeChild(ta);
        }
      });
    }
    panel.querySelectorAll("[data-opener]").forEach(function (li) {
      li.addEventListener("click", function () {
        const opener = li.getAttribute("data-opener") || "";
        const body = panel.querySelector("[data-followup-body]");
        if (!body) return;
        const lines = body.value.split(/\n/);
        // Replace the first non-empty line with the chosen opener.
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].trim()) { lines[i] = opener; break; }
        }
        body.value = lines.join("\n");
        body.focus();
      });
    });
  }

  function open(appId) {
    ensureContainer();
    lastActiveEl = document.activeElement;
    currentId = appId;
    const store = window.CBV2.store;
    const app = typeof store.getApplicationById === "function"
      ? store.getApplicationById(appId)
      : store.getApplications().find(function (a) { return a.id === appId; });
    render(app);
    container.hidden = false;
    container.setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
    // Next frame to allow transition.
    requestAnimationFrame(function () {
      container.classList.add("is-open");
      const panel = container.querySelector(".drawer-panel");
      if (panel) panel.focus();
    });
  }

  function close() {
    if (!container || container.hidden) return;
    container.classList.remove("is-open");
    container.setAttribute("aria-hidden", "true");
    document.body.classList.remove("drawer-open");
    // Allow transition to finish before actually hiding.
    setTimeout(function () {
      if (container) container.hidden = true;
    }, 220);
    currentId = null;
    if (lastActiveEl && typeof lastActiveEl.focus === "function") {
      try { lastActiveEl.focus(); } catch (e) { /* ignore */ }
    }
  }

  function isOpenFor(id) {
    return currentId === id && container && !container.hidden;
  }

  window.CBV2.drawer = {
    openApplication: open,
    close: close,
    isOpenFor: isOpenFor
  };
})();
