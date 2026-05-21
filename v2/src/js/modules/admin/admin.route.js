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
      // Credentials joins this group: it's an operational concern (key
      // rotation, status visibility), not analytics.
      group: "Operate",
      items: [
        { id: "users", icon: "fa-users", label: "Users & outcomes" },
        { id: "health", icon: "fa-heart-pulse", label: "Health" },
        { id: "operations", icon: "fa-shield-halved", label: "Operations" },
        { id: "credentials", icon: "fa-key", label: "API credentials" },
        // Phase 2.5: per-company ATS feed management (Greenhouse, Lever).
        { id: "tracked-companies", icon: "fa-building", label: "Tracked companies" }
      ]
    },
    {
      // Roadmap — deferred-feature reminders. Keeps shipped-but-hidden
      // work visible to operators so we don't forget to re-enable it
      // when prerequisites land.
      group: "Roadmap",
      items: [
        { id: "apply-assist", icon: "fa-paper-plane", label: "Apply Assist (deferred)", badge: "V1 hidden" }
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
    if (!byRole) {
      return { ok: false, reason: "forbidden", label: "Supabase admin role required", user: user, profile: profile };
    }

    // Day 3.2 — MFA elevation gate. The role check is necessary but no
    // longer sufficient: operators with a verified TOTP factor must
    // present a 6-digit code to elevate their session from aal1 to
    // aal2 before the admin console renders. The server-side gate
    // (getAuthedAdmin) enforces the same requirement so this isn't a
    // pure UI guard.
    const mfa = window.CBV2.adminMfa;
    if (mfa && typeof mfa.getSnapshot === "function") {
      const snap = mfa.getSnapshot();
      if (!snap.loaded) {
        // Snapshot not loaded yet — show a loading placeholder and the
        // afterRender hook will kick off the refresh.
        return { ok: false, reason: "mfa-loading", label: "Checking MFA", user: user, profile: profile };
      }
      // Edge case: snapshot loaded but errored out. Fall through and
      // let them in (with a console warning) rather than locking them
      // out of admin entirely on a transient SDK glitch. The server-
      // side gate will still enforce aal2 once 3.2 ships.
      if (snap.error) {
        console.warn("[admin.route] MFA snapshot error, allowing through:", snap.error);
      } else {
        const hasFactor = snap.verifiedFactors && snap.verifiedFactors.length > 0;
        const currentAal = String(snap.currentLevel || "aal1").toLowerCase();
        if (!hasFactor) {
          // Operator hasn't enrolled. Nudge them to /mfa-setup.html.
          // (Server-side enforcement will reject their admin RPCs
          // until they enroll + elevate, so this isn't optional.)
          return { ok: false, reason: "mfa-enroll", label: "MFA enrollment required", user: user, profile: profile };
        }
        if (currentAal !== "aal2") {
          // Has a factor, hasn't challenged this session yet. Show form.
          return { ok: false, reason: "mfa-challenge", label: "MFA challenge required", user: user, profile: profile };
        }
      }
    }

    return {
      ok: true,
      mode: "role",
      label: "Supabase role verified",
      user: user,
      profile: profile
    };
  }

  window.CBV2.adminAccess = {
    state: adminAccessState,
    canAccess: function () {
      return adminAccessState().ok;
    }
  };

  // A5: list of legacy → canonical section rewrites. Sourced from the
  // phase-E migrations: E1 collapsed overview → command-center, E3 folded
  // user-support → users. Add new entries here as boards consolidate.
  const SECTION_ALIASES = {
    "overview": "command-center",
    "user-support": "users"
  };

  function currentSection() {
    const params = (window.CBV2.getRouteParams && window.CBV2.getRouteParams()) || {};
    const rawSection = String(params.section || "command-center").trim();
    let section = rawSection;
    if (SECTION_ALIASES[section]) section = SECTION_ALIASES[section];

    // Phase E5: hard aliases that fully fold into a new board (no need to
    // keep the legacy renderer around because the new board covers it).
    // Note these are different from LEGACY_SECTION_IDS, which keep their
    // own renderers for deep-dive access.
    const navIds = sections.reduce(function (out, group) {
      return out.concat(group.items.map(function (item) { return item.id; }));
    }, []);
    const allValidIds = navIds.concat(LEGACY_SECTION_IDS);
    const resolved = allValidIds.indexOf(section) >= 0 ? section : "command-center";

    // A5: when the URL contains a legacy alias, rewrite the hash so
    // operators see the canonical path in the address bar (and copy/
    // paste the right link). Guarded by rawSection !== resolved so
    // it's a no-op on every other render. Uses replaceState so the
    // back button doesn't ping-pong.
    if (rawSection !== resolved && SECTION_ALIASES[rawSection] === resolved) {
      try {
        const url = new URL(window.location.href);
        const hash = url.hash || "";
        // Hash format: "#/admin?section=user-support&other=foo". Swap
        // just the section param, leave everything else intact.
        const qIdx = hash.indexOf("?");
        if (qIdx >= 0) {
          const pathPart = hash.slice(0, qIdx);
          const search = new URLSearchParams(hash.slice(qIdx + 1));
          if (search.get("section") === rawSection) {
            search.set("section", resolved);
            const newHash = pathPart + "?" + search.toString();
            if (newHash !== hash) {
              window.history.replaceState(null, "", url.pathname + url.search + newHash);
            }
          }
        }
      } catch (_e) { /* non-blocking */ }
    }
    return resolved;
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
    // Day 3.2 — MFA-related access states delegate to the adminMfa
    // module which owns the challenge form + enroll nudge UI.
    if (access) {
      const mfa = window.CBV2.adminMfa;
      if (access.reason === "mfa-loading" && mfa) return mfa.renderLoadingScreen();
      if (access.reason === "mfa-challenge" && mfa) return mfa.renderChallengeScreen();
      if (access.reason === "mfa-enroll" && mfa) return mfa.renderEnrollNudge();
    }
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

    // P3: when the user first lands on /admin (cold load) the
    // admin-overview RPC hasn't returned yet — adminRemote.data is
    // null and status is "loading". Previously we still called the
    // section renderer with mostly-empty `data`, which produced 4
    // blank-looking cards while waiting for the fetch. That's the
    // "ugly blank cards" the operator saw on first nav.
    //
    // Now: render a brand loading panel inside the admin shell (keeps
    // the nav + toolbar visible — only the content area shows the
    // loading state). Once data lands, the normal section renderer
    // takes over on the re-render.
    //
    // Conditions for showing the loader instead:
    //   - cloud is supposed to be connected (backend enabled), AND
    //   - we have no cached admin snapshot yet (first load), AND
    //   - the fetch is in progress (status === "loading"|"idle").
    // If status is "refreshing", we already have stale data and
    // should keep showing it — don't blank the page mid-refresh.
    const wantBackend = isBackendAdminRuntime && typeof isBackendAdminRuntime === "function"
      ? isBackendAdminRuntime()
      : false;
    const firstLoad = wantBackend
      && !adminRemote.data
      && (adminRemote.status === "loading" || adminRemote.status === "idle");

    const content = firstLoad
      ? renderFirstLoadPanel()
      : (section && typeof section.render === "function"
          ? section.render(data)
          : '<p class="admin-copy">Admin section "' + st(active) + '" failed to load.</p>');

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

  // P3: brand-matched loading panel shown on the very first admin load
  // before the metrics fetch completes. Uses the real CareerBoost mark
  // (inline SVG, matches v2/src/assets/logo-mark.svg) so the transition
  // from boot splash → admin loading → real content feels continuous.
  function renderFirstLoadPanel() {
    return (
      '<section class="admin-first-load">' +
        '<svg class="admin-first-load-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" aria-hidden="true">' +
          '<defs>' +
            '<linearGradient id="cbAdminMarkBg" x1="0" y1="0" x2="1" y2="1">' +
              '<stop offset="0%" stop-color="#0d1326"/>' +
              '<stop offset="100%" stop-color="#0a0f1d"/>' +
            '</linearGradient>' +
            '<linearGradient id="cbAdminMarkFill" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="rgba(34, 227, 255, 0.14)"/>' +
              '<stop offset="100%" stop-color="rgba(34, 227, 255, 0.04)"/>' +
            '</linearGradient>' +
          '</defs>' +
          '<rect width="200" height="200" rx="22" ry="22" fill="url(#cbAdminMarkBg)" stroke="#1a2240" stroke-width="1"/>' +
          '<g transform="translate(100, 100)">' +
            '<rect x="-62" y="-62" width="124" height="124" rx="7" ry="7" transform="rotate(45)" fill="url(#cbAdminMarkFill)" stroke="#22e3ff" stroke-width="4"/>' +
            '<rect x="-46" y="-46" width="92" height="92" rx="4" ry="4" transform="rotate(45)" fill="none" stroke="#22e3ff" stroke-width="1" stroke-opacity="0.5"/>' +
            '<text x="0" y="14" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Inter, Roboto, sans-serif" font-weight="700" font-size="44" fill="#f8fbff" letter-spacing="0.04em">CB</text>' +
          '</g>' +
        '</svg>' +
        '<div class="admin-first-load-spinner" aria-hidden="true"></div>' +
        '<h2>Loading admin console</h2>' +
        '<p>Fetching the latest metrics from Supabase. This usually takes 1-2 seconds.</p>' +
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
    // A2: query is the free-text search (email/name/company). Same TTL
    // cache key as filter so flipping between segments + search hits the
    // cache when the params haven't changed.
    const query = typeof opts.query === "string" ? opts.query : adminUsersRemote.query;
    const sameParams = page === adminUsersRemote.page
      && perPage === adminUsersRemote.perPage
      && sort === adminUsersRemote.sort
      && filter === adminUsersRemote.filter
      && query === adminUsersRemote.query;
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
    adminUsersRemote.query = query;
    try {
      const auth = window.CBV2.auth;
      const client = auth && auth.getClient && auth.getClient();
      const body = { page: page, perPage: perPage, sort: sort, filter: filter, query: query };
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
  // Day 3.3: per-session admin CSRF nonce. Stored in sessionStorage so
  // it dies when the tab closes (limits replay window) and is NOT
  // automatically attached to cross-origin requests (a malicious page
  // can't add this custom header to its requests without our origin's
  // CORS allowing it — which it doesn't). Generated lazily on first
  // admin call, reused for the rest of the session.
  function getAdminCsrfNonce() {
    try {
      let nonce = sessionStorage.getItem("cb_admin_csrf_nonce");
      if (!nonce) {
        // 32 url-safe chars from crypto.randomUUID() (minus the dashes) +
        // a fresh randomUUID half to total ~50 chars. Well within the
        // server's 32..128 length window + matches /^[A-Za-z0-9\-_]+$/.
        const a = (crypto.randomUUID && crypto.randomUUID()) || "";
        const b = (crypto.randomUUID && crypto.randomUUID()) || "";
        nonce = (a + "_" + b).replace(/[^A-Za-z0-9\-_]/g, "").slice(0, 100);
        if (nonce.length < 32) {
          // Fallback for ancient browsers where crypto.randomUUID is missing.
          nonce = "fallback_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        }
        sessionStorage.setItem("cb_admin_csrf_nonce", nonce);
      }
      return nonce;
    } catch (_e) {
      // sessionStorage blocked (private mode) — generate one-shot.
      return "ephemeral_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    }
  }

  async function callAdminEndpoint(name, body) {
    if (!isBackendAdminRuntime()) {
      throw new Error("Sign in as an admin to call " + name + ".");
    }
    const auth = window.CBV2.auth;
    const client = auth && auth.getClient && auth.getClient();
    // Day 3.3: include the per-session CSRF nonce on every admin call.
    // The SDK accepts arbitrary headers via the second arg's `headers`
    // option. Read-only endpoints don't strictly need it but sending it
    // anyway keeps the client logic simple.
    const csrfHeaders = { "X-CB-Admin-Nonce": getAdminCsrfNonce() };
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const invoked = await client.functions.invoke(name, { body: body || {}, headers: csrfHeaders });
      if (invoked.error) throw new Error(await parseEdgeError(invoked.error));
      return invoked.data;
    }
    const token = auth && auth.getAccessToken ? await auth.getAccessToken() : "";
    const endpoint = window.CBV2.config.getFunctionsUrl() + "/" + name;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: Object.assign({
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: window.CBV2.config.getSupabaseAnon()
      }, csrfHeaders),
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

  // A3: Self-serve user adjustments. Wraps admin-user-adjust with the
  // mutation-state pattern used by promote + incident — sets a busy
  // flag while in flight, surfaces errors via toast + remote state,
  // and force-refreshes the user timeline on success so the drawer
  // shows the new counter / plan / note immediately.
  async function adjustUserAccount(opts) {
    opts = opts || {};
    const action = String(opts.action || "").trim();
    const targetUserId = String(opts.targetUserId || "").trim();
    const targetEmail = String(opts.targetEmail || "").trim();
    if (!action || !targetUserId) return;

    adminUserTimelineRemote.mutationAction = action;
    adminUserTimelineRemote.mutationBusy = true;
    adminUserTimelineRemote.mutationError = "";
    window.CBV2.renderCurrentRoute();
    try {
      const body = {
        targetUserId: targetUserId,
        targetEmail: targetEmail,
        action: action,
        payload: opts.payload || {}
      };
      const result = await callAdminEndpoint("admin-user-adjust", body);
      if (window.CBV2.toast) {
        let msg = "Adjustment applied.";
        if (action === "grant_quota") {
          msg = "Granted " + (opts.payload && opts.payload.amount) +
                " " + (opts.payload && opts.payload.quota) +
                " to " + (targetEmail || "user") + ".";
        } else if (action === "reset_quota") {
          msg = "All quota counters reset for " + (targetEmail || "user") + ".";
        } else if (action === "change_plan") {
          msg = "Plan set to " + ((opts.payload && opts.payload.planId) || "?") +
                " for " + (targetEmail || "user") + ".";
        } else if (action === "add_note") {
          msg = "Note saved for " + (targetEmail || "user") + ".";
        }
        window.CBV2.toast.success(msg);
      }
      // Re-fetch the timeline so admin_actions + usage_counters + subscription
      // reflect the change immediately in the open drawer.
      try {
        const auth = window.CBV2.auth;
        const client = auth && auth.getClient && auth.getClient();
        const lookupBody = { userId: targetUserId };
        let refreshed;
        if (client && client.functions && typeof client.functions.invoke === "function") {
          const invoked = await client.functions.invoke("admin-user-timeline", { body: lookupBody });
          if (!invoked.error) refreshed = invoked.data;
        }
        if (refreshed && refreshed.ok) {
          adminUserTimelineRemote.data = refreshed.timeline || refreshed;
          adminUserTimelineRemote.status = "ready";
          adminUserTimelineRemote.loadedAt = Date.now();
        }
      } catch (refreshErr) { /* non-blocking; drawer will show stale data until next open */ }
      return result;
    } catch (err) {
      const message = (err && err.message) || "Account adjustment failed.";
      adminUserTimelineRemote.mutationError = message;
      if (window.CBV2.toast) window.CBV2.toast.error(message);
      throw err;
    } finally {
      adminUserTimelineRemote.mutationBusy = false;
      adminUserTimelineRemote.mutationAction = "";
      window.CBV2.renderCurrentRoute();
    }
  }

  window.CBV2.adminUserAdjust = {
    apply: adjustUserAccount,
    state: function () { return Object.assign({}, adminUserTimelineRemote); }
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
    // Day 3.2 — kick the MFA snapshot if it hasn't loaded yet so the
    // loading placeholder resolves to either the challenge form, the
    // enroll nudge, or the actual admin console. Also bind the form
    // submit handler whenever the form is in the DOM (idempotent).
    const mfa = window.CBV2.adminMfa;
    if (mfa) {
      const snap = mfa.getSnapshot();
      if (!snap.loaded && !snap.loading) {
        mfa.refreshSnapshot().then(function () {
          // Re-render once the snapshot lands so the placeholder is
          // replaced by either the challenge form or the real admin UI.
          if (typeof window.CBV2.renderCurrentRoute === "function") {
            window.CBV2.renderCurrentRoute();
          }
        });
      }
      if (typeof mfa.bindChallengeForm === "function") {
        mfa.bindChallengeForm();
      }
    }

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

    // A5: generic refresh dispatcher — any [data-admin-refresh="<key>"]
    // button bound anywhere in the admin tree gets routed to the right
    // force-fetch. Used by the freshness chips on each panel head AND
    // by Retry buttons inside error banners. Single binding pass keeps
    // the per-section code free of repetitive refresh wiring.
    bindRefreshDispatcher();

    startStalenessTicker();
    // Phase 8: subscribe to Supabase Realtime postgres_changes for
    // admin_incidents + admin_audit_log so the admin sees updates
    // without manual refresh.
    if (window.CBV2.adminRealtime && typeof window.CBV2.adminRealtime.setup === "function") {
      window.CBV2.adminRealtime.setup();
    }
  };

  // A5: refresh dispatcher — maps fetcher keys to force-fetch calls.
  // New keys here as we add freshness badges to more panels.
  function bindRefreshDispatcher() {
    document.querySelectorAll("[data-admin-refresh]").forEach(function (btn) {
      // Skip if already bound (event listener idempotency). We tag the
      // node with a dataset flag rather than relying on listener
      // dedup (which can't be detected after the fact).
      if (btn.dataset.adminRefreshBound === "1") return;
      btn.dataset.adminRefreshBound = "1";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.getAttribute("data-admin-refresh") || "";
        runRefresh(key);
      });
    });
  }
  function runRefresh(key) {
    switch (key) {
      case "users":     return fetchAdminUsers({ force: true });
      case "audit":     return fetchAdminAudit({ force: true });
      case "operators": return fetchAdminOperators(true);
      case "tracked-companies": {
        // Phase 2.5: the tracked-companies section owns its own fetcher
        // because it has CRUD operations beyond a simple read.
        const tcSection = window.CBV2.adminSections && window.CBV2.adminSections["tracked-companies"];
        if (tcSection && typeof tcSection.refresh === "function") return tcSection.refresh();
        return null;
      }
      case "metrics":   return fetchAdminMetrics(true);
      case "timeline": {
        const id = adminUserTimelineRemote.activeUserId;
        const email = adminUserTimelineRemote.activeUserEmail;
        if (id) return fetchAdminUserTimeline(id, email);
        return null;
      }
      default:
        if (window.CBV2.toast) window.CBV2.toast.error("Unknown refresh key: " + key);
        return null;
    }
  }

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
    // A2: input id renamed from admin-users-filter → admin-users-query
    // because the new field hits the richer cross-user search (email +
    // name + company) on the backend's `query` param. The old filter
    // param still works server-side for any caller that needs it.
    const queryInput = document.getElementById("admin-users-query");
    const queryClearBtn = document.getElementById("admin-users-query-clear");

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
    if (queryInput) {
      // Debounce 350ms so each keystroke doesn't fire a request.
      queryInput.addEventListener("input", function () {
        if (userSupportFilterTimer != null) {
          clearTimeout(userSupportFilterTimer);
        }
        userSupportFilterTimer = setTimeout(function () {
          userSupportFilterTimer = null;
          const value = String(queryInput.value || "").trim();
          userSupportRestoreFocus = true;        // re-focus the input after the next render
          fetchAdminUsers({ query: value, page: 1, force: true });
        }, 350);
      });
      // If a filter-fetch just completed, re-focus the input + put the caret
      // at the end so the user can keep typing without re-clicking.
      if (userSupportRestoreFocus) {
        userSupportRestoreFocus = false;
        try {
          queryInput.focus();
          const len = queryInput.value.length;
          queryInput.setSelectionRange(len, len);
        } catch (e) { /* ignore */ }
      }
    }
    // A2: Clear button in the pager status line. Wipes the query state
    // and refetches the unfiltered first page.
    if (queryClearBtn) {
      queryClearBtn.addEventListener("click", function () {
        userSupportRestoreFocus = false;
        fetchAdminUsers({ query: "", page: 1, force: true });
      });
    }

    // A4: bulk-selection controls (per-row checkbox, select-all, clear,
    // and bulk-action buttons). All live in the same panel so we bind
    // them here rather than in a separate function — they share state.
    adminUsersRemote.selected = adminUsersRemote.selected || {};

    // Header "select all visible" — toggles every checkbox currently
    // rendered. Reading data-* off each row avoids needing to know
    // page contents server-side.
    const selectAll = document.getElementById("admin-users-select-all");
    if (selectAll) {
      // Set indeterminate via JS (HTML attribute doesn't honor it).
      if (selectAll.hasAttribute("data-indeterminate")) selectAll.indeterminate = true;
      selectAll.addEventListener("change", function () {
        const checks = document.querySelectorAll("[data-admin-user-select]");
        const turnOn = !!selectAll.checked;
        checks.forEach(function (cb) {
          const id = cb.getAttribute("data-admin-user-select") || "";
          if (!id) return;
          if (turnOn) {
            adminUsersRemote.selected[id] = {
              email: cb.getAttribute("data-admin-user-select-email") || "",
              fullName: cb.getAttribute("data-admin-user-select-name") || ""
            };
          } else {
            delete adminUsersRemote.selected[id];
          }
        });
        window.CBV2.renderCurrentRoute();
      });
    }

    // Per-row checkboxes. Click a row, it gets added/removed from
    // adminUsersRemote.selected. Re-render so the bulk toolbar count
    // and the row's `is-selected` style update.
    document.querySelectorAll("[data-admin-user-select]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        const id = cb.getAttribute("data-admin-user-select") || "";
        if (!id) return;
        if (cb.checked) {
          adminUsersRemote.selected[id] = {
            email: cb.getAttribute("data-admin-user-select-email") || "",
            fullName: cb.getAttribute("data-admin-user-select-name") || ""
          };
        } else {
          delete adminUsersRemote.selected[id];
        }
        window.CBV2.renderCurrentRoute();
      });
    });

    // "Clear selection" in the bulk toolbar.
    const bulkClear = document.querySelector("[data-admin-users-bulk-clear]");
    if (bulkClear) {
      bulkClear.addEventListener("click", function () {
        adminUsersRemote.selected = {};
        window.CBV2.renderCurrentRoute();
      });
    }

    // Bulk action buttons (Grant / Note / Email all).
    document.querySelectorAll("[data-admin-users-bulk]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const action = btn.getAttribute("data-admin-users-bulk") || "";
        if (!action) return;
        await runBulkUserAdjust(action);
      });
    });
  }

  // A4: bulk dispatcher. Reads the selection map, gathers one payload
  // (one quota+amount, one note, one email subject+body) that's applied
  // to every selected user. Iterates the per-user RPC sequentially so
  // we don't hammer the function with a 50-way parallel storm — keeps
  // the audit log readable and lets us surface progress incrementally.
  //
  // Cap: 50 users per run. If you need more, run in batches — this is
  // a foot-gun cap, not a real ceiling.
  const BULK_MAX = 50;
  async function runBulkUserAdjust(action) {
    const modal = window.CBV2 && window.CBV2.modal;
    const selectedMap = adminUsersRemote.selected || {};
    const ids = Object.keys(selectedMap);
    if (!ids.length) return;
    if (ids.length > BULK_MAX) {
      if (window.CBV2.toast) window.CBV2.toast.error("Bulk runs are capped at " + BULK_MAX + " users. Clear some selections and try again.");
      return;
    }

    // Build one shared payload via the same per-action modal flow as the
    // single-user dispatcher. We deliberately don't reuse runUserAdjust
    // here because that one prompts + confirms per user; bulk needs to
    // collect once and apply N times.
    let payload = null;
    let confirmLabel = "Apply to " + ids.length;
    let confirmTone = "default";

    if (action === "grant_quota") {
      const quotaOptions = ["ai_resumes", "ai_covers", "ai_mocks", "ai_research", "ai_question_banks"];
      const quotaPick = modal && modal.prompt
        ? await modal.prompt({
            title: "Bulk grant — choose quota",
            body: "Which quota counter should be decremented for all " + ids.length + " selected users?\n\n" +
                  quotaOptions.map(function (q, i) { return (i + 1) + ". " + q; }).join("\n"),
            defaultValue: "ai_resumes",
            validate: function (v) {
              const raw = String(v || "").trim().toLowerCase();
              if (!raw) return "Quota key required.";
              const n = Number(raw);
              if (Number.isFinite(n) && n >= 1 && n <= quotaOptions.length) return null;
              if (quotaOptions.indexOf(raw) === -1) return "Must be one of: " + quotaOptions.join(", ");
              return null;
            }
          })
        : (prompt("Quota:", "ai_resumes") || "");
      if (quotaPick == null || !String(quotaPick).trim()) return;
      let quota = String(quotaPick).trim().toLowerCase();
      const n = Number(quota);
      if (Number.isFinite(n) && n >= 1 && n <= quotaOptions.length) quota = quotaOptions[n - 1];

      const amountStr = modal && modal.prompt
        ? await modal.prompt({
            title: "Bulk grant — amount per user",
            body: "How many " + quota + " uses should we add back to EACH of the " + ids.length + " selected users? (1 - 1000)",
            defaultValue: "5",
            validate: function (v) {
              const num = Number(v);
              if (!Number.isFinite(num) || num < 1 || num > 1000) return "Enter a whole number between 1 and 1000.";
              return null;
            }
          })
        : (prompt("Amount (1-1000):", "5") || "");
      if (amountStr == null) return;
      const amount = Math.max(1, Math.min(1000, Math.floor(Number(amountStr) || 0)));
      payload = { quota: quota, amount: amount };
      confirmLabel = "Grant " + amount + " " + quota + " to " + ids.length;

    } else if (action === "add_note") {
      const note = modal && modal.prompt
        ? await modal.prompt({
            title: "Bulk add note",
            body: "Free-text note saved to the audit log for all " + ids.length + " selected users. (Max 2000 chars.)",
            placeholder: "e.g. \"Comped Pro for May launch — see slack #beta-comms\"",
            multiline: true,
            required: true,
            validate: function (v) {
              const raw = String(v || "").trim();
              if (!raw) return "Note cannot be empty.";
              if (raw.length > 2000) return "Note must be 2000 chars or fewer.";
              return null;
            }
          })
        : (prompt("Note:", "") || "");
      if (note == null || !String(note).trim()) return;
      payload = { note: String(note).trim().slice(0, 2000) };

    } else if (action === "send_email") {
      // Bulk email = one mailto: with all recipients in BCC. This gives
      // each user a personal-looking email (no other addresses visible)
      // while we record one audit row per user. Subject + body are the
      // same; for true mail-merge personalization, the operator should
      // use a real ESP.
      const emails = ids.map(function (id) { return (selectedMap[id] || {}).email || ""; }).filter(Boolean);
      if (!emails.length) {
        if (window.CBV2.toast) window.CBV2.toast.error("None of the selected users have an email on file.");
        return;
      }
      const subject = modal && modal.prompt
        ? await modal.prompt({
            title: "Bulk email — subject",
            body: "Same subject sent to all " + emails.length + " selected users (via BCC so each recipient only sees their own address). Max 200 chars.",
            defaultValue: "An update from CareerBoost",
            required: true,
            validate: function (v) {
              const raw = String(v || "").trim();
              if (!raw) return "Subject required.";
              if (raw.length > 200) return "Max 200 chars.";
              return null;
            }
          })
        : (prompt("Subject:", "An update from CareerBoost") || "");
      if (subject == null || !String(subject).trim()) return;

      const body = modal && modal.prompt
        ? await modal.prompt({
            title: "Bulk email — body",
            body: "Body for all " + emails.length + " recipients. Your mail client opens with the draft — review before sending. (Max 10000 chars.)",
            multiline: true,
            required: true,
            validate: function (v) {
              const raw = String(v || "").trim();
              if (!raw) return "Body cannot be empty.";
              if (raw.length > 10000) return "Max 10000 chars.";
              return null;
            }
          })
        : (prompt("Body:", "") || "");
      if (body == null || !String(body).trim()) return;

      const subj = String(subject).trim().slice(0, 200);
      const bod = String(body).trim().slice(0, 10000);
      payload = { subject: subj, bodyLength: bod.length };
      // Open a single mailto: with all addresses in BCC. The "to:"
      // field gets the operator's own address (filled in by their
      // mail client) so the user sees a 1:1 looking email.
      const mailto = "mailto:?bcc=" + encodeURIComponent(emails.join(","))
        + "&subject=" + encodeURIComponent(subj)
        + "&body=" + encodeURIComponent(bod);
      try { window.open(mailto, "_self"); } catch (_e) { /* popup blocked */ }
    } else {
      return;
    }

    // Day 3.5: dry-run preview. Show the operator the EXACT list of
    // recipients + the exact payload values BEFORE executing the bulk
    // loop. Catches "wrong selection" and "wrong payload" mistakes.
    // List is sorted alphabetically by email for stable reading; capped
    // at first 200 entries shown (rest is summarized) to keep modal
    // height manageable on a 50-row bulk.
    const previewLines = [];
    const sortedIds = ids.slice().sort(function (a, b) {
      const ea = String((selectedMap[a] && selectedMap[a].email) || "").toLowerCase();
      const eb = String((selectedMap[b] && selectedMap[b].email) || "").toLowerCase();
      return ea.localeCompare(eb);
    });
    const showLimit = 200;
    const shown = sortedIds.slice(0, showLimit);
    shown.forEach(function (id) {
      const m = selectedMap[id] || {};
      const email = m.email || "(no email)";
      const name = m.fullName || m.name || "";
      previewLines.push("  " + (name ? name + " <" + email + ">" : email));
    });
    const overflowCount = sortedIds.length - shown.length;

    // Format the payload as JSON for accuracy. Truncate any value past
    // 200 chars so a long email body doesn't blow up the modal.
    const payloadPreview = JSON.stringify(payload, function (_k, v) {
      if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
      return v;
    }, 2);

    const previewBody =
      "ACTION:   " + action + "\n" +
      "TARGETS:  " + ids.length + " user" + (ids.length === 1 ? "" : "s") + "\n" +
      "PAYLOAD:  " + payloadPreview + "\n\n" +
      "RECIPIENTS (alphabetical):\n" +
      previewLines.join("\n") +
      (overflowCount > 0 ? "\n  … and " + overflowCount + " more not shown" : "") +
      "\n\nEach action writes to admin_audit_log with your operator email. This CANNOT be undone.";

    const proceed = modal && modal.confirm
      ? await modal.confirm({
          title: "Confirm bulk action — review before executing",
          body: previewBody,
          confirmLabel: confirmLabel,
          tone: confirmTone
        })
      : confirm("Apply " + action + " to " + ids.length + " users?\n\nFirst recipient: " + (shown[0] ? (selectedMap[shown[0]] && selectedMap[shown[0]].email) : "?"));
    if (!proceed) return;

    // ----- Run sequentially with progress on adminUsersRemote.bulk ----
    adminUsersRemote.bulk = {
      busy: true, action: action, done: 0, total: ids.length, failed: 0, lastError: ""
    };
    window.CBV2.renderCurrentRoute();

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const meta = selectedMap[id] || {};
      try {
        await window.CBV2.adminUserAdjust.apply({
          action: action,
          targetUserId: id,
          targetEmail: meta.email || "",
          payload: payload
        });
      } catch (err) {
        adminUsersRemote.bulk.failed += 1;
        adminUsersRemote.bulk.lastError = (err && err.message) || "Unknown error";
      }
      adminUsersRemote.bulk.done += 1;
      // Live progress: re-render only every ~3rd step so we don't
      // thrash the DOM on a 50-row run. Always re-render at the end.
      if (i % 3 === 2 || i === ids.length - 1) {
        window.CBV2.renderCurrentRoute();
      }
    }

    const ok = ids.length - adminUsersRemote.bulk.failed;
    const fail = adminUsersRemote.bulk.failed;
    if (window.CBV2.toast) {
      if (fail === 0) window.CBV2.toast.success("Applied " + action + " to all " + ok + " selected users.");
      else if (ok === 0) window.CBV2.toast.error("Bulk " + action + " failed for all " + fail + " users. Last error: " + (adminUsersRemote.bulk.lastError || "?"));
      else window.CBV2.toast.warning("Applied " + action + " to " + ok + " users; " + fail + " failed. Last error: " + (adminUsersRemote.bulk.lastError || "?"));
    }

    // Clear selection on full success, keep selection on partial fail so
    // operator can retry just the failures (next iteration we'll mark
    // failed IDs explicitly; for now they keep the whole selection).
    if (fail === 0) adminUsersRemote.selected = {};
    adminUsersRemote.bulk = {
      busy: false, action: "", done: 0, total: 0, failed: 0, lastError: ""
    };
    window.CBV2.renderCurrentRoute();
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
    // A3: Manage account buttons inside the drawer. Each button carries
    // data-admin-user-adjust=<action> + data-admin-user-id + email; we
    // open the right modal per action, validate, then dispatch to the
    // shared adjustUserAccount() wrapper.
    document.querySelectorAll("[data-admin-user-adjust]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const action = btn.getAttribute("data-admin-user-adjust") || "";
        const targetUserId = btn.getAttribute("data-admin-user-id") || "";
        const targetEmail = btn.getAttribute("data-admin-user-email") || "";
        if (!action || !targetUserId) return;
        await runUserAdjust(action, targetUserId, targetEmail);
      });
    });
  }

  // A3: dispatcher — opens the right modal per action, builds the
  // payload, calls adjustUserAccount(). Kept outside bindUserTimelineControls
  // so it can be reused if we ever add bulk-adjust handlers.
  async function runUserAdjust(action, targetUserId, targetEmail) {
    const modal = window.CBV2 && window.CBV2.modal;
    const who = targetEmail || "this user";

    if (action === "grant_quota") {
      // Two-step prompt: pick the quota key, then enter the amount. We
      // could build a richer combined dialog later, but two prompts
      // keeps the UX consistent with the existing incident/snooze flow.
      const quotaOptions = ["ai_resumes", "ai_covers", "ai_mocks", "ai_research", "ai_question_banks"];
      const quotaList = quotaOptions.map(function (q, i) { return (i + 1) + ". " + q; }).join("\n");
      const quotaPick = modal && modal.prompt
        ? await modal.prompt({
            title: "Grant quota — choose quota",
            body: "Which quota counter should be DECREMENTED for " + who + "?\n\n" + quotaList +
                  "\n\nType the exact key (e.g. ai_resumes) or the number.",
            defaultValue: "ai_resumes",
            placeholder: "ai_resumes",
            validate: function (v) {
              const raw = String(v || "").trim().toLowerCase();
              if (!raw) return "Quota key is required.";
              const numeric = Number(raw);
              if (Number.isFinite(numeric) && numeric >= 1 && numeric <= quotaOptions.length) return null;
              if (quotaOptions.indexOf(raw) === -1) {
                return "Must be one of: " + quotaOptions.join(", ");
              }
              return null;
            }
          })
        : (prompt("Quota key (one of " + quotaOptions.join(", ") + "):", "ai_resumes") || "");
      if (quotaPick == null || !String(quotaPick).trim()) return;
      let quota = String(quotaPick).trim().toLowerCase();
      const numericPick = Number(quota);
      if (Number.isFinite(numericPick) && numericPick >= 1 && numericPick <= quotaOptions.length) {
        quota = quotaOptions[numericPick - 1];
      }

      const amountStr = modal && modal.prompt
        ? await modal.prompt({
            title: "Grant quota — amount",
            body: "How many " + quota + " uses should we add back to " + who + "? (1 - 1000)",
            defaultValue: "5",
            placeholder: "5",
            validate: function (v) {
              const n = Number(v);
              if (!Number.isFinite(n) || n < 1 || n > 1000) return "Enter a whole number between 1 and 1000.";
              return null;
            }
          })
        : (prompt("Amount (1-1000):", "5") || "");
      if (amountStr == null) return;
      const amount = Math.max(1, Math.min(1000, Math.floor(Number(amountStr) || 0)));

      const proceed = modal && modal.confirm
        ? await modal.confirm({
            title: "Confirm quota grant",
            body: "Add " + amount + " " + quota + " uses to " + who + "?\nThis decrements their usage counter and writes to the audit log.",
            confirmLabel: "Grant " + amount + " " + quota,
            tone: "default"
          })
        : confirm("Grant " + amount + " " + quota + " to " + who + "?");
      if (!proceed) return;

      await window.CBV2.adminUserAdjust.apply({
        action: "grant_quota",
        targetUserId: targetUserId,
        targetEmail: targetEmail,
        payload: { quota: quota, amount: amount }
      }).catch(function () { /* error already toasted */ });
      return;
    }

    if (action === "reset_quota") {
      const proceed = modal && modal.confirm
        ? await modal.confirm({
            title: "Reset all quota counters",
            body: "Zero out every AI quota counter for " + who + "?\n\nThis affects: ai_resumes, ai_covers, ai_mocks, ai_research, ai_question_banks. Useful for support escalations where a user reports their quota is exhausted unexpectedly.",
            confirmLabel: "Reset all counters",
            tone: "danger"
          })
        : confirm("Reset all 5 quota counters for " + who + "?");
      if (!proceed) return;
      await window.CBV2.adminUserAdjust.apply({
        action: "reset_quota",
        targetUserId: targetUserId,
        targetEmail: targetEmail,
        payload: {}
      }).catch(function () { /* error already toasted */ });
      return;
    }

    if (action === "change_plan") {
      const planOptions = ["free", "plus", "pro", "career"];
      const planList = planOptions.map(function (p, i) { return (i + 1) + ". " + p; }).join("\n");
      const planPick = modal && modal.prompt
        ? await modal.prompt({
            title: "Change plan",
            body: "Set the subscription plan for " + who + ".\n\n" + planList +
                  "\n\nType the plan id (e.g. pro) or the number. Only use this for support escalations — it bypasses Stripe billing.",
            defaultValue: "plus",
            placeholder: "plus",
            validate: function (v) {
              const raw = String(v || "").trim().toLowerCase();
              if (!raw) return "Plan id is required.";
              const n = Number(raw);
              if (Number.isFinite(n) && n >= 1 && n <= planOptions.length) return null;
              if (planOptions.indexOf(raw) === -1) {
                return "Must be one of: " + planOptions.join(", ");
              }
              return null;
            }
          })
        : (prompt("Plan id (" + planOptions.join("|") + "):", "plus") || "");
      if (planPick == null || !String(planPick).trim()) return;
      let planId = String(planPick).trim().toLowerCase();
      const numericPlan = Number(planId);
      if (Number.isFinite(numericPlan) && numericPlan >= 1 && numericPlan <= planOptions.length) {
        planId = planOptions[numericPlan - 1];
      }

      const proceed = modal && modal.confirm
        ? await modal.confirm({
            title: "Confirm plan change",
            body: "Set " + who + "'s plan to '" + planId + "'?\n\nThis bypasses Stripe — only use for support escalations or comp plans. Logged to audit trail.",
            confirmLabel: "Change to " + planId,
            tone: "danger"
          })
        : confirm("Change plan to " + planId + "?");
      if (!proceed) return;
      await window.CBV2.adminUserAdjust.apply({
        action: "change_plan",
        targetUserId: targetUserId,
        targetEmail: targetEmail,
        payload: { planId: planId }
      }).catch(function () { /* error already toasted */ });
      return;
    }

    if (action === "add_note") {
      const note = modal && modal.prompt
        ? await modal.prompt({
            title: "Add admin note",
            body: "Free-text note about " + who + ". Saved to the audit log for the next operator who opens this drawer. (Max 2000 chars.)",
            placeholder: "e.g. \"Promised 3 extra cover letters after Stripe declined refund — see ticket #482.\"",
            multiline: true,
            required: true,
            validate: function (v) {
              const raw = String(v || "").trim();
              if (!raw) return "Note cannot be empty.";
              if (raw.length > 2000) return "Note must be 2000 chars or fewer.";
              return null;
            }
          })
        : (prompt("Admin note (max 2000 chars):", "") || "");
      if (note == null || !String(note).trim()) return;
      await window.CBV2.adminUserAdjust.apply({
        action: "add_note",
        targetUserId: targetUserId,
        targetEmail: targetEmail,
        payload: { note: String(note).trim().slice(0, 2000) }
      }).catch(function () { /* error already toasted */ });
      return;
    }

    if (action === "send_email") {
      // A4: compose modal → mailto: link → audit row.
      // Two prompts (subject, then body) keeps it simple; consider a
      // single richer dialog later. The mailto: is opened via window.open
      // because <a href="mailto:..."> in a freshly-rendered string can be
      // flaky across browsers' popup blockers.
      if (!targetEmail) {
        if (window.CBV2.toast) window.CBV2.toast.error("Cannot email — user has no email on file.");
        return;
      }
      const subject = modal && modal.prompt
        ? await modal.prompt({
            title: "Email " + who + " — subject",
            body: "Subject line for the email. The body comes next. (Max 200 chars.)",
            defaultValue: "Quick note from CareerBoost support",
            placeholder: "Quick note from CareerBoost support",
            required: true,
            validate: function (v) {
              const raw = String(v || "").trim();
              if (!raw) return "Subject cannot be empty.";
              if (raw.length > 200) return "Subject must be 200 chars or fewer.";
              return null;
            }
          })
        : (prompt("Subject:", "Quick note from CareerBoost support") || "");
      if (subject == null || !String(subject).trim()) return;

      const body = modal && modal.prompt
        ? await modal.prompt({
            title: "Email " + who + " — body",
            body: "Body of the email. Your mail client will open with this draft — you can edit and send from there. Uses your operator address as the sender. (Max 10000 chars.)",
            placeholder: "Hi there,\n\nThanks for reaching out…",
            multiline: true,
            required: true,
            validate: function (v) {
              const raw = String(v || "").trim();
              if (!raw) return "Body cannot be empty.";
              if (raw.length > 10000) return "Body must be 10000 chars or fewer.";
              return null;
            }
          })
        : (prompt("Body:", "") || "");
      if (body == null || !String(body).trim()) return;

      // Open mailto: first — if the operator changes their mind they
      // can close the draft. We log to audit AFTER they confirm in
      // the modal so we don't have a phantom "I sent this" row from
      // a draft that was actually discarded.
      const subj = String(subject).trim().slice(0, 200);
      const bod = String(body).trim().slice(0, 10000);
      const mailto = "mailto:" + encodeURIComponent(targetEmail) +
        "?subject=" + encodeURIComponent(subj) +
        "&body=" + encodeURIComponent(bod);
      try { window.open(mailto, "_self"); } catch (_e) { /* popup blocked */ }

      await window.CBV2.adminUserAdjust.apply({
        action: "send_email",
        targetUserId: targetUserId,
        targetEmail: targetEmail,
        payload: { subject: subj, bodyLength: bod.length }
      }).catch(function () { /* error already toasted */ });
      return;
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
