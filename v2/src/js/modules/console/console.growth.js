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
  function toast(m) {
    var f = window.CBConsole.ui && window.CBConsole.ui.toast;
    if (f) f(m); else console.log(m);
  }

  // ── Section IA ───────────────────────────────────────────────────────
  // Growth used to be eleven panels in one scroll: visitor analytics, the
  // content engine, referral loops and lifecycle email all stacked together,
  // so nothing announced what it was for. These are four separate workspaces —
  // pick one, see only that. Same idea as the interview prep mode toggle:
  // one segmented control swaps the whole body instead of asking the reader to
  // scroll past four unrelated jobs to find theirs.
  //
  // The KPI strip used to sit in the middle mixing all four topics at once;
  // each KPI now lives in the tab it actually belongs to. Pulse is where the
  // cross-section glance belongs — Growth is the deep dive.
  var GROWTH_TABS = [
    { id: "traffic", label: "Traffic", icon: "fa-arrow-trend-up",
      hint: "Who reaches the site, where from, and how many become accounts." },
    { id: "content", label: "Content", icon: "fa-pen-nib",
      hint: "The market scan, this week's schedule, and drafts waiting on you." },
    { id: "loops", label: "Referrals & tests", icon: "fa-flask",
      hint: "Existing users bringing new ones, and the experiments running on them." },
    { id: "messaging", label: "Email & push", icon: "fa-paper-plane",
      hint: "Lifecycle drips and the devices reachable by push." }
  ];
  var activeTab = "traffic";
  var cache = { g: null, dq: null };

  function tabById(id) {
    for (var i = 0; i < GROWTH_TABS.length; i++) if (GROWTH_TABS[i].id === id) return GROWTH_TABS[i];
    return GROWTH_TABS[0];
  }

  function tabsHtml(active) {
    return '<div class="cbc-gt">' +
      '<div class="cbc-seg cbc-seg--tabs" role="tablist" aria-label="Growth sections">' +
        GROWTH_TABS.map(function (t) {
          var on = t.id === active;
          return '<button type="button" role="tab" aria-selected="' + (on ? "true" : "false") + '"' +
            ' class="' + (on ? "is-on" : "") + '" data-gtab="' + t.id + '">' +
            '<i class="fa-solid ' + t.icon + '" aria-hidden="true"></i> ' + esc(t.label) + "</button>";
        }).join("") +
      "</div>" +
      '<p class="cbc-gt-hint" id="cbc-gt-hint">' + esc(tabById(active).hint) + "</p>" +
      "</div>";
  }

  // KPIs, routed to the tab they describe rather than pooled into one strip.
  function kpisFor(g, keys) {
    var all = g.kpis || [];
    var picked = [];
    keys.forEach(function (k) {
      for (var i = 0; i < all.length; i++) if (all[i].key === k) picked.push(all[i]);
    });
    if (!picked.length) return "";
    return '<section class="cbc-kpis cbc-kpis--' + Math.min(4, picked.length) + '">' +
      picked.map(U().kpiCard).join("") + "</section>";
  }

  // ── Website traffic (anonymous visitors) ────────────────────────────
  // The pre-signup half of the funnel. Before 0053 + usage-ingest this was
  // impossible to see: usage_events.user_id was NOT NULL, so a logged-out page
  // view could not be stored and the product only ever saw people at sign-in.
  function trafficBars(series) {
    if (!series || !series.length) return "";
    var max = 1;
    for (var i = 0; i < series.length; i++) {
      var v = Number(series[i] && series[i].visitors) || 0;
      if (v > max) max = v;
    }
    return '<div class="cbc-tr-bars" role="img" aria-label="Daily visitors, last 14 days">' +
      series.map(function (d) {
        var h = Math.round((d.visitors / max) * 100);
        return '<span class="cbc-tr-bar" style="--h:' + Math.max(d.visitors ? 6 : 2, h) + '%"' +
          ' title="' + esc(d.day) + ': ' + d.visitors + ' visitor' + (d.visitors === 1 ? "" : "s") + '"></span>';
      }).join("") + "</div>";
  }

  function miniList(rows, emptyMsg, labelFmt) {
    if (!rows || !rows.length) return '<div style="color:var(--c-muted);font-size:12.5px">' + esc(emptyMsg) + "</div>";
    var max = Math.max(1, rows[0].count);
    return '<div class="cbc-tr-list">' + rows.map(function (r) {
      var pctw = Math.round((r.count / max) * 100);
      return '<div class="cbc-tr-row"><span class="cbc-tr-nm">' + esc(labelFmt ? labelFmt(r.name) : r.name) + '</span>' +
        '<span class="cbc-tr-track"><i style="width:' + pctw + '%"></i></span>' +
        '<b class="cbc-tr-n">' + r.count + "</b></div>";
    }).join("") + "</div>";
  }

  function sourceLabel(name) {
    if (name === "direct") return "Direct / typed in";
    if (name.indexOf("utm:") === 0) return name.slice(4) + " (tagged)";
    return name;
  }

  function trafficPanel(t) {
    t = t || {};
    if (t.empty) {
      return '<div class="cbc-card cbc-panel" id="cbc-traffic">' +
        '<div class="cbc-ph"><div><div class="cbc-eb">Acquisition</div><h2>Website visitors</h2></div>' +
          '<span class="cbc-chip dim">no visits yet</span></div>' +
        '<div style="color:var(--c-muted);font-size:12.5px;padding:6px 0">' +
          'Tracking is live — every logged-out visit to careerboost.co.za now lands here. ' +
          'Nothing to show yet simply means nobody has visited since it was switched on.' +
        "</div></div>";
    }
    var conv = Number(t.convRate) || 0;
    var convTone = conv >= 5 ? "green" : conv >= 2 ? "amber" : "red";
    var newV = Math.max(0, (Number(t.visitors7) || 0) - (Number(t.returning7) || 0));
    return '<div class="cbc-card cbc-panel" id="cbc-traffic">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Acquisition</div><h2>Website visitors</h2></div>' +
        '<span class="cbc-chip cyan">' + (Number(t.visitors7) || 0) + ' in 7d</span></div>' +

      '<div class="cbc-tr-kpis">' +
        '<div class="cbc-tr-k"><span>Visitors 7d</span><b>' + (Number(t.visitors7) || 0) + "</b></div>" +
        '<div class="cbc-tr-k"><span>Page views 7d</span><b>' + (Number(t.views7) || 0) + "</b></div>" +
        '<div class="cbc-tr-k"><span>New / returning</span><b>' + newV + " / " + (Number(t.returning7) || 0) + "</b></div>" +
        '<div class="cbc-tr-k"><span>Visit → signup 30d</span><b><span class="cbc-chip ' + convTone + '">' + conv + "%</span></b></div>" +
      "</div>" +

      '<div style="font-size:11.5px;color:var(--c-dim);margin:12px 0 4px">Daily visitors · last 14 days</div>' +
      trafficBars(t.series) +

      '<div class="cbc-tr-cols">' +
        '<div><div class="cbc-tr-h">Where they came from (7d)</div>' + miniList(t.sources, "No sessions yet.", sourceLabel) + "</div>" +
        '<div><div class="cbc-tr-h">Top pages (7d)</div>' + miniList(t.topPages, "No page views yet.") + "</div>" +
      "</div>" +

      '<div style="font-size:11.5px;color:var(--c-dim);margin-top:12px">' +
        (Number(t.converted30) || 0) + ' of ' + (Number(t.visitors30) || 0) + ' visitors in the last 30 days went on to create an account. ' +
        'Matched by the anonymous id the browser keeps across signup — no third-party tracker involved.' +
      "</div></div>";
  }

  // ── Step 1: Market data ─────────────────────────────────────────────
  // The fuel for everything else on this tab. Deliberately shows only what the
  // SCAN knows — it used to also carry a "Social drafts" tile and the agent's
  // last error, both of which belong to the on-request writer further down.
  // Putting one system's numbers inside another's panel is exactly what made
  // this section unreadable.
  function marketPanel(e) {
    e = e || {};
    var segs = e.segments || [];
    var scanned = Number(e.scannedTotal) || 0;
    var ok = Number(e.sufficientCount) || 0;

    var state, tone;
    if (!segs.length) { state = "no market data this week"; tone = "amber"; }
    else if (!ok) { state = "scanned, but samples too small to quote"; tone = "amber"; }
    else { state = ok + " of " + segs.length + " segments ready"; tone = "green"; }

    var segLine = segs.length
      ? '<div class="cbc-tr-list" style="margin-top:10px">' + segs.map(function (s) {
          return '<div class="cbc-tr-row"><span class="cbc-tr-nm">' + esc(s.label || s.segment) + '</span>' +
            '<span class="cbc-chip ' + (s.sufficient ? "green" : "dim") + '">' + (s.sufficient ? "quotable" : "thin") + "</span>" +
            '<b class="cbc-tr-n">' + (Number(s.scanned) || 0) + "</b></div>";
        }).join("") + "</div>"
      : '<div style="color:var(--c-muted);font-size:12.5px;margin-top:8px">' +
        'No scan has run for the week of ' + esc(String(e.weekStart || "—")) + '. ' +
        'Until one does, drafts fall back to generic angles instead of this week\'s real numbers.</div>';

    return '<div class="cbc-card cbc-panel" id="cbc-engine">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Step 1 · Fuel</div><h2>Market data</h2></div>' +
        '<span class="cbc-chip ' + tone + '">' + esc(state) + "</span></div>" +
      '<div class="cbc-tr-kpis cbc-tr-kpis--2">' +
        '<div class="cbc-tr-k"><span>Jobs scanned this week</span><b>' + scanned + "</b></div>" +
        '<div class="cbc-tr-k"><span>Segments quotable</span><b>' + ok + " / " + segs.length + "</b></div>" +
      "</div>" +
      segLine +
      '<div class="cbc-qa" style="margin-top:16px"><button class="cbc-btn cbc-sm" data-eng="market-scan">' +
        '<i class="fa-solid fa-radar"></i> Refresh market data</button></div>' +
      '<div style="margin-top:10px;font-size:11.5px;color:var(--c-dim);line-height:1.6">' +
        'Reads the live SA job market and stores one snapshot per week. No AI, no cost, nothing sent to anyone. ' +
        'Everything below is written from these numbers — <b>“quotable”</b> means the sample is big enough to publish a percentage from.' +
      "</div></div>";
  }

  // ── This week's schedule ────────────────────────────────────────────
  // The week as a plan, not a pile of drafts: one row per day, each showing
  // the angle it leans on so two rows can never quietly be the same post.
  var FORMAT_LABEL = { blog: "Blog", social_linkedin: "LinkedIn", social_x: "X", newsletter: "Newsletter" };
  var STATUS_TONE = { needs_review: "amber", approved: "green", published: "green", scheduled: "cyan", draft: "dim", rejected: "dim" };

  function angleLabel(id) {
    var a = String(id || "").split(":").pop().replace(/_/g, " ");
    return a || "—";
  }

  function schedulePanel(e) {
    e = e || {};
    var rows = (e.schedule || []).slice().sort(function (a, b) { return (a.dayIdx || 0) - (b.dayIdx || 0); });
    var head = '<div class="cbc-ph"><div><div class="cbc-eb">Step 2 · Planned</div><h2>This week&rsquo;s schedule</h2></div>' +
      (rows.length ? '<span class="cbc-chip cyan">' + rows.length + ' planned</span>' : '<span class="cbc-chip dim">not produced yet</span>') +
      "</div>";
    // Newsletter and publish live here, with the week they belong to — they sat
    // in the market panel before, which is only the fuel.
    var extras = '<button class="cbc-btn cbc-sm" data-eng="newsletter-draft"><i class="fa-solid fa-envelope"></i> Weekly newsletter</button>' +
      '<button class="cbc-btn cbc-sm" data-eng="draft"><i class="fa-solid fa-pen-nib"></i> One extra piece</button>' +
      '<button class="cbc-btn cbc-sm" data-eng="publish-due"><i class="fa-solid fa-paper-plane"></i> Publish due</button>';

    if (!rows.length) {
      return '<div class="cbc-card cbc-panel" id="cbc-sched">' + head +
        '<div style="color:var(--c-muted);font-size:12.5px;padding:6px 0;line-height:1.7">' +
          'No schedule for the week of ' + esc(String(e.weekStart || "—")) + ' yet. ' +
          '<b>Produce this week\'s schedule</b> plans five slots — two long-form, two LinkedIn, one X — each built on a ' +
          'different finding from the market scan, then writes them. Every draft lands as <b>needs_review</b>; nothing publishes itself.' +
        "</div>" +
        '<div class="cbc-qa" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><button class="cbc-btn cbc-sm cbc-primary" data-eng="weekly-schedule">' +
          '<i class="fa-solid fa-calendar-week"></i> Produce this week\'s schedule</button>' +
          '<button class="cbc-btn cbc-sm" data-eng-plan="1"><i class="fa-solid fa-eye"></i> Preview the plan first</button>' +
          extras + "</div>" +
        "</div>";
    }

    var body = rows.map(function (r) {
      var tone = STATUS_TONE[r.status] || "dim";
      var fmt = FORMAT_LABEL[r.type] || r.type;
      return '<tr>' +
        '<td><b>' + esc(r.day || "—") + '</b><div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(r.date || "") + '</div></td>' +
        '<td><span class="cbc-chip ' + (r.type === "blog" ? "violet" : "cyan") + '">' + esc(fmt) + '</span></td>' +
        '<td><div style="font-weight:600">' + esc(r.title || "(untitled)") + '</div>' +
          '<div style="font-size:11px;color:var(--c-dim)">' + esc(r.segment || "—") + ' · ' + esc(angleLabel(r.angle)) + '</div></td>' +
        '<td><span class="cbc-chip ' + tone + '">' + esc(String(r.status || "").replace(/_/g, " ")) + '</span></td>' +
        "</tr>";
    }).join("");

    var angles = {};
    rows.forEach(function (r) { angles[r.angle] = 1; });
    var distinct = Object.keys(angles).length;

    return '<div class="cbc-card cbc-panel" id="cbc-sched">' + head +
      '<table class="cbc-table"><thead><tr><th>Day</th><th>Format</th><th>Piece</th><th>Status</th></tr></thead><tbody>' + body + "</tbody></table>" +
      '<div style="margin-top:12px;font-size:11.5px;color:var(--c-dim);line-height:1.6">' +
        distinct + ' distinct ' + (distinct === 1 ? "angle" : "angles") + ' across ' + rows.length + ' ' +
        (rows.length === 1 ? "slot" : "slots") + ' — the planner refuses to reuse an angle inside a week, ' +
        'so a short week means the scan found fewer stories, not that something broke.' +
      "</div>" +
      '<div class="cbc-qa" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><button class="cbc-btn cbc-sm" data-eng="weekly-schedule">' +
        '<i class="fa-solid fa-rotate"></i> Fill any empty days</button>' + extras + "</div>" +
      "</div>";
  }

  // Preview: plans the week without writing anything. Instant and free — it
  // never calls a model, so the operator can see the shape before committing.
  function planPreviewHtml(r) {
    var rows = (r.slots || []).map(function (s) {
      return '<tr><td><b>' + esc(s.day) + '</b><div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(s.date) + '</div></td>' +
        '<td><span class="cbc-chip ' + (s.format === "blog" ? "violet" : "cyan") + '">' + esc(FORMAT_LABEL[s.format] || s.format) + '</span></td>' +
        '<td><div style="font-weight:600">' + esc(s.hook || angleLabel(s.angle)) + '</div>' +
          '<div style="font-size:11px;color:var(--c-dim)">' + esc(s.label || s.segment) + ' · ' + esc(angleLabel(s.angle)) + '</div></td></tr>';
    }).join("");
    return '<button class="cbc-dw-x" data-drawer-close><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="cbc-dw-hd"><div class="cbc-dw-av" style="background:linear-gradient(135deg,#22e3ff,#6b7dff)"><i class="fa-solid fa-calendar-week"></i></div>' +
        '<div><div class="cbc-nm">Week of ' + esc(r.week_start || "") + '</div><div class="cbc-em">' +
          (r.slots || []).length + ' slots · ' + (r.distinctAngles || 0) + ' distinct angles</div></div></div>' +
      '<table class="cbc-table"><thead><tr><th>Day</th><th>Format</th><th>Angle</th></tr></thead><tbody>' + rows + "</tbody></table>" +
      '<div style="margin-top:14px;font-size:11.5px;color:var(--c-dim);line-height:1.6">Nothing has been written yet — this is the plan only. ' +
        'Close this and hit <b>Produce this week\'s schedule</b> to write the drafts.</div>';
  }

  async function engineAction(bodyEl, t) {
    var isPlan = t.hasAttribute("data-eng-plan");
    var task = isPlan ? "weekly-schedule" : t.getAttribute("data-eng");
    var label = t.innerHTML;
    var busy = task === "market-scan" ? "Scanning the market…"
      : (task === "weekly-schedule" && !isPlan) ? "Planning and writing the week…"
      : "Working…";
    t.disabled = true;
    t.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> ' + busy;
    try {
      var r = await D().runMarketingTask(task, isPlan ? { plan: true } : null);
      if (isPlan) {
        t.disabled = false; t.innerHTML = label;
        if (window.CBConsole.ui && window.CBConsole.ui.openDrawer) window.CBConsole.ui.openDrawer(planPreviewHtml(r));
        else toast((r.slots || []).length + " slots planned across " + (r.distinctAngles || 0) + " distinct angles.");
        return;
      }
      var msg = "Done.";
      if (task === "market-scan" && r && r.segments) {
        var total = r.segments.reduce(function (n, s) { return n + (Number(s.scanned) || 0); }, 0);
        var good = r.segments.filter(function (s) { return s.sufficient; }).length;
        msg = total
          ? "Scanned " + total + " jobs — " + good + " of " + r.segments.length + " segments have enough data to quote."
          : "The scan returned no jobs. The job providers may be rate-limited — try again shortly.";
      } else if (task === "weekly-schedule" && r) {
        var fails = (r.failures || []).length;
        msg = "Week of " + r.week_start + ": " + r.generated + " written across " +
          (r.distinctAngles || 0) + " distinct angles." +
          (fails ? " " + fails + " slot" + (fails === 1 ? "" : "s") + " didn't finish — run it again to top up." : "");
      } else if (r && r.piece) { msg = "Draft created — it's in the review queue."; }
      toast(msg);
      cache.dq = null; // these tasks mint drafts — force a refetch
      load(bodyEl);
    } catch (err) {
      t.disabled = false;
      t.innerHTML = label;
      var m = (err && err.message) ? err.message : "That task failed.";
      if (/market scan/i.test(m)) toast(m); // already a plain-English instruction
      else toast(/credit|quota|too low/i.test(m) ? "The AI provider is out of credit — scanning still works, but writing needs a top-up." : m);
    }
  }

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
    if (!exps || !exps.length) return '<div style="color:var(--c-muted);font-size:12.5px">No experiments yet. Nothing creates them from the Console — they are seeded directly in <code>marketing_experiments</code> for now.</div>';
    var body = exps.map(function (e) {
      var tone = e.status === "running" ? "green" : e.status === "done" ? "violet" : "dim";
      var winner = e.winner ? '<span class="cbc-chip cyan">' + esc(e.winner) + '</span>' : '<span style="color:var(--c-dim)">—</span>';
      return '<tr><td><div style="font-weight:600">' + esc(e.name) + '</div><div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(e.key) + '</div></td>' +
        '<td><span class="cbc-chip ' + tone + '">' + esc(e.status) + '</span></td>' +
        '<td class="n">' + e.variants + '</td><td class="n">' + winner + '</td></tr>';
    }).join("");
    return '<table class="cbc-table"><thead><tr><th>Experiment</th><th>Status</th><th style="text-align:right">Variants</th><th style="text-align:right">Winner</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function contentTable(content, pieces) {
    // "No content pieces tracked yet" while the engine reported 11 pieces read
    // as a contradiction. Both were true: this table measures PUBLISHED
    // performance, and everything written so far is still awaiting review.
    if (!content || !content.length) {
      var waiting = Number(pieces) || 0;
      return '<div style="color:var(--c-muted);font-size:12.5px;line-height:1.7">' +
        "Nothing published yet, so there's no performance to measure." +
        (waiting ? " <b>" + waiting + "</b> " + (waiting === 1 ? "piece is" : "pieces are") +
          " written and waiting on review above — approve one, then <b>Publish due</b>, and its views, clicks and signups appear here." : "") +
        "</div>";
    }
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
  var viewMode = "list"; // "list" | "calendar"

  // Monday of the week containing the given date string (YYYY-MM-DD local).
  function weekStartOf(dstr) {
    var d = dstr ? new Date(dstr) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var shift = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    d.setDate(d.getDate() - shift);
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  // Calendar view (#4): drafts grouped by planned week — scheduled_for first,
  // else posted_at, else created_at. Compact rows; switch to List to act.
  function calendarHtml(drafts) {
    if (!drafts.length) return '<div style="color:var(--c-muted);font-size:12.5px;padding:6px 0">Nothing planned yet — generate drafts, then set &ldquo;Post on&rdquo; dates via Edit.</div>';
    var groups = {};
    drafts.forEach(function (d) {
      var wk = weekStartOf(d.scheduled_for || d.posted_at || d.created_at);
      (groups[wk] = groups[wk] || []).push(d);
    });
    var thisWeek = weekStartOf(null);
    return Object.keys(groups).sort().reverse().map(function (wk) {
      var label = wk === thisWeek ? "This week (" + wk + ")" : "Week of " + wk;
      var rows = groups[wk]
        .slice().sort(function (a, b) { return String(a.scheduled_for || "9999").localeCompare(String(b.scheduled_for || "9999")); })
        .map(function (d) {
          return '<div class="cbc-att-it"><div class="cbc-att-ic ' + (d.status === "posted" ? "cyan" : "amber") + '"><i class="fa-solid ' + (d.platform === "tiktok" ? "fa-video" : d.platform === "linkedin" ? "fa-briefcase" : "fa-hashtag") + '"></i></div>' +
            '<div class="cbc-tx">' + esc(d.hook || (d.body || "").slice(0, 60)) +
              '<small><span class="cbc-chip ' + (PLATFORM_TONE[d.platform] || "dim") + '">' + esc(d.platform) + '</span> <span class="cbc-chip ' + (STATUS_TONE[d.status] || "dim") + '">' + esc(d.status) + '</span>' +
              (d.scheduled_for ? ' · post on ' + esc(d.scheduled_for) : "") +
              (d.status === "posted" && d.signups != null ? " · ▲ " + Number(d.signups) + " signups" : "") + '</small></div></div>';
        }).join("");
      return '<div class="cbc-dw-sec" style="margin-top:14px">' + esc(label) + "</div>" + rows;
    }).join("");
  }
  function runSummaryHtml(r) {
    return '<div class="cbc-act-panel" style="margin-bottom:12px"><b>Copilot</b>' + (r._mock ? ' <span class="cbc-chip amber">sample</span>' : "") +
      '<div style="font-size:12.5px;margin-top:5px;white-space:pre-wrap">' + esc(r.result || r.error || "Done.") + '</div>' +
      (r.costUsd ? '<div style="font-size:11px;color:var(--c-dim);margin-top:5px;font-family:var(--c-mono)">run cost $' + Number(r.costUsd).toFixed(2) + '</div>' : "") + '</div>';
  }
  var STATUS_TONE = { draft: "amber", approved: "cyan", posted: "green", rejected: "red" };
  function draftCard(d) {
    var editBtn = '<button class="cbc-btn cbc-sm" data-mk-editd="' + esc(d.id) + '"><i class="fa-solid fa-pen"></i> Edit</button>';
    var btns = "";
    if (d.status === "draft") {
      btns = editBtn +
        '<button class="cbc-btn cbc-sm" data-mk-copy="' + esc(d.id) + '"><i class="fa-solid fa-copy"></i> Copy</button>' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-status="approved" data-mk-id="' + esc(d.id) + '">Approve</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-mk-status="rejected" data-mk-id="' + esc(d.id) + '">Reject</button>';
    } else if (d.status === "approved") {
      btns = editBtn +
        '<button class="cbc-btn cbc-sm" data-mk-copy="' + esc(d.id) + '"><i class="fa-solid fa-copy"></i> Copy</button>' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-pub="' + esc(d.id) + '"><i class="fa-solid fa-paper-plane"></i> Publish</button>' +
        '<button class="cbc-btn cbc-sm" data-mk-status="posted" data-mk-id="' + esc(d.id) + '"><i class="fa-solid fa-check"></i> Mark posted</button>' +
        '<button class="cbc-btn cbc-danger cbc-sm" data-mk-status="rejected" data-mk-id="' + esc(d.id) + '">Reject</button>';
    } else if (d.status === "posted") {
      btns = '<button class="cbc-btn cbc-sm" data-mk-copy="' + esc(d.id) + '"><i class="fa-solid fa-copy"></i> Copy</button>';
    } else {
      btns = '<button class="cbc-btn cbc-danger cbc-sm" data-mk-del="' + esc(d.id) + '"><i class="fa-solid fa-trash"></i> Delete</button>';
    }
    return '<div class="cbc-card" style="padding:13px 14px;margin-bottom:10px" data-mk-card="' + esc(d.id) + '">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
        '<span class="cbc-chip ' + (PLATFORM_TONE[d.platform] || "dim") + '">' + esc(d.platform) + '</span>' +
        '<span class="cbc-chip ' + (STATUS_TONE[d.status] || "dim") + '">' + esc(d.status) + '</span>' +
        (d.status === "posted" && d.signups != null ? '<span class="cbc-chip green">▲ ' + Number(d.signups) + ' signup' + (Number(d.signups) === 1 ? "" : "s") + '</span>' : "") +
        (d.scheduled_for ? '<span class="cbc-chip dim"><i class="fa-solid fa-calendar"></i> ' + esc(String(d.scheduled_for).slice(0, 10)) + '</span>' : "") +
        '<span style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono)">' + esc(String(d.created_at || "").slice(0, 10)) + '</span>' +
        '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">' + btns + '</span></div>' +
      (d.hook ? '<div style="font-weight:700;margin-bottom:6px">' + esc(d.hook) + '</div>' : "") +
      '<div style="font-size:12.5px;line-height:1.55;white-space:pre-wrap;max-height:150px;overflow:auto;color:var(--c-text)">' + esc(d.body) + '</div>' +
      (d.hashtags ? '<div style="font-size:11.5px;color:var(--c-cyan);margin-top:7px">' + esc(d.hashtags) + '</div>' : "") +
      (d.link ? '<div style="font-size:11px;color:var(--c-dim);font-family:var(--c-mono);margin-top:3px;word-break:break-all">' + esc(d.link) + '</div>' : "") +
      (d.rationale ? '<div style="font-size:11.5px;color:var(--c-muted);font-style:italic;margin-top:7px"><i class="fa-solid fa-chart-line" style="color:var(--c-violet)"></i> ' + esc(d.rationale) + '</div>' : "") +
      '</div>';
  }
  // Inline edit form — replaces the card's content until Save/Cancel.
  function editFields(d) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<span class="cbc-chip ' + (PLATFORM_TONE[d.platform] || "dim") + '">' + esc(d.platform) + '</span>' +
        '<span style="font-size:12px;color:var(--c-muted)">Editing draft</span></div>' +
      '<input data-ef-hook class="cbc-inp" style="width:100%;margin-bottom:8px" placeholder="Hook / first line" value="' + esc(d.hook || "") + '" />' +
      '<textarea data-ef-body class="cbc-inp" rows="9" style="width:100%;margin-bottom:8px;line-height:1.5;resize:vertical">' + esc(d.body || "") + '</textarea>' +
      '<input data-ef-hash class="cbc-inp" style="width:100%;margin-bottom:10px" placeholder="#Hashtags" value="' + esc(d.hashtags || "") + '" />' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">' +
        '<span style="font-size:12px;color:var(--c-muted)">Post on</span>' +
        '<input data-ef-sched type="date" class="cbc-inp" value="' + esc(d.scheduled_for || "") + '" />' +
        '<span style="font-size:11px;color:var(--c-dim)">(drives the calendar view)</span></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-save="' + esc(d.id) + '"><i class="fa-solid fa-check"></i> Save</button>' +
        '<button class="cbc-btn cbc-sm" data-mk-cancel>Cancel</button></div>';
  }

  function copilotPanel(dq, engine) {
    var drafts = (dq && dq.drafts) || [];
    var list = viewMode === "calendar"
      ? calendarHtml(drafts)
      : (drafts.length
        ? drafts.map(draftCard).join("")
        : '<div style="color:var(--c-muted);font-size:12.5px;padding:6px 0">Nothing asked for yet. Type what you want covered, or pick a starter below — the writer reads this week&rsquo;s market scan first, then drafts for the platform you need.</div>');
    return '<section class="cbc-card cbc-panel cbc-insights" id="cbc-mk">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Step 3 · On request</div><h2>Ask for a specific post</h2></div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<button class="cbc-btn cbc-sm" data-mk-view="' + (viewMode === "list" ? "calendar" : "list") + '">' +
            (viewMode === "list" ? '<i class="fa-solid fa-calendar"></i> Calendar' : '<i class="fa-solid fa-list"></i> List') + '</button>' +
          '<button class="cbc-btn cbc-sm" data-mk-pubcfg><i class="fa-solid fa-paper-plane"></i> Publishing</button></div></div>' +
      // Step 2 covers the week automatically and writes about the market. This
      // is for the posts only you know you need — about CareerBoost itself, on
      // platforms the schedule doesn't touch (TikTok, Facebook, Instagram).
      '<div style="font-size:11.5px;color:var(--c-dim);line-height:1.6;margin-bottom:12px">' +
        'Step&nbsp;2 writes about <b>the job market</b>, on a fixed weekly rhythm. This writes about <b>CareerBoost</b>, whenever you ask — ' +
        'and reaches TikTok, Facebook and Instagram, which the schedule doesn&rsquo;t. It still quotes only the Step&nbsp;1 numbers; ' +
        'invented statistics are rejected before they reach the queue.' +
      "</div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
        '<input id="cbc-mk-brief" class="cbc-inp" style="flex:1;min-width:220px" placeholder="What should this post be about? e.g. voice mock interviews" />' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-gen style="height:34px"><i class="fa-solid fa-wand-magic-sparkles"></i> Write it</button></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
        '<button class="cbc-btn cbc-sm" data-mk-preset="Campaign week on voice mock interviews — the Pro plan hero feature. Angle: interview nerves are beatable with practice.">🎤 Voice interviews</button>' +
        '<button class="cbc-btn cbc-sm" data-mk-preset="CV / resume tailoring tips for SA job seekers. Angle: generic CVs get silence; tailored ones get replies.">📄 CV tips</button>' +
        '<button class="cbc-btn cbc-sm" data-mk-preset="Referral push: invite a friend who is job hunting. Warm, community angle.">🤝 Referrals</button>' +
        '<button class="cbc-btn cbc-sm" data-mk-preset="Free plan awareness: you can start the whole workflow free, no card. Angle: lower the barrier.">🆓 Free plan</button></div>' +
      '<div id="cbc-mk-pubcfg"></div>' +
      '<div id="cbc-mk-result">' + (lastRun ? runSummaryHtml(lastRun) : agentHealthNote(engine)) + '</div>' +
      '<div id="cbc-mk-list">' + list + '</div></section>';
  }

  // The writer's own health, shown where the writer is. This used to sit in the
  // market panel — an error from one system displayed inside another's card,
  // which is half of why this tab was unreadable.
  //
  // Only within a day, because the note means "the thing you just tried
  // failed". Older than that it is history, not status — and a stale alarm is
  // how a board teaches you to ignore it. agent_runs keeps the full record.
  function agentHealthNote(engine) {
    var e = engine || {};
    if (e.lastRunStatus !== "failed" || !e.lastRunError) return "";
    var when = Date.parse(e.lastRunAt || "");
    if (!when || Date.now() - when > 86400000) return "";
    var credit = /credit balance|too low|quota|rate limit/i.test(e.lastRunError);
    return '<div class="cbc-act-panel" style="margin-bottom:12px;font-size:12px;color:var(--c-amber);line-height:1.6">' +
      '<i class="fa-solid fa-triangle-exclamation"></i> The last request failed — ' +
      esc(credit ? "the AI provider was out of credit or rate-limited. It falls back automatically, so try again." : e.lastRunError) +
      "</div>";
  }
  // Auto-publish setup (Phase D): a webhook the operator points at
  // Zapier/Make/Buffer; Publish POSTs approved drafts there server-side.
  function pubCfgForm() {
    return '<div class="cbc-act-panel" style="margin-bottom:12px">' +
      '<div style="font-size:12.5px;margin-bottom:6px"><b>Auto-publish setup</b> — <span id="cbc-mk-pubstatus" style="color:var(--c-muted)">checking…</span></div>' +
      '<div style="font-size:11.5px;color:var(--c-muted);margin-bottom:8px">Paste an outbound webhook URL (Zapier &ldquo;Catch Hook&rdquo;, Make, Buffer, n8n, custom). When you <b>Publish</b> an approved draft it&rsquo;s POSTed there as JSON, so your automation posts it to LinkedIn / Facebook / etc. Leave blank to disable.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input id="cbc-mk-puburl" class="cbc-inp" style="flex:1;min-width:240px" placeholder="https://hooks.zapier.com/hooks/catch/..." autocomplete="off" />' +
        '<button class="cbc-btn cbc-primary cbc-sm" data-mk-pubsave>Save</button></div></div>';
  }
  function refreshPubStatus(host) {
    D().getPublishConfig().then(function (c) {
      var s = host.querySelector("#cbc-mk-pubstatus");
      if (s) s.textContent = c && c.configured ? "connected · " + (c.urlMasked || "webhook set") : "not connected";
    }).catch(function () {});
  }
  function togglePubCfg(host) {
    var slot = host.querySelector("#cbc-mk-pubcfg");
    if (!slot) return;
    if (slot.innerHTML) { slot.innerHTML = ""; return; }
    slot.innerHTML = pubCfgForm();
    refreshPubStatus(host);
  }

  function bindCopilot(bodyEl, drafts) {
    var host = bodyEl.querySelector("#cbc-mk"); if (!host) return;
    var byId = {};
    (drafts || []).forEach(function (d) { byId[d.id] = d; });
    host.addEventListener("click", async function (e) {
      var t = e.target.closest ? e.target.closest("[data-mk-gen],[data-mk-copy],[data-mk-status],[data-mk-del],[data-mk-preset],[data-mk-editd],[data-mk-save],[data-mk-cancel],[data-mk-view],[data-mk-pub],[data-mk-pubcfg],[data-mk-pubsave]") : null;
      if (!t) return;
      if (t.hasAttribute("data-mk-view")) { viewMode = t.getAttribute("data-mk-view"); load(bodyEl); return; }
      if (t.hasAttribute("data-mk-pubcfg")) { togglePubCfg(host); return; }
      if (t.hasAttribute("data-mk-editd")) {
        var d0 = byId[t.getAttribute("data-mk-editd")];
        var card0 = t.closest("[data-mk-card]");
        if (d0 && card0) card0.innerHTML = editFields(d0);
        return;
      }
      if (t.hasAttribute("data-mk-cancel")) { load(bodyEl); return; }
      if (t.hasAttribute("data-mk-preset")) {
        var inp = host.querySelector("#cbc-mk-brief");
        if (inp) { inp.value = t.getAttribute("data-mk-preset"); inp.focus(); }
        return;
      }
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
        if (t.hasAttribute("data-mk-pubsave")) {
          var purl = ((host.querySelector("#cbc-mk-puburl") || {}).value || "").trim();
          await D().setPublishWebhook(purl);
          toast(purl ? "Publish webhook saved" : "Publish webhook cleared");
          refreshPubStatus(host);
          t.disabled = false;
          return;
        }
        if (t.hasAttribute("data-mk-pub")) {
          await D().publishDraft(t.getAttribute("data-mk-pub"));
          toast("Published via your webhook");
          load(bodyEl);
          return;
        }
        if (t.hasAttribute("data-mk-gen")) {
          var brief = (host.querySelector("#cbc-mk-brief") || {}).value || "";
          var slot = host.querySelector("#cbc-mk-result");
          if (slot) slot.innerHTML = '<div class="cbc-act-panel" style="margin-bottom:12px"><i class="fa-solid fa-circle-notch fa-spin"></i> Copilot is studying your growth data and writing drafts&hellip; (~30&ndash;60s, budget-capped)</div>';
          try {
            var r = await D().runMarketing(brief.trim() || "Study the current growth and content data, then propose this week's content: one LinkedIn post, one Facebook post, and one TikTok script.");
            lastRun = r; // shown by copilotPanel after the reload below
            load(bodyEl); // refresh queue with new drafts
          } catch (genErr) {
            // Show the REAL backend error in place of the spinner (stale
            // deploy, missing migration, budget, rate limit, …).
            if (slot) slot.innerHTML = '<div class="cbc-act-panel" style="margin-bottom:12px"><b style="color:var(--c-danger)">Copilot failed</b><div style="font-size:12.5px;margin-top:5px">' + esc((genErr && genErr.message) || "Unknown error") + '</div><div style="font-size:11.5px;color:var(--c-muted);margin-top:5px">Usual fixes: redeploy <code>agent-run</code> + <code>console-growth</code>, apply migration 0047, or retry in a minute.</div></div>';
            t.disabled = false;
          }
          return;
        }
        if (t.hasAttribute("data-mk-save")) {
          var card1 = t.closest("[data-mk-card]");
          await D().updateDraft(t.getAttribute("data-mk-save"), {
            hook: (card1.querySelector("[data-ef-hook]") || {}).value || "",
            body: (card1.querySelector("[data-ef-body]") || {}).value || "",
            hashtags: (card1.querySelector("[data-ef-hash]") || {}).value || "",
            scheduled_for: (card1.querySelector("[data-ef-sched]") || {}).value || "",
          });
          toast("Draft updated");
          load(bodyEl);
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

  // ── Tab bodies ───────────────────────────────────────────────────────
  // Each returns a complete, self-contained workspace. Nothing is shared
  // between them, which is the point: one job per tab.

  function trafficTab(g) {
    // Reads top-down as the funnel actually runs: strangers → visits →
    // accounts → activated.
    return trafficPanel(g.traffic) +
      kpisFor(g, ["signups", "activation"]) +
      '<section class="cbc-grid cbc-g-2a">' +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Acquisition</div><h2>Channels (30d)</h2></div></div>' +
          channelsTable(g.channels) + "</div>" +
        funnelPanel(g.funnel) +
      "</section>";
  }

  function contentTab(g, dq) {
    // One pipeline, read top to bottom: scan the market → publish a planned
    // week from it → ask for extras → see what landed. There used to be two
    // rival systems here ("Content engine" and "Marketing Copilot") that both
    // wrote LinkedIn posts and never said how they differed. They are now
    // steps of one flow: step 2 is the market on a rhythm, step 3 is the
    // product on demand, and both are fed by step 1.
    return '<div class="cbc-card cbc-panel" style="padding:16px 18px;margin-bottom:14px">' +
        '<div style="font-size:12.5px;color:var(--c-muted);line-height:1.7">' +
          '<b style="color:var(--c-text)">One scan feeds everything below.</b> ' +
          'Step&nbsp;1 reads the live job market. Step&nbsp;2 turns it into a planned week, automatically. ' +
          'Step&nbsp;3 is for the posts only you know you need. Nothing here publishes itself — every piece waits for you.' +
        "</div></div>" +
      marketPanel(g.engine) +
      schedulePanel(g.engine) +
      copilotPanel(dq, g.engine) +
      '<section class="cbc-grid">' +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Step 4 · Did it land</div><h2>Published performance</h2></div></div>' +
          contentTable(g.content, g.engine && g.engine.pieces) + "</div>" +
      "</section>";
  }

  function loopsTab(g) {
    return kpisFor(g, ["referrals"]) +
      '<section class="cbc-grid cbc-g-2b">' +
        referralsPanel(g.referrals) +
        '<div class="cbc-card cbc-panel"><div class="cbc-ph"><div><div class="cbc-eb">Optimization</div><h2>A/B experiments</h2></div></div>' +
          experimentsTable(g.experiments) + "</div>" +
      "</section>";
  }

  function messagingTab(g) {
    return kpisFor(g, ["push"]) +
      '<section class="cbc-grid">' + lifecyclePanel(g.lifecycle) + "</section>";
  }

  function tabBody(tab, g, dq) {
    if (tab === "content") return contentTab(g, dq);
    if (tab === "loops") return loopsTab(g);
    if (tab === "messaging") return messagingTab(g);
    return trafficTab(g);
  }

  // Paint the active tab into the body host, leaving the tab bar alone.
  function paint(bodyEl) {
    var host = bodyEl.querySelector("#cbc-gbody");
    if (!host || !cache.g) return;
    host.innerHTML = tabBody(activeTab, cache.g, cache.dq);
    host.querySelectorAll(".cbc-num[data-count]").forEach(function (n) {
      U().countUp(n, Number(n.getAttribute("data-count")), n.getAttribute("data-fmt"));
    });
    // Re-bound every paint on purpose: #cbc-mk is a fresh element each time,
    // so the old listener dies with the old node and nothing accumulates.
    // Passed bodyEl (not host) because the copilot's own handlers call
    // load(bodyEl) — querySelector finds #cbc-mk inside the host either way.
    if (activeTab === "content") bindCopilot(bodyEl, (cache.dq && cache.dq.drafts) || []);
  }

  async function switchTab(bodyEl, tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    bodyEl.querySelectorAll("[data-gtab]").forEach(function (b) {
      var on = b.getAttribute("data-gtab") === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    var hint = bodyEl.querySelector("#cbc-gt-hint");
    if (hint) hint.textContent = tabById(tab).hint;

    // Drafts are only needed by Content, so they're only fetched when Content
    // is first opened — the other three tabs never pay for that request.
    if (tab === "content" && !cache.dq) {
      var host = bodyEl.querySelector("#cbc-gbody");
      if (host) host.innerHTML = '<div class="cbc-skel" style="height:200px;margin-bottom:14px"></div><div class="cbc-skel" style="height:260px"></div>';
      try { cache.dq = await D().loadDrafts(); } catch (e) { cache.dq = { drafts: [] }; }
    }
    paint(bodyEl);
  }

  // One delegated listener per body element, ever.
  //
  // This used to be re-attached inside load(), and load() is called by the very
  // handlers it registers — so each action stacked another listener on the same
  // node (1 → 2 → 4 → 8) and a later click fired a task several times over.
  function bindOnce(bodyEl) {
    if (bodyEl.__cbGrowthBound) return;
    bodyEl.__cbGrowthBound = true;
    bodyEl.addEventListener("click", function (ev) {
      var tabBtn = ev.target.closest ? ev.target.closest("[data-gtab]") : null;
      if (tabBtn) { switchTab(bodyEl, tabBtn.getAttribute("data-gtab")); return; }
      var engBtn = ev.target.closest ? ev.target.closest("[data-eng],[data-eng-plan]") : null;
      if (engBtn) engineAction(bodyEl, engBtn);
    });
  }

  async function load(bodyEl) {
    var tab = activeTab;
    bodyEl.innerHTML = tabsHtml(tab) +
      '<div id="cbc-gbody"><section class="cbc-kpis cbc-kpis--4">' + U().kpiSkeleton(4) + "</section></div>";
    bindOnce(bodyEl);

    var jobs = [D().loadGrowth()];
    if (tab === "content") jobs.push(D().loadDrafts());
    var res = await Promise.all(jobs);
    cache.g = res[0];
    if (tab === "content") cache.dq = res[1];

    // The sample badge is a property of the data, so it sits above the tabs.
    var badge = U().sampleBadge(cache.g._mock, "console-growth", "acquisition + marketing data");
    bodyEl.innerHTML = badge + tabsHtml(activeTab) + '<div id="cbc-gbody"></div>';
    paint(bodyEl);
  }

  window.CBConsole.sections.growth = { load: load };
})();
