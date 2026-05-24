// Phase D: Sync health section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function render(data) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const renderStat = h.renderStat;

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

  window.CBAdmin.sections.sync = { render: render };
})();
