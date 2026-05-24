// Phase D: AI cost monitor section renderer (split from admin.route.js).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBAdmin = window.CBAdmin || {};
  window.CBAdmin.sections = window.CBAdmin.sections || {};

  function render(data) {
    const h = window.CBAdmin.helpers;
    const st = h.st;
    const renderStat = h.renderStat;
    const safeArray = h.safeArray;
    const money = h.money;
    const formatDateTime = h.formatDateTime;

    const skills = data.ai.bySkill || [];
    const failures = safeArray(data.recentAiFailures);
    const providers = safeArray(data.aiProviders);
    const budget = data.aiBudget || {};
    return (
      '<section class="admin-stat-grid">' +
        renderStat("AI requests", data.ai.totalEvents || 0, (data.ai.failed || 0) + " failed", data.ai.failed ? "amber" : "green") +
        renderStat("Monthly run-rate", money(budget.monthlyRunRateUsd != null ? budget.monthlyRunRateUsd : data.ai.costUsd || 0), "estimated from 30-day sample", budget.status === "watch" ? "amber" : "blue") +
        renderStat("Avg latency", (data.ai.avgLatencyMs || 0) + "ms", "successful and failed calls", "cyan") +
        renderStat("Cost per request", money(budget.costPerRequestUsd || 0), "blended provider average", "violet") +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>AI telemetry</span><h2>Usage by skill</h2></div><span class="chip blue">30 days</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-head"><span>Skill</span><span>Calls</span><span>Failed</span><span>Cost</span></div>' +
            (skills.length ? skills.map(function (skill) {
              return '<div class="admin-table-row"><span>' + st(skill.label) + '</span><span>' + st(skill.count) + '</span><span>' + st(skill.failed || 0) + '</span><span>' + st(money(skill.costUsd || 0)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No AI telemetry has been written in the last 30 days.</p>') +
          '</div>' +
        '</article>' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Provider quality</span><h2>Cost and reliability by provider</h2></div><span class="chip ' + st(providers.some(function (p) { return p.status === "watch"; }) ? "amber" : "green") + '">Provider SLA</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Provider</span><span>Calls</span><span>Fail rate</span><span>Latency</span><span>Cost</span></div>' +
            (providers.length ? providers.map(function (provider) {
              return '<div class="admin-table-row admin-table-row--five"><span>' + st(provider.label) + '</span><span>' + st(provider.count) + '</span><span>' + st((provider.failureRate || 0) + "%") + '</span><span>' + st((provider.avgLatencyMs || 0) + "ms") + '</span><span>' + st(money(provider.costUsd || 0)) + '</span></div>';
            }).join("") : '<p class="admin-copy">No provider-level AI telemetry has been written in the last 30 days.</p>') +
          '</div>' +
        '</article>' +
      '</section>' +
      '<article class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Reliability</span><h2>Recent AI failures</h2></div><span class="chip ' + st(failures.length ? "amber" : "green") + '">' + st(failures.length ? failures.length + " failures" : "Clean") + '</span></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--five admin-table-head"><span>Skill</span><span>Provider</span><span>Model</span><span>Error</span><span>Time</span></div>' +
          (failures.length ? failures.map(function (failure) {
            return '<div class="admin-table-row admin-table-row--five"><span>' + st(failure.skill) + '</span><span>' + st(failure.provider) + '</span><span>' + st(failure.model || "unknown") + '</span><span>' + st(failure.error) + '</span><span>' + st(formatDateTime(failure.at)) + '</span></div>';
          }).join("") : '<p class="admin-copy">No failed AI requests returned in the latest 30-day sample.</p>') +
        '</div>' +
      '</article>'
    );
  }

  window.CBAdmin.sections["ai-cost"] = { render: render };
})();
