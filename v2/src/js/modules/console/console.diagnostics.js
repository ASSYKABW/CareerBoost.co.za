// CareerBoost Console — Backend diagnostics + operator job-board credentials.
//
// P1: moved out of the candidate-facing Settings "Advanced" tab. This is
// operator tooling (it hits ai-run / jobs-search directly and holds raw
// provider keys), so it belongs behind the Console's admin gate rather than
// shipping inside the user settings surface.
//
// Exposes window.CBConsole.diagnostics = { render, bind }. The AI & Health
// section mounts it (render() returns a #cbc-diag panel; bind() wires it and
// re-renders that panel in place).
(function () {
  window.CBConsole = window.CBConsole || {};
  window.CBConsole.diagnostics = window.CBConsole.diagnostics || {};

  function esc(s) {
    var u = window.CBConsole.util;
    return (u && u.escapeHtml) ? u.escapeHtml(s) : String(s == null ? "" : s);
  }
  function toast(m) {
    if (window.CBConsole.ui && window.CBConsole.ui.toast) window.CBConsole.ui.toast(m);
  }

  // results: per-check {ok, latencyMs, detail, error}; tests: provider key tests.
  var state = { results: {}, running: false, lastRunAt: "", tests: {} };

  var CHECKS = [
    { id: "auth", label: "Authentication", desc: "Validates the current session token is accepted by Supabase Auth." },
    { id: "db", label: "Database", desc: "Round-trips a tiny query to the profiles table (RLS must match you)." },
    { id: "ai", label: "AI (query-parse)", desc: "Calls the ai-run Edge Function and validates its JSON output." },
    { id: "aiCritique", label: "AI (resume-critique)", desc: "Calls ai-run for Resume Lab critique — reports provider/model/issues." },
    { id: "aiTailor", label: "AI (tailor-plan)", desc: "Calls ai-run for Tailor Plan — reports provider/model/rewrites." },
    { id: "jobs", label: "Job search aggregator", desc: "Calls the jobs-search Edge Function and counts results." }
  ];

  function suggestFix(id, errorText) {
    var msg = String(errorText || "").toLowerCase();
    if (id === "auth") return "Re-authenticate in a new tab/session, then run diagnostics again.";
    if (id === "db") return "Check RLS on the profiles table and ensure your signed-in user can read at least one row.";
    if (id === "jobs") return "Verify the jobs-search Edge Function deployment and backend provider secrets.";
    if (id === "ai" || id === "aiCritique" || id === "aiTailor") {
      if (msg.indexOf("jwt") >= 0 || msg.indexOf("401") >= 0) return "Session token is likely stale. Sign out/in and retry.";
      return "Check ai-run Edge Function logs and provider credentials in backend environment.";
    }
    return "Review backend logs for this service and retry.";
  }

  // ── Edge-function plumbing (ported verbatim) ─────────────────────────
  async function readResponseDetail(res) {
    var text = "";
    try { text = await res.text(); } catch (e) { /* ignore */ }
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    return { text: text, json: json };
  }

  function extractErrorMessage(status, info) {
    if (info.json) {
      if (typeof info.json.error === "string") return info.json.error;
      if (typeof info.json.message === "string") return info.json.message;
      if (typeof info.json.msg === "string") return info.json.msg;
    }
    var snippet = (info.text || "").slice(0, 200);
    return snippet ? "HTTP " + status + " · " + snippet : "HTTP " + status;
  }

  async function callEdgeFunction(path, payload) {
    var auth = window.CBV2.auth;
    var cfg = window.CBV2.config;
    var client = auth.getClient();

    // Preferred: SDK invoke — attaches apikey + current session token.
    if (client && client.functions && typeof client.functions.invoke === "function") {
      var out = await client.functions.invoke(path, { body: payload });
      if (out.error) {
        var detail = null;
        try {
          if (out.error.context && typeof out.error.context.text === "function") {
            var text = await out.error.context.text();
            var json = null;
            try { json = JSON.parse(text); } catch (e) { /* ignore */ }
            detail = { text: text, json: json };
          }
        } catch (e) { /* ignore */ }
        var status = (out.error.context && out.error.context.status) || out.error.status || 0;
        var msg = detail ? extractErrorMessage(status, detail) : (out.error.message || "Edge function error");
        var err = new Error(msg);
        err.status = status;
        throw err;
      }
      return out.data;
    }

    // Fallback: manual fetch (older SDK).
    var token = await auth.getAccessToken();
    var res = await fetch(cfg.getFunctionsUrl() + "/" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        apikey: cfg.getSupabaseAnon(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    var info = await readResponseDetail(res);
    if (!res.ok || (info.json && info.json.ok === false)) {
      var e2 = new Error(extractErrorMessage(res.status, info));
      e2.status = res.status;
      throw e2;
    }
    return info.json;
  }

  function signedIn() {
    return !!(window.CBV2 && window.CBV2.auth && window.CBV2.auth.isAuthenticated());
  }

  // ── Individual checks ────────────────────────────────────────────────
  async function diagAuth() {
    if (!signedIn()) { state.results.auth = { ok: false, error: "Not signed in" }; return; }
    var start = Date.now();
    try {
      var auth = window.CBV2.auth;
      var token = await auth.getAccessToken();
      if (!token) throw new Error("No access token in session.");
      var got = await auth.getClient().auth.getUser();
      if (got.error || !got.data || !got.data.user) throw new Error((got.error && got.error.message) || "No user returned");
      state.results.auth = { ok: true, latencyMs: Date.now() - start, detail: "User: " + got.data.user.email };
    } catch (err) {
      state.results.auth = { ok: false, latencyMs: Date.now() - start, error: err.message || "auth failed" };
    }
  }

  async function diagDb() {
    if (!signedIn()) { state.results.db = { ok: false, error: "Not signed in" }; return; }
    var start = Date.now();
    try {
      var out = await window.CBV2.auth.getClient().from("profiles").select("user_id").limit(1);
      if (out.error) throw new Error(out.error.message);
      state.results.db = { ok: true, latencyMs: Date.now() - start, detail: "Database reachable and RLS policies allow reads." };
    } catch (err) {
      state.results.db = { ok: false, latencyMs: Date.now() - start, error: err.message || "db failed" };
    }
  }

  async function diagAi() {
    if (!signedIn()) { state.results.ai = { ok: false, error: "Not signed in" }; return; }
    var start = Date.now();
    try {
      var body = await callEdgeFunction("ai-run", {
        requestId: "diag_" + Date.now(),
        skill: "query-parse",
        promptVersion: "diag@1",
        input: { query: "senior react engineer remote europe this week" }
      });
      if (!body || body.ok === false) throw new Error((body && body.error) || "AI returned no body.");
      state.results.ai = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Provider: " + (body.provider || body.model || "unknown") + " · returned " + ((body.data && body.data.keywords) || []).length + " keywords."
      };
    } catch (err) {
      state.results.ai = { ok: false, latencyMs: Date.now() - start, error: err.message || "ai failed" };
    }
  }

  async function diagAiCritique() {
    if (!signedIn()) { state.results.aiCritique = { ok: false, error: "Not signed in" }; return; }
    var start = Date.now();
    try {
      var body = await callEdgeFunction("ai-run", {
        requestId: "diag_critique_" + Date.now(),
        skill: "resume-critique",
        promptVersion: "diag@1",
        input: {
          targetRole: "Frontend Engineer",
          resume: JSON.stringify({
            header: { name: "Alex Example", title: "Frontend Developer", email: "alex@example.com" },
            summary: "Frontend engineer focused on reliable UI delivery and cross-functional collaboration.",
            experience: [{ role: "Frontend Engineer", company: "Acme", bullets: [{ id: "b1", text: "Participated in design and development for internal web apps." }] }],
            skills: { groups: [{ label: "Core", items: ["React", "TypeScript"] }] }
          })
        }
      });
      if (!body || body.ok === false) throw new Error((body && body.error) || "AI returned no body.");
      state.results.aiCritique = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Provider: " + (body.provider || body.model || "unknown") + " · model: " + (body.model || "unknown") + " · issues: " + ((body.data && body.data.issues) || []).length + "."
      };
    } catch (err) {
      state.results.aiCritique = { ok: false, latencyMs: Date.now() - start, error: err.message || "ai critique failed" };
    }
  }

  async function diagAiTailor() {
    if (!signedIn()) { state.results.aiTailor = { ok: false, error: "Not signed in" }; return; }
    var start = Date.now();
    try {
      var body = await callEdgeFunction("ai-run", {
        requestId: "diag_tailor_" + Date.now(),
        skill: "tailor-plan",
        promptVersion: "diag@1",
        input: {
          targetRole: "Frontend Engineer",
          jd: "We are hiring a Frontend Engineer to build performant React interfaces, collaborate with product/design, and improve usability.",
          resume: JSON.stringify({
            header: { name: "Alex Example", title: "Frontend Developer" },
            summary: "Frontend engineer focused on delivery quality and UX.",
            experience: [{ role: "Frontend Engineer", company: "Acme", bullets: [{ id: "b1", text: "Built and maintained React UI components for internal products." }] }],
            skills: { groups: [{ label: "Core", items: ["React", "TypeScript", "CSS"] }] }
          })
        }
      });
      if (!body || body.ok === false) throw new Error((body && body.error) || "AI returned no body.");
      state.results.aiTailor = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Provider: " + (body.provider || body.model || "unknown") + " · model: " + (body.model || "unknown") + " · rewrites: " + ((body.data && body.data.bullets) || []).length + "."
      };
    } catch (err) {
      state.results.aiTailor = { ok: false, latencyMs: Date.now() - start, error: err.message || "ai tailor failed" };
    }
  }

  async function diagJobs() {
    if (!signedIn()) { state.results.jobs = { ok: false, error: "Not signed in" }; return; }
    var start = Date.now();
    try {
      var body = await callEdgeFunction("jobs-search", {
        query: "engineer",
        filters: { remoteOnly: false, postedWithinDays: 0, sort: "newest" }
      });
      if (!body || body.ok === false) throw new Error((body && body.error) || "Jobs returned no body.");
      var sources = (body.sources || []).map(function (s) { return s.name + ":" + (s.ok ? s.count : "fail"); }).join(", ");
      state.results.jobs = { ok: true, latencyMs: Date.now() - start, detail: (body.jobs || []).length + " jobs total · " + sources };
    } catch (err) {
      state.results.jobs = { ok: false, latencyMs: Date.now() - start, error: err.message || "jobs failed" };
    }
  }

  var RUNNERS = { auth: diagAuth, db: diagDb, ai: diagAi, aiCritique: diagAiCritique, aiTailor: diagAiTailor, jobs: diagJobs };

  async function runAll() {
    state.running = true;
    state.results = {};
    rerender();
    for (var i = 0; i < CHECKS.length; i++) {
      await RUNNERS[CHECKS[i].id]();
      rerender();
    }
    state.lastRunAt = new Date().toISOString();
    state.running = false;
    rerender();
  }

  // ── Provider key tests ───────────────────────────────────────────────
  function readKeyForm() {
    function v(id, dflt) { var el = document.getElementById(id); return (el && el.value) || dflt || ""; }
    return {
      adzunaAppId: v("cbc-k-adzuna-id"),
      adzunaAppKey: v("cbc-k-adzuna-key"),
      adzunaCountry: v("cbc-k-adzuna-country", "gb"),
      museKey: v("cbc-k-muse")
    };
  }

  async function testAdzuna() {
    var cfg = window.CBV2.store.getApiKeys();
    if (!cfg.adzunaAppId || !cfg.adzunaAppKey) {
      state.tests.adzuna = { ok: false, error: "Missing App ID or Key", testedAt: new Date().toISOString() };
      rerender();
      return;
    }
    try {
      var url = "https://api.adzuna.com/v1/api/jobs/" + encodeURIComponent(cfg.adzunaCountry || "gb") +
        "/search/1?app_id=" + encodeURIComponent(cfg.adzunaAppId) +
        "&app_key=" + encodeURIComponent(cfg.adzunaAppKey) + "&results_per_page=1";
      var res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      state.tests.adzuna = { ok: true, count: data.count || 0, testedAt: new Date().toISOString() };
    } catch (err) {
      state.tests.adzuna = { ok: false, error: err.message || "Request failed", testedAt: new Date().toISOString() };
    }
    rerender();
  }

  async function testMuse() {
    var cfg = window.CBV2.store.getApiKeys();
    try {
      var q = cfg.museKey ? "api_key=" + encodeURIComponent(cfg.museKey) + "&" : "";
      var res = await fetch("https://www.themuse.com/api/public/jobs?" + q + "page=0");
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      state.tests.muse = { ok: true, count: (data.results || []).length, testedAt: new Date().toISOString() };
    } catch (err) {
      state.tests.muse = { ok: false, error: err.message || "Request failed", testedAt: new Date().toISOString() };
    }
    rerender();
  }

  // ── Render ───────────────────────────────────────────────────────────
  function testChip(id) {
    var r = state.tests[id];
    if (!r) return "";
    var at = r.testedAt ? new Date(r.testedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    var txt = r.ok ? "OK · " + r.count + " results" : "Failed · " + esc(r.error || "unknown");
    return '<span class="cbc-chip ' + (r.ok ? "green" : "red") + '">' + txt + (at ? " · " + at : "") + "</span>";
  }

  function checkRow(c) {
    var r = state.results[c.id];
    var tone = "amber", icon = "fa-circle", chip = '<span class="cbc-chip">Not run</span>';
    if (state.running && !r) {
      chip = '<span class="cbc-chip">Running…</span>';
      icon = "fa-circle-notch fa-spin";
    } else if (r) {
      tone = r.ok ? "green" : "red";
      icon = r.ok ? "fa-check" : "fa-xmark";
      chip = '<span class="cbc-chip ' + tone + '">' + (r.ok ? "OK · " + (r.latencyMs || 0) + "ms" : "Failed") + "</span>";
    }
    var detail = "";
    if (r && !r.ok && r.error) {
      detail = '<div style="color:var(--c-bad,#f87171);font-size:12px;margin-top:4px">' + esc(r.error) + "</div>" +
        '<div style="color:var(--c-muted);font-size:12px;margin-top:2px"><strong>Suggested fix:</strong> ' + esc(suggestFix(c.id, r.error)) + "</div>";
    } else if (r && r.ok && r.detail) {
      detail = '<div style="color:var(--c-muted);font-size:12px;margin-top:4px">' + esc(r.detail) + "</div>";
    }
    if (r) {
      detail += '<button class="cbc-btn cbc-sm" data-diag-copy="' + esc(JSON.stringify({
        check: c.id, ok: !!r.ok, latencyMs: r.latencyMs || 0, detail: r.detail || "", error: r.error || ""
      })) + '" style="margin-top:6px"><i class="fa-solid fa-copy"></i> Copy details</button>';
    }
    return '<div class="cbc-att-it"><div class="cbc-att-ic ' + tone + '"><i class="fa-solid ' + icon + '"></i></div>' +
      '<div class="cbc-tx">' + esc(c.label) + '<small>' + esc(c.desc) + "</small>" + detail + "</div>" +
      '<div class="cbc-rt">' + chip + "</div></div>";
  }

  function keysPanel() {
    var k = (window.CBV2.store && window.CBV2.store.getApiKeys && window.CBV2.store.getApiKeys()) || {};
    var inputStyle = 'style="width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--c-line,rgba(255,255,255,.12));background:var(--c-bg2,rgba(255,255,255,.04));color:var(--c-fg,#e9ecf8);font-family:inherit;font-size:12.5px"';
    var countries = ["gb", "us", "ca", "au", "de", "fr", "nl", "es", "it", "pl", "za", "br", "in", "sg"];
    return '<div class="cbc-card cbc-panel" id="cbc-diag-keys" style="margin-top:14px">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Operator only</div><h2>Job-board credentials</h2></div></div>' +
      '<div style="color:var(--c-muted);font-size:12.5px;margin-bottom:10px">Used to validate provider access for the <strong>jobs-search</strong> Edge Function and local operator tests. Never store candidate passwords here.</div>' +
      '<form id="cbc-keys-form">' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">' +
          '<label style="font-size:12px;color:var(--c-muted)">Adzuna App ID<input id="cbc-k-adzuna-id" type="text" autocomplete="off" value="' + esc(k.adzunaAppId || "") + '" ' + inputStyle + ' /></label>' +
          '<label style="font-size:12px;color:var(--c-muted)">Adzuna App Key<input id="cbc-k-adzuna-key" type="password" autocomplete="off" value="' + esc(k.adzunaAppKey || "") + '" ' + inputStyle + ' /></label>' +
          '<label style="font-size:12px;color:var(--c-muted)">Country<select id="cbc-k-adzuna-country" ' + inputStyle + '>' +
            countries.map(function (c) { return '<option value="' + c + '"' + ((k.adzunaCountry || "gb") === c ? " selected" : "") + ">" + c.toUpperCase() + "</option>"; }).join("") +
          "</select></label>" +
        "</div>" +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">' +
          '<button type="button" class="cbc-btn cbc-sm" data-diag-test="adzuna"><i class="fa-solid fa-vial"></i> Test Adzuna</button>' + testChip("adzuna") +
        "</div>" +
        '<label style="display:block;margin-top:12px;font-size:12px;color:var(--c-muted)">The Muse API key (optional)<input id="cbc-k-muse" type="password" autocomplete="off" value="' + esc(k.museKey || "") + '" ' + inputStyle + ' /></label>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">' +
          '<button type="button" class="cbc-btn cbc-sm" data-diag-test="muse"><i class="fa-solid fa-vial"></i> Test Muse</button>' + testChip("muse") +
        "</div>" +
        '<div style="display:flex;gap:8px;margin-top:14px">' +
          '<button type="submit" class="cbc-btn cbc-sm cbc-amber"><i class="fa-solid fa-floppy-disk"></i> Save keys</button>' +
          '<button type="button" class="cbc-btn cbc-sm" data-diag-clear-keys="1"><i class="fa-solid fa-rotate-left"></i> Clear all</button>' +
        "</div>" +
      "</form></div>";
  }

  function pathPanel() {
    var cfg = window.CBV2.config;
    if (!cfg || typeof cfg.isForceClientJobSearch !== "function") return "";
    var forced = cfg.isForceClientJobSearch();
    return '<div class="cbc-card cbc-panel" id="cbc-diag-path" style="margin-top:14px">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">This tab only</div><h2>Job search path</h2></div>' +
      '<span class="cbc-chip ' + (forced ? "amber" : "green") + '">' + (forced ? "Browser feeds" : "CareerBoost Cloud") + "</span></div>" +
      '<div style="color:var(--c-muted);font-size:12.5px">Signed-in cloud searches normally call only the <strong>jobs-search</strong> Edge Function. Force browser feeds to debug keys, CORS, or provider behaviour — applies to this tab until turned off, and clears the in-memory job cache.</div>' +
      '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px">' +
        '<input type="checkbox" id="cbc-force-client"' + (forced ? " checked" : "") + " /> Force browser job feeds</label></div>";
  }

  function render() {
    var backendOn = !!(window.CBV2.config && window.CBV2.config.isBackendEnabled && window.CBV2.config.isBackendEnabled());
    if (!backendOn) return "";
    var last = state.lastRunAt ? '<div style="color:var(--c-muted);font-size:12px;margin-bottom:8px">Last run: ' + esc(new Date(state.lastRunAt).toLocaleString()) + "</div>" : "";
    return '<div id="cbc-diag-wrap">' +
      '<div class="cbc-card cbc-panel cbc-att" id="cbc-diag" style="margin-top:14px">' +
        '<div class="cbc-ph"><div><div class="cbc-eb">Operator</div><h2>Backend diagnostics</h2></div>' +
          '<span class="cbc-chip ' + (signedIn() ? "green" : "amber") + '">' + (signedIn() ? "Signed in" : "Signed out") + "</span></div>" +
        '<div style="color:var(--c-muted);font-size:12.5px;margin-bottom:8px">Health checks against the backend — auth, database, AI proxy, and the jobs aggregator.</div>' +
        last +
        CHECKS.map(checkRow).join("") +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
          '<button class="cbc-btn cbc-sm cbc-amber" data-diag-run="1"' + (!signedIn() || state.running ? " disabled" : "") + '><i class="fa-solid fa-stethoscope"></i> Run diagnostics</button>' +
          '<button class="cbc-btn cbc-sm" data-diag-report="1"' + (state.running ? " disabled" : "") + '><i class="fa-solid fa-clipboard-list"></i> Copy report</button>' +
          '<button class="cbc-btn cbc-sm" data-diag-reset="1"' + (state.running ? " disabled" : "") + ">Clear</button>" +
        "</div>" +
      "</div>" + pathPanel() + keysPanel() + "</div>";
  }

  function rerender() {
    var wrap = document.getElementById("cbc-diag-wrap");
    if (!wrap) return;
    wrap.outerHTML = render();
    bind();
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text); toast("Copied."); } catch (e) { /* ignore */ }
  }

  function bind() {
    var wrap = document.getElementById("cbc-diag-wrap");
    if (!wrap) return;

    wrap.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-diag-run],[data-diag-report],[data-diag-reset],[data-diag-copy],[data-diag-test],[data-diag-clear-keys]") : null;
      if (!t) return;
      if (t.hasAttribute("data-diag-run")) { runAll(); return; }
      if (t.hasAttribute("data-diag-report")) {
        copy(JSON.stringify({ ranAt: state.lastRunAt, results: state.results }, null, 2));
        return;
      }
      if (t.hasAttribute("data-diag-reset")) { state.results = {}; state.lastRunAt = ""; rerender(); return; }
      if (t.hasAttribute("data-diag-copy")) { copy(t.getAttribute("data-diag-copy") || ""); return; }
      if (t.hasAttribute("data-diag-test")) {
        window.CBV2.store.setApiKeys(readKeyForm());
        if (t.getAttribute("data-diag-test") === "adzuna") testAdzuna(); else testMuse();
        return;
      }
      if (t.hasAttribute("data-diag-clear-keys")) {
        window.CBV2.store.setApiKeys({ adzunaAppId: "", adzunaAppKey: "", adzunaCountry: "gb", museKey: "" });
        state.tests = {};
        toast("API keys cleared.");
        rerender();
        return;
      }
    });

    var form = wrap.querySelector("#cbc-keys-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        window.CBV2.store.setApiKeys(readKeyForm());
        if (window.CBJobs && typeof window.CBJobs.clearCache === "function") window.CBJobs.clearCache();
        toast("API keys saved — job cache cleared.");
        rerender();
      });
    }

    var force = wrap.querySelector("#cbc-force-client");
    if (force) {
      force.addEventListener("change", function () {
        // config.isForceClientJobSearch() reads this session key — there is no
        // setter, so write it the same way the old Settings toggle did.
        try {
          if (force.checked) sessionStorage.setItem("cb_force_client_job_search", "1");
          else sessionStorage.removeItem("cb_force_client_job_search");
        } catch (e) { /* ignore */ }
        if (window.CBJobs && typeof window.CBJobs.clearCache === "function") window.CBJobs.clearCache();
        toast(force.checked ? "This tab will use in-browser job feeds until you turn this off." : "CareerBoost Cloud restored for job search on this tab.");
        rerender();
      });
    }
  }

  window.CBConsole.diagnostics.render = render;
  window.CBConsole.diagnostics.bind = bind;
})();
