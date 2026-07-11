// Job Scout Agent — dashboard client (panel + wizard + inbox).
//
// Talks ONLY to the job-scout edge function (action-routed: get / save / scan /
// delete / update-finding). No client-side table access.
//
// Phase 4b: MULTIPLE agents per user. State holds an `agents` array, each with
// its own findings inbox and scan state; the panel renders a stack of agent
// cards with a "New agent" affordance (gated by the server-reported limit).
(function () {
  window.CBV2 = window.CBV2 || {};

  const state = {
    loadedOnce: false,
    loading: false,
    error: "",
    agents: [],            // each: {id,name,...config, findings:[], newCount, scanBusy}
    limit: 1,              // max agents for this plan (from server)
    stats: { totalNew: 0, agentCount: 0 },
    saveBusy: false,
    editingId: null        // agent being edited in the wizard (null = new)
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

  function findAgent(id) {
    return state.agents.find(function (a) { return a.id === id; }) || null;
  }
  function findFinding(id) {
    for (let i = 0; i < state.agents.length; i++) {
      const a = state.agents[i];
      const f = (a.findings || []).find(function (x) { return x.id === id; });
      if (f) return { agent: a, finding: f };
    }
    return null;
  }
  function recomputeTotals() {
    state.stats.totalNew = state.agents.reduce(function (n, a) { return n + (a.newCount || 0); }, 0);
    state.stats.agentCount = state.agents.length;
  }

  async function load() {
    state.loading = true;
    try {
      const out = await api("get");
      state.agents = (Array.isArray(out.agents) ? out.agents : []).map(function (a) {
        a.findings = Array.isArray(a.findings) ? a.findings : [];
        a.scanBusy = false;
        return a;
      });
      state.limit = out.limit || 1;
      state.stats = out.stats || { totalNew: 0, agentCount: state.agents.length };
      state.error = "";
      // Cron scans (Phase 2/3) deliver findings while the user is away, with no
      // browser to fit-score them — score any unscored NEW findings on arrival.
      state.agents.forEach(function (a) {
        const unscored = a.findings.filter(function (f) {
          return f.status === "new" && (f.fitScore === null || f.fitScore === undefined);
        });
        if (unscored.length) scoreNewFindings(a, unscored.slice(0, 12));
      });
    } catch (e) {
      state.error = (e && e.message) || "Could not load your Job Agents.";
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

  async function runScan(agentId) {
    const a = findAgent(agentId);
    if (!a || a.scanBusy) return;
    a.scanBusy = true;
    state.error = "";
    repaintDashboard();
    try {
      const out = await api("scan", { agentId: agentId });
      const fresh = Array.isArray(out.findings) ? out.findings : [];
      const known = {};
      a.findings.forEach(function (f) { known[f.id] = true; });
      a.findings = fresh.filter(function (f) { return !known[f.id]; }).concat(a.findings);
      a.newCount = a.findings.filter(function (f) { return f.status === "new"; }).length;
      a.lastRunStats = out.stats || a.lastRunStats;
      a.lastRunAt = new Date().toISOString();
      recomputeTotals();
      if (out.newCount > 0) {
        toast("success", a.name + " found " + out.newCount + " new role" + (out.newCount === 1 ? "" : "s") + ".");
      } else {
        toast("info", "Scan complete — nothing new for " + a.name + ".");
      }
      a.scanBusy = false;
      repaintDashboard();
      if (fresh.length) scoreNewFindings(a, fresh);
    } catch (e) {
      a.scanBusy = false;
      state.error = (e && e.message) || "Scan failed.";
      toast("error", state.error);
      repaintDashboard();
    }
  }

  // Resume-fit scoring for a specific agent's fresh findings.
  function scoreNewFindings(agent, fresh) {
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
        const row = (agent.findings || []).find(function (f) { return f.id === r.jobId; });
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
    const hit = findFinding(id);
    if (!hit) return;
    try {
      await api("update-finding", { findingId: id, status: "saved" });
      hit.finding.status = "saved";
      const store = window.CBV2.store;
      if (store && typeof store.bookmarkJob === "function" && hit.finding.job) {
        store.bookmarkJob(Object.assign({ id: "scout_" + id, sourceType: "api" }, hit.finding.job));
      }
      hit.agent.newCount = (hit.agent.findings || []).filter(function (f) { return f.status === "new"; }).length;
      recomputeTotals();
      toast("success", "Saved — find it under Saved jobs.");
      repaintDashboard();
    } catch (e) {
      toast("error", (e && e.message) || "Could not save.");
    }
  }

  async function dismissFinding(id) {
    const hit = findFinding(id);
    if (!hit) return;
    try {
      await api("update-finding", { findingId: id, status: "dismissed" });
      hit.agent.findings = hit.agent.findings.filter(function (f) { return f.id !== id; });
      hit.agent.newCount = hit.agent.findings.filter(function (f) { return f.status === "new"; }).length;
      recomputeTotals();
      repaintDashboard();
    } catch (e) {
      toast("error", (e && e.message) || "Could not dismiss.");
    }
  }

  async function deleteAgent(agentId) {
    const a = findAgent(agentId);
    if (!a) return;
    if (!window.confirm('Delete "' + a.name + '"? Its inbox and history are removed.')) return;
    try {
      await api("delete", { agentId: agentId });
      state.agents = state.agents.filter(function (x) { return x.id !== agentId; });
      recomputeTotals();
      toast("success", "Agent deleted.");
      repaintDashboard();
    } catch (e) {
      toast("error", (e && e.message) || "Could not delete the agent.");
    }
  }

  // ---------------------------------------------------------------------------
  // Wizard (setup / edit modal)
  // ---------------------------------------------------------------------------

  function wizardPrefill(agent) {
    if (agent) {
      return {
        name: agent.name,
        titles: (agent.targetTitles || []).join(", "),
        skills: (agent.mustHaveSkills || []).join(", "),
        excludes: (agent.excludeKeywords || []).join(", "),
        location: agent.location || "",
        strictness: agent.locationStrictness || "balanced",
        workMode: agent.workMode || "any",
        cadence: agent.cadence || "daily",
        notifyPush: agent.notifyPush !== false,
        notifyEmail: agent.notifyEmail !== false
      };
    }
    const store = window.CBV2.store;
    const js = store && typeof store.getJobSearchState === "function" ? (store.getJobSearchState() || {}) : {};
    const rp = js.roleProfile || {};
    return {
      name: state.agents.length ? "Job Agent " + (state.agents.length + 1) : "My Job Agent",
      titles: (Array.isArray(rp.targetTitles) ? rp.targetTitles : []).join(", "),
      skills: (Array.isArray(rp.mustHaveSkills) ? rp.mustHaveSkills : []).join(", "),
      excludes: (Array.isArray(rp.excludeKeywords) ? rp.excludeKeywords : []).join(", "),
      location: (js.filters && js.filters.location) || js.location || "",
      strictness: "balanced",
      workMode: "any",
      cadence: "daily",
      notifyPush: true,
      notifyEmail: true
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

  function openWizard(agentId) {
    closeWizard();
    state.editingId = agentId || null;
    const agent = agentId ? findAgent(agentId) : null;
    const p = wizardPrefill(agent);
    const overlay = document.createElement("div");
    overlay.id = "job-scout-wizard";
    overlay.className = "js-modal-overlay";
    const inputCls = 'class="js-input"';
    overlay.innerHTML =
      '<div class="js-modal" role="dialog" aria-modal="true" aria-label="Job Agent setup">' +
        '<div class="js-modal-head">' +
          '<span class="js-badge"><i class="fa-solid fa-satellite-dish"></i></span>' +
          "<h3>" + (agent ? "Edit agent" : "New Job Agent") + "</h3>" +
          '<button type="button" class="js-modal-close" id="js-agent-cancel-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
        "</div>" +
        '<p class="js-modal-intro">It runs your whole search pipeline, AI-expands your title with Deep Scan, and only brings back jobs it has never shown you before.</p>' +
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
        '<span class="js-field-label">Notify me when it finds new roles</span>' +
        '<div class="js-toggles">' +
          '<label class="js-toggle"><input type="checkbox" id="js-agent-notify-push"' + (p.notifyPush ? " checked" : "") + '><span><i class="fa-solid fa-bell"></i> Push notification</span></label>' +
          '<label class="js-toggle"><input type="checkbox" id="js-agent-notify-email"' + (p.notifyEmail ? " checked" : "") + '><span><i class="fa-solid fa-envelope"></i> Email digest</span></label>' +
        "</div>" +
        '<div class="js-modal-foot">' +
          '<button type="button" class="btn-ghost" id="js-agent-cancel">Cancel</button>' +
          '<button type="button" class="btn-primary" id="js-agent-submit"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + (agent ? "Save changes" : "Create agent & scan") + "</button>" +
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
    const agentInput = {
      name: (nameEl && nameEl.value) || "My Job Agent",
      targetTitles: titles,
      mustHaveSkills: splitCsv("js-agent-skills"),
      excludeKeywords: splitCsv("js-agent-excludes"),
      location: (locEl && locEl.value) || "",
      locationStrictness: (strictEl && strictEl.value) || "balanced",
      workMode: (modeEl && modeEl.value) || "any",
      cadence: (cadenceEl && cadenceEl.value) || "daily",
      notifyPush: !!(document.getElementById("js-agent-notify-push") || {}).checked,
      notifyEmail: !!(document.getElementById("js-agent-notify-email") || {}).checked,
      active: true
    };
    if (state.editingId) agentInput.id = state.editingId;

    state.saveBusy = true;
    const isNew = !state.editingId;
    try {
      const out = await api("save", { agent: agentInput });
      const saved = out.agent;
      saved.findings = [];
      saved.scanBusy = false;
      state.error = "";
      closeWizard();
      if (out.cadenceClamped) {
        toast("info", "Hourly auto-scan is a Pro feature — set to daily.");
      }
      if (isNew) {
        state.agents.push(saved);
        recomputeTotals();
        toast("success", "Agent created — running its first scan…");
        repaintDashboard();
        runScan(saved.id);
      } else {
        const idx = state.agents.findIndex(function (x) { return x.id === saved.id; });
        if (idx >= 0) {
          saved.findings = state.agents[idx].findings || [];
          saved.newCount = state.agents[idx].newCount || 0;
          state.agents[idx] = saved;
        }
        toast("success", "Agent updated.");
        repaintDashboard();
      }
    } catch (e) {
      toast("error", (e && e.message) || "Could not save the agent.");
    } finally {
      state.saveBusy = false;
      state.editingId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
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

  // One configured agent → a full card with targeting, stats, Deep Scan, scan
  // button and its own findings inbox.
  function renderAgentCard(a) {
    const stats = a.lastRunStats || null;
    const autoLabel = a.cadence === "hourly" ? "Auto-scan · hourly"
      : a.cadence === "daily" ? "Auto-scan · daily"
      : "Manual scans only";
    const findings = a.findings || [];

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
        statPill(a.newCount || 0, "New", true) +
        statPill(findings.length, "In inbox") +
        statPill(a.lastRunAt ? (timeAgo(a.lastRunAt) || "—") : "Never", "Last scan") +
        (stats && typeof stats.fetched === "number" ? statPill(stats.fetched, "Last fetch") : "") +
      "</div>";

    const titlesSearched = (stats && Array.isArray(stats.titlesSearched)) ? stats.titlesSearched : [];
    const primaryLower = (a.targetTitles || []).map(function (t) { return String(t).toLowerCase(); });
    const relatedTitles = titlesSearched.filter(function (t) { return primaryLower.indexOf(String(t).toLowerCase()) < 0; });
    const deepScanHtml = (stats && stats.deepScan && relatedTitles.length)
      ? '<div class="js-deepscan">' +
          '<span class="chip violet"><i class="fa-solid fa-wand-magic-sparkles"></i> Deep Scan</span>' +
          '<span class="js-deepscan-label">also searched ' + relatedTitles.length + " related role" + (relatedTitles.length === 1 ? "" : "s") + ":</span>" +
          relatedTitles.slice(0, 6).map(function (t) { return '<span class="chip subtle">' + esc(t) + "</span>"; }).join("") +
        "</div>"
      : "";

    const visible = findings.slice(0, 6);
    const more = findings.length - visible.length;

    return (
      '<article class="card job-scout-card">' +
        '<div class="js-head">' +
          '<span class="js-badge' + (a.scanBusy ? " is-scanning" : "") + '"><i class="fa-solid fa-satellite-dish"></i></span>' +
          '<div class="js-head-titles"><h3>' + esc(a.name) + '</h3><p class="js-head-sub">' + esc(autoLabel) + "</p></div>" +
          '<div class="js-head-actions">' +
            (a.newCount > 0 ? '<span class="chip green">' + esc(String(a.newCount)) + " new</span>" : "") +
            '<span class="chip ' + (a.active ? "cyan" : "subtle") + '"><span class="status-dot ' + (a.active ? "green" : "") + '" style="margin-right:2px;"></span>' + (a.active ? "Active" : "Paused") + "</span>" +
            '<button type="button" class="btn-ghost btn-sm" data-scout-edit="' + esc(a.id) + '"><i class="fa-solid fa-sliders"></i> Edit</button>' +
            '<button type="button" class="btn-ghost btn-sm" data-scout-delete="' + esc(a.id) + '" title="Delete agent"><i class="fa-solid fa-trash-can"></i></button>' +
          "</div>" +
        "</div>" +
        '<div class="js-targeting">' + targetingChips + "</div>" +
        deepScanHtml +
        statsHtml +
        '<div class="js-scan-row">' +
          '<button type="button" class="btn-primary js-scan-btn" data-scout-scan="' + esc(a.id) + '"' + (a.scanBusy ? " disabled" : "") + ">" +
            (a.scanBusy
              ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Scanning every board…'
              : '<i class="fa-solid fa-radar"></i> Scan now') +
          "</button>" +
          (a.cadence !== "manual" ? '<span class="js-scan-hint"><i class="fa-solid fa-bolt"></i> also runs automatically</span>' : "") +
        "</div>" +
        (visible.length
          ? '<div class="js-inbox-head"><h4>Latest finds</h4><span class="js-rule"></span></div>' +
            '<div class="js-findings">' + visible.map(renderFindingRow).join("") + "</div>" +
            (more > 0 ? '<p class="js-more">+ ' + more + " more waiting in your inbox</p>" : "")
          : '<div class="js-empty-inbox"><i class="fa-solid fa-inbox"></i> No new roles yet — hit <strong>Scan now</strong> and fresh postings will appear here.</div>') +
      "</article>"
    );
  }

  function renderEmptyState() {
    const step = function (num, icon, title, body) {
      return (
        '<div class="js-step">' +
          '<span class="js-step-ico"><i class="fa-solid ' + icon + '"></i></span>' +
          '<div class="js-step-body">' +
            "<h4>" + esc(title) + ' <span class="js-step-num">' + num + "</span></h4>" +
            "<p>" + esc(body) + "</p>" +
          "</div>" +
        "</div>"
      );
    };
    return shell(
      (state.error ? '<div class="js-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(state.error) + "</div>" : "") +
      '<div class="js-empty">' +
        '<div class="js-empty-lead">' +
          '<span class="js-badge"><i class="fa-solid fa-satellite-dish"></i></span>' +
          '<h3 class="js-empty-title">Put your job hunt on autopilot</h3>' +
          '<p class="js-empty-sub">Set up a personal agent once — it runs your full search pipeline across every board and only ever surfaces roles it has <strong>never shown you before</strong>, scored against your resume.</p>' +
          '<button type="button" class="btn-primary" id="job-scout-setup"><i class="fa-solid fa-wand-magic-sparkles"></i> Set up your Job Agent</button>' +
        "</div>" +
        '<div class="js-steps">' +
          step("01", "fa-sliders", "Configure once", "Titles, location & skills — pre-filled from your profile.") +
          step("02", "fa-satellite-dish", "Deep Scan expands it", "AI finds every related job title, then searches every board for each.") +
          step("03", "fa-inbox", "New roles land here", "Fresh, matched postings — review, save or apply.") +
        "</div>" +
      "</div>"
    );
  }

  function renderPanel() {
    // Signed-out / local mode → a quiet teaser, no API calls.
    if (!backendReady()) {
      return shell(
        simpleHead("Job Agent", '<span class="chip subtle">Cloud</span>') +
        '<p class="js-empty-sub" style="text-align:left;margin-left:0;">Sign in and your personal agent scans every board for brand-new roles that match you — then delivers them right here.</p>'
      );
    }
    if (!state.loadedOnce || (state.loading && !state.agents.length)) {
      return shell(
        simpleHead("Job Agent") +
        '<p class="js-empty-sub" style="text-align:left;margin-left:0;"><i class="fa-solid fa-circle-notch fa-spin"></i> Checking your agents…</p>'
      );
    }
    if (!state.agents.length) return renderEmptyState();

    // One or more agents → a stack with a header + a card each.
    const canAdd = state.agents.length < state.limit;
    const head =
      '<div class="js-stack-head">' +
        '<span class="js-badge"><i class="fa-solid fa-satellite-dish"></i></span>' +
        '<div class="js-head-titles"><h3>Your Job Agents</h3><p class="js-head-sub">' +
          state.agents.length + " of " + state.limit + " · " + (state.stats.totalNew || 0) + " new" +
        "</p></div>" +
        '<div class="js-head-actions">' +
          (canAdd
            ? '<button type="button" class="btn-primary btn-sm" id="job-scout-new"><i class="fa-solid fa-plus"></i> New agent</button>'
            : (state.limit <= 1
              ? '<button type="button" class="btn-ghost btn-sm" id="job-scout-upsell"><i class="fa-solid fa-crown"></i> More agents — Pro</button>'
              : '<span class="chip subtle">Max ' + state.limit + "</span>")) +
        "</div>" +
      "</div>";
    return (
      '<div class="job-scout-stack" id="job-scout-panel">' +
        head +
        (state.error ? '<div class="js-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(state.error) + "</div>" : "") +
        state.agents.map(renderAgentCard).join("") +
      "</div>"
    );
  }

  // ---------------------------------------------------------------------------
  // Binding (called from afterRender.dashboard on every dashboard render)
  // ---------------------------------------------------------------------------

  function bind() {
    const setup = document.getElementById("job-scout-setup");
    if (setup) setup.addEventListener("click", function () { openWizard(null); });
    const neu = document.getElementById("job-scout-new");
    if (neu) neu.addEventListener("click", function () { openWizard(null); });
    const upsell = document.getElementById("job-scout-upsell");
    if (upsell) upsell.addEventListener("click", function () {
      if (window.CBV2.upgradeModal && typeof window.CBV2.upgradeModal.open === "function") window.CBV2.upgradeModal.open("job-scout-agents");
      else toast("info", "Multiple agents are a Pro feature.");
    });
    document.querySelectorAll("[data-scout-scan]").forEach(function (btn) {
      btn.addEventListener("click", function () { runScan(btn.getAttribute("data-scout-scan")); });
    });
    document.querySelectorAll("[data-scout-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () { openWizard(btn.getAttribute("data-scout-edit")); });
    });
    document.querySelectorAll("[data-scout-delete]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteAgent(btn.getAttribute("data-scout-delete")); });
    });
    document.querySelectorAll("[data-scout-save]").forEach(function (btn) {
      btn.addEventListener("click", function () { saveFindingToPipeline(btn.getAttribute("data-scout-save")); });
    });
    document.querySelectorAll("[data-scout-dismiss]").forEach(function (btn) {
      btn.addEventListener("click", function () { dismissFinding(btn.getAttribute("data-scout-dismiss")); });
    });

    // One load per session — loadedOnce is set BEFORE the async load so the
    // load→render→afterRender→bind cycle can't recurse.
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
