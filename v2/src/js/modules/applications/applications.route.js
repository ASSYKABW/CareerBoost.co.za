(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const STAGES = [
    { id: "saved", label: "Saved", tone: "cyan", icon: "fa-bookmark", sla: 5 },
    { id: "applied", label: "Applied", tone: "violet", icon: "fa-paper-plane", sla: 7 },
    { id: "interview", label: "Interview", tone: "blue", icon: "fa-comments", sla: 3 },
    { id: "offer", label: "Offer", tone: "green", icon: "fa-handshake", sla: 3 },
    { id: "rejected", label: "Closed", tone: "rose", icon: "fa-circle-xmark", sla: 0 }
  ];

  const PRIORITIES = ["low", "medium", "high"];

  const PRIORITY_META = {
    low: { label: "Low", tone: "cyan", weight: 1 },
    medium: { label: "Medium", tone: "violet", weight: 2 },
    high: { label: "High", tone: "warning", weight: 3 }
  };

  const viewState = {
    filterStage: "all",
    filterPriority: "all",
    focus: "all",
    sort: "attention",
    search: "",
    // Phase 4: bulk-action multi-select.
    selectedIds: {} // map of appId -> true
  };

  function getSt() {
    return window.CBV2.sanitizeText || function (s) { return String(s == null ? "" : s); };
  }

  function escAttr(input) {
    return String(input == null ? "" : input)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "")
      .replace(/>/g, "");
  }

  function stageMeta(stageId) {
    return STAGES.find(function (s) { return s.id === stageId; }) || STAGES[0];
  }

  function priorityMeta(priority) {
    return PRIORITY_META[PRIORITIES.indexOf(priority) >= 0 ? priority : "low"];
  }

  function todayStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function daysSince(value) {
    const d = parseDate(value);
    if (!d) return null;
    return Math.max(0, Math.round((todayStart().getTime() - d.getTime()) / 86400000));
  }

  function latestStageAt(app) {
    const history = Array.isArray(app.stageHistory) ? app.stageHistory.slice() : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i] && history[i].stage === app.stage) {
        return history[i].at || app.appliedAt || "";
      }
    }
    return app.appliedAt || "";
  }

  function stageAge(app) {
    return daysSince(latestStageAt(app));
  }

  function formatAge(days) {
    if (days == null) return "No date";
    if (days === 0) return "Today";
    if (days === 1) return "1 day";
    return days + " days";
  }

  function clamp(num, min, max) {
    return Math.min(max, Math.max(min, num));
  }

  function countByStage(apps) {
    const counts = {};
    STAGES.forEach(function (s) {
      counts[s.id] = 0;
    });
    apps.forEach(function (a) {
      if (counts[a.stage] != null) {
        counts[a.stage] += 1;
      }
    });
    return counts;
  }

  function isClosed(app) {
    return app.stage === "rejected";
  }

  function defaultNextAction(app) {
    const stage = app.stage || "saved";
    if (stage === "saved") return "Tailor resume and decide whether to apply.";
    if (stage === "applied") return "Watch for response signal and plan a follow-up.";
    if (stage === "interview") return "Build interview stories and practice out loud.";
    if (stage === "offer") return "Review terms, timeline, and negotiation points.";
    if (stage === "rejected") return "Capture learnings and archive the opportunity.";
    return "Open details and define the next move.";
  }

  function nextActionText(app) {
    const text = String(app.nextAction || "").trim();
    return text || defaultNextAction(app);
  }

  function dueInfo(app) {
    if (isClosed(app)) {
      return { level: "closed", label: "Closed", tone: "rose", icon: "fa-circle-check", score: 0 };
    }
    const meta = stageMeta(app.stage);
    const age = stageAge(app);
    const priorityWeight = priorityMeta(app.priority).weight;
    if (age == null) {
      return { level: "unknown", label: "Add date", tone: "warning", icon: "fa-calendar-plus", score: 1 + priorityWeight };
    }
    if (age >= meta.sla + 4) {
      return { level: "overdue", label: "Stale " + age + "d", tone: "rose", icon: "fa-triangle-exclamation", score: 6 + priorityWeight };
    }
    if (age >= meta.sla) {
      return { level: "due", label: "Action due", tone: "warning", icon: "fa-bolt", score: 4 + priorityWeight };
    }
    if (meta.sla - age <= 2) {
      return { level: "soon", label: "Due soon", tone: "blue", icon: "fa-clock", score: 2 + priorityWeight };
    }
    return { level: "ok", label: "On track", tone: "green", icon: "fa-check", score: priorityWeight };
  }

  function signalScore(app) {
    const stageBase = {
      saved: 58,
      applied: 66,
      interview: 82,
      offer: 92,
      rejected: 34
    };
    const age = stageAge(app);
    const due = dueInfo(app);
    const p = priorityMeta(app.priority).weight;
    let score = (stageBase[app.stage] || 58) + (p - 2) * 6;
    if (due.level === "ok" || due.level === "soon") score += 3;
    if (due.level === "overdue") score -= 8;
    if (age != null && age <= 2 && app.stage !== "rejected") score += 4;
    return clamp(score, 24, 98);
  }

  // Phase 2: stage automation. When an app moves into `interview` or `applied`
  // we auto-create a calendar event so the user sees the next action without
  // touching the calendar themselves. Idempotent — skips if an equivalent
  // event already exists for this app within ±2 weeks.
  function localDayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function hasUpcomingEventForApp(appId, type) {
    const store = window.CBV2 && window.CBV2.store;
    if (!store || typeof store.getEventsForApplication !== "function") return false;
    const events = store.getEventsForApplication(appId) || [];
    const today = localDayKey(new Date());
    return events.some(function (e) {
      if (!e || e.appId !== appId) return false;
      if (type && e.type !== type) return false;
      // Future or today's event still counts — don't double-schedule.
      return e.date && e.date >= today;
    });
  }
  function autoScheduleEventsForStage(appId, stage) {
    const store = window.CBV2 && window.CBV2.store;
    if (!store || typeof store.addEvent !== "function") return;
    const apps = (typeof store.getApplications === "function" && store.getApplications()) || [];
    const app = apps.find(function (a) { return a.id === appId; });
    if (!app) return;

    const today = new Date();
    if (stage === "interview" && !hasUpcomingEventForApp(appId, "interview-prep")) {
      const prep = new Date(today.getTime() + 3 * 86400000);
      store.addEvent({
        date: localDayKey(prep),
        type: "interview-prep",
        title: "Prep · " + (app.company || "interview"),
        appId: appId,
        notes: "Auto-scheduled when this application moved to Interview. Use the Interview module to drill mock questions and review the JD."
      });
      if (window.CBV2.toast) window.CBV2.toast.info("Interview prep scheduled in 3 days.");
    } else if (stage === "applied" && !hasUpcomingEventForApp(appId, "follow-up")) {
      const fu = new Date(today.getTime() + 7 * 86400000);
      store.addEvent({
        date: localDayKey(fu),
        type: "follow-up",
        title: "Follow up · " + (app.company || "application"),
        appId: appId,
        notes: "Auto-scheduled when you moved this app to Applied. Send a polite check-in if you haven't heard back."
      });
      if (window.CBV2.toast) window.CBV2.toast.info("Follow-up scheduled in 7 days.");
    }
  }

  // Phase 2: real readiness — drives chips from applicationCommand.build()
  // so users see at a glance which materials are ready / partial / missing
  // for each application instead of static stage-keyed labels. Falls back to
  // the legacy stage-keyed chips when the command service isn't available.
  function readinessChips(app) {
    const cmd = window.CBV2 && window.CBV2.applicationCommand;
    if (cmd && typeof cmd.build === "function") {
      try {
        const built = cmd.build(app);
        if (built && Array.isArray(built.materials)) {
          // Skip "source" — it doesn't drive user action like the other 4 do.
          return built.materials
            .filter(function (m) { return m && m.id && m.id !== "source"; })
            .map(function (m) {
              const tone = m.status === "ready"
                ? "green"
                : m.status === "partial"
                ? "warning"
                : "rose";
              const label = m.label + (m.status === "ready" ? " ✓" : m.status === "partial" ? " ~" : " ·");
              return { label: label, tone: tone };
            });
        }
      } catch (e) { /* fall through to legacy chips */ }
    }
    // Legacy fallback (service not loaded).
    if (app.stage === "saved") {
      return [{ label: "Resume needed", tone: "warning" }, { label: "Apply path", tone: "cyan" }];
    }
    if (app.stage === "applied") {
      return [{ label: "Materials sent", tone: "green" }, { label: "Follow-up watch", tone: "blue" }];
    }
    if (app.stage === "interview") {
      return [{ label: "Prep required", tone: "warning" }, { label: "Story bank", tone: "violet" }];
    }
    if (app.stage === "offer") {
      return [{ label: "Decision window", tone: "green" }, { label: "Negotiation", tone: "blue" }];
    }
    return [{ label: "Archive", tone: "rose" }, { label: "Learnings", tone: "cyan" }];
  }

  function primaryRouteFor(app) {
    if (app.stage === "saved") {
      return { href: "#/resume", label: "Tailor resume", icon: "fa-file-lines" };
    }
    if (app.stage === "interview") {
      return { href: "#/interview", label: "Prep interview", icon: "fa-comments" };
    }
    if (app.stage === "applied") {
      return { href: "#/cover-letter", label: "Draft follow-up", icon: "fa-envelope-open-text" };
    }
    if (app.stage === "offer") {
      return { href: "#/applications", label: "Review offer", icon: "fa-handshake" };
    }
    return { href: "#/applications", label: "Review notes", icon: "fa-clipboard-check" };
  }

  function destinationForRoute(href) {
    const h = String(href || "");
    if (h.indexOf("cover-letter") >= 0) return "cover";
    if (h.indexOf("interview") >= 0) return "interview";
    if (h.indexOf("resume") >= 0) return "resume";
    return "active";
  }

  function hasFilters() {
    return viewState.filterStage !== "all" ||
      viewState.filterPriority !== "all" ||
      viewState.focus !== "all" ||
      viewState.search.trim() !== "";
  }

  function matchesFocus(app) {
    if (viewState.focus === "all") return true;
    if (viewState.focus === "attention") {
      const due = dueInfo(app);
      return due.level === "overdue" || due.level === "due" || due.level === "soon";
    }
    if (viewState.focus === "active") return !isClosed(app);
    if (viewState.focus === "interviews") return app.stage === "interview";
    if (viewState.focus === "high") return app.priority === "high";
    return true;
  }

  function filterApplications(apps) {
    const q = viewState.search.trim().toLowerCase();
    return apps.filter(function (app) {
      if (viewState.filterStage !== "all" && app.stage !== viewState.filterStage) return false;
      if (viewState.filterPriority !== "all" && app.priority !== viewState.filterPriority) return false;
      if (!matchesFocus(app)) return false;
      if (!q) return true;
      const haystack = [
        app.company,
        app.role,
        app.nextAction,
        app.notes
      ].join(" ").toLowerCase();
      return haystack.indexOf(q) >= 0;
    });
  }

  function sortApplications(apps) {
    const stageOrder = STAGES.reduce(function (acc, stage, index) {
      acc[stage.id] = index;
      return acc;
    }, {});
    return apps.slice().sort(function (a, b) {
      if (viewState.sort === "company") {
        return String(a.company || "").localeCompare(String(b.company || ""));
      }
      if (viewState.sort === "newest") {
        return (parseDate(b.appliedAt) || 0) - (parseDate(a.appliedAt) || 0);
      }
      if (viewState.sort === "oldest") {
        return (parseDate(a.appliedAt) || 0) - (parseDate(b.appliedAt) || 0);
      }
      const bScore = dueInfo(b).score * 10 + priorityMeta(b.priority).weight * 4 + signalScore(b) / 10;
      const aScore = dueInfo(a).score * 10 + priorityMeta(a.priority).weight * 4 + signalScore(a) / 10;
      if (bScore !== aScore) return bScore - aScore;
      return (stageOrder[a.stage] || 0) - (stageOrder[b.stage] || 0);
    });
  }

  function pipelineHealth(apps) {
    const active = apps.filter(function (a) { return !isClosed(a); });
    if (!active.length) return 0;
    const due = active.filter(function (a) {
      const level = dueInfo(a).level;
      return level === "overdue" || level === "due";
    }).length;
    const soon = active.filter(function (a) { return dueInfo(a).level === "soon"; }).length;
    const interviews = active.filter(function (a) { return a.stage === "interview"; }).length;
    const offers = active.filter(function (a) { return a.stage === "offer"; }).length;
    return clamp(84 - due * 12 - soon * 5 + interviews * 4 + offers * 5, 38, 96);
  }

  function buildPriorityActions(apps) {
    const active = apps.filter(function (app) { return !isClosed(app); });
    const ranked = active.map(function (app) {
      const due = dueInfo(app);
      const route = primaryRouteFor(app);
      let title = "Move " + (app.company || "this role") + " forward";
      let icon = "fa-bolt";
      let cta = "Open role";
      let href = "";
      let opensApp = true;
      if (app.stage === "saved") {
        title = "Convert saved role into an application";
        icon = "fa-file-lines";
        cta = route.label;
        href = route.href;
        opensApp = false;
      } else if (app.stage === "interview") {
        title = "Prepare interview pack";
        icon = "fa-comments";
        cta = route.label;
        href = route.href;
        opensApp = false;
      } else if (app.stage === "offer") {
        title = "Protect the offer window";
        icon = "fa-handshake";
      } else if (due.level === "overdue" || due.level === "due") {
        title = "Resolve the next action";
      } else if (app.priority === "high") {
        title = "Keep high-priority role warm";
      }
      return {
        app: app,
        rankScore: due.score * 12 + priorityMeta(app.priority).weight * 8 + signalScore(app) / 4,
        title: title,
        icon: icon,
        cta: cta,
        href: href,
        opensApp: opensApp,
        detail: nextActionText(app),
        due: due
      };
    }).sort(function (a, b) { return b.rankScore - a.rankScore; });

    return ranked.slice(0, 4);
  }

  function renderCommandCenter(apps, counts) {
    const st = getSt();
    const active = apps.filter(function (a) { return !isClosed(a); });
    const dueNow = active.filter(function (a) {
      const level = dueInfo(a).level;
      return level === "overdue" || level === "due";
    }).length;
    const interviews = counts.interview || 0;
    const health = pipelineHealth(apps);
    const healthCopy = health >= 82
      ? "Your pipeline has strong movement. Keep the next actions clean."
      : health >= 64
        ? "The pipeline is active, but a few roles need attention."
        : "Your pipeline needs sharper next actions and follow-through.";

    return `
      <section class="pipeline-command-center">
        <div class="pipeline-command-copy">
          <p class="eyebrow">Pipeline command center</p>
          <h1 class="page-title">Turn every opportunity into a clear next move.</h1>
          <p class="page-subtitle">Track roles, see what is stuck, and move the highest-value applications forward before momentum fades.</p>
          <div class="pipeline-command-actions">
            <button class="btn-primary js-open-add-app" type="button"><i class="fa-solid fa-plus"></i> Add application</button>
            <a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Find roles</a>
            <a class="btn-secondary" href="#/analytics"><i class="fa-solid fa-chart-line"></i> View analytics</a>
          </div>
        </div>
        <aside class="pipeline-score-panel" aria-label="Pipeline health">
          <div class="pipeline-score-ring" style="--pipeline-score: ${health}">
            <strong>${health}</strong>
            <span>Health</span>
          </div>
          <div class="pipeline-score-copy">
            <span class="chip ${dueNow ? "warning" : "green"}"><i class="fa-solid ${dueNow ? "fa-bolt" : "fa-check"}"></i> ${dueNow ? st(dueNow + " due") : "Clear"}</span>
            <h2>${st(healthCopy)}</h2>
            <p>${active.length} active role${active.length === 1 ? "" : "s"} across ${interviews} interview stage${interviews === 1 ? "" : "s"}.</p>
          </div>
          <div class="pipeline-score-mini">
            <span><strong>${active.length}</strong><small>Active</small></span>
            <span><strong>${dueNow}</strong><small>Due now</small></span>
            <span><strong>${counts.offer || 0}</strong><small>Offers</small></span>
          </div>
        </aside>
      </section>
    `;
  }

  function renderPriorityActions(apps) {
    const st = getSt();
    const actions = buildPriorityActions(apps);
    const cards = actions.length ? actions.map(function (item, index) {
      const app = item.app;
      const route = primaryRouteFor(app);
      const ctaIcon = item.opensApp ? "fa-arrow-up-right-from-square" : route.icon;
      const shell = item.opensApp
        ? '<button class="pipeline-action-card" type="button" data-action="open" data-app-id="' + escAttr(app.id) + '">'
        : '<a class="pipeline-action-card" href="' + escAttr(item.href || route.href) + '">';
      const closeShell = item.opensApp ? "</button>" : "</a>";
      return (
        shell +
          '<span class="pipeline-action-rank">0' + (index + 1) + "</span>" +
          '<i class="fa-solid ' + escAttr(item.icon) + '"></i>' +
          '<div class="pipeline-action-copy">' +
            '<span class="chip ' + escAttr(item.due.tone) + '"><i class="fa-solid ' + escAttr(item.due.icon) + '"></i> ' + st(item.due.label) + "</span>" +
            "<strong>" + st(item.title) + "</strong>" +
            "<small>" + st(app.company || "Company") + " - " + st(app.role || "Role") + "</small>" +
            "<p>" + st(item.detail) + "</p>" +
          "</div>" +
          '<span class="pipeline-action-cta">' + st(item.cta) + ' <i class="fa-solid ' + escAttr(ctaIcon) + '"></i></span>' +
        closeShell
      );
    }).join("") : `
      <article class="pipeline-action-card pipeline-action-card--empty">
        <i class="fa-solid fa-circle-check"></i>
        <div class="pipeline-action-copy">
          <span class="chip green">No urgent work</span>
          <strong>Your active roles are organized.</strong>
          <p>Add a new application or review closed roles when you are ready.</p>
        </div>
      </article>`;

    return `
      <section class="pipeline-action-board">
        <div class="pipeline-section-heading">
          <div>
            <p class="eyebrow">Today</p>
            <h2>Priority moves</h2>
          </div>
          <p class="ai-meta">Ranked by stage age, priority, and pipeline signal.</p>
        </div>
        <div class="pipeline-action-grid">${cards}</div>
      </section>
    `;
  }

  function renderMomentumStrip(apps, counts) {
    const st = getSt();
    const maxCount = Math.max(1, ...STAGES.map(function (s) { return counts[s.id] || 0; }));
    const cards = STAGES.map(function (stage) {
      const stageApps = apps.filter(function (a) { return a.stage === stage.id; });
      const ages = stageApps.map(stageAge).filter(function (d) { return d != null; });
      const avgAge = ages.length ? Math.round(ages.reduce(function (sum, d) { return sum + d; }, 0) / ages.length) : null;
      const dueCount = stageApps.filter(function (app) {
        const level = dueInfo(app).level;
        return level === "overdue" || level === "due";
      }).length;
      const pct = Math.max(6, Math.round(((counts[stage.id] || 0) / maxCount) * 100));
      return `
        <article class="pipeline-stage-metric">
          <div>
            <span class="chip ${stage.tone}"><i class="fa-solid ${stage.icon}"></i> ${st(stage.label)}</span>
            <strong>${counts[stage.id] || 0}</strong>
          </div>
          <div class="pipeline-stage-bar"><i style="width:${pct}%"></i></div>
          <small>${avgAge == null ? "No age data" : "Avg " + formatAge(avgAge)}${dueCount ? " - " + dueCount + " due" : ""}</small>
        </article>
      `;
    }).join("");

    return `
      <section class="pipeline-momentum-strip" aria-label="Pipeline stage momentum">
        ${cards}
      </section>
    `;
  }

  function renderToolbar() {
    const st = getSt();
    const stageButtons = [
      { id: "all", label: "All stages" }
    ].concat(STAGES.map(function (stage) {
      return { id: stage.id, label: stage.label };
    })).map(function (item) {
      return '<button type="button" class="chip-btn ' + (viewState.filterStage === item.id ? "is-active" : "") + '" data-pipeline-stage-filter="' + escAttr(item.id) + '">' + st(item.label) + "</button>";
    }).join("");

    const focusButtons = [
      { id: "all", label: "All" },
      { id: "attention", label: "Needs action" },
      { id: "active", label: "Active" },
      { id: "interviews", label: "Interviews" },
      { id: "high", label: "High priority" }
    ].map(function (item) {
      return '<button type="button" class="chip-btn ' + (viewState.focus === item.id ? "is-active" : "") + '" data-pipeline-focus="' + escAttr(item.id) + '">' + st(item.label) + "</button>";
    }).join("");

    return `
      <section class="pipeline-toolbar" aria-label="Pipeline controls">
        <form class="pipeline-search" id="pipeline-search-form">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input id="pipeline-search-input" type="search" value="${escAttr(viewState.search)}" placeholder="Search company, role, notes, or next action" />
          <button class="btn-secondary" type="submit">Search</button>
        </form>
        <div class="pipeline-toolbar-row">
          <div class="pipeline-filter-group" aria-label="Filter by stage">${stageButtons}</div>
          <div class="pipeline-selects">
            <label>
              <span>Priority</span>
              <select id="pipeline-priority-filter">
                <option value="all"${viewState.filterPriority === "all" ? " selected" : ""}>All</option>
                ${PRIORITIES.map(function (p) {
                  return '<option value="' + p + '"' + (viewState.filterPriority === p ? " selected" : "") + ">" + st(priorityMeta(p).label) + "</option>";
                }).join("")}
              </select>
            </label>
            <label>
              <span>Sort</span>
              <select id="pipeline-sort">
                <option value="attention"${viewState.sort === "attention" ? " selected" : ""}>Attention first</option>
                <option value="newest"${viewState.sort === "newest" ? " selected" : ""}>Newest first</option>
                <option value="oldest"${viewState.sort === "oldest" ? " selected" : ""}>Oldest first</option>
                <option value="company"${viewState.sort === "company" ? " selected" : ""}>Company A-Z</option>
              </select>
            </label>
            <button class="btn-ghost" id="pipeline-clear-filters" type="button"${hasFilters() ? "" : " disabled"}>Clear</button>
          </div>
        </div>
        <div class="pipeline-filter-group pipeline-filter-group--focus" aria-label="Focus filter">${focusButtons}</div>
      </section>
    `;
  }

  function renderCard(app) {
    const st = getSt();
    const priority = priorityMeta(app.priority);
    const due = dueInfo(app);
    const age = stageAge(app);
    const score = signalScore(app);
    const logo = (window.CBV2.logos && window.CBV2.logos.badge)
      ? window.CBV2.logos.badge(app.company, "sm")
      : "";
    const chips = readinessChips(app).map(function (chip) {
      return '<span class="pipeline-ready-chip ' + escAttr(chip.tone) + '">' + st(chip.label) + "</span>";
    }).join("");
    const route = primaryRouteFor(app);
    const checked = viewState.selectedIds[app.id] ? " checked" : "";
    return `
      <article class="app-card pipeline-app-card${checked ? " is-selected" : ""}" draggable="true" data-app-id="${escAttr(app.id)}" tabindex="0" role="button" aria-label="Open ${escAttr(app.company)} - ${escAttr(app.role)}">
        <div class="app-card-head">
          <label class="app-card-select" title="Select for bulk actions">
            <input type="checkbox" data-action="select" data-app-id="${escAttr(app.id)}"${checked} aria-label="Select ${escAttr(app.company)}" />
          </label>
          <div class="app-card-id">
            ${logo}
            <strong>${st(app.company)}</strong>
          </div>
          <span class="chip ${priority.tone}">${st(priority.label)}</span>
        </div>
        <p class="app-role">${st(app.role)}</p>
        <div class="pipeline-card-meta">
          <span><i class="fa-solid fa-hourglass-half"></i> ${st(formatAge(age))} in stage</span>
          <span><i class="fa-solid fa-calendar"></i> ${st(app.appliedAt || "No date")}</span>
        </div>
        <div class="pipeline-card-action">
          <span class="chip ${due.tone}"><i class="fa-solid ${due.icon}"></i> ${st(due.label)}</span>
          <p>${st(nextActionText(app))}</p>
        </div>
        <div class="pipeline-card-signal">
          <span>${score}% signal</span>
          <i style="width:${score}%"></i>
        </div>
        <div class="pipeline-ready-row">${chips}</div>
        <div class="app-card-actions">
          <a class="btn-ghost pipeline-card-route" href="${escAttr(route.href)}" data-action="route" data-app-id="${escAttr(app.id)}" data-role-handoff="${escAttr(destinationForRoute(route.href))}" aria-label="${escAttr(route.label)}">
            <i class="fa-solid ${escAttr(route.icon)}"></i>
          </a>
          ${renderApplyAssistButton(app)}
          <button class="btn-ghost" data-action="open" data-app-id="${escAttr(app.id)}" type="button" aria-label="Open details">
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </button>
          <button class="btn-ghost" data-action="delete" data-app-id="${escAttr(app.id)}" type="button" aria-label="Delete">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </article>
    `;
  }

  // ----- Apply Assist (Phase 2c) ---------------------------------------
  //
  // Renders the per-card Apply Assist button. Always present so the user
  // can discover the feature, but enabled only when CBV2.applyAssist.
  // isReadyForJob(app) returns ready:true. The decision label becomes
  // the tooltip when disabled, so the user understands what's missing.
  function renderApplyAssistButton(app) {
    const aa = window.CBV2 && window.CBV2.applyAssist;
    if (!aa || typeof aa.isReadyForJob !== "function") return "";
    const decision = aa.isReadyForJob(app);
    const enabled = !!decision.ready;
    const tip = enabled ? "Apply Assist (auto-fill the form)" : (decision.label || "Apply Assist unavailable");
    const cls = enabled ? "btn-ghost pipeline-apply-assist" : "btn-ghost pipeline-apply-assist is-disabled";
    return (
      '<button class="' + cls + '" type="button"' +
      ' data-action="apply-assist" data-app-id="' + escAttr(app.id) + '"' +
      (enabled ? "" : " disabled") +
      ' title="' + escAttr(tip) + '" aria-label="' + escAttr(tip) + '">' +
      '<i class="fa-solid fa-paper-plane"></i>' +
      "</button>"
    );
  }

  function bindApplyAssist() {
    const buttons = document.querySelectorAll('[data-action="apply-assist"][data-app-id]');
    buttons.forEach(function (btn) {
      btn.addEventListener("click", async function (event) {
        event.stopPropagation();
        if (btn.disabled) return;
        const id = btn.getAttribute("data-app-id");
        const app = window.CBV2.store.getApplicationById(id);
        if (!app) return;
        const aa = window.CBV2 && window.CBV2.applyAssist;
        const toast = window.CBV2 && window.CBV2.toast;
        if (!aa || typeof aa.launch !== "function") {
          if (toast) toast.error("Apply Assist module not loaded.");
          return;
        }
        // Anti-double-click guard while we hand off to the extension.
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
          const result = await aa.launch(app);
          if (result.ok) {
            if (toast) toast.success("Apply tab opening — Apply Assist will auto-fill it.");
          } else {
            const msg = result.error || "Apply Assist could not start.";
            if (toast) {
              if (result.reason === "complete-apply-profile") {
                toast.info(msg + " Settings → Apply Assist.");
              } else if (result.reason === "no-resume") {
                toast.info(msg + " Resume Lab.");
              } else if (result.reason === "no-extension") {
                toast.error(msg);
              } else {
                toast.error(msg);
              }
            }
          }
        } catch (err) {
          if (toast) toast.error((err && err.message) || "Apply Assist threw an error.");
        } finally {
          btn.innerHTML = original;
          btn.disabled = false;
        }
      });
    });
  }

  function renderColumn(stage, filteredApps, allApps) {
    const st = getSt();
    const stageAll = allApps.filter(function (a) { return a.stage === stage.id; });
    const visible = filteredApps.filter(function (a) { return a.stage === stage.id; });
    const ages = stageAll.map(stageAge).filter(function (d) { return d != null; });
    const avgAge = ages.length ? Math.round(ages.reduce(function (sum, d) { return sum + d; }, 0) / ages.length) : null;
    const dueCount = stageAll.filter(function (app) {
      const level = dueInfo(app).level;
      return level === "overdue" || level === "due";
    }).length;
    const cards = visible.map(renderCard).join("") ||
      '<p class="pipeline-drop-empty">' + (hasFilters() ? "No matching applications here" : "Drop applications here") + "</p>";
    return `
      <section class="kanban-col pipeline-kanban-col" data-stage="${escAttr(stage.id)}">
        <header class="kanban-col-head">
          <div>
            <span class="chip ${stage.tone}"><i class="fa-solid ${stage.icon}"></i> ${st(stage.label)}</span>
            <small>${avgAge == null ? "No age data" : "Avg " + formatAge(avgAge)}${dueCount ? " - " + dueCount + " due" : ""}</small>
          </div>
          <span class="count">${visible.length}${visible.length !== stageAll.length ? "/" + stageAll.length : ""}</span>
        </header>
        <div class="kanban-col-body" data-dropzone="${escAttr(stage.id)}">
          ${cards}
        </div>
      </section>
    `;
  }

  function renderEmptyState() {
    return `
      <section class="pipeline-empty-wrap">
        <div class="empty-state empty-state--pipeline">
          <div class="empty-state-head">
            <div class="empty-state-icon"><i class="fa-solid fa-list-check"></i></div>
            <div>
              <h3>Build a job-search pipeline that tells you what to do next.</h3>
              <p>Add a saved role, an application, or an interview. CareerBoost will start tracking stage age, follow-up risk, and next-best actions.</p>
            </div>
          </div>
          <div class="empty-state-actions empty-state-actions--pipeline">
            <button class="btn-primary js-open-add-app" type="button"><i class="fa-solid fa-plus"></i> Add first application</button>
            <a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Import from Job Search</a>
          </div>
        </div>
      </section>
    `;
  }

  function renderAddForm() {
    return `
      <section class="card panel-lg pipeline-add-form" id="add-app-form-wrap" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">New opportunity</p>
            <h2>Add Application</h2>
          </div>
          <button class="btn-ghost" id="close-add-app" type="button"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <form id="add-app-form" class="form-grid">
          <label>Company<input name="company" required /></label>
          <label>Role<input name="role" required /></label>
          <label>Stage
            <select name="stage">
              ${STAGES.map(function (s) {
                return '<option value="' + s.id + '">' + s.label + "</option>";
              }).join("")}
            </select>
          </label>
          <label>Priority
            <select name="priority">
              ${PRIORITIES.map(function (p) {
                return '<option value="' + p + '">' + priorityMeta(p).label + "</option>";
              }).join("")}
            </select>
          </label>
          <label>Applied Date<input type="date" name="appliedAt" /></label>
          <label class="form-row-full">Job posting URL
            <input type="url" name="jobUrl" placeholder="https://boards.greenhouse.io/company/jobs/12345 (optional, unlocks Apply Assist)" />
          </label>
          <label class="form-row-full">Next Action<input name="nextAction" placeholder="Follow up, tailor resume, prep interview..." /></label>
          <label class="form-row-full">Notes<textarea name="notes" rows="2"></textarea></label>
          <div class="form-actions">
            <button class="btn-primary" type="submit">Save Application</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderView() {
    const apps = window.CBV2.store.getApplications();
    const counts = countByStage(apps);
    const filteredApps = sortApplications(filterApplications(apps));
    const boardStages = viewState.filterStage === "all"
      ? STAGES
      : STAGES.filter(function (s) { return s.id === viewState.filterStage; });
    const columns = boardStages.map(function (s) {
      return renderColumn(s, filteredApps, apps);
    }).join("");

    if (!apps.length) {
      return `
        <section class="page-container applications-page applications-command-page">
          ${renderCommandCenter(apps, counts)}
          ${renderEmptyState()}
          ${renderAddForm()}
        </section>
      `;
    }

    return `
      <section class="page-container applications-page applications-command-page">
        ${renderCommandCenter(apps, counts)}
        ${renderPriorityActions(apps)}
        ${renderMomentumStrip(apps, counts)}
        ${renderToolbar()}
        ${renderBulkActionBar(apps)}
        <section class="pipeline-board-shell">
          <div class="pipeline-section-heading">
            <div>
              <p class="eyebrow">Board</p>
              <h2>Application flow</h2>
            </div>
            <p class="ai-meta">${filteredApps.length} visible of ${apps.length} total</p>
          </div>
          <section class="kanban pipeline-kanban" id="kanban-board">
            ${columns}
          </section>
        </section>
        ${renderAddForm()}
      </section>
    `;
  }

  // Phase 4: floating bulk-action bar. Appears only when ≥1 card is selected.
  // Lets users move/delete several apps at once instead of card-by-card.
  function renderBulkActionBar(apps) {
    const ids = Object.keys(viewState.selectedIds).filter(function (id) {
      return viewState.selectedIds[id];
    });
    if (!ids.length) return "";
    const st = getSt();
    // Cull selected IDs that no longer exist (defensive — e.g. after a delete).
    const liveSet = {};
    apps.forEach(function (a) { liveSet[a.id] = true; });
    const live = ids.filter(function (id) { return liveSet[id]; });
    if (live.length !== ids.length) {
      ids.forEach(function (id) { if (!liveSet[id]) delete viewState.selectedIds[id]; });
    }
    const stageButtons = STAGES.map(function (s) {
      return (
        '<button type="button" class="btn-ghost btn-sm bulk-stage" data-bulk-stage="' + escAttr(s.id) + '" title="Move ' + live.length + ' to ' + escAttr(s.label) + '">' +
          '<i class="fa-solid ' + escAttr(s.icon) + '"></i> ' + st(s.label) +
        '</button>'
      );
    }).join("");
    return (
      '<aside class="pipeline-bulkbar" role="toolbar" aria-label="Bulk actions">' +
        '<div class="pipeline-bulkbar-summary">' +
          '<strong>' + live.length + '</strong> selected' +
        '</div>' +
        '<div class="pipeline-bulkbar-actions">' +
          '<span class="pipeline-bulkbar-label">Move to:</span>' +
          stageButtons +
          '<button type="button" class="btn-ghost btn-sm pipeline-bulkbar-priority" data-bulk-priority="high" title="Set high priority"><i class="fa-solid fa-bolt"></i> High</button>' +
          '<button type="button" class="btn-ghost btn-sm pipeline-bulkbar-priority" data-bulk-priority="medium" title="Set medium priority"><i class="fa-solid fa-bolt"></i> Medium</button>' +
          '<button type="button" class="btn-ghost btn-sm pipeline-bulkbar-priority" data-bulk-priority="low" title="Set low priority"><i class="fa-solid fa-bolt"></i> Low</button>' +
          '<button type="button" class="btn-ghost btn-sm pipeline-bulkbar-delete" data-bulk-delete="1"><i class="fa-solid fa-trash"></i> Delete</button>' +
          '<button type="button" class="btn-ghost btn-sm pipeline-bulkbar-clear" data-bulk-clear="1"><i class="fa-solid fa-xmark"></i> Clear</button>' +
        '</div>' +
      '</aside>'
    );
  }

  function bindDragAndDrop() {
    const cards = document.querySelectorAll(".app-card[data-app-id]");
    cards.forEach(function (card) {
      card.addEventListener("dragstart", function (event) {
        event.dataTransfer.setData("text/plain", card.getAttribute("data-app-id"));
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", function () {
        card.classList.remove("dragging");
      });
    });

    const dropzones = document.querySelectorAll("[data-dropzone]");
    dropzones.forEach(function (zone) {
      zone.addEventListener("dragover", function (event) {
        event.preventDefault();
        zone.classList.add("drop-hover");
      });
      zone.addEventListener("dragleave", function () {
        zone.classList.remove("drop-hover");
      });
      zone.addEventListener("drop", function (event) {
        event.preventDefault();
        zone.classList.remove("drop-hover");
        const id = event.dataTransfer.getData("text/plain");
        const stage = zone.getAttribute("data-dropzone");
        if (id && stage) {
          window.CBV2.store.updateApplicationStage(id, stage);
          // Phase 2: stage automation — auto-create interview prep / follow-up
          // events when the app moves into the relevant stage. Idempotent:
          // skips if an equivalent event already exists for this app.
          autoScheduleEventsForStage(id, stage);
          window.CBV2.renderCurrentRoute();
        }
      });
    });
  }

  function bindDelete() {
    const buttons = document.querySelectorAll('[data-action="delete"][data-app-id]');
    buttons.forEach(function (btn) {
      btn.addEventListener("click", async function (event) {
        event.stopPropagation();
        const id = btn.getAttribute("data-app-id");
        // Phase 4.5: in-app modal replaces native confirm.
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Delete this application?",
              body: "This removes the record from your pipeline. Linked events stay on your calendar without the application link.",
              confirmLabel: "Delete",
              tone: "danger",
            })
          : confirm("Delete this application?");
        if (ok) {
          window.CBV2.store.deleteApplication(id);
          window.CBV2.renderCurrentRoute();
        }
      });
    });
  }

  function bindCardOpen() {
    const cards = document.querySelectorAll(".app-card[data-app-id]");
    cards.forEach(function (card) {
      const id = card.getAttribute("data-app-id");
      card.addEventListener("click", function (event) {
        if (event.target.closest("[data-action]")) return;
        if (card.classList.contains("dragging")) return;
        if (window.CBV2.drawer) window.CBV2.drawer.openApplication(id);
      });
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (window.CBV2.drawer) window.CBV2.drawer.openApplication(id);
        }
      });
    });

    const openButtons = document.querySelectorAll('[data-action="open"][data-app-id]');
    openButtons.forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        const id = btn.getAttribute("data-app-id");
        if (window.CBV2.drawer) window.CBV2.drawer.openApplication(id);
      });
    });
  }

  function bindRoleHandoffs() {
    const store = window.CBV2.store;
    const svc = window.CBV2.roleContext;
    if (!svc || typeof svc.useApplication !== "function") return;
    document.querySelectorAll('[data-action="route"][data-app-id]').forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.stopPropagation();
        const id = link.getAttribute("data-app-id");
        const destination = link.getAttribute("data-role-handoff") || "active";
        const app = typeof store.getApplicationById === "function"
          ? store.getApplicationById(id)
          : (store.getApplications() || []).find(function (x) { return x.id === id; });
        if (app) {
          svc.useApplication(app, { destination: destination, origin: "pipeline-card" });
        }
      });
    });
  }

  function bindPipelineControls() {
    const rerender = function () {
      window.CBV2.renderCurrentRoute();
    };

    document.querySelectorAll("[data-pipeline-stage-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        viewState.filterStage = btn.getAttribute("data-pipeline-stage-filter") || "all";
        rerender();
      });
    });

    document.querySelectorAll("[data-pipeline-focus]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        viewState.focus = btn.getAttribute("data-pipeline-focus") || "all";
        rerender();
      });
    });

    const priority = document.getElementById("pipeline-priority-filter");
    if (priority) {
      priority.addEventListener("change", function () {
        viewState.filterPriority = priority.value || "all";
        rerender();
      });
    }

    const sort = document.getElementById("pipeline-sort");
    if (sort) {
      sort.addEventListener("change", function () {
        viewState.sort = sort.value || "attention";
        rerender();
      });
    }

    const form = document.getElementById("pipeline-search-form");
    const input = document.getElementById("pipeline-search-input");
    if (form && input) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        viewState.search = input.value || "";
        rerender();
      });
    }

    const clear = document.getElementById("pipeline-clear-filters");
    if (clear) {
      clear.addEventListener("click", function () {
        viewState.filterStage = "all";
        viewState.filterPriority = "all";
        viewState.focus = "all";
        viewState.search = "";
        rerender();
      });
    }
  }

  function bindAddForm() {
    const openBtns = document.querySelectorAll(".js-open-add-app");
    const closeBtn = document.getElementById("close-add-app");
    const wrap = document.getElementById("add-app-form-wrap");
    const form = document.getElementById("add-app-form");

    if (openBtns.length && wrap) {
      openBtns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          wrap.hidden = false;
          wrap.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    }
    if (closeBtn && wrap) {
      closeBtn.addEventListener("click", function () {
        wrap.hidden = true;
      });
    }
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        const fd = new FormData(form);
        const newApp = {
          id: window.CBV2.createId("app"),
          company: String(fd.get("company") || "").trim(),
          role: String(fd.get("role") || "").trim(),
          stage: String(fd.get("stage") || "saved"),
          priority: String(fd.get("priority") || "medium"),
          appliedAt: String(fd.get("appliedAt") || ""),
          // Optional but high-leverage: a job URL unlocks Apply Assist on
          // supported ATSes and lets analytics group runs by source host.
          jobUrl: String(fd.get("jobUrl") || "").trim(),
          nextAction: String(fd.get("nextAction") || ""),
          notes: String(fd.get("notes") || "")
        };
        if (!newApp.company || !newApp.role) {
          return;
        }
        window.CBV2.store.upsertApplication(newApp);
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  // Phase 4: bulk-action wiring. Per-card checkbox toggles selection state;
  // the floating bar at the top of the kanban dispatches the chosen action
  // against every selected app in one batch then re-renders.
  function bindBulkActions() {
    document.querySelectorAll('input[data-action="select"][data-app-id]').forEach(function (cb) {
      cb.addEventListener("click", function (event) {
        // Stop the click from bubbling to the card-open handler.
        event.stopPropagation();
      });
      cb.addEventListener("change", function () {
        const id = cb.getAttribute("data-app-id");
        if (!id) return;
        if (cb.checked) viewState.selectedIds[id] = true;
        else delete viewState.selectedIds[id];
        window.CBV2.renderCurrentRoute();
      });
    });

    function selectedAppIds() {
      return Object.keys(viewState.selectedIds).filter(function (id) {
        return viewState.selectedIds[id];
      });
    }

    document.querySelectorAll("[data-bulk-stage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const stage = btn.getAttribute("data-bulk-stage");
        const ids = selectedAppIds();
        if (!stage || !ids.length) return;
        ids.forEach(function (id) {
          window.CBV2.store.updateApplicationStage(id, stage);
          // Reuse Phase 2 stage automation so bulk moves also schedule events.
          autoScheduleEventsForStage(id, stage);
        });
        if (window.CBV2.toast) window.CBV2.toast.success("Moved " + ids.length + " to " + stage + ".");
        viewState.selectedIds = {};
        window.CBV2.renderCurrentRoute();
      });
    });

    document.querySelectorAll("[data-bulk-priority]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const pri = btn.getAttribute("data-bulk-priority");
        const ids = selectedAppIds();
        if (!pri || !ids.length) return;
        const store = window.CBV2.store;
        ids.forEach(function (id) {
          if (typeof store.updateApplication === "function") {
            store.updateApplication(id, { priority: pri });
          }
        });
        if (window.CBV2.toast) window.CBV2.toast.success("Set priority " + pri + " on " + ids.length + ".");
        viewState.selectedIds = {};
        window.CBV2.renderCurrentRoute();
      });
    });

    const deleteBtn = document.querySelector("[data-bulk-delete]");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async function () {
        const ids = selectedAppIds();
        if (!ids.length) return;
        // Phase 4.5: in-app modal replaces native confirm for bulk delete.
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Delete " + ids.length + " application" + (ids.length === 1 ? "" : "s") + "?",
              body: "This removes " + ids.length + " record" + (ids.length === 1 ? "" : "s") + " from your pipeline. Linked events stay on your calendar. This can't be undone.",
              confirmLabel: "Delete all",
              tone: "danger",
            })
          : confirm("Delete " + ids.length + " application" + (ids.length === 1 ? "" : "s") + "? This can't be undone.");
        if (!ok) return;
        ids.forEach(function (id) { window.CBV2.store.deleteApplication(id); });
        if (window.CBV2.toast) window.CBV2.toast.success("Deleted " + ids.length + " application" + (ids.length === 1 ? "" : "s") + ".");
        viewState.selectedIds = {};
        window.CBV2.renderCurrentRoute();
      });
    }

    const clearBtn = document.querySelector("[data-bulk-clear]");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        viewState.selectedIds = {};
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  window.CBV2.routes.applications = renderView;
  window.CBV2.afterRender.applications = function (params) {
    bindDragAndDrop();
    bindDelete();
    bindCardOpen();
    bindApplyAssist();
    bindRoleHandoffs();
    bindPipelineControls();
    bindAddForm();
    bindBulkActions();
    if (params && params.add === "1") {
      const wrap = document.getElementById("add-app-form-wrap");
      if (wrap) {
        wrap.hidden = false;
        wrap.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  };
})();
