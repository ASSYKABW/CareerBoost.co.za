// Phase D: Risk Center section renderer (split from admin.route.js).
// Reads incident lifecycle state from helpers.adminIncidentsRemote (Phase C.2).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const serviceTone = h.serviceTone;
    const adminIncidentsRemote = h.adminIncidentsRemote;

    const control = data.controlCenter || {};
    const incidents = safeArray(control.incidents);
    const levels = safeArray(control.serviceLevels);
    const runbooks = safeArray(control.runbooks);
    const readiness = control.releaseReadiness || {};
    const checks = safeArray(readiness.checks);
    const escalation = control.escalation || {};

    // Phase C.2: filter open/snoozed incidents to the top, surface
    // acknowledged/resolved at the bottom collapsed. Also show counts.
    const openCount = incidents.filter(function (i) {
      return (i.status || "open") === "open";
    }).length;
    const ackCount = incidents.filter(function (i) { return i.status === "acknowledged"; }).length;
    const snoozedCount = incidents.filter(function (i) { return i.status === "snoozed"; }).length;

    const incidentMutErr = adminIncidentsRemote.mutationError
      ? '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(adminIncidentsRemote.mutationError) + '</p>'
      : "";

    function renderIncidentRow(item) {
      const status = String(item.status || "open");
      const isOpen = status === "open";
      const isAck = status === "acknowledged";
      const isSnoozed = status === "snoozed";
      const isResolved = status === "resolved";
      const persisted = !!item.dedupKey;
      const isThisBusy = adminIncidentsRemote.mutationBusy && adminIncidentsRemote.actingOnId === item.id;
      const disabledAttr = (adminIncidentsRemote.mutationBusy || !persisted) ? " disabled" : "";
      const statusTone = isResolved ? "green"
        : isAck ? "cyan"
        : isSnoozed ? "blue"
        : (item.severity === "critical" ? "rose" : item.severity === "warning" ? "amber" : "subtle");
      const sevChip = '<b class="chip ' + (item.severity === "critical" ? "rose" : item.severity === "warning" ? "amber" : "subtle") + '">' + st(item.severity || "info") + '</b>';
      const statusChip = '<b class="chip ' + statusTone + '">' + st(status) +
        (item.occurrenceCount > 1 ? ' · ' + item.occurrenceCount + '×' : "") +
        '</b>';
      const buttons = [];
      if (isOpen) {
        buttons.push(
          '<button type="button" class="btn-ghost btn-sm" data-incident-ack="' + st(item.id) + '"' + disabledAttr + '>' +
            (isThisBusy ? '<i class="fa-solid fa-circle-notch fa-spin"></i>' : '<i class="fa-solid fa-eye"></i>') +
            ' Ack' +
          '</button>',
          '<button type="button" class="btn-ghost btn-sm" data-incident-snooze="' + st(item.id) + '"' + disabledAttr + '>' +
            '<i class="fa-solid fa-clock"></i> Snooze' +
          '</button>'
        );
      }
      if (isOpen || isAck || isSnoozed) {
        buttons.push(
          '<button type="button" class="btn-ghost btn-sm" data-incident-resolve="' + st(item.id) + '"' + disabledAttr + '>' +
            '<i class="fa-solid fa-check"></i> Resolve' +
          '</button>'
        );
      }
      if (isResolved || isAck || isSnoozed) {
        buttons.push(
          '<button type="button" class="btn-ghost btn-sm" data-incident-reopen="' + st(item.id) + '"' + disabledAttr + '>' +
            '<i class="fa-solid fa-rotate-left"></i> Reopen' +
          '</button>'
        );
      }
      const tooltip = !persisted
        ? ' title="Re-deploy admin-overview to enable lifecycle controls."'
        : "";
      return (
        '<div class="admin-incident-row admin-incident-row--' + st(status) + '"' + tooltip + '>' +
          '<div class="admin-incident-meta">' +
            sevChip + statusChip +
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

    const openOrPending = incidents.filter(function (i) {
      const s = i.status || "open";
      return s === "open" || s === "acknowledged" || s === "snoozed";
    });
    const archived = incidents.filter(function (i) { return i.status === "resolved"; });

    return (
      '<section class="admin-stat-grid">' +
        renderStat("Open incidents", openCount, "needing attention", openCount ? "amber" : "green") +
        renderStat("Acknowledged", ackCount, "operator aware", ackCount ? "cyan" : "subtle") +
        renderStat("Snoozed", snoozedCount, "will reopen", snoozedCount ? "blue" : "subtle") +
        renderStat("Release readiness", (readiness.score != null ? readiness.score : 0) + "%", readiness.status || "waiting", serviceTone(readiness.status)) +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Risk center</span><h2>Incident queue</h2></div><span class="chip ' + st(openCount ? "amber" : "green") + '">' + st(openCount ? openCount + " open" : "Clean") + '</span></div>' +
          incidentMutErr +
          (openOrPending.length
            ? '<div class="admin-incident-list">' + openOrPending.map(renderIncidentRow).join("") + '</div>'
            : '<p class="admin-copy">No open incidents. Keep monitoring job source truth, AI reliability, sync health, and activation.</p>') +
          (archived.length
            ? '<details class="admin-resolved-incidents">' +
                '<summary>Resolved (' + st(archived.length) + ')</summary>' +
                '<div class="admin-incident-list admin-incident-list--archived">' +
                  archived.map(renderIncidentRow).join("") +
                '</div>' +
              '</details>'
            : "") +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Service levels</span><h2>Operating health checks</h2></div><span class="chip blue">Live controls</span></div>' +
          '<div class="admin-sla-list">' +
            (levels.length ? levels.map(function (row) {
              return (
                '<a class="admin-sla-row admin-sla-row--' + st(serviceTone(row.status)) + '" href="#/admin?section=' + st(row.section || "overview") + '">' +
                  '<span></span><div><strong>' + st(row.label) + '</strong><small>' + st(row.target) + '</small></div><em>' + st(row.current) + '</em>' +
                '</a>'
              );
            }).join("") : '<p class="admin-copy">Service-level checks will appear after the admin backend returns Phase 6 telemetry.</p>') +
          '</div>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Release readiness</span><h2>Can CareerBoost ship safely?</h2></div><span class="chip ' + st(serviceTone(readiness.status)) + '">' + st(readiness.status || "waiting") + '</span></div>' +
        '<div class="admin-readiness-grid">' +
          (checks.length ? checks.map(function (check) {
            return '<div class="admin-readiness-card ' + (check.pass ? "is-pass" : "is-fail") + '"><i class="fa-solid ' + (check.pass ? "fa-check" : "fa-triangle-exclamation") + '"></i><strong>' + st(check.label) + '</strong><span>' + st(check.detail || "") + '</span></div>';
          }).join("") : '<p class="admin-copy">Release checks need the deployed admin backend snapshot.</p>') +
        '</div>' +
      '</article>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Runbooks</span><h2>How operators respond</h2></div><span class="chip cyan">Playbooks</span></div>' +
          '<div class="admin-runbook-list">' +
            (runbooks.length ? runbooks.map(function (book) {
              return (
                '<details class="admin-runbook">' +
                  '<summary><span>' + st(book.title) + '</span><em>' + st(book.ownerArea || "ops") + '</em></summary>' +
                  '<ol>' + safeArray(book.steps).map(function (step) { return '<li>' + st(step) + '</li>'; }).join("") + '</ol>' +
                '</details>'
              );
            }).join("") : '<p class="admin-copy">Runbooks will appear after the backend is deployed.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Escalation policy</span><h2>Operating cadence</h2></div><span class="chip green">Read-only</span></div>' +
          '<div class="admin-action-list">' +
            '<div class="admin-action-card"><i class="fa-solid fa-bell"></i><div><strong>Review policy</strong><span>' + st(escalation.policy || "Review critical incidents before releasing candidate-facing changes.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-calendar-check"></i><div><strong>Cadence</strong><span>' + st(escalation.cadence || "Daily while incidents are open; weekly when all systems are healthy.") + '</span></div></div>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  window.CBV2.adminSections["risk-center"] = { render: render };
})();
