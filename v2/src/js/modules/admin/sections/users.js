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
    // A2: the cross-user search field. We read from pageMeta.query (set
    // by the server-side response) and fall back to the in-flight local
    // state, so the input stays in sync after a debounced fetch lands.
    const queryText   = pageMeta && typeof pageMeta.query === "string"
      ? pageMeta.query
      : (adminUsersRemote.query || "");
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

    // A2: search match summary surfaced in the pager status when a query
    // is active — tells the operator how many rows came back for "stripe"
    // (or whatever they typed) and offers a one-click Clear.
    const queryActive = queryText && queryText.length > 0;
    const queryStatus = queryActive
      ? ' · <strong>' + st(String(totalRows)) + ' match' + (totalRows === 1 ? "" : "es") + ' for "' + st(queryText) + '"</strong>'
      : "";
    const clearQueryBtn = queryActive
      ? ' <button type="button" class="btn-ghost btn-sm" id="admin-users-query-clear" title="Clear search"><i class="fa-solid fa-xmark"></i> Clear</button>'
      : "";

    const toolbar = paginated
      ? (
        '<div class="admin-users-toolbar" role="toolbar" aria-label="Users pagination">' +
          '<label class="admin-users-filter admin-users-filter--wide">' +
            '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>' +
            '<input type="search" id="admin-users-query" placeholder="Search by email, name, or company applied to" value="' + st(queryText) + '" autocomplete="off" spellcheck="false" />' +
          '</label>' +
          '<label class="admin-users-sort">' +
            '<span class="admin-users-sort-label">Sort</span>' +
            '<select id="admin-users-sort">' + sortOptionsHtml + '</select>' +
          '</label>' +
          '<div class="admin-users-pager">' +
            '<button type="button" class="btn-ghost btn-sm" id="admin-users-prev"' + (hasPrev ? "" : " disabled") + ' title="Previous page"><i class="fa-solid fa-chevron-left"></i></button>' +
            '<span class="admin-users-pager-status">Page ' + st(currentPage) + ' of ' + st(totalPages) + ' · ' + st(totalRows) + ' user' + (totalRows === 1 ? "" : "s") + ' · ' + st(perPage) + '/page' + queryStatus + clearQueryBtn + '</span>' +
            '<button type="button" class="btn-ghost btn-sm" id="admin-users-next"' + (hasNext ? "" : " disabled") + ' title="Next page"><i class="fa-solid fa-chevron-right"></i></button>' +
          '</div>' +
        '</div>'
      )
      : "";

    // A4: bulk selection state lives on adminUsersRemote.selected as
    // userId -> { email, fullName }. The toolbar appears above the table
    // when ≥1 user is selected. Per-row checkboxes drive add/remove;
    // header checkbox toggles all visible rows.
    const selectedMap = (adminUsersRemote.selected && typeof adminUsersRemote.selected === "object") ? adminUsersRemote.selected : {};
    const selectedIds = Object.keys(selectedMap);
    const bulkState = adminUsersRemote.bulk || {};
    const bulkToolbar = renderBulkToolbar(selectedIds, selectedMap, bulkState, st);

    // Compute "select all visible" state — checked when every row on the
    // current page is selected, indeterminate when some are.
    const visibleIds = accounts.map(function (a) { return a.userId || a.id || ""; }).filter(Boolean);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(function (id) { return !!selectedMap[id]; });
    const someVisibleSelected = !allVisibleSelected && visibleIds.some(function (id) { return !!selectedMap[id]; });
    const headerCheckAttrs = allVisibleSelected
      ? ' checked'
      : (someVisibleSelected ? ' data-indeterminate="1"' : '');

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
        bulkToolbar +
        segmentNote +
        errorBanner +
        '<div class="admin-table admin-table--bulk">' +
          '<div class="admin-table-row admin-table-row--user-board admin-table-head">' +
            '<span class="admin-users-cell-check"><input type="checkbox" id="admin-users-select-all" aria-label="Select all visible users"' + headerCheckAttrs + ' /></span>' +
            '<span>User</span><span>Health</span><span>Stage</span><span>Blockers</span><span>Recommended action</span><span>Last activity</span><span></span>' +
          '</div>' +
          (accounts.length ? accounts.map(function (account) {
            const blockers = Array.isArray(account.blockers) && account.blockers.length ? account.blockers.join(", ") : "No blocker";
            const isOpen = adminUserTimelineRemote.activeUserId === account.userId || adminUserTimelineRemote.activeUserId === account.id;
            const ownerId = account.userId || account.id || "";
            const expandBtn = ownerId
              ? '<button type="button" class="btn-ghost btn-sm" data-admin-user-expand="' + st(ownerId) + '" data-admin-user-email="' + st(account.email || "") + '" title="View timeline">' +
                  '<i class="fa-solid ' + (isOpen ? "fa-chevron-up" : "fa-chevron-down") + '"></i>' +
                '</button>'
              : '';
            // A2: surface full name on the row + matched-on chips when this
            // row came from a search. Name lives above the email so the
            // operator scans "Jane Smith" first, email second. Chips show
            // WHY this row matched ("company: Stripe, Acme") so the operator
            // doesn't have to guess.
            const fullName = String(account.fullName || "").trim();
            const matchedTags = Array.isArray(account.matchedOn) ? account.matchedOn : [];
            const matchedHtml = matchedTags.length
              ? '<div class="admin-users-matched">' + matchedTags.map(function (tag) {
                  const tone = String(tag).indexOf("company") === 0 ? "blue" : (String(tag) === "name" ? "violet" : "cyan");
                  return '<span class="chip ' + tone + '">' + st(tag) + '</span>';
                }).join("") + '</div>'
              : "";
            const userCell = fullName
              ? '<strong>' + st(fullName) + '</strong><small class="admin-users-email">' + st(account.email || "No email") + '</small>' + matchedHtml
              : st(account.email || "No email") + matchedHtml;
            // A4: per-row checkbox. data-* carries the userId + email +
            // fullName so the row-level handler can hydrate selected[]
            // without a follow-up RPC call.
            const isSelected = !!selectedMap[ownerId];
            const rowCheckHtml = ownerId
              ? '<input type="checkbox" class="admin-users-row-check" data-admin-user-select="' + st(ownerId) + '"' +
                ' data-admin-user-select-email="' + st(account.email || "") + '"' +
                ' data-admin-user-select-name="' + st(fullName) + '"' +
                ' aria-label="Select user"' + (isSelected ? " checked" : "") + ' />'
              : '';
            return (
              '<div class="admin-table-row admin-table-row--user-board' + (isOpen ? " is-expanded" : "") + (isSelected ? " is-selected" : "") + '">' +
                '<span class="admin-users-cell-check">' + rowCheckHtml + '</span>' +
                '<span class="admin-users-cell-user">' + userCell + '</span>' +
                '<span><b class="admin-health-pill admin-health-pill--' + st(supportTone(account.health)) + '">' + st(account.health || 0) + '%</b></span>' +
                '<span>' + st(account.stage || "unknown") + '</span>' +
                '<span>' + st(blockers) + '</span>' +
                '<span>' + st(account.recommendedAction || "") + '</span>' +
                '<span>' + st(formatDateTime(account.lastActivityAt)) + '</span>' +
                '<span class="admin-table-cell--actions">' + expandBtn + '</span>' +
              '</div>' +
              (isOpen ? renderTimelineDrawer(h) : "")
            );
          }).join("") : '<p class="admin-copy">' + (adminUsersRemote.status === "loading" ? "Loading account health queue…" : (queryActive ? 'No users match "' + st(queryText) + '".' : "No support account rows returned yet. Refresh after deploying the admin-overview function.")) + '</p>') +
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
  //
  // A1 expansion: now also surfaces AI spend (30d + lifetime), per-skill
  // usage breakdown, and the last 10 AI calls (with status, latency, error
  // text). This is what makes the drawer "operational" rather than "look
  // at the user" — an operator can answer "how much is this user costing
  // me?" and "what did they do right before the bug?" without SQL access.
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
    const aiSpend = tl.ai_spend || {};
    const aiUsage30d = (tl.ai_usage_30d && typeof tl.ai_usage_30d === "object") ? tl.ai_usage_30d : {};
    const recentAiCalls = safeArray(tl.recent_ai_calls);
    // A3: new fields from migration 0018's extended admin_user_timeline
    // RPC. subscription drives the plan chip, usage_counters is the
    // current-period quota tally (so the operator sees what they're
    // about to bump), admin_actions feeds the "Recent admin actions"
    // log at the bottom of the drawer.
    const subscription = (tl.subscription && typeof tl.subscription === "object") ? tl.subscription : {};
    const usageCounters = (tl.usage_counters && typeof tl.usage_counters === "object") ? tl.usage_counters : {};
    const adminActions = safeArray(tl.admin_actions);

    // Compact USD formatter — sub-cent values still readable, $X.XX for
    // anything > $1, $0.0123 with 4 decimals below that.
    const usd = function (n) {
      const v = Number(n || 0);
      if (!isFinite(v) || v === 0) return "$0";
      if (v >= 100) return "$" + v.toFixed(0);
      if (v >= 1)   return "$" + v.toFixed(2);
      return "$" + v.toFixed(4);
    };
    const aiSpend30 = usd(aiSpend["30d"]);
    const aiSpendLifetime = usd(aiSpend.lifetime);

    // Sort skills by 30d cost descending — biggest line items at the top
    // so cost outliers jump out immediately.
    const skillRows = Object.keys(aiUsage30d)
      .map(function (skill) {
        const row = aiUsage30d[skill] || {};
        return {
          skill: skill,
          count: Number(row.count) || 0,
          cost: Number(row.cost_usd) || 0,
          failed: Number(row.failed) || 0
        };
      })
      .sort(function (a, b) { return b.cost - a.cost; })
      .slice(0, 8);

    // Identity bullets — onboarding + last sign-in + age. Augments the
    // existing Acquisition kv card so the operator sees "is this user
    // engaged or dormant?" at a glance.
    const ageDays = Number(profile.account_age_days);
    const signinDays = profile.days_since_signin == null ? null : Number(profile.days_since_signin);
    const ageStr = isFinite(ageDays) ? (ageDays + " day" + (ageDays === 1 ? "" : "s") + " old") : "—";
    const signinStr = signinDays == null
      ? "never"
      : (signinDays === 0 ? "today" : (signinDays + " day" + (signinDays === 1 ? "" : "s") + " ago"));
    const onboardChip = profile.onboarding_completed
      ? '<span class="chip green">Onboarded</span>'
      : '<span class="chip warning">Onboarding incomplete</span>';

    return (
      '<div class="admin-user-drawer">' +
        '<header class="admin-user-drawer-head">' +
          '<div><strong>' + st(profile.email || op.activeUserEmail || "User") + '</strong><span>' +
            (profile.country_code ? st(profile.country_code) + ' · ' : '') +
            (profile.utm_source ? st(profile.utm_source) + ' · ' : 'direct · ') +
            'joined ' + st(formatDateTime(profile.signup_at || profile.created_at)) + ' · ' +
            st(ageStr) +
          '</span></div>' +
          '<div class="admin-user-drawer-head-chips">' +
            onboardChip +
            '<button type="button" class="btn-ghost btn-sm" data-admin-user-close="1"><i class="fa-solid fa-xmark"></i> Close</button>' +
          '</div>' +
        '</header>' +
        '<div class="admin-user-drawer-stats">' +
          '<span><strong>' + st(counts.applications || 0) + '</strong><em>applications</em></span>' +
          '<span><strong>' + st(counts.saved_jobs || 0) + '</strong><em>saved jobs</em></span>' +
          '<span><strong>' + st(counts.placements || 0) + '</strong><em>placements</em></span>' +
          '<span><strong>' + st(counts.ai_calls_30d || 0) + '</strong><em>AI calls (30d)</em></span>' +
          '<span><strong>' + st(aiSpend30) + '</strong><em>AI spend (30d)</em></span>' +
          '<span><strong>' + st(aiSpendLifetime) + '</strong><em>AI spend (lifetime)</em></span>' +
          '<span><strong>' + st(counts.sessions_30d || 0) + '</strong><em>sessions (30d)</em></span>' +
          '<span><strong>' + st(signinStr) + '</strong><em>last sign-in</em></span>' +
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
            '<h4><i class="fa-solid fa-bullhorn"></i> Acquisition &amp; identity</h4>' +
            '<ul class="admin-user-drawer-kv">' +
              '<li><span>Source</span><strong>' + st(profile.utm_source || "direct") + '</strong></li>' +
              '<li><span>Medium</span><strong>' + st(profile.utm_medium || "—") + '</strong></li>' +
              '<li><span>Campaign</span><strong>' + st(profile.utm_campaign || "—") + '</strong></li>' +
              '<li><span>Referrer</span><strong>' + st(profile.referrer_host || "—") + '</strong></li>' +
              '<li><span>Landing</span><strong>' + st((profile.landing_path || "—").slice(0, 60)) + '</strong></li>' +
              '<li><span>Country</span><strong>' + st(profile.country_code || "—") + '</strong></li>' +
              '<li><span>Plan</span><strong>' + st(profile.plan || "free") + '</strong></li>' +
              '<li><span>Name</span><strong>' + st(profile.full_name || "—") + '</strong></li>' +
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
          '<section class="admin-user-drawer-section">' +
            '<h4><i class="fa-solid fa-coins"></i> AI usage by skill (30d)</h4>' +
            (skillRows.length
              ? '<table class="admin-user-drawer-table"><thead><tr><th>Skill</th><th>Calls</th><th>Cost</th><th>Failed</th></tr></thead>' +
                '<tbody>' + skillRows.map(function (s) {
                  const failChip = s.failed > 0
                    ? '<span class="chip ' + (s.failed >= s.count / 2 ? "warning" : "amber") + '">' + s.failed + '</span>'
                    : '<span class="chip subtle">0</span>';
                  return '<tr><td>' + st(s.skill) + '</td><td>' + s.count + '</td><td>' + st(usd(s.cost)) + '</td><td>' + failChip + '</td></tr>';
                }).join("") + '</tbody></table>'
              : '<p class="admin-copy">No AI activity in the last 30 days.</p>') +
          '</section>' +
          '<section class="admin-user-drawer-section">' +
            '<h4><i class="fa-solid fa-list-check"></i> Recent AI calls</h4>' +
            (recentAiCalls.length
              ? '<ul class="admin-user-drawer-ai-log">' + recentAiCalls.slice(0, 10).map(function (c) {
                  const okChip = c.status === "failed"
                    ? '<span class="chip warning">FAILED</span>'
                    : '<span class="chip subtle">ok</span>';
                  const cache = c.cache_hit ? ' · <span class="chip subtle">cache</span>' : '';
                  const latency = c.latency_ms ? ' · ' + Number(c.latency_ms) + 'ms' : '';
                  const errorRow = c.error
                    ? '<small class="admin-user-drawer-error">' + st(String(c.error).slice(0, 220)) + '</small>'
                    : '';
                  return '<li>' +
                    '<div>' + okChip +
                      ' <strong>' + st(c.skill || "?") + '</strong>' +
                      ' · ' + st(c.provider || "?") +
                      ' · ' + st(usd(c.cost_usd)) +
                      latency + cache +
                      ' <time>' + st(formatDateTime(c.created_at)) + '</time>' +
                    '</div>' +
                    errorRow +
                  '</li>';
                }).join("") + '</ul>'
              : '<p class="admin-copy">No AI calls recorded for this user.</p>') +
          '</section>' +
          renderManageAccountSection(h, profile, subscription, usageCounters) +
          renderRecentAdminActions(h, adminActions) +
        '</div>' +
      '</div>'
    );
  }

  // A3: Manage account — quota grants, full reset, plan change, free-text
  // note. Every action passes through admin-user-adjust which writes to
  // admin_audit_log so there's a paper trail. Self-target safeguards are
  // enforced server-side; UI just shows the buttons.
  //
  // Layout: subscription + counters strip on top (so the operator sees
  // current state before mutating it), four action buttons below. The
  // shared mutationBusy flag spins the button currently in flight; other
  // buttons disable so the operator can't fire two RPCs concurrently.
  function renderManageAccountSection(h, profile, subscription, usageCounters) {
    const st = h.st;
    const op = h.adminUserTimelineRemote;
    const userId = profile.id || profile.user_id || op.activeUserId || "";
    const email = profile.email || op.activeUserEmail || "";

    const planId = subscription.plan_id || profile.plan || "free";
    const planStatus = subscription.status || "—";
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
      : "—";
    const cancelChip = subscription.cancel_at
      ? '<span class="chip warning" title="' + st(subscription.cancel_at) + '">cancels ' + st(new Date(subscription.cancel_at).toLocaleDateString([], { month: "short", day: "numeric" })) + '</span>'
      : '';

    // Quota counters — the current period tally. Higher counters = more
    // usage this billing month. Five canonical quota keys mirror the RPC.
    const counterKeys = [
      { key: "ai_resumes",        label: "Resumes" },
      { key: "ai_covers",         label: "Cover letters" },
      { key: "ai_mocks",          label: "Mock interviews" },
      { key: "ai_research",       label: "Research" },
      { key: "ai_question_banks", label: "Question banks" }
    ];
    const countersHtml = '<div class="admin-user-drawer-counters">' +
      counterKeys.map(function (k) {
        const v = Number(usageCounters[k.key] || 0);
        return '<span><strong>' + st(String(v)) + '</strong><em>' + st(k.label) + '</em></span>';
      }).join("") +
    '</div>';

    const mutationBusy = op.mutationBusy;
    const mutationAction = op.mutationAction || "";
    const mutationError = op.mutationError || "";
    const spin = ' <i class="fa-solid fa-circle-notch fa-spin"></i>';
    const btn = function (action, icon, label, tone) {
      const isActive = mutationBusy && mutationAction === action;
      const disabled = mutationBusy ? " disabled" : "";
      const toneClass = tone ? " btn-" + tone : "";
      return '<button type="button" class="btn-ghost btn-sm admin-user-adjust-btn' + toneClass + '"' +
        ' data-admin-user-adjust="' + st(action) + '"' +
        ' data-admin-user-id="' + st(userId) + '"' +
        ' data-admin-user-email="' + st(email) + '"' +
        disabled + '>' +
        '<i class="fa-solid ' + st(icon) + '"></i> ' + st(label) +
        (isActive ? spin : '') +
      '</button>';
    };

    const errorBanner = mutationError
      ? '<p class="admin-copy admin-error-banner admin-user-adjust-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + st(mutationError) + '</p>'
      : '';

    return (
      '<section class="admin-user-drawer-section admin-user-drawer-section--manage">' +
        '<h4><i class="fa-solid fa-sliders"></i> Manage account</h4>' +
        '<div class="admin-user-drawer-sub">' +
          '<span class="chip blue">Plan: ' + st(planId) + '</span>' +
          '<span class="chip subtle">status: ' + st(planStatus) + '</span>' +
          '<span class="chip subtle">renews ' + st(periodEnd) + '</span>' +
          cancelChip +
        '</div>' +
        '<p class="admin-copy admin-copy--small">Current period quota usage:</p>' +
        countersHtml +
        '<div class="admin-user-adjust-actions">' +
          btn("grant_quota",  "fa-plus",            "Grant quota") +
          btn("reset_quota",  "fa-rotate",          "Reset quota") +
          btn("change_plan",  "fa-arrow-up-right-from-square", "Change plan") +
          btn("add_note",     "fa-note-sticky",     "Add note") +
          // A4: send_email opens a compose modal then a mailto: link.
          // The send is logged to audit but the actual delivery is via
          // the operator's own mail client (so the reply-to is real).
          btn("send_email",   "fa-paper-plane",     "Email user") +
        '</div>' +
        errorBanner +
        '<p class="admin-copy admin-copy--small">All actions are logged to the admin audit trail with your operator email.</p>' +
      '</section>'
    );
  }

  // A3: Recent admin actions — last 10 admin_audit_log rows scoped to
  // THIS user. Shows who did what when, with the actor email so the
  // operator can ping the previous admin if there's a question. Payload
  // gets a compact summary chip per common verb (e.g. "+5 ai_resumes",
  // "plan→pro").
  function renderRecentAdminActions(h, actions) {
    const st = h.st;
    const formatDateTime = h.formatDateTime;
    if (!actions || !actions.length) {
      return (
        '<section class="admin-user-drawer-section admin-user-drawer-section--admin-log">' +
          '<h4><i class="fa-solid fa-clipboard-list"></i> Recent admin actions</h4>' +
          '<p class="admin-copy">No admin actions logged for this user yet.</p>' +
        '</section>'
      );
    }
    return (
      '<section class="admin-user-drawer-section admin-user-drawer-section--admin-log">' +
        '<h4><i class="fa-solid fa-clipboard-list"></i> Recent admin actions</h4>' +
        '<ul class="admin-user-drawer-admin-log">' +
          actions.slice(0, 10).map(function (a) {
            const action = String(a.action || "?");
            const actor = a.admin_email || a.actor_email || "operator";
            const status = String(a.result_status || a.status || "ok").toLowerCase();
            const statusChip = status === "failed"
              ? '<span class="chip warning">FAILED</span>'
              : '<span class="chip subtle">ok</span>';
            const payload = (a.payload && typeof a.payload === "object") ? a.payload : {};
            let summary = "";
            if (action === "grant_quota" && payload.quota) {
              summary = ' <span class="chip blue">+' + st(String(payload.amount || "?")) + ' ' + st(String(payload.quota)) + '</span>';
            } else if (action === "change_plan" && payload.planId) {
              summary = ' <span class="chip blue">plan→' + st(String(payload.planId)) + '</span>';
            } else if (action === "reset_quota") {
              summary = ' <span class="chip subtle">all counters → 0</span>';
            } else if (action === "add_note" && payload.note) {
              summary = '';
            }
            const noteRow = (action === "add_note" && payload.note)
              ? '<small class="admin-user-drawer-note">' + st(String(payload.note).slice(0, 300)) + '</small>'
              : '';
            const errRow = (status === "failed" && (a.error_message || a.error))
              ? '<small class="admin-user-drawer-error">' + st(String(a.error_message || a.error).slice(0, 220)) + '</small>'
              : '';
            // A4 FIX: prefer occurred_at (actual column name from
            // admin_audit_log per 0011) over created_at/at fallbacks.
            return '<li>' +
              '<div>' + statusChip +
                ' <strong>' + st(action) + '</strong>' + summary +
                ' · by ' + st(actor) +
                ' <time>' + st(formatDateTime(a.occurred_at || a.created_at || a.at)) + '</time>' +
              '</div>' +
              noteRow + errRow +
            '</li>';
          }).join("") +
        '</ul>' +
      '</section>'
    );
  }

  // A4: bulk action toolbar — sticky strip above the user table when
  // ≥1 user is selected. Shows count + clear + 3 bulk verbs (Grant /
  // Note / Email). While a bulk run is in flight we replace the verbs
  // with a progress chip + spinner so the operator sees N/Total
  // applied. Bulk runs are capped at 50 users in admin.route.js
  // dispatcher to prevent foot-guns.
  function renderBulkToolbar(selectedIds, selectedMap, bulkState, st) {
    if (!selectedIds.length && !(bulkState && bulkState.busy)) return "";

    if (bulkState && bulkState.busy) {
      const done = Number(bulkState.done || 0);
      const total = Number(bulkState.total || 0);
      const failed = Number(bulkState.failed || 0);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      return (
        '<div class="admin-bulk-toolbar admin-bulk-toolbar--busy" role="status">' +
          '<i class="fa-solid fa-circle-notch fa-spin"></i>' +
          ' <strong>' + st(prettyAction(bulkState.action)) + '</strong>' +
          ' · <span class="num-font">' + done + ' / ' + total + '</span>' +
          ' <i class="admin-bulk-progress" style="--pct:' + pct + '%"></i>' +
          (failed > 0 ? ' · <span class="chip warning">' + failed + ' failed</span>' : '') +
        '</div>'
      );
    }

    const count = selectedIds.length;
    // Sample emails (first 3) so the operator can sanity-check who
    // they're about to act on. Full list appears in each confirm modal.
    const sample = selectedIds.slice(0, 3).map(function (id) {
      const m = selectedMap[id] || {};
      return m.fullName || m.email || "?";
    }).join(", ");
    const moreSuffix = count > 3 ? " +" + (count - 3) + " more" : "";
    return (
      '<div class="admin-bulk-toolbar" role="toolbar" aria-label="Bulk actions">' +
        '<span class="admin-bulk-count"><strong>' + count + '</strong> selected</span>' +
        '<span class="admin-bulk-sample">' + st(sample + moreSuffix) + '</span>' +
        '<div class="admin-bulk-actions">' +
          '<button type="button" class="btn-ghost btn-sm" data-admin-users-bulk="grant_quota"><i class="fa-solid fa-plus"></i> Grant quota</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-admin-users-bulk="add_note"><i class="fa-solid fa-note-sticky"></i> Add note</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-admin-users-bulk="send_email"><i class="fa-solid fa-paper-plane"></i> Email all</button>' +
          '<button type="button" class="btn-ghost btn-sm admin-bulk-clear" data-admin-users-bulk-clear="1"><i class="fa-solid fa-xmark"></i> Clear</button>' +
        '</div>' +
      '</div>'
    );
  }
  function prettyAction(action) {
    if (action === "grant_quota") return "Granting quota…";
    if (action === "add_note") return "Adding note…";
    if (action === "send_email") return "Logging emails…";
    return "Applying…";
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
