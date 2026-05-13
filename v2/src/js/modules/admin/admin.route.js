(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  // Phase A: backend's ADMIN_ROLES env is the source of truth. After the first
  // successful admin-overview call we mirror access.allowedRoles. Until then,
  // the hardcoded list serves as a degraded-mode default for the menu gate.
  // (Real access control is server-side — this list is UX only.)
  function adminRoles() {
    const cfg = window.CB_CONFIG || {};
    const adminAccess = cfg.adminAccess && typeof cfg.adminAccess === "object" ? cfg.adminAccess : {};
    const serverAllowed = adminRemote.data && adminRemote.data.access && Array.isArray(adminRemote.data.access.allowedRoles)
      ? adminRemote.data.access.allowedRoles
      : [];
    return []
      .concat(serverAllowed)
      .concat(adminAccess.roles || [])
      .concat(["admin", "owner", "developer"])
      .map(function (x) { return String(x || "").toLowerCase().trim(); })
      .filter(function (x, i, arr) { return x && arr.indexOf(x) === i; });
  }
  const sections = [
    {
      group: "Analytics",
      items: [
        { id: "overview", icon: "fa-chart-pie", label: "Overview" },
        { id: "usage", icon: "fa-wave-square", label: "Usage & engagement" },
        { id: "funnel", icon: "fa-filter-circle-dollar", label: "Funnel analytics" }
      ]
    },
    {
      group: "Management",
      items: [
        { id: "users", icon: "fa-users", label: "User accounts" },
        { id: "user-support", icon: "fa-user-check", label: "User support" },
        { id: "job-feed", icon: "fa-magnifying-glass-chart", label: "Job feed health", badge: "Live" }
      ]
    },
    {
      group: "Product Health",
      items: [
        { id: "ai-cost", icon: "fa-wand-magic-sparkles", label: "AI cost monitor" },
        { id: "extension", icon: "fa-puzzle-piece", label: "Extension health" },
        { id: "sync", icon: "fa-arrows-rotate", label: "Sync health" }
      ]
    },
    {
      group: "System",
      items: [
        { id: "risk-center", icon: "fa-shield-virus", label: "Risk center" },
        { id: "reports", icon: "fa-file-export", label: "Reports & audit" },
        { id: "logs", icon: "fa-list-check", label: "System logs" },
        { id: "settings", icon: "fa-sliders", label: "Admin settings" }
      ]
    }
  ];

  function st(value) {
    const sanitize = window.CBV2.sanitizeText || function (x) { return String(x == null ? "" : x); };
    return sanitize(value);
  }

  const ADMIN_METRICS_TTL_MS = 60 * 1000;
  const adminRemote = {
    status: "idle",
    data: null,
    error: "",
    loadedAt: 0,
    inFlight: false
  };

  // Phase B: separate paginated cache for the Users + User Support sections.
  // Keyed on (page, perPage, sort, filter) so toggling sort doesn't blow
  // away the previous page's data.
  const adminUsersRemote = {
    status: "idle",
    data: null,
    error: "",
    loadedAt: 0,
    inFlight: false,
    page: 1,
    perPage: 50,
    sort: "health",
    filter: ""
  };

  function numberOr(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function money(value) {
    const num = Number(value || 0);
    return "$" + num.toFixed(num >= 10 ? 2 : 4);
  }

  function cloudDataIsFresh() {
    return adminRemote.data && adminRemote.loadedAt && Date.now() - adminRemote.loadedAt < ADMIN_METRICS_TTL_MS;
  }

  function applyRemoteSnapshot(snapshot) {
    if (!snapshot || snapshot.ok === false) {
      throw new Error((snapshot && snapshot.error) || "Admin metrics returned an invalid response.");
    }
    adminRemote.data = snapshot;
    adminRemote.status = "ready";
    adminRemote.error = "";
    adminRemote.loadedAt = Date.now();
    return snapshot;
  }

  function isBackendAdminRuntime() {
    return Boolean(
      window.CBV2 &&
      window.CBV2.config &&
      window.CBV2.config.isBackendEnabled &&
      window.CBV2.config.isBackendEnabled() &&
      window.CBV2.auth &&
      window.CBV2.auth.isAuthenticated &&
      window.CBV2.auth.isAuthenticated()
    );
  }

  function roleListFromUser(user) {
    if (!user) return [];
    const appMeta = user.app_metadata || {};
    return []
      .concat(appMeta.role || [])
      .concat(appMeta.roles || [])
      .map(function (x) { return String(x || "").toLowerCase().trim(); })
      .filter(Boolean);
  }

  function adminAccessState() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled && window.CBV2.config.isBackendEnabled();
    const auth = window.CBV2.auth;
    if (!backendOn) {
      return { ok: true, mode: "local-preview", label: "Local preview" };
    }
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) {
      return { ok: false, reason: "signed-out", label: "Sign in required" };
    }
    const user = auth.getUser ? auth.getUser() : null;
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const roles = roleListFromUser(user);
    const allowedRoles = adminRoles();
    const byRole = roles.some(function (role) { return allowedRoles.indexOf(role) >= 0; });
    if (byRole) {
      return {
        ok: true,
        mode: "role",
        label: "Supabase role verified",
        user: user,
        profile: profile
      };
    }
    return { ok: false, reason: "forbidden", label: "Supabase admin role required", user: user, profile: profile };
  }

  window.CBV2.adminAccess = {
    state: adminAccessState,
    canAccess: function () {
      return adminAccessState().ok;
    }
  };

  function currentSection() {
    const params = (window.CBV2.getRouteParams && window.CBV2.getRouteParams()) || {};
    const section = String(params.section || "overview").trim();
    const ids = sections.reduce(function (out, group) {
      return out.concat(group.items.map(function (item) { return item.id; }));
    }, []);
    return ids.indexOf(section) >= 0 ? section : "overview";
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function daysBetween(dateValue) {
    if (!dateValue) return 999;
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return 999;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
  }

  function getAdminData() {
    const store = window.CBV2.store;
    const apps = store && typeof store.getApplications === "function" ? store.getApplications() : [];
    const savedJobs = store && typeof store.getSavedJobs === "function" ? store.getSavedJobs() : [];
    const js = store && typeof store.getJobSearchState === "function" ? (store.getJobSearchState() || {}) : {};
    const searchRuns = js.analytics && Array.isArray(js.analytics.runs) ? js.analytics.runs : [];
    const ai = window.CBAI && window.CBAI.telemetry && typeof window.CBAI.telemetry.getSummary === "function"
      ? window.CBAI.telemetry.getSummary()
      : { totalEvents: 0, success: 0, failed: 0, avgLatencyMs: 0 };
    const syncErrors = window.CBV2.syncErrors && Array.isArray(window.CBV2.syncErrors) ? window.CBV2.syncErrors : [];
    const events = store && typeof store.getEvents === "function" ? store.getEvents() : [];
    const savedCount = apps.filter(function (a) { return a.stage === "saved"; }).length;
    const appliedCount = apps.filter(function (a) { return a.stage === "applied"; }).length;
    const interviewCount = apps.filter(function (a) { return a.stage === "interview"; }).length;
    const offerCount = apps.filter(function (a) { return a.stage === "offer"; }).length;
    const staleSaved = apps.filter(function (a) {
      return a.stage === "saved" && daysBetween(a.appliedAt || (a.stageHistory && a.stageHistory[0] && a.stageHistory[0].at)) > 14;
    }).length;
    const lastSearch = searchRuns[0] || null;
    const searchFailures = searchRuns.filter(function (run) { return run && run.error; }).length;
    const data = {
      apps: apps,
      savedJobs: savedJobs,
      events: events,
      jobSearch: js,
      searchRuns: searchRuns,
      ai: ai,
      syncErrors: syncErrors,
      totals: {
        applications: apps.length,
        saved: savedCount,
        applied: appliedCount,
        interviews: interviewCount,
        offers: offerCount,
        staleSaved: staleSaved,
        savedJobs: savedJobs.length,
        searchRuns: searchRuns.length,
        searchFailures: searchFailures,
        lastSearchTotal: lastSearch && typeof lastSearch.total === "number" ? lastSearch.total : null,
        usageEvents: 0,
        usageSessions: 0
      },
      cloud: {
        connected: false,
        status: adminRemote.status,
        error: adminRemote.error,
        generatedAt: "",
        warnings: []
      },
      userStats: null,
      funnel: null,
      jobFeedStats: null,
      alerts: [],
      operations: {},
      diagnostics: null,
      privacyControls: null,
      dataFreshness: null,
      product: null,
      retention: null,
      productInsights: [],
      moduleAdoption: [],
      moduleEngagement: [],
      aiProviders: [],
      aiBudget: null,
      feedQuality: null,
      recentApplications: [],
      recentAiFailures: [],
      sourceIssues: [],
      staleSaved: [],
      support: null,
      reports: null,
      actionQueue: [],
      controlCenter: null,
      remoteActivity: []
    };

    const remote = adminRemote.data;
    if (remote && remote.ok !== false) {
      const totals = remote.totals || {};
      const funnel = remote.funnel || {};
      const stages = funnel.stages || {};
      const remoteAi = remote.ai || {};
      data.cloud = {
        connected: true,
        status: adminRemote.status,
        error: adminRemote.error,
        generatedAt: remote.generatedAt || "",
        warnings: (remote.diagnostics && Array.isArray(remote.diagnostics.warnings)) ? remote.diagnostics.warnings : [],
        // Phase A: surface server-resolved access info so the privacy panel
        // can show ADMIN_ROLES env contents without a separate fetch.
        access: remote.access || null
      };
      data.userStats = remote.users || null;
      data.funnel = funnel;
      data.jobFeedStats = remote.jobFeed || null;
      data.alerts = Array.isArray(remote.alerts) ? remote.alerts : [];
      data.operations = remote.operations || {};
      data.diagnostics = remote.diagnostics || null;
      data.privacyControls = remote.diagnostics && remote.diagnostics.privacyControls ? remote.diagnostics.privacyControls : null;
      data.dataFreshness = remote.diagnostics && remote.diagnostics.dataFreshness ? remote.diagnostics.dataFreshness : null;
      data.product = remote.product || null;
      data.retention = remote.retention || null;
      data.productInsights = remote.product && Array.isArray(remote.product.insights) ? remote.product.insights : [];
      data.moduleAdoption = remote.product && Array.isArray(remote.product.modules) ? remote.product.modules : [];
      data.moduleEngagement = remote.product && Array.isArray(remote.product.moduleEngagement) ? remote.product.moduleEngagement : data.moduleAdoption;
      data.aiProviders = Array.isArray(remoteAi.byProvider) ? remoteAi.byProvider : [];
      data.aiBudget = remoteAi.budget || null;
      data.feedQuality = data.jobFeedStats && data.jobFeedStats.quality ? data.jobFeedStats.quality : null;
      data.recentApplications = Array.isArray(funnel.recentApplications) ? funnel.recentApplications : [];
      data.staleSaved = Array.isArray(funnel.staleSaved) ? funnel.staleSaved : [];
      data.recentAiFailures = Array.isArray(remoteAi.recentFailures) ? remoteAi.recentFailures : [];
      data.sourceIssues = data.jobFeedStats && Array.isArray(data.jobFeedStats.sourceIssues) ? data.jobFeedStats.sourceIssues : [];
      data.support = remote.support || null;
      data.reports = remote.reports || null;
      data.actionQueue = data.reports && Array.isArray(data.reports.actionQueue) ? data.reports.actionQueue : [];
      data.controlCenter = remote.controlCenter || null;
      data.remoteActivity = Array.isArray(remote.activity) ? remote.activity : [];
      data.totals.users = numberOr(totals.users, 0);
      data.totals.profiles = numberOr(totals.profiles, 0);
      data.totals.applications = numberOr(totals.applications, data.totals.applications);
      data.totals.saved = numberOr(stages.saved, data.totals.saved);
      data.totals.applied = numberOr(stages.applied, data.totals.applied);
      data.totals.interviews = numberOr(stages.interview, data.totals.interviews);
      data.totals.offers = numberOr(stages.offer, data.totals.offers);
      data.totals.rejected = numberOr(stages.rejected, 0);
      data.totals.withdrawn = numberOr(stages.withdrawn, 0);
      data.totals.savedJobs = numberOr(totals.savedJobs, data.totals.savedJobs);
      data.totals.savedSearches = numberOr(totals.savedSearches, 0);
      data.totals.events = numberOr(totals.events, data.events.length);
      data.totals.upcomingEvents = numberOr(totals.upcomingEvents, 0);
      data.totals.resumes = numberOr(totals.resumes, 0);
      data.totals.coverLetters = numberOr(totals.coverLetters, 0);
      data.totals.interviewSets = numberOr(totals.interviewSets, 0);
      data.totals.aiCostUsd = numberOr(totals.aiCostUsd, 0);
      data.totals.usageEvents = numberOr(totals.usageEvents, 0);
      data.totals.usageSessions = numberOr(totals.usageSessions, data.retention && data.retention.usageSessions || 0);
      data.ai = {
        totalEvents: numberOr(remoteAi.requests, data.ai.totalEvents || 0),
        success: numberOr(remoteAi.success, data.ai.success || 0),
        failed: numberOr(remoteAi.failed, data.ai.failed || 0),
        avgLatencyMs: numberOr(remoteAi.avgLatencyMs, data.ai.avgLatencyMs || 0),
        costUsd: numberOr(remoteAi.costUsd, 0),
        bySkill: Array.isArray(remoteAi.bySkill) ? remoteAi.bySkill : []
      };
    }
    return data;
  }

  function percent(n, d) {
    if (!d) return "0%";
    return Math.round((n / d) * 100) + "%";
  }

  function formatDateTime(value) {
    if (!value) return "Never";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "Unknown";
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (err) {
      return "Unknown";
    }
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds || 0)));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rem = minutes % 60;
      return hours + "h " + rem + "m";
    }
    if (minutes > 0) return minutes + "m " + secs + "s";
    return secs + "s";
  }

  function renderAccessDenied(access) {
    const signedOut = access && access.reason === "signed-out";
    return (
      '<section class="admin-auth-screen">' +
        '<article class="admin-auth-card">' +
          '<span class="admin-kicker"><i class="fa-solid fa-shield-halved"></i> CareerBoost Admin</span>' +
          '<h1>' + st(signedOut ? "Sign in to open the admin console." : "Admin access is locked.") + '</h1>' +
          '<p>' + st(signedOut
            ? "The admin side is separated from the candidate workspace and requires an authenticated operator account."
            : "Add an admin, owner, or developer role in Supabase Auth raw app metadata for this account.") + '</p>' +
          '<div class="admin-auth-actions">' +
            '<a class="btn-primary" href="#/auth"><i class="fa-solid fa-right-to-bracket"></i> Sign in</a>' +
            '<a class="btn-ghost" href="#/dashboard"><i class="fa-solid fa-arrow-left"></i> Back to app</a>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  function renderAdminBrandLogo() {
    const kit = window.CBV2 && window.CBV2.brandKit;
    const mark = kit && typeof kit.mark === "function"
      ? kit.mark("CareerBoost")
      : (
        '<svg class="cb-mark-svg" viewBox="0 0 80 80" role="img" aria-label="CareerBoost">' +
          '<rect x="14" y="14" width="52" height="52" transform="rotate(45 40 40)" class="cb-mark-outer"></rect>' +
          '<rect x="22" y="22" width="36" height="36" transform="rotate(45 40 40)" class="cb-mark-inner"></rect>' +
          '<text x="40" y="45" text-anchor="middle" class="cb-mark-text">CB</text>' +
        '</svg>'
      );
    return (
      '<span class="cb-logo cb-logo--admin">' +
        '<span class="cb-logo-mark">' + mark + '</span>' +
        '<span class="cb-logo-copy">' +
          '<span class="cb-logo-wordmark">Career<span>Boost</span></span>' +
          '<span class="cb-logo-tagline">Admin console</span>' +
        '</span>' +
      '</span>'
    );
  }

  function renderAdminNav(active) {
    const groups = sections.map(function (group) {
      const items = group.items.map(function (item) {
        const isActive = item.id === active;
        const badge = item.badge ? '<span class="admin-nav-badge">' + st(item.badge) + '</span>' : "";
        return (
          '<a class="admin-nav-link' + (isActive ? " is-active" : "") + '" href="#/admin?section=' + item.id + '" data-admin-route="' + item.id + '">' +
            '<i class="fa-solid ' + item.icon + '" aria-hidden="true"></i>' +
            '<span>' + st(item.label) + '</span>' +
            badge +
          '</a>'
        );
      }).join("");
      return (
        '<section class="admin-nav-group">' +
          '<p>' + st(group.group) + '</p>' +
          items +
        '</section>'
      );
    }).join("");

    return (
      '<aside class="admin-sidebar">' +
        '<a class="admin-brand" href="#/admin" aria-label="CareerBoost admin overview">' +
          renderAdminBrandLogo() +
        '</a>' +
        groups +
        '<div class="admin-sidebar-foot">' +
          '<a class="admin-return-link" href="#/dashboard"><i class="fa-solid fa-arrow-left"></i> Candidate app</a>' +
          '<span class="admin-version">Operator v0.1</span>' +
        '</div>' +
      '</aside>'
    );
  }

  function renderStat(label, value, detail, tone) {
    return (
      '<article class="admin-stat admin-stat--' + st(tone || "cyan") + '">' +
        '<span>' + st(label) + '</span>' +
        '<strong class="num-font">' + st(value) + '</strong>' +
        '<small>' + st(detail || "") + '</small>' +
      '</article>'
    );
  }

  function alertTone(severity) {
    const sev = String(severity || "info").toLowerCase();
    if (sev === "critical") return "critical";
    if (sev === "warning") return "warning";
    return "info";
  }

  function alertIcon(severity) {
    const tone = alertTone(severity);
    if (tone === "critical") return "fa-triangle-exclamation";
    if (tone === "warning") return "fa-circle-exclamation";
    return "fa-circle-info";
  }

  function renderAlerts(data) {
    const alerts = safeArray(data.alerts).slice(0, 4);
    if (!alerts.length) {
      return (
        '<section class="admin-alert-grid">' +
          '<article class="admin-alert admin-alert--info">' +
            '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>' +
            '<div><strong>No admin alerts yet</strong><span>Connect the backend function to populate source, AI, and user-health checks.</span></div>' +
          '</article>' +
        '</section>'
      );
    }
    return (
      '<section class="admin-alert-grid">' +
        alerts.map(function (alert) {
          const tone = alertTone(alert.severity);
          return (
            '<a class="admin-alert admin-alert--' + tone + '" href="#/admin?section=' + st(alert.section || "overview") + '">' +
              '<i class="fa-solid ' + alertIcon(alert.severity) + '" aria-hidden="true"></i>' +
              '<div><strong>' + st(alert.title || "Admin alert") + '</strong><span>' + st(alert.body || "") + '</span><small>' + st(alert.action || "") + '</small></div>' +
            '</a>'
          );
        }).join("") +
      '</section>'
    );
  }

  function hostLabel(value) {
    const raw = String(value || "").replace(/^www\./, "");
    return raw || "No host";
  }

  function progressTone(value) {
    const num = Number(value || 0);
    if (num >= 70) return "green";
    if (num >= 45) return "amber";
    return "red";
  }

  function moduleStatusTone(status) {
    const value = String(status || "").toLowerCase();
    if (value.indexOf("healthy") >= 0) return "green";
    if (value.indexOf("telemetry") >= 0) return "blue";
    if (value.indexOf("attention") >= 0) return "red";
    return "amber";
  }

  function renderProgressRows(rows) {
    const items = safeArray(rows);
    if (!items.length) {
      return '<p class="admin-copy">No product intelligence rows are available yet.</p>';
    }
    return (
      '<div class="admin-progress-list">' +
        items.map(function (row) {
          const value = Math.max(0, Math.min(100, Number(row.value != null ? row.value : row.adoption || 0)));
          return (
            '<div class="admin-progress-row">' +
              '<div><strong>' + st(row.label || row.title || "Metric") + '</strong><span>' + st(row.detail || row.status || row.action || "") + '</span></div>' +
              '<span class="chip ' + st(progressTone(value)) + '">' + st(value) + '%</span>' +
              '<i style="--progress:' + value + '%"></i>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderInsightList(insights) {
    const rows = safeArray(insights);
    if (!rows.length) {
      return '<p class="admin-copy">No product recommendations are currently flagged.</p>';
    }
    return (
      '<div class="admin-action-list">' +
        rows.map(function (item) {
          const tone = alertTone(item.severity);
          return (
            '<a class="admin-action-card admin-action-card--' + st(tone) + '" href="#/admin?section=' + st(item.section || "overview") + '">' +
              '<i class="fa-solid ' + alertIcon(item.severity) + '"></i>' +
              '<div><strong>' + st(item.title || "Product insight") + '</strong><span>' + st(item.body || "") + '</span></div>' +
            '</a>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderCohortBars(cohorts) {
    const rows = safeArray(cohorts);
    if (!rows.length) return '<p class="admin-copy">Cohort data will appear after the admin backend collects user activity.</p>';
    const max = Math.max.apply(Math, rows.map(function (row) { return Math.max(Number(row.signups || 0), Number(row.active || 0), Number(row.jobSaves || 0), Number(row.aiCalls || 0)); }).concat([1]));
    return (
      '<div class="admin-cohort-grid">' +
        rows.map(function (row) {
          const active = Math.max(8, Math.round((Number(row.active || 0) / max) * 100));
          const jobs = Math.max(8, Math.round((Number(row.jobSaves || 0) / max) * 100));
          const ai = Math.max(8, Math.round((Number(row.aiCalls || 0) / max) * 100));
          return (
            '<div class="admin-cohort-card">' +
              '<strong>' + st(row.week) + '</strong>' +
              '<div><span style="--bar:' + active + '%"></span><small>Active ' + st(row.active || 0) + '</small></div>' +
              '<div><span style="--bar:' + jobs + '%"></span><small>Jobs ' + st(row.jobSaves || 0) + '</small></div>' +
              '<div><span style="--bar:' + ai + '%"></span><small>AI ' + st(row.aiCalls || 0) + '</small></div>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function clampPct(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function compactNumber(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0";
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "m";
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(num);
  }

  function syntheticDailyActive(retention) {
    const today = Number(retention.activeToday || 0);
    const weekly = Number(retention.activeLast7 || today || 0);
    const monthly = Number(retention.activeLast30 || weekly || 0);
    return Array.from({ length: 30 }).map(function (_, index) {
      const base = Math.max(0, Math.round((monthly / 3) + (weekly / 7) + (today * (index / 30))));
      const value = index > 25 ? Math.max(today, base) : base;
      return {
        label: "D" + (index + 1),
        activeUsers: value,
        sessions: Math.max(value, Math.round(value * 1.2)),
        avg7: value
      };
    });
  }

  function renderUsageTrend(retention) {
    const rows = safeArray(retention.dailyActive).length ? safeArray(retention.dailyActive) : syntheticDailyActive(retention);
    const max = Math.max.apply(Math, rows.map(function (row) {
      return Math.max(Number(row.activeUsers || 0), Number(row.avg7 || 0), Number(row.sessions || 0));
    }).concat([1]));
    const width = 640;
    const height = 250;
    const top = 28;
    const bottom = 196;
    const left = 38;
    const right = 612;
    const step = rows.length > 1 ? (right - left) / (rows.length - 1) : 0;
    function point(row, index, key) {
      const value = Number(row[key] || 0);
      const x = left + index * step;
      const y = bottom - (value / max) * (bottom - top);
      return { x: x, y: y, value: value };
    }
    const activePoints = rows.map(function (row, index) { return point(row, index, "activeUsers"); });
    const avgPoints = rows.map(function (row, index) { return point(row, index, "avg7"); });
    const activePath = activePoints.map(function (p, index) {
      return (index ? "L" : "M") + p.x.toFixed(1) + "," + p.y.toFixed(1);
    }).join(" ");
    const avgPath = avgPoints.map(function (p, index) {
      return (index ? "L" : "M") + p.x.toFixed(1) + "," + p.y.toFixed(1);
    }).join(" ");
    const areaPath = activePath + " L" + right + "," + bottom + " L" + left + "," + bottom + " Z";
    const firstLabel = rows[0] && (rows[0].label || rows[0].date || "");
    const midLabel = rows[Math.floor(rows.length / 2)] && (rows[Math.floor(rows.length / 2)].label || rows[Math.floor(rows.length / 2)].date || "");
    const lastLabel = rows[rows.length - 1] && (rows[rows.length - 1].label || rows[rows.length - 1].date || "");
    const latest = rows[rows.length - 1] || {};
    return (
      '<div class="admin-line-chart-card">' +
        '<div class="admin-chart-legend admin-chart-legend--top">' +
          '<span><i></i> Daily active users</span>' +
          '<span><i class="admin-legend-dashed"></i> 7-day average</span>' +
          '<strong>' + st(compactNumber(latest.activeUsers || 0)) + ' latest</strong>' +
        '</div>' +
        '<svg class="admin-line-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Daily active users over 30 days">' +
          '<defs><linearGradient id="usageArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22e3ff" stop-opacity="0.28"/><stop offset="100%" stop-color="#10b981" stop-opacity="0.03"/></linearGradient></defs>' +
          '<g class="admin-chart-grid"><line x1="' + left + '" x2="' + right + '" y1="48" y2="48"></line><line x1="' + left + '" x2="' + right + '" y1="96" y2="96"></line><line x1="' + left + '" x2="' + right + '" y1="144" y2="144"></line><line x1="' + left + '" x2="' + right + '" y1="' + bottom + '" y2="' + bottom + '"></line></g>' +
          '<path class="admin-line-area" d="' + areaPath + '"></path>' +
          '<path class="admin-line-main" d="' + activePath + '"></path>' +
          '<path class="admin-line-average" d="' + avgPath + '"></path>' +
          activePoints.slice(-6).map(function (p) { return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3"></circle>'; }).join("") +
        '</svg>' +
        '<div class="admin-chart-axis"><span>' + st(firstLabel) + '</span><span>' + st(midLabel) + '</span><span>' + st(lastLabel) + '</span></div>' +
      '</div>'
    );
  }

  function renderCountBars(rows, emptyLabel) {
    const items = safeArray(rows).filter(function (row) { return Number(row.count || 0) > 0; }).slice(0, 6);
    if (!items.length) return '<p class="admin-copy">' + st(emptyLabel || "No distribution data is available yet.") + '</p>';
    const max = Math.max.apply(Math, items.map(function (row) { return Number(row.count || 0); }).concat([1]));
    const total = items.reduce(function (sum, row) { return sum + Number(row.count || 0); }, 0);
    return (
      '<div class="admin-count-bars">' +
        items.map(function (row) {
          const width = Math.max(4, Math.round((Number(row.count || 0) / max) * 100));
          const share = total ? Math.round((Number(row.count || 0) / total) * 100) : 0;
          return (
            '<div class="admin-count-bar">' +
              '<div><strong>' + st(row.label || "Unknown") + '</strong><span>' + st(row.count || 0) + ' / ' + st(share) + '%</span></div>' +
              '<i style="--bar:' + width + '%"></i>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderRetentionCohorts(retention) {
    const summary = retention && retention.cohortSummary ? retention.cohortSummary : {};
    const rows = safeArray(retention && retention.cohortRetention);
    function renderCell(cell) {
      if (!cell || cell.pending || cell.rate == null) return '<span class="admin-retention-cell admin-retention-cell--pending">-</span>';
      const rate = Number(cell.rate || 0);
      const tone = progressTone(rate);
      return '<span class="admin-retention-cell admin-retention-cell--' + st(tone) + '"><strong>' + st(rate) + '%</strong><em>' + st(cell.activeUsers || 0) + ' users' + (cell.partial ? ' - live' : '') + '</em></span>';
    }
    if (!rows.length) {
      return '<p class="admin-copy">True retention cohorts will appear after users sign up and return in later weeks.</p>';
    }
    return (
      '<div class="admin-retention-summary">' +
        '<span><strong>' + st((summary.avgWeek1Retention != null ? summary.avgWeek1Retention : 0) + '%') + '</strong><em>Avg week 1</em></span>' +
        '<span><strong>' + st((summary.avgWeek2Retention != null ? summary.avgWeek2Retention : 0) + '%') + '</strong><em>Avg week 2</em></span>' +
        '<span><strong>' + st((summary.avgWeek3Retention != null ? summary.avgWeek3Retention : 0) + '%') + '</strong><em>Avg week 3</em></span>' +
        '<span><strong>' + st(summary.habitSignal || 'waiting') + '</strong><em>Habit signal</em></span>' +
      '</div>' +
      '<div class="admin-retention-heatmap">' +
        '<div class="admin-retention-row admin-retention-row--head"><span>Cohort</span><span>Users</span><span>W0</span><span>W1</span><span>W2</span><span>W3</span></div>' +
        rows.map(function (row) {
          const weeks = safeArray(row.weeks);
          return (
            '<div class="admin-retention-row">' +
              '<span><strong>' + st(row.week || 'Cohort') + '</strong><em>' + st(row.users || 0) + ' signed up</em></span>' +
              '<span>' + st(row.users || 0) + '</span>' +
              renderCell(weeks[0]) +
              renderCell(weeks[1]) +
              renderCell(weeks[2]) +
              renderCell(weeks[3]) +
            '</div>'
          );
        }).join("") +
      '</div>' +
      '<p class="admin-copy">' + st(summary.note || "Returns are calculated from tracked usage sessions after signup.") + '</p>'
    );
  }

  function renderCountTable(rows, emptyLabel) {
    const items = safeArray(rows);
    if (!items.length) return '<p class="admin-copy">' + st(emptyLabel || "No session rows are available yet.") + '</p>';
    const total = items.reduce(function (sum, row) { return sum + Number(row.count || 0); }, 0);
    return (
      '<div class="admin-table">' +
        '<div class="admin-table-row admin-table-row--three admin-table-head"><span>Signal</span><span>Count</span><span>Share</span></div>' +
        items.map(function (row) {
          return '<div class="admin-table-row admin-table-row--three"><span>' + st(row.label || "Unknown") + '</span><span>' + st(row.count || 0) + '</span><span>' + st(total ? Math.round((Number(row.count || 0) / total) * 100) + "%" : "-") + '</span></div>';
        }).join("") +
      '</div>'
    );
  }

  function renderModuleEngagement(rows) {
    const items = safeArray(rows);
    if (!items.length) {
      return '<p class="admin-copy">Module usage will appear after users navigate CareerBoost.</p>';
    }
    const maxActive = Math.max.apply(Math, items.map(function (row) {
      return Number(row.activeUsers != null ? row.activeUsers : row.users || 0);
    }).concat([1]));
    const maxDepth = Math.max.apply(Math, items.map(function (row) {
      return Number(row.avgEventsPerSession || row.depth || 0);
    }).concat([1]));
    return (
      '<div class="admin-module-chart">' +
        '<div class="admin-module-row admin-module-row--head">' +
          '<div class="admin-module-title"><strong>Module</strong></div>' +
          '<div class="admin-module-meter-label"><span>Active users</span></div>' +
          '<div class="admin-module-depth-label"><span>Depth / session</span></div>' +
          '<b class="admin-module-status-label">Status</b>' +
        '</div>' +
        items.slice(0, 8).map(function (row) {
          const active = Number(row.activeUsers != null ? row.activeUsers : row.users || 0);
          const sessions = Number(row.sessions || 0);
          const views = Number(row.views || 0);
          const depth = Number(row.avgEventsPerSession || 0);
          const status = row.status || "waiting for telemetry";
          const width = Math.max(4, Math.round((active / maxActive) * 100));
          const depthWidth = Math.max(4, Math.round((depth / maxDepth) * 100));
          return (
            '<div class="admin-module-row">' +
              '<div class="admin-module-title"><strong>' + st(row.label || "Module") + '</strong><span>' + st(active) + ' active users · ' + st(sessions) + ' sessions · ' + st(views) + ' views</span></div>' +
              '<div class="admin-module-meter"><i style="--bar:' + width + '%"></i></div>' +
              '<div class="admin-module-depth"><span>Depth ' + st(depth ? depth + "/session" : "-") + '</span><i style="--bar:' + depthWidth + '%"></i></div>' +
              '<b class="chip ' + st(moduleStatusTone(status)) + '">' + st(status) + '</b>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderActivationFunnel(activation) {
    const rows = safeArray(activation && activation.funnel);
    if (!rows.length) {
      return renderProgressRows([
        { label: "Completed profile", value: activation.onboardingRate || 0, detail: (activation.onboarded || 0) + " users completed setup" },
        { label: "Resume ready", value: activation.resumeReadyRate || 0, detail: (activation.resumeReadyUsers || 0) + " users have a usable resume base" },
        { label: "First job saved", value: activation.firstJobRate || 0, detail: (activation.firstJobUsers || 0) + " users saved or tracked a role" },
        { label: "First tailored asset", value: activation.tailoredAssetRate || 0, detail: (activation.tailoredAssetUsers || 0) + " users tailored a resume or cover letter" },
        { label: "Job moved forward", value: activation.appliedUserRate || 0, detail: (activation.appliedUsers || 0) + " users reached applied/interview/offer" }
      ]);
    }
    return (
      '<div class="admin-funnel-chart">' +
        rows.map(function (row) {
          const conversion = clampPct(row.conversion || 0);
          const stepConversion = clampPct(row.stepConversion || 0);
          const tone = progressTone(conversion);
          return (
            '<div class="admin-funnel-step admin-funnel-step--' + st(tone) + '">' +
              '<div class="admin-funnel-step-head"><strong>' + st(row.label || "Activation step") + '</strong><span>' + st(row.users || 0) + ' users</span><b>' + st(conversion) + '%</b></div>' +
              '<div class="admin-funnel-track"><i style="--bar:' + conversion + '%"></i></div>' +
              '<em>' + st(stepConversion) + '% from previous step' + (row.dropOff ? ' · ' + row.dropOff + ' dropped off' : ' · no drop-off') + '</em>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderUsageKpiStrip(data, activation, retention, avgSessionSeconds) {
    const cohortSummary = retention.cohortSummary || {};
    const week1 = cohortSummary.avgWeek1Retention != null ? cohortSummary.avgWeek1Retention + "%" : "-";
    return (
      '<section class="admin-kpi-strip" aria-label="Usage KPI strip">' +
        '<article class="admin-kpi-card admin-kpi-card--green"><span>Daily active users</span><strong>' + st(retention.activeToday || 0) + '</strong><em>last 24 hours</em></article>' +
        '<article class="admin-kpi-card admin-kpi-card--cyan"><span>Weekly active users</span><strong>' + st(retention.activeLast7 || 0) + '</strong><em>last 7 days</em></article>' +
        '<article class="admin-kpi-card admin-kpi-card--blue"><span>Monthly active users</span><strong>' + st(retention.activeLast30 || 0) + '</strong><em>last 30 days</em></article>' +
        '<article class="admin-kpi-card admin-kpi-card--violet"><span>Activation rate</span><strong>' + st((activation.activatedRate != null ? activation.activatedRate : activation.score || 0) + "%") + '</strong><em>' + st(activation.activatedUsers || 0) + ' moved forward</em></article>' +
        '<article class="admin-kpi-card admin-kpi-card--amber"><span>Week 1 retention</span><strong>' + st(week1) + '</strong><em>' + st(cohortSummary.habitSignal || "waiting") + ' habit signal</em></article>' +
        '<article class="admin-kpi-card admin-kpi-card--cyan"><span>Depth per session</span><strong>' + st(retention.avgSessionDepth || retention.avgRoutesPerSession || 0) + '</strong><em>' + st(avgSessionSeconds ? formatDuration(avgSessionSeconds) : "-") + ' avg length</em></article>' +
        '<article class="admin-kpi-card admin-kpi-card--blue"><span>Tracked events</span><strong>' + st(data.totals.usageEvents || retention.usageEvents || 0) + '</strong><em>' + st(retention.activeSessions || 0) + ' sessions</em></article>' +
      '</section>'
    );
  }

  function renderTopDropOffs(activation, modules, retention) {
    const rows = [];
    if (activation.largestDropOff) {
      rows.push({
        label: activation.largestDropOff.label || "Activation drop-off",
        value: (activation.largestDropOff.dropOffRate || 0) + "%",
        detail: (activation.largestDropOff.dropOff || 0) + " candidates lost. " + (activation.largestDropOff.action || ""),
        tone: "amber"
      });
    }
    safeArray(activation.bottlenecks).slice(0, 3).forEach(function (item) {
      rows.push({
        label: item.label || "Funnel bottleneck",
        value: (item.dropOffRate != null ? item.dropOffRate : item.value || 0) + "%",
        detail: item.action || "Review this activation step.",
        tone: "blue"
      });
    });
    const weakModule = safeArray(modules).find(function (module) {
      return ["needs attention", "underused", "shallow usage"].indexOf(String(module.status || "").toLowerCase()) >= 0;
    });
    if (weakModule) {
      rows.push({
        label: weakModule.label + " engagement",
        value: (weakModule.adoption || 0) + "%",
        detail: weakModule.recommendation || "Review module entry points and calls to action.",
        tone: "red"
      });
    }
    const cohortSummary = retention.cohortSummary || {};
    if (cohortSummary.avgWeek1Retention != null && Number(cohortSummary.avgWeek1Retention) < 30) {
      rows.push({
        label: "Week 1 retention",
        value: cohortSummary.avgWeek1Retention + "%",
        detail: "New users are not returning strongly after signup. Improve reminders, next action prompts, and onboarding handoff.",
        tone: "amber"
      });
    }
    if (!rows.length) {
      rows.push({ label: "No urgent drop-off", value: "Clean", detail: "Current usage signals do not show a major break in the tracked workflow.", tone: "green" });
    }
    return (
      '<div class="admin-decision-list">' +
        rows.slice(0, 5).map(function (row) {
          return (
            '<div class="admin-decision-row admin-decision-row--' + st(row.tone) + '">' +
              '<strong>' + st(row.label) + '</strong>' +
              '<span>' + st(row.value) + '</span>' +
              '<em>' + st(row.detail) + '</em>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderSessionQuality(retention, deviceMix, pathMix, avgSessionSeconds) {
    const metrics = [
      { label: "Active sessions", value: retention.activeSessions || 0, detail: "tracked sessions", pct: Math.min(100, Number(retention.activeSessions || 0) * 10), tone: "cyan" },
      { label: "Avg session length", value: formatDuration(avgSessionSeconds), detail: "time in product", pct: Math.min(100, avgSessionSeconds ? Math.round(avgSessionSeconds / 18) : 0), tone: "green" },
      { label: "Routes per session", value: retention.avgRoutesPerSession || 0, detail: "navigation depth", pct: Math.min(100, Number(retention.avgRoutesPerSession || 0) * 20), tone: "blue" },
      { label: "Events per session", value: retention.avgEventsPerSession || 0, detail: "interaction depth", pct: Math.min(100, Number(retention.avgEventsPerSession || 0) * 8), tone: "violet" },
      { label: "WAU / MAU", value: (retention.stickiness || 0) + "%", detail: "return habit", pct: clampPct(retention.stickiness || 0), tone: "amber" }
    ];
    return (
      '<div class="admin-session-quality">' +
        '<div class="admin-session-metric-grid">' +
          metrics.map(function (metric) {
            return (
              '<div class="admin-session-metric admin-session-metric--' + st(metric.tone) + '">' +
                '<strong>' + st(metric.value) + '</strong><span>' + st(metric.label) + '</span><em>' + st(metric.detail) + '</em>' +
                '<i style="--bar:' + clampPct(metric.pct) + '%"></i>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
        '<div class="admin-session-quality-grid">' +
          '<div><h3>Device mix</h3>' + renderCountBars(deviceMix, "Session device and browser mix will appear after users return.") + '</div>' +
          '<div><h3>Route/module views</h3>' + renderCountBars(pathMix, "Route and module views will appear after users navigate the app.") + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderSparkBars(values) {
    const nums = safeArray(values);
    const max = Math.max.apply(Math, nums.concat([1]));
    return nums.map(function (value, index) {
      const height = Math.max(10, Math.round((Number(value || 0) / max) * 100));
      return '<span style="--bar:' + height + '%" title="Day ' + (index + 1) + ': ' + st(value) + '"></span>';
    }).join("");
  }

  function searchTrend(data) {
    const runs = data.searchRuns.slice(0, 12).reverse();
    if (!runs.length) return [4, 8, 5, 11, 9, 14, 13, 16, 12, 18, 15, 20];
    return runs.map(function (run) { return Number(run.total || 0); });
  }

  function renderProviderRows(data) {
    if (data.jobFeedStats && Array.isArray(data.jobFeedStats.sources) && data.jobFeedStats.sources.length) {
      return data.jobFeedStats.sources.slice(0, 8).map(function (row) {
        return (
          '<div class="admin-health-row">' +
            '<span class="admin-dot admin-dot--green"></span>' +
            '<div><strong>' + st(row.label) + '</strong><small>' + st(row.host || "Verified provider source") + '</small></div>' +
            '<span class="chip green">' + st(row.count) + ' jobs</span>' +
          '</div>'
        );
      }).join("");
    }
    const js = data.jobSearch || {};
    const last = js.lastResultSet || null;
    const sources = last && last.sources && typeof last.sources === "object" ? last.sources : {};
    const rows = [
      { label: "LinkedIn extension", status: "Watch", detail: "Extension imports and token health", tone: "blue" },
      { label: "Adzuna", status: sources.adzuna != null ? "Reporting" : "Ready", detail: "Cloud job search provider", tone: "green" },
      { label: "External boards", status: sources.external != null ? "Reporting" : "Ready", detail: "Verified source provenance", tone: "cyan" },
      { label: "Realtime sync", status: window.CBV2.store && window.CBV2.store.isRemote ? "Remote" : "Local", detail: "Pipeline refresh channel", tone: "violet" }
    ];
    return rows.map(function (row) {
      return (
        '<div class="admin-health-row">' +
          '<span class="admin-dot admin-dot--' + st(row.tone) + '"></span>' +
          '<div><strong>' + st(row.label) + '</strong><small>' + st(row.detail) + '</small></div>' +
          '<span class="chip ' + st(row.tone) + '">' + st(row.status) + '</span>' +
        '</div>'
      );
    }).join("");
  }

  function renderActivity(data) {
    const items = [];
    data.remoteActivity.forEach(function (item) {
      items.push({
        icon: item.type === "ai-failed" ? "fa-triangle-exclamation" : (item.type === "ai" ? "fa-wand-magic-sparkles" : "fa-briefcase"),
        title: item.title || "Admin activity",
        body: item.body || "",
        time: item.at || ""
      });
    });
    data.apps.slice(0, 4).forEach(function (app) {
      items.push({
        icon: "fa-briefcase",
        title: "Pipeline updated",
        body: (app.company || "Company") + " - " + (app.role || "Role"),
        time: app.appliedAt || ""
      });
    });
    data.searchRuns.slice(0, 3).forEach(function (run) {
      items.push({
        icon: "fa-magnifying-glass",
        title: "Job search run",
        body: (run.query || "Search") + " returned " + (run.total || 0) + " roles",
        time: run.at || ""
      });
    });
    if (!items.length) {
      items.push({ icon: "fa-circle-info", title: "No live activity yet", body: "Admin telemetry will populate as users search, save jobs, and run AI actions.", time: "" });
    }
    return items.slice(0, 6).map(function (item) {
      return (
        '<li class="admin-activity-item">' +
          '<i class="fa-solid ' + item.icon + '" aria-hidden="true"></i>' +
          '<div><strong>' + st(item.title) + '</strong><span>' + st(item.body) + '</span></div>' +
          '<time>' + st(formatDateTime(item.time)) + '</time>' +
        '</li>'
      );
    }).join("");
  }

  function renderOverview(data) {
    const aiFailureRate = percent(data.ai.failed || 0, Math.max(1, (data.ai.success || 0) + (data.ai.failed || 0)));
    const funnelTotal = Math.max(1, data.totals.applications);
    const activation = data.product && data.product.activation ? data.product.activation : null;
    const cloudLine = data.cloud.connected
      ? "Supabase live - " + formatDateTime(data.cloud.generatedAt)
      : (data.cloud.status === "error" ? "Cloud error: " + data.cloud.error : "Local/browser telemetry");
    return (
      '<section class="admin-status-banner admin-status-banner--' + st(data.cloud.connected ? "live" : (data.cloud.status === "error" ? "warn" : "local")) + '">' +
        '<div><strong>' + st(data.cloud.connected ? "Admin backend connected" : "Admin backend waiting") + '</strong><span>' + st(cloudLine) + '</span></div>' +
        '<span class="chip ' + st(data.cloud.connected ? "green" : "subtle") + '">' + st(data.cloud.status || "idle") + '</span>' +
      '</section>' +
      '<div class="admin-panel-head admin-panel-head--compact"><div><span>Operator alerts</span><h2>What needs attention</h2></div><span class="chip ' + st(data.alerts && data.alerts.length ? "amber" : "green") + '">' + st(data.alerts && data.alerts.length ? data.alerts.length + " signals" : "Clean") + '</span></div>' +
      renderAlerts(data) +
      '<section class="admin-stat-grid">' +
        renderStat("Total pipeline records", data.totals.applications, data.totals.saved + " saved roles", "cyan") +
        renderStat("User accounts", data.totals.users != null ? data.totals.users : "-", data.userStats ? data.userStats.activeLast7 + " active in 7 days" : "Cloud metric", "green") +
        renderStat("AI spend / requests", money(data.ai.costUsd || 0), (data.ai.totalEvents || 0) + " requests - " + aiFailureRate + " failed", data.ai.failed ? "amber" : "blue") +
        renderStat("Activation score", activation ? activation.score + "%" : "-", activation ? activation.firstJobRate + "% captured a first job" : "Phase 4 metric", activation && activation.score < 55 ? "amber" : "violet") +
      '</section>' +
      '<section class="admin-grid admin-grid--main">' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>Usage signal</span><h2>Job search activity</h2></div><span class="chip cyan">Last ' + st(data.searchRuns.length || 0) + ' runs</span></div>' +
          '<div class="admin-chart-bars">' + renderSparkBars(searchTrend(data)) + '</div>' +
          '<div class="admin-chart-legend"><span><i></i> Returned roles per run</span><span>Searches are cached until users clear results</span></div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Provider readiness</span><h2>Job feed health</h2></div><span class="chip green">Operational</span></div>' +
          '<div class="admin-health-list">' + renderProviderRows(data) + '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Operator feed</span><h2>Recent activity</h2></div><span class="chip subtle">Live-ready</span></div>' +
          '<ul class="admin-activity-list">' + renderActivity(data) + '</ul>' +
        '</article>' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>Application funnel</span><h2>Candidate progress</h2></div><span class="chip violet">Phase 1</span></div>' +
          '<div class="admin-funnel">' +
            '<div><strong>' + st(data.totals.saved) + '</strong><span>Saved</span></div>' +
            '<div><strong>' + st(data.totals.applied) + '</strong><span>Applied</span></div>' +
            '<div><strong>' + st(data.totals.interviews) + '</strong><span>Interview</span></div>' +
            '<div><strong>' + st(data.totals.offers) + '</strong><span>Offer</span></div>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  function renderUsageEngagement(data) {
    const activation = data.product && data.product.activation ? data.product.activation : {};
    const retention = data.retention || {};
    const avgSessionSeconds = Number(retention.avgSessionSeconds || 0);
    const modules = safeArray(data.moduleEngagement && data.moduleEngagement.length ? data.moduleEngagement : data.moduleAdoption);
    const bottlenecks = safeArray(activation.bottlenecks).map(function (item) {
      return { label: item.label, value: item.value, detail: item.action };
    });
    const deviceMix = safeArray(retention.sessionsByDevice).map(function (row) {
      return { label: "Device: " + (row.label || "unknown"), count: row.count || 0 };
    }).concat(safeArray(retention.sessionsByBrowser).map(function (row) {
      return { label: "Browser: " + (row.label || "unknown"), count: row.count || 0 };
    }));
    const pathMix = safeArray(retention.topRoutes).map(function (row) {
      return { label: "Route: " + (row.label || "unknown"), count: row.count || 0 };
    }).concat(safeArray(retention.topModules).map(function (row) {
      return { label: "Module: " + (row.label || "unknown"), count: row.count || 0 };
    }));
    return (
      '<section class="admin-usage-hero">' +
        '<div><span class="admin-kicker">Usage command view</span><h2>Decision-ready engagement dashboard</h2><p>Use this board to see whether candidates activate, return, and keep using the modules that move applications forward.</p></div>' +
        '<div class="admin-usage-hero-score"><strong>' + st((activation.activatedRate != null ? activation.activatedRate : activation.score || 0) + "%") + '</strong><span>Activation rate</span><em>' + st((retention.cohortSummary && retention.cohortSummary.habitSignal) || "waiting") + ' retention signal</em></div>' +
      '</section>' +
      renderUsageKpiStrip(data, activation, retention, avgSessionSeconds) +
      '<section class="admin-grid admin-grid--usage">' +
        '<article class="admin-panel admin-panel--wide admin-panel--priority admin-panel--full">' +
          '<div class="admin-panel-head"><div><span>Daily active users</span><h2>30-day engagement trend</h2></div><span class="chip cyan">Live chart</span></div>' +
          renderUsageTrend(retention) +
        '</article>' +
        '<article class="admin-panel admin-panel--wide admin-panel--priority">' +
          '<div class="admin-panel-head"><div><span>Activation funnel</span><h2>Signed up to job moved forward</h2></div><span class="chip ' + st(progressTone(activation.score)) + '">' + st(activation.score || 0) + '% activated</span></div>' +
          renderActivationFunnel(activation) +
        '</article>' +
        '<article class="admin-panel admin-panel--priority">' +
          '<div class="admin-panel-head"><div><span>Top drop-offs</span><h2>Where the workflow leaks</h2></div><span class="chip amber">' + st(bottlenecks.length || 0) + ' funnel signals</span></div>' +
          renderTopDropOffs(activation, modules, retention) +
        '</article>' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>Module engagement</span><h2>Module adoption and depth</h2></div><span class="chip blue">Phase 4</span></div>' +
          renderModuleEngagement(modules) +
        '</article>' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>Retention cohorts</span><h2>Do new users come back?</h2></div><span class="chip cyan">Phase 5</span></div>' +
          renderRetentionCohorts(retention) +
        '</article>' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>Session quality</span><h2>Depth, duration, and navigation</h2></div><span class="chip cyan">Phase 2</span></div>' +
          renderSessionQuality(retention, deviceMix, pathMix, avgSessionSeconds) +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Product recommendations</span><h2>What to improve next</h2></div><span class="chip amber">' + st((data.productInsights || []).length + (bottlenecks.length || 0)) + ' signals</span></div>' +
          renderInsightList(safeArray(data.productInsights).concat(bottlenecks.map(function (item) {
            return { severity: "info", title: item.label, body: item.detail, section: "usage" };
          }))) +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Weekly cohorts</span><h2>Activity rhythm</h2></div><span class="chip cyan">6 weeks</span></div>' +
          renderCohortBars(retention.cohorts) +
        '</article>' +
      '</section>'
    );
  }

  function renderUsers(data) {
    const users = data.userStats || {};
    const rows = Array.isArray(users.latest) ? users.latest : [];
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Total users", users.total || data.totals.users || 0, (users.newLast30 || 0) + " new in 30 days", "green") +
        renderStat("Active users", users.activeLast7 || 0, "signed in during last 7 days", "cyan") +
        renderStat("Admin operators", users.admins || 0, "protected app_metadata roles", "blue") +
        renderStat("Profiles", data.totals.profiles || 0, "candidate records created", "violet") +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Supabase Auth</span><h2>Recent user accounts</h2></div><span class="chip green">Admin-only</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--six admin-table-head"><span>Email</span><span>Role</span><span>Pipeline</span><span>Saved jobs</span><span>AI calls</span><span>Last activity</span></div>' +
          (rows.length ? rows.map(function (user) {
            const roles = Array.isArray(user.roles) && user.roles.length ? user.roles.join(", ") : "candidate";
            return '<div class="admin-table-row admin-table-row--six"><span>' + st(user.email || "No email") + '</span><span>' + st(roles) + '</span><span>' + st(user.pipelineCount || 0) + '</span><span>' + st(user.savedJobCount || 0) + '</span><span>' + st(user.aiRequests || 0) + '</span><span>' + st(formatDateTime(user.lastActivityAt || user.lastSignInAt || user.createdAt)) + '</span></div>';
          }).join("") : '<p class="admin-copy">No cloud user rows returned yet. Refresh after deploying the admin-overview function.</p>') +
        '</div>' +
      '</article>'
    );
  }

  function supportTone(health) {
    const score = Number(health || 0);
    if (score >= 75) return "green";
    if (score >= 55) return "amber";
    return "red";
  }

  function renderUserSupport(data) {
    const support = data.support || {};
    const summary = support.summary || {};
    const queues = support.queues || {};
    const accounts = safeArray(support.accounts);
    const playbooks = safeArray(support.playbooks);
    return (
      '<section class="admin-stat-grid">' +
        renderStat("At-risk accounts", summary.atRisk || queues.atRisk || 0, "health below support threshold", (summary.atRisk || queues.atRisk) ? "amber" : "green") +
        renderStat("Average health", (summary.averageHealth || 0) + "%", "metadata-only account readiness", supportTone(summary.averageHealth)) +
        renderStat("Resume needed", queues.resumeNeeded || 0, "users blocked before applying", queues.resumeNeeded ? "amber" : "green") +
        renderStat("No job captured", queues.jobCaptureNeeded || 0, "users without a saved/tracked role", queues.jobCaptureNeeded ? "amber" : "cyan") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>User support</span><h2>Account health queue</h2></div><span class="chip ' + st(accounts.length ? "blue" : "amber") + '">' + st(accounts.length ? accounts.length + " monitored" : "Waiting") + '</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--support admin-table-head"><span>User</span><span>Health</span><span>Stage</span><span>Blockers</span><span>Recommended action</span><span>Last activity</span></div>' +
            (accounts.length ? accounts.map(function (account) {
              const blockers = Array.isArray(account.blockers) && account.blockers.length ? account.blockers.join(", ") : "No blocker";
              return '<div class="admin-table-row admin-table-row--support"><span>' + st(account.email || "No email") + '</span><span><b class="admin-health-pill admin-health-pill--' + st(supportTone(account.health)) + '">' + st(account.health || 0) + '%</b></span><span>' + st(account.stage || "unknown") + '</span><span>' + st(blockers) + '</span><span>' + st(account.recommendedAction || "") + '</span><span>' + st(formatDateTime(account.lastActivityAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No support account rows returned yet. Refresh after deploying the admin-overview function.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Support queues</span><h2>Where candidates get stuck</h2></div><span class="chip cyan">Privacy-safe</span></div>' +
          '<div class="admin-support-queue">' +
            '<span><strong>' + st(queues.resumeNeeded || 0) + '</strong><em>Resume needed</em></span>' +
            '<span><strong>' + st(queues.jobCaptureNeeded || 0) + '</strong><em>Need first job</em></span>' +
            '<span><strong>' + st(queues.savedOnly || 0) + '</strong><em>Saved only</em></span>' +
            '<span><strong>' + st(queues.inactive || 0) + '</strong><em>Inactive</em></span>' +
            '<span><strong>' + st(queues.aiIssue || 0) + '</strong><em>AI issue</em></span>' +
          '</div>' +
          '<p class="admin-copy">' + st(support.privacy || "Support health excludes candidate document body text.") + '</p>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Support playbooks</span><h2>What operators should do</h2></div><span class="chip green">Read-only guidance</span></div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          (playbooks.length ? playbooks.map(function (book) {
            return '<div class="admin-action-card"><i class="fa-solid fa-user-check"></i><div><strong>' + st(book.title || "Support playbook") + '</strong><span>' + st(book.action || "") + '</span></div></div>';
          }).join("") : '<p class="admin-copy">Support playbooks will appear after the backend returns Phase 7 telemetry.</p>') +
        '</div>' +
      '</article>'
    );
  }

  function renderFunnel(data) {
    const funnel = data.funnel || {};
    const recent = safeArray(data.recentApplications);
    const stale = safeArray(data.staleSaved);
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Saved to applied", (funnel.savedToAppliedRate || 0) + "%", "roles moving into applications", "cyan") +
        renderStat("Interview rate", (funnel.interviewRate || 0) + "%", "tracked records reaching interview", "blue") +
        renderStat("Offer rate", (funnel.offerRate || 0) + "%", "tracked records reaching offer", "green") +
        renderStat("Closed outcomes", (data.totals.rejected || 0) + (data.totals.withdrawn || 0), "rejected or withdrawn", "amber") +
      '</section>' +
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Pipeline shape</span><h2>Application funnel by stage</h2></div><span class="chip violet">Cloud aggregate</span></div>' +
        '<div class="admin-funnel admin-funnel--six">' +
          '<div><strong>' + st(data.totals.saved) + '</strong><span>Saved</span></div>' +
          '<div><strong>' + st(data.totals.applied) + '</strong><span>Applied</span></div>' +
          '<div><strong>' + st(data.totals.interviews) + '</strong><span>Interview</span></div>' +
          '<div><strong>' + st(data.totals.offers) + '</strong><span>Offer</span></div>' +
          '<div><strong>' + st(data.totals.rejected || 0) + '</strong><span>Rejected</span></div>' +
          '<div><strong>' + st(data.totals.withdrawn || 0) + '</strong><span>Withdrawn</span></div>' +
        '</div>' +
      '</article>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Recent movement</span><h2>Latest pipeline records</h2></div><span class="chip cyan">' + st(recent.length) + ' rows</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Company</span><span>Role</span><span>Stage</span><span>Source</span><span>Updated</span></div>' +
            (recent.length ? recent.map(function (app) {
              return '<div class="admin-table-row admin-table-row--five"><span>' + st(app.company) + '</span><span>' + st(app.role) + '</span><span>' + st(app.stage) + '</span><span>' + st(hostLabel(app.sourceHost)) + '</span><span>' + st(formatDateTime(app.updatedAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No recent pipeline activity returned from the admin backend.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Follow-up risk</span><h2>Stale saved roles</h2></div><span class="chip amber">' + st(stale.length) + ' watch</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Company</span><span>Role</span><span>Age</span><span>Updated</span></div>' +
            (stale.length ? stale.map(function (app) {
              return '<div class="admin-table-row admin-table-row--four"><span>' + st(app.company) + '</span><span>' + st(app.role) + '</span><span>' + st((app.ageDays || 0) + " days") + '</span><span>' + st(formatDateTime(app.updatedAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No stale saved roles in the latest admin sample.</p>') +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  function renderAiCost(data) {
    const skills = data.ai.bySkill || [];
    const failures = safeArray(data.recentAiFailures);
    const providers = safeArray(data.aiProviders);
    const budget = data.aiBudget || {};
    return (
      '<section class="admin-stat-grid">' +
        renderStat("AI requests", data.ai.totalEvents || 0, (data.ai.failed || 0) + " failed", data.ai.failed ? "amber" : "green") +
        renderStat("Monthly run-rate", money(budget.monthlyRunRateUsd != null ? budget.monthlyRunRateUsd : data.ai.costUsd || 0), "estimated from 30-day sample", budget.status === "watch" ? "amber" : "blue") +
        renderStat("Avg latency", (data.ai.avgLatencyMs || 0) + "ms", "successful and failed calls", "cyan") +
        renderStat("Cost per request", money(budget.costPerRequestUsd || 0), "blended provider average", "violet") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>AI telemetry</span><h2>Usage by skill</h2></div><span class="chip blue">30 days</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-head"><span>Skill</span><span>Calls</span><span>Failed</span><span>Cost</span></div>' +
            (skills.length ? skills.map(function (skill) {
              return '<div class="admin-table-row"><span>' + st(skill.label) + '</span><span>' + st(skill.count) + '</span><span>' + st(skill.failed || 0) + '</span><span>' + st(money(skill.costUsd || 0)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No AI telemetry has been written in the last 30 days.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Provider quality</span><h2>Cost and reliability by provider</h2></div><span class="chip ' + st(providers.some(function (p) { return p.status === "watch"; }) ? "amber" : "green") + '">Provider SLA</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Provider</span><span>Calls</span><span>Fail rate</span><span>Latency</span><span>Cost</span></div>' +
            (providers.length ? providers.map(function (provider) {
              return '<div class="admin-table-row admin-table-row--five"><span>' + st(provider.label) + '</span><span>' + st(provider.count) + '</span><span>' + st((provider.failureRate || 0) + "%") + '</span><span>' + st((provider.avgLatencyMs || 0) + "ms") + '</span><span>' + st(money(provider.costUsd || 0)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No provider-level AI telemetry has been written in the last 30 days.</p>') +
          '</div>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Reliability</span><h2>Recent AI failures</h2></div><span class="chip ' + st(failures.length ? "amber" : "green") + '">' + st(failures.length ? failures.length + " failures" : "Clean") + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Skill</span><span>Provider</span><span>Model</span><span>Error</span><span>Time</span></div>' +
          (failures.length ? failures.map(function (failure) {
            return '<div class="admin-table-row admin-table-row--five"><span>' + st(failure.skill) + '</span><span>' + st(failure.provider) + '</span><span>' + st(failure.model || "unknown") + '</span><span>' + st(failure.error) + '</span><span>' + st(formatDateTime(failure.at)) + '</span></div>';
          }).join("") : '<p class="admin-copy">No failed AI requests returned in the latest 30-day sample.</p>') +
        '</div>' +
      '</article>'
    );
  }

  function renderJobFeed(data) {
    const sources = data.jobFeedStats && Array.isArray(data.jobFeedStats.sources) ? data.jobFeedStats.sources : [];
    const issues = safeArray(data.sourceIssues);
    const quality = data.feedQuality || {};
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Saved feed jobs", data.totals.savedJobs || 0, "bookmarked/imported records", "cyan") +
        renderStat("Saved searches", data.totals.savedSearches || 0, "candidate query records", "blue") +
        renderStat("Healthy sources", quality.healthySources != null ? quality.healthySources : sources.length, "providers without current mismatch", "green") +
        renderStat("Issue rate", (quality.issueRate || 0) + "%", "provider label mismatches", issues.length ? "amber" : "green") +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Provider provenance</span><h2>Job source health</h2></div><span class="chip green">Source truth</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Source</span><span>Host</span><span>Jobs</span><span>Issues</span><span>Status</span></div>' +
          (sources.length ? sources.map(function (row) {
            return '<div class="admin-table-row admin-table-row--five"><span>' + st(row.label) + '</span><span>' + st(hostLabel(row.host)) + '</span><span>' + st(row.count) + '</span><span>' + st(row.issueCount || 0) + '</span><span>' + st(row.status || "healthy") + '</span></div>';
          }).join("") : '<p class="admin-copy">No source rows have been reported yet.</p>') +
        '</div>' +
      '</article>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Trust monitor</span><h2>Source truth issues</h2></div><span class="chip ' + st(issues.length ? "amber" : "green") + '">' + st(issues.length ? "Review" : "Clean") + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Job</span><span>Company</span><span>Source</span><span>Actual host</span><span>Saved</span></div>' +
          (issues.length ? issues.map(function (issue) {
            return '<div class="admin-table-row admin-table-row--five"><span>' + st(issue.title) + '</span><span>' + st(issue.company || "Unknown") + '</span><span>' + st(issue.source) + '</span><span>' + st(hostLabel(issue.host)) + '</span><span>' + st(formatDateTime(issue.savedAt)) + '</span></div>';
          }).join("") : '<p class="admin-copy">No provider/host mismatches detected in the latest saved job sample.</p>') +
        '</div>' +
      '</article>'
    );
  }

  function renderSyncHealth(data) {
    const warnings = data.cloud.warnings || [];
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Cloud status", data.cloud.connected ? "Live" : "Local", data.cloud.error || "Protected admin metrics", data.cloud.connected ? "green" : "amber") +
        renderStat("Events", data.totals.events || 0, (data.totals.upcomingEvents || 0) + " upcoming", "cyan") +
        renderStat("Resume bases", data.totals.resumes || 0, "users with resume text", "blue") +
        renderStat("Warnings", warnings.length, "partial backend reads", warnings.length ? "amber" : "green") +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Diagnostics</span><h2>Backend read health</h2></div><span class="chip subtle">Admin backend</span></div>' +
        (warnings.length
          ? '<ul class="admin-warning-list">' + warnings.map(function (warning) { return '<li>' + st(warning) + '</li>'; }).join("") + '</ul>'
          : '<p class="admin-copy">No backend warnings reported by the admin overview function.</p>') +
      '</article>'
    );
  }

  function renderExtensionHealth(data) {
    const jobImportSkill = safeArray(data.ai.bySkill).find(function (skill) {
      return String(skill.label || "").toLowerCase() === "job-import";
    });
    const linkedInSource = data.jobFeedStats && Array.isArray(data.jobFeedStats.sources)
      ? data.jobFeedStats.sources.find(function (row) { return String(row.label || "").toLowerCase().indexOf("linkedin") >= 0; })
      : null;
    const issues = safeArray(data.sourceIssues);
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Extension captures", linkedInSource ? linkedInSource.count : 0, "LinkedIn/imported saved jobs", linkedInSource ? "green" : "amber") +
        renderStat("Import telemetry", jobImportSkill ? jobImportSkill.count : 0, "job-import capture logs", jobImportSkill ? "cyan" : "amber") +
        renderStat("Failed imports", jobImportSkill ? (jobImportSkill.failed || 0) : 0, "extension telemetry failures", jobImportSkill && jobImportSkill.failed ? "amber" : "green") +
        renderStat("Source conflicts", issues.length, "host/provider mismatches", issues.length ? "amber" : "green") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Capture pipeline</span><h2>Extension operating checks</h2></div><span class="chip blue">Browser capture</span></div>' +
          '<div class="admin-action-list">' +
            '<div class="admin-action-card"><i class="fa-solid fa-shield-halved"></i><div><strong>Token handoff</strong><span>Extension saves should use the signed-in Supabase session, then refresh the pipeline without manual reload.</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-file-lines"></i><div><strong>Description quality</strong><span>Captured jobs should include full structured descriptions, not only source and location.</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-link"></i><div><strong>Source truth</strong><span>Provider labels must match the canonical listing host shown to the candidate.</span></div></div>' +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Detected issues</span><h2>Source conflicts</h2></div><span class="chip ' + st(issues.length ? "amber" : "green") + '">' + st(issues.length ? "Review" : "Clean") + '</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Job</span><span>Source</span><span>Host</span><span>Saved</span></div>' +
            (issues.length ? issues.slice(0, 6).map(function (issue) {
              return '<div class="admin-table-row admin-table-row--four"><span>' + st(issue.title) + '</span><span>' + st(issue.source) + '</span><span>' + st(hostLabel(issue.host)) + '</span><span>' + st(formatDateTime(issue.savedAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No extension/source conflicts detected in the current sample.</p>') +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  function serviceTone(status) {
    const s = String(status || "").toLowerCase();
    if (s === "healthy" || s === "ready") return "green";
    if (s === "incident" || s === "blocked" || s === "critical") return "red";
    return "amber";
  }

  function renderRiskCenter(data) {
    const control = data.controlCenter || {};
    const incidents = safeArray(control.incidents);
    const levels = safeArray(control.serviceLevels);
    const runbooks = safeArray(control.runbooks);
    const readiness = control.releaseReadiness || {};
    const checks = safeArray(readiness.checks);
    const escalation = control.escalation || {};
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Open incidents", incidents.length, "critical and warning operator signals", incidents.length ? "amber" : "green") +
        renderStat("Release readiness", (readiness.score != null ? readiness.score : 0) + "%", readiness.status || "waiting for backend", serviceTone(readiness.status)) +
        renderStat("Service levels", levels.length, "operational checks", "cyan") +
        renderStat("Runbooks", runbooks.length, "response playbooks", "blue") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Risk center</span><h2>Open incidents</h2></div><span class="chip ' + st(incidents.length ? "amber" : "green") + '">' + st(incidents.length ? "Review" : "Clean") + '</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Severity</span><span>Area</span><span>Incident</span><span>Runbook</span><span>Status</span></div>' +
            (incidents.length ? incidents.map(function (item) {
              return '<div class="admin-table-row admin-table-row--five"><span>' + st(item.severity || "info") + '</span><span>' + st(item.affectedArea || "overview") + '</span><span>' + st(item.title || "Incident") + '</span><span>' + st(item.runbookId || "review") + '</span><span>' + st(item.status || "open") + '</span></div>';
            }).join("") : '<p class="admin-copy">No open incidents. Keep monitoring job source truth, AI reliability, sync health, and activation.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Service levels</span><h2>Operating health checks</h2></div><span class="chip blue">Live controls</span></div>' +
          '<div class="admin-sla-list">' +
            (levels.length ? levels.map(function (row) {
              return (
                '<a class="admin-sla-row admin-sla-row--' + st(serviceTone(row.status)) + '" href="#/admin?section=' + st(row.section || "overview") + '">' +
                  '<span></span><div><strong>' + st(row.label) + '</strong><small>' + st(row.target) + '</small></div><em>' + st(row.current) + '</em>' +
                '</a>'
              );
            }).join("") : '<p class="admin-copy">Service-level checks will appear after the admin backend returns Phase 6 telemetry.</p>') +
          '</div>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Release readiness</span><h2>Can CareerBoost ship safely?</h2></div><span class="chip ' + st(serviceTone(readiness.status)) + '">' + st(readiness.status || "waiting") + '</span></div>' +
        '<div class="admin-readiness-grid">' +
          (checks.length ? checks.map(function (check) {
            return '<div class="admin-readiness-card ' + (check.pass ? "is-pass" : "is-fail") + '"><i class="fa-solid ' + (check.pass ? "fa-check" : "fa-triangle-exclamation") + '"></i><strong>' + st(check.label) + '</strong><span>' + st(check.detail || "") + '</span></div>';
          }).join("") : '<p class="admin-copy">Release checks need the deployed admin backend snapshot.</p>') +
        '</div>' +
      '</article>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Runbooks</span><h2>How operators respond</h2></div><span class="chip cyan">Playbooks</span></div>' +
          '<div class="admin-runbook-list">' +
            (runbooks.length ? runbooks.map(function (book) {
              return (
                '<details class="admin-runbook">' +
                  '<summary><span>' + st(book.title) + '</span><em>' + st(book.ownerArea || "ops") + '</em></summary>' +
                  '<ol>' + safeArray(book.steps).map(function (step) { return '<li>' + st(step) + '</li>'; }).join("") + '</ol>' +
                '</details>'
              );
            }).join("") : '<p class="admin-copy">Runbooks will appear after the backend is deployed.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Escalation policy</span><h2>Operating cadence</h2></div><span class="chip green">Read-only</span></div>' +
          '<div class="admin-action-list">' +
            '<div class="admin-action-card"><i class="fa-solid fa-bell"></i><div><strong>Review policy</strong><span>' + st(escalation.policy || "Review critical incidents before releasing candidate-facing changes.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-calendar-check"></i><div><strong>Cadence</strong><span>' + st(escalation.cadence || "Daily while incidents are open; weekly when all systems are healthy.") + '</span></div></div>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  function renderReports(data) {
    const reports = data.reports || {};
    const audit = reports.audit || {};
    const governance = reports.governance || {};
    const privacy = reports.privacyControls || data.privacyControls || {};
    const freshness = reports.dataFreshness || data.dataFreshness || {};
    const manifest = safeArray(reports.exportManifest);
    const summary = safeArray(reports.executiveSummary);
    const queue = safeArray(data.actionQueue && data.actionQueue.length ? data.actionQueue : reports.actionQueue);
    const risks = reports.csv && Array.isArray(reports.csv.risks) ? reports.csv.risks : safeArray(data.alerts);
    const sampled = audit.sampledRecords || {};
    const sampledRows = Object.keys(sampled).map(function (key) {
      return '<span><strong>' + st(key) + '</strong><em>' + st(sampled[key]) + '</em></span>';
    }).join("");
    const health = Number(reports.healthScore || 0);
    const healthTone = health >= 80 ? "green" : (health >= 60 ? "amber" : "red");
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Health score", health ? health + "%" : "Local", "activation, source truth, AI reliability, backend warnings", healthTone) +
        renderStat("Action queue", queue.length, "operator follow-ups", queue.length ? "amber" : "green") +
        renderStat("Export packages", manifest.length || (reports.csv ? Object.keys(reports.csv).length : 0), "CSV/JSON report bundles", "cyan") +
        renderStat("Stale signals", (freshness.staleSignals || []).length || 0, "telemetry freshness checks", (freshness.staleSignals || []).length ? "amber" : "green") +
        renderStat("Next review", formatDateTime(governance.recommendedNextReviewAt), "recommended governance cadence", "blue") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Reports &amp; audit</span><h2>Executive snapshot</h2></div><span class="chip ' + st(healthTone) + '">' + st(health ? health + "% health" : "Local") + '</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--three admin-table-head"><span>Signal</span><span>Value</span><span>Detail</span></div>' +
            (summary.length ? summary.map(function (row) {
              return '<div class="admin-table-row admin-table-row--three"><span>' + st(row.label) + '</span><span>' + st(row.value) + '</span><span>' + st(row.detail) + '</span></div>';
            }).join("") : '<p class="admin-copy">Connect the admin backend to generate the executive reporting snapshot.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Operational governance</span><h2>Audit record</h2></div><span class="chip green">Read-only</span></div>' +
          '<div class="admin-kv-grid">' +
            '<span><strong>Generated by</strong><em>' + st(audit.generatedBy || "Local preview") + '</em></span>' +
            '<span><strong>Generated at</strong><em>' + st(formatDateTime(audit.generatedAt || data.cloud.generatedAt)) + '</em></span>' +
            '<span><strong>Data window</strong><em>' + st(audit.dataWindow || "local") + '</em></span>' +
            '<span><strong>Backend warnings</strong><em>' + st(audit.backendWarnings || 0) + '</em></span>' +
            '<span><strong>Latest usage</strong><em>' + st(formatDateTime(freshness.latestUsageSessionAt || freshness.latestUsageEventAt)) + '</em></span>' +
          '</div>' +
          '<div class="admin-kv-grid admin-kv-grid--compact">' + (sampledRows || '<span><strong>Sample</strong><em>No cloud sample yet</em></span>') + '</div>' +
          '<p class="admin-copy">' + st(audit.privacy || "Reports should stay operational and avoid exporting candidate document body text.") + '</p>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Operator action queue</span><h2>What to review next</h2></div><span class="chip ' + st(queue.length ? "amber" : "green") + '">' + st(queue.length ? queue.length + " actions" : "Clean") + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Priority</span><span>Area</span><span>Issue</span><span>Action</span></div>' +
          (queue.length ? queue.map(function (item) {
            return '<div class="admin-table-row admin-table-row--four"><span>' + st(item.priority || "info") + '</span><span>' + st(item.ownerArea || item.section || "overview") + '</span><span>' + st(item.title || "Admin action") + '</span><span>' + st(item.action || "Review this signal.") + '</span></div>';
          }).join("") : '<p class="admin-copy">No operator actions are currently flagged.</p>') +
        '</div>' +
      '</article>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Export packages</span><h2>Download operator reports</h2></div><span class="chip blue">Phase 5</span></div>' +
          '<div class="admin-export-grid">' +
            '<button type="button" class="admin-export-card" data-admin-export="overview"><i class="fa-solid fa-table"></i><strong>Overview CSV</strong><span>Executive snapshot rows</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="risks"><i class="fa-solid fa-triangle-exclamation"></i><strong>Risks CSV</strong><span>' + st(risks.length) + ' alerts and actions</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="modules"><i class="fa-solid fa-layer-group"></i><strong>Modules CSV</strong><span>Adoption and records</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="cohortRetention"><i class="fa-solid fa-table-cells"></i><strong>Cohorts CSV</strong><span>Week 0-3 retention</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="sources"><i class="fa-solid fa-link"></i><strong>Sources CSV</strong><span>Provider provenance</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="providers"><i class="fa-solid fa-wand-magic-sparkles"></i><strong>AI providers CSV</strong><span>Cost and reliability</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="dataFreshness"><i class="fa-solid fa-clock-rotate-left"></i><strong>Freshness CSV</strong><span>Stale-data checks</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="incidents"><i class="fa-solid fa-shield-virus"></i><strong>Incidents CSV</strong><span>Open risk queue</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="serviceLevels"><i class="fa-solid fa-gauge-high"></i><strong>Service levels CSV</strong><span>Operating checks</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="accountHealth"><i class="fa-solid fa-user-check"></i><strong>Account health CSV</strong><span>Support queue</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="snapshot-json"><i class="fa-solid fa-code"></i><strong>Snapshot JSON</strong><span>Full admin report object</span></button>' +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Governance model</span><h2>Safety guardrails</h2></div><span class="chip green">Candidate-safe</span></div>' +
          '<div class="admin-action-list">' +
            '<div class="admin-action-card"><i class="fa-solid fa-user-shield"></i><div><strong>Access model</strong><span>' + st(audit.accessModel || "Supabase app_metadata roles protect this dashboard.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-key"></i><div><strong>Secret model</strong><span>' + st(governance.secretModel || "Provider credentials stay backend-side.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-ban"></i><div><strong>Destructive actions</strong><span>' + st(governance.destructiveActionsDisabled === false ? "Enabled" : "Disabled in this console.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-file-export"></i><div><strong>Export scope</strong><span>' + st(governance.exportScope || "Aggregated operational metrics only.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-lock"></i><div><strong>Privacy controls</strong><span>' + st((privacy.excludedContent || []).length ? "Excludes " + privacy.excludedContent.join(", ") + "." : "Candidate document content is excluded from admin exports.") + '</span></div></div>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  function renderLogs(data) {
    const alerts = safeArray(data.alerts);
    const failures = safeArray(data.recentAiFailures);
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Open alerts", alerts.length, "operator signals", alerts.length ? "amber" : "green") +
        renderStat("Backend warnings", data.cloud.warnings.length, "partial reads", data.cloud.warnings.length ? "amber" : "green") +
        renderStat("AI failures", failures.length, "recent failed calls", failures.length ? "amber" : "green") +
        renderStat("Activity rows", data.remoteActivity.length, "latest backend events", "cyan") +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>System logs</span><h2>Operator event stream</h2></div><span class="chip blue">Phase 3</span></div>' +
        renderAlerts(data) +
        '<ul class="admin-activity-list admin-activity-list--spaced">' + renderActivity(data) + '</ul>' +
      '</article>'
    );
  }

  function renderAdminSettings(data) {
    // Phase A: surface backend privacy controls + allowed-roles so the
    // operator has a transparent view of WHO can access and WHAT this
    // console is permitted to see.
    const privacy = (data.privacyControls || (data.cloud && data.cloud.privacyControls)) || {};
    const access = (data.cloud && data.cloud.access) || {};
    const allowedRoles = Array.isArray(access.allowedRoles) && access.allowedRoles.length
      ? access.allowedRoles
      : ["admin", "owner", "developer"];
    const disallowedKeys = Array.isArray(privacy.disallowedMetadataKeys) ? privacy.disallowedMetadataKeys : [];
    const excludedContent = Array.isArray(privacy.excludedContent) ? privacy.excludedContent : [];
    const allowedTelemetry = Array.isArray(privacy.allowedTelemetry) ? privacy.allowedTelemetry : [];
    const exportScope = privacy.exportScope || "Aggregated operational metrics only";
    const metadataMaxBytes = privacy.metadataMaxBytes || 4096;

    function chipList(items, tone) {
      if (!items.length) return '<span class="admin-copy">None reported.</span>';
      return items.map(function (item) {
        return '<span class="chip ' + (tone || "subtle") + '">' + st(item) + '</span>';
      }).join(" ");
    }

    return (
      '<section class="admin-stat-grid">' +
        renderStat("Admin auth", "Supabase", "app_metadata roles only", "green") +
        renderStat("Backend function", data.cloud.connected ? "Live" : "Waiting", "admin-overview", data.cloud.connected ? "green" : "amber") +
        renderStat("Secret handling", "Server", "provider keys stay backend-side", "cyan") +
        renderStat("Last refresh", formatDateTime(data.cloud.generatedAt), "admin metrics snapshot", "blue") +
      '</section>' +
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Admin settings</span><h2>Operational guardrails</h2></div><span class="chip green">Candidate-safe</span></div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-user-lock"></i><div><strong>Role-based access</strong><span>Only Supabase Auth app_metadata roles open this console. Candidate profile data cannot grant admin rights.</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-key"></i><div><strong>No user API keys</strong><span>Job-board and AI provider configuration belongs in backend environment secrets, never candidate settings.</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-magnifying-glass-chart"></i><div><strong>Provider provenance</strong><span>Search and extension imports should preserve source, host, capture method, and canonical URL.</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-rotate"></i><div><strong>Refresh discipline</strong><span>The console caches metrics briefly and gives operators a manual refresh for current backend state.</span></div></div>' +
        '</div>' +
      '</article>' +
      // Phase A: privacy disclosure panel. Mirrors the backend ADMIN_PRIVACY_CONTROLS
      // constant + ADMIN_ROLES env so the operator can see exactly what this
      // console is permitted to read/export.
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Privacy &amp; access disclosure</span><h2>What this console can see — and cannot</h2></div><span class="chip cyan">Transparency</span></div>' +
        '<p class="admin-copy">Sourced from the backend at request time. Reflects the ADMIN_ROLES env value and the privacy guard constraint on usage_events / usage_sessions metadata.</p>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-users-gear"></i><div><strong>Allowed admin roles (' + allowedRoles.length + ')</strong><span>' +
            chipList(allowedRoles, "blue") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-shield-halved"></i><div><strong>Export scope</strong><span>' + st(exportScope) + '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-eye"></i><div><strong>Telemetry permitted (' + allowedTelemetry.length + ')</strong><span>' +
            chipList(allowedTelemetry, "subtle") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-ban"></i><div><strong>Never exported / inspected (' + excludedContent.length + ')</strong><span>' +
            chipList(excludedContent, "amber") +
          '</span></div></div>' +
        '</div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-database"></i><div><strong>Blocked metadata keys (DB-enforced)</strong><span>' +
            (disallowedKeys.length
              ? '<code class="admin-codelist">' + disallowedKeys.map(st).join(", ") + '</code>'
              : "None reported.") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-ruler-horizontal"></i><div><strong>Metadata size cap</strong><span>' + st(metadataMaxBytes) + ' bytes per row. Enforced via Postgres check constraint.</span></div></div>' +
        '</div>' +
      '</article>'
    );
  }

  // Phase A: human-readable staleness for the toolbar. Tells the operator
  // how old the cached snapshot is so they don't trust stale numbers.
  function renderStalenessChip() {
    if (!adminRemote.loadedAt) return "";
    const ageMs = Date.now() - adminRemote.loadedAt;
    const ageSec = Math.max(0, Math.round(ageMs / 1000));
    let label;
    let tone;
    if (adminRemote.status === "loading") {
      label = "Loading data…";
      tone = "blue";
    } else if (adminRemote.status === "refreshing") {
      label = "Refreshing…";
      tone = "blue";
    } else if (adminRemote.status === "error") {
      label = "Refresh failed";
      tone = "amber";
    } else if (ageSec < 5) {
      label = "Just refreshed";
      tone = "green";
    } else if (ageSec < 60) {
      label = "Refreshed " + ageSec + "s ago";
      tone = ageSec < ADMIN_METRICS_TTL_MS / 1000 ? "green" : "amber";
    } else {
      const ageMin = Math.round(ageSec / 60);
      label = "Refreshed " + ageMin + "m ago";
      tone = "amber";
    }
    return '<span class="chip ' + tone + ' admin-staleness-chip" id="admin-staleness" title="Cache TTL is ' + (ADMIN_METRICS_TTL_MS / 1000) + 's; click Refresh to force a reload"><i class="fa-solid fa-clock-rotate-left"></i> ' + st(label) + '</span>';
  }

  function renderToolbar(access) {
    const user = access && access.user;
    const profile = access && access.profile;
    const name = (profile && profile.full_name) || (user && user.email) || "Operator";
    return (
      '<header class="admin-topbar">' +
        '<div>' +
          '<p class="admin-kicker">CareerBoost Admin</p>' +
          '<h1>Usage &amp; operations command center</h1>' +
        '</div>' +
        '<div class="admin-topbar-actions">' +
          '<span class="chip green"><i class="fa-solid fa-circle"></i> Live-ready</span>' +
          renderStalenessChip() +
          '<span class="chip blue"><i class="fa-solid fa-shield-halved"></i> ' + st(access.label || "Admin") + '</span>' +
          '<button type="button" class="btn-ghost" id="admin-export"><i class="fa-solid fa-download"></i> Export CSV</button>' +
          '<button type="button" class="btn-primary" id="admin-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>' +
        '</div>' +
        '<p class="admin-operator">Signed in as ' + st(name) + '</p>' +
      '</header>'
    );
  }

  function renderView() {
    const access = adminAccessState();
    if (!access.ok) return renderAccessDenied(access);
    const active = currentSection();
    const data = getAdminData();
    const content = active === "overview"
      ? renderOverview(data)
      : active === "usage"
        ? renderUsageEngagement(data)
        : active === "users"
          ? renderUsers(data)
          : active === "user-support"
            ? renderUserSupport(data)
            : active === "funnel"
              ? renderFunnel(data)
              : active === "ai-cost"
                ? renderAiCost(data)
                : active === "job-feed"
                  ? renderJobFeed(data)
                  : active === "sync"
                    ? renderSyncHealth(data)
                    : active === "extension"
                      ? renderExtensionHealth(data)
                      : active === "risk-center"
                        ? renderRiskCenter(data)
                        : active === "reports"
                          ? renderReports(data)
                          : active === "logs"
                            ? renderLogs(data)
                            : active === "settings"
                              ? renderAdminSettings(data)
                              // currentSection() already rejects unknown IDs,
                              // so this fallback is defensive only.
                              : renderOverview(data);
    return (
      '<section class="admin-shell">' +
        renderAdminNav(active) +
        '<main class="admin-main">' +
          renderToolbar(access) +
          '<div class="admin-content">' + content + '</div>' +
        '</main>' +
      '</section>'
    );
  }

  function csvCell(cell) {
    if (cell && typeof cell === "object") {
      cell = JSON.stringify(cell);
    }
    return '"' + String(cell == null ? "" : cell).replace(/"/g, '""') + '"';
  }

  function objectRowsToCsv(rows) {
    const list = safeArray(rows);
    if (!list.length) return "message\n" + csvCell("No rows available") + "\n";
    const columns = list.reduce(function (out, row) {
      Object.keys(row || {}).forEach(function (key) {
        if (out.indexOf(key) < 0) out.push(key);
      });
      return out;
    }, []);
    return [columns.map(csvCell).join(",")].concat(list.map(function (row) {
      return columns.map(function (column) { return csvCell(row ? row[column] : ""); }).join(",");
    })).join("\n");
  }

  function downloadAdminFile(filename, body, type) {
    if (window.CBV2.downloadText) {
      window.CBV2.downloadText(filename, body, type);
    } else {
      const blob = new Blob([body], { type: type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  function exportAdminReport(kind) {
    const data = getAdminData();
    const reports = data.reports || {};
    const csv = reports.csv || {};
    if (kind === "snapshot-json") {
      downloadAdminFile("careerboost-admin-snapshot.json", JSON.stringify(reports || {}, null, 2), "application/json");
      return;
    }
    let rows = csv[kind] || [];
    if (!rows.length && kind === "overview") {
      rows = [
        { metric: "pipeline_records", value: data.totals.applications },
        { metric: "saved_jobs", value: data.totals.savedJobs },
        { metric: "applied", value: data.totals.applied },
        { metric: "interviews", value: data.totals.interviews },
        { metric: "offers", value: data.totals.offers },
        { metric: "search_runs", value: data.totals.searchRuns },
        { metric: "ai_events", value: data.ai.totalEvents || 0 },
        { metric: "ai_failed", value: data.ai.failed || 0 },
        { metric: "sync_errors", value: data.syncErrors.length }
      ];
    }
    downloadAdminFile("careerboost-admin-" + String(kind || "overview") + ".csv", objectRowsToCsv(rows), "text/csv");
  }

  function exportOverviewCsv() {
    exportAdminReport("overview");
  }

  async function parseEdgeError(error) {
    let msg = error && error.message ? error.message : String(error || "Admin metrics failed.");
    try {
      if (error && error.context && typeof error.context.text === "function") {
        const text = await error.context.text();
        try {
          const json = JSON.parse(text);
          msg = json.error || json.message || msg;
        } catch (e) {
          if (text) msg = text.slice(0, 240);
        }
      }
    } catch (e) { /* ignore */ }
    return msg;
  }

  async function fetchAdminMetrics(force) {
    if (!isBackendAdminRuntime()) return null;
    if (adminRemote.inFlight) return null;
    if (!force && cloudDataIsFresh()) return adminRemote.data;
    adminRemote.inFlight = true;
    adminRemote.status = adminRemote.data ? "refreshing" : "loading";
    adminRemote.error = "";
    try {
      const auth = window.CBV2.auth;
      const client = auth && auth.getClient && auth.getClient();
      let result = null;
      if (client && client.functions && typeof client.functions.invoke === "function") {
        const invoked = await client.functions.invoke("admin-overview", { body: {} });
        if (invoked.error) throw new Error(await parseEdgeError(invoked.error));
        result = invoked.data;
      } else {
        const token = auth && auth.getAccessToken ? await auth.getAccessToken() : "";
        const endpoint = window.CBV2.config.getFunctionsUrl() + "/admin-overview";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            apikey: window.CBV2.config.getSupabaseAnon()
          },
          body: "{}"
        });
        result = await response.json();
        if (!response.ok || !result || result.ok === false) {
          throw new Error((result && result.error) || "Admin metrics failed.");
        }
      }
      applyRemoteSnapshot(result);
      return adminRemote.data;
    } catch (err) {
      adminRemote.status = "error";
      adminRemote.error = (err && err.message) || String(err || "Admin metrics failed.");
      adminRemote.loadedAt = Date.now();
      return null;
    } finally {
      adminRemote.inFlight = false;
      const state = window.CBV2.getState && window.CBV2.getState();
      if (state && state.route === "admin" && typeof window.CBV2.renderCurrentRoute === "function") {
        window.CBV2.renderCurrentRoute();
      }
    }
  }

  window.CBV2.adminMetrics = {
    fetch: fetchAdminMetrics,
    applyRemoteSnapshot: applyRemoteSnapshot,
    state: function () { return Object.assign({}, adminRemote); }
  };

  // Phase B: paginated admin-users fetcher. Returns the next page on
  // success, null on failure. Throttles concurrent requests; respects a
  // 30s in-memory TTL keyed on (page, perPage, sort, filter).
  async function fetchAdminUsers(opts) {
    opts = opts || {};
    if (!isBackendAdminRuntime()) return null;
    if (adminUsersRemote.inFlight) return null;

    const page = Number(opts.page) > 0 ? Number(opts.page) : adminUsersRemote.page;
    const perPage = Number(opts.perPage) > 0 ? Number(opts.perPage) : adminUsersRemote.perPage;
    const sort = typeof opts.sort === "string" && opts.sort ? opts.sort : adminUsersRemote.sort;
    const filter = typeof opts.filter === "string" ? opts.filter : adminUsersRemote.filter;
    const sameParams = page === adminUsersRemote.page
      && perPage === adminUsersRemote.perPage
      && sort === adminUsersRemote.sort
      && filter === adminUsersRemote.filter;
    const fresh = adminUsersRemote.loadedAt && Date.now() - adminUsersRemote.loadedAt < 30_000;
    if (!opts.force && sameParams && fresh && adminUsersRemote.data) {
      return adminUsersRemote.data;
    }

    adminUsersRemote.inFlight = true;
    adminUsersRemote.status = adminUsersRemote.data ? "refreshing" : "loading";
    adminUsersRemote.error = "";
    adminUsersRemote.page = page;
    adminUsersRemote.perPage = perPage;
    adminUsersRemote.sort = sort;
    adminUsersRemote.filter = filter;
    try {
      const auth = window.CBV2.auth;
      const client = auth && auth.getClient && auth.getClient();
      const body = { page: page, perPage: perPage, sort: sort, filter: filter };
      let result = null;
      if (client && client.functions && typeof client.functions.invoke === "function") {
        const invoked = await client.functions.invoke("admin-users", { body: body });
        if (invoked.error) throw new Error(await parseEdgeError(invoked.error));
        result = invoked.data;
      } else {
        const token = auth && auth.getAccessToken ? await auth.getAccessToken() : "";
        const endpoint = window.CBV2.config.getFunctionsUrl() + "/admin-users";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            apikey: window.CBV2.config.getSupabaseAnon()
          },
          body: JSON.stringify(body)
        });
        result = await response.json();
        if (!response.ok || !result || result.ok === false) {
          throw new Error((result && result.error) || "Admin users fetch failed.");
        }
      }
      adminUsersRemote.data = result;
      adminUsersRemote.status = "ready";
      adminUsersRemote.loadedAt = Date.now();
      return result;
    } catch (err) {
      adminUsersRemote.status = "error";
      adminUsersRemote.error = (err && err.message) || String(err || "Admin users fetch failed.");
      adminUsersRemote.loadedAt = Date.now();
      return null;
    } finally {
      adminUsersRemote.inFlight = false;
      const state = window.CBV2.getState && window.CBV2.getState();
      if (state && state.route === "admin" && typeof window.CBV2.renderCurrentRoute === "function") {
        window.CBV2.renderCurrentRoute();
      }
    }
  }

  window.CBV2.adminUsers = {
    fetch: fetchAdminUsers,
    state: function () { return Object.assign({}, adminUsersRemote); },
  };

  // Phase A: staleness ticker. Updates the toolbar chip every 10s so the
  // "Refreshed Xs ago" text stays current without a full page render. Only
  // runs while the user is actually on /admin.
  let stalenessTickerId = null;
  function startStalenessTicker() {
    if (stalenessTickerId != null) return;
    if (typeof setInterval !== "function") return;
    stalenessTickerId = setInterval(function () {
      const state = window.CBV2.getState && window.CBV2.getState();
      if (!state || state.route !== "admin") {
        clearInterval(stalenessTickerId);
        stalenessTickerId = null;
        return;
      }
      const chip = document.getElementById("admin-staleness");
      if (!chip) return;
      // Reuse the same renderer to keep the label format consistent. Replace
      // the chip in place to avoid disturbing the rest of the toolbar.
      const next = renderStalenessChip();
      if (!next) {
        chip.remove();
        return;
      }
      const tmp = document.createElement("div");
      tmp.innerHTML = next;
      const fresh = tmp.firstElementChild;
      if (fresh) chip.replaceWith(fresh);
    }, 10_000);
  }

  window.CBV2.routes.admin = renderView;
  window.CBV2.afterRender.admin = function () {
    const refresh = document.getElementById("admin-refresh");
    const exportBtn = document.getElementById("admin-export");
    if (refresh) {
      refresh.addEventListener("click", function () {
        if (window.CBV2.profile && typeof window.CBV2.profile.load === "function") {
          window.CBV2.profile.load().catch(function () {});
        }
        if (window.CBV2.store && typeof window.CBV2.store.refreshApplications === "function") {
          window.CBV2.store.refreshApplications();
        }
        fetchAdminMetrics(true);
        window.CBV2.renderCurrentRoute();
      });
    }
    if (exportBtn) {
      exportBtn.addEventListener("click", exportOverviewCsv);
    }
    Array.prototype.slice.call(document.querySelectorAll("[data-admin-export]")).forEach(function (button) {
      button.addEventListener("click", function () {
        exportAdminReport(button.getAttribute("data-admin-export") || "overview");
      });
    });
    if (adminAccessState().ok && isBackendAdminRuntime() && (adminRemote.status === "idle" || (adminRemote.status === "ready" && !cloudDataIsFresh()))) {
      fetchAdminMetrics(false);
    }
    // Phase B: lazy-fetch the paginated admin-users endpoint when the
    // operator is on the Users or User Support section. This pulls the
    // FULL user list (~50/page) instead of the top-25 snapshot baked into
    // admin-overview, and is backed by mv_admin_per_user_stats so it's fast.
    const activeSection = currentSection();
    if (
      (activeSection === "users" || activeSection === "user-support") &&
      adminAccessState().ok &&
      isBackendAdminRuntime() &&
      (adminUsersRemote.status === "idle" ||
        (adminUsersRemote.status === "ready" && Date.now() - adminUsersRemote.loadedAt > 30_000))
    ) {
      fetchAdminUsers({});
    }
    startStalenessTicker();
  };
})();
