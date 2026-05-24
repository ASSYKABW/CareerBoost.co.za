// Phase D: Overview section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function render(data) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const renderAlerts = h.renderAlerts;
    const renderSparkBars = h.renderSparkBars;
    const searchTrend = h.searchTrend;
    const renderProviderRows = h.renderProviderRows;
    const renderActivity = h.renderActivity;
    const formatDateTime = h.formatDateTime;
    const money = h.money;
    const percent = h.percent;

    const aiFailureRate = percent(data.ai.failed || 0, Math.max(1, (data.ai.success || 0) + (data.ai.failed || 0)));
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

  window.CBAdmin.sections.overview = { render: render };
})();
