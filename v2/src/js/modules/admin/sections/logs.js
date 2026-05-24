// Phase D: System logs section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function render(data) {
    const h = window.CBAdmin.helpers;
    const renderStat = h.renderStat;
    const renderAlerts = h.renderAlerts;
    const renderActivity = h.renderActivity;
    const safeArray = h.safeArray;

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

  window.CBAdmin.sections.logs = { render: render };
})();
