// Phase D: User accounts section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const formatDateTime = h.formatDateTime;

    const users = data.userStats || {};
    const rows = Array.isArray(users.latest) ? users.latest : [];
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Total users", users.total || data.totals.users || 0, (users.newLast30 || 0) + " new in 30 days", "green") +
        renderStat("Active users", users.activeLast7 || 0, "signed in during last 7 days", "cyan") +
        renderStat("Admin operators", users.admins || 0, "protected app_metadata roles", "blue") +
        renderStat("Profiles", data.totals.profiles || 0, "candidate records created", "violet") +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Supabase Auth</span><h2>Recent user accounts</h2></div><span class="chip green">Admin-only</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--six admin-table-head"><span>Email</span><span>Role</span><span>Pipeline</span><span>Saved jobs</span><span>AI calls</span><span>Last activity</span></div>' +
          (rows.length ? rows.map(function (user) {
            const roles = Array.isArray(user.roles) && user.roles.length ? user.roles.join(", ") : "candidate";
            return '<div class="admin-table-row admin-table-row--six"><span>' + st(user.email || "No email") + '</span><span>' + st(roles) + '</span><span>' + st(user.pipelineCount || 0) + '</span><span>' + st(user.savedJobCount || 0) + '</span><span>' + st(user.aiRequests || 0) + '</span><span>' + st(formatDateTime(user.lastActivityAt || user.lastSignInAt || user.createdAt)) + '</span></div>';
          }).join("") : '<p class="admin-copy">No cloud user rows returned yet. Refresh after deploying the admin-overview function.</p>') +
        '</div>' +
      '</article>'
    );
  }

  window.CBV2.adminSections.users = { render: render };
})();
