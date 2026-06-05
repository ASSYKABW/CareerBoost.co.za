// Phase E1: Command Center — the new admin home.
//
// Information design principle: every signal answers four questions —
//   WHAT (the metric),
//   WHY IT MATTERS (business impact),
//   WHY IT'S HAPPENING (root cause),
//   WHAT TO DO (specific action with deep-link).
//
// Layout from top to bottom:
//   1. North Star hero (active placements 30d + delta + target progress)
//   2. AARRR strip (Acquisition · Activation · Retention · Revenue · Referral)
//   3. Today's 3 priorities (algorithmic top-3 with one-click jump to action)
//   4. Weekly changes (what moved week-over-week)
//   5. Live ops feed (existing — minimal version)
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function renderNorthStar(northStar, h, dailyActive) {
    const st = h.st;
    if (!northStar) {
      return (
        '<section class="admin-north-star admin-north-star--pending">' +
          '<div class="admin-north-star-copy">' +
            '<span class="admin-kicker">North star</span>' +
            '<h2>Active placements</h2>' +
            '<p>Awaiting backend snapshot. Refresh after deploying the admin-overview function.</p>' +
          '</div>' +
        '</section>'
      );
    }
    const directionIcon = northStar.direction === "up" ? "fa-arrow-up"
      : northStar.direction === "down" ? "fa-arrow-down"
      : "fa-minus";
    const directionTone = northStar.direction === "up" ? "green"
      : northStar.direction === "down" ? "rose"
      : "subtle";
    const deltaLabel = (northStar.delta > 0 ? "+" : "") + northStar.delta +
      " (" + (northStar.deltaPct > 0 ? "+" : "") + northStar.deltaPct + "%)";
    // BE-1: a 30-day activity sparkline (active users) — the one clean daily
    // series in the payload. Clearly labelled so it reads as context, not the
    // placements metric itself.
    const sparkSeries = (dailyActive || []).map(function (d) { return Number(d.activeUsers || 0); });
    const spark = sparkSeries.length
      ? '<div class="admin-ns-spark">' +
          '<span class="admin-ns-spark-label">Active users · 30d</span>' +
          '<div class="admin-chart-bars">' + h.renderSparkBars(sparkSeries) + '</div>' +
        '</div>'
      : "";
    return (
      '<section class="admin-north-star admin-north-star--' + st(northStar.progressTone || "blue") + '">' +
        '<div class="admin-north-star-copy">' +
          '<span class="admin-kicker"><i class="fa-solid fa-bullseye"></i> North star — last 30 days</span>' +
          '<h2>' + st(northStar.label || "Active placements") + '</h2>' +
          '<p>' + st(northStar.sublabel || "") + '</p>' +
        '</div>' +
        '<div class="admin-north-star-value">' +
          '<strong class="num-font">' + st(northStar.value || 0) + '</strong>' +
          '<span class="admin-north-star-delta admin-north-star-delta--' + st(directionTone) + '">' +
            '<i class="fa-solid ' + directionIcon + '"></i> ' + st(deltaLabel) +
          '</span>' +
        '</div>' +
        '<div class="admin-north-star-progress">' +
          '<div class="admin-north-star-progress-head">' +
            '<span>Target: <strong>' + st(northStar.target || 0) + '</strong></span>' +
            '<span><strong>' + st(northStar.progress || 0) + '%</strong> of target</span>' +
          '</div>' +
          '<div class="admin-north-star-progress-bar"><i style="--bar:' + Math.min(100, Number(northStar.progress) || 0) + '%"></i></div>' +
          '<small>' + st(northStar.note || "") + '</small>' +
          spark +
        '</div>' +
      '</section>'
    );
  }

  function renderAarrrStrip(aarrr, h) {
    const st = h.st;
    if (!aarrr || !aarrr.length) {
      return (
        '<section class="admin-aarrr admin-aarrr--pending">' +
          '<p class="admin-copy">Growth-engine metrics will appear once the admin-overview function returns AARRR data.</p>' +
        '</section>'
      );
    }
    return (
      '<section class="admin-aarrr">' +
        aarrr.map(function (stage) {
          const tone = stage.status === "good" ? "green"
            : stage.status === "watch" ? "amber"
            : "rose";
          const value = stage.preFormatted != null
            ? stage.preFormatted
            : (stage.value + (stage.unit || ""));
          const deltaHtml = stage.delta != null
            ? '<span class="admin-aarrr-delta admin-aarrr-delta--' + (stage.delta >= 0 ? "up" : "down") + '">' +
                (stage.delta > 0 ? "+" : "") + st(stage.delta) +
                (stage.deltaPct != null ? " (" + (stage.deltaPct > 0 ? "+" : "") + st(stage.deltaPct) + "%)" : "") +
              '</span>'
            : "";
          return (
            '<article class="admin-aarrr-card admin-aarrr-card--' + tone + '" data-aarrr-stage="' + st(stage.stage) + '">' +
              '<header class="admin-aarrr-card-head">' +
                '<i class="fa-solid ' + st(stage.icon || "fa-circle") + '" aria-hidden="true"></i>' +
                '<span>' + st(stage.label || stage.stage) + '</span>' +
                '<b class="chip ' + tone + '">' + st(stage.status === "good" ? "ON TRACK" : stage.status === "watch" ? "WATCH" : "FIX") + '</b>' +
              '</header>' +
              '<div class="admin-aarrr-card-value">' +
                '<strong class="num-font">' + st(value) + '</strong>' +
                deltaHtml +
              '</div>' +
              '<small class="admin-aarrr-card-sub">' + st(stage.sub || "") + '</small>' +
              '<details class="admin-aarrr-card-detail">' +
                '<summary>Why &amp; what to do</summary>' +
                '<p><strong>Why it matters:</strong> ' + st(stage.why || "") + '</p>' +
                '<p><strong>Action:</strong> ' + st(stage.action || "") + '</p>' +
                (stage.section ? '<a class="btn-ghost btn-sm" href="#/admin?section=' + st(stage.section) + '"><i class="fa-solid fa-arrow-right"></i> Open ' + st(stage.section) + '</a>' : "") +
              '</details>' +
            '</article>'
          );
        }).join("") +
      '</section>'
    );
  }

  function renderPriorities(priorities, h) {
    const st = h.st;
    if (!priorities || !priorities.length) {
      return (
        '<article class="admin-panel admin-priorities admin-priorities--empty">' +
          '<div class="admin-panel-head"><div><span>Today\'s priorities</span><h2>All systems healthy</h2></div><span class="chip green">Clean</span></div>' +
          '<p class="admin-copy">No priority issues detected. Use this calm to ship a marketing experiment or referral loop.</p>' +
        '</article>'
      );
    }
    const isAllClear = priorities.length === 1 && priorities[0].id === "all-clear";
    return (
      '<article class="admin-panel admin-priorities">' +
        '<div class="admin-panel-head">' +
          '<div><span>Today\'s priorities</span><h2>' + st(isAllClear ? "All systems healthy" : "Clear these in three clicks") + '</h2></div>' +
          '<span class="chip ' + (isAllClear ? "green" : "amber") + '">' + st(priorities.length) + ' priorit' + (priorities.length === 1 ? "y" : "ies") + '</span>' +
        '</div>' +
        '<div class="admin-priority-list">' +
          priorities.map(function (item, index) {
            const impactPct = Math.min(100, (Number(item.impact) || 0) * 10);
            return (
              '<div class="admin-priority-card admin-priority-card--' + (index === 0 ? "top" : "sub") + '">' +
                '<div class="admin-priority-rank"><span>#' + (index + 1) + '</span><i class="fa-solid ' + st(item.icon || "fa-bullseye") + '"></i></div>' +
                '<div class="admin-priority-body">' +
                  '<strong>' + st(item.title || "Priority") + '</strong>' +
                  '<p class="admin-priority-why"><span class="admin-priority-label">Why it matters</span>' + st(item.why || "") + '</p>' +
                  '<p class="admin-priority-cause"><span class="admin-priority-label">Why it\'s happening</span>' + st(item.rootCause || "") + '</p>' +
                  '<p class="admin-priority-action"><span class="admin-priority-label">What to do</span>' + st(item.action || "") + '</p>' +
                '</div>' +
                '<div class="admin-priority-cta">' +
                  '<a class="btn-primary btn-sm" href="#/admin?section=' + st(item.section || "command-center") + '">' +
                    '<i class="fa-solid fa-arrow-right"></i> Take action' +
                  '</a>' +
                  '<div class="admin-priority-meter" title="Impact ' + st(item.impact || 0) + '/10">' +
                    '<i style="--bar:' + impactPct + '%"></i>' +
                  '</div>' +
                '</div>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderWeeklyChanges(changes, h) {
    const st = h.st;
    if (!changes || !changes.length) return "";
    return (
      '<article class="admin-panel admin-weekly-changes">' +
        '<div class="admin-panel-head"><div><span>Week-over-week</span><h2>What moved this week</h2></div><span class="chip blue">7d vs prior 7d</span></div>' +
        '<div class="admin-weekly-grid">' +
          changes.map(function (row) {
            const isUp = row.direction === "up";
            const isDown = row.direction === "down";
            const isGood = (row.goodDirection === "up" && isUp) || (row.goodDirection === "down" && isDown);
            const isBad = (row.goodDirection === "up" && isDown) || (row.goodDirection === "down" && isUp);
            const tone = isGood ? "green" : (isBad ? "rose" : "subtle");
            const arrow = isUp ? "fa-arrow-up" : (isDown ? "fa-arrow-down" : "fa-minus");
            return (
              '<div class="admin-weekly-row admin-weekly-row--' + tone + '">' +
                '<i class="fa-solid ' + st(row.icon || "fa-chart-line") + ' admin-weekly-icon" aria-hidden="true"></i>' +
                '<div class="admin-weekly-copy">' +
                  '<strong>' + st(row.metric || "Metric") + '</strong>' +
                  '<span>' + st(row.now || 0) + ' this week · <em>' + st(row.prior || 0) + ' prior</em></span>' +
                '</div>' +
                '<div class="admin-weekly-delta admin-weekly-delta--' + tone + '">' +
                  '<i class="fa-solid ' + arrow + '"></i> ' +
                  (row.diff > 0 ? "+" : "") + st(row.diff) +
                  (row.pct != null ? ' <small>(' + (row.pct > 0 ? "+" : "") + st(row.pct) + '%)</small>' : "") +
                '</div>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderOutcomesPanel(outcomes, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    if (!outcomes) return "";
    const byChannel = safeArray(outcomes.byChannel);
    const attributedShare = Number(outcomes.attributedShare || 0);
    const channelRows = byChannel.length
      ? byChannel.slice(0, 5).map(function (row) {
          const max = byChannel.reduce(function (m, r) { return Math.max(m, Number(r.placements_30d) || 0); }, 1);
          const width = Math.max(4, Math.round(((Number(row.placements_30d) || 0) / max) * 100));
          return (
            '<div class="admin-channel-row">' +
              '<div><strong>' + st(row.channel || "unattributed") + '</strong><span>' + st(row.distinct_users_30d || 0) + ' users · ' + st(row.interviews_30d || 0) + ' interviews · ' + st(row.offers_30d || 0) + ' offers</span></div>' +
              '<i style="--bar:' + width + '%"></i>' +
              '<b class="chip ' + (row.channel === "unattributed" ? "subtle" : "green") + '">' + st(row.placements_30d || 0) + '</b>' +
            '</div>'
          );
        }).join("")
      : '<p class="admin-copy">No placements have been reported yet. Encourage candidates to mark interview/offer milestones from the pipeline detail view.</p>';
    return (
      '<article class="admin-panel admin-outcomes-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Outcome attribution</span><h2>Which channels lead to interviews</h2></div>' +
          '<span class="chip ' + (attributedShare >= 50 ? "green" : attributedShare > 0 ? "amber" : "subtle") + '">' + st(attributedShare) + '% attributed</span>' +
        '</div>' +
        '<div class="admin-outcomes-stats">' +
          '<span><strong>' + st(outcomes.interviews30d || 0) + '</strong><em>interviews 30d</em></span>' +
          '<span><strong>' + st(outcomes.offers30d || 0) + '</strong><em>offers 30d</em></span>' +
          '<span><strong>' + st(outcomes.distinctPlacedUsers30d || 0) + '</strong><em>placed users</em></span>' +
        '</div>' +
        '<div class="admin-channel-list">' + channelRows + '</div>' +
        '<small class="admin-copy admin-outcomes-source">' + st(outcomes.sourceNote || "") + '</small>' +
      '</article>'
    );
  }

  function renderQuickActions(h) {
    // Phase E1 wires the UI; the campaign / broadcast / feature-flag
    // back-ends come in later phases. For now these route to existing
    // sections so the operator never lands on a dead end.
    const st = h.st;
    const actions = [
      { id: "review-users", label: "Re-engage stuck users", icon: "fa-user-clock", section: "user-support", note: "Open at-risk queue" },
      { id: "investigate-growth", label: "Inspect growth channels", icon: "fa-chart-line", section: "funnel", note: "Open funnel analytics" },
      { id: "review-incidents", label: "Review open incidents", icon: "fa-shield-virus", section: "risk-center", note: "Acknowledge or resolve" },
      { id: "export-snapshot", label: "Export executive snapshot", icon: "fa-file-export", section: "reports", note: "CSV / JSON downloads" }
    ];
    return (
      '<article class="admin-panel admin-quick-actions">' +
        '<div class="admin-panel-head"><div><span>Quick actions</span><h2>Operate the platform</h2></div><span class="chip subtle">Direct levers</span></div>' +
        '<div class="admin-quick-grid">' +
          actions.map(function (a) {
            return (
              '<a class="admin-quick-card" href="#/admin?section=' + st(a.section) + '" data-quick-action="' + st(a.id) + '">' +
                '<i class="fa-solid ' + st(a.icon) + '"></i>' +
                '<div><strong>' + st(a.label) + '</strong><span>' + st(a.note) + '</span></div>' +
                '<i class="fa-solid fa-arrow-right admin-quick-arrow"></i>' +
              '</a>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function render(data) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const safeArray = h.safeArray;
    const renderActivity = h.renderActivity;
    const formatDateTime = h.formatDateTime;

    const cloudLine = data.cloud.connected
      ? "Supabase live · " + formatDateTime(data.cloud.generatedAt)
      : (data.cloud.status === "error" ? "Cloud error: " + data.cloud.error : "Local/browser telemetry");

    const alertCount = safeArray(data.alerts).length;
    const incidentCount = safeArray(data.controlCenter && data.controlCenter.incidents).filter(function (i) {
      return (i.status || "open") === "open";
    }).length;

    // A5: freshness badge on the status banner — the admin-overview
    // fetcher has a 60s TTL, so the badge tone matches the cache state.
    // Sits alongside the incident/alert chip strip so the operator sees
    // "data is N minutes old → Refresh" without scrolling.
    const metricsBadge = h.renderFreshnessBadge
      ? h.renderFreshnessBadge(h.adminRemote, "metrics", { ttlMs: h.ADMIN_METRICS_TTL_MS || 60_000 })
      : "";

    return (
      '<section class="admin-status-banner admin-status-banner--' + st(data.cloud.connected ? "live" : (data.cloud.status === "error" ? "warn" : "local")) + '">' +
        '<div><strong>' + st(data.cloud.connected ? "Admin backend connected" : "Admin backend waiting") + '</strong><span>' + st(cloudLine) + '</span></div>' +
        '<div class="admin-status-counts">' +
          '<span class="chip ' + (incidentCount ? "rose" : "green") + '">' + st(incidentCount) + ' open incident' + (incidentCount === 1 ? "" : "s") + '</span>' +
          '<span class="chip ' + (alertCount ? "amber" : "subtle") + '">' + st(alertCount) + ' alert' + (alertCount === 1 ? "" : "s") + '</span>' +
          metricsBadge +
        '</div>' +
      '</section>' +
      renderNorthStar(data.northStar, h, data.dailyActive) +
      renderAarrrStrip(data.aarrr, h) +
      renderPriorities(data.priorities, h) +
      '<section class="admin-grid admin-grid--command">' +
        renderWeeklyChanges(data.weeklyChanges, h) +
        renderOutcomesPanel(data.outcomes, h) +
      '</section>' +
      '<section class="admin-grid admin-grid--command">' +
        renderQuickActions(h) +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Live operations</span><h2>Recent activity</h2></div><span class="chip subtle">Real-time</span></div>' +
          '<ul class="admin-activity-list">' + renderActivity(data) + '</ul>' +
        '</article>' +
      '</section>'
    );
  }

  window.CBAdmin.sections["command-center"] = { render: render };
})();
