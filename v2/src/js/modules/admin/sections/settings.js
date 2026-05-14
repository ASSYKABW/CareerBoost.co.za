// Phase D: Admin Settings section renderer (split from admin.route.js).
// Embeds the Operator Management panel which reads from helpers.adminOperatorsRemote.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  // Phase C: Operator Management panel — lists current admins and lets the
  // operator promote a new user by email or demote an existing one. Every
  // action is audit-logged at the DB level (admin_audit_log table).
  function renderOperatorManagement(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const formatDateTime = h.formatDateTime;
    const op = h.adminOperatorsRemote;

    const access = (data.cloud && data.cloud.access) || {};
    const allowedRoles = Array.isArray(access.allowedRoles) && access.allowedRoles.length
      ? access.allowedRoles
      : ["admin", "owner", "developer"];
    const operators = (op.data && Array.isArray(op.data.operators)) ? op.data.operators : [];
    const status = op.status;
    const errorLine = op.error
      ? '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(op.error) + '</p>'
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
          '<span>' +
            '<button type="button" class="btn-ghost btn-sm" ' + demoteAttrs + '>' +
              '<i class="fa-solid fa-user-minus"></i> Remove admin' +
            '</button>' +
          '</span>' +
        '</div>'
      );
    }).join("");

    const tableBody = operators.length
      ? rows
      : (status === "loading"
          ? '<p class="admin-copy">Loading operators…</p>'
          : '<p class="admin-copy">No active admin operators returned. The admin-list-operators function may not be deployed yet.</p>');

    return (
      '<article class="admin-panel admin-panel--wide" id="admin-operator-management">' +
        '<div class="admin-panel-head">' +
          '<div><span>Operator management</span><h2>Who has admin access</h2></div>' +
          '<div class="admin-topbar-actions" style="display:flex;gap:6px;align-items:center;">' +
            '<span class="chip blue">' + st(operators.length || 0) + ' operator' + (operators.length === 1 ? "" : "s") + '</span>' +
            '<button type="button" class="btn-ghost btn-sm" id="admin-operators-refresh"' + (op.inFlight ? " disabled" : "") + '>' +
              '<i class="fa-solid fa-rotate' + (op.inFlight ? " fa-spin" : "") + '"></i> Refresh' +
            '</button>' +
          '</div>' +
        '</div>' +
        errorLine +
        '<p class="admin-copy">Promote a teammate to admin by entering their CareerBoost email and role. They\'ll need to sign in/out to see the admin console. All changes are audit-logged.</p>' +
        '<form class="admin-operator-form" id="admin-operator-form">' +
          '<label class="admin-users-filter" style="flex:2;">' +
            '<i class="fa-solid fa-envelope" aria-hidden="true"></i>' +
            '<input type="email" name="email" placeholder="teammate@example.com" required autocomplete="off" />' +
          '</label>' +
          '<label class="admin-users-sort">' +
            '<span class="admin-users-sort-label">Role</span>' +
            '<select name="role">' + roleOptions + '</select>' +
          '</label>' +
          '<label class="admin-users-filter" style="flex:1;">' +
            '<i class="fa-solid fa-pen" aria-hidden="true"></i>' +
            '<input type="text" name="note" placeholder="Optional note (audit log)" maxlength="200" autocomplete="off" />' +
          '</label>' +
          '<button type="submit" class="btn-primary btn-sm"' + (op.mutationBusy ? " disabled" : "") + '>' +
            (op.mutationBusy
              ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Granting…'
              : '<i class="fa-solid fa-user-plus"></i> Grant admin') +
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

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const formatDateTime = h.formatDateTime;

    // Phase A: surface backend privacy controls + allowed-roles so the
    // operator has a transparent view of WHO can access and WHAT this
    // console is permitted to see.
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
      '<section class="admin-stat-grid">' +
        renderStat("Admin auth", "Supabase", "app_metadata roles only", "green") +
        renderStat("Backend function", data.cloud.connected ? "Live" : "Waiting", "admin-overview", data.cloud.connected ? "green" : "amber") +
        renderStat("Secret handling", "Server", "provider keys stay backend-side", "cyan") +
        renderStat("Last refresh", formatDateTime(data.cloud.generatedAt), "admin metrics snapshot", "blue") +
      '</section>' +
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Admin settings</span><h2>Operational guardrails</h2></div><span class="chip green">Candidate-safe</span></div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-user-lock"></i><div><strong>Role-based access</strong><span>Only Supabase Auth app_metadata roles open this console. Candidate profile data cannot grant admin rights.</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-key"></i><div><strong>No user API keys</strong><span>Job-board and AI provider configuration belongs in backend environment secrets, never candidate settings.</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-magnifying-glass-chart"></i><div><strong>Provider provenance</strong><span>Search and extension imports should preserve source, host, capture method, and canonical URL.</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-rotate"></i><div><strong>Refresh discipline</strong><span>The console caches metrics briefly and gives operators a manual refresh for current backend state.</span></div></div>' +
        '</div>' +
      '</article>' +
      // Phase A: privacy disclosure panel. Mirrors the backend ADMIN_PRIVACY_CONTROLS
      // constant + ADMIN_ROLES env so the operator can see exactly what this
      // console is permitted to read/export.
      renderOperatorManagement(data) +
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Privacy &amp; access disclosure</span><h2>What this console can see — and cannot</h2></div><span class="chip cyan">Transparency</span></div>' +
        '<p class="admin-copy">Sourced from the backend at request time. Reflects the ADMIN_ROLES env value and the privacy guard constraint on usage_events / usage_sessions metadata.</p>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-users-gear"></i><div><strong>Allowed admin roles (' + allowedRoles.length + ')</strong><span>' +
            chipList(allowedRoles, "blue") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-shield-halved"></i><div><strong>Export scope</strong><span>' + st(exportScope) + '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-eye"></i><div><strong>Telemetry permitted (' + allowedTelemetry.length + ')</strong><span>' +
            chipList(allowedTelemetry, "subtle") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-ban"></i><div><strong>Never exported / inspected (' + excludedContent.length + ')</strong><span>' +
            chipList(excludedContent, "amber") +
          '</span></div></div>' +
        '</div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          '<div class="admin-action-card"><i class="fa-solid fa-database"></i><div><strong>Blocked metadata keys (DB-enforced)</strong><span>' +
            (disallowedKeys.length
              ? '<code class="admin-codelist">' + disallowedKeys.map(st).join(", ") + '</code>'
              : "None reported.") +
          '</span></div></div>' +
          '<div class="admin-action-card"><i class="fa-solid fa-ruler-horizontal"></i><div><strong>Metadata size cap</strong><span>' + st(metadataMaxBytes) + ' bytes per row. Enforced via Postgres check constraint.</span></div></div>' +
        '</div>' +
      '</article>'
    );
  }

  window.CBV2.adminSections.settings = { render: render };
})();
