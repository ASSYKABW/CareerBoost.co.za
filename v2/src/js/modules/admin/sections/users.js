// Phase E3: Consolidated Users board.
//
// Replaces both the old "users" (anonymous KPI grid) and "user-support"
// (paginated table + queues) sections. One board, three layers:
//
//   1. Segment cards — power / new / at-risk / churned / active with
//      narrative + recommended action per segment.
//   2. Paginated account health queue (same pagination/sort/filter as
//      Phase B.1 user-support, plus an active-segment chip filter).
//   3. Inline expand row → per-user timeline drawer (admin-user-timeline
//      RPC). Profile + attribution + applications + outcomes + sessions.
//
// Mass actions (re-engagement campaigns) are stubbed as buttons that
// route to a "Coming in Phase E3.5" placeholder. The segment counts
// are already real, so the operator gets the value of the segmentation
// while we build the campaign delivery infrastructure.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  function renderSegmentCards(userSegments, activeSegment, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    if (!userSegments || !Array.isArray(userSegments.cards)) {
      return (
        '<section class="admin-stat-grid admin-stat-grid--segments">' +
          '<article class="admin-stat admin-stat--cyan"><span>Loading segments</span><strong class="num-font">—</strong><small>Segment classification will appear after the admin-overview function returns userSegments.</small></article>' +
        '</section>'
      );
    }
    return (
      '<section class="admin-segment-grid">' +
        safeArray(userSegments.cards).map(function (card) {
          const isActive = card.id === activeSegment;
          return (
            '<button type="button" class="admin-segment-card admin-segment-card--' + st(card.tone || "cyan") + (isActive ? " is-active" : "") + '" data-admin-segment="' + st(card.id) + '">' +
              '<header class="admin-segment-card-head">' +
                '<i class="fa-solid ' + st(card.icon || "fa-user") + '" aria-hidden="true"></i>' +
                '<span>' + st(card.label) + '</span>' +
                '<strong class="num-font">' + st(card.count || 0) + '</strong>' +
              '</header>' +
              '<p>' + st(card.narrative || "") + '</p>' +
              '<em class="admin-segment-card-action">' + st(card.action || "") + '</em>' +
              (isActive ? '<span class="admin-segment-card-active"><i class="fa-solid fa-filter"></i> Filtering table</span>' : '') +
            '</button>'
          );
        }).join("") +
      '</section>'
    );
  }

  function renderSupportTable(data, activeSegment, h) {
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const formatDateTime = h.formatDateTime;
    const supportTone = h.supportTone;
    const adminUsersRemote = h.adminUsersRemote;
    const adminUserTimelineRemote = h.adminUserTimelineRemote;

    const paginated = adminUsersRemote.data && adminUsersRemote.data.ok !== false
      ? adminUsersRemote.data
      : null;
    const support = data.support || {};
    const summary = paginated ? (paginated.summary || {}) : (support.summary || {});
    const queues  = paginated ? (paginated.queues  || {}) : (support.queues  || {});
    const accountsRaw = paginated ? safeArray(paginated.accounts) : safeArray(support.accounts);

    // Phase E3: client-side segment filter on the paginated rows. The
    // backend doesn't yet filter by segment, so the segment chip narrows
    // the visible rows from the current page. Acceptable for the first
    // cut; we'll push this server-side when traffic warrants.
    const accounts = activeSegment
      ? accountsRaw.filter(function (acc) {
          // accounts from admin-users don't always have a segment field;
          // fall back to deriving from health + activity.
          const seg = acc.segment || (function () {
            const health = Number(acc.health || 0);
            const stage = String(acc.stage || "").toLowerCase();
            if (health >= 75 && (acc.placementCount || 0) > 0) return "power";
            if (stage.indexOf("onboarding") >= 0 || acc.isNew) return "new";
            if (health < 55) return "at_risk";
            if (acc.inactiveDays && acc.inactiveDays > 30) return "churned";
            return "active";
          })();
          return seg === activeSegment;
        })
      : accountsRaw;

    const playbooks = paginated
      ? safeArray(paginated.playbooks)
      : safeArray(support.playbooks);
    const privacyNote = paginated
      ? (paginated.privacy || support.privacy || "Support health excludes candidate document body text.")
      : (support.privacy || "Support health excludes candidate document body text.");

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
    const sourceTone = paginated ? "blue" : (adminUsersRemote.status === "loading" ? "cyan" : "amber");

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

    const segmentNote = activeSegment
      ? '<p class="admin-copy admin-copy--small"><i class="fa-solid fa-filter"></i> Showing <strong>' + st(activeSegment) + '</strong> segment from page ' + st(currentPage) + '. <button type="button" class="btn-ghost btn-sm" data-admin-segment-clear="1">Clear filter</button></p>'
      : "";

    const toolbar = paginated
      ? (
        '<div class="admin-users-toolbar" role="toolbar" aria-label="Users pagination">' +
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
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Account health queue</span><h2>Who needs attention</h2></div><span class="chip ' + st(sourceTone) + '">' + st(sourceLabel) + '</span></div>' +
        toolbar +
        segmentNote +
        errorBanner +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--user-board admin-table-head"><span>User</span><span>Health</span><span>Stage</span><span>Blockers</span><span>Recommended action</span><span>Last activity</span><span></span></div>' +
          (accounts.length ? accounts.map(function (account) {
            const blockers = Array.isArray(account.blockers) && account.blockers.length ? account.blockers.join(", ") : "No blocker";
            const isOpen = adminUserTimelineRemote.activeUserId === account.userId || adminUserTimelineRemote.activeUserId === account.id;
            const ownerId = account.userId || account.id || "";
            const expandBtn = ownerId
              ? '<button type="button" class="btn-ghost btn-sm" data-admin-user-expand="' + st(ownerId) + '" data-admin-user-email="' + st(account.email || "") + '" title="View timeline">' +
                  '<i class="fa-solid ' + (isOpen ? "fa-chevron-up" : "fa-chevron-down") + '"></i>' +
                '</button>'
              : '';
            return (
              '<div class="admin-table-row admin-table-row--user-board' + (isOpen ? " is-expanded" : "") + '">' +
                '<span>' + st(account.email || "No email") + '</span>' +
                '<span><b class="admin-health-pill admin-health-pill--' + st(supportTone(account.health)) + '">' + st(account.health || 0) + '%</b></span>' +
                '<span>' + st(account.stage || "unknown") + '</span>' +
                '<span>' + st(blockers) + '</span>' +
                '<span>' + st(account.recommendedAction || "") + '</span>' +
                '<span>' + st(formatDateTime(account.lastActivityAt)) + '</span>' +
                '<span class="admin-table-cell--actions">' + expandBtn + '</span>' +
              '</div>' +
              (isOpen ? renderTimelineDrawer(h) : "")
            );
          }).join("") : '<p class="admin-copy">' + (adminUsersRemote.status === "loading" ? "Loading account health queue…" : "No support account rows returned yet. Refresh after deploying the admin-overview function.") + '</p>') +
        '</div>' +
        '<p class="admin-copy admin-copy--small">' + st(privacyNote) + '</p>' +
      '</article>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Support playbooks</span><h2>What operators should do</h2></div><span class="chip green">Read-only guidance</span></div>' +
        '<div class="admin-action-list admin-action-list--grid">' +
          (playbooks.length ? playbooks.map(function (book) {
            return '<div class="admin-action-card"><i class="fa-solid fa-user-check"></i><div><strong>' + st(book.title || "Support playbook") + '</strong><span>' + st(book.action || "") + '</span></div></div>';
          }).join("") : '<p class="admin-copy">Support playbooks will appear after the backend returns telemetry.</p>') +
        '</div>' +
      '</article>'
    );
  }

  // Per-user expanded drawer. Renders inline below the table row when
  // adminUserTimelineRemote.activeUserId matches.
  function renderTimelineDrawer(h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const formatDateTime = h.formatDateTime;
    const formatDuration = h.formatDuration;
    const op = h.adminUserTimelineRemote;

    if (op.status === "loading") {
      return '<div class="admin-user-drawer"><p class="admin-copy"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading timeline for ' + st(op.activeUserEmail || "user") + '…</p></div>';
    }
    if (op.status === "error") {
      return '<div class="admin-user-drawer admin-user-drawer--error"><p class="admin-copy"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(op.error) + '</p></div>';
    }
    const tl = op.data || {};
    const profile = tl.profile || {};
    const counts = tl.counts || {};
    const applications = safeArray(tl.applications);
    const outcomes = safeArray(tl.outcomes);
    const sessions = safeArray(tl.recent_sessions);

    return (
      '<div class="admin-user-drawer">' +
        '<header class="admin-user-drawer-head">' +
          '<div><strong>' + st(profile.email || op.activeUserEmail || "User") + '</strong><span>' +
            (profile.country_code ? st(profile.country_code) + ' · ' : '') +
            (profile.utm_source ? st(profile.utm_source) + ' · ' : 'direct · ') +
            'joined ' + st(formatDateTime(profile.signup_at || profile.created_at)) +
          '</span></div>' +
          '<button type="button" class="btn-ghost btn-sm" data-admin-user-close="1"><i class="fa-solid fa-xmark"></i> Close</button>' +
        '</header>' +
        '<div class="admin-user-drawer-stats">' +
          '<span><strong>' + st(counts.applications || 0) + '</strong><em>applications</em></span>' +
          '<span><strong>' + st(counts.saved_jobs || 0) + '</strong><em>saved jobs</em></span>' +
          '<span><strong>' + st(counts.placements || 0) + '</strong><em>placements</em></span>' +
          '<span><strong>' + st(counts.ai_calls_30d || 0) + '</strong><em>AI calls (30d)</em></span>' +
          '<span><strong>' + st(counts.sessions_30d || 0) + '</strong><em>sessions (30d)</em></span>' +
        '</div>' +
        '<div class="admin-user-drawer-grid">' +
          '<section class="admin-user-drawer-section">' +
            '<h4><i class="fa-solid fa-briefcase"></i> Recent applications</h4>' +
            (applications.length
              ? '<ul>' + applications.map(function (a) {
                  return '<li><strong>' + st(a.company || "Company") + '</strong> · <em>' + st(a.role || "Role") + '</em><span class="chip ' + (a.stage === "interview" ? "blue" : a.stage === "offer" ? "green" : "subtle") + '">' + st(a.stage || "saved") + '</span><time>' + st(formatDateTime(a.updated_at)) + '</time></li>';
                }).join("") + '</ul>'
              : '<p class="admin-copy">No applications yet.</p>') +
          '</section>' +
          '<section class="admin-user-drawer-section">' +
            '<h4><i class="fa-solid fa-trophy"></i> Placement milestones</h4>' +
            (outcomes.length
              ? '<ul>' + outcomes.map(function (o) {
                  return '<li><strong>' + st(o.outcome_type) + '</strong> · ' + st(o.company || "—") + ' · <em>' + st(o.role || "—") + '</em>' +
                    (o.source_channel ? ' · <span class="chip subtle">' + st(o.source_channel) + '</span>' : '') +
                    '<time>' + st(formatDateTime(o.occurred_at)) + '</time></li>';
                }).join("") + '</ul>'
              : '<p class="admin-copy">No interview or offer milestones yet.</p>') +
          '</section>' +
          '<section class="admin-user-drawer-section">' +
            '<h4><i class="fa-solid fa-bullhorn"></i> Acquisition</h4>' +
            '<ul class="admin-user-drawer-kv">' +
              '<li><span>Source</span><strong>' + st(profile.utm_source || "direct") + '</strong></li>' +
              '<li><span>Medium</span><strong>' + st(profile.utm_medium || "—") + '</strong></li>' +
              '<li><span>Campaign</span><strong>' + st(profile.utm_campaign || "—") + '</strong></li>' +
              '<li><span>Referrer</span><strong>' + st(profile.referrer_host || "—") + '</strong></li>' +
              '<li><span>Landing</span><strong>' + st((profile.landing_path || "—").slice(0, 60)) + '</strong></li>' +
              '<li><span>Country</span><strong>' + st(profile.country_code || "—") + '</strong></li>' +
              '<li><span>Plan</span><strong>' + st(profile.plan || "free") + '</strong></li>' +
            '</ul>' +
          '</section>' +
          '<section class="admin-user-drawer-section">' +
            '<h4><i class="fa-solid fa-clock-rotate-left"></i> Recent sessions</h4>' +
            (sessions.length
              ? '<ul>' + sessions.map(function (s) {
                  const mods = Array.isArray(s.modules) && s.modules.length ? s.modules.slice(0, 3).join(", ") : "—";
                  return '<li><strong>' + st(formatDateTime(s.last_activity_at)) + '</strong> · ' + st(formatDuration(s.duration_seconds || 0)) + ' · ' + st(s.route_count || 0) + ' routes<span class="admin-user-drawer-modules">' + st(mods) + '</span></li>';
                }).join("") + '</ul>'
              : '<p class="admin-copy">No recent sessions tracked.</p>') +
          '</section>' +
        '</div>' +
      '</div>'
    );
  }

  function render(data) {
    const h = window.CBV2.adminHelpers;
    const activeSegment = h.adminUserTimelineRemote.activeSegment || "";
    return (
      renderSegmentCards(data.userSegments, activeSegment, h) +
      renderSupportTable(data, activeSegment, h)
    );
  }

  window.CBV2.adminSections.users = { render: render };
  // Phase E3: user-support is now an alias for users (consolidated board).
  // The old section ID still works so legacy links/bookmarks don't 404.
  window.CBV2.adminSections["user-support"] = { render: render };
})();
