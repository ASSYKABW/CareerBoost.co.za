// CareerBoost Console — Growth & Marketing section (Phase 2 — final section).
//
// Registers window.CBConsole.sections.growth = { load(bodyEl) }. Renders:
//   - KPI strip: signups 30d / activation rate / referrals 30d / push devices
//   - Acquisition channels (utm_source → referrer_host → direct) with conv%
//   - Funnel: signed up → onboarded → engaged → paid (30d)
//   - Referrals: totals + top referrers
//   - A/B experiments: status / variants / winner
//   - Content scorecard: views / clicks / attributed signups
//   - Lifecycle: email drips + push health
// Read-only. Grounded via console-growth (which degrades gracefully when the
// 0036–0042 marketing tables aren't applied yet). Uses the shared
// kpiCard/kpiSkeleton/sampleBadge helpers from CBConsole.util.
(function () {
  window.CBConsole = window.CBConsole || {};
  window.CBConsole.sections = window.CBConsole.sections || {};
  var U = function () { return window.CBConsole.util; };
  var D = function () { return window.CBConsole.data; };
  function esc(s) { return U().escapeHtml(s); }

  function channelsTable(channels) {
    if (!channels || !channels.length) return '<div style="color:var(--c-muted);font-size:12.5px">No attributed signups in the last 30 days.</div>';
    var body = channels.map(function (c) {
      var tone = c.conv >= 60 ? "green" : c.conv >= 40 ? "cyan" : "amber";
      return '<tr><td>' + esc(c.channel) + '</td><td class="n">' + c.signups + '</td><td class="n">' + c.activated + '</td>' +
        '<td class="n"><span class="cbc-chip ' + tone + '">' + c.conv + '%</span></td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Channel</th><th style="text-align:right">Signups</th><th style="text-align:right">Activated</th><th style="text-align:right">Conv.</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function funnelPanel(funnel) {
    var rows = (funnel || []).map(function (f) {
      return '<div class="cbc-qbar"><div class="cbc-ql"><span>' + esc(f.stage) + '</span><span>' + f.count + ' · ' + f.pct + '%</span></div>' +
        '<div class="cbc-track"><i style="width:' + Math.max(2, Math.min(100, f.pct)) + '%"></i></div></div>';
    }).join("");
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Pipeline</div><h2>Signup funnel (30d)</h2></div></div>' +
      (rows || '<div style="color:var(--c-muted);font-size:12.5px">No signups yet this month.</div>') + '</div>';
  }

  function referralsPanel(r) {
    r = r || { confirmed: 0, rewarded: 0, pending: 0, top: [] };
    var stats =
      '<div style="display:flex;gap:26px;margin-bottom:14px">' +
        '<div><div style="font-family:var(--c-mono);font-size:24px;font-weight:700">' + (r.confirmed || 0) + '</div><div style="font-size:11.5px;color:var(--c-muted)">confirmed</div></div>' +
        '<div><div style="font-family:var(--c-mono);font-size:24px;font-weight:700">' + (r.rewarded || 0) + '</div><div style="font-size:11.5px;color:var(--c-muted)">rewarded</div></div>' +
        '<div><div style="font-family:var(--c-mono);font-size:24px;font-weight:700">' + (r.pending || 0) + '</div><div style="font-size:11.5px;color:var(--c-muted)">pending</div></div>' +
      '</div>';
    var top = (r.top && r.top.length)
      ? r.top.map(function (t) {
          return '<div class="cbc-fi green"><span class="cbc-fd"></span><div><div class="cbc-ft">' + esc(t.email) + '</div>' +
            '<div class="cbc-fm">' + t.count + ' referral' + (t.count === 1 ? '' : 's') + '</div></div></div>';
        }).join("")
      : '<div style="color:var(--c-muted);font-size:12.5px">No referrers yet — the leaderboard fills as invites convert.</div>';
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Growth loop</div><h2>Referrals</h2></div></div>' +
      stats + '<div class="cbc-dw-sec" style="margin-top:4px">Top referrers</div>' + top + '</div>';
  }

  function experimentsTable(exps) {
    if (!exps || !exps.length) return '<div style="color:var(--c-muted);font-size:12.5px">No experiments yet. Create one in Content Studio (legacy admin) — it shows up here.</div>';
    var body = exps.map(function (e) {
      var tone = e.status === "running" ? "green" : e.status === "done" ? "violet" : "dim";
      var winner = e.winner ? '<span class="cbc-chip cyan">' + esc(e.winner) + '</span>' : '<span style="color:var(--c-dim)">—</span>';
      return '<tr><td><div style="font-weight:600">' + esc(e.name) + '</div><div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(e.key) + '</div></td>' +
        '<td><span class="cbc-chip ' + tone + '">' + esc(e.status) + '</span></td>' +
        '<td class="n">' + e.variants + '</td><td class="n">' + winner + '</td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Experiment</th><th>Status</th><th style="text-align:right">Variants</th><th style="text-align:right">Winner</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function contentTable(content) {
    if (!content || !content.length) return '<div style="color:var(--c-muted);font-size:12.5px">No content pieces tracked yet.</div>';
    var body = content.map(function (c) {
      return '<tr><td><div style="font-weight:600">' + esc(c.title) + '</div><div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(c.slug) + '</div></td>' +
        '<td class="n">' + c.views + '</td><td class="n">' + c.clicks + '</td><td class="n">' + c.signups + '</td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Piece</th><th style="text-align:right">Views</th><th style="text-align:right">Clicks</th><th style="text-align:right">Signups</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function lifecyclePanel(l) {
    l = l || {};
    function stat(v, label) {
      return '<div><div style="font-family:var(--c-mono);font-size:24px;font-weight:700">' + (v || 0) + '</div><div style="font-size:11.5px;color:var(--c-muted)">' + label + '</div></div>';
    }
    var pushNote = (l.pushStale || 0) > 0
      ? '<span class="cbc-chip amber">' + l.pushStale + ' stale device' + (l.pushStale === 1 ? '' : 's') + '</span>'
      : '<span class="cbc-chip green">healthy</span>';
    return '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Lifecycle</div><h2>Email &amp; push</h2></div>' + pushNote + '</div>' +
      '<div class="cbc-dw-sec" style="margin-top:0">Email drips</div>' +
      '<div style="display:flex;gap:26px;margin-bottom:16px">' +
        stat(l.enrolled, "enrolled") + stat(l.completed, "completed") + stat(l.stopped, "stopped") +
      '</div>' +
      '<div class="cbc-dw-sec">Web push</div>' +
      '<div style="display:flex;gap:26px">' + stat(l.pushDevices, "devices") + stat(l.pushStale, "stale") + '</div></div>';
  }

  // ── Marketing Copilot panel (drafts approval queue) ────────────────
  var PLATFORM_TONE = { linkedin: "cyan", facebook: "green", tiktok: "violet", x: "dim", instagram: "amber" };
  var lastRun = null; // last copilot run summary — survives the queue re-render
  function runSummaryHtml(r) {
    return '<div class="cbc-act-panel" style="margin-bottom:12px"><b>Copilot</b>' + (r._mock ? ' <span class="cbc-chip amber">sample</span>' : "") +
      '<div style="font-size:12.5px;margin-top:5px;white-space:pre-wrap">' + esc(r.result || r.error || "Done.") + '</div>' +
      (r.costUsd ? '<div style="font-size:11px;color:var(--c-dim);margin-top:5px;font-family:var(--c-mono)">run cost $' + Number(r.costUsd).toFixed(2) + '</div>' : "") + '</div>';
  }
  var STATUS_TONE = { draft: "amber", approved: "cyan", posted: "green", rejected: "red" };
  function draftCard(d) {
    var btns = "";
    if (d.status === "draft") {
      btns = '<button class="cbc-btn cbc-sm" data-mk-copy="' + esc(d.id) + '"><i class="fa-solid fa-copy"></i> Copy</button>' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-status="approved" data-mk-id="' + esc(d.id) + '">Approve</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-mk-status="rejected" data-mk-id="' + esc(d.id) + '">Reject</button>';
    } else if (d.status === "approved") {
      btns = '<button class="cbc-btn cbc-primary cbc-sm" data-mk-copy="' + esc(d.id) + '"><i class="fa-solid fa-copy"></i> Copy to post</button>' +
        '<button class="cbc-btn cbc-sm" data-mk-status="posted" data-mk-id="' + esc(d.id) + '"><i class="fa-solid fa-check"></i> Mark posted</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-mk-status="rejected" data-mk-id="' + esc(d.id) + '">Reject</button>';
    } else if (d.status === "posted") {
      btns = '<button class="cbc-btn cbc-sm" data-mk-copy="' + esc(d.id) + '"><i class="fa-solid fa-copy"></i> Copy</button>';
    } else {
      btns = '<button class="cbc-btn cbc-danger cbc-sm" data-mk-del="' + esc(d.id) + '"><i class="fa-solid fa-trash"></i> Delete</button>';
    }
    return '<div class="cbc-card" style="padding:13px 14px;margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
        '<span class="cbc-chip ' + (PLATFORM_TONE[d.platform] || "dim") + '">' + esc(d.platform) + '</span>' +
        '<span class="cbc-chip ' + (STATUS_TONE[d.status] || "dim") + '">' + esc(d.status) + '</span>' +
        '<span style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(String(d.created_at || "").slice(0, 10)) + '</span>' +
        '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">' + btns + '</span></div>' +
      (d.hook ? '<div style="font-weight:700;margin-bottom:6px">' + esc(d.hook) + '</div>' : "") +
      '<div style="font-size:12.5px;line-height:1.55;white-space:pre-wrap;max-height:150px;overflow:auto;color:var(--c-text)">' + esc(d.body) + '</div>' +
      (d.hashtags ? '<div style="font-size:11.5px;color:var(--c-cyan);margin-top:7px">' + esc(d.hashtags) + '</div>' : "") +
      (d.link ? '<div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono);margin-top:3px;word-break:break-all">' + esc(d.link) + '</div>' : "") +
      (d.rationale ? '<div style="font-size:11.5px;color:var(--c-muted);font-style:italic;margin-top:7px"><i class="fa-solid fa-chart-line" style="color:var(--c-violet)"></i> ' + esc(d.rationale) + '</div>' : "") +
      '</div>';
  }
  function copilotPanel(dq) {
    var drafts = (dq && dq.drafts) || [];
    var list = drafts.length
      ? drafts.map(draftCard).join("")
      : '<div style="color:var(--c-muted);font-size:12.5px;padding:6px 0">No proposals yet — hit <b>Generate drafts</b> and the Copilot will study your growth data and propose platform-native content.</div>';
    return '<section class="cbc-card cbc-panel cbc-insights" id="cbc-mk">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Marketing Copilot</div><h2>Content proposals</h2></div>' +
        '<span class="cbc-chip violet"><i class="fa-solid fa-wand-magic-sparkles"></i> agent · copy-paste v1</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
        '<input id="cbc-mk-brief" class="cbc-inp" style="flex:1;min-width:220px" placeholder="Optional brief, e.g. focus on voice mock interviews this week" />' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-gen style="height:34px"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate drafts</button></div>' +
      '<div id="cbc-mk-result">' + (lastRun ? runSummaryHtml(lastRun) : "") + '</div>' +
      '<div id="cbc-mk-list">' + list + '</div></section>';
  }
  function bindCopilot(bodyEl, drafts) {
    var host = bodyEl.querySelector("#cbc-mk"); if (!host) return;
    var toast = (window.CBConsole.ui && window.CBConsole.ui.toast) || function (m) { console.log(m); };
    var byId = {};
    (drafts || []).forEach(function (d) { byId[d.id] = d; });
    host.addEventListener("click", async function (e) {
      var t = e.target.closest ? e.target.closest("[data-mk-gen],[data-mk-copy],[data-mk-status],[data-mk-del]") : null;
      if (!t) return;
      if (t.hasAttribute("data-mk-copy")) {
        var d = byId[t.getAttribute("data-mk-copy")];
        if (d) {
          var text = [d.hook, d.body, d.hashtags, d.link].filter(Boolean).join("\n\n");
          try { await navigator.clipboard.writeText(text); toast("Copied — paste it into " + d.platform); }
          catch (err) { toast("Copy failed — select the text manually"); }
        }
        return;
      }
      t.disabled = true;
      try {
        if (t.hasAttribute("data-mk-gen")) {
          var brief = (host.querySelector("#cbc-mk-brief") || {}).value || "";
          var slot = host.querySelector("#cbc-mk-result");
          if (slot) slot.innerHTML = '<div class="cbc-act-panel" style="margin-bottom:12px"><i class="fa-solid fa-circle-notch fa-spin"></i> Copilot is studying your growth data and writing drafts&hellip; (~30&ndash;60s, budget-capped)</div>';
          var r = await D().runMarketing(brief.trim() || "Study the current growth and content data, then propose this week's content: one LinkedIn post, one Facebook post, and one TikTok script.");
          lastRun = r; // shown by copilotPanel after the reload below
          load(bodyEl); // refresh queue with new drafts
          return;
        }
        if (t.hasAttribute("data-mk-status")) {
          await D().updateDraft(t.getAttribute("data-mk-id"), t.getAttribute("data-mk-status"));
          toast("Draft " + t.getAttribute("data-mk-status"));
          load(bodyEl);
          return;
        }
        if (t.hasAttribute("data-mk-del")) {
          await D().deleteDraft(t.getAttribute("data-mk-del"));
          toast("Draft deleted");
          load(bodyEl);
          return;
        }
      } catch (err) {
        t.disabled = false;
        toast((err && err.message) ? err.message : "Action failed.");
      }
    });
  }

  async function load(bodyEl) {
    bodyEl.innerHTML = '<section class="cbc-kpis cbc-kpis--4">' + U().kpiSkeleton(4) + '</section>';
    var both = await Promise.all([D().loadGrowth(), D().loadDrafts()]);
    var g = both[0], dq = both[1];
    bodyEl.innerHTML =
      U().sampleBadge(g._mock, "console-growth", "acquisition + marketing data") +
      copilotPanel(dq) +
      '<section class="cbc-kpis cbc-kpis--4">' + (g.kpis || []).map(U().kpiCard).join("") + '</section>' +
      '<section class="cbc-grid cbc-g-2a">' +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Acquisition</div><h2>Channels (30d)</h2></div></div>' + channelsTable(g.channels) + '</div>' +
        funnelPanel(g.funnel) +
      '</section>' +
      '<section class="cbc-grid cbc-g-2b">' +
        referralsPanel(g.referrals) +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Optimization</div><h2>A/B experiments</h2></div></div>' + experimentsTable(g.experiments) + '</div>' +
      '</section>' +
      '<section class="cbc-grid cbc-g-2a">' +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Content</div><h2>Content scorecard</h2></div></div>' + contentTable(g.content) + '</div>' +
        lifecyclePanel(g.lifecycle) +
      '</section>';
    bodyEl.querySelectorAll(".cbc-num[data-count]").forEach(function (n) {
      U().countUp(n, Number(n.getAttribute("data-count")), n.getAttribute("data-fmt"));
    });
    bindCopilot(bodyEl, (dq && dq.drafts) || []);
  }

  window.CBConsole.sections.growth = { load: load };
})();
