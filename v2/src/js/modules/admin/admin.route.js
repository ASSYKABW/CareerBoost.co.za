// Phase D: Slimmed admin.route.js.
//
// What lives HERE:
//   - Admin route registration + dispatcher
//   - Access gate (sections menu, role check, signed-in check)
//   - getAdminData()                  — merges local store + remote snapshot
//   - Cloud fetchers + mutation       — admin-overview, admin-users,
//     admin-list-operators, admin-promote-user, admin-incident-update,
//     admin-list-audit
//   - Section bindings                — Operator Management, User Support
//     pagination, Risk Center buttons, Audit Log filters
//   - CSV/JSON export pipeline        — exportAdminReport()
//   - Toolbar (refresh / export / staleness chip) + 10s staleness ticker
//
// What lives in admin-helpers.js:
//   - All shared formatters (st, money, formatDateTime, etc.)
//   - Shared sub-renderers (renderStat, renderAlerts, renderActivity, etc.)
//   - State caches (adminRemote, adminUsersRemote, adminOperatorsRemote,
//     adminIncidentsRemote, adminAuditRemote)
//
// What lives in sections/*.js:
//   - Per-section renderers — each calls helpers via window.CBV2.adminHelpers
//     and registers as window.CBV2.adminSections[id] = { render(data) }.
//
// Load order in index.html (critical):
//   1. admin-helpers.js   — state caches + shared helpers
//   2. sections/*.js      — register on window.CBV2.adminSections
//   3. admin.route.js     — this file (dispatcher + fetchers + bindings)
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  const helpers = window.CBV2.adminHelpers;
  const st = helpers.st;
  const safeArray = helpers.safeArray;
  const numberOr = helpers.numberOr;
  const daysBetween = helpers.daysBetween;
  const formatDateTime = helpers.formatDateTime;
  const ADMIN_METRICS_TTL_MS = helpers.ADMIN_METRICS_TTL_MS;
  const adminRemote = helpers.adminRemote;
  const adminUsersRemote = helpers.adminUsersRemote;
  const adminOperatorsRemote = helpers.adminOperatorsRemote;
  const adminIncidentsRemote = helpers.adminIncidentsRemote;
  const adminAuditRemote = helpers.adminAuditRemote;
  const adminUserTimelineRemote = helpers.adminUserTimelineRemote;

  // -- Section menu groups (drives the sidebar + currentSection() guard) ---
  // Phase E5: final IA. Seven entries across four groups. Every old
  // section ID still resolves (legacy URLs / bookmarks), but the nav
  // surfaces only the consolidated CEO-facing boards. Old IDs that no
  // longer appear in nav still route via their registered renderers.
  const sections = [
    {
      group: "Command",
      items: [
        { id: "command-center", icon: "fa-satellite-dish", label: "Command center" }
      ]
    },
    {
      // Analytics — the three lenses that matter:
      //   ROI (what produces placements) → Growth (where users come from)
      //   → Pipeline (candidate progression).
      group: "Analytics",
      items: [
        { id: "product-intelligence", icon: "fa-chart-mixed", label: "Product intelligence", badge: "ROI" },
        { id: "growth", icon: "fa-chart-line", label: "Growth & acquisition" },
        { id: "funnel", icon: "fa-filter-circle-dollar", label: "Pipeline funnel" }
      ]
    },
    {
      // Operate — the three control surfaces:
      //   Users (who) → Health (reliability) → Operations (governance).
      group: "Operate",
      items: [
        { id: "users", icon: "fa-users", label: "Users & outcomes" },
        { id: "health", icon: "fa-heart-pulse", label: "Health" },
        { id: "operations", icon: "fa-shield-halved", label: "Operations" }
      ]
    }
  ];

  // Legacy section IDs that pre-date the E5 consolidation. They are
  // still registered as renderers (see sections/*.js) so direct URLs
  // continue to work, but they don't appear in nav.
  const LEGACY_SECTION_IDS = [
    "overview",      // → command-center (alias)
    "usage",         // raw engagement deep dive
    "ai-cost",       // raw AI cost deep dive
    "extension",     // raw extension deep dive
    "job-feed",      // folded into health
    "sync",          // folded into health
    "risk-center",   // folded into health
    "reports",       // folded into operations
    "logs",          // folded into operations
    "settings",      // folded into operations
    "user-support",  // folded into users
  ];

  // -- Access gate ----------------------------------------------------------

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
    let section = String(params.section || "command-center").trim();
    // Phase E1: "overview" is the old home — redirect to command-center.
    if (section === "overview") section = "command-center";
    // Phase E3: "user-support" is folded into "users".
    if (section === "user-support") section = "users";
    // Phase E5: hard aliases that fully fold into a new board (no need to
    // keep the legacy renderer around because the new board covers it).
    // Note these are different from LEGACY_SECTION_IDS, which keep their
    // own renderers for deep-dive access.
    const navIds = sections.reduce(function (out, group) {
      return out.concat(group.items.map(function (item) { return item.id; }));
    }, []);
    const allValidIds = navIds.concat(LEGACY_SECTION_IDS);
    return allValidIds.indexOf(section) >= 0 ? section : "command-center";
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

  // -- Data composer --------------------------------------------------------

  // Merges the local store snapshot (offline / preview baseline) with the
  // cloud admin-overview payload. Sections render off the returned object.
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
      remoteActivity: [],
      // Phase E1: Command Center blocks (filled in from remote snapshot).
      northStar: null,
      aarrr: [],
      priorities: [],
      weeklyChanges: [],
      outcomes: null,
      // Phase E2: Growth & Acquisition block.
      growth: null,
      // Phase E3: Users board segments + timeline state.
      userSegments: null,
      // Phase E4: Product Intelligence.
      productIntelligence: null,
      // Phase 8: client error telemetry.
      clientErrors: null
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
      // Phase E1: Command Center blocks. When the function isn't deployed
      // yet (older snapshot), these read as null/[] and the Command Center
      // renders a degraded view that still works off the local store.
      data.northStar = remote.northStar || null;
      data.aarrr = Array.isArray(remote.aarrr) ? remote.aarrr : [];
      data.priorities = Array.isArray(remote.priorities) ? remote.priorities : [];
      data.weeklyChanges = Array.isArray(remote.weeklyChanges) ? remote.weeklyChanges : [];
      data.outcomes = remote.outcomes || null;
      // Phase E2: Growth & Acquisition block.
      data.growth = remote.growth || null;
      // Phase E3: Users board segments.
      data.userSegments = remote.userSegments || null;
      // Phase E4: Product Intelligence — module ROI, AI economics, drop-offs.
      data.productIntelligence = remote.productIntelligence || null;
      // Phase 8: client-side error telemetry (last 24h).
      data.clientErrors = remote.clientErrors || null;
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

  // -- Access-denied / nav / toolbar shells ---------------------------------

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

  // Phase 8: real-time connection status chip. Reflects whether
  // the Supabase Realtime channel for admin_incidents + admin_audit_log
  // is currently subscribed and receiving events.
  function renderRealtimeChip() {
    const rt = window.CBV2.adminRealtime;
    if (!rt) return '<span class="chip subtle"><i class="fa-solid fa-circle"></i> Realtime off</span>';
    const s = rt.state();
    if (s.status === "live") {
      return '<span class="chip green" id="admin-realtime-chip" title="Real-time channel is subscribed. Incidents + audit log updates arrive without manual refresh."><i class="fa-solid fa-circle fa-beat-fade"></i> Live</span>';
    }
    if (s.status === "connecting") {
      return '<span class="chip blue" id="admin-realtime-chip" title="Connecting to real-time channel…"><i class="fa-solid fa-circle-notch fa-spin"></i> Connecting</span>';
    }
    if (s.status === "error") {
      return '<span class="chip amber" id="admin-realtime-chip" title="Real-time channel disconnected. Reverting to manual refresh."><i class="fa-solid fa-triangle-exclamation"></i> Realtime stale</span>';
    }
    return '<span class="chip subtle" id="admin-realtime-chip"><i class="fa-solid fa-circle"></i> Realtime off</span>';
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
          renderRealtimeChip() +
          renderStalenessChip() +
          '<span class="chip blue"><i class="fa-solid fa-shield-halved"></i> ' + st(access.label || "Admin") + '</span>' +
          '<button type="button" class="btn-ghost" id="admin-export"><i class="fa-solid fa-download"></i> Export CSV</button>' +
          '<button type="button" class="btn-primary" id="admin-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>' +
        '</div>' +
        '<p class="admin-operator">Signed in as ' + st(name) + '</p>' +
      '</header>'
    );
  }

  // -- Dispatcher -----------------------------------------------------------

  function renderView() {
    const access = adminAccessState();
    if (!access.ok) return renderAccessDenied(access);
    const active = currentSection();
    const data = getAdminData();
    const registry = window.CBV2.adminSections || {};
    const section = registry[active] || registry.overview;
    // section is guaranteed to exist because currentSection() rejects unknown
    // IDs and the section files self-register at script load. Defensive
    // fallback below in case a section script failed to load.
    const content = section && typeof section.render === "function"
      ? section.render(data)
      : '<p class="admin-copy">Admin section "' + st(active) + '" failed to load.</p>';
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

  // -- CSV/JSON exports -----------------------------------------------------

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

  // -- Fetchers + mutators (cloud endpoints) --------------------------------

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

  // Phase C: Operator Management — list, promote, demote.
  // Uses the same SDK-or-fetch pattern as fetchAdminMetrics so it works in
  // both modern (functions.invoke) and degraded (raw fetch) environments.
  async function callAdminEndpoint(name, body) {
    if (!isBackendAdminRuntime()) {
      throw new Error("Sign in as an admin to call " + name + ".");
    }
    const auth = window.CBV2.auth;
    const client = auth && auth.getClient && auth.getClient();
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const invoked = await client.functions.invoke(name, { body: body || {} });
      if (invoked.error) throw new Error(await parseEdgeError(invoked.error));
      return invoked.data;
    }
    const token = auth && auth.getAccessToken ? await auth.getAccessToken() : "";
    const endpoint = window.CBV2.config.getFunctionsUrl() + "/" + name;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: window.CBV2.config.getSupabaseAnon()
      },
      body: JSON.stringify(body || {})
    });
    const result = await response.json();
    if (!response.ok || !result || result.ok === false) {
      throw new Error((result && result.error) || (name + " failed."));
    }
    return result;
  }

  async function fetchAdminOperators(force) {
    if (adminOperatorsRemote.inFlight) return null;
    if (!force && adminOperatorsRemote.data && Date.now() - adminOperatorsRemote.loadedAt < 60_000) {
      return adminOperatorsRemote.data;
    }
    adminOperatorsRemote.inFlight = true;
    adminOperatorsRemote.status = adminOperatorsRemote.data ? "refreshing" : "loading";
    adminOperatorsRemote.error = "";
    try {
      const result = await callAdminEndpoint("admin-list-operators", {});
      adminOperatorsRemote.data = result;
      adminOperatorsRemote.status = "ready";
      adminOperatorsRemote.loadedAt = Date.now();
      return result;
    } catch (err) {
      adminOperatorsRemote.status = "error";
      adminOperatorsRemote.error = (err && err.message) || "Operator list failed.";
      adminOperatorsRemote.loadedAt = Date.now();
      return null;
    } finally {
      adminOperatorsRemote.inFlight = false;
      const state = window.CBV2.getState && window.CBV2.getState();
      if (state && state.route === "admin" && typeof window.CBV2.renderCurrentRoute === "function") {
        window.CBV2.renderCurrentRoute();
      }
    }
  }

  async function promoteOperator(opts) {
    opts = opts || {};
    adminOperatorsRemote.mutationBusy = true;
    adminOperatorsRemote.mutationError = "";
    window.CBV2.renderCurrentRoute();
    try {
      const body = {
        roles: Array.isArray(opts.roles) ? opts.roles : (opts.roles ? [opts.roles] : []),
        note: opts.note || ""
      };
      if (opts.targetUserId) body.targetUserId = opts.targetUserId;
      if (opts.targetEmail) body.targetEmail = opts.targetEmail;
      await callAdminEndpoint("admin-promote-user", body);
      if (window.CBV2.toast) {
        window.CBV2.toast.success(
          body.roles.length
            ? "Granted " + body.roles.join(", ") + " to " + (opts.targetEmail || opts.targetUserId)
            : "Removed admin roles from " + (opts.targetEmail || opts.targetUserId)
        );
      }
      // Force-refresh after mutation so the table is current.
      await fetchAdminOperators(true);
    } catch (err) {
      adminOperatorsRemote.mutationError = (err && err.message) || "Promote failed.";
      if (window.CBV2.toast) window.CBV2.toast.error(adminOperatorsRemote.mutationError);
    } finally {
      adminOperatorsRemote.mutationBusy = false;
      window.CBV2.renderCurrentRoute();
    }
  }

  window.CBV2.adminOperators = {
    fetch: fetchAdminOperators,
    promote: promoteOperator,
    state: function () { return Object.assign({}, adminOperatorsRemote); }
  };

  // Phase C.2: incident lifecycle mutation. After success we force-refresh
  // the admin-overview metrics so the new status (acknowledged / snoozed /
  // resolved) flows back into the Risk Center render.
  async function mutateIncident(incidentId, action, opts) {
    opts = opts || {};
    if (!incidentId || !action) return;
    adminIncidentsRemote.actingOnId = incidentId;
    adminIncidentsRemote.mutationBusy = true;
    adminIncidentsRemote.mutationError = "";
    window.CBV2.renderCurrentRoute();
    try {
      const body = { incidentId: incidentId, action: action };
      if (opts.note) body.note = String(opts.note).slice(0, 300);
      if (action === "snooze") body.snoozeHours = Math.max(1, Number(opts.snoozeHours) || 24);
      await callAdminEndpoint("admin-incident-update", body);
      if (window.CBV2.toast) {
        const label = action === "ack" ? "Acknowledged"
          : action === "resolve" ? "Resolved"
          : action === "snooze" ? "Snoozed"
          : "Reopened";
        window.CBV2.toast.success(label + " incident.");
      }
      // Force-refresh the admin-overview metrics so the Risk Center reflects
      // the new lifecycle state.
      await fetchAdminMetrics(true);
    } catch (err) {
      adminIncidentsRemote.mutationError = (err && err.message) || "Incident update failed.";
      if (window.CBV2.toast) window.CBV2.toast.error(adminIncidentsRemote.mutationError);
    } finally {
      adminIncidentsRemote.mutationBusy = false;
      adminIncidentsRemote.actingOnId = "";
      window.CBV2.renderCurrentRoute();
    }
  }

  window.CBV2.adminIncidents = {
    mutate: mutateIncident,
    state: function () { return Object.assign({}, adminIncidentsRemote); }
  };

  // Phase C.2: paginated audit log fetcher. 30s TTL keyed on
  // (page, perPage, action, targetEmail) so toggling filters doesn't blow
  // away cached pages but a manual refresh always wins.
  async function fetchAdminAudit(opts) {
    opts = opts || {};
    if (!isBackendAdminRuntime()) return null;
    if (adminAuditRemote.inFlight) return null;

    const page = Number(opts.page) > 0 ? Number(opts.page) : adminAuditRemote.page;
    const perPage = Number(opts.perPage) > 0 ? Number(opts.perPage) : adminAuditRemote.perPage;
    const actionFilter = typeof opts.action === "string" ? opts.action : adminAuditRemote.actionFilter;
    const targetEmailFilter = typeof opts.targetEmail === "string" ? opts.targetEmail : adminAuditRemote.targetEmailFilter;
    const sameParams = page === adminAuditRemote.page
      && perPage === adminAuditRemote.perPage
      && actionFilter === adminAuditRemote.actionFilter
      && targetEmailFilter === adminAuditRemote.targetEmailFilter;
    const fresh = adminAuditRemote.loadedAt && Date.now() - adminAuditRemote.loadedAt < 30_000;
    if (!opts.force && sameParams && fresh && adminAuditRemote.data) {
      return adminAuditRemote.data;
    }

    adminAuditRemote.inFlight = true;
    adminAuditRemote.status = adminAuditRemote.data ? "refreshing" : "loading";
    adminAuditRemote.error = "";
    adminAuditRemote.page = page;
    adminAuditRemote.perPage = perPage;
    adminAuditRemote.actionFilter = actionFilter;
    adminAuditRemote.targetEmailFilter = targetEmailFilter;
    try {
      const result = await callAdminEndpoint("admin-list-audit", {
        page: page,
        perPage: perPage,
        action: actionFilter,
        targetEmail: targetEmailFilter
      });
      adminAuditRemote.data = result;
      adminAuditRemote.status = "ready";
      adminAuditRemote.loadedAt = Date.now();
      return result;
    } catch (err) {
      adminAuditRemote.status = "error";
      adminAuditRemote.error = (err && err.message) || "Audit log fetch failed.";
      adminAuditRemote.loadedAt = Date.now();
      return null;
    } finally {
      adminAuditRemote.inFlight = false;
      const state = window.CBV2.getState && window.CBV2.getState();
      if (state && state.route === "admin" && typeof window.CBV2.renderCurrentRoute === "function") {
        window.CBV2.renderCurrentRoute();
      }
    }
  }

  window.CBV2.adminAudit = {
    fetch: fetchAdminAudit,
    state: function () { return Object.assign({}, adminAuditRemote); }
  };

  // Phase E3: per-user timeline drill-down fetcher. Calls
  // /admin-user-timeline which wraps the admin_user_timeline RPC
  // (SECURITY DEFINER + admin role gate). Pulls profile, applications,
  // outcomes, recent sessions for one user — drives the inline drawer
  // in the consolidated Users board.
  async function fetchAdminUserTimeline(userId, email) {
    if (!userId) return null;
    if (adminUserTimelineRemote.inFlight) return null;
    adminUserTimelineRemote.inFlight = true;
    adminUserTimelineRemote.status = "loading";
    adminUserTimelineRemote.error = "";
    adminUserTimelineRemote.activeUserId = userId;
    adminUserTimelineRemote.activeUserEmail = email || "";
    window.CBV2.renderCurrentRoute();
    try {
      const result = await callAdminEndpoint("admin-user-timeline", { userId: userId });
      adminUserTimelineRemote.data = (result && result.timeline) || null;
      adminUserTimelineRemote.status = "ready";
      adminUserTimelineRemote.loadedAt = Date.now();
      return adminUserTimelineRemote.data;
    } catch (err) {
      adminUserTimelineRemote.status = "error";
      adminUserTimelineRemote.error = (err && err.message) || "Timeline fetch failed.";
      adminUserTimelineRemote.data = null;
      return null;
    } finally {
      adminUserTimelineRemote.inFlight = false;
      window.CBV2.renderCurrentRoute();
    }
  }

  function closeAdminUserTimeline() {
    adminUserTimelineRemote.activeUserId = "";
    adminUserTimelineRemote.activeUserEmail = "";
    adminUserTimelineRemote.data = null;
    adminUserTimelineRemote.status = "idle";
    adminUserTimelineRemote.error = "";
    window.CBV2.renderCurrentRoute();
  }

  window.CBV2.adminUserTimeline = {
    fetch: fetchAdminUserTimeline,
    close: closeAdminUserTimeline,
    state: function () { return Object.assign({}, adminUserTimelineRemote); }
  };

  // -- Toolbar refresh + staleness ticker -----------------------------------

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

  // -- Route registration + afterRender -------------------------------------

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
    // Phase E3: when navigating AWAY from users, close any open timeline
    // drawer so it doesn't leak across section changes.
    if (activeSection !== "users" && activeSection !== "user-support" && adminUserTimelineRemote.activeUserId) {
      adminUserTimelineRemote.activeUserId = "";
      adminUserTimelineRemote.activeUserEmail = "";
      adminUserTimelineRemote.data = null;
      adminUserTimelineRemote.status = "idle";
      adminUserTimelineRemote.activeSegment = "";
    }

    // Phase B.1 + E3: bind toolbar controls when on the Users board
    // (which now also serves the legacy user-support section ID).
    if (activeSection === "users" || activeSection === "user-support") {
      bindUserSupportControls();
      bindUserSegmentControls();
      bindUserTimelineControls();
    }

    // Phase C.2 + E5: bind Risk Center incident buttons on the new
    // consolidated Health board AND on the legacy risk-center deep link.
    if (activeSection === "risk-center" || activeSection === "health") {
      bindRiskCenterControls();
    }

    // Phase C.2 + E5: lazy-fetch + bind audit log viewer on Operations
    // board (consolidated) and the legacy reports section.
    if (activeSection === "reports" || activeSection === "operations") {
      if (
        adminAccessState().ok &&
        isBackendAdminRuntime() &&
        (adminAuditRemote.status === "idle" ||
          (adminAuditRemote.status === "ready" && Date.now() - adminAuditRemote.loadedAt > 30_000))
      ) {
        fetchAdminAudit({});
      }
      bindAuditLogControls();
    }

    // Phase C + E5: bind Operator Management controls on Operations
    // board (consolidated) and the legacy settings section.
    if (activeSection === "settings" || activeSection === "operations") {
      if (
        adminAccessState().ok &&
        isBackendAdminRuntime() &&
        (adminOperatorsRemote.status === "idle" ||
          (adminOperatorsRemote.status === "ready" && Date.now() - adminOperatorsRemote.loadedAt > 60_000))
      ) {
        fetchAdminOperators(false);
      }
      bindOperatorManagementControls();
    }

    startStalenessTicker();
    // Phase 8: subscribe to Supabase Realtime postgres_changes for
    // admin_incidents + admin_audit_log so the admin sees updates
    // without manual refresh.
    if (window.CBV2.adminRealtime && typeof window.CBV2.adminRealtime.setup === "function") {
      window.CBV2.adminRealtime.setup();
    }
  };

  // -- Bindings -------------------------------------------------------------

  // Phase C: Operator Management form + demote buttons.
  function bindOperatorManagementControls() {
    const refresh = document.getElementById("admin-operators-refresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        fetchAdminOperators(true);
      });
    }
    const form = document.getElementById("admin-operator-form");
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        const fd = new FormData(form);
        const email = String(fd.get("email") || "").trim().toLowerCase();
        const role = String(fd.get("role") || "").trim();
        const note = String(fd.get("note") || "").trim();
        if (!email || !role) return;
        promoteOperator({ targetEmail: email, roles: [role], note: note }).then(function () {
          // Clear the form on success (mutationError is "")
          if (!adminOperatorsRemote.mutationError) {
            try { form.reset(); } catch (e) { /* ignore */ }
          }
        });
      });
    }
    document.querySelectorAll("[data-admin-demote]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const userId = btn.getAttribute("data-admin-demote") || "";
        const email = btn.getAttribute("data-admin-demote-email") || "";
        if (!userId) return;
        // Phase 4.5: in-app modal replaces native confirm. Destructive
        // admin actions use the danger tone so the button is clearly red.
        const modal = window.CBV2 && window.CBV2.modal;
        const ok = modal && modal.confirm
          ? await modal.confirm({
              title: "Remove admin role?",
              body: "Demote " + (email || userId) + ". They will lose access to the admin console immediately. This is audit-logged.",
              confirmLabel: "Remove admin",
              tone: "danger",
            })
          : confirm("Remove admin role from " + (email || userId) + "? They will lose access immediately.");
        if (!ok) return;
        promoteOperator({ targetUserId: userId, targetEmail: email, roles: [], note: "demoted via UI" });
      });
    });
  }

  // Phase B.1: User Support pagination + sort + filter handlers.
  let userSupportFilterTimer = null;
  let userSupportRestoreFocus = false;
  function bindUserSupportControls() {
    const prevBtn = document.getElementById("admin-users-prev");
    const nextBtn = document.getElementById("admin-users-next");
    const sortSelect = document.getElementById("admin-users-sort");
    const filterInput = document.getElementById("admin-users-filter");

    if (prevBtn && !prevBtn.disabled) {
      prevBtn.addEventListener("click", function () {
        fetchAdminUsers({ page: Math.max(1, adminUsersRemote.page - 1), force: true });
      });
    }
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.addEventListener("click", function () {
        fetchAdminUsers({ page: adminUsersRemote.page + 1, force: true });
      });
    }
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        const nextSort = String(sortSelect.value || "health");
        // Sort change → return to page 1 so the user sees the top of the new order.
        fetchAdminUsers({ sort: nextSort, page: 1, force: true });
      });
    }
    if (filterInput) {
      // Debounce 350ms so each keystroke doesn't fire a request.
      filterInput.addEventListener("input", function () {
        if (userSupportFilterTimer != null) {
          clearTimeout(userSupportFilterTimer);
        }
        userSupportFilterTimer = setTimeout(function () {
          userSupportFilterTimer = null;
          const value = String(filterInput.value || "").trim();
          userSupportRestoreFocus = true;        // re-focus the input after the next render
          fetchAdminUsers({ filter: value, page: 1, force: true });
        }, 350);
      });
      // If a filter-fetch just completed, re-focus the input + put the caret
      // at the end so the user can keep typing without re-clicking.
      if (userSupportRestoreFocus) {
        userSupportRestoreFocus = false;
        try {
          filterInput.focus();
          const len = filterInput.value.length;
          filterInput.setSelectionRange(len, len);
        } catch (e) { /* ignore */ }
      }
    }
  }

  // Phase E3: segment chip click → set activeSegment, re-render. Click
  // the same chip again to clear the filter. The filtering itself is
  // done client-side in sections/users.js renderSupportTable.
  function bindUserSegmentControls() {
    document.querySelectorAll("[data-admin-segment]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const seg = btn.getAttribute("data-admin-segment") || "";
        if (adminUserTimelineRemote.activeSegment === seg) {
          adminUserTimelineRemote.activeSegment = "";
        } else {
          adminUserTimelineRemote.activeSegment = seg;
        }
        // Close any open timeline drawer when switching segments —
        // the row may scroll out of the filtered view.
        adminUserTimelineRemote.activeUserId = "";
        adminUserTimelineRemote.activeUserEmail = "";
        adminUserTimelineRemote.data = null;
        adminUserTimelineRemote.status = "idle";
        window.CBV2.renderCurrentRoute();
      });
    });
    const clear = document.querySelector("[data-admin-segment-clear]");
    if (clear) {
      clear.addEventListener("click", function () {
        adminUserTimelineRemote.activeSegment = "";
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  // Phase E3: timeline expand/collapse for per-user drill-down.
  function bindUserTimelineControls() {
    document.querySelectorAll("[data-admin-user-expand]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const userId = btn.getAttribute("data-admin-user-expand") || "";
        const email = btn.getAttribute("data-admin-user-email") || "";
        if (!userId) return;
        // Toggle: clicking the same row closes the drawer.
        if (adminUserTimelineRemote.activeUserId === userId) {
          closeAdminUserTimeline();
          return;
        }
        fetchAdminUserTimeline(userId, email);
      });
    });
    const closeBtn = document.querySelector("[data-admin-user-close]");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        closeAdminUserTimeline();
      });
    }
  }

  // Phase C.2: Risk Center incident ack/snooze/resolve/reopen handlers.
  function bindRiskCenterControls() {
    document.querySelectorAll("[data-incident-ack]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-incident-ack");
        if (id) mutateIncident(id, "ack", { note: "acknowledged via UI" });
      });
    });
    document.querySelectorAll("[data-incident-resolve]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const id = btn.getAttribute("data-incident-resolve");
        if (!id) return;
        const modal = window.CBV2 && window.CBV2.modal;
        const note = modal && modal.prompt
          ? await modal.prompt({
              title: "Resolve incident",
              body: "Add an optional resolution note. This is saved to the audit log.",
              placeholder: "e.g. \"Provider normalization rule deployed.\"",
              confirmLabel: "Resolve",
              multiline: true,
            })
          : (prompt("Optional resolution note (saved to audit log):", "") || "");
        if (note === null) return; // user cancelled
        mutateIncident(id, "resolve", { note: note || "" });
      });
    });
    document.querySelectorAll("[data-incident-snooze]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const id = btn.getAttribute("data-incident-snooze");
        if (!id) return;
        const modal = window.CBV2 && window.CBV2.modal;
        const hoursStr = modal && modal.prompt
          ? await modal.prompt({
              title: "Snooze incident",
              body: "How many hours should this incident stay quiet? It will reopen automatically at that time.",
              defaultValue: "24",
              placeholder: "1 - 168 hours",
              confirmLabel: "Snooze",
              validate: function (v) {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 1 || n > 168) return "Enter a number between 1 and 168 hours.";
                return null;
              }
            })
          : (prompt("Snooze for how many hours?", "24") || "24");
        if (hoursStr === null) return; // cancelled
        const hours = Math.max(1, Math.min(168, Number(hoursStr) || 24));
        mutateIncident(id, "snooze", { snoozeHours: hours, note: "snoozed " + hours + "h via UI" });
      });
    });
    document.querySelectorAll("[data-incident-reopen]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-incident-reopen");
        if (id) mutateIncident(id, "reopen", { note: "reopened via UI" });
      });
    });
  }

  // Phase C.2: audit log filter + pager handlers.
  let auditFilterTimer = null;
  let auditRestoreFocusId = "";
  function bindAuditLogControls() {
    const prevBtn = document.getElementById("admin-audit-prev");
    const nextBtn = document.getElementById("admin-audit-next");
    const refresh = document.getElementById("admin-audit-refresh");
    const actionInput = document.getElementById("admin-audit-action");
    const targetInput = document.getElementById("admin-audit-target");

    if (prevBtn && !prevBtn.disabled) {
      prevBtn.addEventListener("click", function () {
        fetchAdminAudit({ page: Math.max(1, adminAuditRemote.page - 1), force: true });
      });
    }
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.addEventListener("click", function () {
        fetchAdminAudit({ page: adminAuditRemote.page + 1, force: true });
      });
    }
    if (refresh) {
      refresh.addEventListener("click", function () { fetchAdminAudit({ force: true }); });
    }
    [actionInput, targetInput].forEach(function (input) {
      if (!input) return;
      input.addEventListener("input", function () {
        if (auditFilterTimer != null) clearTimeout(auditFilterTimer);
        auditFilterTimer = setTimeout(function () {
          auditFilterTimer = null;
          auditRestoreFocusId = input.id;
          fetchAdminAudit({
            action: String((actionInput && actionInput.value) || "").trim(),
            targetEmail: String((targetInput && targetInput.value) || "").trim(),
            page: 1,
            force: true
          });
        }, 350);
      });
      if (auditRestoreFocusId === input.id) {
        auditRestoreFocusId = "";
        try {
          input.focus();
          const len = input.value.length;
          input.setSelectionRange(len, len);
        } catch (e) { /* ignore */ }
      }
    });
  }
})();
