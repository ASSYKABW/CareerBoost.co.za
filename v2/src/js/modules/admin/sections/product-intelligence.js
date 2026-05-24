// Phase E4: Product Intelligence — the ROI board.
//
// Connects engagement signals to outcomes. Every panel answers a $-shaped
// question:
//   1. AI economics hero: what does each placement cost us in AI spend?
//   2. Module ROI: which modules predict placement (highest lift)?
//   3. Drop-off impact: where are the highest-$ leaks in the funnel?
//   4. AI skill ROI: which skills are efficient/expensive/unreliable?
//   5. Extension capture summary: import pipeline health
//
// This board doesn't show raw engagement counts — those still live on
// the "Usage & engagement" deep-dive section. Product Intelligence is
// the executive lens; usage-engagement is the analyst lens.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function renderEconomicsHero(econ, h) {
    const st = h.st;
    if (!econ) {
      return '<section class="admin-status-banner admin-status-banner--local"><div><strong>AI economics</strong><span>Waiting for backend snapshot.</span></div></section>';
    }
    const cppLabel = econ.costPerPlacement == null ? "—" : ("$" + econ.costPerPlacement.toFixed(2));
    const tone = econ.healthSignal === "healthy" ? "green"
      : econ.healthSignal === "watch" ? "amber"
      : econ.healthSignal === "unsustainable" ? "rose"
      : "subtle";
    return (
      '<section class="admin-econ-hero admin-econ-hero--' + tone + '">' +
        '<div class="admin-econ-hero-copy">' +
          '<span class="admin-kicker"><i class="fa-solid fa-coins"></i> AI economics — last 30 days</span>' +
          '<h2>Cost per placement</h2>' +
          '<p>' + st(econ.benchmark || "") + '</p>' +
        '</div>' +
        '<div class="admin-econ-hero-value">' +
          '<strong class="num-font">' + st(cppLabel) + '</strong>' +
          '<span class="admin-econ-hero-sub">' + st(econ.placements30d || 0) + ' placements · $' + st(Number(econ.spendMonthlyRunRate || 0).toFixed(2)) + ' AI spend</span>' +
        '</div>' +
        '<div class="admin-econ-hero-stats">' +
          '<span><strong>$' + st(Number(econ.costPerActiveUser || 0).toFixed(2)) + '</strong><em>per active user / month</em></span>' +
          '<span><strong>' + (econ.costPerOutcome == null ? "—" : "$" + Number(econ.costPerOutcome).toFixed(2)) + '</strong><em>per outcome (interview or offer)</em></span>' +
          '<span><strong>$' + st(Number(econ.costPerRequest || 0).toFixed(4)) + '</strong><em>per AI request</em></span>' +
          '<span><strong>' + st(econ.avgLatencyMs || 0) + 'ms</strong><em>avg latency</em></span>' +
        '</div>' +
      '</section>'
    );
  }

  function renderModuleRoi(rows, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const items = safeArray(rows);
    if (!items.length) {
      return '<article class="admin-panel"><div class="admin-panel-head"><div><span>Module ROI</span><h2>Which features predict placement</h2></div><span class="chip subtle">No data</span></div><p class="admin-copy">Module ROI will populate once usage_sessions and placements accumulate.</p></article>';
    }
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>Module ROI</span><h2>Which modules predict placement</h2></div>' +
          '<span class="chip blue">' + st(items.length) + ' modules</span>' +
        '</div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--roi admin-table-head"><span>Module</span><span>Users touched</span><span>Placed touched</span><span>Coverage</span><span>Lift vs baseline</span><span>Verdict</span></div>' +
          items.map(function (row) {
            const verdictTone = row.verdict === "core" ? "green"
              : row.verdict === "supporting" ? "blue"
              : row.verdict === "underused" ? "amber"
              : "subtle";
            const liftTone = row.lift >= 20 ? "green"
              : row.lift >= 0 ? "blue"
              : row.lift >= -20 ? "amber"
              : "rose";
            const liftLabel = (row.lift > 0 ? "+" : "") + row.lift + "%";
            return (
              '<div class="admin-table-row admin-table-row--roi" title="' + st(row.recommendation) + '">' +
                '<span><strong>' + st(row.label) + '</strong></span>' +
                '<span>' + st(row.touched) + '</span>' +
                '<span>' + st(row.placedTouched) + '</span>' +
                '<span><b class="admin-coverage-pill">' + st(row.coverage) + '%</b></span>' +
                '<span><b class="chip ' + liftTone + '">' + st(liftLabel) + '</b></span>' +
                '<span><b class="chip ' + verdictTone + '">' + st(row.verdict) + '</b></span>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
        '<p class="admin-copy admin-copy--small">Lift = (placement rate among module users − baseline rate) / baseline. Coverage = % of placed users who touched this module.</p>' +
      '</article>'
    );
  }

  function renderDropOffImpact(rows, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const items = safeArray(rows).filter(function (r) { return r.droppedUsers > 0; }).slice(0, 5);
    if (!items.length) {
      return '<article class="admin-panel"><div class="admin-panel-head"><div><span>Drop-off impact</span><h2>Where the money leaks</h2></div><span class="chip green">No critical drops</span></div><p class="admin-copy">No funnel steps with material drop-off detected.</p></article>';
    }
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>Drop-off impact</span><h2>Where the money leaks</h2></div>' +
          '<span class="chip amber">' + st(items.length) + ' leak' + (items.length === 1 ? "" : "s") + '</span>' +
        '</div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Funnel step</span><span>Users dropped</span><span>If recovered</span><span>Est. value</span><span>What to do</span></div>' +
          items.map(function (row) {
            return (
              '<div class="admin-table-row admin-table-row--five">' +
                '<span><strong>' + st(row.label) + '</strong></span>' +
                '<span>' + st(row.droppedUsers) + '</span>' +
                '<span>+' + st(row.estimatedExtraPlacements) + ' placements</span>' +
                '<span><b class="chip green">$' + st(row.estimatedValueUsd) + '</b></span>' +
                '<span>' + st(row.action) + '</span>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
        '<p class="admin-copy admin-copy--small">Est. value uses a placeholder $150/placement until monetization launches; replace with real ARPU in <code>admin-overview/index.ts</code> when known.</p>' +
      '</article>'
    );
  }

  function renderSkillRoi(rows, h) {
    const st = h.st;
    const safeArray = h.safeArray;
    const items = safeArray(rows);
    if (!items.length) {
      return '<article class="admin-panel"><div class="admin-panel-head"><div><span>AI skill ROI</span><h2>Which skills are efficient</h2></div><span class="chip subtle">No data</span></div><p class="admin-copy">AI skill ROI populates after the first 5+ calls per skill.</p></article>';
    }
    return (
      '<article class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>AI skill ROI</span><h2>Which skills deliver value</h2></div>' +
          '<span class="chip blue">' + st(items.length) + ' skill' + (items.length === 1 ? "" : "s") + '</span>' +
        '</div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--roi-skill admin-table-head"><span>Skill</span><span>Calls</span><span>Fail %</span><span>Cost</span><span>Share</span><span>Verdict</span><span>Action</span></div>' +
          items.map(function (row) {
            const verdictTone = row.verdict === "efficient" ? "green"
              : row.verdict === "expensive" ? "amber"
              : row.verdict === "unreliable" ? "rose"
              : "subtle";
            return (
              '<div class="admin-table-row admin-table-row--roi-skill">' +
                '<span><strong>' + st(row.label) + '</strong></span>' +
                '<span>' + st(row.count) + '</span>' +
                '<span>' + st(row.failureRate) + '%</span>' +
                '<span>$' + Number(row.cost || 0).toFixed(2) + '</span>' +
                '<span>' + st(row.costShare) + '%</span>' +
                '<span><b class="chip ' + verdictTone + '">' + st(row.verdict) + '</b></span>' +
                '<span class="admin-skill-action">' + st(row.action) + '</span>' +
              '</div>'
            );
          }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderExtensionSummary(ext, h) {
    const st = h.st;
    if (!ext) return "";
    const tone = ext.overallStatus === "healthy" ? "green"
      : ext.overallStatus === "watch" ? "amber"
      : "rose";
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Extension capture pipeline</span><h2>Import health</h2></div>' +
          '<span class="chip ' + tone + '">' + st(ext.overallStatus) + '</span>' +
        '</div>' +
        '<div class="admin-outcomes-stats">' +
          '<span><strong>' + st(ext.captures || 0) + '</strong><em>LinkedIn captures</em></span>' +
          '<span><strong>' + st(ext.jobImportCalls || 0) + '</strong><em>job-import AI calls</em></span>' +
          '<span><strong>' + st(ext.sourceConflicts || 0) + '</strong><em>source/host conflicts</em></span>' +
        '</div>' +
        '<p class="admin-copy admin-copy--small">' +
          (ext.sourceConflicts > 0
            ? 'Open Job feed health to review the source/host mismatches before they erode trust.'
            : 'Capture pipeline is clean. Provider labels match canonical hosts.') +
        '</p>' +
      '</article>'
    );
  }

  function renderRoiSummary(summary, h) {
    const st = h.st;
    const renderStat = h.renderStat;
    if (!summary) return "";
    return (
      '<section class="admin-stat-grid">' +
        renderStat("Core modules", summary.coreModules || 0, "modules ≥50% used by placed users", summary.coreModules ? "green" : "amber") +
        renderStat("Underused modules", summary.underusedModules || 0, "candidates to scope down or improve", summary.underusedModules ? "amber" : "green") +
        renderStat("Expensive AI skills", summary.expensiveSkills || 0, "burning ≥40% of total AI spend", summary.expensiveSkills ? "amber" : "green") +
        renderStat("Unreliable AI skills", summary.unreliableSkills || 0, "failure rate above 15%", summary.unreliableSkills ? "rose" : "green") +
      '</section>'
    );
  }

  function render(data) {
    const h = window.CBAdmin.helpers;
    const pi = data && data.productIntelligence;
    if (!pi) {
      return (
        '<section class="admin-status-banner admin-status-banner--local">' +
          '<div><strong>Product Intelligence</strong><span>Awaiting backend snapshot — deploy admin-overview to populate this board.</span></div>' +
          '<span class="chip subtle">Pending</span>' +
        '</section>' +
        '<article class="admin-panel">' +
          '<p class="admin-copy">Product Intelligence is the ROI board — it tells you which features and AI skills actually produce placements, and where each dollar of AI spend goes. It builds on data from Command Center (outcomes), Growth (acquisition), and Users (segments).</p>' +
        '</article>'
      );
    }
    return (
      renderEconomicsHero(pi.aiEconomics, h) +
      renderRoiSummary(pi.summary, h) +
      renderModuleRoi(pi.moduleRoi, h) +
      renderDropOffImpact(pi.dropOffImpact, h) +
      renderSkillRoi(pi.aiEconomics && pi.aiEconomics.skillRoi, h) +
      '<section class="admin-grid admin-grid--two">' +
        renderExtensionSummary(pi.extension, h) +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Deep dives</span><h2>Detailed boards</h2></div></div>' +
          '<div class="admin-quick-grid">' +
            '<a class="admin-quick-card" href="#/admin?section=usage"><i class="fa-solid fa-wave-square"></i><div><strong>Usage & engagement</strong><span>raw event/session counts</span></div><i class="fa-solid fa-arrow-right admin-quick-arrow"></i></a>' +
            '<a class="admin-quick-card" href="#/admin?section=ai-cost"><i class="fa-solid fa-wand-magic-sparkles"></i><div><strong>AI cost monitor</strong><span>per-provider failures + spend</span></div><i class="fa-solid fa-arrow-right admin-quick-arrow"></i></a>' +
            '<a class="admin-quick-card" href="#/admin?section=extension"><i class="fa-solid fa-puzzle-piece"></i><div><strong>Extension health</strong><span>capture + import pipeline</span></div><i class="fa-solid fa-arrow-right admin-quick-arrow"></i></a>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  window.CBAdmin.sections["product-intelligence"] = { render: render };
})();
