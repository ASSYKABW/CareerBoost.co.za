// Phase D: Reports & audit section renderer (split from admin.route.js).
// Includes the audit log panel which reads from helpers.adminAuditRemote (Phase C.2).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  // Phase C.2: paginated audit log viewer. Reads from /admin-list-audit;
  // shows full mutation history with action + target filters + paging.
  function renderAuditLogPanel() {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const formatDateTime = h.formatDateTime;
    const op = h.adminAuditRemote;

    const data = (op.data && op.data.ok !== false) ? op.data : null;
    const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
    const meta = data && data.page ? data.page : null;
    const mix = (data && Array.isArray(data.actionMix)) ? data.actionMix : [];

    const status = op.status;
    const errLine = op.error
      ? '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(op.error) + '</p>'
      : "";
    const mixChips = mix.length
      ? mix.map(function (row) {
          return '<span class="chip subtle">' + st(row.action) + ' · ' + st(row.count) + '</span>';
        }).join(" ")
      : "";

    const currentPage = meta ? Number(meta.page) : 1;
    const totalPages = meta ? Number(meta.totalPages) : 1;
    const totalRows = meta ? Number(meta.total) : entries.length;
    const hasNext = meta ? Boolean(meta.hasNext) : false;
    const hasPrev = meta ? Boolean(meta.hasPrev) : false;
    const actionFilter = meta ? String(meta.action || "") : op.actionFilter;
    const targetFilter = meta ? String(meta.targetEmail || "") : op.targetEmailFilter;

    const toolbar =
      '<div class="admin-users-toolbar" role="toolbar" aria-label="Audit log filters">' +
        '<label class="admin-users-filter" style="flex:2;">' +
          '<i class="fa-solid fa-bolt" aria-hidden="true"></i>' +
          '<input type="search" id="admin-audit-action" placeholder="Action (e.g. promote_user)" value="' + st(actionFilter) + '" autocomplete="off" />' +
        '</label>' +
        '<label class="admin-users-filter" style="flex:2;">' +
          '<i class="fa-solid fa-envelope" aria-hidden="true"></i>' +
          '<input type="search" id="admin-audit-target" placeholder="Target email" value="' + st(targetFilter) + '" autocomplete="off" />' +
        '</label>' +
        '<div class="admin-users-pager">' +
          '<button type="button" class="btn-ghost btn-sm" id="admin-audit-prev"' + (hasPrev ? "" : " disabled") + ' title="Previous page"><i class="fa-solid fa-chevron-left"></i></button>' +
          '<span class="admin-users-pager-status">Page ' + st(currentPage) + ' of ' + st(totalPages) + ' · ' + st(totalRows) + ' entr' + (totalRows === 1 ? "y" : "ies") + '</span>' +
          '<button type="button" class="btn-ghost btn-sm" id="admin-audit-next"' + (hasNext ? "" : " disabled") + ' title="Next page"><i class="fa-solid fa-chevron-right"></i></button>' +
          '<button type="button" class="btn-ghost btn-sm" id="admin-audit-refresh" title="Refresh"' + (op.inFlight ? " disabled" : "") + '><i class="fa-solid fa-rotate' + (op.inFlight ? " fa-spin" : "") + '"></i></button>' +
        '</div>' +
      '</div>';

    function payloadSnippet(payload) {
      if (!payload || typeof payload !== "object") return "";
      const keys = Object.keys(payload).slice(0, 3);
      if (!keys.length) return "";
      return keys.map(function (k) {
        const v = payload[k];
        let val = "";
        if (v == null) val = "null";
        else if (typeof v === "object") {
          try { val = JSON.stringify(v).slice(0, 60); } catch (e) { val = "[obj]"; }
        } else val = String(v).slice(0, 60);
        return k + "=" + val;
      }).join(" · ");
    }

    const rowsHtml = entries.length
      ? entries.map(function (row) {
          const rowStatus = String(row.result_status || "success");
          const statusTone = rowStatus === "success" ? "green" : "rose";
          const snippet = payloadSnippet(row.payload);
          return (
            '<div class="admin-table-row admin-table-row--audit">' +
              '<span>' + st(formatDateTime(row.occurred_at)) + '</span>' +
              '<span>' + st(row.admin_email || "Unknown") + '</span>' +
              '<span><code>' + st(row.action || "unknown") + '</code></span>' +
              '<span>' + st(row.target_email || "—") + '</span>' +
              '<span><b class="chip ' + statusTone + '">' + st(rowStatus) + '</b></span>' +
              '<span class="admin-audit-payload">' + st(snippet) +
                (row.error_message ? '<em class="admin-audit-error"> · ' + st(row.error_message) + '</em>' : "") +
              '</span>' +
            '</div>'
          );
        }).join("")
      : (status === "loading"
          ? '<p class="admin-copy">Loading audit entries…</p>'
          : '<p class="admin-copy">No audit entries match these filters. Run a promote/demote or resolve an incident to populate the log.</p>');

    return (
      '<article class="admin-panel admin-panel--wide" id="admin-audit-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Audit log</span><h2>Mutation history</h2></div>' +
          '<span class="chip blue">' + st(totalRows || 0) + ' entr' + ((totalRows || 0) === 1 ? "y" : "ies") + '</span>' +
        '</div>' +
        (mixChips ? '<p class="admin-copy"><strong>Last 30 days:</strong> ' + mixChips + '</p>' : "") +
        errLine +
        toolbar +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--audit admin-table-head">' +
            '<span>When</span><span>Admin</span><span>Action</span><span>Target</span><span>Result</span><span>Detail</span>' +
          '</div>' +
          rowsHtml +
        '</div>' +
      '</article>'
    );
  }

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const formatDateTime = h.formatDateTime;

    const reports = data.reports || {};
    const audit = reports.audit || {};
    const governance = reports.governance || {};
    const privacy = reports.privacyControls || data.privacyControls || {};
    const freshness = reports.dataFreshness || data.dataFreshness || {};
    const manifest = safeArray(reports.exportManifest);
    const summary = safeArray(reports.executiveSummary);
    const queue = safeArray(data.actionQueue && data.actionQueue.length ? data.actionQueue : reports.actionQueue);
    const risks = reports.csv && Array.isArray(reports.csv.risks) ? reports.csv.risks : safeArray(data.alerts);
    const sampled = audit.sampledRecords || {};
    const sampledRows = Object.keys(sampled).map(function (key) {
      return '<span><strong>' + st(key) + '</strong><em>' + st(sampled[key]) + '</em></span>';
    }).join("");
    const health = Number(reports.healthScore || 0);
    const healthTone = health >= 80 ? "green" : (health >= 60 ? "amber" : "red");
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Health score", health ? health + "%" : "Local", "activation, source truth, AI reliability, backend warnings", healthTone) +
        renderStat("Action queue", queue.length, "operator follow-ups", queue.length ? "amber" : "green") +
        renderStat("Export packages", manifest.length || (reports.csv ? Object.keys(reports.csv).length : 0), "CSV/JSON report bundles", "cyan") +
        renderStat("Stale signals", (freshness.staleSignals || []).length || 0, "telemetry freshness checks", (freshness.staleSignals || []).length ? "amber" : "green") +
        renderStat("Next review", formatDateTime(governance.recommendedNextReviewAt), "recommended governance cadence", "blue") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Reports &amp; audit</span><h2>Executive snapshot</h2></div><span class="chip ' + st(healthTone) + '">' + st(health ? health + "% health" : "Local") + '</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--three admin-table-head"><span>Signal</span><span>Value</span><span>Detail</span></div>' +
            (summary.length ? summary.map(function (row) {
              return '<div class="admin-table-row admin-table-row--three"><span>' + st(row.label) + '</span><span>' + st(row.value) + '</span><span>' + st(row.detail) + '</span></div>';
            }).join("") : '<p class="admin-copy">Connect the admin backend to generate the executive reporting snapshot.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Operational governance</span><h2>Audit record</h2></div><span class="chip green">Read-only</span></div>' +
          '<div class="admin-kv-grid">' +
            '<span><strong>Generated by</strong><em>' + st(audit.generatedBy || "Local preview") + '</em></span>' +
            '<span><strong>Generated at</strong><em>' + st(formatDateTime(audit.generatedAt || data.cloud.generatedAt)) + '</em></span>' +
            '<span><strong>Data window</strong><em>' + st(audit.dataWindow || "local") + '</em></span>' +
            '<span><strong>Backend warnings</strong><em>' + st(audit.backendWarnings || 0) + '</em></span>' +
            '<span><strong>Latest usage</strong><em>' + st(formatDateTime(freshness.latestUsageSessionAt || freshness.latestUsageEventAt)) + '</em></span>' +
          '</div>' +
          '<div class="admin-kv-grid admin-kv-grid--compact">' + (sampledRows || '<span><strong>Sample</strong><em>No cloud sample yet</em></span>') + '</div>' +
          '<p class="admin-copy">' + st(audit.privacy || "Reports should stay operational and avoid exporting candidate document body text.") + '</p>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Operator action queue</span><h2>What to review next</h2></div><span class="chip ' + st(queue.length ? "amber" : "green") + '">' + st(queue.length ? queue.length + " actions" : "Clean") + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Priority</span><span>Area</span><span>Issue</span><span>Action</span></div>' +
          (queue.length ? queue.map(function (item) {
            return '<div class="admin-table-row admin-table-row--four"><span>' + st(item.priority || "info") + '</span><span>' + st(item.ownerArea || item.section || "overview") + '</span><span>' + st(item.title || "Admin action") + '</span><span>' + st(item.action || "Review this signal.") + '</span></div>';
          }).join("") : '<p class="admin-copy">No operator actions are currently flagged.</p>') +
        '</div>' +
      '</article>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Export packages</span><h2>Download operator reports</h2></div><span class="chip blue">Phase 5</span></div>' +
          '<div class="admin-export-grid">' +
            '<button type="button" class="admin-export-card" data-admin-export="overview"><i class="fa-solid fa-table"></i><strong>Overview CSV</strong><span>Executive snapshot rows</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="risks"><i class="fa-solid fa-triangle-exclamation"></i><strong>Risks CSV</strong><span>' + st(risks.length) + ' alerts and actions</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="modules"><i class="fa-solid fa-layer-group"></i><strong>Modules CSV</strong><span>Adoption and records</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="cohortRetention"><i class="fa-solid fa-table-cells"></i><strong>Cohorts CSV</strong><span>Week 0-3 retention</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="sources"><i class="fa-solid fa-link"></i><strong>Sources CSV</strong><span>Provider provenance</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="providers"><i class="fa-solid fa-wand-magic-sparkles"></i><strong>AI providers CSV</strong><span>Cost and reliability</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="dataFreshness"><i class="fa-solid fa-clock-rotate-left"></i><strong>Freshness CSV</strong><span>Stale-data checks</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="incidents"><i class="fa-solid fa-shield-virus"></i><strong>Incidents CSV</strong><span>Open risk queue</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="serviceLevels"><i class="fa-solid fa-gauge-high"></i><strong>Service levels CSV</strong><span>Operating checks</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="accountHealth"><i class="fa-solid fa-user-check"></i><strong>Account health CSV</strong><span>Support queue</span></button>' +
            '<button type="button" class="admin-export-card" data-admin-export="snapshot-json"><i class="fa-solid fa-code"></i><strong>Snapshot JSON</strong><span>Full admin report object</span></button>' +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Governance model</span><h2>Safety guardrails</h2></div><span class="chip green">Candidate-safe</span></div>' +
          '<div class="admin-action-list">' +
            '<div class="admin-action-card"><i class="fa-solid fa-user-shield"></i><div><strong>Access model</strong><span>' + st(audit.accessModel || "Supabase app_metadata roles protect this dashboard.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-key"></i><div><strong>Secret model</strong><span>' + st(governance.secretModel || "Provider credentials stay backend-side.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-ban"></i><div><strong>Destructive actions</strong><span>' + st(governance.destructiveActionsDisabled === false ? "Enabled" : "Disabled in this console.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-file-export"></i><div><strong>Export scope</strong><span>' + st(governance.exportScope || "Aggregated operational metrics only.") + '</span></div></div>' +
            '<div class="admin-action-card"><i class="fa-solid fa-lock"></i><div><strong>Privacy controls</strong><span>' + st((privacy.excludedContent || []).length ? "Excludes " + privacy.excludedContent.join(", ") + "." : "Candidate document content is excluded from admin exports.") + '</span></div></div>' +
          '</div>' +
        '</article>' +
      '</section>' +
      renderAuditLogPanel()
    );
  }

  window.CBV2.adminSections.reports = { render: render };
})();
