// Phase D: Funnel analytics section renderer (split from admin.route.js).
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

    const funnel = data.funnel || {};
    const recent = safeArray(data.recentApplications);
    const stale = safeArray(data.staleSaved);
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Saved to applied", (funnel.savedToAppliedRate || 0) + "%", "roles moving into applications", "cyan") +
        renderStat("Interview rate", (funnel.interviewRate || 0) + "%", "tracked records reaching interview", "blue") +
        renderStat("Offer rate", (funnel.offerRate || 0) + "%", "tracked records reaching offer", "green") +
        renderStat("Closed outcomes", (data.totals.rejected || 0) + (data.totals.withdrawn || 0), "rejected or withdrawn", "amber") +
      '</section>' +
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Pipeline shape</span><h2>Application funnel by stage</h2></div><span class="chip violet">Cloud aggregate</span></div>' +
        '<div class="admin-funnel admin-funnel--six">' +
          '<div><strong>' + st(data.totals.saved) + '</strong><span>Saved</span></div>' +
          '<div><strong>' + st(data.totals.applied) + '</strong><span>Applied</span></div>' +
          '<div><strong>' + st(data.totals.interviews) + '</strong><span>Interview</span></div>' +
          '<div><strong>' + st(data.totals.offers) + '</strong><span>Offer</span></div>' +
          '<div><strong>' + st(data.totals.rejected || 0) + '</strong><span>Rejected</span></div>' +
          '<div><strong>' + st(data.totals.withdrawn || 0) + '</strong><span>Withdrawn</span></div>' +
        '</div>' +
      '</article>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Recent movement</span><h2>Latest pipeline records</h2></div><span class="chip cyan">' + st(recent.length) + ' rows</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Company</span><span>Role</span><span>Stage</span><span>Source</span><span>Updated</span></div>' +
            (recent.length ? recent.map(function (app) {
              return '<div class="admin-table-row admin-table-row--five"><span>' + st(app.company) + '</span><span>' + st(app.role) + '</span><span>' + st(app.stage) + '</span><span>' + st(hostLabel(app.sourceHost)) + '</span><span>' + st(formatDateTime(app.updatedAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No recent pipeline activity returned from the admin backend.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Follow-up risk</span><h2>Stale saved roles</h2></div><span class="chip amber">' + st(stale.length) + ' watch</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Company</span><span>Role</span><span>Age</span><span>Updated</span></div>' +
            (stale.length ? stale.map(function (app) {
              return '<div class="admin-table-row admin-table-row--four"><span>' + st(app.company) + '</span><span>' + st(app.role) + '</span><span>' + st((app.ageDays || 0) + " days") + '</span><span>' + st(formatDateTime(app.updatedAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No stale saved roles in the latest admin sample.</p>') +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  window.CBV2.adminSections.funnel = { render: render };
})();
