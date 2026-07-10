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
    return '<span class="chip ' + cls + '" title="AI match vs your resume">' + esc(String(score)) + " · Fit</span>";
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
        workMode: state.agent.workMode || "any"
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
      workMode: "any"
    };
  }

  function fieldRow(label, inner, hint) {
    return (
      '<label style="display:block;margin-bottom:12px;">' +
        '<span class="muted" style="display:block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">' + esc(label) + "</span>" +
        inner +
        (hint ? '<span class="muted" style="display:block;font-size:12px;margin-top:3px;">' + esc(hint) + "</span>" : "") +
      "</label>"
    );
  }

  function openWizard() {
    closeWizard();
    const p = wizardPrefill();
    const overlay = document.createElement("div");
    overlay.id = "job-scout-wizard";
    overlay.setAttribute("style", "position:fixed;inset:0;z-index:1200;background:rgba(4,6,14,.72);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;");
    const inputStyle = 'style="width:100%;box-sizing:border-box;"';
    overlay.innerHTML =
      '<div class="card" role="dialog" aria-modal="true" aria-label="Job Agent setup" style="max-width:560px;width:100%;max-height:90vh;overflow:auto;padding:22px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
          "<h3><i class=\"fa-solid fa-satellite-dish\"></i> " + (state.agent ? "Edit your Job Agent" : "Set up your Job Agent") + "</h3>" +
          '<button type="button" class="icon-btn" id="js-agent-cancel-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
        "</div>" +
        '<p class="muted" style="margin-top:0;">It runs your whole search pipeline and only brings back jobs it has never shown you before.</p>' +
        fieldRow("Agent name", '<input id="js-agent-name" type="text" maxlength="60" value="' + esc(p.name) + '" ' + inputStyle + " />") +
        fieldRow("Target job titles (comma-separated)", '<input id="js-agent-titles" type="text" placeholder="e.g. Fire Engineer, Fire Protection Engineer" value="' + esc(p.titles) + '" ' + inputStyle + " />", "Required — the first title drives the search query.") +
        fieldRow("Must-have skills (optional)", '<input id="js-agent-skills" type="text" placeholder="e.g. AutoCAD, sprinkler design" value="' + esc(p.skills) + '" ' + inputStyle + " />") +
        fieldRow("Exclude keywords (optional)", '<input id="js-agent-excludes" type="text" placeholder="e.g. sales, internship" value="' + esc(p.excludes) + '" ' + inputStyle + " />", "Jobs mentioning these are never delivered.") +
        fieldRow("Location", '<input id="js-agent-location" type="text" placeholder="e.g. Cape Town" value="' + esc(p.location) + '" ' + inputStyle + " />") +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:160px;">' +
            fieldRow("Location match",
              '<select id="js-agent-strictness" ' + inputStyle + ">" +
                '<option value="strict"' + (p.strictness === "strict" ? " selected" : "") + ">Strict — this place only</option>" +
                '<option value="balanced"' + (p.strictness === "balanced" ? " selected" : "") + ">Balanced — includes remote</option>" +
                '<option value="broad"' + (p.strictness === "broad" ? " selected" : "") + ">Broad</option>" +
              "</select>") +
          "</div>" +
          '<div style="flex:1;min-width:160px;">' +
            fieldRow("Work mode",
              '<select id="js-agent-workmode" ' + inputStyle + ">" +
                '<option value="any"' + (p.workMode === "any" ? " selected" : "") + ">Any</option>" +
                '<option value="remote"' + (p.workMode === "remote" ? " selected" : "") + ">Remote only</option>" +
                '<option value="onsite"' + (p.workMode === "onsite" ? " selected" : "") + ">On-site</option>" +
              "</select>") +
          "</div>" +
        "</div>" +
        '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">' +
          '<button type="button" class="btn-ghost" id="js-agent-cancel">Cancel</button>' +
          '<button type="button" class="btn-primary" id="js-agent-submit">' + (state.agent ? "Save changes" : "Create agent & scan") + "</button>" +
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
    const payload = {
      agent: {
        name: (nameEl && nameEl.value) || "My Job Agent",
        targetTitles: titles,
        mustHaveSkills: splitCsv("js-agent-skills"),
        excludeKeywords: splitCsv("js-agent-excludes"),
        location: (locEl && locEl.value) || "",
        locationStrictness: (strictEl && strictEl.value) || "balanced",
        workMode: (modeEl && modeEl.value) || "any",
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
    const meta = [job.company, job.location].filter(Boolean).map(esc).join(" · ");
    const statusChip = f.status === "saved"
      ? '<span class="chip subtle">Saved</span>'
      : f.status === "applied"
        ? '<span class="chip subtle">Applied</span>'
        : "";
    return (
      '<li class="job-scout-row" style="display:flex;flex-direction:column;gap:4px;padding:10px 0;border-bottom:1px solid var(--color-border);">' +
        '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
          '<a href="' + esc(job.url || "#") + '" target="_blank" rel="noopener noreferrer" style="font-weight:600;">' + esc(job.title || "Untitled role") + "</a>" +
          '<span style="display:flex;gap:6px;flex-wrap:wrap;">' +
            fitChip(f.fitScore) +
            (job.remote ? '<span class="chip blue">Remote</span>' : "") +
            (job.source ? '<span class="chip subtle">' + esc(job.source) + "</span>" : "") +
            statusChip +
          "</span>" +
        "</div>" +
        (meta ? '<span class="muted" style="font-size:13px;">' + meta + (job.postedAt ? " · " + esc(timeAgo(job.postedAt) || job.postedAt) : "") + "</span>" : "") +
        '<div style="display:flex;gap:8px;margin-top:2px;flex-wrap:wrap;">' +
          '<a class="btn-ghost btn-sm" href="' + esc(job.url || "#") + '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>' +
          (f.status !== "saved"
            ? '<button type="button" class="btn-ghost btn-sm" data-scout-save="' + esc(f.id) + '"><i class="fa-solid fa-bookmark"></i> Save</button>'
            : "") +
          '<button type="button" class="btn-ghost btn-sm" data-scout-dismiss="' + esc(f.id) + '"><i class="fa-solid fa-xmark"></i> Dismiss</button>' +
        "</div>" +
      "</li>"
    );
  }

  function renderPanel() {
    // Local-only / signed-out: a quiet teaser, no API calls.
    if (!backendReady()) {
      return (
        '<article class="card panel-lg" id="job-scout-panel">' +
          '<div class="resume-section-head"><h3><i class="fa-solid fa-satellite-dish"></i> Job Agent</h3><span class="chip subtle">Cloud</span></div>' +
          '<p class="muted">Sign in and your personal agent scans every board for brand-new roles that match you — and delivers them here.</p>' +
        "</article>"
      );
    }

    if (!state.loadedOnce || (state.loading && !state.agent && !state.findings.length)) {
      return (
        '<article class="card panel-lg" id="job-scout-panel">' +
          '<div class="resume-section-head"><h3><i class="fa-solid fa-satellite-dish"></i> Job Agent</h3></div>' +
          '<p class="muted"><i class="fa-solid fa-circle-notch fa-spin"></i> Checking your agent…</p>' +
        "</article>"
      );
    }

    if (!state.agent) {
      return (
        '<article class="card panel-lg" id="job-scout-panel">' +
          '<div class="resume-section-head"><h3><i class="fa-solid fa-satellite-dish"></i> Job Agent</h3><span class="chip cyan">New</span></div>' +
          '<p class="muted">Configure a personal agent once — it runs your full search pipeline and only ever shows you jobs it has never delivered before.</p>' +
          (state.error ? '<p class="ai-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(state.error) + "</p>" : "") +
          '<button type="button" class="btn-primary" id="job-scout-setup"><i class="fa-solid fa-wand-magic-sparkles"></i> Set up your Job Agent</button>' +
        "</article>"
      );
    }

    const a = state.agent;
    const stats = a.lastRunStats || null;
    const lastLine = a.lastRunAt
      ? "Last scan " + timeAgo(a.lastRunAt) + (stats ? " · " + esc(String(stats.fetched || 0)) + " fetched · " + esc(String(stats.newCount || 0)) + " new" : "")
      : "Never run yet";
    const targeting = [
      (a.targetTitles || []).slice(0, 3).join(", "),
      a.location || "",
      a.workMode === "remote" ? "remote" : (a.workMode === "onsite" ? "on-site" : "")
    ].filter(Boolean).join(" · ");
    const visible = state.findings.slice(0, 8);
    const more = state.findings.length - visible.length;

    return (
      '<article class="card panel-lg" id="job-scout-panel">' +
        '<div class="resume-section-head" style="flex-wrap:wrap;gap:8px;">' +
          "<h3><i class=\"fa-solid fa-satellite-dish\"></i> " + esc(a.name) + "</h3>" +
          '<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            (state.stats.newCount > 0 ? '<span class="chip green">' + esc(String(state.stats.newCount)) + " new</span>" : "") +
            '<span class="chip ' + (a.active ? "cyan" : "subtle") + '">' + (a.active ? "Active" : "Paused") + "</span>" +
            '<button type="button" class="btn-ghost btn-sm" id="job-scout-edit"><i class="fa-solid fa-sliders"></i> Edit</button>' +
          "</span>" +
        "</div>" +
        '<p class="muted" style="margin:2px 0 4px;">' + esc(targeting || "No targeting set") + "</p>" +
        '<p class="muted" style="margin:0 0 10px;font-size:13px;">' + lastLine + "</p>" +
        (state.error ? '<p class="ai-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(state.error) + "</p>" : "") +
        '<button type="button" class="btn-primary btn-sm" id="job-scout-scan"' + (state.scanBusy ? " disabled" : "") + ">" +
          (state.scanBusy
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Scanning all boards…'
            : '<i class="fa-solid fa-radar"></i> Scan now') +
        "</button>" +
        (visible.length
          ? '<ul style="list-style:none;margin:12px 0 0;padding:0;">' + visible.map(renderFindingRow).join("") + "</ul>" +
            (more > 0 ? '<p class="muted" style="font-size:12px;margin:8px 0 0;">+' + more + " more in your inbox</p>" : "")
          : '<p class="muted" style="margin-top:12px;">No findings yet — run a scan and your agent will deliver brand-new postings here.</p>') +
      "</article>"
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
