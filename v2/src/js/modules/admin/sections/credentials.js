// Admin section — "API Credentials".
//
// Status-only view of every Supabase Edge Function secret the app
// depends on. Never shows the secret value (those live in Supabase's
// secret store and never leave the runtime). Instead surfaces:
//
//   - For each service: a "Set" / "Missing" chip.
//   - For each key inside that service: env var name + purpose.
//   - A one-click "Copy rotation command" button that puts the
//     `npx supabase secrets set NAME=...` line on the clipboard, so the
//     admin can paste it into PowerShell with their new key value.
//
// Rotation flow:
//   1. Click "Copy rotation command" next to the key you're rotating.
//   2. In PowerShell, paste, replace ...your-key... with the real value,
//      hit Enter.
//   3. Click "Refresh" in the admin UI to confirm status flipped to "Set".
//
// This file talks to backend/supabase/functions/admin-credentials. The
// edge function is read-only — no values flow into the client.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  // Module state. Refreshed on every section open + when the user hits
  // the Refresh button. Initial render uses lastSnapshot (or empty).
  const state = {
    loading: false,
    error: "",
    lastSnapshot: null,   // { catalog, services, projectRef, generatedAt }
    lastLoadedAt: 0
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

  function formatDateTime(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch (e) { return iso; }
  }

  // ---------- backend call --------------------------------------------

  async function fetchStatus() {
    const auth = window.CBV2 && window.CBV2.auth;
    const cfg = window.CBV2 && window.CBV2.config;
    if (!auth || !cfg) throw new Error("CareerBoost auth/config not loaded.");
    if (!auth.isAuthenticated || !auth.isAuthenticated()) throw new Error("Sign in required.");
    const client = auth.getClient && auth.getClient();
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const res = await client.functions.invoke("admin-credentials", { body: {} });
      if (res.error) throw res.error;
      return res.data;
    }
    // Fallback raw POST (mirrors what other admin sections do).
    const token = await auth.getAccessToken();
    const url = cfg.getFunctionsUrl() + "/admin-credentials";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": cfg.getSupabaseAnon()
      },
      body: "{}"
    });
    const body = await resp.json();
    if (!resp.ok || !body || body.ok === false) {
      throw new Error((body && body.error) || ("Status " + resp.status));
    }
    return body;
  }

  async function refresh() {
    state.loading = true;
    state.error = "";
    rerender();
    try {
      const snap = await fetchStatus();
      state.lastSnapshot = snap;
      state.lastLoadedAt = Date.now();
    } catch (err) {
      state.error = (err && err.message) || "Could not load credential status.";
    } finally {
      state.loading = false;
      rerender();
    }
  }

  function rerender() {
    if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") {
      window.CBV2.renderCurrentRoute();
    }
  }

  // ---------- copy-paste command --------------------------------------

  // Generates the PowerShell-friendly command. Quoted carefully so an
  // accidental special character in the future doesn't break paste.
  // Uses the project ref returned by the edge function (it derives this
  // from SUPABASE_URL at runtime — never hard-coded).
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
    // Fallback for old browsers / non-secure contexts.
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

  // ---------- render ---------------------------------------------------

  function renderHeader(snap) {
    const refLine = snap && snap.projectRef
      ? "Project ref: <code>" + st(snap.projectRef) + "</code>"
      : "Project ref unknown (backend hasn't been deployed yet?)";
    const updated = snap && snap.generatedAt ? formatDateTime(snap.generatedAt) : "—";
    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>API credentials</span><h2>Edge Function secrets</h2></div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button type="button" class="btn-ghost btn-sm" id="cb-creds-refresh">' +
              '<i class="fa-solid fa-rotate"></i> Refresh' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<p class="admin-copy">' +
          'Live status of every secret the app depends on. Values never leave Supabase &mdash; this view only shows whether each key is set. ' +
          'To rotate a key, copy its command, paste it into PowerShell with your new value, then hit Refresh.' +
        '</p>' +
        '<p class="ai-meta">' + refLine + ' &nbsp;&middot;&nbsp; Last checked: ' + st(updated) + '</p>' +
      '</article>'
    );
  }

  function renderServiceCard(serviceName, members, projectRef) {
    const allSet = members.every(function (m) { return m.set; });
    const someSet = members.some(function (m) { return m.set; });
    const tone = allSet ? "green" : (someSet ? "amber" : "warning");
    const chipText = allSet ? "Set" : (someSet ? "Partial" : "Missing");
    const chipIcon = allSet ? "fa-check" : (someSet ? "fa-circle-exclamation" : "fa-triangle-exclamation");

    const rows = members.map(function (m) {
      const memberChip = m.set
        ? '<span class="chip green"><i class="fa-solid fa-check"></i> Set</span>'
        : '<span class="chip warning"><i class="fa-solid fa-xmark"></i> Missing</span>';
      const readOnly = m.category === "infrastructure";
      const cmdBtn = readOnly
        ? '<span class="ai-meta" style="font-size:12px;">Managed by Supabase</span>'
        : '<button type="button" class="btn-secondary btn-sm" data-cb-creds-copy="' + st(m.name) + '" data-cb-creds-ref="' + st(projectRef || "") + '">' +
          '<i class="fa-solid fa-copy"></i> Copy rotation command' +
          '</button>';
      return (
        '<div class="admin-action-card">' +
          '<i class="fa-solid fa-key" style="color:' + (m.set ? "#4ade80" : "#fbbf24") + ';"></i>' +
          '<div>' +
            '<strong>' + st(m.label) + ' &nbsp;<code>' + st(m.name) + '</code></strong>' +
            '<span>' + st(m.purpose) + '</span>' +
            '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
              memberChip + cmdBtn +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    return (
      '<article class="admin-panel">' +
        '<div class="admin-panel-head">' +
          '<div><span>Service</span><h2>' + st(serviceName) + '</h2></div>' +
          '<span class="chip ' + tone + '"><i class="fa-solid ' + chipIcon + '"></i> ' + chipText + '</span>' +
        '</div>' +
        '<div class="admin-action-list">' + rows + '</div>' +
      '</article>'
    );
  }

  function renderCategoryGroup(catKey, catalog, projectRef) {
    const meta = categoryLabel(catKey);
    const members = catalog.filter(function (m) { return m.category === catKey; });
    if (!members.length) return "";

    // Group by service inside the category.
    const serviceMap = {};
    members.forEach(function (m) {
      if (!serviceMap[m.service]) serviceMap[m.service] = [];
      serviceMap[m.service].push(m);
    });
    const cards = Object.keys(serviceMap).map(function (svc) {
      return renderServiceCard(svc, serviceMap[svc], projectRef);
    }).join("");

    return (
      '<section class="admin-stat-grid" style="margin-top:24px;">' +
        '<h3 class="admin-section-title" style="grid-column:1/-1;">' +
          '<i class="fa-solid ' + meta.icon + '"></i> ' + st(meta.label) +
        '</h3>' +
      '</section>' +
      '<section class="admin-grid admin-grid--two">' + cards + '</section>'
    );
  }

  function render(/* data */) {
    const snap = state.lastSnapshot;

    // Kick off a first load on render if we don't have data yet.
    if (!snap && !state.loading && !state.error) {
      setTimeout(refresh, 0);
    }

    if (state.loading && !snap) {
      return (
        '<article class="admin-panel">' +
          '<p class="admin-copy"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading credential status…</p>' +
        '</article>'
      );
    }

    if (state.error && !snap) {
      return (
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Error</span><h2>Could not load credential status</h2></div></div>' +
          '<p class="admin-copy">' + st(state.error) + '</p>' +
          '<p class="admin-copy">' +
            'Most common cause: <code>admin-credentials</code> edge function hasn\'t been deployed yet. From the backend folder run:' +
          '</p>' +
          '<pre style="background:#0a0f1d;padding:10px;border-radius:8px;overflow-x:auto;font-size:12px;">npm run fn:deploy:admin-credentials</pre>' +
          '<button type="button" class="btn-secondary btn-sm" id="cb-creds-refresh"><i class="fa-solid fa-rotate"></i> Retry</button>' +
        '</article>'
      );
    }

    if (!snap) return "";

    const categories = ["ai", "job-boards", "search", "billing", "infrastructure"];
    const groups = categories.map(function (c) {
      return renderCategoryGroup(c, snap.catalog || [], snap.projectRef || "");
    }).join("");

    return renderHeader(snap) + groups;
  }

  // ---------- click handlers (delegated, attach once) ------------------
  document.addEventListener("click", function (e) {
    const refreshBtn = e.target.closest && e.target.closest("#cb-creds-refresh");
    if (refreshBtn) {
      e.preventDefault();
      refresh();
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
          window.CBV2.toast.success("Command copied. Paste in PowerShell, replace the placeholder, then hit Refresh.");
        }
      }, function () {
        if (window.CBV2 && window.CBV2.toast) {
          window.CBV2.toast.error("Could not access clipboard. Copy this manually:\n\n" + cmd);
        }
      });
    }
  });

  window.CBV2.adminSections["credentials"] = { render: render };
})();
