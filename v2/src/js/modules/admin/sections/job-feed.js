// Phase D: Job feed health section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function render(data) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const hostLabel = h.hostLabel;
    const formatDateTime = h.formatDateTime;

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

  window.CBAdmin.sections["job-feed"] = { render: render };
})();
