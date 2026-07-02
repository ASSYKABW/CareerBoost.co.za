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

  // ── Model Control (live per-skill LLM routing via console-config) ──
  function sourceChip(s) {
    if (s.source === "admin") return '<span class="cbc-chip violet">admin</span>';
    if (s.source === "env") return '<span class="cbc-chip amber">env</span>';
    return '<span class="cbc-chip dim">default</span>';
  }
  function modelControlPanel(cfg) {
    var rows = (cfg.skills || []).map(function (s) {
      var reset = s.source === "admin"
        ? ' <button class="cbc-btn cbc-sm" data-mc-reset="' + esc(s.skill) + '">Reset</button>'
        : "";
      return '<tr><td><div style="font-weight:600">' + esc(s.skill) + '</div></td>' +
        '<td><span class="cbc-chip dim">' + esc(s.tier) + '</span></td>' +
        '<td>' + esc(s.effectiveProvider) + '</td>' +
        '<td style="font-family:var(--c-mono);font-size:12px">' + esc(s.effectiveModel) + '</td>' +
        '<td>' + sourceChip(s) + '</td>' +
        '<td class="n"><button class="cbc-btn cbc-sm" data-mc-edit="' + esc(s.skill) + '">Change</button>' + reset + '</td></tr>';
    }).join("");
    return '<section class="cbc-card cbc-panel" id="cbc-mc">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Ops control</div><h2>Model Control</h2></div>' +
        '<span class="cbc-chip green"><span class="cbc-dot"></span> live · applies in ≤60s</span></div>' +
      '<div style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Route any skill to a different provider/model with no redeploy. Changes are audit-logged; the fallback chain still protects you if the routed provider fails.</div>' +
      '<div id="cbc-mc-edit"></div>' +
      '<table class="cbc-table"><thead><tr><th>Skill</th><th>Tier</th><th>Provider</th><th>Model</th><th>Source</th><th style="text-align:right">Route</th></tr></thead><tbody>' + rows + '</tbody></table></section>';
  }
  function bindModelControl(bodyEl, cfg) {
    var host = bodyEl.querySelector("#cbc-mc"); if (!host) return;
    var toast = (window.CBConsole.ui && window.CBConsole.ui.toast) || function (m) { console.log(m); };
    function editForm(s) {
      var provs = (cfg.availableProviders || []).map(function (p) {
        return '<option value="' + esc(p) + '"' + (p === s.effectiveProvider ? " selected" : "") + '>' + esc(p) + '</option>';
      }).join("");
      var cat = cfg.modelCatalog || {};
      var opts = (cat[s.effectiveProvider] || []).map(function (m) { return '<option value="' + esc(m) + '">'; }).join("");
      return '<div class="cbc-act-panel" style="margin-bottom:12px">' +
        '<div style="font-size:12.5px;margin-bottom:8px"><b>' + esc(s.skill) + '</b> — default: ' + esc(s.defaultProvider) + ' · <span style="font-family:var(--c-mono)">' + esc(s.defaultModel) + '</span></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<select id="cbc-mc-prov" class="cbc-inp">' + provs + '</select>' +
          '<input id="cbc-mc-model" class="cbc-inp" list="cbc-mc-models" placeholder="model id (blank = provider default)" value="' + esc(s.db && s.db.model ? s.db.model : "") + '" style="min-width:230px" />' +
          '<datalist id="cbc-mc-models">' + opts + '</datalist>' +
          '<button class="cbc-btn cbc-primary cbc-sm" data-mc-apply="' + esc(s.skill) + '">Apply</button>' +
          '<button class="cbc-btn cbc-sm" data-mc-cancel>Cancel</button></div></div>';
    }
    host.addEventListener("click", async function (e) {
      var t = e.target.closest ? e.target.closest("[data-mc-edit],[data-mc-reset],[data-mc-apply],[data-mc-cancel]") : null;
      if (!t) return;
      var slot = host.querySelector("#cbc-mc-edit");
      if (t.hasAttribute("data-mc-cancel")) { slot.innerHTML = ""; return; }
      if (t.hasAttribute("data-mc-edit")) {
        var sk = t.getAttribute("data-mc-edit");
        var s = (cfg.skills || []).filter(function (x) { return x.skill === sk; })[0];
        if (s) {
          slot.innerHTML = editForm(s);
          // Refresh the model datalist when the provider select changes.
          var prov = slot.querySelector("#cbc-mc-prov");
          prov.addEventListener("change", function () {
            var dl = slot.querySelector("#cbc-mc-models");
            var cat = cfg.modelCatalog || {};
            dl.innerHTML = (cat[prov.value] || []).map(function (m) { return '<option value="' + esc(m) + '">'; }).join("");
          });
        }
        return;
      }
      t.disabled = true;
      try {
        if (t.hasAttribute("data-mc-apply")) {
          var provider = (host.querySelector("#cbc-mc-prov") || {}).value || "";
          var model = ((host.querySelector("#cbc-mc-model") || {}).value || "").trim();
          await D().setModelRoute(t.getAttribute("data-mc-apply"), provider, model);
          toast("Route updated — live within 60s");
        } else if (t.hasAttribute("data-mc-reset")) {
          await D().clearModelRoute(t.getAttribute("data-mc-reset"));
          toast("Route reset to default");
        }
        load(bodyEl); // repaint with fresh effective routes
      } catch (err) {
        t.disabled = false;
        toast((err && err.message) ? err.message : "Change failed.");
      }
    });
  }

  async function load(bodyEl) {
    bodyEl.innerHTML = '<section class="cbc-kpis cbc-kpis--4">' + U().kpiSkeleton(4) + '</section>';
    var both = await Promise.all([D().loadAiHealth(), D().loadModelControl()]);
    var h = both[0], mc = both[1];
    bodyEl.innerHTML =
      U().sampleBadge(h._mock, "console-ai-health", "AI cost + failures") +
      '<section class="cbc-kpis cbc-kpis--4">' + (h.kpis || []).map(U().kpiCard).join("") + '</section>' +
      modelControlPanel(mc) +
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
    bindModelControl(bodyEl, mc);
  }

  window.CBConsole.sections.ai = { load: load };
})();
