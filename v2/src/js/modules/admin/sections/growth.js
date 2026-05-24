// Phase E2: Growth & Acquisition section.
//
// Answers "where do users come from, and which sources deliver QUALITY
// signups (signups that activate and place)?" Renders five panels:
//   1. Summary strip: total signups, activation %, placement %, attribution coverage
//   2. Acquisition funnel: signups → activated → placed
//   3. Channels table: utm_source × medium, with quality scores
//   4. Geography table: country breakdown
//   5. Top landing pages + Top referrer hosts
//   6. "Where to invest" recommendations
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function renderSummary(growth, h) {
    const st = h.st;
    const renderStat = h.renderStat;
    const summary = (growth && growth.summary) || {};
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Total signups", summary.totalSignups || 0,
          (summary.totalSignups30d || 0) + " in last 30 days", "green") +
        renderStat("Activation rate",
          (summary.overallActivation || 0) + "%",
          (summary.totalActivated || 0) + " of " + (summary.totalSignups || 0) + " created an application",
          (summary.overallActivation || 0) >= 40 ? "green" : "amber") +
        renderStat("Placement rate",
          (summary.overallPlacement || 0) + "%",
          (summary.totalPlaced || 0) + " reached interview / offer",
          (summary.overallPlacement || 0) >= 5 ? "green" : (summary.overallPlacement || 0) > 0 ? "amber" : "rose") +
        renderStat("Attribution coverage",
          (summary.attributionCoverage || 0) + "%",
          "signups with a campaign tag (utm_source)",
          (summary.attributionCoverage || 0) >= 50 ? "green" : "amber") +
      '</section>'
    );
  }

  function renderAcquisitionFunnel(growth, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const rows = safeArray(growth && growth.funnel);
    if (!rows.length) return "";
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>Acquisition funnel</span><h2>From signup to placement</h2></div>' +
          '<span class="chip blue">Lifetime</span>' +
        '</div>' +
        '<div class="admin-funnel admin-funnel--three">' +
          rows.map(function (row, index) {
            const tone = index === 0 ? "cyan" : index === 1 ? "blue" : "green";
            return (
              '<div><strong>' + st(row.count || 0) + '</strong>' +
                '<span>' + st(row.label || "Step") + '</span>' +
                '<small class="admin-funnel-share chip ' + tone + '">' + st(row.share || 0) + '%</small>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderChannelsTable(growth, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const rows = safeArray(growth && growth.channels);
    if (!rows.length) {
      return (
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Acquisition channels</span><h2>Source × medium breakdown</h2></div><span class="chip subtle">No data</span></div>' +
          '<p class="admin-copy">No attributed signups yet. Capture UTMs by appending <code>?utm_source=name&amp;utm_medium=type</code> to every campaign link.</p>' +
        '</article>'
      );
    }
    const total = rows.reduce(function (sum, row) { return sum + (Number(row.signups) || 0); }, 0);
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>Acquisition channels</span><h2>Source × medium quality</h2></div>' +
          '<span class="chip blue">' + st(rows.length) + ' channel' + (rows.length === 1 ? "" : "s") + '</span>' +
        '</div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--six admin-table-head"><span>Channel</span><span>Medium</span><span>Signups</span><span>Activated</span><span>Placed</span><span>Quality</span></div>' +
          rows.map(function (row) {
            const quality = Number(row.quality_score) || 0;
            const tone = quality >= 10 ? "green" : quality >= 3 ? "amber" : "rose";
            const share = total ? Math.round(((Number(row.signups) || 0) / total) * 100) : 0;
            return (
              '<div class="admin-table-row admin-table-row--six">' +
                '<span><strong>' + st(row.channel || "direct") + '</strong><em>' + st(share) + '% share</em></span>' +
                '<span>' + st(row.medium || "—") + '</span>' +
                '<span>' + st(row.signups || 0) + ' <em>(' + st(row.signups_30d || 0) + ' /30d)</em></span>' +
                '<span>' + st(row.activated || 0) + '</span>' +
                '<span>' + st(row.placed || 0) + '</span>' +
                '<span><b class="chip ' + tone + '">' + st(quality) + '%</b></span>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
        '<p class="admin-copy admin-copy--small">Quality = placed ÷ signups. A channel with 1000 signups and 0 placements is a leak, not a win.</p>' +
      '</article>'
    );
  }

  function renderGeoTable(growth, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const rows = safeArray(growth && growth.geo).slice(0, 12);
    if (!rows.length) {
      return (
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Geography</span><h2>Where users come from</h2></div><span class="chip subtle">No data</span></div>' +
          '<p class="admin-copy">Country attribution requires the signup-attribution function deployed behind Cloudflare. New signups will populate this once the function is live.</p>' +
        '</article>'
      );
    }
    const max = rows.reduce(function (m, r) { return Math.max(m, Number(r.signups) || 0); }, 1);
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Geography</span><h2>Signups by country</h2></div><span class="chip blue">' + st(rows.length) + ' countries</span></div>' +
        '<div class="admin-channel-list">' +
          rows.map(function (row) {
            const width = Math.max(4, Math.round(((Number(row.signups) || 0) / max) * 100));
            const code = String(row.country_code || "unknown");
            return (
              '<div class="admin-channel-row">' +
                '<div><strong>' + st(code) + '</strong><span>' + st(row.signups_30d || 0) + ' /30d · ' + st(row.activated || 0) + ' activated · ' + st(row.placed || 0) + ' placed</span></div>' +
                '<i style="--bar:' + width + '%"></i>' +
                '<b class="chip ' + (code === "unknown" ? "subtle" : "blue") + '">' + st(row.signups || 0) + '</b>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderLandingTable(growth, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const rows = safeArray(growth && growth.landing).slice(0, 8);
    if (!rows.length) return "";
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Top entry points</span><h2>Landing pages</h2></div><span class="chip cyan">' + st(rows.length) + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Path</span><span>Signups</span><span>30d</span><span>Activated</span></div>' +
          rows.map(function (row) {
            const path = String(row.landing_path || "unknown");
            return (
              '<div class="admin-table-row admin-table-row--four">' +
                '<span><code>' + st(path.slice(0, 60)) + (path.length > 60 ? "…" : "") + '</code></span>' +
                '<span>' + st(row.signups || 0) + '</span>' +
                '<span>' + st(row.signups_30d || 0) + '</span>' +
                '<span>' + st(row.activated || 0) + '</span>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderReferrersTable(growth, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const rows = safeArray(growth && growth.referrers).slice(0, 8);
    if (!rows.length) return "";
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Top referrers</span><h2>Where the click came from</h2></div><span class="chip cyan">' + st(rows.length) + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--four admin-table-head"><span>Host</span><span>Signups</span><span>30d</span><span>Activated</span></div>' +
          rows.map(function (row) {
            const host = String(row.referrer_host || "direct");
            return (
              '<div class="admin-table-row admin-table-row--four">' +
                '<span><strong>' + st(host) + '</strong></span>' +
                '<span>' + st(row.signups || 0) + '</span>' +
                '<span>' + st(row.signups_30d || 0) + '</span>' +
                '<span>' + st(row.activated || 0) + '</span>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderRecommendations(growth, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const alertTone = h.alertTone;
    const alertIcon = h.alertIcon;
    const rows = safeArray(growth && growth.recommendations);
    if (!rows.length) {
      return (
        '<article class="admin-panel admin-panel--wide">' +
          '<div class="admin-panel-head"><div><span>Where to invest</span><h2>Growth recommendations</h2></div><span class="chip green">Clean</span></div>' +
          '<p class="admin-copy">No urgent growth actions detected. Pick the highest-quality channel and increase budget by 25%.</p>' +
        '</article>'
      );
    }
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head"><div><span>Where to invest</span><h2>Growth recommendations</h2></div><span class="chip amber">' + st(rows.length) + ' action' + (rows.length === 1 ? "" : "s") + '</span></div>' +
        '<div class="admin-action-list">' +
          rows.map(function (rec) {
            const tone = alertTone(rec.severity);
            return (
              '<div class="admin-action-card admin-action-card--' + st(tone) + '">' +
                '<i class="fa-solid ' + alertIcon(rec.severity) + '"></i>' +
                '<div>' +
                  '<strong>' + st(rec.title || "Growth signal") + '</strong>' +
                  '<span>' + st(rec.body || "") + '</span>' +
                  '<em class="admin-action-card-action">' + st(rec.action || "") + '</em>' +
                '</div>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function render(data) {
    const h = window.CBAdmin.helpers;
    const growth = data && data.growth;
    if (!growth) {
      const st = h.st;
      return (
        '<section class="admin-status-banner admin-status-banner--local">' +
          '<div><strong>Growth & Acquisition</strong><span>Awaiting backend snapshot. Deploy admin-overview to populate this board.</span></div>' +
          '<span class="chip subtle">Pending</span>' +
        '</section>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Set up acquisition tracking</span><h2>How to populate this board</h2></div></div>' +
          '<ol class="admin-copy admin-copy--list">' +
            '<li>Deploy migration 0013 (adds UTM/referrer/geo columns to profiles).</li>' +
            '<li>Deploy the signup-attribution Edge Function.</li>' +
            '<li>Append <code>?utm_source=X&amp;utm_medium=Y&amp;utm_campaign=Z</code> to every campaign link.</li>' +
            '<li>New signups will be attributed automatically — Direct visits show under "direct".</li>' +
          '</ol>' +
        '</article>'
      );
    }
    return (
      renderSummary(growth, h) +
      renderRecommendations(growth, h) +
      '<section class="admin-grid admin-grid--two">' +
        renderAcquisitionFunnel(growth, h) +
        renderGeoTable(growth, h) +
      '</section>' +
      renderChannelsTable(growth, h) +
      '<section class="admin-grid admin-grid--two">' +
        renderLandingTable(growth, h) +
        renderReferrersTable(growth, h) +
      '</section>'
    );
  }

  window.CBAdmin.sections.growth = { render: render };
})();
