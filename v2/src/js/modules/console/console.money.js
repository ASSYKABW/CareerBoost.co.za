// CareerBoost Console — Money section (Phase 2).
//
// Registers window.CBConsole.sections.money = { load(bodyEl) }. Renders the
// revenue board from console-money: KPI strip (MRR / active paid / churn /
// past due), active-paid-by-plan breakdown, promotions performance, and a
// failed-payments queue. Read-only; the "Recover" / "Manage promos" buttons
// point at the existing admin surfaces for now (data-toast).
(function () {
  window.CBConsole = window.CBConsole || {};
  window.CBConsole.sections = window.CBConsole.sections || {};
  var U = function () { return window.CBConsole.util; };
  var D = function () { return window.CBConsole.data; };
  function esc(s) { return U().escapeHtml(s); }

  function sampleBadge(on) {
    if (!on) return "";
    return '<div style="margin-bottom:13px;font-size:12px;color:var(--c-amber);background:rgba(255,157,74,.08);border:1px solid rgba(255,157,74,.22);border-radius:10px;padding:8px 12px">' +
      '<i class="fa-solid fa-flask"></i> Sample data — deploy <code>console-money</code> and sign in with MFA to see real revenue.</div>';
  }

  function kpiCard(d) {
    var col = d.tone === "green" ? "#22c55e" : d.tone === "amber" ? "#ff9d4a" : d.tone === "violet" ? "#b06bff" : "#22e3ff";
    var arrow = d.deltaDir === "down" ? "▼ " : "▲ ";
    var spark = (d.spark && d.spark.length)
      ? '<svg class="cbc-spark" viewBox="0 0 200 30" preserveAspectRatio="none"><path d="' + U().sparkPath(d.spark, 200, 30) + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : "";
    return '<div class="cbc-card cbc-kpi cbc-' + d.tone + '"><span class="cbc-ac"></span>' +
      '<div class="cbc-lab">' + esc(d.label) + '</div>' +
      '<div class="cbc-rw"><div class="cbc-num" data-count="' + d.value + '" data-fmt="' + esc(d.fmt) + '">0</div>' +
      '<span class="cbc-delta ' + d.deltaDir + '">' + arrow + esc(d.delta) + '</span></div>' + spark + '</div>';
  }

  function plansTable(plans) {
    if (!plans || !plans.length) return '<div style="color:var(--c-muted);font-size:12.5px">No active paid subscriptions yet.</div>';
    var body = plans.map(function (p) {
      return '<tr><td><span class="cbc-chip ' + p.planTone + '">' + esc(p.plan) + '</span></td>' +
        '<td class="n">' + p.count + '</td><td class="n">R ' + Number(p.mrr).toLocaleString() + '</td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Plan</th><th style="text-align:right">Subs</th><th style="text-align:right">MRR</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function promoPanel(p) {
    p = p || {};
    var status = p.active
      ? '<span class="cbc-chip green"><span class="cbc-dot"></span> live · ' + (p.percent || 0) + '% off</span>' + (p.endDate ? ' <span style="font-size:12px;color:var(--c-muted)">ends ' + esc(p.endDate) + '</span>' : '')
      : '<span class="cbc-chip dim">no active campaign</span>';
    var g = p.grants || { active: 0, redeemed: 0 };
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Marketing</div><h2>Promotions</h2></div></div>' +
      '<div style="margin-bottom:16px">' + status + '</div>' +
      '<div style="display:flex;gap:26px">' +
        '<div><div style="font-family:var(--c-mono);font-size:24px;font-weight:700">' + g.active + '</div><div style="font-size:11.5px;color:var(--c-muted)">active grants</div></div>' +
        '<div><div style="font-family:var(--c-mono);font-size:24px;font-weight:700">' + g.redeemed + '</div><div style="font-size:11.5px;color:var(--c-muted)">redeemed</div></div>' +
      '</div>' +
      '<div class="cbc-qa" style="margin-top:18px"><button class="cbc-btn cbc-sm" data-toast="Promotions live in the legacy admin for now"><i class="fa-solid fa-tag"></i> Manage promos</button></div></div>';
  }

  function failedPanel(failed) {
    var rows = (failed && failed.length)
      ? failed.map(function (f) {
          return '<div class="cbc-att-it"><div class="cbc-att-ic amber"><i class="fa-solid fa-credit-card"></i></div>' +
            '<div class="cbc-tx">' + esc(f.email) + '<small>' + esc(f.plan) + ' · since ' + esc(f.since) + '</small></div>' +
            '<div class="cbc-rt"><button class="cbc-btn cbc-sm cbc-amber" data-toast="Payment recovery lives in the legacy admin for now">Recover</button></div></div>';
        }).join("")
      : '<div style="color:var(--c-muted);font-size:12.5px;padding:8px 0"><i class="fa-solid fa-circle-check" style="color:var(--c-ok)"></i> No failed payments — all subscriptions current.</div>';
    return '<div class="cbc-card cbc-panel cbc-att"><div class="cbc-ph"><div><div class="cbc-eb">Needs you</div><h2>Failed payments</h2></div></div>' + rows + '</div>';
  }

  function skeleton() {
    var r = ""; for (var i = 0; i < 4; i++) r += '<div class="cbc-card cbc-kpi"><div class="cbc-skel" style="height:74px"></div></div>';
    return r;
  }

  async function load(bodyEl) {
    bodyEl.innerHTML = '<section class="cbc-kpis cbc-kpis--4">' + skeleton() + '</section>';
    var m = await D().loadMoney();
    var mrr = (m.kpis && m.kpis[0] && m.kpis[0].value) || 0;
    bodyEl.innerHTML =
      sampleBadge(m._mock) +
      '<section class="cbc-kpis cbc-kpis--4">' + (m.kpis || []).map(kpiCard).join("") + '</section>' +
      '<section class="cbc-grid cbc-g-2a">' +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Revenue</div><h2>Active paid by plan</h2></div>' +
          '<span class="cbc-chip green">MRR R ' + Number(mrr).toLocaleString() + '</span></div>' + plansTable(m.plans) + '</div>' +
        promoPanel(m.promo) +
      '</section>' +
      '<section class="cbc-grid">' + failedPanel(m.failed) + '</section>';
    bodyEl.querySelectorAll(".cbc-num[data-count]").forEach(function (n) {
      U().countUp(n, Number(n.getAttribute("data-count")), n.getAttribute("data-fmt"));
    });
  }

  window.CBConsole.sections.money = { load: load };
})();
