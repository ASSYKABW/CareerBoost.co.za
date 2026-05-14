// Phase D: Extension health section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const hostLabel = h.hostLabel;
    const formatDateTime = h.formatDateTime;

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

  window.CBV2.adminSections.extension = { render: render };
})();
