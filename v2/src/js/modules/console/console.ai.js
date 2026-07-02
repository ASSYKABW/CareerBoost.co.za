// CareerBoost Console — AI & Health section (Phase 2).
//
// Registers window.CBConsole.sections.ai = { load(bodyEl) }. Renders:
//   - KPI strip: AI spend 7d (est) / AI calls / failure rate / open incidents
//   - spend by skill (calls / est spend / failure-rate chip)
//   - open incidents (needs-you)
//   - recent failures (skill · model · error)
//   - spend by model
// Read-only. Grounded on ai_usage + admin_incidents via console-ai-health.
(function () {
  window.CBConsole = window.CBConsole || {};
  window.CBConsole.sections = window.CBConsole.sections || {};
  var U = function () { return window.CBConsole.util; };
  var D = function () { return window.CBConsole.data; };
  function esc(s) { return U().escapeHtml(s); }

  // kpiCard / kpiSkeleton / sampleBadge come from CBConsole.util (shared).
  function skillTable(bySkill) {
    if (!bySkill || !bySkill.length) return '<div style="color:var(--c-muted);font-size:12.5px">No AI usage in the last 7 days.</div>';
    var body = bySkill.map(function (s) {
      return '<tr><td>' + esc(s.skill) + '</td><td class="n">' + s.calls + '</td><td class="n">' + esc(s.spend) + '</td>' +
        '<td class="n"><span class="cbc-chip ' + (s.tone || "green") + '">' + s.failRate + '%</span></td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Skill</th><th style="text-align:right">Calls</th><th style="text-align:right">Spend</th><th style="text-align:right">Fail</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function modelTable(byModel) {
    if (!byModel || !byModel.length) return '<div style="color:var(--c-muted);font-size:12.5px">No model data yet.</div>';
    var body = byModel.map(function (m) {
      return '<tr><td style="font-family:var(--c-mono);font-size:12px">' + esc(m.model) + '</td><td class="n">' + m.calls + '</td><td class="n">' + esc(m.spend) + '</td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Model</th><th style="text-align:right">Calls</th><th style="text-align:right">Spend</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function incidentsPanel(incidents) {
    var rows = (incidents && incidents.length)
      ? incidents.map(function (i) {
          var crit = i.severity === "critical";
          return '<div class="cbc-att-it"><div class="cbc-att-ic ' + (crit ? "red" : "amber") + '"><i class="fa-solid fa-triangle-exclamation"></i></div>' +
            '<div class="cbc-tx">' + esc(i.title) + '<small>' + esc(i.section) + ' · ' + esc(i.when) + '</small></div>' +
            '<div class="cbc-rt"><span class="cbc-chip ' + (crit ? "red" : "amber") + '">' + esc(i.severity) + '</span></div></div>';
        }).join("")
      : '<div style="color:var(--c-muted);font-size:12.5px;padding:8px 0"><i class="fa-solid fa-circle-check" style="color:var(--c-ok)"></i> No open incidents — systems healthy.</div>';
    return '<div class="cbc-card cbc-panel cbc-att"><div class="cbc-ph"><div><div class="cbc-eb">Needs you</div><h2>Open incidents</h2></div></div>' + rows + '</div>';
  }

  function failuresPanel(failures) {
    var rows = (failures && failures.length)
      ? failures.map(function (f) {
          return '<div class="cbc-fi red"><span class="cbc-fd"></span><div><div class="cbc-ft">' + esc(f.skill) + ' · ' + esc(f.model) + '</div>' +
            '<div class="cbc-fm">' + esc(f.error) + ' · ' + esc(f.when) + '</div></div></div>';
        }).join("")
      : '<div style="color:var(--c-muted);font-size:12.5px;padding:8px 0"><i class="fa-solid fa-circle-check" style="color:var(--c-ok)"></i> No AI failures in the last 7 days.</div>';
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Reliability</div><h2>Recent failures</h2></div></div>' +
      '<div class="cbc-feed" style="max-height:280px">' + rows + '</div></div>';
  }

  async function load(bodyEl) {
    bodyEl.innerHTML = '<section class="cbc-kpis cbc-kpis--4">' + U().kpiSkeleton(4) + '</section>';
    var h = await D().loadAiHealth();
    bodyEl.innerHTML =
      U().sampleBadge(h._mock, "console-ai-health", "AI cost + failures") +
      '<section class="cbc-kpis cbc-kpis--4">' + (h.kpis || []).map(U().kpiCard).join("") + '</section>' +
      '<section class="cbc-grid cbc-g-2a">' +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">AI cost</div><h2>Spend by skill (7d)</h2></div></div>' + skillTable(h.bySkill) + '</div>' +
        incidentsPanel(h.incidents) +
      '</section>' +
      '<section class="cbc-grid cbc-g-2b">' +
        failuresPanel(h.failures) +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">AI cost</div><h2>Spend by model (7d)</h2></div></div>' + modelTable(h.byModel) + '</div>' +
      '</section>';
    bodyEl.querySelectorAll(".cbc-num[data-count]").forEach(function (n) {
      U().countUp(n, Number(n.getAttribute("data-count")), n.getAttribute("data-fmt"));
    });
  }

  window.CBConsole.sections.ai = { load: load };
})();
