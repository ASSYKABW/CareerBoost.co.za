/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadScript(ctx, relPath) {
  const abs = path.resolve(__dirname, "..", relPath);
  const src = fs.readFileSync(abs, "utf8");
  vm.runInContext(src, ctx, { filename: relPath });
}

function sanitizeText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeStore() {
  return {
    getApplications: function () {
      return [
        { id: "app1", company: "Acme", role: "Engineer", stage: "saved", appliedAt: "2026-05-01" },
        { id: "app2", company: "Beta", role: "Analyst", stage: "interview", appliedAt: "2026-05-04" }
      ];
    },
    getSavedJobs: function () { return [{ id: "job1" }]; },
    getEvents: function () { return []; },
    getJobSearchState: function () {
      return {
        analytics: { runs: [{ query: "engineer", total: 12, at: "2026-05-08T10:00:00.000Z" }] },
        lastResultSet: { sources: { adzuna: 12 } }
      };
    }
  };
}

function makeContext() {
  const window = {
    CB_CONFIG: { forceLocal: true },
    CBV2: {
      routes: {},
      afterRender: {},
      sanitizeText: sanitizeText,
      store: makeStore(),
      getRouteParams: function () { return {}; },
      config: {
        isBackendEnabled: function () { return false; }
      }
    },
    CBAI: { telemetry: { getSummary: function () { return { totalEvents: 4, success: 3, failed: 1, avgLatencyMs: 1200 }; } } }
  };
  return vm.createContext({
    window: window,
    console: console,
    Date: Date,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    Blob: function () {}
  });
}

function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/app/config.js");
  ctx.window.CB_CONFIG.forceLocal = true;
  // Phase D: helpers + section files load first, then the route dispatcher.
  // Phase E1: command-center is loaded too (new admin home).
  loadScript(ctx, "src/js/modules/admin/admin-helpers.js");
  [
    "command-center", "growth", "overview", "usage-engagement", "funnel",
    "users", "user-support", "job-feed", "ai-cost", "extension", "sync",
    "risk-center", "reports", "logs", "settings"
  ].forEach(function (name) {
    loadScript(ctx, "src/js/modules/admin/sections/" + name + ".js");
  });
  loadScript(ctx, "src/js/modules/admin/admin.route.js");
  assert.strictEqual(typeof ctx.window.CBV2.routes.admin, "function", "admin route should register");
  assert.strictEqual(ctx.window.CBV2.adminAccess.canAccess(), true, "local preview should be allowed");
  const html = ctx.window.CBV2.routes.admin();
  assert.ok(/CareerBoost Admin/.test(html), "admin shell should render brand");
  assert.ok(/cb-logo--admin/.test(html), "admin shell should use the CareerBoost logo lockup");
  assert.ok(!/admin-brand-mark/.test(html), "admin shell should not render the temporary CB tile");
  assert.ok(/Usage &amp; operations command center/.test(html), "admin shell should render overview header");
  // Phase E1: home is now the Command Center. North Star + AARRR + priorities
  // render even with no remote snapshot, so the shell shows the new copy.
  assert.ok(/Active placements/.test(html) || /Total pipeline records/.test(html), "admin shell should render command center or overview metrics");

  ctx.window.CB_CONFIG.forceLocal = false;
  ctx.window.CBV2.config.isBackendEnabled = function () { return true; };
  ctx.window.CBV2.auth = {
    isAuthenticated: function () { return true; },
    getUser: function () { return { email: "candidate@example.com", app_metadata: {}, user_metadata: {} }; }
  };
  ctx.window.CBV2.profile = { get: function () { return { preferences: {} }; } };
  assert.strictEqual(ctx.window.CBV2.adminAccess.canAccess(), false, "candidate users should not open admin");
  assert.ok(/Admin access is locked/.test(ctx.window.CBV2.routes.admin()), "non-admin users should see the access guard");

  ctx.window.CBV2.auth.getUser = function () {
    return { email: "candidate@example.com", app_metadata: {}, user_metadata: { roles: ["admin"] } };
  };
  assert.strictEqual(ctx.window.CBV2.adminAccess.canAccess(), false, "user metadata should not grant admin access");

  ctx.window.CBV2.auth.getUser = function () {
    return { email: "operator@example.com", app_metadata: { roles: ["admin"] }, user_metadata: {} };
  };
  assert.strictEqual(ctx.window.CBV2.adminAccess.canAccess(), true, "admin role should open admin");

  ctx.window.CBV2.adminMetrics.applyRemoteSnapshot({
    ok: true,
    generatedAt: "2026-05-10T10:00:00.000Z",
    totals: {
      users: 2,
      profiles: 2,
      applications: 5,
      savedJobs: 9,
      savedSearches: 1,
      events: 3,
      upcomingEvents: 1,
      resumes: 1,
      aiCostUsd: 0.42,
      usageEvents: 44,
      usageSessions: 7
    },
    users: {
      total: 2,
      activeLast7: 1,
      activeLast30: 2,
      newLast30: 2,
      admins: 1,
      latest: [{
        email: "operator@example.com",
        roles: ["admin"],
        createdAt: "2026-05-01T10:00:00.000Z",
        lastSignInAt: "2026-05-10T09:00:00.000Z",
        pipelineCount: 3,
        savedJobCount: 4,
        aiRequests: 8,
        lastActivityAt: "2026-05-10T09:15:00.000Z"
      }]
    },
    support: {
      summary: { monitoredAccounts: 2, averageHealth: 72, atRisk: 1, healthy: 1 },
      queues: { atRisk: 1, resumeNeeded: 1, jobCaptureNeeded: 0, savedOnly: 1, inactive: 0, aiIssue: 1 },
      accounts: [{
        email: "candidate@example.com",
        plan: "free",
        health: 48,
        stage: "resume-needed",
        blockers: ["Resume not ready", "Saved roles not moved forward"],
        recommendedAction: "Help user resolve: Resume not ready.",
        inactiveDays: 2,
        lastActivityAt: "2026-05-10T08:00:00.000Z"
      }],
      playbooks: [{ id: "resume-needed", title: "Resume readiness follow-up", action: "Guide the user to Resume Lab." }],
      privacy: "Support health excludes resume, cover-letter, and interview document body text."
    },
    product: {
      activation: {
        score: 50,
        signedUp: 2,
        completedProfileUsers: 2,
        onboarded: 2,
        onboardingRate: 100,
        resumeReadyUsers: 1,
        resumeReadyRate: 50,
        firstJobUsers: 2,
        firstJobRate: 100,
        tailoredAssetUsers: 1,
        tailoredAssetRate: 50,
        appliedUsers: 1,
        appliedUserRate: 50,
        activatedUsers: 1,
        activatedRate: 50,
        largestDropOff: { label: "Resume ready", users: 1, conversion: 50, stepConversion: 50, dropOff: 1, dropOffRate: 50, action: "Push users toward Resume Lab." },
        funnel: [
          { id: "signed-up", label: "Signed up", users: 2, conversion: 100, stepConversion: 100, dropOff: 0, dropOffRate: 0 },
          { id: "completed-profile", label: "Completed profile", users: 2, conversion: 100, stepConversion: 100, dropOff: 0, dropOffRate: 0 },
          { id: "resume-ready", label: "Resume ready", users: 1, conversion: 50, stepConversion: 50, dropOff: 1, dropOffRate: 50, action: "Push users toward Resume Lab." },
          { id: "first-job-saved", label: "First job saved", users: 1, conversion: 50, stepConversion: 100, dropOff: 0, dropOffRate: 0 },
          { id: "first-tailored-asset", label: "First tailored asset", users: 1, conversion: 50, stepConversion: 100, dropOff: 0, dropOffRate: 0 },
          { id: "job-moved-forward", label: "Job moved forward", users: 1, conversion: 50, stepConversion: 100, dropOff: 0, dropOffRate: 0 }
        ],
        bottlenecks: [{ label: "Resume ready drop-off", value: 50, dropOff: 1, dropOffRate: 50, action: "Push users toward Resume Lab before applying." }]
      },
      modules: [
        { id: "job-search", label: "Job Search", users: 2, records: 10, adoption: 100, status: "source quality matters most" },
        { id: "resume", label: "Resume Lab", users: 1, records: 1, adoption: 50, status: "application readiness" }
      ],
      moduleEngagement: [
        { id: "job-search", label: "Job Search", activeUsers: 2, recordUsers: 2, records: 10, adoption: 100, sessions: 5, sessionShare: 71, views: 9, events: 16, avgEventsPerSession: 3.2, status: "healthy" },
        { id: "pipeline", label: "Pipeline", activeUsers: 1, recordUsers: 1, records: 5, adoption: 50, sessions: 3, sessionShare: 43, views: 5, events: 8, avgEventsPerSession: 2.7, status: "healthy" },
        { id: "interview", label: "Interview Prep", activeUsers: 0, recordUsers: 0, records: 0, adoption: 0, sessions: 0, sessionShare: 0, views: 0, events: 0, avgEventsPerSession: 0, status: "needs attention" }
      ],
      plans: [{ label: "free", count: 2 }],
      insights: [{ severity: "info", title: "Users are saving jobs before resumes are ready", body: "First job capture is ahead of resume readiness.", section: "usage" }]
    },
    retention: {
      activeToday: 1,
      activeLast7: 1,
      activeLast30: 2,
      stickiness: 50,
      avgPipelinePerActiveUser: 5,
      avgAiCallsPerActiveUser: 12,
      usageEvents: 44,
      usageSessions: 7,
      activeSessions: 7,
      avgSessionSeconds: 612,
      avgSessionMinutes: 10.2,
      avgRoutesPerSession: 4.4,
      avgEventsPerSession: 12.7,
      avgSessionDepth: 4.4,
      sessionsByDevice: [{ label: "desktop", count: 5 }, { label: "mobile", count: 2 }],
      sessionsByBrowser: [{ label: "Chrome", count: 6 }, { label: "Edge", count: 1 }],
      sessionsByPreviewMode: [{ label: "signed_in", count: 6 }, { label: "local_preview", count: 1 }],
      topRoutes: [{ label: "job-search", count: 9 }, { label: "resume", count: 6 }],
      topModules: [{ label: "job-search", count: 11 }, { label: "pipeline", count: 7 }],
      cohorts: [{ week: "05-04", signups: 2, active: 1, sessions: 3, jobSaves: 4, aiCalls: 6, avgSessionMinutes: 10.2, returnRate: 50 }],
      cohortSummary: {
        windowWeeks: 8,
        returnWeeks: 4,
        trackedSessions: 16,
        avgWeek1Retention: 50,
        avgWeek2Retention: 25,
        avgWeek3Retention: 25,
        habitSignal: "developing",
        note: "Signup cohorts are based on Supabase Auth created_at and returns are based on tracked usage sessions."
      },
      cohortRetention: [{
        week: "04-27",
        users: 2,
        weeks: [
          { week: "W0", weekOffset: 0, activeUsers: 2, sessions: 5, rate: 100, complete: true, partial: false, pending: false },
          { week: "W1", weekOffset: 1, activeUsers: 1, sessions: 3, rate: 50, complete: true, partial: false, pending: false },
          { week: "W2", weekOffset: 2, activeUsers: 1, sessions: 2, rate: 50, complete: false, partial: true, pending: false },
          { week: "W3", weekOffset: 3, activeUsers: 0, sessions: 0, rate: null, complete: false, partial: false, pending: true }
        ],
        week0Retention: 100,
        week1Retention: 50,
        week2Retention: 50,
        week3Retention: null
      }]
    },
    funnel: {
      stages: { saved: 2, applied: 2, interview: 1, offer: 0, rejected: 0, withdrawn: 0 },
      savedToAppliedRate: 60,
      interviewRate: 20,
      offerRate: 0,
      recentApplications: [{ company: "Acme", role: "Engineer", stage: "saved", sourceHost: "adzuna.co.za", updatedAt: "2026-05-10T08:00:00.000Z" }],
      staleSaved: [{ company: "OldCo", role: "Analyst", ageDays: 18, updatedAt: "2026-04-20T08:00:00.000Z" }]
    },
    ai: {
      requests: 12,
      success: 11,
      failed: 1,
      avgLatencyMs: 900,
      costUsd: 0.42,
      bySkill: [{ label: "resume-tailor", count: 6, failed: 0, costUsd: 0.2 }, { label: "job-import", count: 3, failed: 0, costUsd: 0 }],
      byProvider: [{ label: "openai", count: 12, failed: 1, failureRate: 8, avgLatencyMs: 900, costUsd: 0.42, status: "watch" }],
      budget: { monthlyRunRateUsd: 0.42, costPerRequestUsd: 0.035, status: "normal" },
      recentFailures: [{ skill: "cover-letter", provider: "openai", model: "gpt-x", error: "Rate limit", at: "2026-05-10T07:00:00.000Z" }]
    },
    jobFeed: {
      savedJobs: 9,
      latestSavedAt: "2026-05-09T10:00:00.000Z",
      sources: [{ label: "Adzuna", count: 7, host: "adzuna.co.za", issueCount: 0, status: "healthy" }, { label: "LinkedIn", count: 2, host: "linkedin.com", issueCount: 1, status: "review" }],
      sourceIssues: [{ title: "Engineer", company: "Acme", source: "LinkedIn", host: "indeed.com", savedAt: "2026-05-09T10:00:00.000Z" }],
      quality: { issueRate: 11, healthySources: 1, staleSources: 0, reviewSources: 1 }
    },
    activity: [{ type: "pipeline", title: "Pipeline updated", body: "Acme - Engineer", at: "2026-05-10T09:30:00.000Z" }],
    alerts: [{ severity: "critical", title: "Source truth needs review", body: "1 saved job record has a provider label mismatch.", action: "Review provider normalization.", section: "job-feed" }],
    operations: { sourceIssueCount: 1, staleSaved: 1, latestSavedAgeDays: 1, aiFailureRate: 8, staleDataSignals: 1 },
    diagnostics: {
      warnings: [],
      dataFreshness: {
        generatedAt: "2026-05-10T10:00:00.000Z",
        latestUsageEventAt: "2026-05-10T09:45:00.000Z",
        latestUsageSessionAt: "2026-05-10T09:50:00.000Z",
        staleSignals: [{ area: "profiles", status: "stale", latestAt: "2026-04-01T10:00:00.000Z", ageDays: 39, action: "Prompt users to refresh profile goals." }]
      },
      privacyControls: {
        exportScope: "Aggregated operational metrics only",
        excludedContent: ["resume bodies", "cover-letter text", "job descriptions", "raw documents", "API keys", "auth tokens"],
        metadataMaxBytes: 4096
      },
      exportManifest: [{ key: "overview", filename: "careerboost-admin-overview.csv", format: "csv", rows: 2, privacy: "operational metadata only" }]
    },
    reports: {
      healthScore: 78,
      executiveSummary: [
        { label: "System health", value: "78%", detail: "1 operator signal in this snapshot." },
        { label: "Users", value: 2, detail: "1 active this week." }
      ],
      actionQueue: [
        { priority: "critical", ownerArea: "job-feed", title: "Source truth needs review", action: "Review provider normalization." }
      ],
      audit: {
        generatedAt: "2026-05-10T10:00:00.000Z",
        generatedBy: "operator@example.com",
        dataWindow: "last_30_days",
        accessModel: "Supabase app_metadata roles with service-role reads after verification",
        backendWarnings: 0,
        sampledRecords: { users: 2, applications: 1, savedJobs: 9, aiUsage: 12, sourceIssues: 1 },
        privacy: "Exports contain operational metadata."
      },
      governance: {
        destructiveActionsDisabled: true,
        exportScope: "Aggregated operational metrics",
        secretModel: "Backend environment secrets",
        privacyPolicy: "Admin reports use counts, timestamps, source labels, and workflow state only.",
        recommendedNextReviewAt: "2026-05-17T10:00:00.000Z"
      },
      dataFreshness: {
        generatedAt: "2026-05-10T10:00:00.000Z",
        latestUsageEventAt: "2026-05-10T09:45:00.000Z",
        latestUsageSessionAt: "2026-05-10T09:50:00.000Z",
        staleSignals: [{ area: "profiles", status: "stale", latestAt: "2026-04-01T10:00:00.000Z", ageDays: 39, action: "Prompt users to refresh profile goals." }]
      },
      privacyControls: {
        exportScope: "Aggregated operational metrics only",
        excludedContent: ["resume bodies", "cover-letter text", "job descriptions", "raw documents", "API keys", "auth tokens"],
        metadataMaxBytes: 4096
      },
      exportManifest: [
        { key: "overview", filename: "careerboost-admin-overview.csv", format: "csv", rows: 2, privacy: "operational metadata only" },
        { key: "dataFreshness", filename: "careerboost-admin-dataFreshness.csv", format: "csv", rows: 1, privacy: "operational metadata only" }
      ],
      csv: {
        overview: [{ label: "System health", value: "78%", detail: "1 operator signal in this snapshot." }],
        risks: [{ severity: "critical", title: "Source truth needs review", section: "job-feed", action: "Review provider normalization." }],
        modules: [{ id: "job-search", label: "Job Search", users: 2, records: 10, adoption: 100 }],
        cohortRetention: [{ cohort: "04-27", signups: 2, week0: 100, week1: 50, week2: 50, week3: null }],
        sources: [{ label: "LinkedIn", count: 2, host: "linkedin.com", issueCount: 1 }],
        providers: [{ label: "openai", count: 12, failed: 1, failureRate: 8 }],
        dataFreshness: [{ area: "profiles", status: "stale", latestAt: "2026-04-01T10:00:00.000Z", ageDays: 39, action: "Prompt users to refresh profile goals." }],
        incidents: [{ id: "ops-1", severity: "critical", title: "Source truth needs review", affectedArea: "job-feed", status: "open", runbookId: "source-truth" }],
        serviceLevels: [{ id: "source-truth", label: "Source truth", current: "11% mismatch", status: "incident", section: "job-feed" }],
        accountHealth: [{ email: "candidate@example.com", health: 48, stage: "resume-needed", blockers: "Resume not ready" }],
        actionQueue: [{ priority: "critical", ownerArea: "job-feed", title: "Source truth needs review", action: "Review provider normalization." }]
      }
    },
    controlCenter: {
      incidents: [{ id: "ops-1", severity: "critical", title: "Source truth needs review", affectedArea: "job-feed", status: "open", runbookId: "source-truth" }],
      serviceLevels: [
        { id: "source-truth", label: "Source truth", target: "<= 5% source/host mismatch", current: "11% mismatch", status: "incident", section: "job-feed" },
        { id: "ai-reliability", label: "AI reliability", target: "<= 10% failure rate", current: "8% failure", status: "healthy", section: "ai-cost" }
      ],
      runbooks: [{
        id: "source-truth",
        title: "Fix source truth mismatch",
        ownerArea: "job-feed",
        steps: ["Open Job feed health.", "Update provider normalization."]
      }],
      releaseReadiness: {
        score: 83,
        status: "watch",
        checks: [
          { label: "Admin access is protected", pass: true, detail: "Supabase app_metadata roles." },
          { label: "Job source truth is within tolerance", pass: false, detail: "11% provider mismatch rate." }
        ]
      },
      escalation: {
        policy: "Review critical incidents before release.",
        cadence: "Daily while incidents are open."
      }
    }
  });
  // Phase E1: simulate the new backend fields landing in the snapshot so
  // the Command Center renders fully. The applyRemoteSnapshot above
  // doesn't include E1 blocks, so we patch them on the cached payload.
  (function () {
    const remote = ctx.window.CBV2.adminMetrics.state();
    const enriched = Object.assign({}, remote.data, {
      northStar: {
        label: "Active placements",
        sublabel: "Candidates with interview or offer in last 30 days",
        value: 3,
        prior: 1,
        delta: 2,
        deltaPct: 200,
        direction: "up",
        target: 5,
        progress: 60,
        progressTone: "blue",
        healthSignal: "tracking",
        note: "Self-reported milestones."
      },
      aarrr: [
        { stage: "acquisition", label: "Acquisition", icon: "fa-bullhorn", value: 4, delta: 2, deltaPct: 100, sub: "2 prior 30d", status: "good", why: "Up MoM.", action: "Keep mix.", section: "growth" },
        { stage: "activation",  label: "Activation",  icon: "fa-bolt",     value: 50, unit: "%", sub: "1 of 2 users",   status: "watch", why: "Below floor.", action: "Fix step.", section: "growth" },
        { stage: "retention",   label: "Retention",   icon: "fa-arrows-rotate", value: 50, unit: "%", sub: "2 MAU", status: "good", why: "Habit forming.", action: "Protect feature.", section: "users" },
        { stage: "revenue",     label: "Revenue",     icon: "fa-coins",    value: 0, preFormatted: "Pre-revenue", sub: "AI cost $0.21 / MAU", status: "good", why: "Healthy unit econ.", action: "Launch Pro tier.", section: "ai-cost" },
        { stage: "referral",    label: "Referral",    icon: "fa-share-nodes", value: 1, sub: "advocates", status: "watch", why: "Some advocates.", action: "Ship referral loop.", section: "users" }
      ],
      priorities: [
        { id: "north-star-gap", title: "2 placements short of target", why: "Below 5 floor.", rootCause: "Conversion below floor.", action: "Open Product Intelligence.", impact: 10, urgency: 8, section: "growth", actionType: "navigate", icon: "fa-bullseye" }
      ],
      weeklyChanges: [
        { metric: "Signups", icon: "fa-user-plus", now: 3, prior: 1, diff: 2, pct: 200, direction: "up", goodDirection: "up" }
      ],
      outcomes: {
        placements30d: 3, placementsPrior30d: 1, placementDelta: 2, placementDeltaPct: 200,
        interviews30d: 2, offers30d: 1, distinctPlacedUsers30d: 2, attributedShare: 67,
        byChannel: [{ channel: "linkedin", interviews_30d: 1, offers_30d: 1, placements_30d: 2, distinct_users_30d: 2 }],
        target: 5, progressPct: 60, sourceNote: "From self-reported milestones"
      }
    });
    ctx.window.CBV2.adminMetrics.applyRemoteSnapshot(enriched);
  })();

  const cloudHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Admin backend connected/.test(cloudHtml), "remote admin metrics should show cloud status");
  // Phase E1: home is Command Center now.
  assert.ok(/North star/.test(cloudHtml), "command center should render the North Star kicker");
  assert.ok(/Active placements/.test(cloudHtml), "command center should render the North Star metric");
  assert.ok(/Acquisition/.test(cloudHtml) && /Activation/.test(cloudHtml) && /Retention/.test(cloudHtml) && /Revenue/.test(cloudHtml) && /Referral/.test(cloudHtml), "command center should render all five AARRR stages");
  assert.ok(/Today's priorities/.test(cloudHtml), "command center should render the priorities panel");
  assert.ok(/Take action/.test(cloudHtml), "priorities should expose a take-action CTA");
  assert.ok(/What moved this week/.test(cloudHtml), "command center should render weekly changes");
  assert.ok(/Which channels lead to interviews/.test(cloudHtml), "command center should render outcome attribution");

  // Test the old overview alias redirect: section=overview should serve
  // the Command Center, not the legacy overview renderer.
  ctx.window.CBV2.getRouteParams = function () { return { section: "overview" }; };
  const aliasHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Active placements/.test(aliasHtml), "section=overview alias should redirect to Command Center");

  // Reset to default route for subsequent assertions.
  ctx.window.CBV2.getRouteParams = function () { return {}; };

  ctx.window.CBV2.getRouteParams = function () { return { section: "usage" }; };
  const usageHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Decision-ready engagement dashboard/.test(usageHtml), "usage section should render the decision-ready command board");
  assert.ok(/Usage KPI strip/.test(usageHtml), "usage section should render the KPI strip");
  assert.ok(/Activation funnel/.test(usageHtml), "usage section should render activation intelligence");
  assert.ok(/Signed up to job moved forward/.test(usageHtml), "usage section should render strict activation path");
  assert.ok(/First tailored asset/.test(usageHtml), "usage section should render tailored asset activation step");
  assert.ok(/Job moved forward/.test(usageHtml), "usage section should render job moved forward activation step");
  assert.ok(/Daily active users/.test(usageHtml), "usage section should render DAU");
  assert.ok(/Avg session length/.test(usageHtml), "usage section should render average session length");
  assert.ok(/Depth per session/.test(usageHtml), "usage section should render route depth");
  assert.ok(/Tracked events/.test(usageHtml), "usage section should render usage event telemetry");
  assert.ok(/Top drop-offs/.test(usageHtml), "usage section should render top drop-offs");
  assert.ok(/Product recommendations/.test(usageHtml), "usage section should render product recommendations");
  assert.ok(/Session quality/.test(usageHtml), "usage section should render session quality");
  assert.ok(/Device mix/.test(usageHtml), "usage section should render device and browser mix");
  assert.ok(/Route\/module views/.test(usageHtml), "usage section should render route and module views");
  assert.ok(/Module engagement/.test(usageHtml), "usage section should render module engagement");
  assert.ok(/Active users/.test(usageHtml), "usage section should show active users per module");
  assert.ok(/Interview Prep/.test(usageHtml), "usage section should show tracked product modules");
  assert.ok(/Retention cohorts/.test(usageHtml), "usage section should render true retention cohorts");
  assert.ok(/Do new users come back/.test(usageHtml), "usage section should explain cohort retention");
  assert.ok(/Avg week 1/.test(usageHtml), "usage section should summarize week 1 retention");
  assert.ok(/Weekly cohorts/.test(usageHtml), "usage section should render cohort activity");

  // Phase E2: Growth board. Patch growth block onto the cached snapshot
  // so we can render the full board with real-shaped data.
  (function () {
    const remote = ctx.window.CBV2.adminMetrics.state();
    const enriched = Object.assign({}, remote.data, {
      growth: {
        summary: {
          totalSignups: 8, totalSignups30d: 5, totalActivated: 4, totalPlaced: 2,
          overallActivation: 50, overallPlacement: 25, attributionCoverage: 75
        },
        funnel: [
          { id: "signups", label: "Signups", count: 8, share: 100 },
          { id: "activated", label: "Activated", count: 4, share: 50 },
          { id: "placed", label: "Placed", count: 2, share: 25 }
        ],
        channels: [
          { channel: "linkedin", medium: "social", signups: 4, signups_30d: 3, activated: 3, placed: 2, quality_score: 50 },
          { channel: "google",   medium: "cpc",    signups: 2, signups_30d: 1, activated: 1, placed: 0, quality_score: 0 },
          { channel: "direct",   medium: "unknown",signups: 2, signups_30d: 1, activated: 0, placed: 0, quality_score: 0 }
        ],
        geo: [
          { country_code: "ZA", signups: 5, signups_30d: 3, activated: 3, placed: 2 },
          { country_code: "US", signups: 3, signups_30d: 2, activated: 1, placed: 0 }
        ],
        landing: [
          { landing_path: "/", signups: 6, signups_30d: 4, activated: 3 },
          { landing_path: "/landing-pro", signups: 2, signups_30d: 1, activated: 1 }
        ],
        referrers: [
          { referrer_host: "linkedin.com", signups: 4, signups_30d: 3, activated: 3 },
          { referrer_host: "direct", signups: 4, signups_30d: 2, activated: 1 }
        ],
        topChannels: [
          { channel: "linkedin", medium: "social", signups: 4, activated: 3, placed: 2, quality_score: 50 }
        ],
        leakingChannels: [],
        recommendations: [
          { severity: "info", title: "Invest more in linkedin", body: "50% of linkedin signups placed.", action: "Double down on LinkedIn." }
        ]
      }
    });
    ctx.window.CBV2.adminMetrics.applyRemoteSnapshot(enriched);
  })();

  ctx.window.CBV2.getRouteParams = function () { return { section: "growth" }; };
  const growthHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Growth recommendations/.test(growthHtml), "growth section should render recommendations");
  assert.ok(/Acquisition funnel/.test(growthHtml), "growth section should render the acquisition funnel");
  assert.ok(/Acquisition channels/.test(growthHtml), "growth section should render channels table");
  assert.ok(/linkedin/.test(growthHtml), "growth section should include channel rows");
  assert.ok(/Signups by country/.test(growthHtml), "growth section should render geography");
  assert.ok(/ZA/.test(growthHtml), "growth section should include country codes");
  assert.ok(/Quality/.test(growthHtml), "growth section should render channel quality column");
  assert.ok(/Invest more in linkedin/.test(growthHtml), "growth section should render specific recommendations");

  ctx.window.CBV2.getRouteParams = function () { return { section: "users" }; };
  const usersHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Recent user accounts/.test(usersHtml), "users section should render");
  assert.ok(/operator@example\.com/.test(usersHtml), "users section should include recent users");
  assert.ok(/Pipeline/.test(usersHtml), "users section should include user work counts");

  ctx.window.CBV2.getRouteParams = function () { return { section: "user-support" }; };
  const supportHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/User support/.test(supportHtml), "user support section should render");
  assert.ok(/Account health queue/.test(supportHtml), "user support should render account health queue");
  assert.ok(/candidate@example\.com/.test(supportHtml), "user support should include monitored accounts");
  assert.ok(/Resume readiness follow-up/.test(supportHtml), "user support should render support playbooks");

  ctx.window.CBV2.getRouteParams = function () { return { section: "job-feed" }; };
  const feedHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Source truth issues/.test(feedHtml), "job feed section should render source issues");
  assert.ok(/indeed\.com/.test(feedHtml), "job feed section should show the actual host");

  ctx.window.CBV2.getRouteParams = function () { return { section: "ai-cost" }; };
  const aiHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Recent AI failures/.test(aiHtml), "AI section should render recent failure drill-down");
  assert.ok(/Provider quality/.test(aiHtml), "AI section should render provider-level metrics");
  assert.ok(/Rate limit/.test(aiHtml), "AI failures should show error message");

  ctx.window.CBV2.getRouteParams = function () { return { section: "extension" }; };
  const extensionHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Extension operating checks/.test(extensionHtml), "extension section should render capture checks");

  ctx.window.CBV2.getRouteParams = function () { return { section: "risk-center" }; };
  const riskHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Risk center/.test(riskHtml), "risk center should render");
  assert.ok(/Open incidents/.test(riskHtml), "risk center should render incidents");
  assert.ok(/Service levels/.test(riskHtml), "risk center should render service levels");
  assert.ok(/Release readiness/.test(riskHtml), "risk center should render release readiness");
  assert.ok(/Fix source truth mismatch/.test(riskHtml), "risk center should render runbooks");

  ctx.window.CBV2.getRouteParams = function () { return { section: "reports" }; };
  const reportsHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Reports &amp; audit/.test(reportsHtml), "reports section should render report heading");
  assert.ok(/Executive snapshot/.test(reportsHtml), "reports section should render executive snapshot");
  assert.ok(/Operator action queue/.test(reportsHtml), "reports section should render action queue");
  assert.ok(/Audit record/.test(reportsHtml), "reports section should render audit metadata");
  assert.ok(/Export packages/.test(reportsHtml), "reports section should render export packages");
  assert.ok(/Stale signals/.test(reportsHtml), "reports section should render stale-data status");
  assert.ok(/Privacy controls/.test(reportsHtml), "reports section should render privacy controls");
  assert.ok(/Cohorts CSV/.test(reportsHtml), "reports section should render cohort export");
  assert.ok(/Freshness CSV/.test(reportsHtml), "reports section should render freshness export");

  ctx.window.CBV2.getRouteParams = function () { return { section: "logs" }; };
  const logsHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/System logs/.test(logsHtml), "logs section should render operator stream");

  ctx.window.CBV2.getRouteParams = function () { return { section: "settings" }; };
  const settingsHtml = ctx.window.CBV2.routes.admin();
  assert.ok(/Operational guardrails/.test(settingsHtml), "settings section should render admin guardrails");

  console.log("Admin console tests passed.");
}

run();
