// CareerBoost Console — Money section (Phase 2).
//
// Registers window.CBConsole.sections.money = { load(bodyEl) }. Renders the
// revenue board from console-money: KPI strip (MRR / active paid / churn /
// past due), active-paid-by-plan breakdown, promotions performance, and a
// failed-payments queue.
//
// MRR counts only subscriptions with a payment processor behind them. Comps
// (admin-granted free months) look identical to paid rows apart from the money,
// so they are reported separately — see the integrity note under the plans
// table. Read-only apart from "Manage promos", which opens the Promo Center.
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
      var comped = Number(p.comped) || 0;
      return '<tr><td><span class="cbc-chip ' + p.planTone + '">' + esc(p.plan) + '</span></td>' +
        '<td class="n">' + p.count + (comped ? ' <span style="color:var(--c-dim);font-size:11px">+' + comped + ' comped</span>' : '') + '</td>' +
        '<td class="n">R ' + Number(p.mrr).toLocaleString() + '</td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Plan</th><th style="text-align:right">Paying</th><th style="text-align:right">MRR</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  // What MRR deliberately excludes, and what it may be over-counting. Silent on
  // a clean board — it only speaks when a number needs a caveat.
  function integrityNote(it) {
    it = it || {};
    var lines = [];
    if (Number(it.comped) > 0) {
      lines.push('<i class="fa-solid fa-gift" style="color:var(--c-cyan)"></i> ' + it.comped + ' comped ' +
        (it.comped === 1 ? 'account' : 'accounts') + ' on a paid tier — excluded from MRR (would add R ' +
        Number(it.compedValue || 0).toLocaleString() + ' if counted).');
    }
    if (Number(it.stalePaid) > 0) {
      lines.push('<i class="fa-solid fa-triangle-exclamation" style="color:var(--c-amber)"></i> ' + it.stalePaid + ' paid ' +
        (it.stalePaid === 1 ? 'subscription has' : 'subscriptions have') + ' a billing period that already ended and nothing renewed ' +
        (it.stalePaid === 1 ? 'it' : 'them') + ' — R ' + Number(it.staleValue || 0).toLocaleString() +
        ' of MRR here depends on the processor webhook having fired.');
    }
    if (!lines.length) return "";
    return '<div style="margin-top:12px;font-size:11.5px;color:var(--c-muted);line-height:1.7">' + lines.join("<br/>") + "</div>";
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
      '<div class="cbc-qa" style="margin-top:18px"><button class="cbc-btn cbc-sm" data-qa-promo-cfg><i class="fa-solid fa-tag"></i> Manage promos</button></div></div>';
  }

  function failedPanel(failed) {
    var rows = (failed && failed.length)
      ? failed.map(function (f) {
          return '<div class="cbc-att-it"><div class="cbc-att-ic amber"><i class="fa-solid fa-credit-card"></i></div>' +
            '<div class="cbc-tx">' + esc(f.email) + '<small>' + esc(f.plan) + ' · since ' + esc(f.since) + '</small></div>' +
            '<div class="cbc-rt"><button class="cbc-btn cbc-sm cbc-amber" data-toast="Automated payment recovery isn\'t built yet — chase this one from the Paystack dashboard.">Recover</button></div></div>';
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
          '<span class="cbc-chip green">MRR R ' + Number(mrr).toLocaleString() + '</span></div>' +
          plansTable(m.plans) + integrityNote(m.integrity) + '</div>' +
        promoPanel(m.promo) +
      '</section>' +
      '<section class="cbc-grid">' + failedPanel(m.failed) + '</section>';
    bodyEl.querySelectorAll(".cbc-num[data-count]").forEach(function (n) {
      U().countUp(n, Number(n.getAttribute("data-count")), n.getAttribute("data-fmt"));
    });
  }

  window.CBConsole.sections.money = { load: load };
})();
