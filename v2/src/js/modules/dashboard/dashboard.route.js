(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const DAY_MS = 24 * 60 * 60 * 1000;

  function getSt() { return window.CBV2.sanitizeText; }
  function getAiService() { return window.CBAI || {}; }

  function getProfileJobPreferences() {
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const prefs = profile && profile.preferences && typeof profile.preferences === "object" ? profile.preferences : null;
    return prefs && prefs.jobPreferences && typeof prefs.jobPreferences === "object" ? prefs.jobPreferences : null;
  }

  function getProfileCompletionState(roleProfile) {
    const auth = window.CBV2.auth;
    const user = auth && auth.getUser ? auth.getUser() : null;
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    var score = 0;
    if (user && user.email) score += 20;
    if (profile && profile.full_name) score += 25;
    if (profile && profile.headline) score += 20;
    if (profile && profile.avatar_url) score += 15;
    if (roleProfile && Array.isArray(roleProfile.targetTitles) && roleProfile.targetTitles.length) score += 20;
    return Math.max(0, Math.min(100, score));
  }

  function renderProfileNudge(roleProfile) {
    const score = getProfileCompletionState(roleProfile);
    if (score >= 80) return "";
    try {
      const ts = localStorage.getItem("cb_profile_nudge_dismissed");
      if (ts && (Date.now() - parseInt(ts, 10)) < 7 * 24 * 60 * 60 * 1000) return "";
    } catch (e) { /* private mode */ }
    return (
      '<section class="ai-notice" style="margin-top:8px; justify-content:space-between;">' +
        '<div style="display:flex; align-items:center; gap:10px; min-width:0;">' +
          '<i class="fa-solid fa-user-check" style="flex-shrink:0;"></i>' +
          '<div>Profile completeness is <strong>' + score + '%</strong>. ' +
          'Finish profile basics and role targets to improve match quality. ' +
          '<a href="#/settings?tab=me">Complete profile</a></div>' +
        '</div>' +
        '<button type="button" data-dismiss-nudge aria-label="Dismiss profile nudge" ' +
          'style="flex-shrink:0; background:none; border:none; color:inherit; opacity:0.45; ' +
          'cursor:pointer; font-size:18px; line-height:1; padding:0 2px;">' +
          '&times;' +
        '</button>' +
      '</section>'
    );
  }

  // ---------------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------------
  function toDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function daysAgo(n) { return new Date(Date.now() - n * DAY_MS); }
  // Return YYYY-MM-DD in the user's LOCAL timezone. Using toISOString() here
  // would emit UTC, putting users west of UTC into the wrong day at midnight.
  function localDayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return "";
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function daysBetween(a, b) {
    const da = toDate(a); const db = toDate(b);
    if (!da || !db) return null;
    return Math.round((db.getTime() - da.getTime()) / DAY_MS);
  }
  function humanTimeUntil(dateStr) {
    const d = toDate(dateStr);
    if (!d) return "";
    const diff = Math.round((d.getTime() - Date.now()) / DAY_MS);
    if (diff < 0) return Math.abs(diff) + "d ago";
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff < 7) return "in " + diff + " days";
    if (diff < 14) return "next week";
    return "in " + Math.round(diff / 7) + " weeks";
  }

  // Returns a fixed-length array of daily counts for the last `days` buckets,
  // oldest first. Each entry is the number of apps whose appliedAt falls on
  // that calendar day. Used to draw sparklines.
  function buildDailyCounts(apps, days) {
    const buckets = new Array(days).fill(0);
    const now = new Date();
    // Use the user's LOCAL midnight as the anchor — toISOString() returns UTC,
    // which puts users west of UTC into the wrong day at the boundary.
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayIdx = days - 1;
    apps.forEach(function (a) {
      const d = toDate(a.appliedAt);
      if (!d) return;
      const dLocal = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.round((todayLocal.getTime() - dLocal.getTime()) / DAY_MS);
      const idx = todayIdx - diff;
      if (idx >= 0 && idx < days) buckets[idx] += 1;
    });
    return buckets;
  }

  // Render an inline SVG sparkline. No external lib. Points are non-negative
  // integers. Tone is one of cyan/violet/blue/green — maps to stroke/fill.
  function renderSparkline(points, tone) {
    if (!points || !points.length) return "";
    const max = Math.max(1, Math.max.apply(null, points));
    const w = 120;
    const h = 32;
    const step = points.length > 1 ? w / (points.length - 1) : 0;
    const coords = points.map(function (v, i) {
      const x = Math.round(i * step);
      const y = Math.round(h - (v / max) * (h - 4) - 2);
      return [x, y];
    });
    const path = coords.map(function (p, i) {
      return (i === 0 ? "M" : "L") + p[0] + " " + p[1];
    }).join(" ");
    const area = path + " L " + w + " " + h + " L 0 " + h + " Z";
    const last = coords[coords.length - 1];
    const t = tone || "cyan";
    return (
      '<svg class="kpi-sparkline kpi-sparkline--' + t + '" ' +
      'viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" ' +
      'preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="spark-area" d="' + area + '"/>' +
      '<path class="spark-line" d="' + path + '"/>' +
      '<circle class="spark-dot" cx="' + last[0] + '" cy="' + last[1] + '" r="2.5"/>' +
      '</svg>'
    );
  }

  // ---------------------------------------------------------------------------
  // Metrics (Phase A: weekly + rates + deltas)
  // ---------------------------------------------------------------------------
  function computeMetrics(apps) {
    const counts = { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 };
    apps.forEach(function (a) {
      if (counts[a.stage] != null) counts[a.stage] += 1;
    });

    // Total apps that actually got submitted (have moved past "saved").
    const submitted =
      counts.applied + counts.interview + counts.offer + counts.rejected + counts.withdrawn;
    const heardBack = counts.interview + counts.offer + counts.rejected;

    // Weekly windows based on appliedAt (the date the user submitted).
    const weekStart = daysAgo(7);
    const prevWeekStart = daysAgo(14);
    const nowD = new Date();

    function inRange(dateStr, from, to) {
      const d = toDate(dateStr);
      if (!d) return false;
      return d >= from && d < to;
    }

    const thisWeek = apps.filter(function (a) { return inRange(a.appliedAt, weekStart, nowD); }).length;
    const prevWeek = apps.filter(function (a) { return inRange(a.appliedAt, prevWeekStart, weekStart); }).length;

    // Smart baseline: once we have 28+ days of history, compare this week to
    // a rolling 4-week average instead of just last week. More robust to the
    // natural noise of weekly job-search volume (holidays, interview prep
    // weeks, etc.) and a much fairer signal for mature users.
    const fourWeekStart = daysAgo(28);
    const appsInBaselineWindow = apps.filter(function (a) {
      return inRange(a.appliedAt, fourWeekStart, weekStart);
    }).length;
    const hasMatureHistory = (function () {
      // "Mature" = at least one application in each of the 3 prior weeks OR
      // 8+ apps in the last 28d. Guards against a single big week skewing avg.
      if (appsInBaselineWindow >= 8) return true;
      const w2 = apps.filter(function (a) { return inRange(a.appliedAt, daysAgo(14), daysAgo(7)); }).length;
      const w3 = apps.filter(function (a) { return inRange(a.appliedAt, daysAgo(21), daysAgo(14)); }).length;
      const w4 = apps.filter(function (a) { return inRange(a.appliedAt, daysAgo(28), daysAgo(21)); }).length;
      return w2 > 0 && w3 > 0 && w4 > 0;
    })();
    const baselineWeekly = hasMatureHistory
      ? Math.round(appsInBaselineWindow / 3)  // last 3 prior weeks (excl. this week)
      : prevWeek;
    const baselineLabel = hasMatureHistory ? "vs 4-wk avg" : "vs last week";

    const replyRate = submitted ? Math.round((heardBack / submitted) * 100) : 0;
    const prevReplyRate = (function () {
      // Approximate previous-window reply rate using only apps submitted >7d ago.
      const older = apps.filter(function (a) {
        const d = toDate(a.appliedAt);
        return d && d < weekStart;
      });
      const olderSubmitted = older.filter(function (a) {
        return a.stage !== "saved";
      }).length;
      const olderHeard = older.filter(function (a) {
        return a.stage === "interview" || a.stage === "offer" || a.stage === "rejected";
      }).length;
      return olderSubmitted ? Math.round((olderHeard / olderSubmitted) * 100) : 0;
    })();

    const interviewRate = submitted ? Math.round(((counts.interview + counts.offer) / submitted) * 100) : 0;

    return {
      stageCounts: counts,
      submitted: submitted,
      heardBack: heardBack,
      thisWeek: thisWeek,
      prevWeek: prevWeek,
      baselineWeekly: baselineWeekly,
      baselineLabel: baselineLabel,
      hasMatureHistory: hasMatureHistory,
      weeklyDelta: thisWeek - baselineWeekly,
      replyRate: replyRate,
      replyRateDelta: replyRate - prevReplyRate,
      interviewRate: interviewRate,
      offers: counts.offer
    };
  }

  // ---------------------------------------------------------------------------
  // Derived state for hero + Next Best Actions
  // ---------------------------------------------------------------------------
  function deriveState(apps, events, savedSearches, digest, savedJobs, roleProfile) {
    const now = new Date();
    const todayISO = localDayKey(now);

    // Upcoming interviews within 72h — highest urgency.
    const upcomingInterviews = events
      .filter(function (e) {
        if (!e || !e.date) return false;
        if (e.type && e.type !== "interview") return false;
        const diff = daysBetween(todayISO, e.date);
        return diff !== null && diff >= 0 && diff <= 3;
      })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });

    // Any interview in next 2 weeks — for hero if none in 72h.
    const weekInterviews = events
      .filter(function (e) {
        if (!e || !e.date) return false;
        if (e.type && e.type !== "interview") return false;
        const diff = daysBetween(todayISO, e.date);
        return diff !== null && diff >= 0 && diff <= 14;
      })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });

    // Apps stuck in "applied" for >5 days — classic follow-up territory.
    const stuckApplied = apps.filter(function (a) {
      if (a.stage !== "applied") return false;
      const ago = daysBetween(a.appliedAt, todayISO);
      return ago !== null && ago >= 5;
    });

    // Apps saved but not yet applied, sitting for >3 days.
    const staleSaved = apps.filter(function (a) {
      if (a.stage !== "saved") return false;
      const ago = daysBetween(a.appliedAt, todayISO);
      // If appliedAt is missing for saved rows, fall back to "older than 3 days"
      // by assuming creation date (not tracked) — so only count if we can prove it.
      return ago !== null && ago >= 3;
    });

    // Saved searches that found new matches recently (from digest scan).
    const hotSearches = ((digest && digest.results) || [])
      .filter(function (r) { return r && !r.error && (r.newCount || 0) >= 3; })
      .sort(function (a, b) { return (b.newCount || 0) - (a.newCount || 0); });

    const activeRoleProfile = roleProfile || {};
    const preferredTarget = Array.isArray(activeRoleProfile.targetTitles) && activeRoleProfile.targetTitles.length
      ? activeRoleProfile.targetTitles[0]
      : "";
    const hasRoleFocus =
      ((activeRoleProfile.targetTitles || []).length > 0) ||
      ((activeRoleProfile.mustHaveSkills || []).length > 0) ||
      (activeRoleProfile.seniority && activeRoleProfile.seniority !== "any");

    const highFitRecentSaved = (savedJobs || [])
      .filter(function (j) {
        if (!j || typeof j.roleFitScore !== "number") return false;
        if (j.roleFitScore < 70) return false;
        const savedAt = toDate(j.savedAt);
        if (!savedAt) return false;
        return (Date.now() - savedAt.getTime()) <= (3 * DAY_MS);
      })
      .sort(function (a, b) {
        return (b.roleFitScore || 0) - (a.roleFitScore || 0);
      });

    return {
      todayISO: todayISO,
      upcomingInterviews: upcomingInterviews,
      weekInterviews: weekInterviews,
      stuckApplied: stuckApplied,
      staleSaved: staleSaved,
      hotSearches: hotSearches,
      highFitRecentSaved: highFitRecentSaved,
      hasRoleFocus: hasRoleFocus,
      preferredTarget: preferredTarget,
      // Day 4.6 — content the user has built outside the applications
      // pipeline. Used so the dashboard doesn't render the cold-start
      // storyboard or "let's start from scratch" hero when they
      // actually have a resume saved, jobs bookmarked, or interview
      // history — they're not new, just between application rounds.
      savedJobsCount: Array.isArray(savedJobs) ? savedJobs.length : 0
    };
  }

  // Day 4.6 — detect whether the user has *any* content in the
  // candidate tables. Used to gate the "you have nothing" hero +
  // storyboard so they don't show for returning users who have a
  // resume / saved jobs / cover letters / interview history but no
  // applications yet.
  //
  // Cheap reads from the local store; called once per dashboard
  // render so the cost is negligible.
  function hasOtherActivity() {
    const store = window.CBV2 && window.CBV2.store;
    if (!store) return false;
    // Resume — base text typed in OR structured editor data OR saved CVs.
    try {
      const r = store.getResumeStructured && store.getResumeStructured();
      if (r) return true;
    } catch (_e) {}
    try {
      if (typeof store.getResumeBase === "function") {
        const base = store.getResumeBase();
        if (base && String(base).trim().length > 50) return true;
      }
    } catch (_e) {}
    // Cover letters.
    try {
      const cl = store.getCoverLetterState && store.getCoverLetterState();
      if (cl && (
        (Array.isArray(cl.variants) && cl.variants.length) ||
        (Array.isArray(cl.rolePacks) && cl.rolePacks.length) ||
        cl.lastResult
      )) return true;
    } catch (_e) {}
    // Interview history.
    try {
      const ivSet = store.getInterviewSet && store.getInterviewSet();
      if (ivSet) return true;
    } catch (_e) {}
    try {
      const mock = store.getInterviewMockSession && store.getInterviewMockSession();
      if (mock) return true;
    } catch (_e) {}
    // Saved jobs.
    try {
      const saved = store.getSavedJobs && store.getSavedJobs();
      if (Array.isArray(saved) && saved.length) return true;
    } catch (_e) {}
    // Saved searches.
    try {
      const ss = store.getSavedSearches && store.getSavedSearches();
      if (Array.isArray(ss) && ss.length) return true;
    } catch (_e) {}
    return false;
  }

  // ---------------------------------------------------------------------------
  // Hero — momentum sentence + ONE primary CTA
  // ---------------------------------------------------------------------------
  function firstName() {
    try {
      const auth = window.CBV2.auth;
      if (auth && auth.isAuthenticated && auth.isAuthenticated()) {
        const u = auth.getUser() || {};
        const meta = u.user_metadata || {};
        const fn = meta.full_name || meta.name || "";
        if (fn) return String(fn).split(" ")[0];
        if (u.email) return String(u.email).split("@")[0];
      }
    } catch (e) { /* ignore */ }
    return window.CBV2.getState().user.name || "there";
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return "Working late";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    if (h < 21) return "Good evening";
    return "Good night";
  }

  function buildMomentumSentence(metrics, derived) {
    const parts = [];
    if (derived.upcomingInterviews.length) {
      parts.push(
        derived.upcomingInterviews.length +
        " interview" + (derived.upcomingInterviews.length > 1 ? "s" : "") +
        " in the next 3 days"
      );
    } else if (derived.weekInterviews.length) {
      parts.push(
        derived.weekInterviews.length +
        " interview" + (derived.weekInterviews.length > 1 ? "s" : "") +
        " coming up"
      );
    }
    if (derived.stuckApplied.length) {
      parts.push(derived.stuckApplied.length + " application" + (derived.stuckApplied.length > 1 ? "s" : "") + " awaiting follow-up");
    }
    if (metrics.thisWeek) {
      parts.push(metrics.thisWeek + " applied this week");
    }
    if (derived.hotSearches.length) {
      const total = derived.hotSearches.reduce(function (s, r) { return s + (r.newCount || 0); }, 0);
      parts.push(total + " new matches waiting");
    }

    if (!parts.length) return "You're all caught up — a good moment to line up the next wave of applications.";
    if (parts.length === 1) return "You have " + parts[0] + ".";
    if (parts.length === 2) return "You have " + parts[0] + " and " + parts[1] + ".";
    return "You have " + parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1] + ".";
  }

  // Picks ONE primary CTA based on the most urgent signal.
  function buildPrimaryCta(apps, metrics, derived) {
    if (!apps.length) {
      // Day 4.6 — if the user has saved roles waiting, route them to
      // the Saved tab in Job Search. Pipeline is for applications; the
      // saved bookmarks live under #/job-search?tab=saved.
      const savedCount = Number(derived.savedJobsCount || 0);
      if (savedCount > 0) {
        return {
          label: "Open " + savedCount + " saved role" + (savedCount === 1 ? "" : "s"),
          href: "#/job-search?tab=saved",
          icon: "fa-bookmark"
        };
      }
      if (derived.preferredTarget) {
        return {
          label: "Find roles for " + derived.preferredTarget,
          href: "#/job-search?rerunq=" + encodeURIComponent(derived.preferredTarget),
          icon: "fa-magnifying-glass"
        };
      }
      return { label: "Find your first role", href: "#/job-search", icon: "fa-magnifying-glass" };
    }
    if (derived.upcomingInterviews.length) {
      const ev = derived.upcomingInterviews[0];
      const when = humanTimeUntil(ev.date);
      const st = getSt();
      return {
        label: "Prep for " + st((ev.title || "interview")) + " · " + when,
        href: "#/interview",
        icon: "fa-comments"
      };
    }
    if (derived.stuckApplied.length >= 3) {
      return {
        label: "Follow up with " + derived.stuckApplied.length + " companies",
        href: "#/applications",
        icon: "fa-envelope-circle-check"
      };
    }
    if (derived.hasRoleFocus && derived.highFitRecentSaved.length) {
      const top = derived.highFitRecentSaved[0];
      return {
        label: "Apply to top-fit: " + (top.title || "saved role"),
        href: "#/job-search",
        icon: "fa-crosshairs"
      };
    }
    if (derived.hotSearches.length) {
      const total = derived.hotSearches.reduce(function (s, r) { return s + (r.newCount || 0); }, 0);
      return {
        label: "Review " + total + " new matches",
        href: "#/job-search?ss=" + encodeURIComponent(derived.hotSearches[0].id),
        icon: "fa-sparkles"
      };
    }
    if (derived.staleSaved.length) {
      return {
        label: "Apply to " + derived.staleSaved.length + " saved role" + (derived.staleSaved.length > 1 ? "s" : ""),
        href: "#/applications",
        icon: "fa-paper-plane"
      };
    }
    if (metrics.thisWeek < 3) {
      return { label: "Discover new roles", href: "#/job-search", icon: "fa-magnifying-glass" };
    }
    return { label: "Review your pipeline", href: "#/applications", icon: "fa-list-check" };
  }

  // Picks the primary headline for the hero. Factual > friendly. "3 interviews
  // this week." beats "Good afternoon, Jonathan" every time.
  function buildHeroTitle(apps, metrics, derived) {
    const st = getSt();
    const name = st(firstName());
    const preferredTarget = st(derived.preferredTarget || "");
    if (!apps.length) {
      // Day 4.6 — acknowledge other content the user has built when no
      // applications have been filed yet. Order matters: most actionable
      // signal first (saved-but-not-applied), then "toolkit's ready",
      // then the totally-new welcome.
      //
      // Saved jobs live in Job Search's "Saved" tab (?tab=saved), NOT
      // in Pipeline — Pipeline is for applications. The hero copy
      // points the user to the right place so the CTA below resolves.
      const savedCount = Number(derived.savedJobsCount || 0);
      if (savedCount > 0) {
        return {
          main: '<em>' + savedCount + '</em> saved role' + (savedCount === 1 ? "" : "s") + ' waiting for an application.',
          sub:  "Open the Saved tab in Job Search to pick one, tailor a resume, and apply."
        };
      }
      if (hasOtherActivity()) {
        // They have a resume / cover letter / interview history but
        // haven't applied yet. Treat as "between rounds", not "new".
        return {
          main: 'Toolkit\'s ready, <em>' + name + '</em>. Time to find roles.',
          sub:  "Your resume + assets are saved. Run a targeted search or open the command palette to jump straight to applying."
        };
      }
      if (preferredTarget) {
        return {
          main: "Let's land your first <em>" + preferredTarget + "</em> role.",
          sub: "Your saved preferences are loaded — run a targeted search and start building momentum."
        };
      }
      return {
        main: "Let's build your pipeline, <em>" + name + "</em>.",
        sub:  "Search five job boards at once, save roles, and let AI tailor your resume for each one."
      };
    }
    if (derived.upcomingInterviews.length) {
      const n = derived.upcomingInterviews.length;
      return {
        main: n + " <em>interview" + (n > 1 ? "s" : "") + "</em> on deck this week.",
        sub:  "Open the pipeline or prep with the AI coach — whichever helps you land them."
      };
    }
    if (derived.hotSearches.length) {
      const total = derived.hotSearches.reduce(function (s, r) { return s + (r.newCount || 0); }, 0);
      if (total > 0) {
        return {
          main: "<em>" + total + "</em> new match" + (total > 1 ? "es" : "") + " matched your saved searches.",
          sub:  "Fresh roles from your tracked queries — review and apply before they get stale."
        };
      }
    }
    if (derived.stuckApplied.length >= 3) {
      return {
        main: derived.stuckApplied.length + " application" + (derived.stuckApplied.length > 1 ? "s" : "") + " need a <em>follow-up</em>.",
        sub:  "Nudge them with an AI-drafted email — most responses come from polite check-ins at 7–10 days."
      };
    }
    if (metrics.thisWeek >= 5) {
      return {
        main: "Strong week, " + name + " — <em>" + metrics.thisWeek + "</em> applications shipped.",
        sub:  "Keep momentum by following up on last week's applied roles and prepping upcoming interviews."
      };
    }
    if (metrics.thisWeek > 0) {
      return {
        main: metrics.thisWeek + " application" + (metrics.thisWeek > 1 ? "s" : "") + " this week. Let's push for <em>more</em>.",
        sub:  "Quality + volume wins the job search. Aim for 5+ tailored applications per week."
      };
    }
    return {
      main: "Your pipeline is <em>clean</em>. Let's fill the top.",
      sub:  "Review saved searches, check your resume's freshness, or open the command palette to jump anywhere."
    };
  }

  function renderHero(apps, metrics, derived) {
    const st = getSt();
    const title = buildHeroTitle(apps, metrics, derived);
    const cta = buildPrimaryCta(apps, metrics, derived);

    // Streak: consecutive days with at least one appliedAt (last 30d).
    const appliedDays = {};
    apps.forEach(function (a) {
      if (!a.appliedAt) return;
      const d = toDate(a.appliedAt);
      if (!d) return;
      appliedDays[localDayKey(d)] = true;
    });
    let streak = 0;
    for (let i = 0; i < 30; i += 1) {
      const d = localDayKey(new Date(Date.now() - i * DAY_MS));
      if (appliedDays[d]) streak += 1;
      else if (i > 0) break;
    }

    const chipsHtml = streak >= 2
      ? '<span class="chip green hero-streak" title="Days in a row with at least one application"><i class="fa-solid fa-fire"></i> ' + streak + '-day streak</span>'
      : "";

    const today = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    return `
      <section class="hero-panel hero-panel--momentum">
        <div class="hero-text">
          <p class="eyebrow">Today's focus · ${st(today)}</p>
          <h1 class="page-title hero-title">${title.main}</h1>
          <p class="page-subtitle hero-sub">${st(title.sub)}</p>
        </div>
        <div class="hero-actions hero-actions--stack">
          <a class="btn-primary hero-cta" href="${st(cta.href)}">
            <i class="fa-solid ${st(cta.icon)}" aria-hidden="true"></i>
            ${st(cta.label)}
          </a>
          <button class="btn-secondary hero-cta-secondary" type="button" data-open-palette>
            <i class="fa-solid fa-bolt"></i> Command palette
            <kbd class="palette-kbd-inline"><span class="kbd-cmd">⌘</span>K</kbd>
          </button>
          ${chipsHtml}
        </div>
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // KPI row — weekly applications + rates + deltas
  // ---------------------------------------------------------------------------
  function formatDelta(delta, suffix, baselineLabel) {
    const tip = baselineLabel
      ? ' title="Compared ' + baselineLabel + '"'
      : '';
    if (!delta) {
      return '<span class="kpi-delta kpi-delta--flat"' + tip + '>No change' +
        (baselineLabel ? ' <span class="kpi-delta-base">' + baselineLabel + '</span>' : '') +
        '</span>';
    }
    const isUp = delta > 0;
    const cls = isUp ? "kpi-delta--up" : "kpi-delta--down";
    const icon = isUp ? "fa-arrow-trend-up" : "fa-arrow-trend-down";
    const sign = isUp ? "+" : "";
    return '<span class="kpi-delta ' + cls + '"' + tip + '>' +
      '<i class="fa-solid ' + icon + '"></i> ' + sign + delta + (suffix || "") +
      (baselineLabel ? ' <span class="kpi-delta-base">' + baselineLabel + '</span>' : '') +
      '</span>';
  }

  function renderKpiCard(opts) {
    const st = getSt();
    return `
      <article class="card kpi-card">
        <div class="kpi-head">
          <span class="kpi-icon ${st(opts.tone)}"><i class="fa-solid ${st(opts.icon)}" aria-hidden="true"></i></span>
          <span class="chip ${st(opts.tone)}">${st(opts.label)}</span>
        </div>
        <div class="kpi-value-row">
          <div class="value">${st(String(opts.value))}</div>
          ${opts.sparklineHtml || ""}
        </div>
        <div class="kpi-foot">
          ${opts.subtitle ? '<span class="kpi-sub">' + st(opts.subtitle) + '</span>' : ''}
          ${opts.deltaHtml || ''}
        </div>
      </article>
    `;
  }

  function renderKpiStrip(apps, metrics) {
    // 14-day buckets of applications by appliedAt.
    const daily = buildDailyCounts(apps, 14);
    // Cumulative "submitted" curve for interview/reply/offer rates where a
    // per-day percentage doesn't make sense — we instead show the running
    // total of applications (leading indicator of pipeline velocity).
    const running = daily.reduce(function (acc, v, i) {
      acc.push((acc[i - 1] || 0) + v);
      return acc;
    }, []);

    const hasActivity = daily.some(function (v) { return v > 0; });

    const cards = [
      renderKpiCard({
        icon: "fa-paper-plane",
        label: "This week",
        tone: "cyan",
        value: metrics.thisWeek,
        subtitle: "applications sent",
        deltaHtml: formatDelta(metrics.weeklyDelta, "", metrics.baselineLabel),
        sparklineHtml: hasActivity ? renderSparkline(daily, "cyan") : ""
      }),
      renderKpiCard({
        icon: "fa-reply",
        label: "Reply rate",
        tone: "violet",
        value: metrics.replyRate + "%",
        subtitle: metrics.heardBack + " of " + metrics.submitted + " heard back",
        deltaHtml: metrics.submitted >= 5 ? formatDelta(metrics.replyRateDelta, "%", "vs prior period") : "",
        sparklineHtml: hasActivity ? renderSparkline(running, "violet") : ""
      }),
      renderKpiCard({
        icon: "fa-user-tie",
        label: "Interview rate",
        tone: "blue",
        value: metrics.interviewRate + "%",
        subtitle: (metrics.stageCounts.interview + metrics.stageCounts.offer) + " of " + metrics.submitted + " reached interview"
      }),
      renderKpiCard({
        icon: "fa-trophy",
        label: "Offers",
        tone: "green",
        value: metrics.offers,
        subtitle: metrics.offers === 1 ? "offer on the table" : "offers on the table"
      })
    ].join("");
    return '<div class="card-grid">' + cards + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Next Best Actions — priority-sorted, each with a single CTA
  // ---------------------------------------------------------------------------
  function buildActionItems(apps, events, derived) {
    const items = [];
    const st = getSt();

    // 1. Interviews in next 72h (priority 100)
    derived.upcomingInterviews.slice(0, 2).forEach(function (ev) {
      const when = humanTimeUntil(ev.date);
      items.push({
        priority: 100,
        icon: "fa-comments",
        tone: "blue",
        title: "Prep for " + (ev.title || "interview"),
        reason: when.charAt(0).toUpperCase() + when.slice(1) + " · run a 15-min mock with AI Interview Coach.",
        cta: { label: "Start prep", href: "#/interview", icon: "fa-play" }
      });
    });

    // 2. Stuck in "applied" > 5 days (priority 80)
    derived.stuckApplied.slice(0, 3).forEach(function (a) {
      const ago = daysBetween(a.appliedAt, derived.todayISO);
      items.push({
        priority: 80,
        icon: "fa-envelope-circle-check",
        tone: "violet",
        title: "Follow up at " + (a.company || "—"),
        reason: "Applied " + (ago || 0) + " days ago for " + (a.role || "role") + " — a short nudge often unsticks recruiters.",
        cta: { label: "Open application", href: "#/applications", icon: "fa-arrow-right", appId: a.id }
      });
    });

    // 3. Hot saved searches (priority 70)
    derived.hotSearches.slice(0, 2).forEach(function (s) {
      items.push({
        priority: 70,
        icon: "fa-sparkles",
        tone: "cyan",
        title: s.newCount + " new matches in \"" + s.name + "\"",
        reason: "Review them now while the listings are fresh — the best roles fill in 5–7 days.",
        cta: { label: "View matches", href: "#/job-search?ss=" + encodeURIComponent(s.id), icon: "fa-arrow-right" }
      });
    });

    // 3b. High-fit bookmarked jobs from active role profile (priority 75)
    if (derived.hasRoleFocus) {
      derived.highFitRecentSaved.slice(0, 2).forEach(function (j) {
        items.push({
          priority: 75,
          icon: "fa-crosshairs",
          tone: "green",
          title: "High-fit role: " + (j.title || "Saved role"),
          reason: "Bookmarked recently with " + (j.roleFitScore || 0) + "% role fit. Apply while it's still fresh.",
          cta: { label: "Open job search", href: "#/job-search", icon: "fa-arrow-right" }
        });
      });
    }

    // 4. Stale saved roles (priority 50)
    derived.staleSaved.slice(0, 2).forEach(function (a) {
      items.push({
        priority: 50,
        icon: "fa-paper-plane",
        tone: "warning",
        title: "Apply to " + (a.role || "saved role") + " at " + (a.company || "—"),
        reason: "Been in your pipeline without a push — tailor the resume and send it today.",
        cta: { label: "Open in pipeline", href: "#/applications", icon: "fa-arrow-right", appId: a.id }
      });
    });

    items.sort(function (a, b) { return b.priority - a.priority; });
    return items.slice(0, 4);
  }

  function renderActionCard(item) {
    const st = getSt();
    // When the action is tied to a specific application, render a button that
    // pops the drawer open rather than navigating. Keeps the user in context.
    const cta = item.cta.appId
      ? '<button class="btn-secondary nba-cta" type="button" data-open-app="' + st(item.cta.appId) + '">' +
          st(item.cta.label) + ' <i class="fa-solid ' + st(item.cta.icon) + '" aria-hidden="true"></i>' +
        '</button>'
      : '<a class="btn-secondary nba-cta" href="' + st(item.cta.href) + '">' +
          st(item.cta.label) + ' <i class="fa-solid ' + st(item.cta.icon) + '" aria-hidden="true"></i>' +
        '</a>';
    return `
      <li class="nba-item">
        <span class="nba-icon ${st(item.tone)}"><i class="fa-solid ${st(item.icon)}" aria-hidden="true"></i></span>
        <div class="nba-body">
          <strong class="nba-title">${st(item.title)}</strong>
          <span class="nba-reason">${st(item.reason)}</span>
        </div>
        ${cta}
      </li>
    `;
  }

  function renderNextBestActions(apps, events, derived) {
    const items = buildActionItems(apps, events, derived);
    if (!items.length) {
      const empty = window.CBV2.ui && window.CBV2.ui.emptyState
        ? window.CBV2.ui.emptyState({
            className: "empty-state--compact",
            icon: "fa-compass",
            title: "Nothing urgent right now.",
            body: "A good moment to add a few new roles to your pipeline or tailor your resume for a specific target.",
            actions: [
              { label: "Discover roles", href: "#/job-search", icon: "fa-magnifying-glass", className: "btn-primary" },
              { label: "Refresh resume", href: "#/resume", icon: "fa-file-lines", className: "btn-secondary" }
            ]
          })
        : "";
      return `
        <article class="card panel-lg nba-card">
          <div class="panel-head">
            <h2>Next best actions</h2>
            <span class="chip cyan">Quiet queue</span>
          </div>
          ${empty}
        </article>
      `;
    }
    return `
      <article class="card panel-lg nba-card">
        <div class="panel-head">
          <h2>Next best actions</h2>
          <span class="chip cyan">${items.length} queued</span>
        </div>
        <p class="page-subtitle nba-lede">The highest-leverage moves, ranked by urgency. Each one points to a specific company or interview.</p>
        <ul class="nba-list">${items.map(renderActionCard).join("")}</ul>
      </article>
    `;
  }

  // ---------------------------------------------------------------------------
  // Cold start — guided ladder
  // ---------------------------------------------------------------------------
  function renderColdStart() {
    // Horizontal storyboard. Each panel is a visual sketch of the
    // destination — pipeline, AI resume, analytics — not a numbered todo.
    const storyboard = `
      <div class="storyboard">
        <article class="storyboard-card storyboard-pipeline">
          <header>
            <span class="chip cyan"><i class="fa-solid fa-list-check"></i> Pipeline</span>
            <span class="storyboard-meta">Drag &amp; drop</span>
          </header>
          <div class="storyboard-visual storyboard-visual--pipeline" aria-hidden="true">
            ${[{ t: "Saved", c: 4, tone: "cyan" }, { t: "Applied", c: 7, tone: "violet" }, { t: "Interview", c: 2, tone: "blue" }, { t: "Offer", c: 1, tone: "green" }]
              .map(function (s) {
                return '<div class="sb-col"><span class="sb-col-label">' + s.t + '</span>' +
                  Array.from({ length: s.c }).map(function () { return '<span class="sb-card ' + s.tone + '"></span>'; }).join("") +
                  '</div>';
              }).join("")}
          </div>
          <p>Every application in one Kanban view — with auto-tracked stage history and AI follow-ups.</p>
        </article>

        <article class="storyboard-card storyboard-ai">
          <header>
            <span class="chip violet"><i class="fa-solid fa-wand-magic-sparkles"></i> AI tailoring</span>
            <span class="storyboard-meta">&lt; 6s / role</span>
          </header>
          <div class="storyboard-visual storyboard-visual--ai" aria-hidden="true">
            <span class="sb-line sb-line--h"></span>
            <span class="sb-line sb-line--m"></span>
            <span class="sb-line sb-line--m"></span>
            <span class="sb-line sb-line--s"></span>
            <span class="sb-highlight">React · TypeScript · A/B testing</span>
            <span class="sb-line sb-line--m"></span>
          </div>
          <p>One-click tailored resume, cover letter, and follow-up email — generated from your base resume + the job description.</p>
        </article>

        <article class="storyboard-card storyboard-analytics">
          <header>
            <span class="chip green"><i class="fa-solid fa-chart-line"></i> Analytics</span>
            <span class="storyboard-meta">8-week trend</span>
          </header>
          <div class="storyboard-visual storyboard-visual--chart" aria-hidden="true">
            ${[40, 62, 48, 78, 65, 82, 58, 90].map(function (h) {
              return '<span class="sb-bar" style="height:' + h + '%;"></span>';
            }).join("")}
          </div>
          <p>Weekly volume, stage conversion, and average time-in-stage — so you know exactly what's working.</p>
        </article>
      </div>
    `;

    const providers = [
      { n: "Remotive",  i: "fa-globe" },
      { n: "Arbeitnow", i: "fa-briefcase" },
      { n: "Jobicy",    i: "fa-laptop-code" },
      { n: "Adzuna",    i: "fa-building" },
      { n: "The Muse",  i: "fa-wand-magic-sparkles" }
    ];
    const marquee = providers.map(function (p) {
      return '<span class="provider-pill"><i class="fa-solid ' + p.i + '"></i> ' + p.n + '</span>';
    }).join("");

    return `
      <section class="card panel-lg cold-start">
        <div class="cold-start-head">
          <div>
            <span class="chip violet">Getting started</span>
            <h2 class="cold-start-title">A job-search command center — ready in 90 seconds.</h2>
            <p class="page-subtitle">Here's what unlocks the moment you add your first role. No tour, no wizard — just the destination.</p>
          </div>
          <div class="hero-actions">
            <a class="btn-primary" href="#/resume"><i class="fa-solid fa-file-lines"></i> Paste your resume</a>
            <a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Search roles</a>
          </div>
        </div>

        ${storyboard}

        <div class="provider-marquee" aria-label="Supported job boards">
          <span class="provider-marquee-label">Searches in one query across</span>
          <div class="provider-marquee-track">${marquee}${marquee}</div>
        </div>
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // Job Digest — unchanged except for layout
  // ---------------------------------------------------------------------------
  function renderDigestPanel(state) {
    const st = getSt();
    const searches = window.CBV2.store.getSavedSearches();
    if (!searches.length) {
      return `
        <article class="card panel-lg digest-card">
          <div class="panel-head">
            <h2>Job Digest</h2>
            <span class="chip cyan">AI</span>
          </div>
          <p class="page-subtitle insight-copy">
            Save a job search on the <a href="#/job-search">Job Search</a> page and we'll track new matches for you here every time you return.
          </p>
          <div class="form-actions">
            <a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Create a search</a>
          </div>
        </article>
      `;
    }

    const digest = state.digest || { busy: false, results: [] };
    const statusLine = digest.busy
      ? '<p class="ai-meta"><i class="fa-solid fa-spinner fa-spin"></i> Scanning ' + searches.length + " saved search" + (searches.length > 1 ? "es" : "") + "…</p>"
      : digest.results.length
      ? '<p class="ai-meta">Last scan: ' + st(new Date(digest.generatedAt).toLocaleString()) + "</p>"
      : '<p class="ai-meta">Ready to scan saved searches.</p>';

    const items = digest.results
      .slice()
      .sort(function (a, b) { return (b.newCount || 0) - (a.newCount || 0); })
      .map(function (r) {
        const tone = r.error ? "rose" : r.newCount > 0 ? "green" : "cyan";
        const label = r.error ? "error" : r.newCount > 0 ? "+" + r.newCount + " new" : r.total + " total";
        return (
          '<li class="digest-item">' +
          '<a href="#/job-search?ss=' + encodeURIComponent(r.id) + '" class="digest-link">' +
          '<span class="digest-name">' + st(r.name) + "</span>" +
          '<span class="chip ' + tone + '">' + label + "</span>" +
          "</a>" +
          (r.error ? '<span class="ai-error digest-error">' + st(r.error) + "</span>" : "") +
          "</li>"
        );
      }).join("");

    return `
      <article class="card panel-lg digest-card">
        <div class="panel-head">
          <h2>Job Digest</h2>
          <span class="chip cyan">${searches.length} tracked</span>
        </div>
        ${statusLine}
        <ul class="digest-list">${items}</ul>
        <div class="form-actions">
          <button class="btn-ghost" id="refresh-digest" type="button"><i class="fa-solid fa-rotate"></i> Refresh</button>
          <a class="btn-secondary" href="#/job-search">Manage searches</a>
        </div>
      </article>
    `;
  }

  // ---------------------------------------------------------------------------
  // Resume Freshness — visible signal of how stale the base resume is
  // ---------------------------------------------------------------------------
  function renderResumeFreshness() {
    const st = getSt();
    const resumeData = (window.CBV2.store.getAll() || {}).resume || {};
    const base = (resumeData.base || "").trim();
    const updatedAt = resumeData.updatedAt || "";

    if (!base) {
      return `
        <article class="card panel-sm freshness-card">
          <div class="panel-head">
            <h2>Resume freshness</h2>
            <span class="chip warning">Empty</span>
          </div>
          <p class="freshness-lede">Paste your base resume to unlock AI-tailored variants and interview prep.</p>
          <a class="btn-primary freshness-cta" href="#/resume">
            <i class="fa-solid fa-file-circle-plus"></i> Add base resume
          </a>
        </article>
      `;
    }

    const d = toDate(updatedAt);
    const ago = d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS)) : null;

    // Tone ladder: green <14d · violet 14–30d · warning 30–60d · rose >60d
    let tone = "green";
    let label = "Fresh";
    let hint = "Great — keep it tuned to your active target role.";
    if (ago === null) {
      tone = "cyan";
      label = "Unknown";
      hint = "We couldn't determine when this was last updated. Save it once to set a timestamp.";
    } else if (ago > 60) {
      tone = "rose";
      label = "Very stale";
      hint = "More than two months old — skills, titles and tools drift fast. A 15-minute refresh pays off.";
    } else if (ago > 30) {
      tone = "warning";
      label = "Stale";
      hint = "Over a month old. Add any new wins, tools or metrics from the last few weeks.";
    } else if (ago > 14) {
      tone = "violet";
      label = "Ageing";
      hint = "Good but ageing. A short pass now keeps it relevant.";
    }

    const agoLabel = ago === null
      ? "never"
      : ago === 0
      ? "today"
      : ago === 1
      ? "1 day ago"
      : ago < 14
      ? ago + " days ago"
      : ago < 60
      ? Math.round(ago / 7) + " weeks ago"
      : Math.round(ago / 30) + " months ago";

    const wordCount = base.split(/\s+/).filter(Boolean).length;

    return `
      <article class="card panel-sm freshness-card freshness-card--${st(tone)}">
        <div class="panel-head">
          <h2>Resume freshness</h2>
          <span class="chip ${st(tone)}">${st(label)}</span>
        </div>
        <div class="freshness-stat">
          <span class="freshness-age">${st(agoLabel)}</span>
          <span class="freshness-sub">last updated</span>
        </div>
        <p class="freshness-hint">${st(hint)}</p>
        <div class="freshness-meta">
          <span><i class="fa-solid fa-align-left"></i> ${wordCount.toLocaleString()} words</span>
          ${resumeData.tailored ? '<span><i class="fa-solid fa-wand-magic-sparkles"></i> Tailored cached</span>' : ''}
        </div>
        <a class="btn-secondary freshness-cta" href="#/resume">
          <i class="fa-solid fa-pen-to-square"></i> Update resume
        </a>
      </article>
    `;
  }

  // ---------------------------------------------------------------------------
  // Upcoming Week — compact list of next 7 days' events
  // ---------------------------------------------------------------------------
  function renderUpcomingWeek(events) {
    const st = getSt();
    const now = new Date();
    const todayISO = localDayKey(now);
    const weekEnd = localDayKey(new Date(now.getTime() + 7 * DAY_MS));

    const upcoming = events
      .filter(function (e) { return e && e.date >= todayISO && e.date <= weekEnd; })
      .slice()
      .sort(function (a, b) { return a.date.localeCompare(b.date); });

    if (!upcoming.length) {
      return `
        <article class="card panel-sm upcoming-card">
          <div class="panel-head">
            <h2>Upcoming week</h2>
            <span class="chip cyan">Next 7 days</span>
          </div>
          <p class="upcoming-empty">Your schedule is clear. Add an interview or deadline to see it here.</p>
          <a class="btn-secondary freshness-cta" href="#/calendar"><i class="fa-solid fa-calendar-plus"></i> Open calendar</a>
        </article>
      `;
    }

    const iconFor = function (type) {
      if (type === "interview") return { icon: "fa-comments", tone: "blue" };
      if (type === "deadline")  return { icon: "fa-flag-checkered", tone: "warning" };
      if (type === "followup")  return { icon: "fa-envelope-circle-check", tone: "violet" };
      return { icon: "fa-calendar-day", tone: "cyan" };
    };

    const rows = upcoming.slice(0, 5).map(function (e) {
      const meta = iconFor(e.type);
      const when = humanTimeUntil(e.date);
      const dateLabel = new Date(e.date).toLocaleDateString(undefined, {
        weekday: "short", month: "short", day: "numeric"
      });
      return `
        <li class="upcoming-item">
          <span class="upcoming-icon ${st(meta.tone)}"><i class="fa-solid ${st(meta.icon)}" aria-hidden="true"></i></span>
          <div class="upcoming-body">
            <strong class="upcoming-title">${st(e.title || "Untitled")}</strong>
            <span class="upcoming-meta">${st(dateLabel)} · ${st(when)}</span>
          </div>
        </li>
      `;
    }).join("");

    const overflow = upcoming.length > 5
      ? '<p class="upcoming-overflow">+' + (upcoming.length - 5) + ' more this week</p>'
      : '';

    return `
      <article class="card panel-sm upcoming-card">
        <div class="panel-head">
          <h2>Upcoming week</h2>
          <span class="chip blue">${upcoming.length} scheduled</span>
        </div>
        <ul class="upcoming-list">${rows}</ul>
        ${overflow}
        <a class="btn-ghost freshness-cta" href="#/calendar">Open calendar <i class="fa-solid fa-arrow-right"></i></a>
      </article>
    `;
  }

  // ---------------------------------------------------------------------------
  // Pipeline funnel — simple horizontal visualization
  // ---------------------------------------------------------------------------
  function renderPipelineSnapshot(metrics) {
    const c = metrics.stageCounts;
    const stages = [
      { key: "saved", label: "Saved", tone: "cyan", value: c.saved },
      { key: "applied", label: "Applied", tone: "violet", value: c.applied },
      { key: "interview", label: "Interview", tone: "blue", value: c.interview },
      { key: "offer", label: "Offer", tone: "green", value: c.offer }
    ];
    const max = Math.max(1, c.saved, c.applied, c.interview, c.offer);
    const st = getSt();
    const rows = stages.map(function (s) {
      const pct = Math.max(6, Math.round((s.value / max) * 100));
      return (
        '<div class="funnel-row">' +
          '<div class="funnel-label"><span class="status-dot ' + s.tone + '"></span> ' + st(s.label) + '</div>' +
          '<div class="funnel-track"><span class="funnel-fill ' + s.tone + '" style="width:' + pct + '%"></span></div>' +
          '<div class="funnel-value">' + s.value + '</div>' +
        '</div>'
      );
    }).join("");

    const rejected = c.rejected + c.withdrawn;
    const caveat = rejected
      ? '<p class="ai-meta funnel-caveat">' + rejected + ' closed (rejected or withdrawn) — excluded from the funnel.</p>'
      : '';

    return `
      <article class="card panel-lg funnel-card">
        <div class="panel-head">
          <h2>Pipeline funnel</h2>
          <span class="chip blue">Live</span>
        </div>
        <div class="funnel-grid">${rows}</div>
        ${caveat}
        <div class="form-actions">
          <a class="btn-ghost" href="#/applications">Open pipeline <i class="fa-solid fa-arrow-right"></i></a>
        </div>
      </article>
    `;
  }

  function renderCandidateIntelligencePanel() {
    const api = window.CBV2.candidateIntel;
    if (!api || typeof api.build !== "function") return "";
    if (window.CBV2.ui && typeof window.CBV2.ui.candidateIntelligenceCard === "function") {
      return window.CBV2.ui.candidateIntelligenceCard({
        title: "Candidate intelligence",
        badge: "Phase 2 brain",
        description: "CareerBoost is now building one reusable profile from your resume, target roles, saved evidence, and pipeline outcomes.",
        actionClass: "candidate-intel-actions"
      });
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------
  function renderDashboardView(state) {
    const apps = window.CBV2.store.getApplications();
    const events = window.CBV2.store.getEvents();
    const savedSearches = window.CBV2.store.getSavedSearches();
    const savedJobs = window.CBV2.store.getSavedJobs();
    const jobSearchState = window.CBV2.store.getJobSearchState() || {};
    const profilePrefs = getProfileJobPreferences();
    const effectiveRoleProfile = Object.assign(
      {},
      (jobSearchState.roleProfile || {}),
      (profilePrefs && profilePrefs.roleProfile) || {}
    );
    const metrics = computeMetrics(apps);
    const derived = deriveState(apps, events, savedSearches, state.digest, savedJobs, effectiveRoleProfile);

    // Cold-start: TRULY empty — no apps, no events, no resume / saved
    // jobs / cover letters / interview history. The previous gate only
    // checked apps + events, so a returning user who'd built a resume
    // or saved jobs but hadn't applied yet got hit with the marketing
    // storyboard meant for first-time visitors. Day 4.6 fix.
    if (!apps.length && !events.length && !hasOtherActivity()) {
      return `
        <section class="page-container">
          ${renderHero(apps, metrics, derived)}
          ${renderProfileNudge(effectiveRoleProfile)}
          ${renderCandidateIntelligencePanel()}
          ${renderColdStart()}
        </section>
      `;
    }

    return `
      <section class="page-container">
        ${renderHero(apps, metrics, derived)}
        ${renderProfileNudge(effectiveRoleProfile)}
        ${renderKpiStrip(apps, metrics)}
        <section class="dashboard-layout">
          ${renderCandidateIntelligencePanel()}
          ${renderNextBestActions(apps, events, derived)}
          ${renderUpcomingWeek(events)}
          ${renderPipelineSnapshot(metrics)}
          ${renderResumeFreshness()}
          ${renderDigestPanel(state)}
        </section>
      </section>
    `;
  }

  window.CBV2.routes.dashboard = function () {
    return renderDashboardView(window.CBV2.getState());
  };

  // ---------------------------------------------------------------------------
  // Digest scan (unchanged)
  // ---------------------------------------------------------------------------
  async function scanDigest(force) {
    const state = window.CBV2.getState();
    state.digest = state.digest || { busy: false, results: [], generatedAt: 0 };
    const searches = window.CBV2.store.getSavedSearches();
    if (!searches.length) return;

    // CRITICAL FIX: re-entry guard. scanDigest is called from
    // afterRender.dashboard, and scanDigest itself triggers
    // renderCurrentRoute() (to show the "scanning..." busy state). That
    // re-render fires afterRender.dashboard again, which calls
    // scanDigest again — infinite loop, stack overflow, browser hang,
    // floods Adzuna API until ERR_INSUFFICIENT_RESOURCES.
    //
    // Previously masked by the router's old 180ms setTimeout that made
    // each cycle async, but that mask was removed in commit a930d4a.
    // Now we guard explicitly: if a scan is in progress, exit early.
    if (state.digest.busy) return;

    const freshMs = 30 * 60 * 1000;
    if (!force && state.digest.generatedAt && Date.now() - state.digest.generatedAt < freshMs && state.digest.results.length) {
      return;
    }

    state.digest.busy = true;
    // Also dropped the renderCurrentRoute() that USED to be here. It
    // was the "show scanning state" repaint, but it's what kicked off
    // the recursion in the first place. The final renderCurrentRoute()
    // call below (after the loop) paints the completed state. Users
    // miss a momentary "scanning..." flash but gain a working app.

    const results = [];
    for (let i = 0; i < searches.length; i += 1) {
      const s = searches[i];
      try {
        const out = await window.CBJobs.search({
          query: (s.filters && s.filters.query) || "",
          remoteOnly: s.filters && s.filters.remoteOnly,
          postedWithinDays: s.filters && s.filters.postedWithinDays,
          sort: (s.filters && s.filters.sort) || "newest",
          roleProfile: (s.filters && s.filters.roleProfile) || null
        });
        const topIds = out.jobs.slice(0, 20).map(function (j) { return j.id; });
        const prevIds = Array.isArray(s.lastTopIds) ? s.lastTopIds : [];
        const prevSet = new Set(prevIds);
        const newCount = prevIds.length ? topIds.filter(function (id) { return !prevSet.has(id); }).length : 0;
        window.CBV2.store.markSavedSearchRun(s.id, {
          lastCount: out.total,
          lastTopIds: topIds,
          lastNewCount: newCount
        });
        results.push({
          id: s.id,
          name: s.name,
          total: out.total,
          newCount: newCount
        });
      } catch (err) {
        results.push({
          id: s.id,
          name: s.name,
          total: 0,
          newCount: 0,
          error: err && err.message ? err.message : "Scan failed"
        });
      }
    }

    state.digest = {
      busy: false,
      results: results,
      generatedAt: Date.now()
    };
    window.CBV2.renderCurrentRoute();
  }

  // Easing for the counter tween. Quick at first, gentle at the end — reads
  // "confident" instead of "bouncy" (which would look cheap at this scale).
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // Animates any element with `data-counter="N"` from 0 to N over ~700ms.
  // Respects prefers-reduced-motion.
  function animateCounters(root) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const els = (root || document).querySelectorAll("[data-counter]");
    els.forEach(function (el) {
      const target = parseFloat(el.getAttribute("data-counter")) || 0;
      const suffix = el.getAttribute("data-counter-suffix") || "";
      if (reduce || target === 0) {
        el.textContent = target + suffix;
        return;
      }
      const start = performance.now();
      const dur = 720;
      function step(now) {
        const t = Math.min(1, (now - start) / dur);
        const v = Math.round(easeOutCubic(t) * target);
        el.textContent = v + suffix;
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  // Staggers the appearance of the dashboard sections. Adds a class which
  // the CSS uses to animate opacity + translateY with a per-index delay.
  function staggerIn(root) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const cards = (root || document).querySelectorAll(".page-container > *");
    cards.forEach(function (el, i) {
      el.style.setProperty("--stagger-delay", (i * 55) + "ms");
      el.classList.add("stagger-in");
    });
  }

  window.CBV2.afterRender.dashboard = function () {
    const refresh = document.getElementById("refresh-digest");
    if (refresh) {
      refresh.addEventListener("click", function () { scanDigest(true); });
    }

    const dismissNudge = document.querySelector("[data-dismiss-nudge]");
    if (dismissNudge) {
      dismissNudge.addEventListener("click", function () {
        try { localStorage.setItem("cb_profile_nudge_dismissed", String(Date.now())); } catch (e) {}
        const nudge = dismissNudge.closest(".ai-notice");
        if (nudge) nudge.remove();
      });
    }

    // Next-best-action CTAs bound to a specific app → open the drawer
    // instead of navigating. Preserves context from the dashboard.
    document.querySelectorAll("[data-open-app]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-open-app");
        if (id && window.CBV2.drawer) window.CBV2.drawer.openApplication(id);
      });
    });

    animateCounters(document);
    staggerIn(document);

    scanDigest(false);
  };
})();
