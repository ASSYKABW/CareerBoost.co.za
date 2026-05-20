// Phase 2.5: admin section — tracked_companies management.
//
// Wired into the admin nav under "Integrations". Lets operators:
//   - View all companies (active + inactive)
//   - Add a new company with a token probe BEFORE saving
//   - Toggle active/inactive inline
//   - Edit slug/name/regions/notes
//   - Delete (with confirm modal)
//   - See last-fetched timestamp + last probe result
//
// All state lives on h.adminTrackedCompaniesRemote so this section
// follows the same lazy-fetch + refresh pattern as the other admin
// surfaces. No new in-flight tracking complexity.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  // ----- state cache (lives on adminHelpers so refresh dispatcher works) ---
  function ensureState() {
    const h = window.CBV2.adminHelpers || (window.CBV2.adminHelpers = {});
    if (!h.adminTrackedCompaniesRemote) {
      h.adminTrackedCompaniesRemote = {
        status: "idle",
        data: null,
        error: "",
        loadedAt: 0,
        filter: "all", // all | active | inactive
        probeResults: {}, // { "ats:token" → { ok, jobsFound, error, at } }
        editing: null,   // company being edited (or {} for new)
        busy: false
      };
    }
    return h.adminTrackedCompaniesRemote;
  }

  // ----- helpers ---------------------------------------------------------
  function st(v) { return (window.CBV2.sanitizeText || String)(v); }

  function callApi(action, payload) {
    const auth = window.CBV2.auth;
    const client = auth && auth.getClient && auth.getClient();
    const body = Object.assign({ action: action }, payload || {});
    if (client && client.functions && typeof client.functions.invoke === "function") {
      return client.functions.invoke("admin-tracked-companies", { body: body })
        .then(function (res) {
          if (res.error) throw res.error;
          if (res.data && res.data.ok === false) throw new Error(res.data.error || "API error");
          return res.data;
        });
    }
    return Promise.reject(new Error("Supabase client unavailable."));
  }

  function fetchList() {
    const state = ensureState();
    if (state.busy) return Promise.resolve();
    state.busy = true;
    state.status = state.data ? "refreshing" : "loading";
    state.error = "";
    window.CBV2.renderCurrentRoute();
    return callApi("list", {})
      .then(function (data) {
        state.data = (data && data.companies) || [];
        state.status = "ready";
        state.loadedAt = Date.now();
      })
      .catch(function (err) {
        state.error = (err && err.message) || "Failed to load companies.";
        state.status = "error";
      })
      .finally(function () {
        state.busy = false;
        window.CBV2.renderCurrentRoute();
      });
  }

  // ----- renderers -------------------------------------------------------

  function renderToolbar(state) {
    const h = window.CBV2.adminHelpers;
    const all = state.data || [];
    const counts = {
      all: all.length,
      active: all.filter(function (c) { return c.active; }).length,
      inactive: all.filter(function (c) { return !c.active; }).length
    };
    const filterChip = function (key, label) {
      const isActive = state.filter === key;
      return '<button type="button" class="btn-ghost btn-sm' + (isActive ? " is-active" : "") + '" data-tc-filter="' + key + '">' +
        st(label) + ' <em>' + counts[key] + '</em></button>';
    };
    const badge = h.renderFreshnessBadge ? h.renderFreshnessBadge(state, "tracked-companies", { ttlMs: 60000 }) : "";
    return (
      '<div class="admin-tc-toolbar">' +
        '<div class="admin-tc-filters">' +
          filterChip("all", "All") +
          filterChip("active", "Active") +
          filterChip("inactive", "Inactive") +
        '</div>' +
        '<div class="admin-tc-toolbar-right">' +
          badge +
          '<button type="button" class="btn-primary btn-sm" data-tc-action="add"><i class="fa-solid fa-plus"></i> Add company</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderProbeBadge(state, company) {
    const key = company.ats + ":" + company.ats_token;
    const probe = state.probeResults[key];
    if (!probe) {
      return '<button type="button" class="btn-ghost btn-sm" data-tc-action="probe" data-tc-id="' + st(company.id) + '" title="Test the ATS endpoint"><i class="fa-solid fa-circle-notch"></i> Test</button>';
    }
    const tone = probe.ok ? "success" : "warning";
    const icon = probe.ok ? "fa-circle-check" : "fa-circle-exclamation";
    const label = probe.ok ? probe.jobsFound + " jobs" : (probe.error || "Failed").slice(0, 40);
    return '<span class="chip ' + tone + '" title="Last probed: ' + new Date(probe.at).toLocaleString() + '"><i class="fa-solid ' + icon + '"></i> ' + st(label) + '</span>' +
      ' <button type="button" class="btn-ghost btn-sm" data-tc-action="probe" data-tc-id="' + st(company.id) + '" title="Re-probe"><i class="fa-solid fa-rotate"></i></button>';
  }

  function renderRow(state, company) {
    const regions = (company.regions || []).join(", ") || "—";
    const lastUpdated = company.updated_at ? new Date(company.updated_at).toLocaleDateString() : "—";
    const tone = company.active ? "green" : "subtle";
    const toggleLabel = company.active ? "Disable" : "Enable";
    return (
      '<div class="admin-tc-row' + (company.active ? "" : " is-inactive") + '">' +
        '<div class="admin-tc-cell admin-tc-cell--name">' +
          '<strong>' + st(company.name) + '</strong>' +
          '<small>' + st(company.slug) + '</small>' +
          (company.notes ? '<em class="admin-tc-notes" title="' + st(company.notes) + '">' + st(String(company.notes).slice(0, 80)) + (company.notes.length > 80 ? "…" : "") + '</em>' : "") +
        '</div>' +
        '<div class="admin-tc-cell"><span class="chip subtle">' + st(company.ats) + '</span><code class="admin-tc-token">' + st(company.ats_token) + '</code></div>' +
        '<div class="admin-tc-cell">' + st(regions) + '</div>' +
        '<div class="admin-tc-cell">' + renderProbeBadge(state, company) + '</div>' +
        '<div class="admin-tc-cell admin-tc-cell--meta"><span class="chip ' + tone + '">' + (company.active ? "ON" : "OFF") + '</span><small>' + st(lastUpdated) + '</small></div>' +
        '<div class="admin-tc-cell admin-tc-cell--actions">' +
          '<button type="button" class="btn-ghost btn-sm" data-tc-action="toggle" data-tc-id="' + st(company.id) + '" data-tc-active="' + (company.active ? "0" : "1") + '">' + toggleLabel + '</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-tc-action="edit" data-tc-id="' + st(company.id) + '"><i class="fa-solid fa-pen"></i></button>' +
          '<button type="button" class="btn-ghost btn-sm admin-tc-danger" data-tc-action="delete" data-tc-id="' + st(company.id) + '" title="Delete permanently"><i class="fa-solid fa-trash"></i></button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTable(state) {
    const all = state.data || [];
    const filtered = all.filter(function (c) {
      if (state.filter === "active") return c.active;
      if (state.filter === "inactive") return !c.active;
      return true;
    });
    if (!filtered.length) {
      return '<p class="admin-copy">No companies in this view. Use "Add company" to track a new ATS feed.</p>';
    }
    return (
      '<div class="admin-tc-table">' +
        '<div class="admin-tc-row admin-tc-head">' +
          '<div class="admin-tc-cell">Company</div>' +
          '<div class="admin-tc-cell">ATS</div>' +
          '<div class="admin-tc-cell">Regions</div>' +
          '<div class="admin-tc-cell">Probe</div>' +
          '<div class="admin-tc-cell">Status</div>' +
          '<div class="admin-tc-cell admin-tc-cell--actions">Actions</div>' +
        '</div>' +
        filtered.map(function (c) { return renderRow(state, c); }).join("") +
      '</div>'
    );
  }

  function renderView() {
    const state = ensureState();
    if (state.status === "idle") {
      // Lazy load on first render; renderCurrentRoute fires again when ready.
      setTimeout(fetchList, 0);
    }
    if (state.status === "loading" && !state.data) {
      return '<section class="admin-panel"><p class="admin-copy">Loading tracked companies…</p></section>';
    }
    if (state.status === "error" && !state.data) {
      return '<section class="admin-panel"><p class="admin-copy admin-error-banner">Failed to load: ' + st(state.error) + ' <button type="button" class="btn-ghost btn-sm" data-admin-refresh="tracked-companies">Retry</button></p></section>';
    }
    return (
      '<section class="admin-panel admin-panel--wide">' +
        '<div class="admin-panel-head">' +
          '<div><span>Integrations</span><h2>Tracked Companies (direct ATS aggregation)</h2></div>' +
        '</div>' +
        '<p class="admin-copy">Each row is a company whose Greenhouse/Lever Job Board feed is pulled by the <code>companies-search</code> edge function on every job search. Active companies contribute jobs in real time. Probe a token before adding to verify it works.</p>' +
        renderToolbar(state) +
        renderTable(state) +
      '</section>'
    );
  }

  // ----- action handlers -------------------------------------------------

  function probeOne(id) {
    const state = ensureState();
    const company = (state.data || []).find(function (c) { return c.id === id; });
    if (!company) return;
    const key = company.ats + ":" + company.ats_token;
    state.probeResults[key] = { ok: false, jobsFound: 0, error: "Probing…", at: Date.now() };
    window.CBV2.renderCurrentRoute();
    callApi("probe", { ats: company.ats, ats_token: company.ats_token })
      .then(function (data) {
        state.probeResults[key] = {
          ok: !!data.ok,
          jobsFound: Number(data.jobsFound) || 0,
          error: data.error || "",
          at: Date.now()
        };
      })
      .catch(function (err) {
        state.probeResults[key] = { ok: false, jobsFound: 0, error: (err && err.message) || "Probe failed", at: Date.now() };
      })
      .finally(function () { window.CBV2.renderCurrentRoute(); });
  }

  async function openEditForm(id) {
    const state = ensureState();
    const modal = window.CBV2.modal;
    if (!modal || typeof modal.prompt !== "function") {
      if (window.CBV2.toast) window.CBV2.toast.error("Modal helper unavailable.");
      return;
    }
    const existing = id ? (state.data || []).find(function (c) { return c.id === id; }) : null;
    const title = existing ? "Edit company" : "Add company";

    // Multi-step prompt sequence keeps the modal helper simple.
    const name = await modal.prompt({
      title: title + " — Name",
      body: "Display name as users will see it (e.g. \"Stripe\").",
      defaultValue: existing ? existing.name : "",
      required: true,
      validate: function (v) { return String(v || "").trim() ? null : "Name required."; }
    });
    if (name == null) return;

    const slug = await modal.prompt({
      title: title + " — Slug",
      body: "Internal identifier, lowercase + hyphens (e.g. \"stripe\"). Used in URLs + logs.",
      defaultValue: existing ? existing.slug : String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      required: true,
      validate: function (v) {
        if (!String(v || "").trim()) return "Slug required.";
        if (!/^[a-z0-9\-]+$/.test(String(v))) return "Lowercase letters, numbers, hyphens only.";
        return null;
      }
    });
    if (slug == null) return;

    const atsOptions = ["greenhouse", "lever", "workable", "smartrecruiters", "ashby"];
    const ats = await modal.prompt({
      title: title + " — ATS",
      body: "Which Applicant Tracking System does this company use? Type one of:\n\n" + atsOptions.join("\n"),
      defaultValue: existing ? existing.ats : "greenhouse",
      required: true,
      validate: function (v) {
        const raw = String(v || "").trim().toLowerCase();
        return atsOptions.indexOf(raw) >= 0 ? null : "Must be one of: " + atsOptions.join(", ");
      }
    });
    if (ats == null) return;

    const ats_token = await modal.prompt({
      title: title + " — ATS Token",
      body: "The company's identifier on the ATS. For Greenhouse, that's the slug in their boards URL (boards.greenhouse.io/STRIPE → token is \"stripe\"). For Lever, it's the company subdomain.",
      defaultValue: existing ? existing.ats_token : "",
      required: true,
      validate: function (v) { return String(v || "").trim() ? null : "Token required."; }
    });
    if (ats_token == null) return;

    const regionsInput = await modal.prompt({
      title: title + " — Regions",
      body: "Comma-separated region tags so search can prioritize. Options: global, africa, europe, north_america, asia_pacific. Use \"global\" if unsure.",
      defaultValue: existing ? (existing.regions || []).join(", ") : "global",
      validate: function () { return null; }
    });
    if (regionsInput == null) return;

    const regions = String(regionsInput || "global").split(",")
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);

    const careers_url = existing ? existing.careers_url : null;
    const notes = existing ? existing.notes : null;

    const payload = {
      company: {
        id: existing ? existing.id : undefined,
        slug: String(slug).trim().toLowerCase(),
        ats: String(ats).trim().toLowerCase(),
        ats_token: String(ats_token).trim(),
        name: String(name).trim(),
        regions: regions,
        careers_url: careers_url,
        notes: notes,
        active: existing ? existing.active : true
      }
    };

    try {
      await callApi("upsert", payload);
      if (window.CBV2.toast) window.CBV2.toast.success((existing ? "Updated " : "Added ") + name);
      fetchList();
    } catch (err) {
      if (window.CBV2.toast) window.CBV2.toast.error((err && err.message) || "Save failed");
    }
  }

  async function toggleOne(id, makeActive) {
    try {
      await callApi("toggle", { id: id, active: makeActive });
      if (window.CBV2.toast) window.CBV2.toast.success(makeActive ? "Enabled" : "Disabled");
      fetchList();
    } catch (err) {
      if (window.CBV2.toast) window.CBV2.toast.error((err && err.message) || "Toggle failed");
    }
  }

  async function deleteOne(id) {
    const state = ensureState();
    const company = (state.data || []).find(function (c) { return c.id === id; });
    if (!company) return;
    const modal = window.CBV2.modal;
    const proceed = modal && modal.confirm
      ? await modal.confirm({
          title: "Delete tracked company?",
          body: 'Permanently remove "' + company.name + '" from the registry. Jobs from this company will stop appearing in search. To temporarily stop fetching, use Disable instead.',
          confirmLabel: "Delete permanently",
          tone: "danger"
        })
      : confirm("Delete " + company.name + " permanently?");
    if (!proceed) return;
    try {
      await callApi("delete", { id: id });
      if (window.CBV2.toast) window.CBV2.toast.success("Deleted " + company.name);
      fetchList();
    } catch (err) {
      if (window.CBV2.toast) window.CBV2.toast.error((err && err.message) || "Delete failed");
    }
  }

  // ----- delegated click handler ------------------------------------------

  function bind() {
    document.addEventListener("click", function (e) {
      const filterBtn = e.target && e.target.closest && e.target.closest("[data-tc-filter]");
      if (filterBtn) {
        const state = ensureState();
        state.filter = filterBtn.getAttribute("data-tc-filter") || "all";
        window.CBV2.renderCurrentRoute();
        return;
      }
      const actionBtn = e.target && e.target.closest && e.target.closest("[data-tc-action]");
      if (!actionBtn) return;
      const action = actionBtn.getAttribute("data-tc-action");
      const id = actionBtn.getAttribute("data-tc-id");
      if (action === "add") return openEditForm(null);
      if (action === "edit" && id) return openEditForm(id);
      if (action === "probe" && id) return probeOne(id);
      if (action === "toggle" && id) {
        const active = actionBtn.getAttribute("data-tc-active") === "1";
        return toggleOne(id, active);
      }
      if (action === "delete" && id) return deleteOne(id);
    });
  }

  // Bind once on script load. Section render is idempotent.
  if (!window.__CB_TC_BOUND) {
    window.__CB_TC_BOUND = true;
    bind();
  }

  window.CBV2.adminSections["tracked-companies"] = {
    render: function (data) { return renderView(); },
    refresh: fetchList
  };
})();
