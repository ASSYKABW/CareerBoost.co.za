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

  // kpiCard / kpiSkeleton / sampleBadge come from CBConsole.util (shared).
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

  async function load(bodyEl) {
    bodyEl.innerHTML = '<section class="cbc-kpis cbc-kpis--4">' + U().kpiSkeleton(4) + '</section>';
    var m = await D().loadMoney();
    var mrr = (m.kpis && m.kpis[0] && m.kpis[0].value) || 0;
    bodyEl.innerHTML =
      U().sampleBadge(m._mock, "console-money", "revenue") +
      '<section class="cbc-kpis cbc-kpis--4">' + (m.kpis || []).map(U().kpiCard).join("") + '</section>' +
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
