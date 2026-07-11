// Job Scout Agent — Phase 1 client (dashboard panel + wizard + inbox).
//
// Talks ONLY to the job-scout edge function (action-routed: get / save / scan /
// update-finding). No client-side table access — matches the codebase pattern.
// The dashboard route calls window.CBV2.jobScout.renderPanel() inside its view
// and .bind() from afterRender. bind() loads state once per session (guarded so
// the load→render→afterRender cycle can't loop, same hazard as scanDigest).
//
// After a scan delivers NEW findings, we reuse the existing resume-fit machinery
// (CBJobs.scoreJobs) client-side and PATCH the fit back via update-finding —
// Phase 2 (cron) will move scoring server-side.
(function () {
  window.CBV2 = window.CBV2 || {};

  const state = {
    loadedOnce: false,
    loading: false,
    error: "",
    agent: null,
    findings: [],
    stats: { newCount: 0 },
    scanBusy: false,
    saveBusy: false
  };

  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toast(kind, msg) {
    const t = window.CBV2.toast;
    if (t && typeof t[kind] === "function") t[kind](msg);
  }

  function backendReady() {
    const cfg = window.CBV2.config;
    const auth = window.CBV2.auth;
    return Boolean(
      cfg && typeof cfg.isBackendEnabled === "function" && cfg.isBackendEnabled() &&
      auth && typeof auth.isAuthenticated === "function" && auth.isAuthenticated()
    );
  }

  async function api(action, body) {
    const cfg = window.CBV2.config;
    const auth = window.CBV2.auth;
    const token = await auth.getAccessToken();
    if (!token) throw new Error("Sign in to use the Job Agent.");
    const res = await fetch(cfg.getFunctionsUrl() + "/job-scout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": cfg.getSupabaseAnon()
      },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.error) || ("job-scout " + res.status));
    }
    return data;
  }

  function repaintDashboard() {
    const st = window.CBV2.getState && window.CBV2.getState();
    if (st && st.route === "dashboard" && window.CBV2.renderCurrentRoute) {
      window.CBV2.renderCurrentRoute();
    }
  }

  async function load() {
    state.loading = true;
    try {
      const out = await api("get");
      state.agent = out.agent || null;
      state.findings = Array.isArray(out.findings) ? out.findings : [];
      state.stats = out.stats || { newCount: 0 };
      state.error = "";
      // Cron scans (Phase 2) deliver findings while the user is away, without a
      // browser to fit-score them — score any unscored NEW findings on arrival.
      const unscored = state.findings.filter(function (f) {
        return f.status === "new" && (f.fitScore === null || f.fitScore === undefined);
      });
      if (unscored.length) scoreNewFindings(unscored.slice(0, 12));
    } catch (e) {
      state.error = (e && e.message) || "Could not load your Job Agent.";
    } finally {
      state.loading = false;
    }
  }

  function timeAgo(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.floor(hrs / 24) + "d ago";
  }

  function fitChip(score) {
    if (typeof score !== "number") return "";
    const cls = score >= 72 ? "green" : score >= 50 ? "cyan" : "violet";
    return '<span class="chip ' + cls + '" title="AI match vs your resume"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + esc(String(score)) + "</span>";
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function runScan() {
    if (state.scanBusy) return;
    state.scanBusy = true;
    repaintDashboard();
    try {
      const out = await api("scan");
      const fresh = Array.isArray(out.findings) ? out.findings : [];
      // Prepend new findings, dedupe by id.
      const known = {};
      state.findings.forEach(function (f) { known[f.id] = true; });
      const merged = fresh.filter(function (f) { return !known[f.id]; }).concat(state.findings);
      state.findings = merged;
      state.stats.newCount = merged.filter(function (f) { return f.status === "new"; }).length;
      if (state.agent) state.agent.lastRunStats = out.stats || state.agent.lastRunStats;
      if (state.agent) state.agent.lastRunAt = new Date().toISOString();
      state.error = "";
      if (out.newCount > 0) {
        toast("success", "Your agent found " + out.newCount + " new role" + (out.newCount === 1 ? "" : "s") + ".");
      } else {
        toast("info", "Scan complete — nothing new since the last run.");
      }
      state.scanBusy = false;
      repaintDashboard();
      if (fresh.length) scoreNewFindings(fresh);
    } catch (e) {
      state.scanBusy = false;
      state.error = (e && e.message) || "Scan failed.";
      toast("error", state.error);
      repaintDashboard();
    }
  }

  // Resume-fit scoring for freshly delivered findings — reuses the existing
  // job-match machinery, then persists fit via update-finding. Fire-and-forget;
  // rows repaint when the batch settles.
  function scoreNewFindings(fresh) {
    const jobsApi = window.CBJobs;
    if (!jobsApi || typeof jobsApi.scoreJobs !== "function") return;
    if (typeof jobsApi.hasResume === "function" && !jobsApi.hasResume()) return;
    const jobs = fresh.map(function (f) {
      return Object.assign({ id: f.id }, f.job || {});
    }).filter(function (j) { return j.id && j.title; });
    if (!jobs.length) return;

    jobsApi.scoreJobs(jobs, {
      topN: Math.min(12, jobs.length),
      onProgress: function (r) {
        if (!r || !r.jobId || r.error) return;
        const row = state.findings.find(function (f) { return f.id === r.jobId; });
        if (row) {
          row.fitScore = typeof r.score === "number" ? r.score : row.fitScore;
          row.fitSummary = r.fitSummary || row.fitSummary;
        }
        api("update-finding", {
          findingId: r.jobId,
          fit: { score: r.score, summary: r.fitSummary, reasons: r.reasons }
        }).catch(function () { /* fit is best-effort */ });
      }
    }).then(function () {
      repaintDashboard();
    }).catch(function () { /* scoring is best-effort */ });
  }

  async function saveFindingToPipeline(id) {
    const row = state.findings.find(function (f) { return f.id === id; });
    if (!row) return;
    try {
      await api("update-finding", { findingId: id, status: "saved" });
      row.status = "saved";
      const store = window.CBV2.store;
      if (store && typeof store.bookmarkJob === "function" && row.job) {
        store.bookmarkJob(Object.assign({ id: "scout_" + id, sourceType: "api" }, row.job));
      }
      toast("success", "Saved — find it under Saved jobs.");
      repaintDashboard();
    } catch (e) {
      toast("error", (e && e.message) || "Could not save.");
    }
  }

  async function dismissFinding(id) {
    const row = state.findings.find(function (f) { return f.id === id; });
    if (!row) return;
    try {
      await api("update-finding", { findingId: id, status: "dismissed" });
      state.findings = state.findings.filter(function (f) { return f.id !== id; });
      state.stats.newCount = state.findings.filter(function (f) { return f.status === "new"; }).length;
      repaintDashboard();
    } catch (e) {
      toast("error", (e && e.message) || "Could not dismiss.");
    }
  }

  // ---------------------------------------------------------------------------
  // Wizard (setup / edit modal)
  // ---------------------------------------------------------------------------

  function wizardPrefill() {
    if (state.agent) {
      return {
        name: state.agent.name,
        titles: (state.agent.targetTitles || []).join(", "),
        skills: (state.agent.mustHaveSkills || []).join(", "),
        excludes: (state.agent.excludeKeywords || []).join(", "),
        location: state.agent.location || "",
        strictness: state.agent.locationStrictness || "balanced",
        workMode: state.agent.workMode || "any",
        cadence: state.agent.cadence || "daily"
      };
    }
    const store = window.CBV2.store;
    const js = store && typeof store.getJobSearchState === "function" ? (store.getJobSearchState() || {}) : {};
    const rp = js.roleProfile || {};
    return {
      name: "My Job Agent",
      titles: (Array.isArray(rp.targetTitles) ? rp.targetTitles : []).join(", "),
      skills: (Array.isArray(rp.mustHaveSkills) ? rp.mustHaveSkills : []).join(", "),
      excludes: (Array.isArray(rp.excludeKeywords) ? rp.excludeKeywords : []).join(", "),
      location: (js.filters && js.filters.location) || js.location || "",
      strictness: "balanced",
      workMode: "any",
      cadence: "daily" // automation on by default — that's the point of an agent
    };
  }

  function fieldRow(label, inner, hint) {
    return (
      '<label class="js-field">' +
        '<span class="js-field-label">' + esc(label) + "</span>" +
        inner +
        (hint ? '<span class="js-field-hint">' + esc(hint) + "</span>" : "") +
      "</label>"
    );
  }

  function openWizard() {
    closeWizard();
    const p = wizardPrefill();
    const overlay = document.createElement("div");
    overlay.id = "job-scout-wizard";
    overlay.className = "js-modal-overlay";
    const inputCls = 'class="js-input"';
    overlay.innerHTML =
      '<div class="js-modal" role="dialog" aria-modal="true" aria-label="Job Agent setup">' +
        '<div class="js-modal-head">' +
          '<span class="js-badge"><i class="fa-solid fa-satellite-dish"></i></span>' +
          "<h3>" + (state.agent ? "Edit your Job Agent" : "Set up your Job Agent") + "</h3>" +
          '<button type="button" class="js-modal-close" id="js-agent-cancel-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
        "</div>" +
        '<p class="js-modal-intro">It runs your whole search pipeline and only brings back jobs it has never shown you before.</p>' +
        fieldRow("Agent name", '<input id="js-agent-name" type="text" maxlength="60" value="' + esc(p.name) + '" ' + inputCls + " />") +
        fieldRow("Target job titles (comma-separated)", '<input id="js-agent-titles" type="text" placeholder="e.g. Fire Engineer, Fire Protection Engineer" value="' + esc(p.titles) + '" ' + inputCls + " />", "Required — the first title drives the search query.") +
        fieldRow("Must-have skills (optional)", '<input id="js-agent-skills" type="text" placeholder="e.g. AutoCAD, sprinkler design" value="' + esc(p.skills) + '" ' + inputCls + " />") +
        fieldRow("Exclude keywords (optional)", '<input id="js-agent-excludes" type="text" placeholder="e.g. sales, internship" value="' + esc(p.excludes) + '" ' + inputCls + " />", "Jobs mentioning these are never delivered.") +
        fieldRow("Location", '<input id="js-agent-location" type="text" placeholder="e.g. Cape Town" value="' + esc(p.location) + '" ' + inputCls + " />") +
        '<div class="js-field-row">' +
          fieldRow("Location match",
            '<select id="js-agent-strictness" ' + inputCls + ">" +
              '<option value="strict"' + (p.strictness === "strict" ? " selected" : "") + ">Strict — this place only</option>" +
              '<option value="balanced"' + (p.strictness === "balanced" ? " selected" : "") + ">Balanced — includes remote</option>" +
              '<option value="broad"' + (p.strictness === "broad" ? " selected" : "") + ">Broad</option>" +
            "</select>") +
          fieldRow("Work mode",
            '<select id="js-agent-workmode" ' + inputCls + ">" +
              '<option value="any"' + (p.workMode === "any" ? " selected" : "") + ">Any</option>" +
              '<option value="remote"' + (p.workMode === "remote" ? " selected" : "") + ">Remote only</option>" +
              '<option value="onsite"' + (p.workMode === "onsite" ? " selected" : "") + ">On-site</option>" +
            "</select>") +
          fieldRow("Auto-scan",
            '<select id="js-agent-cadence" ' + inputCls + ">" +
              '<option value="daily"' + (p.cadence === "daily" ? " selected" : "") + ">Daily (automatic)</option>" +
              '<option value="hourly"' + (p.cadence === "hourly" ? " selected" : "") + ">Hourly — Pro</option>" +
              '<option value="manual"' + (p.cadence === "manual" ? " selected" : "") + ">Manual only</option>" +
            "</select>") +
        "</div>" +
        '<p class="js-field-hint" style="margin:-4px 0 14px;"><i class="fa-solid fa-bolt"></i> Your agent runs in the background — new finds are waiting when you return.</p>' +
        '<div class="js-modal-foot">' +
          '<button type="button" class="btn-ghost" id="js-agent-cancel">Cancel</button>' +
          '<button type="button" class="btn-primary" id="js-agent-submit"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + (state.agent ? "Save changes" : "Create agent & scan") + "</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeWizard();
    });
    const cancel = overlay.querySelector("#js-agent-cancel");
    const cancelX = overlay.querySelector("#js-agent-cancel-x");
    if (cancel) cancel.addEventListener("click", closeWizard);
    if (cancelX) cancelX.addEventListener("click", closeWizard);
    const submit = overlay.querySelector("#js-agent-submit");
    if (submit) submit.addEventListener("click", submitWizard);
  }

  function closeWizard() {
    const el = document.getElementById("job-scout-wizard");
    if (el) el.remove();
  }

  function splitCsv(id) {
    const el = document.getElementById(id);
    return String((el && el.value) || "")
      .split(",")
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  async function submitWizard() {
    if (state.saveBusy) return;
    const titles = splitCsv("js-agent-titles");
    if (!titles.length) {
      toast("error", "Add at least one target job title.");
      return;
    }
    const nameEl = document.getElementById("js-agent-name");
    const locEl = document.getElementById("js-agent-location");
    const strictEl = document.getElementById("js-agent-strictness");
    const modeEl = document.getElementById("js-agent-workmode");
    const cadenceEl = document.getElementById("js-agent-cadence");
    const payload = {
      agent: {
        name: (nameEl && nameEl.value) || "My Job Agent",
        targetTitles: titles,
        mustHaveSkills: splitCsv("js-agent-skills"),
        excludeKeywords: splitCsv("js-agent-excludes"),
        location: (locEl && locEl.value) || "",
        locationStrictness: (strictEl && strictEl.value) || "balanced",
        workMode: (modeEl && modeEl.value) || "any",
        cadence: (cadenceEl && cadenceEl.value) || "daily",
        active: true
      }
    };
    state.saveBusy = true;
    const isNew = !state.agent;
    try {
      const out = await api("save", payload);
      state.agent = out.agent;
      state.error = "";
      closeWizard();
      if (out.cadenceClamped) {
        toast("info", "Hourly auto-scan is a Pro feature — your agent is set to daily.");
      }
      toast("success", isNew ? "Agent created — running its first scan…" : "Agent updated.");
      repaintDashboard();
      if (isNew) runScan();
    } catch (e) {
      toast("error", (e && e.message) || "Could not save the agent.");
    } finally {
      state.saveBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Panel rendering
  // ---------------------------------------------------------------------------

  function renderFindingRow(f) {
    const job = f.job || {};
    const metaBits = [];
    if (job.company) metaBits.push('<span><i class="fa-solid fa-building" aria-hidden="true"></i> ' + esc(job.company) + "</span>");
    if (job.location) metaBits.push('<span><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ' + esc(job.location) + "</span>");
    if (job.postedAt) metaBits.push('<span><i class="fa-solid fa-clock" aria-hidden="true"></i> ' + esc(timeAgo(job.postedAt) || job.postedAt) + "</span>");
    const statusChip = f.status === "saved"
      ? '<span class="chip green"><i class="fa-solid fa-check"></i> Saved</span>'
      : f.status === "applied"
        ? '<span class="chip cyan">Applied</span>'
        : "";
    return (
      '<div class="js-finding' + (f.status === "new" ? " is-new" : "") + '">' +
        '<div class="js-finding-top">' +
          '<a class="js-finding-title" href="' + esc(job.url || "#") + '" target="_blank" rel="noopener noreferrer">' + esc(job.title || "Untitled role") + "</a>" +
          (fitChip(f.fitScore) || "") +
        "</div>" +
        (metaBits.length ? '<div class="js-finding-meta">' + metaBits.join("") + "</div>" : "") +
        '<div class="js-finding-chips">' +
          (job.remote ? '<span class="chip blue"><i class="fa-solid fa-house-laptop"></i> Remote</span>' : "") +
          (job.source ? '<span class="chip subtle">' + esc(job.source) + "</span>" : "") +
          statusChip +
        "</div>" +
        '<div class="js-finding-actions">' +
          '<a class="btn-ghost btn-sm" href="' + esc(job.url || "#") + '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>' +
          (f.status !== "saved"
            ? '<button type="button" class="btn-ghost btn-sm" data-scout-save="' + esc(f.id) + '"><i class="fa-solid fa-bookmark"></i> Save</button>'
            : "") +
          '<button type="button" class="btn-ghost btn-sm" data-scout-dismiss="' + esc(f.id) + '"><i class="fa-solid fa-xmark"></i> Dismiss</button>' +
        "</div>" +
      "</div>"
    );
  }

  function shell(inner) {
    return '<article class="card panel-lg job-scout-card" id="job-scout-panel">' + inner + "</article>";
  }

  function simpleHead(title, chip) {
    return (
      '<div class="js-head">' +
        '<span class="js-badge"><i class="fa-solid fa-satellite-dish"></i></span>' +
        '<div class="js-head-titles"><h3>' + esc(title) + "</h3></div>" +
        (chip ? '<div class="js-head-actions">' + chip + "</div>" : "") +
      "</div>"
    );
  }

  function renderPanel() {
    // Local-only / signed-out: a quiet teaser, no API calls.
    if (!backendReady()) {
      return shell(
        simpleHead("Job Agent", '<span class="chip subtle">Cloud</span>') +
        '<p class="js-empty-sub" style="text-align:left;margin-left:0;">Sign in and your personal agent scans every board for brand-new roles that match you — then delivers them right here.</p>'
      );
    }

    if (!state.loadedOnce || (state.loading && !state.agent && !state.findings.length)) {
      return shell(
        simpleHead("Job Agent") +
        '<p class="js-empty-sub" style="text-align:left;margin-left:0;"><i class="fa-solid fa-circle-notch fa-spin"></i> Checking your agent…</p>'
      );
    }

    // Not configured yet → an inviting empty state that sells the feature.
    if (!state.agent) {
      const step = function (num, icon, title, body) {
        return (
          '<div class="js-step">' +
            '<span class="js-step-num">' + num + "</span>" +
            '<span class="js-step-ico"><i class="fa-solid ' + icon + '"></i></span>' +
            "<h4>" + esc(title) + "</h4><p>" + esc(body) + "</p>" +
          "</div>"
        );
      };
      return shell(
        (state.error ? '<div class="js-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(state.error) + "</div>" : "") +
        '<div class="js-empty">' +
          '<span class="js-badge"><i class="fa-solid fa-satellite-dish"></i></span>' +
          '<h3 class="js-empty-title">Put your job hunt on autopilot</h3>' +
          '<p class="js-empty-sub">Configure a personal agent once. It runs your full search pipeline across every board and only ever surfaces roles it has <strong>never shown you before</strong> — scored against your resume.</p>' +
          '<div class="js-steps">' +
            step("01", "fa-sliders", "Configure once", "Titles, location, skills and what to exclude — pre-filled from your profile.") +
            step("02", "fa-satellite-dish", "It scans for you", "Every board + LinkedIn/Indeed, on a schedule, while you get on with life.") +
            step("03", "fa-inbox", "New roles land here", "Only fresh, matched postings — review, save, or apply with AI.") +
          "</div>" +
          '<button type="button" class="btn-primary" id="job-scout-setup"><i class="fa-solid fa-wand-magic-sparkles"></i> Set up your Job Agent</button>' +
        "</div>"
      );
    }

    // Configured agent.
    const a = state.agent;
    const stats = a.lastRunStats || null;
    const autoLabel = a.cadence === "hourly" ? "Auto-scan · hourly"
      : a.cadence === "daily" ? "Auto-scan · daily"
      : "Manual scans only";

    const targetingChips = []
      .concat((a.targetTitles || []).slice(0, 3).map(function (t) {
        return '<span class="chip cyan"><i class="fa-solid fa-crosshairs"></i> ' + esc(t) + "</span>";
      }))
      .concat(a.location ? ['<span class="chip subtle"><i class="fa-solid fa-location-dot"></i> ' + esc(a.location) + "</span>"] : [])
      .concat(a.workMode === "remote" ? ['<span class="chip blue"><i class="fa-solid fa-house-laptop"></i> Remote</span>']
        : a.workMode === "onsite" ? ['<span class="chip subtle">On-site</span>'] : [])
      .concat(['<span class="chip violet"><i class="fa-solid fa-clock-rotate-left"></i> ' + esc(autoLabel) + "</span>"])
      .join("");

    const statPill = function (num, label, accent) {
      return '<div class="js-stat"><span class="js-stat-num' + (accent ? " is-accent" : "") + '">' + esc(String(num)) + '</span><span class="js-stat-label">' + esc(label) + "</span></div>";
    };
    const statsHtml =
      '<div class="js-stats">' +
        statPill(state.stats.newCount || 0, "New", true) +
        statPill(state.findings.length, "In inbox") +
        statPill(a.lastRunAt ? (timeAgo(a.lastRunAt) || "—") : "Never", "Last scan") +
        (stats && typeof stats.fetched === "number" ? statPill(stats.fetched, "Last fetch") : "") +
      "</div>";

    const visible = state.findings.slice(0, 8);
    const more = state.findings.length - visible.length;

    return shell(
      '<div class="js-head">' +
        '<span class="js-badge' + (state.scanBusy ? " is-scanning" : "") + '"><i class="fa-solid fa-satellite-dish"></i></span>' +
        '<div class="js-head-titles"><h3>' + esc(a.name) + '</h3><p class="js-head-sub">' + esc(autoLabel) + "</p></div>" +
        '<div class="js-head-actions">' +
          (state.stats.newCount > 0 ? '<span class="chip green">' + esc(String(state.stats.newCount)) + " new</span>" : "") +
          '<span class="chip ' + (a.active ? "cyan" : "subtle") + '"><span class="status-dot ' + (a.active ? "green" : "") + '" style="margin-right:2px;"></span>' + (a.active ? "Active" : "Paused") + "</span>" +
          '<button type="button" class="btn-ghost btn-sm" id="job-scout-edit"><i class="fa-solid fa-sliders"></i> Edit</button>' +
        "</div>" +
      "</div>" +
      '<div class="js-targeting">' + targetingChips + "</div>" +
      statsHtml +
      (state.error ? '<div class="js-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(state.error) + "</div>" : "") +
      '<div class="js-scan-row">' +
        '<button type="button" class="btn-primary js-scan-btn" id="job-scout-scan"' + (state.scanBusy ? " disabled" : "") + ">" +
          (state.scanBusy
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Scanning every board…'
            : '<i class="fa-solid fa-radar"></i> Scan now') +
        "</button>" +
        (a.cadence !== "manual" ? '<span class="js-scan-hint"><i class="fa-solid fa-bolt"></i> also runs automatically</span>' : "") +
      "</div>" +
      (visible.length
        ? '<div class="js-inbox-head"><h4>Latest finds</h4><span class="js-rule"></span></div>' +
          '<div class="js-findings">' + visible.map(renderFindingRow).join("") + "</div>" +
          (more > 0 ? '<p class="js-more">+ ' + more + " more waiting in your inbox</p>" : "")
        : '<div class="js-empty-inbox"><i class="fa-solid fa-inbox"></i> No new roles yet — hit <strong>Scan now</strong> and fresh postings will appear here.</div>')
    );
  }

  // ---------------------------------------------------------------------------
  // Binding (called from afterRender.dashboard on every dashboard render)
  // ---------------------------------------------------------------------------

  function bind() {
    const setup = document.getElementById("job-scout-setup");
    if (setup) setup.addEventListener("click", openWizard);
    const edit = document.getElementById("job-scout-edit");
    if (edit) edit.addEventListener("click", openWizard);
    const scan = document.getElementById("job-scout-scan");
    if (scan) scan.addEventListener("click", runScan);
    document.querySelectorAll("[data-scout-save]").forEach(function (btn) {
      btn.addEventListener("click", function () { saveFindingToPipeline(btn.getAttribute("data-scout-save")); });
    });
    document.querySelectorAll("[data-scout-dismiss]").forEach(function (btn) {
      btn.addEventListener("click", function () { dismissFinding(btn.getAttribute("data-scout-dismiss")); });
    });

    // One load per session — the loadedOnce flag is set BEFORE the async load
    // so the load→render→afterRender→bind cycle can't recurse (same hazard the
    // digest scanner hit; see dashboard.route.js scanDigest).
    if (!state.loadedOnce && backendReady()) {
      state.loadedOnce = true;
      load().then(repaintDashboard);
    }
  }

  window.CBV2.jobScout = {
    renderPanel: renderPanel,
    bind: bind
  };
})();
