// Phase D: shared helpers + state caches for the admin console.
//
// Loaded BEFORE every sections/*.js script and BEFORE admin.route.js so that
// section renderers can read formatting helpers, palette tones, and the
// remote-state caches without each section duplicating that boilerplate.
//
// The state caches live here (not in admin.route.js) so that sections can
// observe them directly. admin.route.js owns the fetchers/mutators that
// write to these caches; sections are read-only consumers.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  // -- State caches ---------------------------------------------------------
  const ADMIN_METRICS_TTL_MS = 60 * 1000;

  const adminRemote = {
    status: "idle",
    data: null,
    error: "",
    loadedAt: 0,
    inFlight: false
  };

  // Phase B: paginated cache for the Users + User Support sections.
  const adminUsersRemote = {
    status: "idle",
    data: null,
    error: "",
    loadedAt: 0,
    inFlight: false,
    page: 1,
    perPage: 50,
    sort: "health",
    filter: "",
    // A2: free-text cross-user search. Matches email + profile.full_name
    // + applications.company server-side. Composes with `filter`.
    query: ""
  };

  // Phase C: cache for the operator management panel.
  const adminOperatorsRemote = {
    status: "idle",
    data: null,
    error: "",
    loadedAt: 0,
    inFlight: false,
    mutationError: "",
    mutationBusy: false
  };

  // Phase C.2: incident lifecycle mutation state.
  const adminIncidentsRemote = {
    mutationBusy: false,
    mutationError: "",
    actingOnId: ""
  };

  // Phase C.2: paginated audit log viewer cache.
  const adminAuditRemote = {
    status: "idle",
    data: null,
    error: "",
    loadedAt: 0,
    inFlight: false,
    page: 1,
    perPage: 50,
    actionFilter: "",
    targetEmailFilter: ""
  };

  // Phase E3: per-user timeline state. activeUserId is the user whose
  // expanded drawer is open in the Users board; the fetcher writes the
  // result here, the section reads it on render.
  const adminUserTimelineRemote = {
    status: "idle",        // idle | loading | ready | error
    error: "",
    activeUserId: "",
    activeUserEmail: "",
    data: null,            // raw timeline JSON from the RPC
    loadedAt: 0,
    inFlight: false,
    // Active segment chip ("power" | "new" | "at_risk" | "churned" |
    // "active" | "") — section.js writes this when the operator clicks
    // a segment card to filter the table.
    activeSegment: ""
  };

  // -- Sanitization ---------------------------------------------------------
  function st(value) {
    const sanitize = window.CBV2.sanitizeText || function (x) { return String(x == null ? "" : x); };
    return sanitize(value);
  }

  // -- Numeric helpers ------------------------------------------------------
  function numberOr(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function money(value) {
    const num = Number(value || 0);
    return "$" + num.toFixed(num >= 10 ? 2 : 4);
  }

  function percent(n, d) {
    if (!d) return "0%";
    return Math.round((n / d) * 100) + "%";
  }

  function clampPct(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function compactNumber(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0";
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "m";
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(num);
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function daysBetween(dateValue) {
    if (!dateValue) return 999;
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return 999;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
  }

  function formatDateTime(value) {
    if (!value) return "Never";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "Unknown";
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (err) {
      return "Unknown";
    }
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds || 0)));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rem = minutes % 60;
      return hours + "h " + rem + "m";
    }
    if (minutes > 0) return minutes + "m " + secs + "s";
    return secs + "s";
  }

  function hostLabel(value) {
    const raw = String(value || "").replace(/^www\./, "");
    return raw || "No host";
  }

  // -- Palette / tones ------------------------------------------------------
  function alertTone(severity) {
    const sev = String(severity || "info").toLowerCase();
    if (sev === "critical") return "critical";
    if (sev === "warning") return "warning";
    return "info";
  }

  function alertIcon(severity) {
    const tone = alertTone(severity);
    if (tone === "critical") return "fa-triangle-exclamation";
    if (tone === "warning") return "fa-circle-exclamation";
    return "fa-circle-info";
  }

  function progressTone(value) {
    const num = Number(value || 0);
    if (num >= 70) return "green";
    if (num >= 45) return "amber";
    return "red";
  }

  function moduleStatusTone(status) {
    const value = String(status || "").toLowerCase();
    if (value.indexOf("healthy") >= 0) return "green";
    if (value.indexOf("telemetry") >= 0) return "blue";
    if (value.indexOf("attention") >= 0) return "red";
    return "amber";
  }

  function serviceTone(status) {
    const s = String(status || "").toLowerCase();
    if (s === "healthy" || s === "ready") return "green";
    if (s === "incident" || s === "blocked" || s === "critical") return "red";
    return "amber";
  }

  function supportTone(health) {
    const score = Number(health || 0);
    if (score >= 75) return "green";
    if (score >= 55) return "amber";
    return "red";
  }

  // -- Shared renderers -----------------------------------------------------
  function renderStat(label, value, detail, tone) {
    return (
      '<article class="admin-stat admin-stat--' + st(tone || "cyan") + '">' +
        '<span>' + st(label) + '</span>' +
        '<strong class="num-font">' + st(value) + '</strong>' +
        '<small>' + st(detail || "") + '</small>' +
      '</article>'
    );
  }

  function renderAlerts(data) {
    const alerts = safeArray(data.alerts).slice(0, 4);
    if (!alerts.length) {
      return (
        '<section class="admin-alert-grid">' +
          '<article class="admin-alert admin-alert--info">' +
            '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>' +
            '<div><strong>No admin alerts yet</strong><span>Connect the backend function to populate source, AI, and user-health checks.</span></div>' +
          '</article>' +
        '</section>'
      );
    }
    return (
      '<section class="admin-alert-grid">' +
        alerts.map(function (alert) {
          const tone = alertTone(alert.severity);
          return (
            '<a class="admin-alert admin-alert--' + tone + '" href="#/admin?section=' + st(alert.section || "overview") + '">' +
              '<i class="fa-solid ' + alertIcon(alert.severity) + '" aria-hidden="true"></i>' +
              '<div><strong>' + st(alert.title || "Admin alert") + '</strong><span>' + st(alert.body || "") + '</span><small>' + st(alert.action || "") + '</small></div>' +
            '</a>'
          );
        }).join("") +
      '</section>'
    );
  }

  function renderProgressRows(rows) {
    const items = safeArray(rows);
    if (!items.length) {
      return '<p class="admin-copy">No product intelligence rows are available yet.</p>';
    }
    return (
      '<div class="admin-progress-list">' +
        items.map(function (row) {
          const value = Math.max(0, Math.min(100, Number(row.value != null ? row.value : row.adoption || 0)));
          return (
            '<div class="admin-progress-row">' +
              '<div><strong>' + st(row.label || row.title || "Metric") + '</strong><span>' + st(row.detail || row.status || row.action || "") + '</span></div>' +
              '<span class="chip ' + st(progressTone(value)) + '">' + st(value) + '%</span>' +
              '<i style="--progress:' + value + '%"></i>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderInsightList(insights) {
    const rows = safeArray(insights);
    if (!rows.length) {
      return '<p class="admin-copy">No product recommendations are currently flagged.</p>';
    }
    return (
      '<div class="admin-action-list">' +
        rows.map(function (item) {
          const tone = alertTone(item.severity);
          return (
            '<a class="admin-action-card admin-action-card--' + st(tone) + '" href="#/admin?section=' + st(item.section || "overview") + '">' +
              '<i class="fa-solid ' + alertIcon(item.severity) + '"></i>' +
              '<div><strong>' + st(item.title || "Product insight") + '</strong><span>' + st(item.body || "") + '</span></div>' +
            '</a>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderCohortBars(cohorts) {
    const rows = safeArray(cohorts);
    if (!rows.length) return '<p class="admin-copy">Cohort data will appear after the admin backend collects user activity.</p>';
    const max = Math.max.apply(Math, rows.map(function (row) { return Math.max(Number(row.signups || 0), Number(row.active || 0), Number(row.jobSaves || 0), Number(row.aiCalls || 0)); }).concat([1]));
    return (
      '<div class="admin-cohort-grid">' +
        rows.map(function (row) {
          const active = Math.max(8, Math.round((Number(row.active || 0) / max) * 100));
          const jobs = Math.max(8, Math.round((Number(row.jobSaves || 0) / max) * 100));
          const ai = Math.max(8, Math.round((Number(row.aiCalls || 0) / max) * 100));
          return (
            '<div class="admin-cohort-card">' +
              '<strong>' + st(row.week) + '</strong>' +
              '<div><span style="--bar:' + active + '%"></span><small>Active ' + st(row.active || 0) + '</small></div>' +
              '<div><span style="--bar:' + jobs + '%"></span><small>Jobs ' + st(row.jobSaves || 0) + '</small></div>' +
              '<div><span style="--bar:' + ai + '%"></span><small>AI ' + st(row.aiCalls || 0) + '</small></div>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderActivity(data) {
    const items = [];
    safeArray(data.remoteActivity).forEach(function (item) {
      items.push({
        icon: item.type === "ai-failed" ? "fa-triangle-exclamation" : (item.type === "ai" ? "fa-wand-magic-sparkles" : "fa-briefcase"),
        title: item.title || "Admin activity",
        body: item.body || "",
        time: item.at || ""
      });
    });
    safeArray(data.apps).slice(0, 4).forEach(function (app) {
      items.push({
        icon: "fa-briefcase",
        title: "Pipeline updated",
        body: (app.company || "Company") + " - " + (app.role || "Role"),
        time: app.appliedAt || ""
      });
    });
    safeArray(data.searchRuns).slice(0, 3).forEach(function (run) {
      items.push({
        icon: "fa-magnifying-glass",
        title: "Job search run",
        body: (run.query || "Search") + " returned " + (run.total || 0) + " roles",
        time: run.at || ""
      });
    });
    if (!items.length) {
      items.push({ icon: "fa-circle-info", title: "No live activity yet", body: "Admin telemetry will populate as users search, save jobs, and run AI actions.", time: "" });
    }
    return items.slice(0, 6).map(function (item) {
      return (
        '<li class="admin-activity-item">' +
          '<i class="fa-solid ' + item.icon + '" aria-hidden="true"></i>' +
          '<div><strong>' + st(item.title) + '</strong><span>' + st(item.body) + '</span></div>' +
          '<time>' + st(formatDateTime(item.time)) + '</time>' +
        '</li>'
      );
    }).join("");
  }

  function renderSparkBars(values) {
    const nums = safeArray(values);
    const max = Math.max.apply(Math, nums.concat([1]));
    return nums.map(function (value, index) {
      const height = Math.max(10, Math.round((Number(value || 0) / max) * 100));
      return '<span style="--bar:' + height + '%" title="Day ' + (index + 1) + ': ' + st(value) + '"></span>';
    }).join("");
  }

  function searchTrend(data) {
    const runs = safeArray(data.searchRuns).slice(0, 12).reverse();
    if (!runs.length) return [4, 8, 5, 11, 9, 14, 13, 16, 12, 18, 15, 20];
    return runs.map(function (run) { return Number(run.total || 0); });
  }

  function renderProviderRows(data) {
    if (data.jobFeedStats && Array.isArray(data.jobFeedStats.sources) && data.jobFeedStats.sources.length) {
      return data.jobFeedStats.sources.slice(0, 8).map(function (row) {
        return (
          '<div class="admin-health-row">' +
            '<span class="admin-dot admin-dot--green"></span>' +
            '<div><strong>' + st(row.label) + '</strong><small>' + st(row.host || "Verified provider source") + '</small></div>' +
            '<span class="chip green">' + st(row.count) + ' jobs</span>' +
          '</div>'
        );
      }).join("");
    }
    const js = data.jobSearch || {};
    const last = js.lastResultSet || null;
    const sources = last && last.sources && typeof last.sources === "object" ? last.sources : {};
    const rows = [
      { label: "LinkedIn extension", status: "Watch", detail: "Extension imports and token health", tone: "blue" },
      { label: "Adzuna", status: sources.adzuna != null ? "Reporting" : "Ready", detail: "Cloud job search provider", tone: "green" },
      { label: "External boards", status: sources.external != null ? "Reporting" : "Ready", detail: "Verified source provenance", tone: "cyan" },
      { label: "Realtime sync", status: window.CBV2.store && window.CBV2.store.isRemote ? "Remote" : "Local", detail: "Pipeline refresh channel", tone: "violet" }
    ];
    return rows.map(function (row) {
      return (
        '<div class="admin-health-row">' +
          '<span class="admin-dot admin-dot--' + st(row.tone) + '"></span>' +
          '<div><strong>' + st(row.label) + '</strong><small>' + st(row.detail) + '</small></div>' +
          '<span class="chip ' + st(row.tone) + '">' + st(row.status) + '</span>' +
        '</div>'
      );
    }).join("");
  }

  function renderCountBars(rows, emptyLabel) {
    const items = safeArray(rows).filter(function (row) { return Number(row.count || 0) > 0; }).slice(0, 6);
    if (!items.length) return '<p class="admin-copy">' + st(emptyLabel || "No distribution data is available yet.") + '</p>';
    const max = Math.max.apply(Math, items.map(function (row) { return Number(row.count || 0); }).concat([1]));
    const total = items.reduce(function (sum, row) { return sum + Number(row.count || 0); }, 0);
    return (
      '<div class="admin-count-bars">' +
        items.map(function (row) {
          const width = Math.max(4, Math.round((Number(row.count || 0) / max) * 100));
          const share = total ? Math.round((Number(row.count || 0) / total) * 100) : 0;
          return (
            '<div class="admin-count-bar">' +
              '<div><strong>' + st(row.label || "Unknown") + '</strong><span>' + st(row.count || 0) + ' / ' + st(share) + '%</span></div>' +
              '<i style="--bar:' + width + '%"></i>' +
            '</div>'
          );
        }).join("") +
      '</div>'
    );
  }

  function renderCountTable(rows, emptyLabel) {
    const items = safeArray(rows);
    if (!items.length) return '<p class="admin-copy">' + st(emptyLabel || "No session rows are available yet.") + '</p>';
    const total = items.reduce(function (sum, row) { return sum + Number(row.count || 0); }, 0);
    return (
      '<div class="admin-table">' +
        '<div class="admin-table-row admin-table-row--three admin-table-head"><span>Signal</span><span>Count</span><span>Share</span></div>' +
        items.map(function (row) {
          return '<div class="admin-table-row admin-table-row--three"><span>' + st(row.label || "Unknown") + '</span><span>' + st(row.count || 0) + '</span><span>' + st(total ? Math.round((Number(row.count || 0) / total) * 100) + "%" : "-") + '</span></div>';
        }).join("") +
      '</div>'
    );
  }

  // -- Public namespace -----------------------------------------------------
  window.CBV2.adminHelpers = {
    // constants
    ADMIN_METRICS_TTL_MS: ADMIN_METRICS_TTL_MS,
    // state caches (live mutable references)
    adminRemote: adminRemote,
    adminUsersRemote: adminUsersRemote,
    adminOperatorsRemote: adminOperatorsRemote,
    adminIncidentsRemote: adminIncidentsRemote,
    adminAuditRemote: adminAuditRemote,
    adminUserTimelineRemote: adminUserTimelineRemote,
    // sanitization + numeric
    st: st,
    numberOr: numberOr,
    money: money,
    percent: percent,
    clampPct: clampPct,
    compactNumber: compactNumber,
    safeArray: safeArray,
    daysBetween: daysBetween,
    formatDateTime: formatDateTime,
    formatDuration: formatDuration,
    hostLabel: hostLabel,
    // tones
    alertTone: alertTone,
    alertIcon: alertIcon,
    progressTone: progressTone,
    moduleStatusTone: moduleStatusTone,
    serviceTone: serviceTone,
    supportTone: supportTone,
    // renderers
    renderStat: renderStat,
    renderAlerts: renderAlerts,
    renderProgressRows: renderProgressRows,
    renderInsightList: renderInsightList,
    renderCohortBars: renderCohortBars,
    renderActivity: renderActivity,
    renderSparkBars: renderSparkBars,
    renderProviderRows: renderProviderRows,
    renderCountBars: renderCountBars,
    renderCountTable: renderCountTable,
    searchTrend: searchTrend
  };
})();
