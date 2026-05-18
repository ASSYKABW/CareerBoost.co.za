// Phase E5: Operations board — the consolidated governance + ops view.
//
// Merges three pre-redesign sections into one:
//   - Reports & audit (executive snapshot + audit log + export packages)
//   - Admin settings (operators + privacy disclosure + guardrails)
//   - System logs (alerts + recent activity)
//
// Layout, top to bottom:
//   1. Ops summary stat grid (health score / operators / open alerts / exports)
//   2. Operator management (promote/demote)
//   3. Audit log (paginated)
//   4. Recent alerts + activity feed
//   5. Export packages (CSV/JSON downloads)
//   6. Privacy & access disclosure
//
// Bindings (operator form, audit pager, demote, exports) are wired by
// admin.route.js's afterRender hook keyed on section === "operations"
// so the same controls work here that worked on the old sections.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function renderSummary(data, h) {
    const renderStat = h.renderStat;
    const formatDateTime = h.formatDateTime;
    const safeArray = h.safeArray;
    const reports = data.reports || {};
    const opState = h.adminOperatorsRemote;
    const operatorsCount = (opState.data && Array.isArray(opState.data.operators)) ? opState.data.operators.length : 0;
    const alerts = safeArray(data.alerts);
    const health = Number(reports.healthScore || 0);
    const healthTone = health >= 80 ? "green" : (health >= 60 ? "amber" : "rose");
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Health score", health ? health + "%" : "Local", "activation + source + AI + freshness", healthTone) +
        renderStat("Admin operators", operatorsCount, "users with admin role", operatorsCount > 0 ? "blue" : "amber") +
        renderStat("Open alerts", alerts.length, "operator signals to review", alerts.length ? "amber" : "green") +
        renderStat("Last snapshot", formatDateTime(data.cloud.generatedAt), "admin-overview refresh", "cyan") +
      '</section>'
    );
  }

  function renderOperatorManagement(data, h) {
    const st = h.st;
    const formatDateTime = h.formatDateTime;
    const op = h.adminOperatorsRemote;
    const access = (data.cloud && data.cloud.access) || {};
    const allowedRoles = Array.isArray(access.allowedRoles) && access.allowedRoles.length
      ? access.allowedRoles
      : ["admin", "owner", "developer"];
    const operators = (op.data && Array.isArray(op.data.operators)) ? op.data.operators : [];
    // A5: fetch-error banner uses shared helper so a Retry button is
    // wired inline. Mutation errors stay as plain banners (no fetcher
    // to retry — the operator just resubmits the form).
    const errorLine = op.error
      ? (h.renderErrorBanner
          ? h.renderErrorBanner(op.error, "operators")
          : '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(op.error) + '</p>')
      : "";
    const mutationErr = op.mutationError
      ? '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(op.mutationError) + '</p>'
      : "";
    const roleOptions = allowedRoles.map(function (role) {
      return '<option value="' + st(role) + '">' + st(role) + '</option>';
    }).join("");
    const rows = operators.map(function (entry) {
      const adminRolesLabel = entry.adminRoles && entry.adminRoles.length ? entry.adminRoles.join(", ") : "admin";
      const isSelf = !!entry.isSelf;
      const demoteAttrs = isSelf
        ? 'disabled title="You cannot demote yourself — ask another admin"'
        : 'data-admin-demote="' + st(entry.id || "") + '" data-admin-demote-email="' + st(entry.email || "") + '"';
      return (
        '<div class="admin-table-row admin-table-row--operators">' +
          '<span>' + st(entry.email || "Unknown email") + (isSelf ? ' <em class="admin-self-tag">(you)</em>' : "") + '</span>' +
          '<span><b class="chip blue">' + st(adminRolesLabel) + '</b></span>' +
          '<span>' + st(formatDateTime(entry.lastSignInAt || entry.createdAt)) + '</span>' +
          '<span><button type="button" class="btn-ghost btn-sm" ' + demoteAttrs + '><i class="fa-solid fa-user-minus"></i> Remove admin</button></span>' +
        '</div>'
      );
    }).join("");
    const tableBody = operators.length
      ? rows
      : (op.status === "loading"
          ? '<p class="admin-copy">Loading operators…</p>'
          : '<p class="admin-copy">No active admin operators returned. Deploy admin-list-operators if the function is missing.</p>');
    // A5: replaced the bespoke refresh button with the shared freshness
    // badge. The badge's built-in refresh icon hits [data-admin-refresh]
    // which dispatches to fetchAdminOperators(true). The old
    // #admin-operators-refresh button stays on the page only via the
    // legacy binding code path for code that may still reference it.
    const operatorsBadge = h.renderFreshnessBadge
      ? h.renderFreshnessBadge(op, "operators", { ttlMs: 60_000 })
      : "";
    return (
      '<article class="admin-panel admin-panel--wide" id="admin-operator-management">' +
        '<div class="admin-panel-head">' +
          '<div><span>Operator management</span><h2>Who has admin access</h2></div>' +
          '<div class="admin-topbar-actions" style="display:flex;gap:6px;align-items:center;">' +
            '<span class="chip blue">' + st(operators.length || 0) + ' operator' + (operators.length === 1 ? "" : "s") + '</span>' +
            operatorsBadge +
          '</div>' +
        '</div>' +
        errorLine +
        '<p class="admin-copy">Promote a teammate by entering their CareerBoost email and role. All changes are audit-logged.</p>' +
        '<form class="admin-operator-form" id="admin-operator-form">' +
          '<label class="admin-users-filter" style="flex:2;"><i class="fa-solid fa-envelope" aria-hidden="true"></i><input type="email" name="email" placeholder="teammate@example.com" required autocomplete="off" /></label>' +
          '<label class="admin-users-sort"><span class="admin-users-sort-label">Role</span><select name="role">' + roleOptions + '</select></label>' +
          '<label class="admin-users-filter" style="flex:1;"><i class="fa-solid fa-pen" aria-hidden="true"></i><input type="text" name="note" placeholder="Optional note" maxlength="200" autocomplete="off" /></label>' +
          '<button type="submit" class="btn-primary btn-sm"' + (op.mutationBusy ? " disabled" : "") + '>' +
            (op.mutationBusy ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Granting…' : '<i class="fa-solid fa-user-plus"></i> Grant admin') +
          '</button>' +
        '</form>' +
        mutationErr +
        '<div class="admin-table" style="margin-top:12px;">' +
          '<div class="admin-table-row admin-table-row--operators admin-table-head"><span>Email</span><span>Admin role</span><span>Last sign-in</span><span></span></div>' +
          tableBody +
        '</div>' +
      '</article>'
    );
  }

  // Audit log panel — same shape as reports.js renderAuditLogPanel.
  function renderAuditLogPanel(h) {
    const st = h.st;
    const formatDateTime = h.formatDateTime;
    const op = h.adminAuditRemote;
    const data = (op.data && op.data.ok !== false) ? op.data : null;
    const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
    const meta = data && data.page ? data.page : null;
    const mix = (data && Array.isArray(data.actionMix)) ? data.actionMix : [];
    const status = op.status;
    // A5: shared error banner with Retry button wired to audit fetcher.
    const errLine = op.error
      ? (h.renderErrorBanner
          ? h.renderErrorBanner(op.error, "audit")
          : '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(op.error) + '</p>')
      : "";
    const mixChips = mix.length
      ? mix.map(function (row) { return '<span class="chip subtle">' + st(row.action) + ' · ' + st(row.count) + '</span>'; }).join(" ")
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
        '<label class="admin-users-filter" style="flex:2;"><i class="fa-solid fa-bolt" aria-hidden="true"></i><input type="search" id="admin-audit-action" placeholder="Action (e.g. promote_user)" value="' + st(actionFilter) + '" autocomplete="off" /></label>' +
        '<label class="admin-users-filter" style="flex:2;"><i class="fa-solid fa-envelope" aria-hidden="true"></i><input type="search" id="admin-audit-target" placeholder="Target email" value="' + st(targetFilter) + '" autocomplete="off" /></label>' +
        '<div class="admin-users-pager">' +
          '<button type="button" class="btn-ghost btn-sm" id="admin-audit-prev"' + (hasPrev ? "" : " disabled") + '><i class="fa-solid fa-chevron-left"></i></button>' +
          '<span class="admin-users-pager-status">Page ' + st(currentPage) + ' of ' + st(totalPages) + ' · ' + st(totalRows) + ' entr' + (totalRows === 1 ? "y" : "ies") + '</span>' +
          '<button type="button" class="btn-ghost btn-sm" id="admin-audit-next"' + (hasNext ? "" : " disabled") + '><i class="fa-solid fa-chevron-right"></i></button>' +
          '<button type="button" class="btn-ghost btn-sm" id="admin-audit-refresh"' + (op.inFlight ? " disabled" : "") + '><i class="fa-solid fa-rotate' + (op.inFlight ? " fa-spin" : "") + '"></i></button>' +
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
          : '<p class="admin-copy">No audit entries match these filters. Promote/demote or resolve an incident to populate the log.</p>');
    // A5: freshness badge in the audit log panel head. TTL matches the
    // fetcher's 30s cache so badge tone (fresh/aging/stale) aligns with
    // when the cache actually expires.
    const auditBadge = h.renderFreshnessBadge
      ? h.renderFreshnessBadge(op, "audit", { ttlMs: 30_000 })
      : "";
    return (
      '<article class="admin-panel admin-panel--wide" id="admin-audit-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Audit log</span><h2>Mutation history</h2></div>' +
          '<div class="admin-topbar-actions" style="display:flex;gap:6px;align-items:center;">' +
            '<span class="chip blue">' + st(totalRows || 0) + ' entr' + ((totalRows || 0) === 1 ? "y" : "ies") + '</span>' +
            auditBadge +
          '</div>' +
        '</div>' +
        (mixChips ? '<p class="admin-copy"><strong>Last 30 days:</strong> ' + mixChips + '</p>' : "") +
        errLine +
        toolbar +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--audit admin-table-head"><span>When</span><span>Admin</span><span>Action</span><span>Target</span><span>Result</span><span>Detail</span></div>' +
          rowsHtml +
        '</div>' +
      '</article>'
    );
  }

  function renderSystemLogs(data, h) {
    const renderAlerts = h.renderAlerts;
    const renderActivity = h.renderActivity;
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>System logs</span><h2>Alerts + recent activity</h2></div><span class="chip blue">Live</span></div>' +
        renderAlerts(data) +
        '<ul class="admin-activity-list admin-activity-list--spaced">' + renderActivity(data) + '</ul>' +
      '</article>'
    );
  }

  function renderExportPackages(data, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const reports = data.reports || {};
    const risks = reports.csv && Array.isArray(reports.csv.risks) ? reports.csv.risks : safeArray(data.alerts);
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Export packages</span><h2>Operator reports</h2></div><span class="chip blue">CSV / JSON</span></div>' +
        '<div class="admin-export-grid">' +
          '<button type="button" class="admin-export-card" data-admin-export="overview"><i class="fa-solid fa-table"></i><strong>Overview</strong><span>Executive snapshot</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="risks"><i class="fa-solid fa-triangle-exclamation"></i><strong>Risks</strong><span>' + st(risks.length) + ' alerts</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="modules"><i class="fa-solid fa-layer-group"></i><strong>Modules</strong><span>Adoption</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="cohortRetention"><i class="fa-solid fa-table-cells"></i><strong>Cohorts</strong><span>Retention</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="sources"><i class="fa-solid fa-link"></i><strong>Sources</strong><span>Provenance</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="providers"><i class="fa-solid fa-wand-magic-sparkles"></i><strong>AI providers</strong><span>Cost + reliability</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="dataFreshness"><i class="fa-solid fa-clock-rotate-left"></i><strong>Freshness</strong><span>Stale signals</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="incidents"><i class="fa-solid fa-shield-virus"></i><strong>Incidents</strong><span>Risk queue</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="serviceLevels"><i class="fa-solid fa-gauge-high"></i><strong>SLAs</strong><span>Health checks</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="accountHealth"><i class="fa-solid fa-user-check"></i><strong>Account health</strong><span>Support queue</span></button>' +
          '<button type="button" class="admin-export-card" data-admin-export="snapshot-json"><i class="fa-solid fa-code"></i><strong>Snapshot JSON</strong><span>Full payload</span></button>' +
        '</div>' +
      '</article>'
    );
  }

  function renderPrivacyDisclosure(data, h) {
    const st = h.st;
    const privacy = (data.privacyControls || (data.cloud && data.cloud.privacyControls)) || {};
    const access = (data.cloud && data.cloud.access) || {};
    const allowedRoles = Array.isArray(access.allowedRoles) && access.allowedRoles.length
      ? access.allowedRoles
      : ["admin", "owner", "developer"];
    const disallowedKeys = Array.isArray(privacy.disallowedMetadataKeys) ? privacy.disallowedMetadataKeys : [];
    const excludedContent = Array.isArray(privacy.excludedContent) ? privacy.excludedContent : [];
    const allowedTelemetry = Array.isArray(privacy.allowedTelemetry) ? privacy.allowedTelemetry : [];
    const exportScope = privacy.exportScope || "Aggregated operational metrics only";
    const metadataMaxBytes = privacy.metadataMaxBytes || 4096;
    function chipList(items, tone) {
      if (!items.length) return '<span class="admin-copy">None reported.</span>';
      return items.map(function (item) {
        return '<span class="chip ' + (tone || "subtle") + '">' + st(item) + '</span>';
      }).join(" ");
    }
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Privacy &amp; access disclosure</span><h2>What this console can see — and cannot</h2></div><span class="chip cyan">Transparency</span></div>' +
        '<p class="admin-copy">Sourced from the backend at request time. Reflects the ADMIN_ROLES env value and the privacy guard constraint on usage_events / usage_sessions metadata.</p>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-users-gear"></i><div><strong>Allowed admin roles (' + allowedRoles.length + ')</strong><span>' + chipList(allowedRoles, "blue") + '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-shield-halved"></i><div><strong>Export scope</strong><span>' + st(exportScope) + '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-eye"></i><div><strong>Telemetry permitted (' + allowedTelemetry.length + ')</strong><span>' + chipList(allowedTelemetry, "subtle") + '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-ban"></i><div><strong>Never exported / inspected (' + excludedContent.length + ')</strong><span>' + chipList(excludedContent, "amber") + '</span></div></div>' +
        '</div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-database"></i><div><strong>Blocked metadata keys (DB-enforced)</strong><span>' +
            (disallowedKeys.length ? '<code class="admin-codelist">' + disallowedKeys.map(st).join(", ") + '</code>' : "None reported.") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-ruler-horizontal"></i><div><strong>Metadata size cap</strong><span>' + st(metadataMaxBytes) + ' bytes per row. Enforced via Postgres check constraint.</span></div></div>' +
        '</div>' +
      '</article>'
    );
  }

  function render(data) {
    const h = window.CBV2.adminHelpers;
    return (
      renderSummary(data, h) +
      renderOperatorManagement(data, h) +
      renderAuditLogPanel(h) +
      '<section class="admin-grid admin-grid--two">' +
        renderSystemLogs(data, h) +
        renderExportPackages(data, h) +
      '</section>' +
      renderPrivacyDisclosure(data, h)
    );
  }

  window.CBV2.adminSections.operations = { render: render };
})();
