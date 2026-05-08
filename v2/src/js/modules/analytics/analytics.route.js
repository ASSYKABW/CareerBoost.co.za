(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};
  const shared = window.CBV2.analyticsShared || {};

  const STAGE_ORDER = shared.STAGE_ORDER || ["saved", "applied", "interview", "offer", "rejected", "withdrawn"];
  const STAGE_LABEL = shared.STAGE_LABEL || {
    saved: "Saved",
    applied: "Applied",
    interview: "Interview",
    offer: "Offer",
    rejected: "Rejected",
    withdrawn: "Withdrawn"
  };
  const STAGE_COLOR = shared.STAGE_COLOR || {
    saved: "#22d3ee",
    applied: "#6b7dff",
    interview: "#3b82f6",
    offer: "#22c55e",
    rejected: "#f59e0b",
    withdrawn: "#f43f5e"
  };
  const DAY_MS = shared.DAY_MS || 86400000;

  function getSt() {
    return window.CBV2.sanitizeText || function (s) { return String(s == null ? "" : s); };
  }

  function toDate(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // Weekly buckets: returns array of { label, count, start, end } for the last
  // `weeks` calendar weeks (Mon-Sun), oldest first.
  function buildWeeklyBuckets(apps, weeks) {
    const now = new Date();
    // Monday of current week.
    const currentMonday = new Date(now);
    const day = (currentMonday.getDay() + 6) % 7; // 0 = Mon
    currentMonday.setHours(0, 0, 0, 0);
    currentMonday.setDate(currentMonday.getDate() - day);

    const buckets = [];
    for (let i = weeks - 1; i >= 0; i -= 1) {
      const start = new Date(currentMonday.getTime() - i * 7 * DAY_MS);
      const end = new Date(start.getTime() + 7 * DAY_MS);
      buckets.push({
        start: start,
        end: end,
        label: start.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        count: 0
      });
    }
    apps.forEach(function (a) {
      const d = toDate(a.appliedAt);
      if (!d) return;
      for (let i = 0; i < buckets.length; i += 1) {
        if (d >= buckets[i].start && d < buckets[i].end) {
          buckets[i].count += 1;
          break;
        }
      }
    });
    return buckets;
  }

  // Uses stageHistory to derive time-in-stage averages. For each application,
  // compute the number of days between consecutive history entries, grouped
  // by the origin stage. "Open" stages (the current stage at time of read)
  // are excluded from averaging — they would bias the stat downward.
  function computeTimeInStage(apps) {
    const totals = {};
    STAGE_ORDER.forEach(function (s) { totals[s] = { days: 0, count: 0 }; });
    apps.forEach(function (a) {
      const hist = Array.isArray(a.stageHistory) ? a.stageHistory.slice() : [];
      if (hist.length < 2) return;
      hist.sort(function (x, y) { return new Date(x.at).getTime() - new Date(y.at).getTime(); });
      for (let i = 0; i < hist.length - 1; i += 1) {
        const a0 = toDate(hist[i].at);
        const a1 = toDate(hist[i + 1].at);
        if (!a0 || !a1) continue;
        const days = Math.max(0, Math.round((a1.getTime() - a0.getTime()) / DAY_MS));
        const stage = hist[i].stage;
        if (!totals[stage]) continue;
        totals[stage].days += days;
        totals[stage].count += 1;
      }
    });
    const averages = {};
    STAGE_ORDER.forEach(function (s) {
      averages[s] = totals[s].count ? totals[s].days / totals[s].count : null;
    });
    return averages;
  }

  // For each stage that has a next stage, what % of applications that entered
  // the stage also moved to (or beyond) the next stage? Uses stageHistory so
  // apps that passed *through* a stage count correctly.
  function computeStageConversion(apps) {
    const FLOW = ["saved", "applied", "interview", "offer"];
    const touched = { saved: 0, applied: 0, interview: 0, offer: 0 };
    apps.forEach(function (a) {
      const stages = new Set();
      (a.stageHistory || []).forEach(function (h) { stages.add(h.stage); });
      // Also count the current stage, even if history is missing an entry.
      stages.add(a.stage);
      // If a user saved then applied, they touched "saved" even if only the
      // applied entry was recorded (pre-Phase-C backfill handles this).
      FLOW.forEach(function (s) { if (stages.has(s)) touched[s] += 1; });
    });
    const rates = [];
    for (let i = 0; i < FLOW.length - 1; i += 1) {
      const from = FLOW[i];
      const to = FLOW[i + 1];
      const rate = touched[from] ? Math.round((touched[to] / touched[from]) * 100) : 0;
      rates.push({
        from: from,
        to: to,
        rate: rate,
        enteredFrom: touched[from],
        enteredTo: touched[to]
      });
    }
    return rates;
  }

  function totalByStage(apps) {
    const c = {};
    STAGE_ORDER.forEach(function (s) { c[s] = 0; });
    apps.forEach(function (a) { if (c[a.stage] != null) c[a.stage] += 1; });
    return c;
  }

  function renderKpiStrip(stats, apps) {
    const total = apps.length;
    const submitted = apps.filter(function (a) { return a.stage !== "saved"; }).length;
    const heard = apps.filter(function (a) {
      return a.stage === "interview" || a.stage === "offer" || a.stage === "rejected";
    }).length;
    const offers = stats.byStage.offer || 0;
    const responseRate = submitted ? Math.round((heard / submitted) * 100) : 0;
    const offerRate = submitted ? Math.round((offers / submitted) * 100) : 0;
    const cards = [
      { label: "Total tracked", value: total, tone: "cyan", icon: "fa-briefcase", sub: "in your pipeline" },
      { label: "Response rate", value: responseRate + "%", tone: "violet", icon: "fa-reply", sub: heard + " of " + submitted + " heard back" },
      { label: "Offer rate", value: offerRate + "%", tone: "green", icon: "fa-trophy", sub: offers + " offer" + (offers === 1 ? "" : "s") },
      { label: "Closed", value: (stats.byStage.rejected + stats.byStage.withdrawn), tone: "warning", icon: "fa-circle-xmark", sub: "rejected or withdrawn" }
    ];
    const st = getSt();
    return (
      '<div class="card-grid">' +
      cards.map(function (c) {
        return (
          '<article class="card kpi-card">' +
            '<div class="kpi-head">' +
              '<span class="kpi-icon ' + c.tone + '"><i class="fa-solid ' + c.icon + '"></i></span>' +
              '<span class="chip ' + c.tone + '">' + st(c.label) + '</span>' +
            '</div>' +
            '<div class="kpi-value-row"><div class="value">' + st(String(c.value)) + '</div></div>' +
            '<div class="kpi-foot"><span class="kpi-sub">' + st(c.sub) + '</span></div>' +
          '</article>'
        );
      }).join("") +
      '</div>'
    );
  }

  function plural(n, one, many) {
    return n === 1 ? one : (many || one + "s");
  }

  function pct(n) {
    if (typeof shared.pct === "function") return parseInt(shared.pct(n), 10) || 0;
    return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  }

  function getStageTouchCounts(apps) {
    const flow = ["saved", "applied", "interview", "offer"];
    const counts = { saved: 0, applied: 0, interview: 0, offer: 0 };
    apps.forEach(function (a) {
      let maxRank = -1;
      const stages = [];
      (Array.isArray(a.stageHistory) ? a.stageHistory : []).forEach(function (h) { stages.push(h.stage); });
      stages.push(a.stage);
      stages.forEach(function (s) {
        const idx = flow.indexOf(s);
        if (idx > maxRank) maxRank = idx;
      });
      if (maxRank < 0 && (a.stage === "rejected" || a.stage === "withdrawn")) maxRank = 1;
      if (maxRank < 0 && a.stage) maxRank = 0;
      for (let i = 0; i <= maxRank; i += 1) counts[flow[i]] += 1;
    });
    return counts;
  }

  function getStaleApplications(apps, minDays, limit) {
    const today = Date.now();
    return apps
      .filter(function (a) { return a.stage === "applied" || a.stage === "interview"; })
      .map(function (a) {
        const hist = Array.isArray(a.stageHistory) ? a.stageHistory : [];
        const last = hist.length ? hist[hist.length - 1] : null;
        const lastAt = last && last.at ? toDate(last.at) : toDate(a.appliedAt);
        const days = lastAt ? Math.floor((today - lastAt.getTime()) / DAY_MS) : 0;
        return { app: a, days: days };
      })
      .filter(function (x) { return x.days >= (minDays || 7); })
      .sort(function (a, b) { return b.days - a.days; })
      .slice(0, limit || 6);
  }

  function upcomingInterviewEvents(limit) {
    const store = window.CBV2.store;
    if (!store || typeof store.getEvents !== "function") return [];
    const now = Date.now();
    return store.getEvents()
      .filter(function (e) {
        const d = toDate(e.start || e.date);
        return e.type === "interview" && d && d.getTime() >= now;
      })
      .sort(function (a, b) {
        return toDate(a.start || a.date).getTime() - toDate(b.start || b.date).getTime();
      })
      .slice(0, limit || 3);
  }

  function buildNextBestActions(apps, intel) {
    const all = window.CBV2.store.getAll();
    const resume = all.resume || {};
    const cover = all.coverLetter || {};
    const actions = [];
    const stale = intel.staleItems || [];
    const saved = apps.filter(function (a) { return a.stage === "saved"; });
    const interviewApps = apps.filter(function (a) { return a.stage === "interview"; });

    if (stale.length) {
      actions.push({
        icon: "fa-paper-plane",
        tone: "warning",
        title: "Follow up with " + (stale[0].app.company || "a stale application"),
        detail: (stale[0].app.role || "Application") + " has waited " + stale[0].days + " days.",
        appId: stale[0].app.id
      });
    }
    if (interviewApps.length) {
      actions.push({
        icon: "fa-comments",
        tone: "blue",
        title: "Prepare interview stories",
        detail: "Use Interview Prep for " + (interviewApps[0].company || "your active interview") + ".",
        href: "#/interview"
      });
    }
    if (saved.length) {
      actions.push({
        icon: "fa-file-pen",
        tone: "cyan",
        title: "Convert saved role to application",
        detail: "Tailor resume for " + (saved[0].company || "your highest-fit saved role") + ".",
        href: "#/resume"
      });
    }
    if (!resume.base && !resume.structured) {
      actions.push({
        icon: "fa-id-card",
        tone: "violet",
        title: "Build your resume baseline",
        detail: "Analytics gets smarter once Resume Lab has a strong source profile.",
        href: "#/resume"
      });
    }
    if (!Array.isArray(cover.sentLog) || !cover.sentLog.length) {
      actions.push({
        icon: "fa-envelope-open-text",
        tone: "green",
        title: "Track cover letter performance",
        detail: "Send and mark at least one letter to unlock variant analytics.",
        href: "#/cover-letter"
      });
    }
    if (intel.searchRuns === 0) {
      actions.push({
        icon: "fa-magnifying-glass-chart",
        tone: "cyan",
        title: "Run a targeted role search",
        detail: "Search Quality needs job-search data to reveal which sources convert.",
        href: "#/job-search"
      });
    }
    actions.push({
      icon: "fa-gavel",
      tone: "violet",
      title: "Generate the weekly AI Judge",
      detail: "Get a ruthless score, gaps, and a 7-day correction plan.",
      judge: true
    });
    return actions.slice(0, 5);
  }

  function buildInsightCards(intel) {
    const insights = [];
    if (intel.confidence.score < 55) {
      insights.push({
        icon: "fa-scale-balanced",
        tone: "warning",
        title: "Confidence is still building",
        body: "Track more applications before trusting conversion rates too strongly."
      });
    }
    if (intel.staleItems.length) {
      insights.push({
        icon: "fa-clock",
        tone: "warning",
        title: "Follow-up hygiene needs attention",
        body: intel.staleItems.length + " " + plural(intel.staleItems.length, "application") + " have been idle for 7+ days."
      });
    } else {
      insights.push({
        icon: "fa-check",
        tone: "green",
        title: "No stale follow-ups",
        body: "Your active applications are not sitting unattended."
      });
    }
    if (intel.responseRate >= 50 && intel.submitted >= 4) {
      insights.push({
        icon: "fa-signal",
        tone: "green",
        title: "Response quality is promising",
        body: intel.heard + " of " + intel.submitted + " submitted applications have produced a signal."
      });
    } else {
      insights.push({
        icon: "fa-filter-circle-dollar",
        tone: "violet",
        title: "Improve role targeting",
        body: "Prioritize roles where your resume evidence clearly matches the requirements."
      });
    }
    if (intel.health.profileStrength < 60) {
      insights.push({
        icon: "fa-id-card-clip",
        tone: "cyan",
        title: "Profile strength is limiting signal",
        body: "Resume Lab and Cover Letter tracking should feed stronger evidence into Analytics."
      });
    }
    return insights.slice(0, 4);
  }

  function buildAnalyticsIntelligence(apps, weeks, conversions, averages) {
    const byStage = totalByStage(apps);
    const submitted = apps.filter(function (a) { return a.stage !== "saved"; }).length;
    const heard = apps.filter(function (a) {
      return a.stage === "interview" || a.stage === "offer" || a.stage === "rejected";
    }).length;
    const offers = byStage.offer || 0;
    const responseRate = submitted ? pct((heard / submitted) * 100) : 0;
    const offerRate = submitted ? pct((offers / submitted) * 100) : 0;
    const staleItems = getStaleApplications(apps, 7, 6);
    const signals = collectJudgeSignals();
    const scores = computeJudgeScores(signals);
    const confidence = computeJudgeConfidence(scores);
    const searchAnalytics = window.CBV2.store.getJobSearchAnalytics ? window.CBV2.store.getJobSearchAnalytics() : { runs: [] };
    const latestWeek = weeks.length ? weeks[weeks.length - 1].count : 0;
    const previousWeek = weeks.length > 1 ? weeks[weeks.length - 2].count : 0;
    const weeklyDelta = latestWeek - previousWeek;
    const avgTimeKnown = STAGE_ORDER.some(function (s) { return averages[s] != null; });
    const stageTouches = getStageTouchCounts(apps);
    const health = {
      executionDiscipline: scores.executionDiscipline,
      marketStrategy: scores.marketStrategy,
      profileStrength: scores.profileStrength,
      interviewReadiness: scores.interviewReadiness,
      learningVelocity: scores.learningVelocity
    };
    const headline = scores.weighted >= 80
      ? "Your search system is performing. Keep pressure high."
      : scores.weighted >= 60
      ? "Your search has traction, but the system is leaking value."
      : "Your search needs tighter execution and cleaner follow-through.";
    const summary = staleItems.length
      ? staleItems.length + " active " + plural(staleItems.length, "application") + " need attention before you chase new roles."
      : "No stale active applications detected. Focus on role quality and weekly consistency.";
    const intel = {
      byStage: byStage,
      submitted: submitted,
      heard: heard,
      offers: offers,
      responseRate: responseRate,
      offerRate: offerRate,
      staleItems: staleItems,
      weeklyDelta: weeklyDelta,
      latestWeek: latestWeek,
      avgTimeKnown: avgTimeKnown,
      stageTouches: stageTouches,
      score: scores.weighted,
      confidence: confidence,
      health: health,
      searchRuns: (searchAnalytics.runs || []).length,
      upcomingInterviews: upcomingInterviewEvents(3),
      headline: headline,
      summary: summary
    };
    intel.actions = buildNextBestActions(apps, intel);
    intel.insights = buildInsightCards(intel);
    intel.conversions = conversions;
    return intel;
  }

  function scoreBand(score) {
    if (score >= 80) return { tone: "green", label: "Strong" };
    if (score >= 60) return { tone: "violet", label: "Needs optimization" };
    return { tone: "warning", label: "Needs attention" };
  }

  function renderCommandCenter(intel) {
    const st = getSt();
    const band = scoreBand(intel.score);
    const delta = intel.weeklyDelta > 0 ? "+" + intel.weeklyDelta : String(intel.weeklyDelta);
    return (
      '<section class="analytics-command-center">' +
        '<div class="analytics-command-copy">' +
          '<p class="eyebrow">Career Intelligence</p>' +
          '<h1 class="page-title">Job-search command center</h1>' +
          '<p class="page-subtitle">' + st(intel.headline) + ' ' + st(intel.summary) + '</p>' +
          '<div class="analytics-command-actions">' +
            '<button class="btn-primary" type="button" data-judge-generate><i class="fa-solid fa-gavel"></i> Generate AI Judge</button>' +
            '<button class="btn-secondary" id="export-csv" type="button"><i class="fa-solid fa-file-csv"></i> Export CSV</button>' +
          '</div>' +
        '</div>' +
        '<aside class="analytics-score-panel">' +
          '<div class="analytics-score-ring" style="--score:' + pct(intel.score) + '">' +
            '<strong>' + pct(intel.score) + '</strong><span>health score</span>' +
          '</div>' +
          '<div class="analytics-score-copy">' +
            '<span class="chip ' + band.tone + '">' + st(band.label) + '</span>' +
            '<h2>' + st(intel.confidence.label) + '</h2>' +
            '<p>Based on ' + intel.submitted + ' submitted ' + plural(intel.submitted, "application") + ', ' + intel.heard + ' response ' + plural(intel.heard, "signal") + ', and current follow-up hygiene.</p>' +
          '</div>' +
          '<div class="analytics-score-mini">' +
            '<span><strong>' + intel.responseRate + '%</strong><small>response</small></span>' +
            '<span><strong>' + intel.offerRate + '%</strong><small>offer yield</small></span>' +
            '<span><strong>' + delta + '</strong><small>weekly delta</small></span>' +
          '</div>' +
        '</aside>' +
      '</section>'
    );
  }

  function renderNextActions(intel) {
    const st = getSt();
    return (
      '<section class="analytics-action-board">' +
        '<div class="analytics-section-heading">' +
          '<div><p class="eyebrow">Next Best Actions</p><h2>Do these before reviewing more charts.</h2></div>' +
          '<span class="chip cyan">' + intel.actions.length + ' priorities</span>' +
        '</div>' +
        '<div class="analytics-action-grid">' +
          intel.actions.map(function (a, i) {
            const inner =
              '<span class="analytics-action-rank">0' + (i + 1) + '</span>' +
              '<i class="fa-solid ' + st(a.icon || "fa-arrow-right") + '"></i>' +
              '<strong>' + st(a.title) + '</strong>' +
              '<small>' + st(a.detail) + '</small>';
            const cls = 'analytics-action-card tone-' + st(a.tone || "cyan");
            if (a.appId) return '<button class="' + cls + '" type="button" data-open-app="' + st(a.appId) + '">' + inner + '</button>';
            if (a.judge) return '<button class="' + cls + '" type="button" data-judge-generate>' + inner + '</button>';
            return '<a class="' + cls + '" href="' + st(a.href || "#/dashboard") + '">' + inner + '</a>';
          }).join("") +
        '</div>' +
      '</section>'
    );
  }

  function renderHealthMatrix(intel) {
    const st = getSt();
    const rows = [
      { key: "executionDiscipline", label: "Execution discipline", detail: "Weekly volume, calendar usage, and active follow-up pressure.", color: "#22d3ee" },
      { key: "marketStrategy", label: "Market strategy", detail: "Search quality, saved-role selectivity, and conversion into interviews.", color: "#6b7dff" },
      { key: "profileStrength", label: "Profile strength", detail: "Resume freshness, tailored assets, and cover-letter signal.", color: "#22c55e" },
      { key: "interviewReadiness", label: "Interview readiness", detail: "Interview-stage pipeline and preparation state.", color: "#3b82f6" },
      { key: "learningVelocity", label: "Learning velocity", detail: "Recent progress and how quickly the system improves.", color: "#f59e0b" }
    ];
    return (
      '<section class="analytics-health-panel">' +
        '<div class="analytics-section-heading">' +
          '<div><p class="eyebrow">Pipeline Health</p><h2>Five signals that determine momentum.</h2></div>' +
          '<span class="chip violet">Weighted score</span>' +
        '</div>' +
        '<div class="analytics-health-grid">' +
          rows.map(function (r) {
            const val = pct(intel.health[r.key]);
            return (
              '<article class="analytics-health-card">' +
                '<div><strong>' + st(r.label) + '</strong><span>' + val + '/100</span></div>' +
                '<p>' + st(r.detail) + '</p>' +
                '<div class="analytics-health-track"><i style="width:' + val + '%;background:' + r.color + '"></i></div>' +
              '</article>'
            );
          }).join("") +
        '</div>' +
      '</section>'
    );
  }

  function renderPipelineFunnel(intel) {
    const st = getSt();
    const flow = ["saved", "applied", "interview", "offer"];
    const max = Math.max(1, intel.stageTouches.saved || intel.byStage.saved || 1);
    return (
      '<section class="analytics-funnel-panel">' +
        '<div class="analytics-section-heading">' +
          '<div><p class="eyebrow">Conversion Funnel</p><h2>Where applications are advancing or leaking.</h2></div>' +
          '<span class="chip green">' + intel.responseRate + '% response</span>' +
        '</div>' +
        '<div class="analytics-funnel">' +
          flow.map(function (stage, i) {
            const count = intel.stageTouches[stage] || 0;
            const width = Math.max(16, Math.round((count / max) * 100));
            const next = flow[i + 1];
            const nextCount = next ? (intel.stageTouches[next] || 0) : 0;
            const stepRate = next && count ? Math.round((nextCount / count) * 100) : null;
            return (
              '<article class="analytics-funnel-step" style="--bar:' + width + ';--stage-color:' + STAGE_COLOR[stage] + '">' +
                '<div class="analytics-funnel-bar"></div>' +
                '<div class="analytics-funnel-copy">' +
                  '<span>' + st(STAGE_LABEL[stage]) + '</span>' +
                  '<strong>' + count + '</strong>' +
                  (stepRate == null ? '<small>final stage</small>' : '<small>' + stepRate + '% to ' + st(STAGE_LABEL[next]) + '</small>') +
                '</div>' +
              '</article>'
            );
          }).join("") +
        '</div>' +
      '</section>'
    );
  }

  function renderInsightCards(intel) {
    const st = getSt();
    return (
      '<section class="analytics-insight-grid">' +
        intel.insights.map(function (x) {
          return (
            '<article class="analytics-insight-card tone-' + st(x.tone) + '">' +
              '<i class="fa-solid ' + st(x.icon) + '"></i>' +
              '<div><strong>' + st(x.title) + '</strong><p>' + st(x.body) + '</p></div>' +
            '</article>'
          );
        }).join("") +
      '</section>'
    );
  }

  function renderMomentumMetrics(intel) {
    const st = getSt();
    const cards = [
      { label: "Tracked", value: String(Object.keys(intel.byStage).reduce(function (s, k) { return s + (intel.byStage[k] || 0); }, 0)), sub: "roles in pipeline", icon: "fa-briefcase", tone: "cyan" },
      { label: "Response", value: intel.responseRate + "%", sub: intel.heard + " of " + intel.submitted + " heard back", icon: "fa-reply", tone: "violet" },
      { label: "Offers", value: String(intel.offers), sub: intel.offerRate + "% offer yield", icon: "fa-trophy", tone: "green" },
      { label: "Stale", value: String(intel.staleItems.length), sub: "need attention", icon: "fa-clock", tone: intel.staleItems.length ? "warning" : "green" }
    ];
    return (
      '<section class="analytics-metric-grid">' +
        cards.map(function (c) {
          return (
            '<article class="analytics-metric-card tone-' + c.tone + '">' +
              '<i class="fa-solid ' + c.icon + '"></i>' +
              '<span>' + st(c.label) + '</span>' +
              '<strong>' + st(c.value) + '</strong>' +
              '<small>' + st(c.sub) + '</small>' +
            '</article>'
          );
        }).join("") +
      '</section>'
    );
  }

  function renderWeeklyChart(weeks) {
    const w = 720;
    const h = 260;
    const padLeft = 40;
    const padRight = 20;
    const padTop = 20;
    const padBottom = 40;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;
    const max = Math.max.apply(null, weeks.map(function (x) { return x.count; })) || 1;
    const bw = chartW / weeks.length - 10;

    // Horizontal grid lines (3 ticks).
    let gridLines = "";
    for (let i = 0; i <= 3; i += 1) {
      const y = padTop + (chartH / 3) * i;
      const value = Math.round(max - (max / 3) * i);
      gridLines +=
        '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (w - padRight) + '" y2="' + y + '" stroke="rgba(255,255,255,0.05)" />' +
        '<text x="' + (padLeft - 6) + '" y="' + (y + 4) + '" fill="#8b92a6" font-size="10" text-anchor="end">' + value + '</text>';
    }

    const bars = weeks.map(function (b, i) {
      const val = b.count;
      const barH = (val / max) * chartH;
      const x = padLeft + i * (chartW / weeks.length) + 5;
      const y = padTop + (chartH - barH);
      const tone = val ? "#22d3ee" : "#2a3040";
      return (
        '<g>' +
          '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + barH + '" rx="5" fill="' + tone + '" opacity="0.85">' +
            '<title>' + b.label + ': ' + val + (val === 1 ? ' application' : ' applications') + '</title>' +
          '</rect>' +
          (val > 0 ? '<text x="' + (x + bw / 2) + '" y="' + (y - 4) + '" fill="#e6e9f2" font-size="11" text-anchor="middle" font-weight="600">' + val + '</text>' : "") +
          '<text x="' + (x + bw / 2) + '" y="' + (h - 18) + '" fill="#8b92a6" font-size="10" text-anchor="middle">' + b.label + '</text>' +
        '</g>'
      );
    }).join("");

    return (
      '<svg viewBox="0 0 ' + w + ' ' + h + '" class="chart-svg chart-svg--weekly" role="img" aria-label="Applications per week">' +
        gridLines + bars +
      '</svg>'
    );
  }

  function renderConversionTable(rates) {
    const st = getSt();
    const rows = rates.map(function (r) {
      const width = Math.min(100, r.rate);
      // Phase 4: confidence chip — small samples make percentages misleading.
      // Hide rate entirely below 3 (statistical noise), warn from 3-9, OK
      // from 10+. The "n=N" hint contextualizes every reported rate.
      const n = r.enteredFrom || 0;
      const lowSample = n < 10;
      const tooFew = n < 3;
      const sampleChip = tooFew
        ? '<span class="chip rose conv-confidence" title="Fewer than 3 applications passed through this stage — rate is statistical noise.">n=' + n + ' · low data</span>'
        : lowSample
        ? '<span class="chip warning conv-confidence" title="Small sample — treat this rate as directional, not predictive.">n=' + n + ' · small sample</span>'
        : '<span class="chip green conv-confidence" title="Reliable sample size.">n=' + n + '</span>';
      const rateText = tooFew ? '—' : r.rate + '%';
      const fillWidth = tooFew ? 0 : width;
      return (
        '<div class="conv-row">' +
          '<span class="conv-label">' +
            '<span class="status-dot ' + toneOf(r.from) + '"></span> ' + st(STAGE_LABEL[r.from]) +
            ' <i class="fa-solid fa-arrow-right conv-arrow"></i> ' +
            '<span class="status-dot ' + toneOf(r.to) + '"></span> ' + st(STAGE_LABEL[r.to]) +
          '</span>' +
          '<div class="conv-track"><span class="conv-fill" style="width:' + fillWidth + '%;background:' + STAGE_COLOR[r.to] + '"></span></div>' +
          '<span class="conv-rate">' + rateText + '</span>' +
          '<span class="conv-count">' + r.enteredTo + '/' + r.enteredFrom + '</span>' +
          sampleChip +
        '</div>'
      );
    }).join("");
    return '<div class="conv-grid">' + rows + '</div>';
  }

  function toneOf(stage) {
    return stage === "saved" ? "cyan"
      : stage === "applied" ? "violet"
      : stage === "interview" ? "blue"
      : stage === "offer" ? "green"
      : stage === "rejected" ? "warning"
      : stage === "withdrawn" ? "rose"
      : "cyan";
  }

  function renderTimeInStage(averages) {
    const st = getSt();
    const values = STAGE_ORDER
      .filter(function (s) { return averages[s] != null && s !== "withdrawn"; })
      .map(function (s) { return { stage: s, days: averages[s] }; });
    if (!values.length) {
      return '<p class="ai-meta">Not enough stage history yet. Move a few applications between stages and this will start to fill in.</p>';
    }
    const max = Math.max.apply(null, values.map(function (v) { return v.days; })) || 1;
    const rows = values.map(function (v) {
      const width = Math.min(100, Math.round((v.days / max) * 100));
      const label = v.days < 1 ? "<1 day" : v.days === 1 ? "1 day" : Math.round(v.days) + " days";
      return (
        '<div class="conv-row">' +
          '<span class="conv-label"><span class="status-dot ' + toneOf(v.stage) + '"></span> ' + st(STAGE_LABEL[v.stage]) + '</span>' +
          '<div class="conv-track"><span class="conv-fill" style="width:' + width + '%;background:' + STAGE_COLOR[v.stage] + '"></span></div>' +
          '<span class="conv-rate">' + label + '</span>' +
        '</div>'
      );
    }).join("");
    return '<div class="conv-grid conv-grid--nocount">' + rows + '</div>';
  }

  function renderStaleList(apps) {
    const st = getSt();
    const stale = getStaleApplications(apps, 7, 6);
    if (!stale.length) {
      return '<p class="ai-meta">Nothing stale. Great hygiene — keep the momentum.</p>';
    }
    return (
      '<ul class="stale-list">' +
      stale.map(function (x) {
        const a = x.app;
        return (
          '<li class="stale-item" data-open-app="' + st(a.id) + '">' +
            '<div class="stale-body">' +
              '<strong>' + st(a.company || "—") + '</strong>' +
              '<span class="ai-meta">' + st(a.role || "") + ' · ' + st(STAGE_LABEL[a.stage] || a.stage) + '</span>' +
            '</div>' +
            '<span class="chip warning">' + x.days + "d ago</span>" +
          '</li>'
        );
      }).join("") +
      '</ul>'
    );
  }

  function computeCoverLetterMetrics() {
    const c = (window.CBV2.store.getAll().coverLetter || {});
    const sent = Array.isArray(c.sentLog) ? c.sentLog : [];
    const byVariant = {};
    sent.forEach(function (x) {
      const key = x.variantLabel || "Live draft";
      if (!byVariant[key]) byVariant[key] = { sent: 0, positive: 0 };
      byVariant[key].sent += 1;
      if (x.status === "responded" || x.status === "interview" || x.status === "offer") byVariant[key].positive += 1;
    });
    const totals = sent.reduce(function (acc, x) {
      acc.sent += 1;
      if (x.status === "responded" || x.status === "interview" || x.status === "offer") acc.positive += 1;
      if (x.status === "offer") acc.offers += 1;
      return acc;
    }, { sent: 0, positive: 0, offers: 0 });
    return { sent: sent, byVariant: byVariant, totals: totals };
  }

  function renderCoverLetterCard() {
    const st = getSt();
    const m = computeCoverLetterMetrics();
    const names = Object.keys(m.byVariant);
    if (!m.totals.sent) {
      return (
        '<section class="card panel-lg analytics-empty-signal">' +
          '<div class="panel-head"><h2>Cover Letter A/B Performance</h2><span class="chip cyan">No signal yet</span></div>' +
          '<p class="page-subtitle">Track sent letters before judging variants. Once you mark letters as sent, this section will show positive response rate, offer yield, and which draft style converts.</p>' +
          '<div class="hero-actions"><a class="btn-secondary" href="#/cover-letter"><i class="fa-solid fa-envelope-open-text"></i> Open Cover Letter Studio</a></div>' +
        '</section>'
      );
    }
    const rows = names.map(function (k) {
      const r = m.byVariant[k];
      const rate = r.sent ? Math.round((r.positive / r.sent) * 100) : 0;
      return '<div class="conv-row"><span class="conv-label">' + st(k) + '</span><div class="conv-track"><span class="conv-fill" style="width:' + rate + '%;background:#22d3ee"></span></div><span class="conv-rate">' + rate + '%</span><span class="conv-count">' + r.positive + "/" + r.sent + "</span></div>";
    }).join("");
    return (
      '<section class="card panel-lg">' +
        '<div class="panel-head"><h2>Cover Letter A/B Performance</h2><span class="chip cyan">' + m.totals.sent + ' sent</span></div>' +
        '<div class="conv-grid">' +
          '<div class="conv-row"><span class="conv-label">Positive response rate</span><div class="conv-track"><span class="conv-fill" style="width:' + (m.totals.sent ? Math.round((m.totals.positive / m.totals.sent) * 100) : 0) + '%;background:#6b7dff"></span></div><span class="conv-rate">' + (m.totals.sent ? Math.round((m.totals.positive / m.totals.sent) * 100) : 0) + '%</span><span class="conv-count">' + m.totals.positive + "/" + m.totals.sent + '</span></div>' +
          '<div class="conv-row"><span class="conv-label">Offer yield</span><div class="conv-track"><span class="conv-fill" style="width:' + (m.totals.sent ? Math.round((m.totals.offers / m.totals.sent) * 100) : 0) + '%;background:#22c55e"></span></div><span class="conv-rate">' + (m.totals.sent ? Math.round((m.totals.offers / m.totals.sent) * 100) : 0) + '%</span><span class="conv-count">' + m.totals.offers + "/" + m.totals.sent + '</span></div>' +
        "</div>" +
        (rows ? ('<div class="conv-grid" style="margin-top:10px;">' + rows + "</div>") : '<p class="ai-meta">No variant performance yet. Mark cover letters as sent in Cover Letter Studio.</p>') +
      '</section>'
    );
  }

  const JUDGE_STORAGE_KEY = "cbv2_ai_judge_v1";

  function loadJudgeState() {
    try {
      const raw = localStorage.getItem(JUDGE_STORAGE_KEY);
      if (!raw) return { reports: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.reports)) return { reports: [] };
      if (!parsed.experiments || typeof parsed.experiments !== "object") {
        parsed.experiments = {
          assignments: {},
          stats: {
            control: { reports: 0, avgScoreDelta: 0, improvements: 0 },
            challenger: { reports: 0, avgScoreDelta: 0, improvements: 0 }
          },
          lastVariant: "control"
        };
      }
      return { reports: parsed.reports, memory: parsed.memory || null, experiments: parsed.experiments };
    } catch (e) {
      return { reports: [] };
    }
  }

  function saveJudgeState(state) {
    try {
      localStorage.setItem(JUDGE_STORAGE_KEY, JSON.stringify(state || { reports: [] }));
    } catch (e) {
      // ignore storage errors
    }
  }

  function clampScore(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function judgeVariantForNextReport(state) {
    const s = state || loadJudgeState();
    const ex = s.experiments || {};
    const policy = ex.policy || {};
    if (policy.lockedVariant) return policy.lockedVariant;
    const last = ex.lastVariant || "control";
    return last === "control" ? "challenger" : "control";
  }

  function variantLabel(v) {
    return v === "challenger" ? "Challenger (hard mode)" : "Control (standard)";
  }

  function stageScore(apps) {
    const submitted = apps.filter(function (a) { return a.stage !== "saved"; }).length;
    if (!submitted) return 0;
    const interviewOrOffer = apps.filter(function (a) {
      return a.stage === "interview" || a.stage === "offer";
    }).length;
    const ratio = interviewOrOffer / submitted;
    return clampScore(ratio * 100);
  }

  function appInWindow(a, startMs, endMs) {
    if (startMs == null && endMs == null) return true;
    const d = toDate(a && a.appliedAt);
    if (!d) return false;
    const t = d.getTime();
    if (startMs != null && t < startMs) return false;
    if (endMs != null && t >= endMs) return false;
    return true;
  }

  function inRangeByDate(value, startMs, endMs) {
    if (startMs == null && endMs == null) return true;
    const d = toDate(value);
    if (!d) return false;
    const t = d.getTime();
    if (startMs != null && t < startMs) return false;
    if (endMs != null && t >= endMs) return false;
    return true;
  }

  function collectJudgeSignals(opts) {
    opts = opts || {};
    const now = typeof opts.referenceMs === "number" ? opts.referenceMs : Date.now();
    const startMs = typeof opts.windowStartMs === "number" ? opts.windowStartMs : null;
    const endMs = typeof opts.windowEndMs === "number" ? opts.windowEndMs : null;
    const store = window.CBV2.store;
    const all = store.getAll();
    const scopedApps = store.getApplications().filter(function (a) { return appInWindow(a, startMs, endMs); });
    const submitted = scopedApps.filter(function (a) { return a.stage !== "saved"; });
    const followupReady = submitted.filter(function (a) {
      const hist = Array.isArray(a.stageHistory) ? a.stageHistory : [];
      const last = hist.length ? hist[hist.length - 1] : null;
      const lastAt = toDate(last && last.at ? last.at : a.appliedAt);
      if (!lastAt) return false;
      const days = Math.floor((now - lastAt.getTime()) / DAY_MS);
      return days >= 7 && (a.stage === "applied" || a.stage === "interview");
    }).length;
    const staleSaved = scopedApps.filter(function (a) {
      if (a.stage !== "saved") return false;
      const d = toDate(a.appliedAt);
      if (!d) return false;
      return Math.floor((now - d.getTime()) / DAY_MS) >= 5;
    }).length;
    const appsLast7 = scopedApps.filter(function (a) {
      const d = toDate(a.appliedAt);
      return d && now - d.getTime() <= 7 * DAY_MS;
    }).length;
    const appsLast14 = scopedApps.filter(function (a) {
      const d = toDate(a.appliedAt);
      return d && now - d.getTime() <= 14 * DAY_MS;
    }).length;

    const events = store.getEvents().filter(function (e) {
      const dt = e.start || e.date;
      return inRangeByDate(dt, startMs, endMs);
    });
    const upcomingInterviews = events.filter(function (e) { return e.type === "interview"; }).length;

    const savedJobs = store.getSavedJobs();
    const savedSearches = store.getSavedSearches();
    const jsAnalytics = store.getJobSearchAnalytics ? store.getJobSearchAnalytics() : { runs: [] };
    const runs = (jsAnalytics.runs || []).slice(0, 40);
    const surfaced = runs.reduce(function (s, r) { return s + Number(r.total || 0); }, 0);
    const searchSaveRate = surfaced ? Math.round((savedJobs.length / surfaced) * 100) : 0;

    const resume = all.resume || {};
    const resumeUpdatedAt = toDate(resume.updatedAt);
    const resumeFreshDays = resumeUpdatedAt ? Math.floor((now - resumeUpdatedAt.getTime()) / DAY_MS) : 999;
    const cover = all.coverLetter || {};
    const interviewState = all.interview || {};

    return {
      pipeline: {
        scopedApps: scopedApps.length,
        submitted: submitted.length,
        stageScore: stageScore(scopedApps),
        followupReady: followupReady,
        staleSaved: staleSaved,
        appsLast7: appsLast7,
        appsLast14: appsLast14,
        interviewOrOffer: scopedApps.filter(function (a) { return a.stage === "interview" || a.stage === "offer"; }).length,
        offers: scopedApps.filter(function (a) { return a.stage === "offer"; }).length
      },
      search: {
        runs: runs.length,
        surfacedJobs: surfaced,
        savedJobs: savedJobs.length,
        savedSearches: savedSearches.length,
        searchSaveRate: searchSaveRate
      },
      resume: {
        hasBase: !!(resume.base && String(resume.base).trim()),
        hasTailored: !!resume.tailored,
        hasStructured: !!resume.structured,
        freshnessDays: resumeFreshDays
      },
      interview: {
        upcomingInterviews: upcomingInterviews,
        hasInterviewSet: !!interviewState.lastSet
      },
      coverLetter: {
        sentCount: Array.isArray(cover.sentLog) ? cover.sentLog.length : 0
      },
      calendar: {
        eventCount: events.length
      }
    };
  }

  function computeJudgeScores(signals) {
    const s = signals || {};
    const p = s.pipeline || {};
    const sr = s.search || {};
    const rs = s.resume || {};
    const iv = s.interview || {};
    const cl = s.coverLetter || {};
    const cal = s.calendar || {};

    const executionDiscipline = clampScore(
      (Math.min(1, (p.appsLast7 || 0) / 5) * 45) +
      (Math.max(0, 1 - ((p.followupReady || 0) / Math.max(1, p.submitted || 0))) * 30) +
      (Math.min(1, (cal.eventCount || 0) / 4) * 25)
    );

    const marketStrategy = clampScore(
      (Math.min(1, (sr.searchSaveRate || 0) / 25) * 40) +
      (Math.min(1, (sr.savedSearches || 0) / 4) * 20) +
      ((p.stageScore || 0) * 0.40)
    );

    const profileStrength = clampScore(
      (rs.hasBase ? 30 : 0) +
      (rs.hasStructured ? 20 : 0) +
      (rs.hasTailored ? 20 : 0) +
      ((rs.freshnessDays || 999) <= 14 ? 20 : (rs.freshnessDays <= 30 ? 10 : 0)) +
      ((cl.sentCount || 0) > 0 ? 10 : 0)
    );

    const interviewReadiness = clampScore(
      ((p.interviewOrOffer || 0) > 0 ? 40 : 0) +
      ((iv.upcomingInterviews || 0) > 0 ? 35 : 0) +
      (iv.hasInterviewSet ? 25 : 0)
    );

    const learningVelocity = clampScore(
      ((p.appsLast7 || 0) > 0 ? 35 : 0) +
      ((p.appsLast14 || 0) >= 4 ? 25 : 0) +
      ((sr.runs || 0) >= 2 ? 20 : 0) +
      ((p.followupReady || 0) === 0 ? 20 : 0)
    );

    return {
      executionDiscipline: executionDiscipline,
      marketStrategy: marketStrategy,
      profileStrength: profileStrength,
      interviewReadiness: interviewReadiness,
      learningVelocity: learningVelocity,
      weighted: clampScore(
        executionDiscipline * 0.25 +
        marketStrategy * 0.20 +
        profileStrength * 0.20 +
        interviewReadiness * 0.20 +
        learningVelocity * 0.15
      ),
      details: {
        appsLast7: p.appsLast7 || 0,
        followupReady: p.followupReady || 0,
        staleSaved: p.staleSaved || 0,
        submitted: p.submitted || 0,
        scopeSize: p.scopedApps || 0
      }
    };
  }

  function computeJudgeConfidence(scores) {
    const d = scores.details || {};
    const evidencePoints = [
      Math.min(1, (d.submitted || 0) / 12),
      Math.min(1, (d.appsLast7 || 0) / 6),
      d.followupReady > 0 || d.staleSaved > 0 ? 1 : 0.5
    ];
    const confidence = clampScore((evidencePoints[0] * 45) + (evidencePoints[1] * 35) + (evidencePoints[2] * 20));
    if (confidence >= 75) return { score: confidence, label: "High confidence" };
    if (confidence >= 50) return { score: confidence, label: "Moderate confidence" };
    return { score: confidence, label: "Low confidence" };
  }

  function computeJudgeBenchmarks(signals, scores) {
    const p = (signals && signals.pipeline) || {};
    const submitted = p.submitted || 0;
    const interviewRate = submitted ? clampScore(((p.interviewOrOffer || 0) / submitted) * 100) : 0;
    const offerRate = submitted ? clampScore(((p.offers || 0) / submitted) * 100) : 0;
    const appsLast7 = scores.details && scores.details.appsLast7 ? scores.details.appsLast7 : 0;

    const cohort = { appsPerWeek: 5, interviewRate: 22, offerRate: 6 };
    const target = { appsPerWeek: 8, interviewRate: 30, offerRate: 10 };
    return {
      current: { appsPerWeek: appsLast7, interviewRate: interviewRate, offerRate: offerRate },
      cohort: cohort,
      target: target,
      gaps: {
        appsPerWeek: appsLast7 - target.appsPerWeek,
        interviewRate: interviewRate - target.interviewRate,
        offerRate: offerRate - target.offerRate
      }
    };
  }

  function tokenizeSkillText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9+#.\-\s]/g, " ")
      .split(/\s+/)
      .filter(function (x) { return x && x.length > 1; });
  }

  const SKILL_ALIAS = {
    js: "javascript",
    ts: "typescript",
    node: "node.js",
    nodejs: "node.js",
    reactjs: "react",
    nextjs: "next.js",
    vuejs: "vue",
    aws: "aws",
    gcp: "gcp",
    ai: "ai",
    ml: "machine learning",
    nlp: "nlp",
    postgresql: "postgresql",
    postgres: "postgresql",
    mongo: "mongodb",
    k8s: "kubernetes",
    cicd: "ci/cd",
    sprinklers: "sprinkler systems",
    sprinkler: "sprinkler systems"
  };

  const SKILL_LEXICON = new Set([
    "javascript", "typescript", "python", "java", "c#", "c++", "go", "rust", "php", "ruby",
    "react", "next.js", "vue", "angular", "node.js", "express", "nestjs",
    "html", "css", "sass", "tailwind",
    "sql", "postgresql", "mysql", "mongodb", "redis",
    "aws", "gcp", "azure", "docker", "kubernetes", "terraform", "ci/cd",
    "graphql", "rest", "microservices",
    "git", "github", "linux",
    "machine learning", "deep learning", "neural networks", "statistical modeling", "nlp", "tensorflow", "pytorch", "pandas", "numpy",
    "product management", "a/b testing", "analytics",
    "fire protection", "fire detection", "fire alarms", "sprinkler systems", "sprinkler design",
    "suppression systems", "smoke control", "hydraulic calculations", "rational fire design",
    "site assessments", "site visits", "building codes", "compliance reports", "cost estimates",
    "technical knowledge", "technical oversight", "quality assurance", "project engineering",
    "stakeholder communication", "field operations", "asset reliability", "customer service"
  ]);

  const SKILL_NOISE = new Set([
    "role", "roles", "company", "candidate", "team", "strong", "experience", "years", "work",
    "building", "build", "deliver", "delivering", "good", "excellent", "high", "low", "fast",
    "communication", "skills", "problem", "solving", "ability", "plus", "bonus", "required"
  ]);

  function canonicalizeSkill(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "";
    if (SKILL_ALIAS[s]) return SKILL_ALIAS[s];
    return s;
  }

  function formatSkillLabel(skill) {
    const s = String(skill || "");
    if (!s) return "";
    if (s === "javascript") return "JavaScript";
    if (s === "typescript") return "TypeScript";
    if (s === "node.js") return "Node.js";
    if (s === "next.js") return "Next.js";
    if (s === "graphql") return "GraphQL";
    if (s === "postgresql") return "PostgreSQL";
    if (s === "ci/cd") return "CI/CD";
    if (s === "nlp") return "NLP";
    if (s === "aws") return "AWS";
    if (s === "gcp") return "GCP";
    return s.split(/\s+/).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function extractLexiconSkills(text) {
    const toks = tokenizeSkillText(text);
    const out = [];
    toks.forEach(function (t, i) {
      const one = canonicalizeSkill(t);
      const two = i < toks.length - 1 ? canonicalizeSkill(t + " " + toks[i + 1]) : "";
      const three = i < toks.length - 2 ? canonicalizeSkill(t + " " + toks[i + 1] + " " + toks[i + 2]) : "";
      if (three && SKILL_LEXICON.has(three)) out.push(three);
      if (two && SKILL_LEXICON.has(two)) out.push(two);
      if (one && SKILL_LEXICON.has(one)) out.push(one);
    });
    return out;
  }

  function detectMissingSkills(apps) {
    const resume = (window.CBV2.store.getAll().resume || {});
    const resumeCorpus = [
      resume.base || "",
      JSON.stringify(resume.structured || {}),
      JSON.stringify(resume.tailored || {})
    ].join(" ").toLowerCase();
    const seen = {};
    const candidates = [];
    const demand = {};
    const savedJobs = window.CBV2.store.getSavedJobs();
    const roleProfile = (window.CBV2.store.getJobSearchState() || {}).roleProfile || {};
    const mustHaveSet = new Set((roleProfile.mustHaveSkills || []).map(canonicalizeSkill).filter(Boolean));

    function pushCandidate(skill, source) {
      const s = canonicalizeSkill(skill);
      if (!s || !SKILL_LEXICON.has(s)) return;
      candidates.push({ skill: s, source: source });
      demand[s] = demand[s] || { roleProfile: 0, roleReason: 0, jobText: 0, total: 0 };
      if (source === "role profile") demand[s].roleProfile += 1;
      else if (source === "saved role reason") demand[s].roleReason += 1;
      else if (source === "job text") demand[s].jobText += 1;
      demand[s].total += 1;
    }

    (roleProfile.mustHaveSkills || []).forEach(function (s) {
      pushCandidate(s, "role profile");
    });
    savedJobs.forEach(function (j) {
      (j.roleReasons || []).forEach(function (s) {
        extractLexiconSkills(s).forEach(function (skill) {
          pushCandidate(skill, "saved role reason");
        });
      });
      extractLexiconSkills((j.title || "") + " " + (j.descriptionText || "")).forEach(function (skill) {
        pushCandidate(skill, "job text");
      });
    });
    const filtered = candidates.filter(function (x) {
      const skill = canonicalizeSkill(x.skill);
      if (!skill || skill.length < 3) return false;
      if (SKILL_NOISE.has(skill)) return false;
      if (!SKILL_LEXICON.has(skill)) return false;
      if (seen[skill]) return false;
      seen[skill] = true;
      return resumeCorpus.indexOf(skill) < 0;
    });
    function severityFor(skill) {
      const d = demand[skill] || { roleProfile: 0, roleReason: 0, jobText: 0, total: 0 };
      const weighted = (d.roleProfile * 5) + (d.roleReason * 3) + (d.jobText * 1);
      if (weighted >= 8 || (mustHaveSet.has(skill) && d.total >= 2)) return "critical";
      if (weighted >= 5) return "high";
      if (weighted >= 3) return "medium";
      return "low";
    }

    return filtered
      .map(function (x) {
        const s = canonicalizeSkill(x.skill);
        const d = demand[s] || { total: 0 };
        return {
          skill: formatSkillLabel(s),
          skillKey: s,
          source: x.source,
          demandCount: d.total || 0,
          severity: severityFor(s),
          profileRequired: mustHaveSet.has(s)
        };
      })
      .sort(function (a, b) {
        const rank = { critical: 4, high: 3, medium: 2, low: 1 };
        if (rank[b.severity] !== rank[a.severity]) return rank[b.severity] - rank[a.severity];
        return (b.demandCount || 0) - (a.demandCount || 0);
      })
      .slice(0, 10);
  }

  function buildSkillActionPlan(missingSkills) {
    const items = (missingSkills || []).slice(0, 8);
    return items.map(function (s) {
      const sev = String(s.severity || "low");
      const isCritical = sev === "critical" || sev === "high";
      const skill = s.skill || "this skill";
      return {
        skill: skill,
        severity: sev,
        actions: [
          "Resume proof: add 1 quantified bullet that demonstrates " + skill + " in production.",
          "Project proof: prepare one concrete example where you used " + skill + " and describe scope + impact.",
          "Interview story: craft a 90-second STAR answer centered on " + skill + "."
        ],
        priority: isCritical ? "do_this_week" : "do_this_month"
      };
    });
  }

  function updateCoachingMemory(report) {
    const state = loadJudgeState();
    state.memory = state.memory || {
      generatedCount: 0,
      recurringGaps: {},
      lastActions: [],
      adherenceStreak: 0,
      previousScore: null
    };
    state.memory.generatedCount += 1;
    (report.missing || []).forEach(function (m) {
      state.memory.recurringGaps[m] = (state.memory.recurringGaps[m] || 0) + 1;
    });
    state.memory.lastActions = (report.actions || []).slice(0, 4);
    if (state.memory.previousScore == null || report.score >= state.memory.previousScore) {
      state.memory.adherenceStreak += 1;
    } else {
      state.memory.adherenceStreak = 0;
    }
    state.memory.previousScore = report.score;
    saveJudgeState(state);
    return state.memory;
  }

  function memoryHighlights(memory) {
    const recurring = Object.keys((memory && memory.recurringGaps) || {})
      .map(function (k) { return { text: k, count: memory.recurringGaps[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 3);
    return {
      recurring: recurring,
      streak: memory && typeof memory.adherenceStreak === "number" ? memory.adherenceStreak : 0,
      generatedCount: memory && typeof memory.generatedCount === "number" ? memory.generatedCount : 0
    };
  }

  function buildImprovementPlans(scores, benchmarks) {
    const seven = [];
    const thirty = [];
    const d = scores.details || {};
    if (d.followupReady > 0) seven.push("Clear all pending follow-ups (>=7d old) within 48 hours.");
    seven.push("Submit " + Math.max(5, benchmarks.target.appsPerWeek) + " tailored applications this week.");
    if (scores.profileStrength < 70) seven.push("Refresh resume base and ship at least 1 tailored resume for top-fit roles.");
    seven.push("Run one interview drill and log feedback in Interview Coach.");

    thirty.push("Stabilize weekly output to 7-8 high-fit applications/week for 4 consecutive weeks.");
    thirty.push("Lift interview rate toward " + benchmarks.target.interviewRate + "% by narrowing role targeting and resume alignment.");
    thirty.push("Build a repeatable follow-up cadence: day 7 and day 12 for every submitted application.");
    thirty.push("Create 2 reusable role-specific resume variants and 2 cover-letter variants.");
    return {
      sevenDay: seven.slice(0, 4),
      thirtyDay: thirty.slice(0, 4)
    };
  }

  function buildJudgeTrendFromWindows() {
    const now = Date.now();
    const currentSignals = collectJudgeSignals({
      referenceMs: now,
      windowStartMs: now - (7 * DAY_MS),
      windowEndMs: now
    });
    const previousSignals = collectJudgeSignals({
      referenceMs: now - (7 * DAY_MS),
      windowStartMs: now - (14 * DAY_MS),
      windowEndMs: now - (7 * DAY_MS)
    });
    const current = computeJudgeScores(currentSignals);
    const previous = computeJudgeScores(previousSignals);
    const cat = {
      executionDiscipline: current.executionDiscipline - previous.executionDiscipline,
      marketStrategy: current.marketStrategy - previous.marketStrategy,
      profileStrength: current.profileStrength - previous.profileStrength,
      interviewReadiness: current.interviewReadiness - previous.interviewReadiness,
      learningVelocity: current.learningVelocity - previous.learningVelocity
    };
    const overallDelta = current.weighted - previous.weighted;
    return {
      overallDelta: overallDelta,
      direction: overallDelta > 0 ? "up" : overallDelta < 0 ? "down" : "flat",
      categories: cat,
      baseline: "7d_vs_prev_7d"
    };
  }

  function buildJudgeReport(apps, opts) {
    opts = opts || {};
    const variant = opts.variant || "control";
    const signals = collectJudgeSignals();
    const scores = computeJudgeScores(signals);
    const confidence = computeJudgeConfidence(scores);
    const trend = buildJudgeTrendFromWindows();
    const benchmarks = computeJudgeBenchmarks(signals, scores);
    const missingSkills = detectMissingSkills(apps);
    const skillActionPlan = buildSkillActionPlan(missingSkills);
    const plans = buildImprovementPlans(scores, benchmarks);
    const d = scores.details;
    const strengths = [];
    const missing = [];
    const actions = [];

    if (d.appsLast7 >= 5) strengths.push("Execution volume is strong this week. Keep this pace.");
    if (scores.profileStrength >= 70) strengths.push("Profile assets are in place (resume/cover-letter stack).");
    if (scores.interviewReadiness >= 60) strengths.push("Interview readiness signals are present in your workflow.");
    if (!strengths.length) strengths.push("You have a foundation, but it is underutilized.");

    if (d.followupReady > 0) missing.push(d.followupReady + " submitted applications are stale and need follow-up now.");
    if (d.staleSaved > 0) missing.push(d.staleSaved + " saved roles are decaying without conversion to applications.");
    if (scores.profileStrength < 60) missing.push("Profile strength is weak. Missing or outdated resume assets lower conversion.");
    if (scores.marketStrategy < 55) missing.push("Market strategy is unfocused: low signal that your pipeline is role-targeted.");
    if (trend.direction === "down") missing.push("Performance regressed versus your last report. Investigate execution consistency and follow-up hygiene.");
    if (!missing.length) missing.push("No critical blockers detected. Focus on compounding weekly consistency.");

    actions.push("Send follow-ups to every applied role older than 7 days.");
    actions.push("Ship at least 5 tailored applications in the next 7 days.");
    actions.push("Update resume base and generate one tailored variant for top-fit roles.");
    actions.push("Run one interview prep session and schedule at least one mock.");

    const verdict =
      variant === "challenger"
        ? (scores.weighted >= 80 ? "Execution is good, but complacency will kill momentum. Raise conversion quality now."
          : scores.weighted >= 60 ? "This is not enough. Your process leaks value and must be corrected this week."
          : "Performance is failing the objective. Current behavior will not produce top-tier outcomes.")
        : (scores.weighted >= 80 ? "Strong execution. Keep pressure high and optimize for interviews."
          : scores.weighted >= 60 ? "Mid-tier performance. You're active, but you're leaking conversion."
          : "Underperforming. Activity exists, but the system is inefficient and inconsistent.");

    return {
      id: "judge_" + Date.now().toString(36),
      generatedAt: new Date().toISOString(),
      variant: variant,
      score: scores.weighted,
      confidence: confidence,
      trend: trend,
      benchmarks: benchmarks,
      missingSkills: missingSkills,
      skillActionPlan: skillActionPlan,
      plans: plans,
      signalBreakdown: {
        search: clampScore((Math.min(1, (signals.search.searchSaveRate || 0) / 25) * 70) + (Math.min(1, (signals.search.savedSearches || 0) / 4) * 30)),
        resume: clampScore((signals.resume.hasBase ? 35 : 0) + (signals.resume.hasStructured ? 25 : 0) + (signals.resume.hasTailored ? 20 : 0) + ((signals.resume.freshnessDays || 999) <= 14 ? 20 : 0)),
        interview: clampScore(((signals.interview.upcomingInterviews || 0) > 0 ? 55 : 0) + (signals.interview.hasInterviewSet ? 45 : 0)),
        calendar: clampScore(Math.min(100, (signals.calendar.eventCount || 0) * 20))
      },
      verdict: verdict,
      categories: [
        { key: "executionDiscipline", label: "Execution Discipline", weight: 25, score: scores.executionDiscipline },
        { key: "marketStrategy", label: "Market Strategy", weight: 20, score: scores.marketStrategy },
        { key: "profileStrength", label: "Profile Strength", weight: 20, score: scores.profileStrength },
        { key: "interviewReadiness", label: "Interview Readiness", weight: 20, score: scores.interviewReadiness },
        { key: "learningVelocity", label: "Learning Velocity", weight: 15, score: scores.learningVelocity }
      ],
      strengths: strengths.slice(0, 3),
      missing: missing.slice(0, 4),
      actions: actions.slice(0, 4),
      generatedFrom: {
        scope: "phase4_experimentation",
        variant: variant
      }
    };
  }

  function updateExperimentStats(state, newReport) {
    state.experiments = state.experiments || {
      assignments: {},
      stats: {
        control: { reports: 0, avgScoreDelta: 0, improvements: 0 },
        challenger: { reports: 0, avgScoreDelta: 0, improvements: 0 }
      },
      lastVariant: "control",
      policy: { lockedVariant: "", minSamplesPerArm: 4, minDeltaToLock: 1.5 }
    };
    const variant = newReport && newReport.variant ? newReport.variant : "control";
    const stats = state.experiments.stats[variant] || { reports: 0, avgScoreDelta: 0, improvements: 0 };
    const prev = state.reports && state.reports[1] ? state.reports[1] : null;
    const delta = prev ? Number(newReport.score || 0) - Number(prev.score || 0) : 0;
    const nextReports = stats.reports + 1;
    stats.avgScoreDelta = ((stats.avgScoreDelta * stats.reports) + delta) / Math.max(1, nextReports);
    stats.reports = nextReports;
    if (delta > 0) stats.improvements += 1;
    state.experiments.stats[variant] = stats;
    state.experiments.lastVariant = variant;
    maybeLockWinnerVariant(state);
  }

  function maybeLockWinnerVariant(state) {
    const ex = state.experiments || {};
    ex.policy = ex.policy || { lockedVariant: "", minSamplesPerArm: 4, minDeltaToLock: 1.5 };
    if (ex.policy.lockedVariant) return;
    const stats = ex.stats || {};
    const c = stats.control || { reports: 0, avgScoreDelta: 0, improvements: 0 };
    const h = stats.challenger || { reports: 0, avgScoreDelta: 0, improvements: 0 };
    const minN = Number(ex.policy.minSamplesPerArm || 4);
    const minDelta = Number(ex.policy.minDeltaToLock || 1.5);
    if (c.reports < minN || h.reports < minN) return;

    const cImproveRate = c.reports ? (c.improvements / c.reports) : 0;
    const hImproveRate = h.reports ? (h.improvements / h.reports) : 0;
    const cScore = (c.avgScoreDelta * 0.7) + (cImproveRate * 10 * 0.3);
    const hScore = (h.avgScoreDelta * 0.7) + (hImproveRate * 10 * 0.3);
    const diff = hScore - cScore;
    if (Math.abs(diff) < minDelta) return;
    ex.policy.lockedVariant = diff > 0 ? "challenger" : "control";
    state.experiments = ex;
  }

  function judgeBand(score) {
    if (score >= 80) return { tone: "green", label: "High performance" };
    if (score >= 60) return { tone: "violet", label: "Needs optimization" };
    return { tone: "warning", label: "Critical gaps" };
  }

  function renderJudgePanel(apps) {
    const st = getSt();
    const judgeState = loadJudgeState();
    const latest = judgeState.reports.length ? judgeState.reports[0] : null;
    if (!latest) {
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head">' +
            '<h2>AI Judge (Phase 1)</h2>' +
            '<span class="chip warning">No report yet</span>' +
          '</div>' +
          '<p class="page-subtitle">Generate your weekly ruthless report: score, what is missing, what is working, and the exact next actions.</p>' +
          '<div class="hero-actions"><button class="btn-primary" id="judge-generate" type="button"><i class="fa-solid fa-gavel"></i> Generate report</button></div>' +
        '</section>'
      );
    }

    const band = judgeBand(latest.score);
    const scoreRows = latest.categories.map(function (c) {
      const delta = latest.trend && latest.trend.categories ? Number(latest.trend.categories[c.key] || 0) : 0;
      const deltaText = delta > 0 ? " +" + delta : delta < 0 ? " " + delta : " 0";
      return (
        '<div class="conv-row">' +
          '<span class="conv-label">' + st(c.label) + ' · ' + c.weight + '%</span>' +
          '<div class="conv-track"><span class="conv-fill" style="width:' + c.score + '%;background:#6b7dff"></span></div>' +
          '<span class="conv-rate">' + c.score + '</span>' +
          '<span class="conv-count">' + deltaText + '</span>' +
        '</div>'
      );
    }).join("");

    function list(title, items, tone) {
      return (
        '<article class="card panel-lg">' +
          '<div class="panel-head"><h2>' + st(title) + '</h2><span class="chip ' + tone + '">' + items.length + '</span></div>' +
          '<ul class="stale-list">' +
            items.map(function (x) { return '<li class="stale-item"><div class="stale-body">' + st(x) + "</div></li>"; }).join("") +
          '</ul>' +
        '</article>'
      );
    }

    function benchmarkCard(data) {
      const b = data || { current: {}, cohort: {}, target: {}, gaps: {} };
      function gap(v) { return v > 0 ? "+" + v : String(v || 0); }
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head"><h2>Benchmark Positioning</h2><span class="chip blue">Phase 2</span></div>' +
          '<div class="conv-grid">' +
            '<div class="conv-row"><span class="conv-label">Applications / week</span><div class="conv-track"><span class="conv-fill" style="width:' + Math.min(100, (b.current.appsPerWeek || 0) * 10) + '%;background:#22d3ee"></span></div><span class="conv-rate">' + (b.current.appsPerWeek || 0) + '</span><span class="conv-count">target ' + (b.target.appsPerWeek || 0) + ' (' + gap(b.gaps.appsPerWeek) + ')</span></div>' +
            '<div class="conv-row"><span class="conv-label">Interview rate</span><div class="conv-track"><span class="conv-fill" style="width:' + (b.current.interviewRate || 0) + '%;background:#6b7dff"></span></div><span class="conv-rate">' + (b.current.interviewRate || 0) + '%</span><span class="conv-count">target ' + (b.target.interviewRate || 0) + '% (' + gap(b.gaps.interviewRate) + ')</span></div>' +
            '<div class="conv-row"><span class="conv-label">Offer rate</span><div class="conv-track"><span class="conv-fill" style="width:' + (b.current.offerRate || 0) + '%;background:#22c55e"></span></div><span class="conv-rate">' + (b.current.offerRate || 0) + '%</span><span class="conv-count">target ' + (b.target.offerRate || 0) + '% (' + gap(b.gaps.offerRate) + ')</span></div>' +
          '</div>' +
        '</section>'
      );
    }

    function globalHealthCard(breakdown) {
      const b = breakdown || {};
      const rows = [
        { label: "Search health", score: Number(b.search || 0), color: "#22d3ee" },
        { label: "Resume health", score: Number(b.resume || 0), color: "#6b7dff" },
        { label: "Interview health", score: Number(b.interview || 0), color: "#22c55e" },
        { label: "Calendar discipline", score: Number(b.calendar || 0), color: "#f59e0b" }
      ];
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head"><h2>Whole Dashboard Health</h2><span class="chip cyan">Beyond pipeline</span></div>' +
          '<div class="conv-grid">' +
            rows.map(function (r) {
              return '<div class="conv-row"><span class="conv-label">' + st(r.label) + '</span><div class="conv-track"><span class="conv-fill" style="width:' + r.score + '%;background:' + r.color + '"></span></div><span class="conv-rate">' + r.score + '</span></div>';
            }).join("") +
          '</div>' +
        '</section>'
      );
    }

    function missingSkillsCard(items) {
      function sevTone(sev) {
        return sev === "critical" ? "rose"
          : sev === "high" ? "warning"
          : sev === "medium" ? "violet"
          : "cyan";
      }
      const listItems = (items || []).slice(0, 8).map(function (x) {
        return (
          '<li class="stale-item">' +
            '<div class="stale-body"><strong>' + st(x.skill) + '</strong><span class="ai-meta">missing · demand ' + (x.demandCount || 0) + ' · from ' + st(x.source) + (x.profileRequired ? " · required by role profile" : "") + '</span></div>' +
            '<span class="chip ' + sevTone(x.severity) + '">' + st(String(x.severity || "low")) + '</span>' +
          '</li>'
        );
      }).join("");
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head"><h2>Missing Skills Detector</h2><span class="chip warning">' + ((items || []).length) + '</span></div>' +
          ((items || []).length
            ? '<ul class="stale-list">' + listItems + '</ul>'
            : '<p class="ai-meta">No high-signal missing skills detected from your current saved roles and profile.</p>') +
        '</section>'
      );
    }

    function coachingMemoryCard(memory) {
      const h = memoryHighlights(memory);
      const recurringRows = h.recurring.map(function (r) {
        return '<li class="stale-item"><div class="stale-body">' + st(r.text) + '</div><span class="chip warning">' + r.count + 'x</span></li>';
      }).join("");
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head"><h2>Coaching Memory</h2><span class="chip violet">Phase 3</span></div>' +
          '<div class="card-grid">' +
            '<article class="card kpi-card"><div class="kpi-head"><span class="chip cyan">Reports generated</span></div><div class="value">' + h.generatedCount + '</div></article>' +
            '<article class="card kpi-card"><div class="kpi-head"><span class="chip green">Adherence streak</span></div><div class="value">' + h.streak + '</div><div class="kpi-foot"><span class="kpi-sub">non-regressing reports</span></div></article>' +
          '</div>' +
          (h.recurring.length
            ? '<ul class="stale-list">' + recurringRows + '</ul>'
            : '<p class="ai-meta">No recurring weakness pattern yet. Generate reports weekly to build signal.</p>') +
        '</section>'
      );
    }

    function experimentCard(experiments, latestReport) {
      const ex = experiments || {};
      const stats = ex.stats || {};
      const policy = ex.policy || {};
      const c = stats.control || { reports: 0, avgScoreDelta: 0, improvements: 0 };
      const h = stats.challenger || { reports: 0, avgScoreDelta: 0, improvements: 0 };
      function fmt(n) { return (n > 0 ? "+" : "") + (Math.round(n * 10) / 10); }
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head"><h2>Phase 4 Experiments</h2><span class="chip blue">A/B enabled</span></div>' +
          '<p class="ai-meta">Current report variant: <strong>' + st(variantLabel(latestReport && latestReport.variant)) + '</strong></p>' +
          '<p class="ai-meta">Selection policy: ' + (policy.lockedVariant ? ('locked to <strong>' + st(variantLabel(policy.lockedVariant)) + "</strong>") : ('auto-rotate until each arm reaches ' + (policy.minSamplesPerArm || 4) + ' samples')) + '.</p>' +
          '<div class="conv-grid">' +
            '<div class="conv-row"><span class="conv-label">Control avg score delta</span><div class="conv-track"><span class="conv-fill" style="width:' + Math.min(100, Math.abs(c.avgScoreDelta) * 10) + '%;background:#22d3ee"></span></div><span class="conv-rate">' + fmt(c.avgScoreDelta) + '</span><span class="conv-count">' + c.improvements + '/' + c.reports + ' improved</span></div>' +
            '<div class="conv-row"><span class="conv-label">Challenger avg score delta</span><div class="conv-track"><span class="conv-fill" style="width:' + Math.min(100, Math.abs(h.avgScoreDelta) * 10) + '%;background:#6b7dff"></span></div><span class="conv-rate">' + fmt(h.avgScoreDelta) + '</span><span class="conv-count">' + h.improvements + '/' + h.reports + ' improved</span></div>' +
          '</div>' +
        '</section>'
      );
    }

    function skillActionsCard(plan) {
      const top = (plan || []).slice(0, 4);
      if (!top.length) {
        return (
          '<section class="card panel-lg">' +
            '<div class="panel-head"><h2>Skill Gap Action Mapper</h2><span class="chip cyan">Phase 3.3</span></div>' +
            '<p class="ai-meta">No critical skill actions to map yet.</p>' +
          '</section>'
        );
      }
      const rows = top.map(function (p) {
        const tone = p.severity === "critical" ? "rose" : p.severity === "high" ? "warning" : "violet";
        return (
          '<article class="card panel-lg">' +
            '<div class="panel-head"><h2>' + st(p.skill) + '</h2><span class="chip ' + tone + '">' + st(p.severity) + '</span></div>' +
            '<ul class="stale-list">' +
              (p.actions || []).map(function (a) { return '<li class="stale-item"><div class="stale-body">' + st(a) + '</div></li>'; }).join("") +
            '</ul>' +
          '</article>'
        );
      }).join("");
      return (
        '<section class="card panel-lg">' +
          '<div class="panel-head"><h2>Skill Gap Action Mapper</h2><span class="chip cyan">Phase 3.3</span></div>' +
          '<p class="ai-meta">Each gap now has an execution path: resume proof, project proof, and interview story.</p>' +
          rows +
        '</section>'
      );
    }

    return (
      '<section class="card panel-lg">' +
        '<div class="panel-head">' +
          '<h2>AI Judge (Phase 1)</h2>' +
          '<span class="chip ' + band.tone + '">' + band.label + '</span>' +
        '</div>' +
        '<div class="card-grid">' +
          '<article class="card kpi-card"><div class="kpi-head"><span class="chip cyan">Overall score</span></div><div class="value">' + latest.score + '/100</div><div class="kpi-foot"><span class="kpi-sub">' + st(new Date(latest.generatedAt).toLocaleString()) + '</span></div></article>' +
          '<article class="card kpi-card"><div class="kpi-head"><span class="chip violet">Verdict</span></div><div class="kpi-foot"><span class="kpi-sub">' + st(latest.verdict) + '</span></div></article>' +
          '<article class="card kpi-card"><div class="kpi-head"><span class="chip blue">Trend</span></div><div class="value">' + (latest.trend && latest.trend.overallDelta > 0 ? "+" : "") + (latest.trend ? latest.trend.overallDelta : 0) + '</div><div class="kpi-foot"><span class="kpi-sub">last 7d vs prior 7d</span></div></article>' +
          '<article class="card kpi-card"><div class="kpi-head"><span class="chip cyan">Confidence</span></div><div class="value">' + (latest.confidence ? latest.confidence.score : 0) + '</div><div class="kpi-foot"><span class="kpi-sub">' + st(latest.confidence ? latest.confidence.label : "Unknown") + '</span></div></article>' +
        '</div>' +
        '<div class="conv-grid">' + scoreRows + '</div>' +
        '<div class="hero-actions" style="margin-top:10px;"><button class="btn-secondary" id="judge-generate" type="button"><i class="fa-solid fa-arrows-rotate"></i> Regenerate report</button></div>' +
      '</section>' +
      benchmarkCard(latest.benchmarks) +
      globalHealthCard(latest.signalBreakdown || {}) +
      '<section class="two-pane">' +
        missingSkillsCard(latest.missingSkills || []) +
        coachingMemoryCard(latest.memory || null) +
      '</section>' +
      experimentCard(judgeState.experiments || {}, latest) +
      skillActionsCard(latest.skillActionPlan || []) +
      '<section class="two-pane">' +
        list("What You Are Doing Well", latest.strengths || [], "green") +
        list("What Is Missing", latest.missing || [], "warning") +
      '</section>' +
      '<section class="two-pane">' +
        list("Priority 7-Day Actions", (latest.plans && latest.plans.sevenDay) || latest.actions || [], "cyan") +
        list("30-Day Plan", (latest.plans && latest.plans.thirtyDay) || [], "violet") +
      '</section>'
    );
  }

  function generateJudgeReportAndRender() {
    const apps = window.CBV2.store.getApplications();
    const state = loadJudgeState();
    state.experiments = state.experiments || {
      assignments: {},
      stats: {
        control: { reports: 0, avgScoreDelta: 0, improvements: 0 },
        challenger: { reports: 0, avgScoreDelta: 0, improvements: 0 }
      },
      lastVariant: "control",
      policy: { lockedVariant: "", minSamplesPerArm: 4, minDeltaToLock: 1.5 }
    };
    const variant = judgeVariantForNextReport(state);
    const report = buildJudgeReport(apps, { variant: variant });
    state.reports = [report].concat(state.reports || []).slice(0, 12);
    saveJudgeState(state);
    report.memory = updateCoachingMemory(report);
    state.reports[0] = report;
    updateExperimentStats(state, report);
    saveJudgeState(state);
    if (window.CBV2.toast) window.CBV2.toast.success("AI Judge report generated.");
    window.CBV2.renderCurrentRoute();
  }

  function roleProfileLabel(rp) {
    rp = rp || {};
    const titles = Array.isArray(rp.targetTitles) ? rp.targetTitles : [];
    if (titles.length) return titles.slice(0, 2).join(", ");
    if (rp.seniority && rp.seniority !== "any") return "Seniority: " + rp.seniority;
    return "Unscoped profile";
  }

  function computeSearchQuality(apps) {
    const store = window.CBV2.store;
    const savedJobs = store.getSavedJobs();
    const analytics = store.getJobSearchAnalytics ? store.getJobSearchAnalytics() : { runs: [] };
    const runs = (analytics.runs || []).slice(0, 50);
    const totalSeen = runs.reduce(function (s, r) { return s + (r.total || 0); }, 0);
    const totalSaved = savedJobs.length;
    const searchToSaveRate = totalSeen ? Math.round((totalSaved / totalSeen) * 100) : 0;

    function appMatchesSaved(a) {
      if (!a) return null;
      const byUrl = savedJobs.find(function (j) { return j.url && a.jobUrl && j.url === a.jobUrl; });
      if (byUrl) return byUrl;
      return savedJobs.find(function (j) {
        return String(j.company || "").toLowerCase() === String(a.company || "").toLowerCase() &&
          String(j.title || "").toLowerCase() === String(a.role || "").toLowerCase();
      }) || null;
    }

    const appliedApps = apps.filter(function (a) { return a.stage !== "saved"; });
    const fromSaved = appliedApps.filter(function (a) { return !!appMatchesSaved(a); });
    const saveToApplyRate = totalSaved ? Math.round((fromSaved.length / totalSaved) * 100) : 0;

    const profMap = {};
    fromSaved.forEach(function (a) {
      const sj = appMatchesSaved(a);
      const key = roleProfileLabel((sj && sj.roleProfile) || {});
      if (!profMap[key]) profMap[key] = { applied: 0, interview: 0 };
      profMap[key].applied += 1;
      if (a.stage === "interview" || a.stage === "offer") profMap[key].interview += 1;
    });
    const profileRows = Object.keys(profMap).map(function (k) {
      const row = profMap[k];
      row.profile = k;
      row.rate = row.applied ? Math.round((row.interview / row.applied) * 100) : 0;
      return row;
    }).sort(function (a, b) { return b.rate - a.rate; }).slice(0, 5);

    const providerMap = {};
    savedJobs.forEach(function (j) {
      const src = j.source || "unknown";
      if (!providerMap[src]) providerMap[src] = { saved: 0, applied: 0, interview: 0 };
      providerMap[src].saved += 1;
      const app = apps.find(function (a) {
        if (j.url && a.jobUrl) return j.url === a.jobUrl;
        return String(a.company || "").toLowerCase() === String(j.company || "").toLowerCase() &&
          String(a.role || "").toLowerCase() === String(j.title || "").toLowerCase();
      });
      if (app && app.stage !== "saved") providerMap[src].applied += 1;
      if (app && (app.stage === "interview" || app.stage === "offer")) providerMap[src].interview += 1;
    });
    const providerRows = Object.keys(providerMap).map(function (k) {
      const row = providerMap[k];
      row.source = k;
      row.applyRate = row.saved ? Math.round((row.applied / row.saved) * 100) : 0;
      row.interviewRate = row.applied ? Math.round((row.interview / row.applied) * 100) : 0;
      return row;
    }).sort(function (a, b) { return b.interviewRate - a.interviewRate; }).slice(0, 6);

    const latestDiag = runs[0] && runs[0].diagnostics && runs[0].diagnostics.counts ? runs[0].diagnostics.counts : null;
    return {
      runCount: runs.length,
      searchToSaveRate: searchToSaveRate,
      saveToApplyRate: saveToApplyRate,
      profileRows: profileRows,
      providerRows: providerRows,
      latestDiag: latestDiag
    };
  }

  function renderSearchQualityCard(apps) {
    const st = getSt();
    const m = computeSearchQuality(apps);
    const profileRows = m.profileRows.map(function (r) {
      return '<div class="conv-row"><span class="conv-label">' + st(r.profile) + '</span><div class="conv-track"><span class="conv-fill" style="width:' + r.rate + '%;background:#22c55e"></span></div><span class="conv-rate">' + r.rate + '%</span><span class="conv-count">' + r.interview + "/" + r.applied + "</span></div>";
    }).join("");
    const providerRows = m.providerRows.map(function (r) {
      return '<div class="conv-row"><span class="conv-label">' + st(r.source) + '</span><div class="conv-track"><span class="conv-fill" style="width:' + r.interviewRate + '%;background:#6b7dff"></span></div><span class="conv-rate">' + r.interviewRate + '%</span><span class="conv-count">' + r.applied + "/" + r.saved + "</span></div>";
    }).join("");
    const diag = m.latestDiag
      ? ('<p class="ai-meta">Latest search funnel: fetched ' + (m.latestDiag.fetched || 0) +
        " → deduped " + (m.latestDiag.afterDedupe || 0) +
        " → base filters " + (m.latestDiag.afterBaseFilters || 0) +
        " → role-pass " + (m.latestDiag.afterIntentFilters || 0) + ".</p>")
      : '<p class="ai-meta">Run a few searches to unlock role-filter diagnostics.</p>';
    const searchValue = m.runCount ? (m.searchToSaveRate + "%") : "No signal";
    const applyValue = m.runCount ? (m.saveToApplyRate + "%") : "No signal";
    return (
      '<section class="card panel-lg">' +
        '<div class="panel-head"><h2>Search Quality Loop</h2><span class="chip cyan">' + m.runCount + ' recent runs</span></div>' +
        '<div class="card-grid">' +
          '<article class="card kpi-card"><div class="kpi-head"><span class="chip cyan">Search → Save</span></div><div class="value">' + searchValue + '</div><div class="kpi-foot"><span class="kpi-sub">saved jobs vs surfaced jobs</span></div></article>' +
          '<article class="card kpi-card"><div class="kpi-head"><span class="chip violet">Save → Apply</span></div><div class="value">' + applyValue + '</div><div class="kpi-foot"><span class="kpi-sub">applications created from saved roles</span></div></article>' +
        '</div>' +
        diag +
        '<div class="two-pane">' +
          '<article class="card panel-lg"><div class="panel-head"><h2>Interview rate by role profile</h2><span class="chip green">From saved roles</span></div>' +
          (profileRows || '<p class="ai-meta">Not enough profile-attributed applications yet.</p>') +
          '</article>' +
          '<article class="card panel-lg"><div class="panel-head"><h2>Provider relevance quality</h2><span class="chip blue">Interview / applied</span></div>' +
          (providerRows || '<p class="ai-meta">Not enough provider data yet.</p>') +
          '</article>' +
        '</div>' +
      '</section>'
    );
  }

  const FIT_STOPWORDS = new Set([
    "about", "above", "after", "again", "against", "all", "also", "and", "any", "apply",
    "are", "around", "available", "based", "been", "before", "being", "below", "between",
    "both", "candidate", "careerboost", "client", "company", "could", "date", "description",
    "different", "does", "dynamic", "each", "engineer", "engineering", "essential", "etc",
    "every", "field", "first", "from", "gauteng", "have", "high", "hire", "into", "job", "join",
    "looking", "more", "must", "needs", "posted", "profile", "project", "projects", "qualified",
    "ready", "recruiter", "ref", "relevant", "role", "roles", "source", "south", "stage",
    "strong", "summary", "team", "their", "there", "this", "through", "with", "work",
    "working", "years", "your", "africa", "centurion", "pretoria", "johannesburg", "cape",
    "town", "linkedin", "extension", "imported", "personnel", "consultants", "consulting",
    "executive", "executiveplacements", "zecutive", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april",
    "may", "june", "july", "august", "september", "october", "november", "december"
  ]);

  const FIT_DISPLAY_SINGLE_NOISE = new Set([
    "alarm", "alarms", "deep", "detection", "fire", "learning", "machine", "protection",
    "research", "scientist", "site", "sprinkler", "sprinklers", "system", "systems"
  ]);

  function normalizeFitText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9+#.\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getCandidateCorpus() {
    const api = window.CBV2.candidateIntel;
    if (api && typeof api.getCandidateCorpus === "function") {
      const corpus = api.getCandidateCorpus();
      return Object.assign({
        raw: "",
        normalized: "",
        hasResume: false,
        hasStructured: false,
        hasTailored: false
      }, corpus || {});
    }
    const store = window.CBV2.store;
    const all = store.getAll ? store.getAll() : {};
    const resume = all.resume || {};
    const pieces = [];
    if (typeof store.getEffectiveResumeBaseText === "function") {
      pieces.push(store.getEffectiveResumeBaseText() || "");
    }
    pieces.push(resume.base || "");
    pieces.push(JSON.stringify(resume.structured || {}));
    pieces.push(JSON.stringify(resume.tailored || {}));
    (resume.careerAssets || []).forEach(function (asset) {
      pieces.push(asset && asset.text ? asset.text : "");
      if (asset && Array.isArray(asset.tags)) pieces.push(asset.tags.join(" "));
    });
    return {
      raw: pieces.join("\n"),
      normalized: normalizeFitText(pieces.join("\n")),
      hasResume: pieces.join("").trim().length > 80,
      hasStructured: !!resume.structured,
      hasTailored: !!resume.tailored
    };
  }

  function getJobDescriptionFromNotes(notes) {
    const helper = window.CBV2.jobNotes;
    if (helper && typeof helper.parseImportedNotes === "function") {
      const parsed = helper.parseImportedNotes(notes);
      if (parsed) {
        return {
          intro: parsed.intro || "",
          source: parsed.source || "",
          location: parsed.location || "",
          description: parsed.description || ""
        };
      }
    }
    const raw = String(notes || "");
    const marker = raw.match(/Job description snapshot\s*:\s*([\s\S]*)$/i);
    return {
      intro: "",
      source: ((raw.match(/^Source\s*:\s*(.+)$/im) || [])[1] || "").trim(),
      location: ((raw.match(/^Location\s*:\s*(.+)$/im) || [])[1] || "").trim(),
      description: marker ? marker[1].trim() : raw
    };
  }

  function importantTerms(text, limit) {
    const counts = {};
    const tokens = normalizeFitText(text)
      .split(/\s+/)
      .map(function (word) { return word.replace(/^[.\-]+|[.\-]+$/g, ""); })
      .filter(function (word) {
        if (!word || word.length < 4) return false;
        if (/^\d+$/.test(word)) return false;
        if (FIT_STOPWORDS.has(word)) return false;
        return true;
      });
    tokens.forEach(function (word) {
      counts[word] = (counts[word] || 0) + 1;
    });
    tokens.forEach(function (word, index) {
      const two = index < tokens.length - 1 ? word + " " + tokens[index + 1] : "";
      const three = index < tokens.length - 2 ? word + " " + tokens[index + 1] + " " + tokens[index + 2] : "";
      if (two && two.length <= 42 && SKILL_LEXICON.has(two)) counts[two] = (counts[two] || 0) + 2;
      if (three && three.length <= 58 && SKILL_LEXICON.has(three)) counts[three] = (counts[three] || 0) + 2;
    });
    extractLexiconSkills(text).forEach(function (skill) {
      counts[skill] = (counts[skill] || 0) + 8;
    });
    return Object.keys(counts)
      .sort(function (a, b) {
        return counts[b] - counts[a] || a.localeCompare(b);
      })
      .slice(0, limit || 24);
  }

  function compactFitTerms(terms, limit) {
    const raw = (terms || []).map(function (term) { return normalizeFitText(term).trim(); }).filter(Boolean);
    const seen = new Set();
    const compacted = [];
    raw.forEach(function (term) {
      if (seen.has(term)) return;
      const isSingle = term.split(/\s+/).length === 1;
      if (isSingle && FIT_DISPLAY_SINGLE_NOISE.has(term)) return;
      if (isSingle && raw.some(function (other) {
        return other !== term && other.split(/\s+/).indexOf(term) >= 0;
      })) return;
      seen.add(term);
      compacted.push(term);
    });
    return compacted.slice(0, limit || 8);
  }

  function termInCorpus(term, corpus) {
    const hay = corpus.normalized || "";
    const t = normalizeFitText(term);
    if (!t) return false;
    const variants = [t];
    variants.push(t.replace(/\bsystems\b/g, "system"));
    variants.push(t.replace(/\bcalculations\b/g, "calculation"));
    variants.push(t.replace(/\bassessments\b/g, "assessment"));
    variants.push(t.replace(/\breports\b/g, "report"));
    variants.push(t.replace(/\bcodes\b/g, "code"));
    variants.push(t.replace(/\balarms\b/g, "alarm"));
    variants.push(t.replace(/\bsprinklers\b/g, "sprinkler"));
    if (/s$/.test(t) && t.length > 4 && !/css$/.test(t)) variants.push(t.slice(0, -1));
    if (variants.some(function (variant) { return variant && hay.indexOf(variant) >= 0; })) return true;
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      return parts.every(function (p) { return p.length < 4 || hay.indexOf(p) >= 0; });
    }
    return false;
  }

  function extractMaxYears(text) {
    const raw = String(text || "");
    let max = 0;
    raw.replace(/(\d+)\s*(?:[-+]\s*(\d+))?\+?\s*(?:years?|yrs?)/gi, function (_, a, b) {
      const n = Math.max(Number(a) || 0, Number(b) || 0);
      if (n > max) max = n;
      return _;
    });
    return max;
  }

  function stageReachedScore(stage) {
    const s = String(stage || "").toLowerCase();
    if (s === "offer") return 100;
    if (s === "interview") return 78;
    if (s === "applied") return 54;
    if (s === "rejected") return 24;
    if (s === "withdrawn") return 18;
    return 36;
  }

  function outcomeMemoryFor(app, apps) {
    const targetTerms = importantTerms((app.role || "") + " " + (app.company || ""), 6);
    const related = apps.filter(function (item) {
      if (!item || item.id === app.id || item.stage === "saved") return false;
      const hay = normalizeFitText((item.role || "") + " " + (item.company || ""));
      return targetTerms.some(function (term) { return hay.indexOf(normalizeFitText(term)) >= 0; });
    });
    if (!related.length) return { score: 50, count: 0 };
    const avg = related.reduce(function (sum, item) {
      return sum + stageReachedScore(item.stage);
    }, 0) / related.length;
    return { score: clampScore(avg), count: related.length };
  }

  function fitBand(score) {
    if (score >= 82) return { label: "High probability", tone: "green", action: "Apply first" };
    if (score >= 70) return { label: "Strong fit", tone: "cyan", action: "Tailor and apply" };
    if (score >= 55) return { label: "Promising", tone: "violet", action: "Improve evidence" };
    if (score >= 40) return { label: "Reach", tone: "warning", action: "Research before applying" };
    return { label: "Low-fit", tone: "rose", action: "Deprioritize" };
  }

  function scoreSavedApplicationFit(app, apps, candidate) {
    const parsed = getJobDescriptionFromNotes(app.notes || "");
    const jobText = [
      app.company || "",
      app.role || "",
      app.nextAction || "",
      parsed.location || "",
      parsed.description || "",
      app.notes || ""
    ].join("\n");
    const roleTerms = importantTerms(app.role || "", 8);
    const jobTerms = importantTerms(jobText, 30);
    const matched = jobTerms.filter(function (term) { return termInCorpus(term, candidate); });
    const missing = jobTerms.filter(function (term) { return !termInCorpus(term, candidate); });
    const displayedMatched = compactFitTerms(matched, 8);
    const displayedMissing = compactFitTerms(missing, 8);
    const titleMatched = roleTerms.filter(function (term) { return termInCorpus(term, candidate); });
    const requiredYears = extractMaxYears(jobText);
    const candidateYears = extractMaxYears(candidate.raw);
    const outcome = outcomeMemoryFor(app, apps);
    const hasDescription = (parsed.description || "").trim().length > 120;

    const skillScore = jobTerms.length ? clampScore((matched.length / jobTerms.length) * 100) : 45;
    const titleScore = roleTerms.length ? clampScore((titleMatched.length / roleTerms.length) * 100) : 52;
    const experienceScore = requiredYears
      ? clampScore(Math.min(1.15, candidateYears / requiredYears) * 86)
      : (candidate.hasResume ? 66 : 34);
    const evidenceScore = clampScore(
      (candidate.hasResume ? 34 : 0) +
      (candidate.hasStructured ? 18 : 0) +
      (candidate.hasTailored ? 12 : 0) +
      (Math.min(1, matched.length / 8) * 36)
    );
    const locationScore = /remote|hybrid|on-site|onsite|location|pretoria|centurion|cape town|johannesburg|south africa/i.test(jobText)
      ? 68
      : 58;
    const readinessScore = clampScore(
      (hasDescription ? 36 : 14) +
      (app.jobUrl ? 16 : 0) +
      (app.nextAction ? 14 : 0) +
      (candidate.hasResume ? 24 : 0) +
      (parsed.source ? 10 : 0)
    );

    let score = clampScore(
      (skillScore * 0.30) +
      (experienceScore * 0.18) +
      (titleScore * 0.16) +
      (evidenceScore * 0.14) +
      (locationScore * 0.08) +
      (readinessScore * 0.08) +
      (outcome.score * 0.06)
    );
    if (!candidate.hasResume) score = Math.min(score, 48);
    if (!hasDescription) score = Math.min(score, 64);

    const band = fitBand(score);
    const strengths = [];
    const risks = [];
    const actions = [];
    if (displayedMatched.length) strengths.push("Resume evidence overlaps with " + displayedMatched.slice(0, 4).map(formatSkillLabel).join(", ") + ".");
    if (titleMatched.length) strengths.push("Target title appears aligned with your current profile language.");
    if (candidateYears && requiredYears) strengths.push("Experience signal: resume shows about " + candidateYears + " years against a " + requiredYears + "-year ask.");
    if (outcome.count) strengths.push("Past pipeline data includes " + outcome.count + " related role " + plural(outcome.count, "signal") + ".");
    if (!candidate.hasResume) risks.push("No strong resume baseline is available, so confidence is capped.");
    if (displayedMissing.length) risks.push("Missing or weak resume evidence: " + displayedMissing.slice(0, 5).map(formatSkillLabel).join(", ") + ".");
    if (requiredYears && !candidateYears) risks.push("The job asks for experience, but the resume text does not expose years clearly.");
    if (!hasDescription) risks.push("Job description capture is thin, so the model has less evidence.");
    actions.push(score >= 70 ? "Tailor the resume and apply while the role is fresh." : "Strengthen the resume evidence before applying.");
    if (displayedMissing.length) actions.push("Add proof for " + displayedMissing.slice(0, 3).map(formatSkillLabel).join(", ") + " if it is true to your experience.");
    actions.push("Use Cover Letters to frame the strongest matched evidence.");

    return {
      app: app,
      score: score,
      band: band,
      subScores: {
        skills: skillScore,
        experience: experienceScore,
        role: titleScore,
        evidence: evidenceScore,
        readiness: readinessScore
      },
      matched: displayedMatched,
      missing: displayedMissing,
      strengths: strengths.slice(0, 3),
      risks: risks.slice(0, 3),
      actions: actions.slice(0, 3),
      confidence: candidate.hasResume && hasDescription ? "Moderate" : "Low",
      requiredYears: requiredYears,
      candidateYears: candidateYears,
      hasDescription: hasDescription
    };
  }

  function savedRoleFitSignal(apps) {
    const api = window.CBV2.candidateIntel;
    if (api && typeof api.scoreSavedApplications === "function") {
      return api.scoreSavedApplications(apps);
    }
    const saved = apps.filter(function (app) { return String(app.stage || "").toLowerCase() === "saved"; });
    const candidate = getCandidateCorpus();
    const scored = saved.map(function (app) {
      return scoreSavedApplicationFit(app, apps, candidate);
    }).sort(function (a, b) { return b.score - a.score; });
    const avg = scored.length
      ? Math.round(scored.reduce(function (sum, item) { return sum + item.score; }, 0) / scored.length)
      : 0;
    return { saved: saved, scored: scored, average: avg, candidate: candidate };
  }

  function renderFitSubscore(label, value) {
    return (
      '<span class="fit-subscore">' +
        '<small>' + getSt()(label) + '</small>' +
        '<b><i style="width:' + pct(value) + '%"></i></b>' +
        '<strong>' + pct(value) + '</strong>' +
      '</span>'
    );
  }

  function renderCandidateIntelligencePanel() {
    const api = window.CBV2.candidateIntel;
    if (!api || typeof api.build !== "function") return "";
    const st = getSt();
    const intel = api.build();
    const score = intel.scores && typeof intel.scores.readiness === "number" ? intel.scores.readiness : 0;
    const gaps = (intel.gaps || []).slice(0, 4);
    const skills = (intel.skills && intel.skills.top ? intel.skills.top : []).slice(0, 8);
    const gapHtml = gaps.length
      ? gaps.map(function (gap) {
        return '<li><i class="fa-solid fa-arrow-right"></i><a href="' + st(gap.href || "#/settings") + '">' + st(gap.label) + "</a></li>";
      }).join("")
      : '<li><i class="fa-solid fa-check"></i>No major intelligence gaps detected.</li>';
    const skillHtml = skills.length
      ? skills.map(function (skill) {
        return '<span>' + st(api.formatSkill ? api.formatSkill(skill) : skill) + "</span>";
      }).join("")
      : '<span>Add skills in Settings</span>';
    return (
      '<section class="analytics-fit-panel candidate-intel-card candidate-intel-card--analytics">' +
        '<div class="analytics-section-heading">' +
          '<div><p class="eyebrow">Candidate Intelligence Layer</p><h2>The evidence model behind every recommendation.</h2></div>' +
          '<span class="chip cyan">Shared across modules</span>' +
        '</div>' +
        '<div class="fit-summary-grid">' +
          '<article class="fit-summary-card">' +
            '<div class="fit-score-ring fit-score-ring--large" style="--fit:' + score + '"><strong>' + score + '</strong><small>readiness</small></div>' +
            '<div><span class="chip ' + (score >= 75 ? "green" : score >= 55 ? "cyan" : "warning") + '">' + (score >= 75 ? "Strong profile signal" : score >= 55 ? "Usable signal" : "Needs evidence") + '</span>' +
            '<h3>' + st((intel.identity && intel.identity.headline) || "Candidate profile") + '</h3>' +
            '<p>' + st(String(intel.evidence.count || 0)) + ' evidence items, ' + st(String((intel.roleProfile.targetTitles || []).length)) + ' target roles, and ' + st(String((intel.skills.matchedTarget || []).length)) + ' matched target skills are feeding probability and search decisions.</p></div>' +
          '</article>' +
          '<article class="fit-caveat-card">' +
            '<i class="fa-solid fa-fingerprint"></i>' +
            '<strong>Current skill signal</strong>' +
            '<div class="fit-chip-row">' + skillHtml + '</div>' +
            '<ul class="fit-action-list">' + gapHtml + '</ul>' +
          '</article>' +
        '</div>' +
      '</section>'
    );
  }

  function renderSavedRoleFitPanel(apps) {
    const st = getSt();
    const signal = savedRoleFitSignal(apps);
    if (!signal.saved.length) {
      return (
        '<section class="analytics-fit-panel">' +
          '<div class="analytics-section-heading">' +
            '<div><p class="eyebrow">Saved Role Probability Score</p><h2>No saved roles waiting for priority scoring.</h2></div>' +
            '<span class="chip cyan">Decision engine</span>' +
          '</div>' +
          '<p class="ai-meta">Save roles into the pipeline first. CareerBoost will rank them against your resume evidence before you spend time applying.</p>' +
        '</section>'
      );
    }
    const top = signal.scored[0];
    const rows = signal.scored.slice(0, 5).map(function (item, index) {
      const app = item.app;
      const band = item.band;
      const matched = item.matched.length
        ? '<div class="fit-chip-row">' + item.matched.slice(0, 5).map(function (x) { return '<span>' + st(formatSkillLabel(x)) + '</span>'; }).join("") + '</div>'
        : '<p class="ai-meta">No strong keyword overlap detected yet.</p>';
      const missing = item.missing.length
        ? '<div class="fit-chip-row fit-chip-row--risk">' + item.missing.slice(0, 5).map(function (x) { return '<span>' + st(formatSkillLabel(x)) + '</span>'; }).join("") + '</div>'
        : '<p class="ai-meta">No major missing terms surfaced.</p>';
      return (
        '<article class="fit-role-card tone-' + st(band.tone) + '">' +
          '<div class="fit-role-head">' +
            '<span class="fit-role-rank">' + String(index + 1).padStart(2, "0") + '</span>' +
            '<div class="fit-score-ring" style="--fit:' + item.score + '"><strong>' + item.score + '</strong><small>fit score</small></div>' +
            '<div class="fit-role-title">' +
              '<span class="chip ' + st(band.tone) + '">' + st(band.label) + '</span>' +
              '<h3>' + st(app.company || "Company") + '</h3>' +
              '<p>' + st(app.role || "Role") + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="fit-subscore-grid">' +
            renderFitSubscore("Skills", item.subScores.skills) +
            renderFitSubscore("Experience", item.subScores.experience) +
            renderFitSubscore("Role", item.subScores.role) +
            renderFitSubscore("Evidence", item.subScores.evidence) +
            renderFitSubscore("Readiness", item.subScores.readiness) +
          '</div>' +
          '<div class="fit-diagnostic-grid">' +
            '<div><h4>Matched evidence</h4>' + matched + '</div>' +
            '<div><h4>Gaps to address</h4>' + missing + '</div>' +
          '</div>' +
          '<ul class="fit-action-list">' +
            item.actions.map(function (action) { return '<li><i class="fa-solid fa-check"></i>' + st(action) + '</li>'; }).join("") +
          '</ul>' +
          '<div class="fit-card-actions">' +
            '<button class="btn-secondary btn-sm" type="button" data-open-app="' + st(app.id) + '"><i class="fa-solid fa-arrow-up-right-from-square"></i> Review role</button>' +
            '<a class="btn-primary btn-sm" href="#/resume"><i class="fa-solid fa-file-pen"></i> Tailor resume</a>' +
          '</div>' +
        '</article>'
      );
    }).join("");
    return (
      '<section class="analytics-fit-panel">' +
        '<div class="analytics-section-heading">' +
          '<div><p class="eyebrow">Saved Role Probability Score</p><h2>Which saved jobs deserve your effort first.</h2></div>' +
          '<span class="chip cyan">AI fit estimate, not a guarantee</span>' +
        '</div>' +
        '<div class="fit-summary-grid">' +
          '<article class="fit-summary-card">' +
            '<div class="fit-score-ring fit-score-ring--large" style="--fit:' + (top ? top.score : 0) + '"><strong>' + (top ? top.score : 0) + '</strong><small>top score</small></div>' +
            '<div><span class="chip ' + st(top ? top.band.tone : "cyan") + '">' + st(top ? top.band.action : "Waiting") + '</span>' +
            '<h3>' + st(top ? ((top.app.company || "Company") + " - " + (top.app.role || "Role")) : "No saved role") + '</h3>' +
            '<p>Average saved-role probability score: ' + signal.average + '/100. This compares job requirements with resume evidence, experience clues, readiness, and your pipeline outcomes.</p></div>' +
          '</article>' +
          '<article class="fit-caveat-card">' +
            '<i class="fa-solid fa-scale-balanced"></i>' +
            '<strong>How to read this probability</strong>' +
            '<p>This is an apply-priority model. It estimates fit and likely conversion strength from available evidence; it cannot know hidden recruiter preferences or final hiring decisions.</p>' +
          '</article>' +
        '</div>' +
        '<div class="fit-role-grid">' + rows + '</div>' +
      '</section>'
    );
  }

  function renderExplainableRecommendationPanel(apps) {
    const svc = window.CBV2.productIntel;
    if (!svc || typeof svc.analyticsRecommendations !== "function") return "";
    const st = getSt();
    const recs = svc.analyticsRecommendations(apps, {
      all: window.CBV2.store && typeof window.CBV2.store.getAll === "function" ? window.CBV2.store.getAll() : {}
    });
    const rows = (recs || []).map(function (rec, index) {
      const evidence = (rec.evidence || []).slice(0, 3).map(function (x) {
        return '<li>' + st(x) + '</li>';
      }).join("");
      const action = rec.appId
        ? '<button class="btn-secondary btn-sm" type="button" data-open-app="' + st(rec.appId) + '"><i class="fa-solid fa-arrow-up-right-from-square"></i> Review role</button>'
        : '<a class="btn-secondary btn-sm" href="' + st(rec.href || "#/applications") + '"><i class="fa-solid fa-arrow-right"></i> Open workspace</a>';
      return (
        '<article class="phase4-recommendation tone-' + st(rec.tone || "cyan") + '">' +
          '<span class="phase4-rec-rank">' + String(index + 1).padStart(2, "0") + '</span>' +
          '<div class="phase4-rec-copy">' +
            '<h3>' + st(rec.title) + '</h3>' +
            '<p>' + st(rec.reason) + '</p>' +
            (evidence ? '<ul>' + evidence + '</ul>' : "") +
            '<strong>' + st(rec.action || "Take action") + '</strong>' +
          '</div>' +
          '<div class="phase4-rec-action">' + action + '</div>' +
        '</article>'
      );
    }).join("");
    return (
      '<section class="analytics-fit-panel phase4-analytics-panel">' +
        '<div class="analytics-section-heading">' +
          '<div><p class="eyebrow">Explainable recommendations</p><h2>What the numbers are asking you to do next.</h2></div>' +
          '<span class="chip cyan">Phase 4 intelligence</span>' +
        '</div>' +
        '<div class="phase4-recommendation-grid">' + rows + '</div>' +
      '</section>'
    );
  }

  function csvEscape(s) {
    const str = String(s == null ? "" : s);
    if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  function exportCsv(apps) {
    const header = ["Company", "Role", "Stage", "Priority", "Applied", "Next action", "Notes", "Transitions"];
    const rows = apps.map(function (a) {
      return [
        a.company || "",
        a.role || "",
        a.stage || "",
        a.priority || "",
        a.appliedAt || "",
        a.nextAction || "",
        (a.notes || "").replace(/\r?\n/g, " "),
        Array.isArray(a.stageHistory) ? a.stageHistory.length : 1
      ].map(csvEscape).join(",");
    });
    const csv = header.join(",") + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = "pipeline-" + stamp + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    if (window.CBV2.toast) window.CBV2.toast.success("Exported " + apps.length + " applications to CSV.");
  }

  function renderEmpty() {
    return (
      '<section class="card panel-lg">' +
        '<div class="empty-state">' +
          '<div class="empty-state-icon"><i class="fa-solid fa-chart-column"></i></div>' +
          '<h3>Analytics unlock once your pipeline has data.</h3>' +
          '<p>Add a few applications and move them between stages — this page will populate with weekly trends, conversion rates, and time-in-stage benchmarks.</p>' +
          '<div class="empty-state-actions">' +
            '<a class="btn-primary" href="#/applications?add=1"><i class="fa-solid fa-plus"></i> Add application</a>' +
            '<a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Find roles</a>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderEmptyIntelligencePage() {
    return (
      '<section class="page-container analytics-page">' +
        '<section class="analytics-command-center analytics-command-center--empty">' +
          '<div class="analytics-command-copy">' +
            '<p class="eyebrow">Career Intelligence</p>' +
            '<h1 class="page-title">Build the signal, then optimize the search.</h1>' +
            '<p class="page-subtitle">Analytics becomes your weekly career strategy cockpit once your pipeline has movement.</p>' +
          '</div>' +
          '<aside class="analytics-score-panel">' +
            '<div class="analytics-score-ring" style="--score:0"><strong>0</strong><span>health score</span></div>' +
            '<div class="analytics-score-copy"><span class="chip warning">Waiting for data</span><h2>No signal yet</h2><p>Track applications first. The system avoids fake precision until there is enough evidence.</p></div>' +
          '</aside>' +
        '</section>' +
        '<section class="analytics-empty-intel">' +
          '<div>' +
            '<p class="eyebrow">No Pipeline Signal Yet</p>' +
            '<h2>Analytics becomes powerful after a few real moves.</h2>' +
            '<p>Add applications, move them through stages, mark follow-ups, and track cover letters. CareerBoost will turn that activity into conversion insights and next-best actions.</p>' +
            '<div class="analytics-command-actions">' +
              '<a class="btn-primary" href="#/applications?add=1"><i class="fa-solid fa-plus"></i> Add application</a>' +
              '<a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Find roles</a>' +
            '</div>' +
          '</div>' +
          '<div class="analytics-empty-unlocks">' +
            '<span><i class="fa-solid fa-chart-line"></i><strong>5 applications</strong><small>unlock conversion signal</small></span>' +
            '<span><i class="fa-solid fa-clock"></i><strong>Stage history</strong><small>unlocks velocity</small></span>' +
            '<span><i class="fa-solid fa-envelope-open-text"></i><strong>Sent letters</strong><small>unlock variant quality</small></span>' +
          '</div>' +
        '</section>' +
      '</section>'
    );
  }

  function renderView() {
    const apps = window.CBV2.store.getApplications();
    if (!apps.length) {
      return renderEmptyIntelligencePage();
    }

    const weeks = buildWeeklyBuckets(apps, 8);
    const totalInWindow = weeks.reduce(function (s, b) { return s + b.count; }, 0);
    const avgWeekly = Math.round((totalInWindow / 8) * 10) / 10;
    const averages = computeTimeInStage(apps);
    const conversions = computeStageConversion(apps);
    const intel = buildAnalyticsIntelligence(apps, weeks, conversions, averages);

    return (
      '<section class="page-container analytics-page">' +
        renderCommandCenter(intel) +
        renderNextActions(intel) +
        renderExplainableRecommendationPanel(apps) +
        renderMomentumMetrics(intel) +
        renderCandidateIntelligencePanel() +
        renderSavedRoleFitPanel(apps) +
        renderHealthMatrix(intel) +
        renderInsightCards(intel) +
        renderPipelineFunnel(intel) +

        '<section class="card panel-lg">' +
          '<div class="panel-head">' +
            '<h2>Applications per week</h2>' +
            '<span class="chip cyan">Last 8 weeks · avg ' + avgWeekly + '/wk</span>' +
          '</div>' +
          renderWeeklyChart(weeks) +
        '</section>' +

        '<section class="two-pane">' +
          '<article class="card panel-lg">' +
            '<div class="panel-head">' +
              '<h2>Stage conversion</h2>' +
              '<span class="chip green">Across all time</span>' +
            '</div>' +
            renderConversionTable(conversions) +
          '</article>' +
          '<article class="card panel-lg">' +
            '<div class="panel-head">' +
              '<h2>Average time in stage</h2>' +
              '<span class="chip violet">Pipeline velocity</span>' +
            '</div>' +
            renderTimeInStage(averages) +
          '</article>' +
        '</section>' +

        '<section class="card panel-lg">' +
          '<div class="panel-head">' +
            '<h2>Needs a nudge</h2>' +
            '<span class="chip warning">Stale ≥ 7 days</span>' +
          '</div>' +
          '<p class="page-subtitle">Applications that have sat idle — follow up, update status, or close out.</p>' +
          renderStaleList(apps) +
        '</section>' +
        renderJudgePanel(apps) +
        renderSearchQualityCard(apps) +
        renderCoverLetterCard() +
      '</section>'
    );
  }

  window.CBV2.routes.analytics = renderView;
  window.CBV2.afterRender.analytics = function () {
    const btn = document.getElementById("export-csv");
    if (btn) {
      btn.addEventListener("click", function () {
        exportCsv(window.CBV2.store.getApplications());
      });
    }
    // Stale rows and action cards open the drawer for the corresponding application.
    document.querySelectorAll("[data-open-app]").forEach(function (row) {
      const id = row.getAttribute("data-open-app");
      row.addEventListener("click", function () {
        if (window.CBV2.drawer) window.CBV2.drawer.openApplication(id);
      });
    });
    document.querySelectorAll("[data-judge-generate], #judge-generate").forEach(function (judgeBtn) {
      judgeBtn.addEventListener("click", function () {
        generateJudgeReportAndRender();
      });
    });
  };
})();
