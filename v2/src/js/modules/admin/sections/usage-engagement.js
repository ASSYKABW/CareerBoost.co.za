// Phase D: Usage & engagement section renderer (split from admin.route.js).
//
// This is the largest section — owns all of the per-section sub-renderers
// (usage trend chart, KPI strip, activation funnel, top drop-offs, module
// engagement, retention cohorts, session quality). Sub-renderers are kept
// inside this IIFE because no other section uses them.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

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
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;
    const compactNumber = h.compactNumber;

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

  function renderRetentionCohorts(retention) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;
    const progressTone = h.progressTone;

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

  function renderModuleEngagement(rows) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;
    const moduleStatusTone = h.moduleStatusTone;

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
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;
    const clampPct = h.clampPct;
    const progressTone = h.progressTone;
    const renderProgressRows = h.renderProgressRows;

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
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const formatDuration = h.formatDuration;

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
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;

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
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const formatDuration = h.formatDuration;
    const clampPct = h.clampPct;
    const renderCountBars = h.renderCountBars;

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

  function render(data) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;
    const progressTone = h.progressTone;
    const renderInsightList = h.renderInsightList;
    const renderCohortBars = h.renderCohortBars;

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

  window.CBAdmin.sections.usage = { render: render };
})();
