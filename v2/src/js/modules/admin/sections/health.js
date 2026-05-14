// Phase E5: Health board — the consolidated reliability view.
//
// Merges three pre-redesign sections into one:
//   - Risk center (incidents + SLA + release readiness + runbooks)
//   - Sync health (cloud connectivity + backend warnings)
//   - Job feed health (source/host truth, provider conflicts)
//
// Layout, top to bottom:
//   1. Health summary strip (incidents / cloud / source / readiness)
//   2. Active incidents queue (with ack/snooze/resolve/reopen buttons —
//      reuses the same data-incident-* bindings that admin.route.js
//      already wires up for the legacy risk-center section).
//   3. Service level checks (one row per check)
//   4. Release readiness checks
//   5. Cloud / backend diagnostics (warnings list)
//   6. Job source truth (provider table + mismatch issues)
//   7. Operator runbooks (collapsible)
//
// The legacy section IDs (risk-center, sync, job-feed) still route here
// via the admin.route.js dispatcher alias, so old links/bookmarks work.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function renderHealthSummary(data, h) {
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const control = data.controlCenter || {};
    const incidents = safeArray(control.incidents);
    const openCount = incidents.filter(function (i) { return (i.status || "open") === "open"; }).length;
    const readiness = control.releaseReadiness || {};
    const cloudConnected = data.cloud && data.cloud.connected;
    const warnings = (data.cloud && data.cloud.warnings) || [];
    const sourceIssues = safeArray(data.sourceIssues);
    const jobFeedQuality = data.feedQuality || {};
    const issueRate = Number(jobFeedQuality.issueRate || 0);
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Open incidents", openCount, "needing attention", openCount ? "amber" : "green") +
        renderStat("Cloud backend", cloudConnected ? "Live" : "Local", warnings.length + " warning" + (warnings.length === 1 ? "" : "s"), cloudConnected && warnings.length === 0 ? "green" : (cloudConnected ? "amber" : "rose")) +
        renderStat("Source truth", (issueRate || 0) + "% mismatch", sourceIssues.length + " conflict" + (sourceIssues.length === 1 ? "" : "s"), issueRate > 10 ? "rose" : (issueRate > 5 ? "amber" : "green")) +
        renderStat("Release readiness", (readiness.score != null ? readiness.score : 0) + "%", readiness.status || "waiting", (readiness.score || 0) >= 85 ? "green" : (readiness.score || 0) >= 65 ? "amber" : "rose") +
      '</section>'
    );
  }

  // Incident row renderer — mirrors the risk-center version but lives
  // here so health.js doesn't depend on risk-center.js being loaded.
  function renderIncidentRow(item, h) {
    const st = h.st;
    const op = h.adminIncidentsRemote;
    const status = String(item.status || "open");
    const isOpen = status === "open";
    const isAck = status === "acknowledged";
    const isSnoozed = status === "snoozed";
    const isResolved = status === "resolved";
    const persisted = !!item.dedupKey;
    const isThisBusy = op.mutationBusy && op.actingOnId === item.id;
    const disabledAttr = (op.mutationBusy || !persisted) ? " disabled" : "";
    const statusTone = isResolved ? "green"
      : isAck ? "cyan"
      : isSnoozed ? "blue"
      : (item.severity === "critical" ? "rose" : item.severity === "warning" ? "amber" : "subtle");
    const sevTone = item.severity === "critical" ? "rose" : item.severity === "warning" ? "amber" : "subtle";
    const buttons = [];
    if (isOpen) {
      buttons.push(
        '<button type="button" class="btn-ghost btn-sm" data-incident-ack="' + st(item.id) + '"' + disabledAttr + '>' +
          (isThisBusy ? '<i class="fa-solid fa-circle-notch fa-spin"></i>' : '<i class="fa-solid fa-eye"></i>') + ' Ack' +
        '</button>',
        '<button type="button" class="btn-ghost btn-sm" data-incident-snooze="' + st(item.id) + '"' + disabledAttr + '><i class="fa-solid fa-clock"></i> Snooze</button>'
      );
    }
    if (isOpen || isAck || isSnoozed) {
      buttons.push('<button type="button" class="btn-ghost btn-sm" data-incident-resolve="' + st(item.id) + '"' + disabledAttr + '><i class="fa-solid fa-check"></i> Resolve</button>');
    }
    if (isResolved || isAck || isSnoozed) {
      buttons.push('<button type="button" class="btn-ghost btn-sm" data-incident-reopen="' + st(item.id) + '"' + disabledAttr + '><i class="fa-solid fa-rotate-left"></i> Reopen</button>');
    }
    return (
      '<div class="admin-incident-row admin-incident-row--' + st(status) + '"' + (persisted ? '' : ' title="Re-deploy admin-overview to enable lifecycle controls."') + '>' +
        '<div class="admin-incident-meta">' +
          '<b class="chip ' + sevTone + '">' + st(item.severity || "info") + '</b>' +
          '<b class="chip ' + statusTone + '">' + st(status) + (item.occurrenceCount > 1 ? ' · ' + item.occurrenceCount + '×' : "") + '</b>' +
          '<span class="admin-incident-area">' + st(item.affectedArea || item.section || "overview") + '</span>' +
        '</div>' +
        '<div class="admin-incident-body">' +
          '<strong>' + st(item.title || "Incident") + '</strong>' +
          (item.body ? '<span>' + st(item.body) + '</span>' : "") +
          (item.action ? '<em>' + st(item.action) + '</em>' : "") +
        '</div>' +
        (buttons.length ? '<div class="admin-incident-actions">' + buttons.join("") + '</div>' : "") +
      '</div>'
    );
  }

  function renderIncidents(data, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const control = data.controlCenter || {};
    const incidents = safeArray(control.incidents);
    const openOrPending = incidents.filter(function (i) {
      const s = i.status || "open";
      return s === "open" || s === "acknowledged" || s === "snoozed";
    });
    const archived = incidents.filter(function (i) { return i.status === "resolved"; });
    const mutErr = h.adminIncidentsRemote.mutationError
      ? '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(h.adminIncidentsRemote.mutationError) + '</p>'
      : "";
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>Active incidents</span><h2>Anything degraded right now?</h2></div>' +
          '<span class="chip ' + (openOrPending.length ? "amber" : "green") + '">' + st(openOrPending.length) + ' active</span>' +
        '</div>' +
        mutErr +
        (openOrPending.length
          ? '<div class="admin-incident-list">' + openOrPending.map(function (i) { return renderIncidentRow(i, h); }).join("") + '</div>'
          : '<p class="admin-copy">No open incidents. Keep monitoring source truth, AI reliability, sync health, and activation.</p>') +
        (archived.length
          ? '<details class="admin-resolved-incidents">' +
              '<summary>Resolved (' + st(archived.length) + ')</summary>' +
              '<div class="admin-incident-list admin-incident-list--archived">' +
                archived.map(function (i) { return renderIncidentRow(i, h); }).join("") +
              '</div>' +
            '</details>'
          : "") +
      '</article>'
    );
  }

  function renderServiceLevels(data, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const serviceTone = h.serviceTone;
    const control = data.controlCenter || {};
    const levels = safeArray(control.serviceLevels);
    if (!levels.length) return "";
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Service levels</span><h2>Operating health checks</h2></div><span class="chip blue">Live controls</span></div>' +
        '<div class="admin-sla-list">' +
          levels.map(function (row) {
            return (
              '<a class="admin-sla-row admin-sla-row--' + st(serviceTone(row.status)) + '" href="#/admin?section=' + st(row.section || "command-center") + '">' +
                '<span></span><div><strong>' + st(row.label) + '</strong><small>' + st(row.target) + '</small></div><em>' + st(row.current) + '</em>' +
              '</a>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderReleaseReadiness(data, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const serviceTone = h.serviceTone;
    const control = data.controlCenter || {};
    const readiness = control.releaseReadiness || {};
    const checks = safeArray(readiness.checks);
    if (!checks.length) return "";
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Release readiness</span><h2>Can CareerBoost ship safely?</h2></div><span class="chip ' + st(serviceTone(readiness.status)) + '">' + st(readiness.status || "waiting") + '</span></div>' +
        '<div class="admin-readiness-grid">' +
          checks.map(function (check) {
            return '<div class="admin-readiness-card ' + (check.pass ? "is-pass" : "is-fail") + '"><i class="fa-solid ' + (check.pass ? "fa-check" : "fa-triangle-exclamation") + '"></i><strong>' + st(check.label) + '</strong><span>' + st(check.detail || "") + '</span></div>';
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderCloudDiagnostics(data, h) {
    const st = h.st;
    const warnings = (data.cloud && data.cloud.warnings) || [];
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Cloud diagnostics</span><h2>Backend read health</h2></div><span class="chip ' + (data.cloud.connected ? "green" : "amber") + '">' + (data.cloud.connected ? "Live" : "Waiting") + '</span></div>' +
        (warnings.length
          ? '<ul class="admin-warning-list">' + warnings.map(function (w) { return '<li>' + st(w) + '</li>'; }).join("") + '</ul>'
          : '<p class="admin-copy">No backend warnings reported by the admin overview function.</p>') +
      '</article>'
    );
  }

  function renderJobSourceTruth(data, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const hostLabel = h.hostLabel;
    const formatDateTime = h.formatDateTime;
    const sources = data.jobFeedStats && Array.isArray(data.jobFeedStats.sources) ? data.jobFeedStats.sources : [];
    const issues = safeArray(data.sourceIssues);
    if (!sources.length && !issues.length) return "";
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Job source truth</span><h2>Provider provenance + conflicts</h2></div><span class="chip ' + (issues.length ? "amber" : "green") + '">' + st(issues.length) + ' conflict' + (issues.length === 1 ? "" : "s") + '</span></div>' +
        (sources.length
          ? '<div class="admin-table">' +
              '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Source</span><span>Host</span><span>Jobs</span><span>Issues</span><span>Status</span></div>' +
              sources.slice(0, 8).map(function (row) {
                return '<div class="admin-table-row admin-table-row--five"><span>' + st(row.label) + '</span><span>' + st(hostLabel(row.host)) + '</span><span>' + st(row.count) + '</span><span>' + st(row.issueCount || 0) + '</span><span>' + st(row.status || "healthy") + '</span></div>';
              }).join("") +
            '</div>'
          : '') +
        (issues.length
          ? '<details class="admin-resolved-incidents" open>' +
              '<summary>Source/host mismatches (' + st(issues.length) + ')</summary>' +
              '<div class="admin-table">' +
                '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Job</span><span>Company</span><span>Source</span><span>Actual host</span><span>Saved</span></div>' +
                issues.slice(0, 12).map(function (issue) {
                  return '<div class="admin-table-row admin-table-row--five"><span>' + st(issue.title) + '</span><span>' + st(issue.company || "Unknown") + '</span><span>' + st(issue.source) + '</span><span>' + st(hostLabel(issue.host)) + '</span><span>' + st(formatDateTime(issue.savedAt)) + '</span></div>';
                }).join("") +
              '</div>' +
            '</details>'
          : '') +
      '</article>'
    );
  }

  function renderRunbooks(data, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const control = data.controlCenter || {};
    const runbooks = safeArray(control.runbooks);
    const escalation = control.escalation || {};
    if (!runbooks.length && !escalation.policy) return "";
    return (
      '<section class="admin-grid admin-grid--two">' +
        (runbooks.length ? (
          '<article class="admin-panel">' +
            '<div class="admin-panel-head"><div><span>Runbooks</span><h2>How operators respond</h2></div><span class="chip cyan">Playbooks</span></div>' +
            '<div class="admin-runbook-list">' +
              runbooks.map(function (book) {
                return (
                  '<details class="admin-runbook">' +
                    '<summary><span>' + st(book.title) + '</span><em>' + st(book.ownerArea || "ops") + '</em></summary>' +
                    '<ol>' + safeArray(book.steps).map(function (step) { return '<li>' + st(step) + '</li>'; }).join("") + '</ol>' +
                  '</details>'
                );
              }).join("") +
            '</div>' +
          '</article>'
        ) : '') +
        (escalation.policy ? (
          '<article class="admin-panel">' +
            '<div class="admin-panel-head"><div><span>Escalation</span><h2>Operating cadence</h2></div><span class="chip green">Read-only</span></div>' +
            '<div class="admin-action-list">' +
              '<div class="admin-action-card"><i class="fa-solid fa-bell"></i><div><strong>Review policy</strong><span>' + st(escalation.policy || "—") + '</span></div></div>' +
              '<div class="admin-action-card"><i class="fa-solid fa-calendar-check"></i><div><strong>Cadence</strong><span>' + st(escalation.cadence || "—") + '</span></div></div>' +
            '</div>' +
          '</article>'
        ) : '') +
      '</section>'
    );
  }

  function render(data) {
    const h = window.CBV2.adminHelpers;
    return (
      renderHealthSummary(data, h) +
      renderIncidents(data, h) +
      '<section class="admin-grid admin-grid--two">' +
        renderServiceLevels(data, h) +
        renderReleaseReadiness(data, h) +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        renderCloudDiagnostics(data, h) +
        renderJobSourceTruth(data, h) +
      '</section>' +
      renderRunbooks(data, h)
    );
  }

  window.CBV2.adminSections.health = { render: render };
})();
