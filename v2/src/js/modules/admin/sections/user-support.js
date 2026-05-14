// Phase D: User support section renderer (split from admin.route.js).
// Reads paginated state from helpers.adminUsersRemote (Phase B.1).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const formatDateTime = h.formatDateTime;
    const supportTone = h.supportTone;
    const adminUsersRemote = h.adminUsersRemote;

    // Phase B.1: prefer the paginated admin-users response when loaded.
    // Falls back to the top-25 snapshot from admin-overview when the lazy
    // fetch hasn't completed yet (first navigation, or during a refresh).
    const paginated = adminUsersRemote.data && adminUsersRemote.data.ok !== false
      ? adminUsersRemote.data
      : null;
    const support = data.support || {};
    const summary = paginated ? (paginated.summary || {}) : (support.summary || {});
    const queues  = paginated ? (paginated.queues  || {}) : (support.queues  || {});
    const accounts = paginated
      ? safeArray(paginated.accounts)
      : safeArray(support.accounts);
    const playbooks = paginated
      ? safeArray(paginated.playbooks)
      : safeArray(support.playbooks);
    const privacyNote = paginated
      ? (paginated.privacy || support.privacy || "Support health excludes candidate document body text.")
      : (support.privacy || "Support health excludes candidate document body text.");

    // Pagination metadata
    const pageMeta = paginated && paginated.page ? paginated.page : null;
    const currentPage = pageMeta ? Number(pageMeta.page) : 1;
    const totalPages  = pageMeta ? Number(pageMeta.totalPages) : 1;
    const totalRows   = pageMeta ? Number(pageMeta.total)   : accounts.length;
    const perPage     = pageMeta ? Number(pageMeta.perPage) : accounts.length;
    const sortMode    = pageMeta ? String(pageMeta.sort || adminUsersRemote.sort)     : adminUsersRemote.sort;
    const filterText  = pageMeta ? String(pageMeta.filter || "") : adminUsersRemote.filter;
    const hasNext     = pageMeta ? Boolean(pageMeta.hasNext) : false;
    const hasPrev     = pageMeta ? Boolean(pageMeta.hasPrev) : false;

    const sourceLabel = paginated
      ? "Paginated · " + (adminUsersRemote.status === "refreshing" ? "refreshing" : ("page " + currentPage + " of " + totalPages))
      : (adminUsersRemote.status === "loading" || adminUsersRemote.status === "refreshing"
         ? "Loading paginated view…"
         : "Top-25 snapshot");
    const sourceTone = paginated
      ? "blue"
      : (adminUsersRemote.status === "loading" || adminUsersRemote.status === "refreshing"
         ? "cyan"
         : "amber");

    // Sort dropdown options
    const sortOptions = [
      { value: "health",   label: "Health (lowest first)" },
      { value: "activity", label: "Recent activity" },
      { value: "created",  label: "Newest signups" },
      { value: "pipeline", label: "Pipeline size" },
    ];
    const sortOptionsHtml = sortOptions.map(function (opt) {
      const sel = opt.value === sortMode ? " selected" : "";
      return '<option value="' + st(opt.value) + '"' + sel + '>' + st(opt.label) + '</option>';
    }).join("");

    const errorBanner = adminUsersRemote.status === "error"
      ? '<p class="admin-copy admin-error-banner"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(adminUsersRemote.error || "Paginated users fetch failed.") + '</p>'
      : "";

    const toolbar = paginated
      ? (
        '<div class="admin-users-toolbar" role="toolbar" aria-label="User support pagination">' +
          '<label class="admin-users-filter">' +
            '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>' +
            '<input type="search" id="admin-users-filter" placeholder="Filter by email, role, or stage" value="' + st(filterText) + '" autocomplete="off" />' +
          '</label>' +
          '<label class="admin-users-sort">' +
            '<span class="admin-users-sort-label">Sort</span>' +
            '<select id="admin-users-sort">' + sortOptionsHtml + '</select>' +
          '</label>' +
          '<div class="admin-users-pager">' +
            '<button type="button" class="btn-ghost btn-sm" id="admin-users-prev"' + (hasPrev ? "" : " disabled") + ' title="Previous page"><i class="fa-solid fa-chevron-left"></i></button>' +
            '<span class="admin-users-pager-status">Page ' + st(currentPage) + ' of ' + st(totalPages) + ' · ' + st(totalRows) + ' user' + (totalRows === 1 ? "" : "s") + ' · ' + st(perPage) + '/page</span>' +
            '<button type="button" class="btn-ghost btn-sm" id="admin-users-next"' + (hasNext ? "" : " disabled") + ' title="Next page"><i class="fa-solid fa-chevron-right"></i></button>' +
          '</div>' +
        '</div>'
      )
      : "";

    return (
      '<section class="admin-stat-grid">' +
        renderStat("At-risk accounts", summary.atRisk || queues.atRisk || 0, "health below support threshold", (summary.atRisk || queues.atRisk) ? "amber" : "green") +
        renderStat("Average health", (summary.averageHealth || 0) + "%", "metadata-only account readiness", supportTone(summary.averageHealth)) +
        renderStat("Onboarding", queues.onboarding || 0, "users still in setup", queues.onboarding ? "amber" : "green") +
        renderStat("No job captured", queues.jobCaptureNeeded || 0, "users without a saved/tracked role", queues.jobCaptureNeeded ? "amber" : "cyan") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>User support</span><h2>Account health queue</h2></div><span class="chip ' + st(sourceTone) + '">' + st(sourceLabel) + '</span></div>' +
          toolbar +
          errorBanner +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--support admin-table-head"><span>User</span><span>Health</span><span>Stage</span><span>Blockers</span><span>Recommended action</span><span>Last activity</span></div>' +
            (accounts.length ? accounts.map(function (account) {
              const blockers = Array.isArray(account.blockers) && account.blockers.length ? account.blockers.join(", ") : "No blocker";
              return '<div class="admin-table-row admin-table-row--support"><span>' + st(account.email || "No email") + '</span><span><b class="admin-health-pill admin-health-pill--' + st(supportTone(account.health)) + '">' + st(account.health || 0) + '%</b></span><span>' + st(account.stage || "unknown") + '</span><span>' + st(blockers) + '</span><span>' + st(account.recommendedAction || "") + '</span><span>' + st(formatDateTime(account.lastActivityAt)) + '</span></div>';
            }).join("") : '<p class="admin-copy">' + (adminUsersRemote.status === "loading" ? "Loading account health queue…" : "No support account rows returned yet. Refresh after deploying the admin-overview function.") + '</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Support queues</span><h2>Where candidates get stuck</h2></div><span class="chip cyan">Privacy-safe</span></div>' +
          '<div class="admin-support-queue">' +
            '<span><strong>' + st(queues.onboarding || queues.resumeNeeded || 0) + '</strong><em>' + (paginated ? "Onboarding" : "Resume needed") + '</em></span>' +
            '<span><strong>' + st(queues.jobCaptureNeeded || 0) + '</strong><em>Need first job</em></span>' +
            '<span><strong>' + st(queues.savedOnly || 0) + '</strong><em>Saved only</em></span>' +
            '<span><strong>' + st(queues.inactive || 0) + '</strong><em>Inactive</em></span>' +
            '<span><strong>' + st(queues.aiIssue || 0) + '</strong><em>AI issue</em></span>' +
          '</div>' +
          '<p class="admin-copy">' + st(privacyNote) + '</p>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Support playbooks</span><h2>What operators should do</h2></div><span class="chip green">Read-only guidance</span></div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          (playbooks.length ? playbooks.map(function (book) {
            return '<div class="admin-action-card"><i class="fa-solid fa-user-check"></i><div><strong>' + st(book.title || "Support playbook") + '</strong><span>' + st(book.action || "") + '</span></div></div>';
          }).join("") : '<p class="admin-copy">Support playbooks will appear after the backend returns Phase 7 telemetry.</p>') +
        '</div>' +
      '</article>'
    );
  }

  window.CBV2.adminSections["user-support"] = { render: render };
})();
