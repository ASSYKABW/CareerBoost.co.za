// Admin section — "API Credentials".
//
// Status-only view of every Supabase Edge Function secret the app
// depends on. Never shows the secret value (those live in Supabase's
// secret store and never leave the runtime).
//
// What we surface:
//   - Per-key "Set / Missing" chip (env var present and non-empty)
//   - Per-service "Reachable / Auth failed / Rate limited / Quota exhausted"
//     chip — fetched on demand by hitting the cheapest "are you alive?"
//     endpoint each provider offers (Test buttons)
//   - One-click "Copy rotation command" → PowerShell `supabase secrets set`
//     line on the clipboard with the project ref pre-filled
//
// Rotation flow: copy command → paste in PowerShell with new key value →
// hit Enter → click Refresh in admin. The key value never enters the
// browser or our database.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  // Module state. Survives re-renders within the same admin visit.
  // Cleared when the admin section file is reloaded (page refresh).
  const state = {
    loading: false,
    error: "",
    snapshot: null,        // { catalog, services, projectRef, generatedAt }
    snapshotAt: 0,
    // Health-check results keyed by service name. Each entry:
    //   { ok, status, message, latencyMs, httpStatus, checkedAt }
    checks: {},
    // Per-service "I'm currently running a check" flag — drives the
    // spinner in the Test button.
    checking: {}
  };

  // ---------- helpers --------------------------------------------------

  function st(s) {
    if (window.CBV2 && typeof window.CBV2.sanitizeText === "function") return window.CBV2.sanitizeText(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function categoryLabel(key) {
    return {
      ai:              { label: "AI providers",       icon: "fa-wand-magic-sparkles" },
      "job-boards":    { label: "Job boards",         icon: "fa-briefcase" },
      search:          { label: "Search providers",   icon: "fa-magnifying-glass" },
      billing:         { label: "Billing",            icon: "fa-credit-card" },
      infrastructure:  { label: "Infrastructure",     icon: "fa-server" }
    }[key] || { label: key, icon: "fa-cube" };
  }

  function formatRelative(iso) {
    if (!iso) return "never";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "never";
    const diff = Math.max(0, Date.now() - t);
    if (diff < 60_000) return Math.floor(diff / 1000) + "s ago";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
    return Math.floor(diff / 86_400_000) + "d ago";
  }

  // ---------- backend call --------------------------------------------

  async function callBackend(body) {
    const auth = window.CBV2 && window.CBV2.auth;
    const cfg = window.CBV2 && window.CBV2.config;
    if (!auth || !cfg) throw new Error("CareerBoost auth/config not loaded.");
    if (!auth.isAuthenticated || !auth.isAuthenticated()) throw new Error("Sign in required.");
    const client = auth.getClient && auth.getClient();
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const res = await client.functions.invoke("admin-credentials", { body: body || {} });
      if (res.error) throw res.error;
      return res.data;
    }
    const token = await auth.getAccessToken();
    const url = cfg.getFunctionsUrl() + "/admin-credentials";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": cfg.getSupabaseAnon()
      },
      body: JSON.stringify(body || {})
    });
    const data = await resp.json();
    if (!resp.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("Status " + resp.status));
    }
    return data;
  }

  async function refreshStatus() {
    state.loading = true;
    state.error = "";
    rerender();
    try {
      const snap = await callBackend({});
      state.snapshot = snap;
      state.snapshotAt = Date.now();
    } catch (err) {
      state.error = (err && err.message) || "Could not load credential status.";
    } finally {
      state.loading = false;
      rerender();
    }
  }

  async function testService(service) {
    state.checking[service] = true;
    rerender();
    try {
      const snap = await callBackend({ check: service });
      if (snap && snap.checks && snap.checks[service]) {
        state.checks[service] = Object.assign({ checkedAt: new Date().toISOString() }, snap.checks[service]);
      }
      // Also refresh the set/not-set status while we're here — sometimes
      // the admin rotated a key and is testing in the same click.
      if (snap && snap.catalog) {
        state.snapshot = snap;
        state.snapshotAt = Date.now();
      }
    } catch (err) {
      state.checks[service] = {
        ok: false,
        status: "network_error",
        message: (err && err.message) || "Check failed.",
        checkedAt: new Date().toISOString()
      };
    } finally {
      state.checking[service] = false;
      rerender();
    }
  }

  async function testAll() {
    const snap = state.snapshot;
    if (!snap || !snap.services) return;
    // Mark every testable service as checking up front for snappy UI.
    const services = Object.keys(snap.services).filter(function (s) {
      const members = (snap.catalog || []).filter(function (m) { return m.service === s; });
      return members.length && members[0].category !== "infrastructure";
    });
    services.forEach(function (s) { state.checking[s] = true; });
    rerender();
    try {
      const result = await callBackend({ checkAll: true });
      if (result && result.checks) {
        const now = new Date().toISOString();
        Object.keys(result.checks).forEach(function (s) {
          state.checks[s] = Object.assign({ checkedAt: now }, result.checks[s]);
        });
      }
      if (result && result.catalog) {
        state.snapshot = result;
        state.snapshotAt = Date.now();
      }
    } catch (err) {
      services.forEach(function (s) {
        state.checks[s] = {
          ok: false,
          status: "network_error",
          message: (err && err.message) || "Check failed.",
          checkedAt: new Date().toISOString()
        };
      });
    } finally {
      services.forEach(function (s) { state.checking[s] = false; });
      rerender();
    }
  }

  function rerender() {
    if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") {
      window.CBV2.renderCurrentRoute();
    }
  }

  // ---------- copy-paste command --------------------------------------

  function rotationCommand(name, projectRef) {
    const ref = projectRef ? (" --project-ref " + projectRef) : "";
    return "npx supabase secrets set " + name + "='paste-your-new-key-here'" + ref;
  }

  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (e) { /* fall through */ }
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  // ---------- chip styling for health check status --------------------

  function healthChip(check) {
    if (!check) {
      return '<span class="cb-creds-chip cb-creds-chip--neutral" title="Not yet tested"><i class="fa-regular fa-circle-question"></i> Untested</span>';
    }
    const tone = (function () {
      switch (check.status) {
        case "ok": return "ok";
        case "rate_limited": return "warn";
        case "unauthorized": return "bad";
        case "quota_exhausted": return "bad";
        case "not_configured": return "neutral";
        case "not_supported": return "neutral";
        default: return "bad";
      }
    })();
    const icon = (function () {
      switch (check.status) {
        case "ok": return "fa-check";
        case "rate_limited": return "fa-gauge-high";
        case "unauthorized": return "fa-lock";
        case "quota_exhausted": return "fa-coins";
        case "not_configured": return "fa-minus";
        case "not_supported": return "fa-minus";
        default: return "fa-triangle-exclamation";
      }
    })();
    const label = (function () {
      switch (check.status) {
        case "ok": return "Reachable" + (check.latencyMs ? " · " + check.latencyMs + "ms" : "");
        case "rate_limited": return "Rate limited";
        case "unauthorized": return "Auth failed";
        case "quota_exhausted": return "Quota exhausted";
        case "not_configured": return "Not configured";
        case "not_supported": return "No health check";
        case "network_error": return "Network error";
        default: return "Error";
      }
    })();
    const title = (check.message || label) +
      (check.httpStatus ? " (HTTP " + check.httpStatus + ")" : "") +
      (check.checkedAt ? " · checked " + formatRelative(check.checkedAt) : "");
    return '<span class="cb-creds-chip cb-creds-chip--' + tone + '" title="' + st(title) + '">' +
      '<i class="fa-solid ' + icon + '"></i> ' + st(label) + '</span>';
  }

  function setChip(isSet) {
    return isSet
      ? '<span class="cb-creds-chip cb-creds-chip--ok" title="Env var is present and non-empty"><i class="fa-solid fa-check"></i> Set</span>'
      : '<span class="cb-creds-chip cb-creds-chip--bad" title="Env var is missing or empty"><i class="fa-solid fa-xmark"></i> Missing</span>';
  }

  // ---------- render ---------------------------------------------------

  function renderHeader(snap) {
    const refLine = snap && snap.projectRef
      ? 'Project ref: <code class="cb-creds-code">' + st(snap.projectRef) + '</code>'
      : '<span style="color:#fbbf24;">Project ref unknown — deploy admin-credentials first.</span>';
    const updated = snap && snap.generatedAt ? formatRelative(snap.generatedAt) : "never";
    return (
      '<article class="admin-panel cb-creds-header">' +
        '<div class="cb-creds-header-row">' +
          '<div>' +
            '<h2 class="cb-creds-h">API credentials</h2>' +
            '<p class="cb-creds-sub">Live status + reachability for every key the app uses. Values never leave Supabase.</p>' +
          '</div>' +
          '<div class="cb-creds-header-actions">' +
            '<button type="button" class="btn-ghost btn-sm" id="cb-creds-test-all">' +
              '<i class="fa-solid fa-wave-pulse"></i> Test all' +
            '</button>' +
            '<button type="button" class="btn-ghost btn-sm" id="cb-creds-refresh">' +
              '<i class="fa-solid fa-rotate"></i> Refresh' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<p class="cb-creds-meta">' + refLine + ' &nbsp;·&nbsp; Last checked: ' + st(updated) + '</p>' +
      '</article>'
    );
  }

  function renderServiceBlock(service, members, projectRef) {
    const allSet = members.every(function (m) { return m.set; });
    const someSet = members.some(function (m) { return m.set; });
    const overallTone = allSet ? "ok" : (someSet ? "warn" : "bad");
    const overallText = allSet ? "Set" : (someSet ? "Partial" : "Missing");
    const overallIcon = allSet ? "fa-check" : (someSet ? "fa-circle-exclamation" : "fa-xmark");

    const isInfra = members[0] && members[0].category === "infrastructure";
    const check = state.checks[service];
    const checking = !!state.checking[service];

    const testBtn = isInfra
      ? '<span class="cb-creds-muted">Managed by Supabase</span>'
      : '<button type="button" class="btn-ghost btn-sm cb-creds-test-btn" data-cb-test-service="' + st(service) + '"' + (checking ? " disabled" : "") + '>' +
          '<i class="fa-solid ' + (checking ? 'fa-circle-notch fa-spin' : 'fa-wave-pulse') + '"></i> ' + (checking ? "Testing…" : "Test") +
        '</button>';

    const keyRows = members.map(function (m) {
      const keyChip = setChip(m.set);
      const copyBtn = isInfra
        ? ""
        : '<button type="button" class="btn-ghost btn-sm cb-creds-copy" data-cb-creds-copy="' + st(m.name) + '" data-cb-creds-ref="' + st(projectRef || "") + '" title="Copy the rotation command for this key">' +
            '<i class="fa-solid fa-copy"></i>' +
          '</button>';
      return (
        '<div class="cb-creds-keyrow">' +
          '<div class="cb-creds-keyrow-main">' +
            '<div class="cb-creds-keyrow-title">' +
              '<i class="fa-solid fa-key cb-creds-keyicon"></i>' +
              '<strong>' + st(m.label) + '</strong>' +
              '<code class="cb-creds-code">' + st(m.name) + '</code>' +
            '</div>' +
            '<p class="cb-creds-keyrow-purpose">' + st(m.purpose) + '</p>' +
          '</div>' +
          '<div class="cb-creds-keyrow-actions">' +
            keyChip +
            copyBtn +
          '</div>' +
        '</div>'
      );
    }).join("");

    return (
      '<article class="admin-panel cb-creds-service">' +
        '<div class="cb-creds-service-head">' +
          '<div class="cb-creds-service-title">' +
            '<h3>' + st(service) + '</h3>' +
            '<span class="cb-creds-chip cb-creds-chip--' + overallTone + '"><i class="fa-solid ' + overallIcon + '"></i> ' + overallText + '</span>' +
            healthChip(check) +
          '</div>' +
          '<div class="cb-creds-service-actions">' +
            testBtn +
          '</div>' +
        '</div>' +
        '<div class="cb-creds-keys">' + keyRows + '</div>' +
      '</article>'
    );
  }

  function renderCategory(catKey, catalog, projectRef) {
    const meta = categoryLabel(catKey);
    const members = catalog.filter(function (m) { return m.category === catKey; });
    if (!members.length) return "";

    const serviceMap = {};
    members.forEach(function (m) {
      if (!serviceMap[m.service]) serviceMap[m.service] = [];
      serviceMap[m.service].push(m);
    });
    const blocks = Object.keys(serviceMap).map(function (svc) {
      return renderServiceBlock(svc, serviceMap[svc], projectRef);
    }).join("");

    return (
      '<section class="cb-creds-category">' +
        '<h3 class="cb-creds-category-title">' +
          '<i class="fa-solid ' + meta.icon + '"></i> ' + st(meta.label) +
        '</h3>' +
        '<div class="cb-creds-category-grid">' + blocks + '</div>' +
      '</section>'
    );
  }

  function render(/* data */) {
    const snap = state.snapshot;

    if (!snap && !state.loading && !state.error) {
      setTimeout(refreshStatus, 0);
    }

    if (state.loading && !snap) {
      return injectStyles() +
        '<article class="admin-panel"><p class="admin-copy"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading credential status…</p></article>';
    }

    if (state.error && !snap) {
      return injectStyles() + (
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Error</span><h2>Could not load credential status</h2></div></div>' +
          '<p class="admin-copy">' + st(state.error) + '</p>' +
          '<p class="admin-copy">Most likely the <code>admin-credentials</code> edge function isn\'t deployed yet. From <code>backend/</code> run:</p>' +
          '<pre class="cb-creds-codeblock">npm run fn:deploy:admin-credentials</pre>' +
          '<button type="button" class="btn-secondary btn-sm" id="cb-creds-refresh"><i class="fa-solid fa-rotate"></i> Retry</button>' +
        '</article>'
      );
    }

    if (!snap) return injectStyles();

    const categories = ["ai", "job-boards", "search", "billing", "infrastructure"];
    const groups = categories.map(function (c) {
      return renderCategory(c, snap.catalog || [], snap.projectRef || "");
    }).join("");

    return injectStyles() + renderHeader(snap) + groups;
  }

  // ---------- styles (one-time inject) --------------------------------
  //
  // Scoped to .cb-creds-* so we don't fight other admin sections. Mounted
  // inline on first render so the section stays self-contained — no need
  // to touch modules.css. Idempotent via the data-cb-creds-styles flag.
  function injectStyles() {
    if (document.querySelector('[data-cb-creds-styles="1"]')) return "";
    return (
      '<style data-cb-creds-styles="1">' +
      '.cb-creds-header { margin-bottom: 18px; }' +
      '.cb-creds-header-row { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }' +
      '.cb-creds-header-actions { display:flex; gap:8px; flex-wrap:wrap; }' +
      '.cb-creds-h { margin:0 0 4px; font-size:18px; }' +
      '.cb-creds-sub { margin:0; color:#94a3b8; font-size:13px; line-height:1.5; }' +
      '.cb-creds-meta { margin:10px 0 0; font-size:12px; color:#64748b; }' +

      '.cb-creds-category { margin-top: 22px; }' +
      '.cb-creds-category-title { display:flex; align-items:center; gap:8px; margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:0.08em; color:#94a3b8; font-weight:600; }' +
      '.cb-creds-category-title i { color:#22e3ff; }' +
      '.cb-creds-category-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(420px, 1fr)); gap:12px; }' +

      '.cb-creds-service { padding:14px 16px !important; }' +
      '.cb-creds-service-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); }' +
      '.cb-creds-service-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }' +
      '.cb-creds-service-title h3 { margin:0; font-size:15px; }' +
      '.cb-creds-service-actions { display:flex; gap:6px; align-items:center; }' +
      '.cb-creds-test-btn { white-space:nowrap; }' +

      '.cb-creds-keys { display:flex; flex-direction:column; gap:8px; }' +
      '.cb-creds-keyrow { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:8px 10px; background:rgba(255,255,255,0.025); border-radius:8px; border:1px solid rgba(255,255,255,0.04); }' +
      '.cb-creds-keyrow-main { flex:1 1 auto; min-width:0; }' +
      '.cb-creds-keyrow-title { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }' +
      '.cb-creds-keyicon { color:#94a3b8; font-size:11px; }' +
      '.cb-creds-keyrow-title strong { font-size:12.5px; }' +
      '.cb-creds-keyrow-purpose { margin:4px 0 0; font-size:11.5px; color:#94a3b8; line-height:1.4; }' +
      '.cb-creds-keyrow-actions { display:flex; align-items:center; gap:6px; flex-shrink:0; }' +

      '.cb-creds-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 8px; font-size:11px; line-height:1.2; border-radius:999px; border:1px solid; white-space:nowrap; font-weight:500; }' +
      '.cb-creds-chip i { font-size:10px; }' +
      '.cb-creds-chip--ok      { color:#86efac; border-color:rgba(74,222,128,0.4);  background:rgba(74,222,128,0.08); }' +
      '.cb-creds-chip--warn    { color:#fcd34d; border-color:rgba(251,191,36,0.42); background:rgba(251,191,36,0.08); }' +
      '.cb-creds-chip--bad     { color:#fda4af; border-color:rgba(239,68,68,0.42);  background:rgba(239,68,68,0.08); }' +
      '.cb-creds-chip--neutral { color:#94a3b8; border-color:rgba(148,163,184,0.32); background:rgba(148,163,184,0.06); }' +

      '.cb-creds-code { font-family: "JetBrains Mono", ui-monospace, monospace; font-size:10.5px; padding:1px 5px; background:rgba(255,255,255,0.06); border-radius:4px; color:#cbd5e1; }' +
      '.cb-creds-codeblock { background:#0a0f1d; padding:10px 12px; border-radius:8px; overflow-x:auto; font-family: "JetBrains Mono", ui-monospace, monospace; font-size:12px; color:#cbd5e1; }' +
      '.cb-creds-muted { font-size:11px; color:#64748b; font-style:italic; }' +

      '.cb-creds-copy { padding:4px 8px !important; }' +
      '</style>'
    );
  }

  // ---------- click handlers (delegated, attach once) ------------------
  document.addEventListener("click", function (e) {
    const refreshBtn = e.target.closest && e.target.closest("#cb-creds-refresh");
    if (refreshBtn) {
      e.preventDefault();
      refreshStatus();
      return;
    }
    const testAllBtn = e.target.closest && e.target.closest("#cb-creds-test-all");
    if (testAllBtn) {
      e.preventDefault();
      testAll();
      return;
    }
    const testBtn = e.target.closest && e.target.closest("[data-cb-test-service]");
    if (testBtn) {
      e.preventDefault();
      const service = testBtn.getAttribute("data-cb-test-service");
      if (service) testService(service);
      return;
    }
    const copyBtn = e.target.closest && e.target.closest("[data-cb-creds-copy]");
    if (copyBtn) {
      e.preventDefault();
      const name = copyBtn.getAttribute("data-cb-creds-copy");
      const ref = copyBtn.getAttribute("data-cb-creds-ref") || "";
      const cmd = rotationCommand(name, ref);
      copyToClipboard(cmd).then(function () {
        if (window.CBV2 && window.CBV2.toast) {
          window.CBV2.toast.success("Command copied. Paste in PowerShell, replace the placeholder, then Test / Refresh.");
        }
      }, function () {
        if (window.CBV2 && window.CBV2.toast) {
          window.CBV2.toast.error("Could not access clipboard. Command:\n\n" + cmd);
        }
      });
    }
  });

  window.CBV2.adminSections["credentials"] = { render: render };
})();
