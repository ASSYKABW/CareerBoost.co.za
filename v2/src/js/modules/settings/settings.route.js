(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const viewState = {
    testResults: {},
    diagnostics: {},
    diagnosticsRunning: false,
    diagnosticsLastRunAt: "",
    docs: {
      cvFilter: "all",
      cvQuery: "",
      cvSort: "updated_desc",
      assetQuery: "",
      assetSort: "updated_desc"
    },
    formStatus: {
      jobPreferences: { dirty: false, kind: "idle", text: "" },
      aiPreferences: { dirty: false, kind: "idle", text: "" },
      appearance: { dirty: false, kind: "idle", text: "" },
      applyAssist: { dirty: false, kind: "idle", text: "" }
    },
    saving: false,
    message: ""
  };
  let prefMigrationTried = false;
  const settingsMeta = window.CBV2.settingsMeta || {};
  const SETTINGS_TABS = settingsMeta.TABS || ["overview", "me", "job-preferences", "ai", "documents", "data-privacy", "appearance", "account", "extension", "advanced"];
  const ADMIN_ROLES = settingsMeta.ADMIN_ROLES || ["admin", "owner", "developer"];
  const LEGACY_TAB_ALIASES = settingsMeta.LEGACY_ALIASES || {
    home: "overview",
    profile: "me",
    integrations: "advanced",
    diagnostics: "advanced",
    data: "data-privacy",
    docs: "documents",
    privacy: "data-privacy",
    preferences: "job-preferences",
    "job-search": "job-preferences",
    "job-search-profile": "job-preferences",
    theme: "appearance",
    colors: "appearance"
  };

  function getSt() { return window.CBV2.sanitizeText; }

  // P0: serialize + deep-merge preference writes. Every settings form used to
  // read profile.get().preferences, shallow-assign its own key, and write the
  // whole blob back — so two near-simultaneous saves raced on the same snapshot
  // and the later write reverted the earlier one's change. This queues writes
  // so each reads the freshest profile (the previous update sets profile.get()
  // before it resolves) and deep-merges nested objects instead of replacing.
  let _prefSaveChain = Promise.resolve();
  function deepMergePreferences(base, patch) {
    const out = Object.assign({}, base && typeof base === "object" ? base : {});
    Object.keys(patch || {}).forEach(function (k) {
      const pv = patch[k];
      const bv = out[k];
      if (pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv)) {
        out[k] = deepMergePreferences(bv, pv);
      } else {
        out[k] = pv;
      }
    });
    return out;
  }
  function savePreferencePatch(patch) {
    const run = function () {
      if (!(window.CBV2.profile && typeof window.CBV2.profile.update === "function")) {
        return Promise.resolve(null);
      }
      const current = (window.CBV2.profile.get && window.CBV2.profile.get()) || {};
      const preferences = (current.preferences && typeof current.preferences === "object") ? current.preferences : {};
      return window.CBV2.profile.update({ preferences: deepMergePreferences(preferences, patch) });
    };
    // Chain so concurrent saves serialize; a failed write doesn't break the
    // chain for the next writer.
    const result = _prefSaveChain.then(run, run);
    _prefSaveChain = result.then(function () {}, function () {});
    return result;
  }

  function setFormStatus(key, patch) {
    if (!viewState.formStatus[key]) {
      viewState.formStatus[key] = { dirty: false, kind: "idle", text: "" };
    }
    viewState.formStatus[key] = Object.assign({}, viewState.formStatus[key], patch || {});
  }

  function renderTestChip(id) {
    const r = viewState.testResults[id];
    if (!r) return "";
    const tone = r.ok ? "green" : "rose";
    const testedAt = r.testedAt ? new Date(r.testedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return '<span class="chip ' + tone + '">' + (r.ok ? "OK · " + r.count + " results" : "Failed · " + getSt()(r.error || "unknown")) + (testedAt ? " · " + testedAt : "") + "</span>";
  }

  function suggestDiagnosticFix(id, errorText) {
    const msg = String(errorText || "").toLowerCase();
    if (id === "auth") return "Re-authenticate in a new tab/session, then run diagnostics again.";
    if (id === "db") return "Check RLS on the profiles table and ensure your signed-in user can read at least one row.";
    if (id === "jobs") return "Verify the jobs-search Edge Function deployment and backend provider secrets.";
    if (id === "ai" || id === "aiCritique" || id === "aiTailor") {
      if (msg.indexOf("jwt") >= 0 || msg.indexOf("401") >= 0) return "Session token is likely stale. Sign out/in and retry.";
      return "Check ai-run Edge Function logs and provider credentials in backend environment.";
    }
    return "Review backend logs for this service and retry.";
  }

  function renderDiagRow(id, label, description) {
    const r = viewState.diagnostics[id];
    const st = getSt();
    let status = '<span class="chip">Not run</span>';
    let detail = "";
    if (viewState.diagnosticsRunning && !r) {
      status = '<span class="chip blue"><i class="fa-solid fa-circle-notch fa-spin"></i> Running</span>';
    } else if (r) {
      const tone = r.ok ? "green" : "rose";
      const icon = r.ok ? "fa-check" : "fa-xmark";
      const text = r.ok
        ? "OK · " + (r.latencyMs || 0) + "ms"
        : "Failed";
      status = '<span class="chip ' + tone + '"><i class="fa-solid ' + icon + '"></i> ' + text + "</span>";
      if (!r.ok && r.error) {
        detail =
          '<p class="ai-error" style="margin-top:6px;font-size:12px;">' + st(r.error) + "</p>" +
          '<p class="ai-meta" style="margin-top:4px;"><strong>Suggested fix:</strong> ' + st(suggestDiagnosticFix(id, r.error)) + "</p>";
      } else if (r.ok && r.detail) {
        detail = '<p class="ai-meta" style="margin-top:6px;">' + st(r.detail) + "</p>";
      }
      const copyPayload = st(JSON.stringify({
        check: id,
        ok: !!r.ok,
        latencyMs: r.latencyMs || 0,
        detail: r.detail || "",
        error: r.error || "",
        timestamp: new Date().toISOString()
      }));
      detail += '<button class="btn-ghost btn-sm" type="button" data-copy-diag="' + copyPayload + '" style="margin-top:4px;"><i class="fa-solid fa-copy"></i> Copy details</button>';
    }
    return (
      '<div class="diag-row" style="display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
      '<div><strong>' + st(label) + '</strong><br/><span class="ai-meta">' + st(description) + "</span></div>" +
      status +
      "</div>" +
      detail +
      "</div>"
    );
  }

  function renderDiagnosticsSection() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    const signedIn = window.CBV2.auth && window.CBV2.auth.isAuthenticated();
    if (!backendOn) return "";
    return `
      <section class="card panel-lg">
        <div class="panel-head">
          <h2>Backend diagnostics</h2>
          <span class="chip cyan">${signedIn ? "Signed in" : "Signed out"}</span>
        </div>
        <p class="page-subtitle">
          Run quick health checks against your Supabase backend — AI proxy, jobs aggregator, database, and auth.
        </p>
        ${viewState.diagnosticsLastRunAt ? '<p class="ai-meta">Last run: ' + getSt()(new Date(viewState.diagnosticsLastRunAt).toLocaleString()) + '</p>' : ""}
        <div style="margin:8px 0 12px;">
          ${renderDiagRow("auth", "Authentication", "Validates the current session token is accepted by Supabase Auth.")}
          ${renderDiagRow("db", "Database", "Round-trips a tiny query to the profiles table (RLS must match you).")}
          ${renderDiagRow("ai", "AI (query-parse)", "Calls the ai-run Edge Function and validates its JSON output.")}
          ${renderDiagRow("aiCritique", "AI (resume-critique)", "Calls ai-run for Resume Lab critique and reports provider/model/issue count.")}
          ${renderDiagRow("aiTailor", "AI (tailor-plan)", "Calls ai-run for Tailor Plan and reports provider/model/rewrite count.")}
          ${renderDiagRow("jobs", "Job search aggregator", "Calls the jobs-search Edge Function and counts results.")}
        </div>
        <div class="form-actions">
          <button class="btn-primary" id="run-diagnostics" type="button" ${!signedIn || viewState.diagnosticsRunning ? "disabled" : ""}>
            <i class="fa-solid fa-stethoscope"></i> Run diagnostics
          </button>
          <button class="btn-ghost" id="copy-diagnostics-report" type="button" ${viewState.diagnosticsRunning ? "disabled" : ""}>
            <i class="fa-solid fa-clipboard-list"></i> Copy report
          </button>
          <button class="btn-ghost" id="clear-diagnostics" type="button" ${viewState.diagnosticsRunning ? "disabled" : ""}>
            Clear
          </button>
        </div>
      </section>
    `;
  }

  function renderJobSearchPathSection() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    const signedIn = window.CBV2.auth && window.CBV2.auth.isAuthenticated();
    if (!backendOn || !signedIn) return "";
    const forced =
      window.CBV2.config &&
      typeof window.CBV2.config.isForceClientJobSearch === "function" &&
      window.CBV2.config.isForceClientJobSearch();
    return `
      <section class="card panel-lg">
        <div class="panel-head">
          <h2>Job search path (this tab)</h2>
          <span class="chip ${forced ? "warning" : "cyan"}">${forced ? "Browser feeds" : "CareerBoost Cloud"}</span>
        </div>
        <p class="page-subtitle">
          <strong>Phase 1 — primary path:</strong> when you are signed in with cloud enabled, Job Search normally calls only the
          <code>jobs-search</code> Edge Function (no parallel in-browser calls to the same boards). Use the toggle below only to
          debug keys, CORS, or provider behaviour in your browser — it applies to <em>this tab</em> until you turn it off.
        </p>
        <label class="job-filter" style="display:flex;align-items:flex-start;gap:10px;margin-top:8px;">
          <input type="checkbox" id="force-client-job-search" ${forced ? "checked" : ""} style="margin-top:4px;" />
          <span><strong>Force browser job feeds</strong> — same provider fan-out as guest/local mode for this session tab. Clears the in-memory job cache when changed.</span>
        </label>
      </section>
    `;
  }

  function computeProfileInitials(profile, email) {
    const name = (profile && profile.full_name) ? String(profile.full_name).trim() : "";
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    }
    const e = String(email || "").trim();
    return e ? e.charAt(0).toUpperCase() : "?";
  }

  function renderProfileAvatar(profile, email) {
    const st = getSt();
    const avatarUrl = profile && profile.avatar_url ? profile.avatar_url : "";
    if (avatarUrl) {
      return (
        '<span class="avatar avatar--img profile-avatar-preview" aria-hidden="true">' +
          '<img id="profile-avatar-img" src="' + st(avatarUrl) + '" alt="" referrerpolicy="no-referrer" />' +
        '</span>'
      );
    }
    return (
      '<span class="avatar profile-avatar-preview" aria-hidden="true">' +
        st(computeProfileInitials(profile, email)) +
      '</span>'
    );
  }

  function renderProfileSection() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    if (!backendOn) return "";
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) return "";
    const st = getSt();
    const user = auth.getUser() || {};
    const profile = (window.CBV2.profile && window.CBV2.profile.get()) || null;
    const email = user.email || "";
    const fullName = profile && profile.full_name ? profile.full_name : "";
    const headline = profile && profile.headline ? profile.headline : "";
    const prefs = (profile && profile.preferences && profile.preferences.profile) || {};
    const about = prefs.about ? String(prefs.about) : "";
    const experienceYears = typeof prefs.experienceYears === "number" ? prefs.experienceYears : "";
    const skills = Array.isArray(prefs.skills) ? prefs.skills.join(", ") : "";
    const industries = Array.isArray(prefs.industries) ? prefs.industries.join(", ") : "";
    const links = (prefs.links && typeof prefs.links === "object") ? prefs.links : {};
    const linkedin = links.linkedin ? String(links.linkedin) : "";
    const github = links.github ? String(links.github) : "";
    const portfolio = links.portfolio ? String(links.portfolio) : "";

    return `
      <section class="card panel-lg settings-section" id="profile-section">
        <div class="panel-head">
          <h2>Profile &amp; avatar</h2>
          <span class="chip violet">Syncs across devices</span>
        </div>
        <p class="page-subtitle">
          This is how you appear in the sidebar, cover letters, and interview prep. Add a photo or we'll show your initials.
        </p>

        <div class="profile-card-body">
          <div class="profile-avatar-col">
            ${renderProfileAvatar(profile, email)}
            <p class="profile-avatar-hint">PNG or JPG, square preferred.<br/>We resize to 512&times;512.</p>
          </div>

          <div class="profile-fields">
            <label for="profile-full-name">Full name
              <input id="profile-full-name" type="text" maxlength="120" autocomplete="name"
                     value="${st(fullName)}" placeholder="e.g. Jonathan Doe" />
            </label>
            <label for="profile-headline">Headline
              <input id="profile-headline" type="text" maxlength="160"
                     value="${st(headline)}" placeholder="e.g. Senior React Engineer · Remote · EU" />
            </label>
            <label for="profile-about">About
              <textarea id="profile-about" maxlength="500" rows="4"
                        placeholder="Short summary used across dashboard and AI context.">${st(about)}</textarea>
            </label>
            <label for="profile-experience-years">Years of experience
              <input id="profile-experience-years" type="number" min="0" max="60"
                     value="${st(String(experienceYears))}" placeholder="e.g. 6" />
            </label>
            <label for="profile-skills">Primary skills
              <input id="profile-skills" type="text" maxlength="250"
                     value="${st(skills)}" placeholder="e.g. React, TypeScript, Node.js" />
            </label>
            <label for="profile-industries">Industries
              <input id="profile-industries" type="text" maxlength="250"
                     value="${st(industries)}" placeholder="e.g. SaaS, FinTech, Healthcare" />
            </label>
            <label for="profile-linkedin">LinkedIn URL
              <input id="profile-linkedin" type="url" maxlength="240"
                     value="${st(linkedin)}" placeholder="https://linkedin.com/in/your-profile" />
            </label>
            <label for="profile-github">GitHub URL
              <input id="profile-github" type="url" maxlength="240"
                     value="${st(github)}" placeholder="https://github.com/your-handle" />
            </label>
            <label for="profile-portfolio">Portfolio URL
              <input id="profile-portfolio" type="url" maxlength="240"
                     value="${st(portfolio)}" placeholder="https://yourportfolio.com" />
            </label>

            <div class="avatar-dropzone" id="avatar-dropzone" tabindex="0" role="button"
                 aria-label="Upload avatar — click or drop an image here">
              <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true" style="font-size:22px;color:#7fe7c4;"></i>
              <strong>Upload a new photo</strong>
              <span>Click here or drop an image file (PNG/JPG up to 5&nbsp;MB)</span>
              <input id="avatar-file-input" type="file" accept="image/png,image/jpeg,image/webp" />
            </div>
          </div>
        </div>

        <p class="profile-card-status" id="profile-status" aria-live="polite"></p>

        <div class="profile-card-actions">
          <button class="btn-primary" id="profile-save" type="button">
            <i class="fa-solid fa-floppy-disk"></i> Save changes
          </button>
          ${profile && profile.avatar_url ? `
            <button class="btn-ghost" id="profile-remove-avatar" type="button">
              <i class="fa-solid fa-trash-can"></i> Remove photo
            </button>
          ` : ""}
          <button class="btn-ghost" id="profile-refresh" type="button" title="Re-fetch your profile from the server">
            <i class="fa-solid fa-rotate"></i> Refresh
          </button>
        </div>
      </section>
    `;
  }

  function renderAccountSection() {
    return renderAccountIdentitySection();
  }

  function renderLegacyAccountSection() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    const st = getSt();
    if (!backendOn) {
      return `
        <section class="card panel-lg">
          <div class="panel-head">
            <h2>Account</h2>
            <span class="chip warning">Local mode</span>
          </div>
          <p class="page-subtitle">
            Backend is not configured. The app runs in local-only mode — your
            data lives in this browser only. Follow <code>backend/README.md</code>
            to enable cloud sync, accounts, and AI.
          </p>
        </section>
      `;
    }
    const user = (window.CBV2.auth && window.CBV2.auth.getUser()) || null;
    if (!user) return "";

    const errors = (window.CBV2.syncErrors || []).slice(-3).reverse();
    const errorRows = errors.map(function (e) {
      return '<li><code>' + st(e.label) + '</code> — ' + st(e.error) + '</li>';
    }).join("");

    return `
      <section class="card panel-lg settings-section">
        <div class="panel-head">
          <h2>Account</h2>
          <span class="chip green">Signed in</span>
        </div>
        <div class="pipeline-grid settings-account-grid">
          <div class="pipeline-col settings-account-col">
            <p>Email</p>
            <strong class="settings-account-value settings-account-value--email">${st(user.email || "—")}</strong>
          </div>
          <div class="pipeline-col settings-account-col">
            <p>Provider</p>
            <strong class="settings-account-value">${st((user.app_metadata && user.app_metadata.provider) || "email")}</strong>
          </div>
          <div class="pipeline-col settings-account-col">
            <p>User ID</p>
            <strong class="mono settings-account-value settings-account-value--id">${st((user.id || "").slice(0, 8))}</strong>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn-ghost" id="import-local" type="button">
            <i class="fa-solid fa-cloud-arrow-up"></i> Import local data into cloud
          </button>
          <button class="btn-ghost" id="signout-btn" type="button">
            <i class="fa-solid fa-right-from-bracket"></i> Sign out
          </button>
        </div>
        ${errors.length ? `
          <p class="ai-meta" style="margin-top:12px;"><strong>Recent sync issues</strong></p>
          <ul class="ai-meta">${errorRows}</ul>
        ` : ""}
      </section>
    `;
  }

  // -----------------------------------------------------------------------
  // Apply Assist — Phase 1 settings tab.
  //
  // Stores the data the Greenhouse adapter (Phase 2) will auto-fill into ATS
  // forms: identity, links, work authorization, compensation, preferences,
  // optional EEO. Sits inside profile.preferences.applyAssist (existing JSONB
  // column on public.profiles — no migration needed).
  //
  // The screening-question library section is rendered read-only here in V1.
  // Phase 3 (screening-answer AI skill) will populate it after the user
  // accepts AI suggestions during a real application.
  // -----------------------------------------------------------------------
  function renderApplyAssistSection() {
    const st = getSt();
    const aa = (window.CBV2.applyAssist && typeof window.CBV2.applyAssist.getProfile === "function")
      ? window.CBV2.applyAssist.getProfile()
      : null;
    if (!aa) {
      return '<section class="card panel-lg settings-section"><p class="ai-meta">Apply Assist module not loaded.</p></section>';
    }
    const missing = window.CBV2.applyAssist.missingMinimalFields();
    const ready = missing.length === 0;

    const status = viewState.formStatus.applyAssist || { dirty: false, kind: "idle", text: "" };
    const statusText = status.dirty ? "Unsaved changes." : (status.text || "No recent changes.");
    const statusKind = status.dirty ? "pending" : (status.kind || "idle");

    const identity = aa.identity || {};
    const loc = identity.location || {};
    const links = aa.links || {};
    const auth = aa.workAuth || {};
    const comp = aa.compensation || {};
    const prefs = aa.preferences || {};
    const eeo = aa.eeo || {};
    const screenLib = Array.isArray(aa.screeningAnswers) ? aa.screeningAnswers : [];

    const visaOpts = [
      { v: "",                     label: "Select…" },
      { v: "citizen",              label: "Citizen of authorized country" },
      { v: "permanent_resident",   label: "Permanent resident / green card" },
      { v: "work_visa",            label: "Work visa (no sponsorship needed)" },
      { v: "needs_sponsorship",    label: "Needs sponsorship to work" },
      { v: "other",                label: "Other / prefer not to say" }
    ].map(function (o) {
      const sel = (auth.visaStatus || "") === o.v ? " selected" : "";
      return '<option value="' + st(o.v) + '"' + sel + ">" + st(o.label) + "</option>";
    }).join("");

    const relocOpts = [
      { v: "yes",      label: "Yes, I'll relocate" },
      { v: "no",       label: "No, only local roles" },
      { v: "depends",  label: "Depends on the role" }
    ].map(function (o) {
      const sel = (prefs.relocate || "depends") === o.v ? " selected" : "";
      return '<option value="' + st(o.v) + '"' + sel + ">" + st(o.label) + "</option>";
    }).join("");

    const workModeOpts = [
      { v: "any",     label: "Any" },
      { v: "remote",  label: "Remote" },
      { v: "hybrid",  label: "Hybrid" },
      { v: "onsite",  label: "On-site" }
    ].map(function (o) {
      const sel = (prefs.workMode || "any") === o.v ? " selected" : "";
      return '<option value="' + st(o.v) + '"' + sel + ">" + st(o.label) + "</option>";
    }).join("");

    const missingChip = ready
      ? '<span class="chip green"><i class="fa-solid fa-check"></i> Ready</span>'
      : '<span class="chip warning"><i class="fa-solid fa-triangle-exclamation"></i> Missing: ' + st(missing.slice(0, 3).join(", ")) + (missing.length > 3 ? ", …" : "") + '</span>';

    const screenLibHtml = screenLib.length
      ? '<div class="settings-action-list">' +
        screenLib.slice(0, 20).map(function (row) {
          const q = st(String(row.questionText || row.normalized || "").slice(0, 120));
          const a = st(String(row.answer || "").slice(0, 200));
          const used = row.timesUsed ? " · used " + Number(row.timesUsed) + "×" : "";
          return (
            '<div class="admin-action-card">' +
              '<i class="fa-solid fa-circle-question"></i>' +
              '<div><strong>' + q + '</strong><span>' + a + used + '</span></div>' +
            '</div>'
          );
        }).join("") +
        '</div>'
      : '<p class="ai-meta"><i class="fa-solid fa-circle-info"></i> No saved answers yet. When Apply Assist asks you a screening question, your approved answer is saved here for re-use on future applications.</p>';

    const arr = function (val) {
      if (Array.isArray(val)) return val.join(", ");
      return "";
    };
    const num = function (n) {
      const x = Number(n);
      return Number.isFinite(x) && x > 0 ? String(x) : "";
    };

    return `
      <section class="card panel-lg settings-section">
        <div class="panel-head">
          <h2>Apply Assist profile</h2>
          ${missingChip}
        </div>
        <p class="page-subtitle">
          Fields the browser extension will auto-fill on supported job application forms.
          You always click <strong>Submit</strong> yourself &mdash; Apply Assist never submits on your behalf.
        </p>

        <form id="apply-assist-form" class="form-grid settings-form">

          <fieldset class="full-row">
            <legend><i class="fa-solid fa-id-card"></i> Identity &amp; contact</legend>
            <div class="grid-3">
              <label>Legal first name
                <input id="aa-first-name" type="text" value="${st(identity.legalFirstName || "")}" autocomplete="given-name" />
              </label>
              <label>Legal last name
                <input id="aa-last-name" type="text" value="${st(identity.legalLastName || "")}" autocomplete="family-name" />
              </label>
              <label>Preferred name
                <input id="aa-preferred-name" type="text" value="${st(identity.preferredName || "")}" placeholder="Optional" />
              </label>
            </div>
            <div class="grid-3">
              <label>Email
                <input id="aa-email" type="email" value="${st(identity.email || "")}" autocomplete="email" />
              </label>
              <label>Phone
                <input id="aa-phone" type="tel" value="${st(identity.phone || "")}" autocomplete="tel" placeholder="+1 555 123 4567" />
              </label>
              <label>City
                <input id="aa-city" type="text" value="${st(loc.city || "")}" autocomplete="address-level2" />
              </label>
            </div>
            <div class="grid-3">
              <label>State / region
                <input id="aa-state" type="text" value="${st(loc.state || "")}" autocomplete="address-level1" />
              </label>
              <label>Country
                <input id="aa-country" type="text" value="${st(loc.country || "")}" autocomplete="country" placeholder="e.g. United States" />
              </label>
              <label>Postal / ZIP
                <input id="aa-postal" type="text" value="${st(loc.postal || "")}" autocomplete="postal-code" />
              </label>
            </div>
          </fieldset>

          <fieldset class="full-row">
            <legend><i class="fa-solid fa-link"></i> Professional links</legend>
            <div class="grid-2">
              <label>LinkedIn URL
                <input id="aa-linkedin" type="url" value="${st(links.linkedin || "")}" placeholder="https://www.linkedin.com/in/…" />
              </label>
              <label>GitHub URL
                <input id="aa-github" type="url" value="${st(links.github || "")}" placeholder="https://github.com/…" />
              </label>
              <label>Portfolio URL
                <input id="aa-portfolio" type="url" value="${st(links.portfolio || "")}" placeholder="Optional" />
              </label>
              <label>Personal website
                <input id="aa-website" type="url" value="${st(links.website || "")}" placeholder="Optional" />
              </label>
            </div>
          </fieldset>

          <fieldset class="full-row">
            <legend><i class="fa-solid fa-passport"></i> Work authorization</legend>
            <div class="grid-2">
              <label>Visa / work status
                <select id="aa-visa-status">${visaOpts}</select>
              </label>
              <label>Earliest start date
                <input id="aa-earliest-start" type="date" value="${st(auth.earliestStart || "")}" />
              </label>
              <label>Authorized to work in (countries, comma-separated)
                <input id="aa-auth-countries" type="text" value="${st(arr(auth.countriesAuthorized))}" placeholder="e.g. US, CA, UK" />
              </label>
              <label>Needs sponsorship for (countries)
                <input id="aa-sponsor-needed" type="text" value="${st(arr(auth.needsSponsorshipFor))}" placeholder="Leave blank if none" />
              </label>
              <label>Notice period (days)
                <input id="aa-notice-days" type="number" min="0" max="365" value="${st(num(auth.noticePeriodDays))}" />
              </label>
            </div>
          </fieldset>

          <fieldset class="full-row">
            <legend><i class="fa-solid fa-coins"></i> Compensation expectations</legend>
            <div class="grid-3">
              <label>Target minimum (annual)
                <input id="aa-comp-min" type="number" min="0" step="1000" value="${st(num(comp.targetMin))}" />
              </label>
              <label>Target maximum (annual)
                <input id="aa-comp-max" type="number" min="0" step="1000" value="${st(num(comp.targetMax))}" />
              </label>
              <label>Currency
                <input id="aa-comp-currency" type="text" maxlength="6" value="${st(comp.currency || "USD")}" />
              </label>
            </div>
            <label class="full-row" style="margin-top:8px;">
              <input id="aa-comp-negotiate" type="checkbox" ${comp.openToNegotiate !== false ? "checked" : ""} />
              Open to negotiation
            </label>
          </fieldset>

          <fieldset class="full-row">
            <legend><i class="fa-solid fa-route"></i> Preferences</legend>
            <div class="grid-2">
              <label>Willing to relocate
                <select id="aa-relocate">${relocOpts}</select>
              </label>
              <label>Preferred work mode
                <select id="aa-work-mode">${workModeOpts}</select>
              </label>
              <label>Open to relocate to (cities, comma-separated)
                <input id="aa-reloc-locations" type="text" value="${st(arr(prefs.relocateLocations))}" placeholder="Optional" />
              </label>
              <label>Travel OK (% of time)
                <input id="aa-travel-pct" type="number" min="0" max="100" value="${st(num(prefs.travelOkPercent))}" />
              </label>
            </div>
          </fieldset>

          <details class="settings-advanced full-row">
            <summary><i class="fa-solid fa-circle-info"></i> Optional EEO / demographic answers</summary>
            <p class="ai-meta" style="margin:8px 0;">
              US employers often include an Equal Employment Opportunity section. All fields are optional and only shared when you tick the consent box AND the application form actually asks for them.
            </p>
            <div class="grid-2">
              <label>Gender
                <input id="aa-eeo-gender" type="text" value="${st(eeo.gender || "")}" placeholder="Optional" />
              </label>
              <label>Race / ethnicity
                <input id="aa-eeo-race" type="text" value="${st(eeo.race || "")}" placeholder="Optional" />
              </label>
              <label>Veteran status
                <input id="aa-eeo-veteran" type="text" value="${st(eeo.veteran || "")}" placeholder="Optional" />
              </label>
              <label>Disability status
                <input id="aa-eeo-disability" type="text" value="${st(eeo.disability || "")}" placeholder="Optional" />
              </label>
            </div>
            <label class="full-row" style="margin-top:8px;">
              <input id="aa-eeo-consent" type="checkbox" ${eeo.consentToShare ? "checked" : ""} />
              I consent to sharing the EEO answers above when an ATS form asks for them.
            </label>
          </details>

          <div class="form-actions full-row">
            <button class="btn-primary" id="apply-assist-save" type="submit">
              <i class="fa-solid fa-floppy-disk"></i> Save Apply Assist profile
            </button>
          </div>
        </form>
        <p class="settings-save-state settings-save-state--${statusKind}">${statusText}</p>

        <div class="panel-head" style="margin-top:18px;">
          <h3>Saved screening answers</h3>
          <span class="chip subtle">${screenLib.length} answer${screenLib.length === 1 ? "" : "s"}</span>
        </div>
        ${screenLibHtml}
      </section>
    `;
  }

  function bindApplyAssist() {
    const form = document.getElementById("apply-assist-form");
    if (!form) return;
    const markDirty = function () {
      setFormStatus("applyAssist", { dirty: true, kind: "pending", text: "Unsaved changes." });
      const line = form.parentElement && form.parentElement.querySelector(".settings-save-state");
      if (line) {
        line.textContent = "Unsaved changes.";
        line.classList.remove("settings-save-state--success", "settings-save-state--error", "settings-save-state--idle");
        line.classList.add("settings-save-state--pending");
      }
    };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const val = function (id, fallback) {
        const el = document.getElementById(id);
        return el ? String(el.value || "").trim() : (fallback || "");
      };
      const num = function (id) {
        const el = document.getElementById(id);
        const n = el ? Number(el.value) : 0;
        return Number.isFinite(n) && n >= 0 ? n : 0;
      };
      const checked = function (id) {
        const el = document.getElementById(id);
        return el ? !!el.checked : false;
      };
      const csv = function (id) {
        return val(id, "")
          .split(",")
          .map(function (x) { return x.trim(); })
          .filter(Boolean);
      };

      const next = {
        identity: {
          legalFirstName: val("aa-first-name"),
          legalLastName: val("aa-last-name"),
          preferredName: val("aa-preferred-name"),
          phone: val("aa-phone"),
          email: val("aa-email"),
          location: {
            city: val("aa-city"),
            state: val("aa-state"),
            country: val("aa-country"),
            postal: val("aa-postal")
          }
        },
        links: {
          linkedin: val("aa-linkedin"),
          github: val("aa-github"),
          portfolio: val("aa-portfolio"),
          website: val("aa-website")
        },
        workAuth: {
          visaStatus: val("aa-visa-status"),
          countriesAuthorized: csv("aa-auth-countries"),
          needsSponsorshipFor: csv("aa-sponsor-needed"),
          earliestStart: val("aa-earliest-start"),
          noticePeriodDays: num("aa-notice-days")
        },
        compensation: {
          targetMin: num("aa-comp-min"),
          targetMax: num("aa-comp-max"),
          currency: val("aa-comp-currency", "USD") || "USD",
          openToNegotiate: checked("aa-comp-negotiate")
        },
        preferences: {
          relocate: val("aa-relocate", "depends") || "depends",
          relocateLocations: csv("aa-reloc-locations"),
          workMode: val("aa-work-mode", "any") || "any",
          travelOkPercent: Math.max(0, Math.min(100, num("aa-travel-pct")))
        },
        eeo: {
          gender: val("aa-eeo-gender"),
          race: val("aa-eeo-race"),
          veteran: val("aa-eeo-veteran"),
          disability: val("aa-eeo-disability"),
          consentToShare: checked("aa-eeo-consent")
        },
        // Phase 1 doesn't write to screeningAnswers here — Phase 3 manages
        // that library. Preserve whatever was already saved.
        screeningAnswers: (function () {
          const current = (window.CBV2.applyAssist && window.CBV2.applyAssist.getProfile()) || {};
          return Array.isArray(current.screeningAnswers) ? current.screeningAnswers : [];
        })(),
        updatedAt: new Date().toISOString()
      };

      try {
        if (window.CBV2.profile && typeof window.CBV2.profile.update === "function") {
          const current = (window.CBV2.profile.get && window.CBV2.profile.get()) || {};
          const preferences = (current.preferences && typeof current.preferences === "object") ? current.preferences : {};
          await window.CBV2.profile.update({
            preferences: Object.assign({}, preferences, { applyAssist: next })
          });
        }
        viewState.message = "Apply Assist profile saved.";
        setFormStatus("applyAssist", { dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("Apply Assist profile saved.");
      } catch (err) {
        viewState.message = "Failed to save Apply Assist profile: " + ((err && err.message) || "unknown error");
        setFormStatus("applyAssist", { dirty: false, kind: "error", text: "Save failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("Apply Assist save failed.");
      }
      window.CBV2.renderCurrentRoute();
    });
  }

  function renderExtensionInstallSection() {
    const st = getSt();
    const dataSummary = window.CBV2.store && typeof window.CBV2.store.getSummary === "function"
      ? window.CBV2.store.getSummary() : {};
    const hasCaptures = !!(dataSummary.applications || dataSummary.savedJobs);
    const zipUrl = "./careerboost-extension.zip";
    return `
      <section class="card panel-lg settings-section">
        <div class="panel-head">
          <h2>Job Capture Extension</h2>
          <span class="chip ${hasCaptures ? "green" : "cyan"}">${hasCaptures ? "Active" : "Not installed"}</span>
        </div>
        <p class="page-subtitle">
          Works in <strong>Chrome and Microsoft Edge</strong>. Adds a <strong>Save to CareerBoost</strong> button on LinkedIn, Indeed, Greenhouse, and Lever — so you can add any job to your pipeline without leaving the board.
        </p>

        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;">
          <a class="btn-primary" href="${zipUrl}" download="careerboost-extension.zip">
            <i class="fa-solid fa-download"></i> Download extension (.zip)
          </a>
          <a class="btn-ghost" href="https://www.careerboost.app" target="_blank" rel="noopener">
            <i class="fa-brands fa-chrome"></i> Chrome Web Store (coming soon)
          </a>
        </div>

        <div class="panel-head" style="margin-top:4px;">
          <h3>How to install</h3>
        </div>
        <div class="settings-action-list" style="margin-bottom:24px;">
          <div class="admin-action-card">
            <i class="fa-solid fa-1"></i>
            <div>
              <strong>Download and unzip</strong>
              <span>Click <strong>Download extension (.zip)</strong> above, then extract the zip to a permanent folder on your computer.</span>
            </div>
          </div>
          <div class="admin-action-card">
            <i class="fa-solid fa-2"></i>
            <div>
              <strong>Open your browser's extension page</strong>
              <span>Chrome: <code>chrome://extensions</code> &nbsp;·&nbsp; Edge: <code>edge://extensions</code> — then enable <strong>Developer mode</strong> (toggle, top-right).</span>
            </div>
          </div>
          <div class="admin-action-card">
            <i class="fa-solid fa-3"></i>
            <div>
              <strong>Load unpacked</strong>
              <span>Click <strong>Load unpacked</strong> and select the folder you extracted in step 1. The CareerBoost icon will appear in your toolbar.</span>
            </div>
          </div>
          <div class="admin-action-card">
            <i class="fa-solid fa-4"></i>
            <div>
              <strong>Sign in</strong>
              <span>Click the CareerBoost toolbar icon → <strong>Options</strong>, and sign in with your CareerBoost account to connect.</span>
            </div>
          </div>
          <div class="admin-action-card">
            <i class="fa-solid fa-5"></i>
            <div>
              <strong>Capture a job</strong>
              <span>Open any supported job page and click <strong>Save to CareerBoost</strong>. The job lands in your Pipeline automatically.</span>
            </div>
          </div>
        </div>

        <div class="panel-head" style="margin-top:8px;">
          <h3>Supported job boards</h3>
        </div>
        <div class="admin-table" style="margin-bottom:24px;">
          <div class="admin-table-row admin-table-row--three admin-table-head"><span>Board</span><span>URL pattern</span><span>Extraction</span></div>
          <div class="admin-table-row admin-table-row--three"><span>LinkedIn</span><span>linkedin.com/jobs/*</span><span>JSON-LD → CSS selectors</span></div>
          <div class="admin-table-row admin-table-row--three"><span>Indeed</span><span>indeed.com/viewjob*</span><span>JSON-LD → CSS selectors</span></div>
          <div class="admin-table-row admin-table-row--three"><span>Greenhouse</span><span>boards.greenhouse.io/*</span><span>JSON-LD → CSS selectors</span></div>
          <div class="admin-table-row admin-table-row--three"><span>Lever</span><span>jobs.lever.co/*</span><span>JSON-LD → data-qa selectors</span></div>
        </div>

        <div class="panel-head" style="margin-top:8px;">
          <h3>Status</h3>
        </div>
        <div class="settings-status-grid" style="margin-top:12px;">
          ${renderSettingsStatusCard("fa-puzzle-piece", "Captures recorded", hasCaptures ? "Active" : "None yet", hasCaptures ? "green" : "amber", hasCaptures ? "Jobs have been saved via the extension." : "No captures yet — install the extension and save your first job.", null, null)}
          ${renderSettingsStatusCard("fa-shield-halved", "Credentials", "Stored in browser", "cyan", "Your CareerBoost tokens are saved in browser extension storage — never in a plain cookie.", null, null)}
        </div>
      </section>
    `;
  }

  function renderAccountIdentitySection() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    const st = getSt();
    if (!backendOn) {
      return `
        <section class="card panel-lg settings-section settings-account-panel">
          <div class="panel-head">
            <h2>Account</h2>
            <span class="chip warning">Local mode</span>
          </div>
          <div class="settings-account-summary">
            <span class="settings-account-avatar" aria-hidden="true">
              <i class="fa-solid fa-laptop"></i>
            </span>
            <div class="settings-account-copy">
              <p class="eyebrow">Local workspace</p>
              <strong class="settings-account-email">No cloud account connected</strong>
              <span class="settings-account-meta">Your data is stored in this browser until cloud sync is enabled.</span>
            </div>
          </div>
        </section>
      `;
    }

    const user = (window.CBV2.auth && window.CBV2.auth.getUser()) || null;
    if (!user) return "";
    const provider = (user.app_metadata && user.app_metadata.provider) || "email";
    const shortId = (user.id || "").slice(0, 8) || "local";
    const errors = (window.CBV2.syncErrors || []).slice(-3).reverse();
    const errorRows = errors.map(function (e) {
      return '<li><code>' + st(e.label) + '</code> - ' + st(e.error) + '</li>';
    }).join("");

    return `
      <section class="card panel-lg settings-section settings-account-panel">
        <div class="panel-head">
          <h2>Account</h2>
          <span class="chip green">Signed in</span>
        </div>
        <div class="settings-account-summary">
          <span class="settings-account-avatar" aria-hidden="true">
            <i class="fa-solid fa-user-shield"></i>
          </span>
          <div class="settings-account-copy">
            <p class="eyebrow">Signed in as</p>
            <strong class="settings-account-email">${st(user.email || "No email on account")}</strong>
            <span class="settings-account-meta">
              <span><i class="fa-solid fa-envelope"></i> ${st(provider)}</span>
              <span><i class="fa-solid fa-fingerprint"></i> ${st(shortId)}</span>
            </span>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn-ghost" id="import-local" type="button">
            <i class="fa-solid fa-cloud-arrow-up"></i> Import local data into cloud
          </button>
          <button class="btn-ghost" id="signout-btn" type="button">
            <i class="fa-solid fa-right-from-bracket"></i> Sign out
          </button>
        </div>
        ${errors.length ? `
          <p class="ai-meta" style="margin-top:12px;"><strong>Recent sync issues</strong></p>
          <ul class="ai-meta">${errorRows}</ul>
        ` : ""}
      </section>
    `;
  }

  function renderSavedCvSection() {
    const store = window.CBV2.store;
    if (!store || typeof store.getSavedCVs !== "function") return "";
    const st = getSt();
    const items = store.getSavedCVs();
    const defaultId = (typeof store.getDefaultSavedCVId === "function")
      ? store.getDefaultSavedCVId()
      : "";
    const filter = (viewState.docs && viewState.docs.cvFilter) || "all";
    const query = ((viewState.docs && viewState.docs.cvQuery) || "").trim().toLowerCase();
    const sort = (viewState.docs && viewState.docs.cvSort) || "updated_desc";
    const filteredItems = items.filter(function (cv) {
      const isDefault = cv.id === defaultId;
      if (filter === "default" && !isDefault) return false;
      if (filter === "recent") {
        const ts = cv.updatedAt ? Date.parse(cv.updatedAt) : 0;
        if (!ts || (Date.now() - ts) > (14 * 24 * 60 * 60 * 1000)) return false;
      }
      if (query) {
        const hay = ((cv.name || "") + " " + (cv.source || "") + " " + (cv.baseText || "")).toLowerCase();
        if (hay.indexOf(query) < 0) return false;
      }
      return true;
    }).slice().sort(function (a, b) {
      if (sort === "name_asc") return String(a.name || "").localeCompare(String(b.name || ""));
      if (sort === "name_desc") return String(b.name || "").localeCompare(String(a.name || ""));
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      if (sort === "updated_asc") return ta - tb;
      return tb - ta;
    });
    const rows = filteredItems.map(function (cv) {
      const isDefault = cv.id === defaultId;
      const updated = cv.updatedAt ? new Date(cv.updatedAt).toLocaleString() : "—";
      return (
        '<li class="saved-cv-row" data-cv-id="' + st(cv.id) + '" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));">' +
          '<div style="min-width:0;">' +
            '<strong>' + st(cv.name || "Untitled CV") + '</strong> ' +
            (isDefault ? '<span class="chip green">Default</span>' : '') +
            '<span class="chip subtle">' + st(cv.source || "resume-lab") + '</span>' +
            '<p class="ai-meta" style="margin:4px 0 0;">Updated: ' + st(updated) + "</p>" +
          "</div>" +
          '<div class="form-actions" style="margin:0;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' +
            '<button class="btn-ghost btn-sm" type="button" data-cv-action="use" ' + (isDefault ? "disabled" : "") + '><i class="fa-solid fa-check"></i> Use as default</button>' +
            '<button class="btn-ghost btn-sm" type="button" data-cv-action="download"><i class="fa-solid fa-download"></i> Download</button>' +
            '<a class="btn-ghost btn-sm" href="#/resume"><i class="fa-solid fa-file-lines"></i> Open</a>' +
            '<button class="btn-ghost btn-sm" type="button" data-cv-action="rename"><i class="fa-solid fa-pen"></i> Rename</button>' +
            '<button class="btn-ghost btn-sm" type="button" data-cv-action="delete"><i class="fa-solid fa-trash"></i></button>' +
          "</div>" +
        "</li>"
      );
    }).join("");
    return `
      <section class="card panel-lg settings-section" id="saved-cv-section">
        <div class="panel-head">
          <h2>Reusable CV library</h2>
          <span class="chip cyan">${items.length} saved</span>
        </div>
        <p class="page-subtitle">
          Save polished CV versions from Resume Lab, set one as default, and we will use it automatically for AI match scoring and apply workflows.
        </p>
        ${items.length ? `
          <div class="form-actions" style="margin-top:8px;align-items:center;">
            <label class="ai-meta" for="default-cv-select" style="text-transform:none;letter-spacing:0;">Default CV</label>
            <select id="default-cv-select" style="min-width:260px;">
              ${items.map(function (cv) {
                return '<option value="' + st(cv.id) + '" ' + (cv.id === defaultId ? "selected" : "") + '>' + st(cv.name || "Untitled CV") + "</option>";
              }).join("")}
            </select>
            <select id="cv-filter" style="min-width:140px;">
              <option value="all" ${filter === "all" ? "selected" : ""}>All</option>
              <option value="default" ${filter === "default" ? "selected" : ""}>Default</option>
              <option value="recent" ${filter === "recent" ? "selected" : ""}>Recent (14d)</option>
            </select>
            <select id="cv-sort" style="min-width:170px;">
              <option value="updated_desc" ${sort === "updated_desc" ? "selected" : ""}>Updated (newest)</option>
              <option value="updated_asc" ${sort === "updated_asc" ? "selected" : ""}>Updated (oldest)</option>
              <option value="name_asc" ${sort === "name_asc" ? "selected" : ""}>Name (A-Z)</option>
              <option value="name_desc" ${sort === "name_desc" ? "selected" : ""}>Name (Z-A)</option>
            </select>
            <input id="cv-search" type="text" value="${st((viewState.docs && viewState.docs.cvQuery) || "")}" placeholder="Search CVs..." style="min-width:200px;" />
            <button class="btn-ghost btn-sm" type="button" id="cv-reset-filters"><i class="fa-solid fa-filter-circle-xmark"></i> Reset</button>
            <button class="btn-ghost btn-sm" type="button" id="export-cvs-json"><i class="fa-solid fa-file-code"></i> Export CVs JSON</button>
          </div>
        ` : ""}
        ${items.length
          ? (filteredItems.length
              ? '<ul style="list-style:none;margin:0;padding:0;">' + rows + "</ul>"
              : '<p class="ai-meta">No CVs match your current filter/search.</p>')
          : '<p class="ai-meta">No saved CVs yet. In Resume Lab, click <strong>Save CV</strong> after tailoring to add one here.</p><div class="form-actions" style="margin-top:10px;"><a class="btn-secondary" href="#/resume"><i class="fa-solid fa-file-lines"></i> Open Resume Lab</a></div>'}
      </section>
    `;
  }

  function renderCareerAssetsSection() {
    const store = window.CBV2.store;
    if (!store || typeof store.getCareerAssets !== "function") return "";
    const st = getSt();
    const items = store.getCareerAssets();
    const assetQuery = ((viewState.docs && viewState.docs.assetQuery) || "").trim().toLowerCase();
    const assetSort = (viewState.docs && viewState.docs.assetSort) || "updated_desc";
    const filteredItems = items.filter(function (a) {
      if (!assetQuery) return true;
      const hay = ((a.name || "") + " " + (a.type || "") + " " + (a.text || "") + " " + ((a.tags || []).join(" "))).toLowerCase();
      return hay.indexOf(assetQuery) >= 0;
    }).slice().sort(function (a, b) {
      if (assetSort === "name_asc") return String(a.name || "").localeCompare(String(b.name || ""));
      if (assetSort === "name_desc") return String(b.name || "").localeCompare(String(a.name || ""));
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      if (assetSort === "updated_asc") return ta - tb;
      return tb - ta;
    });
    const rows = filteredItems.map(function (a) {
      const updated = a.updatedAt ? new Date(a.updatedAt).toLocaleString() : "—";
      return (
        '<li class="saved-cv-row" data-asset-id="' + st(a.id) + '" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));">' +
          '<div style="min-width:0;">' +
            '<strong>' + st(a.name || "Untitled asset") + '</strong> ' +
            '<span class="chip subtle">' + st(a.type || "bullet") + "</span>" +
            '<p class="ai-meta" style="margin:4px 0 0;">' + st((a.text || "").slice(0, 180)) + "</p>" +
            '<p class="ai-meta" style="margin:4px 0 0;">Updated: ' + st(updated) + "</p>" +
          "</div>" +
          '<div class="form-actions" style="margin:0;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' +
            '<button class="btn-ghost btn-sm" type="button" data-asset-action="copy"><i class="fa-solid fa-copy"></i> Copy</button>' +
            '<button class="btn-ghost btn-sm" type="button" data-asset-action="rename"><i class="fa-solid fa-pen"></i> Rename</button>' +
            '<button class="btn-ghost btn-sm" type="button" data-asset-action="delete"><i class="fa-solid fa-trash"></i></button>' +
          "</div>" +
        "</li>"
      );
    }).join("");
    return `
      <section class="card panel-lg settings-section" id="career-assets-section">
        <div class="panel-head">
          <h2>Career Asset Vault</h2>
          <span class="chip violet">${items.length} assets</span>
        </div>
        <p class="page-subtitle">
          Reusable bullets and skills captured from Resume Lab. Apply them into new CVs without rewriting from scratch.
        </p>
        ${items.length ? `
          <div class="form-actions" style="margin-top:8px;">
            <input id="asset-search" type="text" value="${st((viewState.docs && viewState.docs.assetQuery) || "")}" placeholder="Search assets..." style="min-width:240px;" />
            <select id="asset-sort" style="min-width:170px;">
              <option value="updated_desc" ${assetSort === "updated_desc" ? "selected" : ""}>Updated (newest)</option>
              <option value="updated_asc" ${assetSort === "updated_asc" ? "selected" : ""}>Updated (oldest)</option>
              <option value="name_asc" ${assetSort === "name_asc" ? "selected" : ""}>Name (A-Z)</option>
              <option value="name_desc" ${assetSort === "name_desc" ? "selected" : ""}>Name (Z-A)</option>
            </select>
            <button class="btn-ghost btn-sm" type="button" id="asset-reset-filters"><i class="fa-solid fa-filter-circle-xmark"></i> Reset</button>
            <button class="btn-ghost btn-sm" type="button" id="export-assets"><i class="fa-solid fa-file-export"></i> Export all assets</button>
            <button class="btn-ghost btn-sm" type="button" id="export-assets-json"><i class="fa-solid fa-file-code"></i> Export assets JSON</button>
          </div>
        ` : ""}
        ${items.length
          ? (filteredItems.length
              ? '<ul style="list-style:none;margin:0;padding:0;">' + rows + "</ul>"
              : '<p class="ai-meta">No assets match your search.</p>')
          : '<p class="ai-meta">No assets saved yet. In Resume Lab, use the bookmark icon on bullets and skills to add assets.</p><div class="form-actions" style="margin-top:10px;"><a class="btn-secondary" href="#/resume"><i class="fa-solid fa-bookmark"></i> Build first asset</a></div>'}
      </section>
    `;
  }

  function computeProfileCompleteness(user, profile, roleProfile) {
    let score = 0;
    if (user && user.email) score += 20;
    if (profile && profile.full_name) score += 25;
    if (profile && profile.headline) score += 20;
    if (profile && profile.avatar_url) score += 15;
    if (roleProfile && Array.isArray(roleProfile.targetTitles) && roleProfile.targetTitles.length) score += 20;
    return Math.max(0, Math.min(100, score));
  }

  function getProfileCompletionTasks(user, profile, roleProfile) {
    const tasks = [];
    if (!(user && user.email)) tasks.push({ id: "account", label: "Sign in to sync your profile.", href: "#/auth" });
    if (!(profile && String(profile.full_name || "").trim())) tasks.push({ id: "name", label: "Add your full name.", href: "#/settings?tab=profile" });
    if (!(profile && String(profile.headline || "").trim())) tasks.push({ id: "headline", label: "Add a professional headline.", href: "#/settings?tab=profile" });
    if (!(profile && String(profile.avatar_url || "").trim())) tasks.push({ id: "avatar", label: "Upload an avatar/photo.", href: "#/settings?tab=profile" });
    if (!(roleProfile && Array.isArray(roleProfile.targetTitles) && roleProfile.targetTitles.length)) {
      tasks.push({ id: "targets", label: "Set target roles in Job Search Profile.", href: "#/settings?tab=job-preferences" });
    }
    return tasks;
  }

  function renderPersonalHero() {
    const st = getSt();
    const auth = window.CBV2.auth;
    const user = (auth && auth.getUser && auth.getUser()) || null;
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const js = (window.CBV2.store && window.CBV2.store.getJobSearchState && window.CBV2.store.getJobSearchState()) || {};
    const roleProfile = js.roleProfile || {};
    const fullName = (profile && profile.full_name) || (user && user.user_metadata && user.user_metadata.full_name) || "";
    const headline = (profile && profile.headline) || "Tell us who you are and what roles you want so your dashboard and AI feel personal.";
    const target = (roleProfile.targetTitles && roleProfile.targetTitles[0]) || "Not set";
    const remote = (js.lastFilters && js.lastFilters.remoteOnly) ? "Remote only" : "Any";
    const region = (js.lastFilters && js.lastFilters.location) || "Global";
    const email = (user && user.email) || "";
    const completeness = computeProfileCompleteness(user, profile, roleProfile);
    const tasks = getProfileCompletionTasks(user, profile, roleProfile);
    const tasksHtml = tasks.length
      ? (
        '<div class="settings-completion-tasks">' +
        '<p class="ai-meta"><strong>Next steps</strong></p>' +
        '<ul class="ai-meta" style="margin:0;padding-left:16px;">' +
        tasks.slice(0, 3).map(function (t) {
          return '<li><a href="' + st(t.href) + '">' + st(t.label) + "</a></li>";
        }).join("") +
        "</ul>" +
        "</div>"
      )
      : '<p class="ai-meta">Great setup. Your profile is fully ready for personalized recommendations.</p>';
    return (
      '<section class="card panel-lg settings-identity-hero">' +
      '<div class="settings-identity-main">' +
      renderProfileAvatar(profile, email) +
      '<div class="settings-identity-copy">' +
      '<p class="eyebrow">Personal profile</p>' +
      '<h2>' + st(fullName || "Your profile") + '</h2>' +
      '<p class="page-subtitle">' + st(headline) + "</p>" +
      '<div class="settings-identity-chips">' +
      '<span class="chip cyan">Target: ' + st(target) + "</span>" +
      '<span class="chip blue">Mode: ' + st(remote) + "</span>" +
      '<span class="chip violet">Region: ' + st(region) + "</span>" +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="settings-identity-completion">' +
      '<p class="ai-meta">Profile completeness</p>' +
      '<strong>' + st(String(completeness)) + '%</strong>' +
      tasksHtml +
      "</div>" +
      "</section>"
    );
  }

  function renderSettingsStatusCard(icon, label, value, tone, body, href, actionLabel) {
    const st = getSt();
    const tag = href ? "a" : "div";
    const hrefAttr = href ? ' href="' + st(href) + '"' : "";
    const action = href && actionLabel
      ? '<span class="settings-status-action">' + st(actionLabel) + ' <i class="fa-solid fa-arrow-right"></i></span>'
      : "";
    return (
      '<' + tag + ' class="settings-status-card"' + hrefAttr + '>' +
        '<span class="settings-status-icon settings-status-icon--' + st(tone || "cyan") + '"><i class="fa-solid ' + st(icon) + '"></i></span>' +
        '<span class="settings-status-body">' +
          '<span>' + st(label) + '</span>' +
          '<strong>' + st(value) + '</strong>' +
          '<small>' + st(body) + '</small>' +
          action +
        '</span>' +
      '</' + tag + '>'
    );
  }

  function renderSetupAction(done, icon, label, body, href) {
    const st = getSt();
    return (
      '<a class="settings-action-row' + (done ? " is-done" : "") + '" href="' + st(href) + '">' +
        '<span class="settings-action-check"><i class="fa-solid ' + (done ? "fa-check" : icon) + '"></i></span>' +
        '<span class="settings-action-copy">' +
          '<strong>' + st(label) + '</strong>' +
          '<small>' + st(body) + '</small>' +
        '</span>' +
        '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>' +
      '</a>'
    );
  }

  function renderSettingsOverviewSection() {
    const st = getSt();
    const auth = window.CBV2.auth;
    const user = (auth && auth.getUser && auth.getUser()) || null;
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const prefRoot = (profile && profile.preferences && typeof profile.preferences === "object") ? profile.preferences : {};
    const aiPrefs = (prefRoot.aiPreferences && typeof prefRoot.aiPreferences === "object") ? prefRoot.aiPreferences : {};
    const store = window.CBV2.store;
    const js = (store && store.getJobSearchState && store.getJobSearchState()) || {};
    const roleProfile = js.roleProfile || {};
    const filters = js.lastFilters || {};
    const sync = getSyncStatusModel();
    const dataSummary = getCurrentDataSummary();
    const completion = computeProfileCompleteness(user, profile, roleProfile);
    const hasTargets = !!(roleProfile.targetTitles && roleProfile.targetTitles.length);
    const hasSearchContext = hasTargets || !!filters.location || !!filters.query;
    const aiPersonalized = aiPrefs.personalizedMode !== false && aiPrefs.consentPersonalizedAi !== false;
    const cloudLabel = sync.healthy ? "Cloud synced" : (sync.signedIn ? "Sync starting" : "Local workspace");
    const cloudBody = sync.healthy
      ? "Your profile and workspace can follow you across devices."
      : sync.signedIn
      ? "CareerBoost is preparing cloud sync for this session."
      : "Sign in when you want your workspace available on another device.";
    const searchValue = hasSearchContext ? "Ready to rank" : "Needs targets";
    const searchBody = hasSearchContext
      ? "Search constraints and scoring use your role profile."
      : "Add roles, location, and skills before searching at scale.";
    const extensionValue = dataSummary.applications || dataSummary.savedJobs ? "Capture active" : "Optional capture";
    const extensionBody = "Save jobs from supported boards into your pipeline. Works in Chrome and Edge.";
    const candidateIntelHtml = renderCandidateIntelligenceSettingsSection();

    return `
      ${renderPersonalHero()}
      ${candidateIntelHtml}
      <section class="card panel-lg settings-section settings-command-center">
        <div class="panel-head">
          <h2>Candidate control center</h2>
          <span class="chip cyan">No technical setup needed</span>
        </div>
        <p class="page-subtitle">
          Keep the personal settings that shape CareerBoost in one place. Job-board connections and service credentials are managed by CareerBoost, so candidates can focus on profile quality, search intent, and privacy.
        </p>
        <div class="settings-status-grid">
          ${renderSettingsStatusCard("fa-magnifying-glass", "Job Search", searchValue, hasSearchContext ? "green" : "cyan", searchBody, "#/settings?tab=job-preferences", "Tune profile")}
          ${renderSettingsStatusCard("fa-wand-magic-sparkles", "AI Personalization", aiPersonalized ? "Personalized" : "Limited context", aiPersonalized ? "violet" : "warning", aiPersonalized ? "AI can use your saved career context when you ask for help." : "Turn on profile context for sharper resume, cover letter, and interview help.", "#/settings?tab=ai", "Review")}
          ${renderSettingsStatusCard("fa-cloud-arrow-up", "Workspace Sync", cloudLabel, sync.healthy ? "green" : "blue", cloudBody, "#/settings?tab=data-privacy", "Privacy")}
          ${renderSettingsStatusCard("fa-puzzle-piece", "Job Capture", extensionValue, "cyan", extensionBody, "#/settings?tab=extension", "Install extension")}
        </div>
      </section>
      <section class="card panel-lg settings-section settings-command-center">
        <div class="panel-head">
          <h2>Recommended setup</h2>
          <span class="chip ${completion >= 80 && hasSearchContext ? "green" : "warning"}">${st(String(Math.round((completion + (hasSearchContext ? 100 : 20) + (aiPersonalized ? 100 : 50)) / 3)))}% ready</span>
        </div>
        <div class="settings-action-list">
          ${renderSetupAction(completion >= 80, "fa-user-pen", "Complete your profile", "Name, headline, and avatar help every generated document feel polished.", "#/settings?tab=profile")}
          ${renderSetupAction(hasSearchContext, "fa-bullseye", "Set your job-search profile", "Target roles, must-have skills, and location constraints guide search quality.", "#/settings?tab=job-preferences")}
          ${renderSetupAction(aiPersonalized, "fa-brain", "Confirm AI personalization", "Choose how much career context AI can use inside Resume Lab, Cover Letters, and Interview Prep.", "#/settings?tab=ai")}
          ${renderSetupAction(sync.signedIn, "fa-shield-halved", "Review privacy and sync", "Export your data, understand local storage, and control destructive actions.", "#/settings?tab=data-privacy")}
        </div>
      </section>
    `;
  }

  // P2: extracted to settings.intel.js. Shim kept here so existing
  // callsites inside renderView() don't need touching — they still
  // call renderCandidateIntelligenceSettingsSection() and we delegate.
  // When settings.route.js eventually shrinks below the audit target,
  // callsites can switch to window.CBV2.settingsIntel.render() directly
  // and this shim can be dropped.
  function renderCandidateIntelligenceSettingsSection() {
    if (window.CBV2.settingsIntel && typeof window.CBV2.settingsIntel.render === "function") {
      return window.CBV2.settingsIntel.render();
    }
    return "";
  }

  function renderAppearanceSection() {
    const st = getSt();
    const themeApi = window.CBV2.theme;
    if (!themeApi || typeof themeApi.get !== "function") {
      return `
        <section class="card panel-lg settings-section settings-appearance-card">
          <div class="panel-head">
            <h2>Appearance</h2>
            <span class="chip cyan">CareerBoost default</span>
          </div>
          <p class="page-subtitle">
            This build is using the official dark CareerBoost theme. Visual preferences will appear here when the theme runtime is enabled.
          </p>
          <div class="settings-appearance-preview">
            <div class="settings-preview-window">
              <div class="settings-preview-topbar"><span></span><span></span><span></span></div>
              <div class="settings-preview-body">
                <div class="settings-preview-sidebar"></div>
                <div class="settings-preview-content">
                  <span class="settings-preview-line settings-preview-line--wide"></span>
                  <span class="settings-preview-line"></span>
                  <span class="settings-preview-button"></span>
                </div>
              </div>
            </div>
            <div class="settings-swatch-panel">
              <p class="eyebrow">Current palette</p>
              <div class="settings-swatch-row">
                <span style="--swatch:#06070f;"></span>
                <span style="--swatch:#0b1220;"></span>
                <span style="--swatch:#22e3ff;"></span>
                <span style="--swatch:#7c6bff;"></span>
                <span style="--swatch:#eaf0ff;"></span>
              </div>
              <p class="ai-meta">Dark, high-contrast, cyan-accented, and consistent with the rest of the workspace.</p>
            </div>
          </div>
        </section>
      `;
    }
    const theme = themeApi.get() || {};
    const colors = (theme.colors && typeof theme.colors === "object") ? theme.colors : {};
    const presets = typeof themeApi.presets === "function" ? themeApi.presets() : [];
    const activePreset = String(theme.presetId || "custom");
    const status = viewState.formStatus.appearance || { dirty: false, kind: "idle", text: "" };
    const statusText = status.dirty ? "Unsaved changes." : (status.text || "Changes apply instantly.");
    const statusKind = status.dirty ? "pending" : (status.kind || "idle");
    function c(key, fallback) {
      return st(String(colors[key] || fallback || ""));
    }
    return `
      <section class="card panel-lg settings-section settings-appearance-card">
        <div class="panel-head">
          <h2>Appearance</h2>
          <span class="chip cyan">Applies instantly</span>
        </div>
        <p class="page-subtitle">Pick a preset and adjust only the key visual colors.</p>
        <form id="appearance-form" class="settings-form">
          <div class="grid-3 full-row settings-theme-simple">
            <label>Theme preset
              <select id="theme-preset">
                ${presets.map(function (p) {
                  return '<option value="' + st(p.id) + '" ' + (p.id === activePreset ? "selected" : "") + '>' + st(p.name || p.id) + "</option>";
                }).join("")}
                <option value="custom" ${activePreset === "custom" ? "selected" : ""}>Custom</option>
              </select>
            </label>
            <label>Highlight color
              <input id="theme-primary" type="color" value="${c("primary", "#22e3ff")}" />
            </label>
            <label>Background color
              <input id="theme-bg" type="color" value="${c("bg", "#06070f")}" />
            </label>
          </div>
          <div class="form-actions full-row">
            <button class="btn-primary" id="appearance-save" type="submit">
              <i class="fa-solid fa-floppy-disk"></i> Save theme
            </button>
            <button class="btn-ghost" id="appearance-reset" type="button">
              <i class="fa-solid fa-rotate-left"></i> Reset to Aurora
            </button>
          </div>
        </form>
        <p class="settings-save-state settings-save-state--${st(statusKind)}">${st(statusText)}</p>
      </section>
    `;
  }

  function renderJobPreferencesSection() {
    const st = getSt();
    const store = window.CBV2.store;
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const prefRoot = (profile && profile.preferences && typeof profile.preferences === "object") ? profile.preferences : {};
    const cloud = (prefRoot.jobPreferences && typeof prefRoot.jobPreferences === "object")
      ? prefRoot.jobPreferences
      : {};
    const js = (store && store.getJobSearchState && store.getJobSearchState()) || {};
    const rp = Object.assign({}, js.roleProfile || {}, cloud.roleProfile || {});
    const filters = js.lastFilters || {};
    const titles = Array.isArray(rp.targetTitles) ? rp.targetTitles.join(", ") : "";
    const skills = Array.isArray(rp.mustHaveSkills) ? rp.mustHaveSkills.join(", ") : "";
    const excludes = Array.isArray(rp.excludeKeywords) ? rp.excludeKeywords.join(", ") : "";
    const location = cloud.location != null ? String(cloud.location || "") : String(filters.location || "");
    const remoteOnly = typeof cloud.remoteOnly === "boolean" ? cloud.remoteOnly : !!filters.remoteOnly;
    const recency = cloud.postedWithinDays != null ? Number(cloud.postedWithinDays) || 0 : Number(filters.postedWithinDays) || 0;
    const seniority = cloud.seniority || rp.seniority || "any";
    const strictMode = typeof cloud.strictMode === "boolean" ? cloud.strictMode : !!rp.strictMode;
    const recencyLabel = recency > 0 ? ("Last " + recency + " days") : "Any time";
    const hasAnyPreference =
      Boolean(titles.trim()) ||
      Boolean(skills.trim()) ||
      Boolean(excludes.trim()) ||
      Boolean(location.trim()) ||
      Boolean(remoteOnly) ||
      recency > 0;
    const isCloudBacked = !!profile;
    const status = viewState.formStatus.jobPreferences || { dirty: false, kind: "idle", text: "" };
    const statusText = status.dirty ? "Unsaved changes." : (status.text || "No recent changes.");
    const statusKind = status.dirty ? "pending" : (status.kind || "idle");
    return `
      <section class="card panel-lg settings-section">
        <div class="panel-head">
          <h2>Job Search Profile</h2>
          <span class="chip ${isCloudBacked ? "green" : "warning"}">${isCloudBacked ? "Cloud synced" : "Local only"}</span>
        </div>
        <p class="page-subtitle">
          These preferences power search constraints, match scoring, and AI tailoring. CareerBoost manages the job-board connections for you, so this screen stays focused on the roles you actually want.
        </p>
        ${!hasAnyPreference
          ? '<div class="ai-notice"><i class="fa-solid fa-lightbulb"></i><div>Your job-search profile is still blank. Add role targets and skills to get better recommendations, stronger AI tailoring, and a more personal dashboard.</div></div>'
          : ""}
        <form id="job-preferences-form" class="form-grid settings-form">
          <label class="full-row">Target roles (comma separated)
            <input id="jp-target-roles" type="text" maxlength="300" value="${st(titles)}" placeholder="Frontend Engineer, Product Manager" />
          </label>
          <label class="full-row">Must-have skills (comma separated)
            <input id="jp-must-have-skills" type="text" maxlength="300" value="${st(skills)}" placeholder="React, TypeScript, SQL" />
          </label>
          <div class="grid-3 full-row">
            <label>Location
              <input id="jp-location" type="text" maxlength="120" value="${st(location)}" placeholder="Remote · EU · Berlin" />
            </label>
            <label>Remote preference
              <select id="jp-remote-mode">
                <option value="any" ${!remoteOnly ? "selected" : ""}>Any</option>
                <option value="remote_only" ${remoteOnly ? "selected" : ""}>Remote only</option>
              </select>
            </label>
            <div class="settings-kv">
              <p>Current summary</p>
              <strong>${st((titles || "No roles") + " · " + (location || "Global") + " · " + recencyLabel)}</strong>
            </div>
          </div>
          <details class="settings-advanced full-row">
            <summary>Show advanced options</summary>
            <div class="grid-3" style="margin-top:10px;">
              <label>Posted window
                <select id="jp-posted-days">
                  <option value="0" ${recency === 0 ? "selected" : ""}>Any time</option>
                  <option value="7" ${recency === 7 ? "selected" : ""}>Last 7 days</option>
                  <option value="14" ${recency === 14 ? "selected" : ""}>Last 14 days</option>
                  <option value="30" ${recency === 30 ? "selected" : ""}>Last 30 days</option>
                </select>
              </label>
              <label>Seniority
                <select id="jp-seniority">
                  <option value="any" ${seniority === "any" ? "selected" : ""}>Any</option>
                  <option value="junior" ${seniority === "junior" ? "selected" : ""}>Junior</option>
                  <option value="mid" ${seniority === "mid" ? "selected" : ""}>Mid</option>
                  <option value="senior" ${seniority === "senior" ? "selected" : ""}>Senior</option>
                  <option value="lead" ${seniority === "lead" ? "selected" : ""}>Lead</option>
                </select>
              </label>
              <label>Strict match mode
                <select id="jp-strict-mode">
                  <option value="off" ${!strictMode ? "selected" : ""}>Off</option>
                  <option value="on" ${strictMode ? "selected" : ""}>On</option>
                </select>
              </label>
            </div>
            <label style="margin-top:10px;">Exclude keywords (comma separated)
              <input id="jp-exclude-keywords" type="text" maxlength="300" value="${st(excludes)}" placeholder="intern, unpaid, relocation-only" />
            </label>
          </details>
          <div class="form-actions full-row">
            <button class="btn-primary" id="jp-save" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save job-search profile</button>
            <a class="btn-secondary" href="#/job-search"><i class="fa-solid fa-magnifying-glass"></i> Open Job Search</a>
          </div>
        </form>
        <p class="settings-save-state settings-save-state--${st(statusKind)}">${st(statusText)} These values also update in-memory Job Search defaults instantly.</p>
      </section>
    `;
  }

  function getMetricNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function renderAiUsageStats(telemetry) {
    const st = getSt();
    const success = getMetricNumber(telemetry && telemetry.success, 0);
    const failed = getMetricNumber(telemetry && telemetry.failed, 0);
    const totalRaw = telemetry && (telemetry.totalEvents != null ? telemetry.totalEvents : telemetry.total);
    const total = getMetricNumber(totalRaw, success + failed);
    const avgLatency = getMetricNumber(telemetry && telemetry.avgLatencyMs, 0);
    const successRate = total ? Math.round((success / total) * 100) : 0;

    return `
      <details class="settings-advanced settings-ai-usage">
        <summary>
          <span><i class="fa-solid fa-chart-line"></i> Usage stats</span>
          <span class="chip cyan">${st(String(total))} calls</span>
        </summary>
        ${telemetry
          ? `<div class="settings-ai-stats-grid">
              <div class="settings-ai-stat">
                <span>Successful</span>
                <strong>${st(String(success))}</strong>
              </div>
              <div class="settings-ai-stat">
                <span>Failed</span>
                <strong>${st(String(failed))}</strong>
              </div>
              <div class="settings-ai-stat">
                <span>Success rate</span>
                <strong>${st(String(successRate))}%</strong>
              </div>
              <div class="settings-ai-stat">
                <span>Avg latency</span>
                <strong>${st(String(avgLatency))}ms</strong>
              </div>
            </div>
            <p class="ai-meta settings-ai-usage-note">Usage stats are local to this browser and help you spot slow or failing AI actions.</p>`
          : '<p class="ai-meta settings-ai-usage-note">Telemetry appears after your first AI action.</p>'}
      </details>
    `;
  }

  function renderAiPersonalizationSection() {
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const prefRoot = (profile && profile.preferences && typeof profile.preferences === "object") ? profile.preferences : {};
    const ai = (prefRoot.aiPreferences && typeof prefRoot.aiPreferences === "object") ? prefRoot.aiPreferences : {};
    const modules = (ai.modules && typeof ai.modules === "object") ? ai.modules : {};
    const personalizedMode = ai.personalizedMode !== false;
    const tone = ai.tone || "professional";
    const responseLength = ai.responseLength || "balanced";
    const localeStyle = ai.localeStyle || "global";
    const consentTelemetry = ai.consentTelemetry !== false;
    const consentPersonalizedAi = ai.consentPersonalizedAi !== false;
    const jobSearchOn = modules.jobSearch !== false;
    const resumeOn = modules.resume !== false;
    const coverLetterOn = modules.coverLetter !== false;
    const interviewOn = modules.interview !== false;
    const telemetry = window.CBAI && window.CBAI.telemetry && typeof window.CBAI.telemetry.getSummary === "function"
      ? window.CBAI.telemetry.getSummary()
      : null;
    const status = viewState.formStatus.aiPreferences || { dirty: false, kind: "idle", text: "" };
    const statusText = status.dirty ? "Unsaved changes." : (status.text || "No recent changes.");
    const statusKind = status.dirty ? "pending" : (status.kind || "idle");
    return `
      <section class="card panel-lg settings-section">
        <div class="panel-head">
          <h2>AI personalization</h2>
          <span class="chip ${personalizedMode ? "green" : "warning"}">${personalizedMode ? "Personalized" : "Stateless"}</span>
        </div>
        <p class="page-subtitle">
          Control how strongly AI adapts to your profile, writing style, and module preferences.
        </p>
        <form id="ai-preferences-form" class="form-grid settings-form settings-ai-form">
          <div class="grid-3 full-row">
            <label>Personalization mode
              <select id="ai-personalized-mode">
                <option value="on" ${personalizedMode ? "selected" : ""}>On (use my profile context)</option>
                <option value="off" ${!personalizedMode ? "selected" : ""}>Off (stateless responses)</option>
              </select>
            </label>
            <label>Tone
              <select id="ai-tone">
                <option value="professional" ${tone === "professional" ? "selected" : ""}>Professional</option>
                <option value="friendly" ${tone === "friendly" ? "selected" : ""}>Friendly</option>
                <option value="confident" ${tone === "confident" ? "selected" : ""}>Confident</option>
                <option value="concise" ${tone === "concise" ? "selected" : ""}>Concise</option>
              </select>
            </label>
            <label>Response length
              <select id="ai-response-length">
                <option value="short" ${responseLength === "short" ? "selected" : ""}>Short</option>
                <option value="balanced" ${responseLength === "balanced" ? "selected" : ""}>Balanced</option>
                <option value="detailed" ${responseLength === "detailed" ? "selected" : ""}>Detailed</option>
              </select>
            </label>
          </div>
          <details class="settings-advanced full-row">
            <summary>Show advanced options</summary>
            <label style="margin-top:10px;">Locale/style
              <select id="ai-locale-style">
                <option value="global" ${localeStyle === "global" ? "selected" : ""}>Global English</option>
                <option value="us" ${localeStyle === "us" ? "selected" : ""}>US English</option>
                <option value="uk" ${localeStyle === "uk" ? "selected" : ""}>UK English</option>
                <option value="eu" ${localeStyle === "eu" ? "selected" : ""}>EU international</option>
              </select>
            </label>
            <fieldset class="full-row" style="margin-top:10px;">
              <legend><i class="fa-solid fa-sliders"></i> Apply personalization to modules</legend>
              <div class="settings-inline-checks">
                <label><input type="checkbox" id="ai-module-job-search" ${jobSearchOn ? "checked" : ""} /> Job Search</label>
                <label><input type="checkbox" id="ai-module-resume" ${resumeOn ? "checked" : ""} /> Resume Lab</label>
                <label><input type="checkbox" id="ai-module-cover-letter" ${coverLetterOn ? "checked" : ""} /> Cover Letter</label>
                <label><input type="checkbox" id="ai-module-interview" ${interviewOn ? "checked" : ""} /> Interview Prep</label>
              </div>
            </fieldset>
            <fieldset class="full-row" style="margin-top:10px;">
              <legend><i class="fa-solid fa-shield-halved"></i> Consent</legend>
              <div class="settings-inline-checks">
                <label><input type="checkbox" id="ai-consent-personalized" ${consentPersonalizedAi ? "checked" : ""} /> Allow profile-based AI personalization</label>
                <label><input type="checkbox" id="ai-consent-telemetry" ${consentTelemetry ? "checked" : ""} /> Allow AI usage telemetry</label>
              </div>
            </fieldset>
          </details>
          <div class="form-actions full-row">
            <button class="btn-primary" id="ai-preferences-save" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save AI preferences</button>
          </div>
        </form>
        <p class="settings-save-state settings-save-state--${statusKind}">${statusText}</p>
        ${renderAiUsageStats(telemetry)}
      </section>
    `;
  }

  function countSnapshotSummary(snapshot) {
    const data = snapshot && typeof snapshot === "object" ? snapshot : {};
    const resume = data.resume && typeof data.resume === "object" ? data.resume : {};
    const cover = data.coverLetter && typeof data.coverLetter === "object" ? data.coverLetter : {};
    const interview = data.interview && typeof data.interview === "object" ? data.interview : {};
    return {
      applications: Array.isArray(data.applications) ? data.applications.length : 0,
      events: Array.isArray(data.events) ? data.events.length : 0,
      savedJobs: Array.isArray(data.savedJobs) ? data.savedJobs.length : 0,
      savedSearches: Array.isArray(data.savedSearches) ? data.savedSearches.length : 0,
      savedCVs: Array.isArray(resume.savedCVs) ? resume.savedCVs.length : 0,
      careerAssets: Array.isArray(resume.careerAssets) ? resume.careerAssets.length : 0,
      coverVariants: Array.isArray(cover.variants) ? cover.variants.length : 0,
      interviewSets: interview.lastSet ? 1 : 0
    };
  }

  function summaryLineText(summary) {
    return (
      summary.applications + " applications, " +
      summary.events + " events, " +
      summary.savedJobs + " saved jobs, " +
      summary.savedSearches + " saved searches, " +
      summary.savedCVs + " CVs, " +
      summary.careerAssets + " assets, " +
      summary.coverVariants + " cover variants, " +
      summary.interviewSets + " interview set"
    );
  }

  function getCurrentDataSummary() {
    const s = window.CBV2.store;
    if (!s) return countSnapshotSummary(null);
    return {
      applications: (s.getApplications && s.getApplications().length) || 0,
      events: (s.getEvents && s.getEvents().length) || 0,
      savedJobs: (s.getSavedJobs && s.getSavedJobs().length) || 0,
      savedSearches: (s.getSavedSearches && s.getSavedSearches().length) || 0,
      savedCVs: (s.getSavedCVs && s.getSavedCVs().length) || 0,
      careerAssets: (s.getCareerAssets && s.getCareerAssets().length) || 0,
      coverVariants: (s.getCoverLetterState && ((s.getCoverLetterState().variants || []).length)) || 0,
      interviewSets: (s.getAll && s.getAll().interview && s.getAll().interview.lastSet) ? 1 : 0
    };
  }

  function getSyncStatusModel() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled && window.CBV2.config.isBackendEnabled();
    const signedIn = window.CBV2.auth && window.CBV2.auth.isAuthenticated && window.CBV2.auth.isAuthenticated();
    const store = window.CBV2.store;
    const remote = !!(store && store.isRemote);
    const hydrated = !!(store && typeof store.isHydrated === "function" && store.isHydrated());
    const errors = (window.CBV2.syncErrors || []).slice(-10);
    const lastError = errors.length ? errors[errors.length - 1] : null;
    const healthy = backendOn && signedIn && remote && hydrated && !errors.length;
    return {
      backendOn: backendOn,
      signedIn: signedIn,
      remote: remote,
      hydrated: hydrated,
      errors: errors,
      lastError: lastError,
      healthy: healthy
    };
  }

  function renderSyncStatusSection() {
    const st = getSt();
    const m = getSyncStatusModel();
    const tone = m.healthy ? "green" : (m.errors.length ? "warning" : "cyan");
    const label = m.healthy
      ? "Healthy"
      : m.errors.length
      ? "Degraded"
      : m.backendOn && m.signedIn
      ? "Starting"
      : "Local mode";
    const lastErrorLine = m.lastError
      ? '<p class="ai-meta"><strong>Last sync issue:</strong> ' + st(m.lastError.label || "sync") + " — " + st(m.lastError.error || "unknown") + "</p>"
      : "";
    return `
      <section class="card panel-lg settings-section">
        <div class="panel-head">
          <h2>Cloud sync status</h2>
          <span class="chip ${tone}">${label}</span>
        </div>
        <div class="pipeline-grid settings-sync-grid">
          <div class="pipeline-col"><p>Backend</p><strong>${m.backendOn ? "On" : "Off"}</strong></div>
          <div class="pipeline-col"><p>Session</p><strong>${m.signedIn ? "Signed in" : "Guest"}</strong></div>
          <div class="pipeline-col"><p>Store mode</p><strong>${m.remote ? "Cloud" : "Local"}</strong></div>
          <div class="pipeline-col"><p>Sync issues</p><strong>${m.errors.length}</strong></div>
        </div>
        <p class="ai-meta" style="margin-top:10px;">
          ${m.remote ? "Your data writes to cloud and syncs across signed-in devices." : "Your data stays in this browser until you enable cloud mode."}
        </p>
        ${lastErrorLine}
      </section>
    `;
  }

  function buildExportBundle() {
    const auth = window.CBV2.auth;
    const user = (auth && auth.getUser && auth.getUser()) || null;
    const profile = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || null;
    const store = window.CBV2.store;
    const all = (store && store.getAll && store.getAll()) || {};
    const summary = getCurrentDataSummary();
    return {
      exportedAt: new Date().toISOString(),
      app: "CareerBoost v2",
      account: user
        ? {
            email: user.email || "",
            userId: user.id || "",
            provider: (user.app_metadata && user.app_metadata.provider) || "email"
          }
        : null,
      profile: profile || null,
      summary: summary,
      data: all
    };
  }

  function confirmWithTypedPhrase(title, details, phrase) {
    const confirmed = window.confirm(title + "\n\n" + details + "\n\nPress OK to continue to verification.");
    if (!confirmed) return false;
    const typed = window.prompt("Type " + phrase + " to confirm.");
    return String(typed || "").trim().toUpperCase() === phrase.toUpperCase();
  }

  function normalizeSettingsTab(raw) {
    if (typeof settingsMeta.normalizeTab === "function") return settingsMeta.normalizeTab(raw);
    const tab = String(raw || "").toLowerCase().trim();
    const mapped = LEGACY_TAB_ALIASES[tab] || tab;
    return SETTINGS_TABS.indexOf(mapped) >= 0 ? mapped : "overview";
  }

  function canAccessAdvancedSettings() {
    const auth = window.CBV2.auth;
    const user = auth && typeof auth.getUser === "function" ? auth.getUser() : null;
    if (!user) return false;
    if (typeof settingsMeta.canAccessAdvanced === "function") return settingsMeta.canAccessAdvanced(user);
    const appMeta = user.app_metadata || {};
    const userMeta = user.user_metadata || {};
    const roleCandidates = []
      .concat(appMeta.role || [])
      .concat(appMeta.roles || [])
      .concat(userMeta.role || [])
      .concat(userMeta.roles || [])
      .map(function (x) { return String(x || "").toLowerCase(); });
    return roleCandidates.some(function (r) { return ADMIN_ROLES.indexOf(r) >= 0; });
  }

  async function maybeBackfillJobPreferences() {
    if (prefMigrationTried) return;
    prefMigrationTried = true;
    const profileApi = window.CBV2.profile;
    const store = window.CBV2.store;
    if (!profileApi || typeof profileApi.get !== "function" || typeof profileApi.update !== "function") return;
    const profile = profileApi.get();
    if (!profile || !profile.preferences || typeof profile.preferences !== "object") return;

    const prefs = profile.preferences;
    if (prefs.jobPreferences && typeof prefs.jobPreferences === "object") return;

    const legacyTargetRole = String(prefs.targetRole || "").trim();
    const legacyLocation = String(prefs.location || "").trim();
    const legacyRemote = String(prefs.remote || "").toLowerCase();
    const js = (store && typeof store.getJobSearchState === "function" && store.getJobSearchState()) || {};
    const jsRole = js.roleProfile || {};
    const jsFilters = js.lastFilters || {};

    const roleProfile = {
      targetTitles: legacyTargetRole ? [legacyTargetRole] : (Array.isArray(jsRole.targetTitles) ? jsRole.targetTitles.slice(0, 8) : []),
      seniority: jsRole.seniority || "any",
      mustHaveSkills: Array.isArray(jsRole.mustHaveSkills) ? jsRole.mustHaveSkills.slice(0, 20) : [],
      excludeKeywords: Array.isArray(jsRole.excludeKeywords) ? jsRole.excludeKeywords.slice(0, 20) : [],
      strictMode: !!jsRole.strictMode
    };
    const jobPreferences = {
      roleProfile: roleProfile,
      location: legacyLocation || String(jsFilters.location || ""),
      remoteOnly: legacyRemote === "remote" || legacyRemote === "remote_only" || !!jsFilters.remoteOnly,
      postedWithinDays: Number(jsFilters.postedWithinDays) || 0,
      seniority: roleProfile.seniority,
      strictMode: roleProfile.strictMode,
      updatedAt: new Date().toISOString(),
      migratedFromLegacy: true
    };
    const hasMeaningfulData =
      roleProfile.targetTitles.length ||
      roleProfile.mustHaveSkills.length ||
      roleProfile.excludeKeywords.length ||
      jobPreferences.location ||
      jobPreferences.remoteOnly ||
      jobPreferences.postedWithinDays > 0;
    if (!hasMeaningfulData) return;

    try {
      await profileApi.update({
        preferences: Object.assign({}, prefs, { jobPreferences: jobPreferences })
      });
    } catch (e) {
      // Non-fatal. Migration can retry on next route mount.
      prefMigrationTried = false;
    }
  }

  function renderSettingsTabNav(activeTab, canAccessAdvanced) {
    const items = (typeof settingsMeta.visibleTabs === "function" ? settingsMeta.visibleTabs(canAccessAdvanced) : [
      { id: "overview", icon: "fa-gauge-high", label: "Overview" },
      { id: "me", icon: "fa-user-pen", label: "Profile" },
      { id: "job-preferences", icon: "fa-bullseye", label: "Job Search Profile" },
      { id: "ai", icon: "fa-wand-magic-sparkles", label: "AI Personalization" },
      { id: "documents", icon: "fa-folder-open", label: "Documents" },
      { id: "data-privacy", icon: "fa-shield-halved", label: "Data & Privacy" },
      { id: "appearance", icon: "fa-palette", label: "Appearance" },
      { id: "account", icon: "fa-id-badge", label: "Account" },
      { id: "extension", icon: "fa-puzzle-piece", label: "Extension" },
      { id: "advanced", icon: "fa-screwdriver-wrench", label: "Advanced" }
    ].filter(function (item) {
      if (canAccessAdvanced) return true;
      return item.id !== "advanced";
    }));
    return `
      <aside class="card settings-studio-nav">
        <p class="eyebrow">Sections</p>
        <nav role="tablist" aria-label="Settings sections">
          ${items.map(function (item) {
            const active = item.id === activeTab;
            return (
              '<a class="settings-nav-link' + (active ? " is-active" : "") + '" role="tab" aria-selected="' + (active ? "true" : "false") + '" aria-current="' + (active ? "page" : "false") + '"' +
              ' href="#/settings?tab=' + item.id + '" data-settings-tab="' + item.id + '">' +
              '<i class="fa-solid ' + item.icon + '" aria-hidden="true"></i>' +
              '<span>' + item.label + "</span>" +
              "</a>"
            );
          }).join("")}
        </nav>
      </aside>
    `;
  }

  function renderTabSummary(activeTab) {
    const copy = settingsMeta.TAB_SUMMARY || {
      overview: "A candidate-friendly command center for setup, sync, and service readiness.",
      me: "Update your profile identity, avatar, and headline.",
      "job-preferences": "Define the role targets and constraints that shape search quality.",
      appearance: "Choose your app theme colors and keep your workspace personal.",
      documents: "Manage your reusable CV versions and career assets.",
      ai: "Control AI personalization behavior and usage consent.",
      "data-privacy": "Control cloud sync, exports, and data safety actions.",
      account: "Review sign-in identity and account-level sync context.",
      extension: "Install the Chrome extension and connect it to your CareerBoost account.",
      advanced: "Technical controls for app operators only."
    };
    const text = typeof settingsMeta.summary === "function" ? settingsMeta.summary(activeTab) : (copy[activeTab] || copy.overview);
    return '<p class="ai-meta settings-tab-summary"><i class="fa-solid fa-circle-info"></i> ' + getSt()(text) + "</p>";
  }

  function renderView() {
    const params = (window.CBV2.getRouteParams && window.CBV2.getRouteParams()) || {};
    const canAccessAdvanced = canAccessAdvancedSettings();
    let activeTab = normalizeSettingsTab(params.tab);
    if (!canAccessAdvanced && activeTab === "advanced") {
      activeTab = "overview";
    }
    // Mirror the visibleTabs gating: apply-profile is hidden unless
    // CBV2.applyAssist.isFeatureEnabled() returns true (flag OR session
    // override) OR the user has admin access. URL deeplinks
    // (#/settings?tab=apply-profile) get the same treatment.
    const _aa = window.CBV2 && window.CBV2.applyAssist;
    const _applyAssistOn = _aa && typeof _aa.isFeatureEnabled === "function" ? _aa.isFeatureEnabled() : false;
    if (!canAccessAdvanced && !_applyAssistOn && activeTab === "apply-profile") {
      activeTab = "overview";
    }
    const showOverview = activeTab === "overview";
    const showMe = activeTab === "me";
    const showJobPreferences = activeTab === "job-preferences";
    const showAppearance = activeTab === "appearance";
    const showDocuments = activeTab === "documents";
    const showAi = activeTab === "ai";
    const showData = activeTab === "data-privacy";
    const showAccount = activeTab === "account";
    const showApplyAssist = activeTab === "apply-profile";
    const showExtension = activeTab === "extension";
    // Phase Billing: dedicated tab for plan + usage + portal.
    const showBilling = activeTab === "billing";
    const showAdvanced = canAccessAdvanced && activeTab === "advanced";

    const keys = showAdvanced ? window.CBV2.store.getApiKeys() : {};
    const st = getSt();
    const telemetry = window.CBAI && window.CBAI.telemetry && typeof window.CBAI.telemetry.getSummary === "function"
      ? window.CBAI.telemetry.getSummary()
      : null;

    const signedIn = window.CBV2.auth && window.CBV2.auth.isAuthenticated();
    const cloudPrimary =
      window.CBV2.config &&
      typeof window.CBV2.config.isCloudJobSearchPrimary === "function" &&
      window.CBV2.config.isCloudJobSearchPrimary();
    const forceClientJobs =
      window.CBV2.config &&
      typeof window.CBV2.config.isForceClientJobSearch === "function" &&
      window.CBV2.config.isForceClientJobSearch();

    return `
      <section class="page-container">
        <header class="settings-page-head">
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Manage your profile, preferences, and account controls.</p>
        </header>

        <section class="settings-studio-layout">
          ${renderSettingsTabNav(activeTab, canAccessAdvanced)}
          <section class="settings-studio-main">
            ${renderTabSummary(activeTab)}
            ${viewState.message ? '<div class="ai-notice"><i class="fa-solid fa-circle-info"></i><div>' + st(viewState.message) + "</div></div>" : ""}

            ${showOverview ? renderSettingsOverviewSection() : ""}

            ${showOverview && window.CBV2.settingsReferral && window.CBV2.settingsReferral.render
              ? window.CBV2.settingsReferral.render()
              : ""}

            ${showMe ? renderPersonalHero() : ""}
            ${showMe ? renderProfileSection() : ""}

            ${showJobPreferences ? renderJobPreferencesSection() : ""}
            ${showAppearance ? renderAppearanceSection() : ""}

            ${showDocuments ? renderSavedCvSection() : ""}
            ${showDocuments ? renderCareerAssetsSection() : ""}

            ${showAi ? renderAiPersonalizationSection() : ""}

            ${showAccount ? renderAccountIdentitySection() : ""}

            ${showApplyAssist ? renderApplyAssistSection() : ""}

            ${showExtension ? renderExtensionInstallSection() : ""}

            ${showBilling && window.CBV2.settingsBilling && window.CBV2.settingsBilling.render
              ? window.CBV2.settingsBilling.render()
              : ""}

            ${showAdvanced ? renderDiagnosticsSection() : ""}
            ${showAdvanced ? renderJobSearchPathSection() : ""}

            ${showAdvanced ? `<section class="card panel-lg settings-section">
          <div class="panel-head">
            <h2>Developer job-board credentials</h2>
            <span class="chip cyan">Operator only</span>
          </div>
          <p class="page-subtitle">
            These controls are hidden from candidates. Use them only to validate provider access for the <strong>jobs-search</strong> Edge Function and local operator tests. Never store passwords for LinkedIn or other sites here.
          </p>
          ${
            cloudPrimary
              ? '<p class="ai-meta">While signed in with cloud enabled, Job Search uses <strong>CareerBoost Cloud</strong> only (no parallel in-browser calls to each board). See <code>docs/JOB_SEARCH_ARCHITECTURE.md</code> for Tier A/B/C.</p>'
              : signedIn && forceClientJobs
              ? '<p class="ai-meta">Diagnostic override is on: Job Search uses <strong>in-browser feeds</strong> for this tab. Keys below still apply to both paths where relevant. Turn off “Force browser job feeds” above to restore cloud-only search.</p>'
              : ""
          }

          <form id="api-keys-form" class="form-grid settings-form">
            <fieldset class="full-row">
              <legend><i class="fa-solid fa-briefcase"></i> Adzuna ${renderTestChip("adzuna")}</legend>
              <p class="ai-meta">Create a free key at <a href="https://developer.adzuna.com" target="_blank" rel="noopener noreferrer">developer.adzuna.com</a>.</p>
              <div class="grid-3">
                <label>App ID
                  <input type="text" id="k-adzuna-id" value="${st(keys.adzunaAppId || "")}" autocomplete="off" />
                </label>
                <label>App Key
                  <input type="password" id="k-adzuna-key" value="${st(keys.adzunaAppKey || "")}" autocomplete="off" />
                </label>
                <label>Country
                  <select id="k-adzuna-country">
                    ${["gb","us","ca","au","de","fr","nl","es","it","pl","za","br","in","sg"].map(function (c) {
                      const sel = (keys.adzunaCountry || "gb") === c ? "selected" : "";
                      return '<option value="' + c + '" ' + sel + '>' + c.toUpperCase() + "</option>";
                    }).join("")}
                  </select>
                </label>
              </div>
              <div class="form-actions">
                <button class="btn-ghost" type="button" data-test="adzuna"><i class="fa-solid fa-vial"></i> Test connection</button>
              </div>
            </fieldset>

            <fieldset class="full-row">
              <legend><i class="fa-solid fa-compass"></i> The Muse ${renderTestChip("muse")}</legend>
              <p class="ai-meta">Optional key (boosts rate limit) at <a href="https://www.themuse.com/developers/api/v2" target="_blank" rel="noopener noreferrer">themuse.com/developers</a>.</p>
              <label>API Key
                <input type="password" id="k-muse" value="${st(keys.museKey || "")}" autocomplete="off" />
              </label>
              <div class="form-actions">
                <button class="btn-ghost" type="button" data-test="muse"><i class="fa-solid fa-vial"></i> Test connection</button>
              </div>
            </fieldset>

            <div class="full-row form-actions">
              <button class="btn-primary" id="save-keys" type="submit">
                <i class="fa-solid fa-floppy-disk"></i> Save keys
              </button>
              <button class="btn-ghost" id="clear-keys" type="button">
                <i class="fa-solid fa-rotate-left"></i> Clear all
              </button>
            </div>
          </form>
        </section>` : ""}

            ${showData ? renderSyncStatusSection() : ""}

            ${showData && window.CBV2.settingsEmailConsent && window.CBV2.settingsEmailConsent.render
              ? window.CBV2.settingsEmailConsent.render()
              : ""}

            ${showData && window.CBV2.settingsPush && window.CBV2.settingsPush.render
              ? window.CBV2.settingsPush.render()
              : ""}

            ${showData ? `<section class="card panel-lg settings-section">
          <div class="panel-head">
            <h2>Local browser data</h2>
            <span class="chip warning">Destructive</span>
          </div>
          <p class="page-subtitle">
            Stored in this browser only. Resetting removes local pipeline/events/resume/cover-letter/interview/bookmark/search data for this device.
          </p>
          <p class="ai-meta">
            Current local snapshot: ${st(summaryLineText(getCurrentDataSummary()))}.
          </p>
          <div class="form-actions">
            <button class="btn-secondary" id="export-all-data" type="button"><i class="fa-solid fa-file-export"></i> Export all data (JSON)</button>
          </div>
          <div class="settings-danger-zone">
            <p class="ai-meta"><strong>Danger zone</strong> · This action permanently removes local browser data for this device.</p>
            <div class="form-actions">
              <button class="btn-ghost" id="reset-data" type="button"><i class="fa-solid fa-triangle-exclamation"></i> Reset all local data</button>
            </div>
          </div>
        </section>` : ""}

            ${showData && (window.CBV2.auth && window.CBV2.auth.isAuthenticated && window.CBV2.auth.isAuthenticated()) ? `<section class="card panel-lg settings-section">
          <div class="panel-head">
            <h2>Cloud account data</h2>
            <span class="chip ${(window.CBV2.store && window.CBV2.store.isRemote) ? "warning" : "cyan"}">${(window.CBV2.store && window.CBV2.store.isRemote) ? "Connected" : "Unavailable"}</span>
          </div>
          <p class="page-subtitle">
            Data stored in your signed-in account and synced across devices when cloud mode is active.
          </p>
          <p class="ai-meta">
            ${(window.CBV2.store && window.CBV2.store.isRemote)
              ? "Use this only when you intentionally want to clear your cloud workspace."
              : "Cloud reset is disabled because this session is not using the remote store."}
          </p>
          <div class="settings-danger-zone">
            <p class="ai-meta"><strong>Danger zone</strong> · Resetting cloud data removes your synced workspace across devices.</p>
            <div class="form-actions">
              ${(window.CBV2.store && window.CBV2.store.isRemote)
                ? '<button class="btn-ghost" id="reset-cloud-data" type="button"><i class="fa-solid fa-cloud-bolt"></i> Reset cloud data</button>'
                : '<button class="btn-ghost" type="button" disabled><i class="fa-solid fa-cloud-slash"></i> Cloud reset unavailable</button>'}
            </div>
          </div>
        </section>` : ""}

            ${showData && (window.CBV2.auth && window.CBV2.auth.isAuthenticated && window.CBV2.auth.isAuthenticated()) ? `<section class="card panel-lg settings-section">
          <div class="panel-head">
            <h2>Delete account</h2>
            <span class="chip warning">Permanent</span>
          </div>
          <p class="page-subtitle">
            Permanently removes your CareerBoost account and every piece of data tied to it &mdash;
            profile, pipeline, applications, resumes, cover letters, interview history, AI usage records, and your sign-in itself.
          </p>
          <p class="ai-meta">
            <i class="fa-solid fa-triangle-exclamation"></i> This cannot be undone.
            Consider <a href="#" id="pre-delete-export">exporting your data</a> first if you want a copy.
            See the <a href="#/privacy">Privacy Policy</a> for what's deleted and what (if anything) is retained for audit compliance.
          </p>
          <div class="settings-danger-zone">
            <p class="ai-meta"><strong>Danger zone</strong> &middot; You'll be asked to type your email to confirm.</p>
            <div class="form-actions">
              <button class="btn-ghost" id="delete-account" type="button" style="color:#fda4af;border-color:rgba(239,68,68,0.4);">
                <i class="fa-solid fa-trash-can"></i> Delete my account permanently
              </button>
            </div>
          </div>
        </section>` : ""}
          </section>
        </section>
      </section>
    `;
  }

  async function testAdzuna() {
    const cfg = window.CBV2.store.getApiKeys();
    if (!cfg.adzunaAppId || !cfg.adzunaAppKey) {
      viewState.testResults.adzuna = { ok: false, error: "Missing App ID or Key", testedAt: new Date().toISOString() };
      window.CBV2.renderCurrentRoute();
      return;
    }
    try {
      const url = "https://api.adzuna.com/v1/api/jobs/" +
        encodeURIComponent(cfg.adzunaCountry || "gb") +
        "/search/1?app_id=" + encodeURIComponent(cfg.adzunaAppId) +
        "&app_key=" + encodeURIComponent(cfg.adzunaAppKey) +
        "&results_per_page=1";
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      viewState.testResults.adzuna = { ok: true, count: data.count || 0, testedAt: new Date().toISOString() };
    } catch (err) {
      viewState.testResults.adzuna = { ok: false, error: err.message || "Request failed", testedAt: new Date().toISOString() };
    }
    window.CBV2.renderCurrentRoute();
  }

  async function diagAuth() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) {
      viewState.diagnostics.auth = { ok: false, error: "Not signed in" };
      return;
    }
    const start = Date.now();
    try {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No access token in session.");
      const client = auth.getClient();
      const { data, error } = await client.auth.getUser();
      if (error || !data || !data.user) throw new Error((error && error.message) || "No user returned");
      viewState.diagnostics.auth = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "User: " + data.user.email
      };
    } catch (err) {
      viewState.diagnostics.auth = { ok: false, latencyMs: Date.now() - start, error: err.message || "auth failed" };
    }
  }

  async function diagDb() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) {
      viewState.diagnostics.db = { ok: false, error: "Not signed in" };
      return;
    }
    const start = Date.now();
    try {
      const client = auth.getClient();
      const { error } = await client.from("profiles").select("user_id").limit(1);
      if (error) throw new Error(error.message);
      viewState.diagnostics.db = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Database reachable and RLS policies allow reads."
      };
    } catch (err) {
      viewState.diagnostics.db = { ok: false, latencyMs: Date.now() - start, error: err.message || "db failed" };
    }
  }

  // Read the response body as text first so we always have something useful
  // to show the user, then try JSON. Supabase platform 401s (invalid JWT) are
  // returned as plain JSON like `{"code":401,"message":"Invalid JWT"}` while
  // our own function errors are `{"ok":false,"error":"..."}`. Handle both.
  async function readResponseDetail(res) {
    let text = "";
    try { text = await res.text(); } catch (e) { /* ignore */ }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    return { text: text, json: json };
  }

  function extractErrorMessage(status, info) {
    if (info.json) {
      if (typeof info.json.error === "string") return info.json.error;
      if (typeof info.json.message === "string") return info.json.message;
      if (typeof info.json.msg === "string") return info.json.msg;
    }
    const snippet = (info.text || "").slice(0, 200);
    return snippet ? "HTTP " + status + " · " + snippet : "HTTP " + status;
  }

  async function callEdgeFunction(path, payload) {
    const auth = window.CBV2.auth;
    const cfg = window.CBV2.config;
    const client = auth.getClient();

    // Preferred: use the SDK's invoke — it attaches both the apikey and the
    // current session token automatically, which avoids stale-token bugs.
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const { data, error } = await client.functions.invoke(path, { body: payload });
      if (error) {
        // error may be a FunctionsHttpError with a .context Response.
        let detail = null;
        try {
          if (error.context && typeof error.context.text === "function") {
            const text = await error.context.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* ignore */ }
            detail = { text: text, json: json };
          }
        } catch (e) { /* ignore */ }
        const status = (error.context && error.context.status) || error.status || 0;
        const msg = detail
          ? extractErrorMessage(status, detail)
          : (error.message || "Edge function error");
        const err = new Error(msg);
        err.status = status;
        throw err;
      }
      return data;
    }

    // Fallback: manual fetch (older SDK).
    const token = await auth.getAccessToken();
    const url = cfg.getFunctionsUrl() + "/" + path;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        apikey: cfg.getSupabaseAnon(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const info = await readResponseDetail(res);
    if (!res.ok || (info.json && info.json.ok === false)) {
      const msg = extractErrorMessage(res.status, info);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return info.json;
  }

  async function diagAi() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) {
      viewState.diagnostics.ai = { ok: false, error: "Not signed in" };
      return;
    }
    const start = Date.now();
    try {
      const body = await callEdgeFunction("ai-run", {
        requestId: "diag_" + Date.now(),
        skill: "query-parse",
        promptVersion: "diag@1",
        input: { query: "senior react engineer remote europe this week" }
      });
      if (!body || body.ok === false) {
        throw new Error((body && body.error) || "AI returned no body.");
      }
      viewState.diagnostics.ai = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Provider: " + (body.provider || body.model || "unknown") + " · returned " + ((body.data && body.data.keywords) || []).length + " keywords."
      };
    } catch (err) {
      viewState.diagnostics.ai = { ok: false, latencyMs: Date.now() - start, error: err.message || "ai failed" };
    }
  }

  async function diagAiCritique() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) {
      viewState.diagnostics.aiCritique = { ok: false, error: "Not signed in" };
      return;
    }
    const start = Date.now();
    try {
      const body = await callEdgeFunction("ai-run", {
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
      if (!body || body.ok === false) {
        throw new Error((body && body.error) || "AI returned no body.");
      }
      const issues = ((body.data && body.data.issues) || []).length;
      viewState.diagnostics.aiCritique = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Provider: " + (body.provider || body.model || "unknown") + " · model: " + (body.model || "unknown") + " · issues: " + issues + "."
      };
    } catch (err) {
      viewState.diagnostics.aiCritique = { ok: false, latencyMs: Date.now() - start, error: err.message || "ai critique failed" };
    }
  }

  async function diagAiTailor() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) {
      viewState.diagnostics.aiTailor = { ok: false, error: "Not signed in" };
      return;
    }
    const start = Date.now();
    try {
      const body = await callEdgeFunction("ai-run", {
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
      if (!body || body.ok === false) {
        throw new Error((body && body.error) || "AI returned no body.");
      }
      const rewrites = ((body.data && body.data.bullets) || []).length;
      viewState.diagnostics.aiTailor = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: "Provider: " + (body.provider || body.model || "unknown") + " · model: " + (body.model || "unknown") + " · rewrites: " + rewrites + "."
      };
    } catch (err) {
      viewState.diagnostics.aiTailor = { ok: false, latencyMs: Date.now() - start, error: err.message || "ai tailor failed" };
    }
  }

  async function diagJobs() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) {
      viewState.diagnostics.jobs = { ok: false, error: "Not signed in" };
      return;
    }
    const start = Date.now();
    try {
      const body = await callEdgeFunction("jobs-search", {
        query: "engineer",
        filters: { remoteOnly: false, postedWithinDays: 0, sort: "newest" }
      });
      if (!body || body.ok === false) {
        throw new Error((body && body.error) || "Jobs returned no body.");
      }
      const sources = (body.sources || []).map(function (s) {
        return s.name + ":" + (s.ok ? s.count : "fail");
      }).join(", ");
      viewState.diagnostics.jobs = {
        ok: true,
        latencyMs: Date.now() - start,
        detail: (body.jobs || []).length + " jobs total · " + sources
      };
    } catch (err) {
      viewState.diagnostics.jobs = { ok: false, latencyMs: Date.now() - start, error: err.message || "jobs failed" };
    }
  }

  async function runDiagnostics() {
    viewState.diagnosticsRunning = true;
    viewState.diagnostics = {};
    window.CBV2.renderCurrentRoute();
    await diagAuth();
    window.CBV2.renderCurrentRoute();
    await diagDb();
    window.CBV2.renderCurrentRoute();
    await diagAi();
    window.CBV2.renderCurrentRoute();
    await diagAiCritique();
    window.CBV2.renderCurrentRoute();
    await diagAiTailor();
    window.CBV2.renderCurrentRoute();
    await diagJobs();
    viewState.diagnosticsLastRunAt = new Date().toISOString();
    viewState.diagnosticsRunning = false;
    window.CBV2.renderCurrentRoute();
  }

  async function testMuse() {
    const cfg = window.CBV2.store.getApiKeys();
    try {
      const auth = cfg.museKey ? "api_key=" + encodeURIComponent(cfg.museKey) + "&" : "";
      const url = "https://www.themuse.com/api/public/jobs?" + auth + "page=0";
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      viewState.testResults.muse = { ok: true, count: (data.results || []).length, testedAt: new Date().toISOString() };
    } catch (err) {
      viewState.testResults.muse = { ok: false, error: err.message || "Request failed", testedAt: new Date().toISOString() };
    }
    window.CBV2.renderCurrentRoute();
  }

  function readForm() {
    return {
      adzunaAppId: (document.getElementById("k-adzuna-id") || {}).value || "",
      adzunaAppKey: (document.getElementById("k-adzuna-key") || {}).value || "",
      adzunaCountry: (document.getElementById("k-adzuna-country") || {}).value || "gb",
      museKey: (document.getElementById("k-muse") || {}).value || ""
    };
  }

  function bindForm() {
    const form = document.getElementById("api-keys-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        window.CBV2.store.setApiKeys(readForm());
        if (window.CBJobs && typeof window.CBJobs.clearCache === "function") {
          window.CBJobs.clearCache();
        }
        viewState.message = "API keys saved. Cached searches cleared — your next search will re-fetch from all providers.";
        window.CBV2.renderCurrentRoute();
      });
    }

    const clear = document.getElementById("clear-keys");
    if (clear) {
      clear.addEventListener("click", function () {
        if (!window.confirm("Clear all API keys?")) return;
        window.CBV2.store.setApiKeys({ adzunaAppId: "", adzunaAppKey: "", adzunaCountry: "gb", museKey: "" });
        viewState.testResults = {};
        viewState.message = "API keys cleared.";
        window.CBV2.renderCurrentRoute();
      });
    }

    if (form) {
      form.querySelectorAll("[data-test]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          window.CBV2.store.setApiKeys(readForm());
          const target = btn.getAttribute("data-test");
          if (target === "adzuna") testAdzuna();
          else if (target === "muse") testMuse();
        });
      });
    }

    const reset = document.getElementById("reset-data");
    if (reset) {
      reset.addEventListener("click", function () {
        const summary = getCurrentDataSummary();
        const ok = confirmWithTypedPhrase(
          "Reset all local data?",
          "This removes: " + summaryLineText(summary) + ".\nAccount and developer connection settings are not changed.",
          "RESET"
        );
        if (!ok) {
          viewState.message = "Reset cancelled.";
          window.CBV2.renderCurrentRoute();
          return;
        }
        window.CBV2.store.reset();
        viewState.message = "Local data reset. Your browser snapshot was cleared and defaults reloaded.";
        window.location.hash = "#/dashboard";
      });
    }
    const exportAll = document.getElementById("export-all-data");
    if (exportAll) {
      exportAll.addEventListener("click", function () {
        const bundle = buildExportBundle();
        const stamp = new Date().toISOString().slice(0, 10);
        if (window.CBV2.downloadText) {
          window.CBV2.downloadText("careerboost-data-export-" + stamp + ".json", JSON.stringify(bundle, null, 2));
          viewState.message = "Data export downloaded.";
          if (window.CBV2.toast) window.CBV2.toast.success("Data export downloaded.");
          window.CBV2.renderCurrentRoute();
        }
      });
    }
    const resetCloud = document.getElementById("reset-cloud-data");
    if (resetCloud) {
      resetCloud.addEventListener("click", function () {
        const summary = getCurrentDataSummary();
        const ok = confirmWithTypedPhrase(
          "Reset all cloud data?",
          "This clears your cloud account data: " + summaryLineText(summary) + ".\nThis action is destructive.",
          "CLOUD RESET"
        );
        if (!ok) {
          viewState.message = "Cloud reset cancelled.";
          window.CBV2.renderCurrentRoute();
          return;
        }
        try {
          if (window.CBV2.store && typeof window.CBV2.store.reset === "function") {
            window.CBV2.store.reset();
            viewState.message = "Cloud data reset initiated.";
            if (window.CBV2.toast) window.CBV2.toast.success("Cloud reset started.");
            window.CBV2.renderCurrentRoute();
          }
        } catch (err) {
          viewState.message = "Cloud reset failed: " + ((err && err.message) || "unknown error");
          if (window.CBV2.toast) window.CBV2.toast.error("Cloud reset failed.");
          window.CBV2.renderCurrentRoute();
        }
      });
    }

    const preDeleteExport = document.getElementById("pre-delete-export");
    if (preDeleteExport) {
      preDeleteExport.addEventListener("click", function (e) {
        e.preventDefault();
        const btn = document.getElementById("export-all-data");
        if (btn) btn.click();
      });
    }

    const deleteAccountBtn = document.getElementById("delete-account");
    if (deleteAccountBtn) {
      deleteAccountBtn.addEventListener("click", async function () {
        const user = (window.CBV2.auth && window.CBV2.auth.getUser && window.CBV2.auth.getUser()) || null;
        const email = (user && user.email) || "";
        if (!email) {
          if (window.CBV2.toast) window.CBV2.toast.error("Can't read your account email. Please sign in again.");
          return;
        }
        // Day 4.4 — three-stage confirm + soft-delete window:
        //   1. Explain the grace period in plain prose
        //   2. Require typing "DELETE" exactly (atomic, language-neutral)
        //   3. Call delete-account in soft mode (default) → server sets
        //      pending_deletion_at = now + 7 days. Account stays usable
        //      during the window; a banner reminds the user to cancel
        //      if they change their mind.
        // For users who genuinely want immediate purge (GDPR, etc.) we
        // could add a "Delete immediately" checkbox in stage 1, but for
        // now the soft path is the only UI affordance.
        const modal = window.CBV2 && window.CBV2.modal;
        let proceed = false;
        if (modal && typeof modal.confirm === "function") {
          proceed = await modal.confirm({
            title: "Schedule account deletion?",
            body:
              "Your account will be scheduled for deletion in 7 days. During the grace " +
              "window you can keep using CareerBoost normally — and a banner will offer " +
              "a one-click Restore button. After 7 days every trace of your data is " +
              "removed: profile, pipeline, applications, resumes, cover letters, " +
              "interview history, AI usage records, and your sign-in itself. " +
              "Restoring after 7 days is impossible.",
            confirmLabel: "Continue",
            tone: "danger"
          });
        } else {
          proceed = window.confirm(
            "Schedule account deletion in 7 days? You can cancel anytime during the grace window."
          );
        }
        if (!proceed) return;

        let typed;
        if (modal && typeof modal.prompt === "function") {
          typed = await modal.prompt({
            title: "Type DELETE to confirm",
            body: 'Type the word <strong>DELETE</strong> (uppercase) to schedule deletion of <strong>' +
              email + '</strong>.',
            placeholder: "DELETE",
            required: true
          });
        } else {
          typed = window.prompt('Type DELETE (uppercase) to confirm scheduling deletion:');
        }
        if (typed === null) return;
        if (String(typed || "").trim() !== "DELETE") {
          if (window.CBV2.toast) window.CBV2.toast.error('Confirmation didn\'t match — type DELETE exactly. Account NOT scheduled for deletion.');
          return;
        }

        // Disable while in flight. We do NOT sign the user out on success
        // — they need to be able to keep using the account during the
        // grace window (and see the restore banner).
        deleteAccountBtn.disabled = true;
        deleteAccountBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scheduling…';

        try {
          const auth = window.CBV2.auth;
          const client = auth && typeof auth.getClient === "function" ? auth.getClient() : null;
          let response;
          if (client && client.functions && typeof client.functions.invoke === "function") {
            const invoked = await client.functions.invoke("delete-account", { body: { mode: "soft" } });
            if (invoked.error) throw invoked.error;
            response = invoked.data || {};
          } else {
            const token = await auth.getAccessToken();
            const url = window.CBV2.config.getFunctionsUrl() + "/delete-account";
            const resp = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token,
                apikey: window.CBV2.config.getSupabaseAnon()
              },
              body: JSON.stringify({ mode: "soft" })
            });
            response = await resp.json();
            if (!resp.ok || (response && response.ok === false)) {
              throw new Error((response && response.error) || ("HTTP " + resp.status));
            }
          }

          // Reload entitlements so the new pending_deletion_at lands in
          // the cached profile and the global banner picks it up.
          const ent = window.CBV2 && window.CBV2.entitlements;
          if (ent && typeof ent.load === "function") {
            try { await ent.load(true); } catch (_e) { /* banner will refresh on next route */ }
          }

          const scheduled = response && response.scheduledFor
            ? new Date(response.scheduledFor)
            : null;
          const dateLabel = scheduled
            ? scheduled.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
            : "in 7 days";
          if (window.CBV2.toast) {
            window.CBV2.toast.success("Account scheduled for deletion on " + dateLabel + ". Use the banner at the top of any page to cancel.");
          }
          // Reset the button + re-render the section so the user sees
          // the new state (the danger-zone copy could update to say
          // "deletion pending — cancel via banner").
          deleteAccountBtn.disabled = false;
          deleteAccountBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Delete my account permanently';
        } catch (err) {
          deleteAccountBtn.disabled = false;
          deleteAccountBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Delete my account permanently';
          const msg = (err && err.message) || "Account deletion failed.";
          if (window.CBV2.toast) window.CBV2.toast.error("Couldn't schedule deletion: " + msg);
        }
      });
    }

    const signout = document.getElementById("signout-btn");
    if (signout) {
      signout.addEventListener("click", async function () {
        try { await window.CBV2.auth.signOut(); } catch (e) { /* ignore */ }
        window.location.hash = "#/auth";
      });
    }

    const runDiag = document.getElementById("run-diagnostics");
    if (runDiag) {
      runDiag.addEventListener("click", function () {
        if (!viewState.diagnosticsRunning) runDiagnostics();
      });
    }
    const clearDiag = document.getElementById("clear-diagnostics");
    if (clearDiag) {
      clearDiag.addEventListener("click", function () {
        viewState.diagnostics = {};
        viewState.diagnosticsLastRunAt = "";
        window.CBV2.renderCurrentRoute();
      });
    }
    const copyDiagReport = document.getElementById("copy-diagnostics-report");
    if (copyDiagReport) {
      copyDiagReport.addEventListener("click", async function () {
        const report = {
          runAt: viewState.diagnosticsLastRunAt || "",
          checks: viewState.diagnostics || {}
        };
        const text = JSON.stringify(report, null, 2);
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            if (window.CBV2.toast) window.CBV2.toast.success("Diagnostics report copied.");
            return;
          }
        } catch (e) { /* fallback below */ }
        window.prompt("Copy diagnostics report:", text);
      });
    }
    document.querySelectorAll("[data-copy-diag]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const payload = btn.getAttribute("data-copy-diag") || "";
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(payload);
            if (window.CBV2.toast) window.CBV2.toast.success("Diagnostic details copied.");
            return;
          }
        } catch (e) { /* fallback below */ }
        window.prompt("Copy diagnostic details:", payload);
      });
    });

    const forceJob = document.getElementById("force-client-job-search");
    if (forceJob) {
      forceJob.addEventListener("change", function () {
        try {
          if (forceJob.checked) sessionStorage.setItem("cb_force_client_job_search", "1");
          else sessionStorage.removeItem("cb_force_client_job_search");
        } catch (e) { /* ignore */ }
        if (window.CBJobs && typeof window.CBJobs.clearCache === "function") {
          window.CBJobs.clearCache();
        }
        viewState.message = forceJob.checked
          ? "This tab will use in-browser job feeds until you turn this off. Open Job Search to refetch."
          : "CareerBoost Cloud is restored for job search on this tab. Open Job Search to refetch.";
        window.CBV2.renderCurrentRoute();
      });
    }

    const importBtn = document.getElementById("import-local");
    if (importBtn) {
      importBtn.addEventListener("click", async function () {
        let localData = null;
        try {
          const raw = localStorage.getItem("cbv2_store_v1");
          if (raw) localData = JSON.parse(raw);
        } catch (e) { /* ignore */ }
        if (!localData) {
          viewState.message = "No local data snapshot found to import.";
          window.CBV2.renderCurrentRoute();
          return;
        }
        const summary = countSnapshotSummary(localData);
        const ok = confirmWithTypedPhrase(
          "Import local data into cloud account?",
          "Local snapshot to merge: " + summaryLineText(summary) + ".\nCloud data is merged, not overwritten.",
          "IMPORT"
        );
        if (!ok) {
          viewState.message = "Import cancelled.";
          window.CBV2.renderCurrentRoute();
          return;
        }
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Importing...';
        try {
          await window.CBV2.remoteStore.importLocal(localData);
          viewState.message = "Local data imported into your cloud account. Reload to see everything in sync.";
        } catch (err) {
          viewState.message = "Import failed: " + (err.message || "unknown error");
        }
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  function setProfileStatus(message, kind) {
    const el = document.getElementById("profile-status");
    if (!el) return;
    el.classList.remove("is-error", "is-success");
    if (kind === "error") el.classList.add("is-error");
    else if (kind === "success") el.classList.add("is-success");
    const icon = kind === "error"
      ? '<i class="fa-solid fa-circle-exclamation"></i>'
      : kind === "success"
      ? '<i class="fa-solid fa-circle-check"></i>'
      : kind === "pending"
      ? '<i class="fa-solid fa-circle-notch fa-spin"></i>'
      : "";
    el.innerHTML = message ? icon + getSt()(message) : "";
  }

  async function handleAvatarFile(file) {
    if (!file) return;
    if (!window.CBV2.profile) return;
    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      setProfileStatus("Image too large (max 5 MB).", "error");
      if (window.CBV2.toast) window.CBV2.toast.error("Image too large (max 5 MB).");
      return;
    }
    setProfileStatus("Uploading and resizing your photo…", "pending");
    try {
      await window.CBV2.profile.uploadAvatar(file);
      setProfileStatus("Avatar updated.", "success");
      if (window.CBV2.toast) window.CBV2.toast.success("Avatar updated.");
      window.CBV2.renderCurrentRoute();
    } catch (err) {
      const msg = (err && err.message) || "Upload failed";
      setProfileStatus(msg, "error");
      if (window.CBV2.toast) window.CBV2.toast.error("Upload failed: " + msg);
    }
  }

  function bindProfile() {
    const section = document.getElementById("profile-section");
    if (!section) return;

    const dropzone = document.getElementById("avatar-dropzone");
    const fileInput = document.getElementById("avatar-file-input");
    const saveBtn = document.getElementById("profile-save");
    const removeBtn = document.getElementById("profile-remove-avatar");
    const refreshBtn = document.getElementById("profile-refresh");

    if (dropzone && fileInput) {
      dropzone.addEventListener("click", function () { fileInput.click(); });
      dropzone.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
      });
      ["dragover", "dragenter"].forEach(function (ev) {
        dropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          dropzone.classList.add("is-dragover");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        dropzone.addEventListener(ev, function () { dropzone.classList.remove("is-dragover"); });
      });
      dropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) handleAvatarFile(dt.files[0]);
      });
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files.length) handleAvatarFile(fileInput.files[0]);
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", async function () {
        const nameEl = document.getElementById("profile-full-name");
        const headlineEl = document.getElementById("profile-headline");
        const aboutEl = document.getElementById("profile-about");
        const expEl = document.getElementById("profile-experience-years");
        const skillsEl = document.getElementById("profile-skills");
        const industriesEl = document.getElementById("profile-industries");
        const linkedinEl = document.getElementById("profile-linkedin");
        const githubEl = document.getElementById("profile-github");
        const portfolioEl = document.getElementById("profile-portfolio");
        const profileNow = (window.CBV2.profile && window.CBV2.profile.get && window.CBV2.profile.get()) || {};
        const preferencesNow = (profileNow.preferences && typeof profileNow.preferences === "object") ? profileNow.preferences : {};
        const profilePrefsNow = (preferencesNow.profile && typeof preferencesNow.profile === "object") ? preferencesNow.profile : {};
        const splitCsv = function (raw) {
          return String(raw || "")
            .split(",")
            .map(function (x) { return x.trim(); })
            .filter(Boolean)
            .slice(0, 20);
        };
        const experienceYears = Number((expEl && expEl.value) || "");
        const patch = {
          full_name: nameEl ? nameEl.value.trim() : "",
          headline: headlineEl ? headlineEl.value.trim() : "",
          preferences: Object.assign({}, preferencesNow, {
            profile: Object.assign({}, profilePrefsNow, {
              about: aboutEl ? aboutEl.value.trim() : "",
              experienceYears: Number.isFinite(experienceYears) ? Math.max(0, Math.min(60, experienceYears)) : null,
              skills: splitCsv(skillsEl ? skillsEl.value : ""),
              industries: splitCsv(industriesEl ? industriesEl.value : ""),
              links: {
                linkedin: linkedinEl ? linkedinEl.value.trim() : "",
                github: githubEl ? githubEl.value.trim() : "",
                portfolio: portfolioEl ? portfolioEl.value.trim() : ""
              }
            })
          })
        };
        saveBtn.disabled = true;
        setProfileStatus("Saving…", "pending");
        try {
          await window.CBV2.profile.update(patch);
          setProfileStatus("Profile saved.", "success");
          if (window.CBV2.toast) window.CBV2.toast.success("Profile saved.");
        } catch (err) {
          const msg = (err && err.message) || "Save failed";
          setProfileStatus(msg, "error");
          if (window.CBV2.toast) window.CBV2.toast.error("Save failed: " + msg);
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener("click", async function () {
        if (!window.confirm("Remove your profile photo?")) return;
        removeBtn.disabled = true;
        setProfileStatus("Removing photo…", "pending");
        try {
          await window.CBV2.profile.removeAvatar();
          setProfileStatus("Photo removed.", "success");
          if (window.CBV2.toast) window.CBV2.toast.success("Photo removed.");
          window.CBV2.renderCurrentRoute();
        } catch (err) {
          const msg = (err && err.message) || "Remove failed";
          setProfileStatus(msg, "error");
          if (window.CBV2.toast) window.CBV2.toast.error(msg);
          removeBtn.disabled = false;
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", async function () {
        refreshBtn.disabled = true;
        setProfileStatus("Refreshing from server…", "pending");
        try {
          await window.CBV2.profile.load();
          setProfileStatus("Profile refreshed.", "success");
          window.CBV2.renderCurrentRoute();
        } catch (err) {
          setProfileStatus((err && err.message) || "Refresh failed", "error");
          refreshBtn.disabled = false;
        }
      });
    }
  }

  function bindJobPreferences() {
    const form = document.getElementById("job-preferences-form");
    if (!form) return;
    const markDirty = function () {
      setFormStatus("jobPreferences", { dirty: true, kind: "pending", text: "Unsaved changes." });
      const line = form.parentElement && form.parentElement.querySelector(".settings-save-state");
      if (line) {
        line.textContent = "Unsaved changes. These values also update in-memory Job Search defaults instantly.";
        line.classList.remove("settings-save-state--success", "settings-save-state--error", "settings-save-state--idle");
        line.classList.add("settings-save-state--pending");
      }
    };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const splitCsv = function (raw) {
        return String(raw || "")
          .split(",")
          .map(function (x) { return x.trim(); })
          .filter(Boolean)
          .slice(0, 20);
      };
      const roleProfile = {
        targetTitles: splitCsv((document.getElementById("jp-target-roles") || {}).value || ""),
        mustHaveSkills: splitCsv((document.getElementById("jp-must-have-skills") || {}).value || ""),
        excludeKeywords: splitCsv((document.getElementById("jp-exclude-keywords") || {}).value || ""),
        seniority: ((document.getElementById("jp-seniority") || {}).value || "any"),
        strictMode: ((document.getElementById("jp-strict-mode") || {}).value || "off") === "on"
      };
      const location = ((document.getElementById("jp-location") || {}).value || "").trim();
      const remoteMode = ((document.getElementById("jp-remote-mode") || {}).value || "any");
      const postedWithinDays = Number(((document.getElementById("jp-posted-days") || {}).value || 0) || 0);
      const store = window.CBV2.store;
      const js = (store && store.getJobSearchState && store.getJobSearchState()) || {};
      const nextFilters = Object.assign({}, js.lastFilters || {}, {
        location: location,
        remoteOnly: remoteMode === "remote_only",
        postedWithinDays: postedWithinDays
      });
      if (store && typeof store.setJobSearchState === "function") {
        store.setJobSearchState({
          roleProfile: roleProfile,
          lastFilters: nextFilters
        });
      }
      try {
        await savePreferencePatch({
          jobPreferences: {
            roleProfile: roleProfile,
            location: location,
            remoteOnly: remoteMode === "remote_only",
            postedWithinDays: postedWithinDays,
            seniority: roleProfile.seniority,
            strictMode: roleProfile.strictMode,
            updatedAt: new Date().toISOString()
          }
        });
        viewState.message = "Job preferences saved and synced.";
        setFormStatus("jobPreferences", { dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("Preferences saved.");
      } catch (err) {
        viewState.message = "Preferences saved locally, but cloud sync failed: " + ((err && err.message) || "unknown error");
        setFormStatus("jobPreferences", { dirty: false, kind: "error", text: "Saved locally. Cloud sync failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("Cloud sync failed.");
      }
      window.CBV2.renderCurrentRoute();
    });
  }

  function bindAiPreferences() {
    const form = document.getElementById("ai-preferences-form");
    if (!form) return;
    const markDirty = function () {
      setFormStatus("aiPreferences", { dirty: true, kind: "pending", text: "Unsaved changes." });
      const line = form.parentElement && form.parentElement.querySelector(".settings-save-state");
      if (line) {
        line.textContent = "Unsaved changes.";
        line.classList.remove("settings-save-state--success", "settings-save-state--error", "settings-save-state--idle");
        line.classList.add("settings-save-state--pending");
      }
    };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const val = function (id, fallback) {
        const el = document.getElementById(id);
        return el ? el.value : fallback;
      };
      const checked = function (id, fallback) {
        const el = document.getElementById(id);
        return el ? !!el.checked : !!fallback;
      };
      const next = {
        personalizedMode: val("ai-personalized-mode", "on") === "on",
        tone: val("ai-tone", "professional"),
        responseLength: val("ai-response-length", "balanced"),
        localeStyle: val("ai-locale-style", "global"),
        modules: {
          jobSearch: checked("ai-module-job-search", true),
          resume: checked("ai-module-resume", true),
          coverLetter: checked("ai-module-cover-letter", true),
          interview: checked("ai-module-interview", true)
        },
        consentPersonalizedAi: checked("ai-consent-personalized", true),
        consentTelemetry: checked("ai-consent-telemetry", true),
        updatedAt: new Date().toISOString()
      };
      try {
        await savePreferencePatch({ aiPreferences: next });
        if (!next.consentTelemetry && window.CBAI && window.CBAI.telemetry && typeof window.CBAI.telemetry.clear === "function") {
          window.CBAI.telemetry.clear();
        }
        viewState.message = "AI personalization preferences saved.";
        setFormStatus("aiPreferences", { dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("AI preferences saved.");
      } catch (err) {
        viewState.message = "Failed to save AI preferences: " + ((err && err.message) || "unknown error");
        setFormStatus("aiPreferences", { dirty: false, kind: "error", text: "Save failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("AI preferences save failed.");
      }
      window.CBV2.renderCurrentRoute();
    });
  }

  function bindSavedCvSettings() {
    const root = document.getElementById("saved-cv-section");
    if (!root) return;
    const defaultSel = document.getElementById("default-cv-select");
    if (defaultSel) {
      defaultSel.addEventListener("change", function () {
        const id = String(defaultSel.value || "");
        const store = window.CBV2.store;
        if (store && typeof store.setDefaultSavedCV === "function") {
          store.setDefaultSavedCV(id);
          if (window.CBV2.toast) window.CBV2.toast.success("Default CV updated.");
          window.CBV2.renderCurrentRoute();
        }
      });
    }
    const filterSel = document.getElementById("cv-filter");
    if (filterSel) {
      filterSel.addEventListener("change", function () {
        viewState.docs.cvFilter = String(filterSel.value || "all");
        window.CBV2.renderCurrentRoute();
      });
    }
    const cvSearch = document.getElementById("cv-search");
    if (cvSearch) {
      cvSearch.addEventListener("input", function () {
        viewState.docs.cvQuery = String(cvSearch.value || "");
        window.CBV2.renderCurrentRoute();
      });
    }
    const cvSort = document.getElementById("cv-sort");
    if (cvSort) {
      cvSort.addEventListener("change", function () {
        viewState.docs.cvSort = String(cvSort.value || "updated_desc");
        window.CBV2.renderCurrentRoute();
      });
    }
    const cvReset = document.getElementById("cv-reset-filters");
    if (cvReset) {
      cvReset.addEventListener("click", function () {
        viewState.docs.cvFilter = "all";
        viewState.docs.cvQuery = "";
        viewState.docs.cvSort = "updated_desc";
        window.CBV2.renderCurrentRoute();
      });
    }
    const exportCvsJson = document.getElementById("export-cvs-json");
    if (exportCvsJson) {
      exportCvsJson.addEventListener("click", function () {
        const store = window.CBV2.store;
        const items = (store && store.getSavedCVs && store.getSavedCVs()) || [];
        if (!items.length) {
          if (window.CBV2.toast) window.CBV2.toast.warning("No saved CVs to export.");
          return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        if (window.CBV2.downloadText) {
          window.CBV2.downloadText("saved-cvs-" + stamp + ".json", JSON.stringify(items, null, 2));
          if (window.CBV2.toast) window.CBV2.toast.success("Saved CVs exported as JSON.");
        }
      });
    }
    root.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-cv-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-cv-action");
      const row = btn.closest("[data-cv-id]");
      if (!row) return;
      const id = row.getAttribute("data-cv-id");
      const store = window.CBV2.store;
      const items = (store.getSavedCVs && store.getSavedCVs()) || [];
      const cv = items.find(function (x) { return x.id === id; });
      if (!cv) return;

      if (action === "use") {
        store.setDefaultSavedCV(id);
        if (window.CBV2.toast) window.CBV2.toast.success("Default CV updated.");
        window.CBV2.renderCurrentRoute();
        return;
      }
      if (action === "rename") {
        const next = window.prompt("Rename CV", cv.name || "Untitled CV");
        if (!next || !next.trim()) return;
        store.saveCurrentResumeAsSavedCV({
          id: cv.id,
          name: next.trim(),
          baseText: cv.baseText || "",
          structured: cv.structured || null,
          source: cv.source || "resume-lab",
          createdAt: cv.createdAt || new Date().toISOString()
        });
        if (window.CBV2.toast) window.CBV2.toast.success("CV renamed.");
        window.CBV2.renderCurrentRoute();
        return;
      }
      if (action === "download") {
        const raw = (cv.baseText && String(cv.baseText).trim())
          ? String(cv.baseText)
          : (cv.structured ? JSON.stringify(cv.structured, null, 2) : "");
        if (!raw) {
          if (window.CBV2.toast) window.CBV2.toast.warning("This CV has no exportable content yet.");
          return;
        }
        const safeName = String(cv.name || "cv")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "cv";
        if (window.CBV2.downloadText) {
          window.CBV2.downloadText(safeName + ".txt", raw);
          if (window.CBV2.toast) window.CBV2.toast.success("CV downloaded.");
        }
        return;
      }
      if (action === "delete") {
        if (!window.confirm("Delete this saved CV?")) return;
        store.deleteSavedCV(id);
        if (window.CBV2.toast) window.CBV2.toast.success("Saved CV deleted.");
        window.CBV2.renderCurrentRoute();
      }
    });
  }

  function bindCareerAssetsSettings() {
    const root = document.getElementById("career-assets-section");
    if (!root) return;
    const assetSearch = document.getElementById("asset-search");
    if (assetSearch) {
      assetSearch.addEventListener("input", function () {
        viewState.docs.assetQuery = String(assetSearch.value || "");
        window.CBV2.renderCurrentRoute();
      });
    }
    const assetSort = document.getElementById("asset-sort");
    if (assetSort) {
      assetSort.addEventListener("change", function () {
        viewState.docs.assetSort = String(assetSort.value || "updated_desc");
        window.CBV2.renderCurrentRoute();
      });
    }
    const assetReset = document.getElementById("asset-reset-filters");
    if (assetReset) {
      assetReset.addEventListener("click", function () {
        viewState.docs.assetQuery = "";
        viewState.docs.assetSort = "updated_desc";
        window.CBV2.renderCurrentRoute();
      });
    }
    const exportBtn = document.getElementById("export-assets");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        const store = window.CBV2.store;
        const items = (store && store.getCareerAssets && store.getCareerAssets()) || [];
        if (!items.length) {
          if (window.CBV2.toast) window.CBV2.toast.warning("No assets to export.");
          return;
        }
        const lines = items.map(function (a, i) {
          return (
            "# " + (i + 1) + " — " + (a.name || "Untitled asset") + "\n" +
            "type: " + (a.type || "bullet") + "\n" +
            "updated: " + (a.updatedAt || "—") + "\n" +
            ((a.tags && a.tags.length) ? ("tags: " + a.tags.join(", ") + "\n") : "") +
            "\n" + (a.text || "") + "\n"
          );
        }).join("\n---\n\n");
        const stamp = new Date().toISOString().slice(0, 10);
        if (window.CBV2.downloadText) {
          window.CBV2.downloadText("career-assets-" + stamp + ".txt", lines);
          if (window.CBV2.toast) window.CBV2.toast.success("Assets exported.");
        }
      });
    }
    const exportAssetsJson = document.getElementById("export-assets-json");
    if (exportAssetsJson) {
      exportAssetsJson.addEventListener("click", function () {
        const store = window.CBV2.store;
        const items = (store && store.getCareerAssets && store.getCareerAssets()) || [];
        if (!items.length) {
          if (window.CBV2.toast) window.CBV2.toast.warning("No assets to export.");
          return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        if (window.CBV2.downloadText) {
          window.CBV2.downloadText("career-assets-" + stamp + ".json", JSON.stringify(items, null, 2));
          if (window.CBV2.toast) window.CBV2.toast.success("Assets exported as JSON.");
        }
      });
    }
    root.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-asset-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-asset-action");
      const row = btn.closest("[data-asset-id]");
      if (!row) return;
      const id = row.getAttribute("data-asset-id");
      const store = window.CBV2.store;
      const items = (store.getCareerAssets && store.getCareerAssets()) || [];
      const asset = items.find(function (x) { return x.id === id; });
      if (!asset) return;
      if (action === "copy") {
        const text = String(asset.text || "").trim();
        if (!text) return;
        const done = function () {
          if (window.CBV2.toast) window.CBV2.toast.success("Asset text copied.");
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () {
            window.prompt("Copy asset text:", text);
          });
        } else {
          window.prompt("Copy asset text:", text);
        }
        return;
      }
      if (action === "rename") {
        const next = window.prompt("Rename asset", asset.name || "Untitled asset");
        if (!next || !next.trim()) return;
        store.saveCareerAsset({
          id: asset.id,
          name: next.trim(),
          type: asset.type || "bullet",
          text: asset.text || "",
          tags: asset.tags || [],
          source: asset.source || "resume-lab",
          createdAt: asset.createdAt || new Date().toISOString()
        });
        if (window.CBV2.toast) window.CBV2.toast.success("Career asset renamed.");
        window.CBV2.renderCurrentRoute();
        return;
      }
      if (action === "delete") {
        if (!window.confirm("Delete this career asset?")) return;
        store.deleteCareerAsset(id);
        if (window.CBV2.toast) window.CBV2.toast.success("Career asset deleted.");
        window.CBV2.renderCurrentRoute();
      }
    });
  }

  function bindAppearance() {
    const themeApi = window.CBV2.theme;
    if (!themeApi || typeof themeApi.get !== "function") return;
    const form = document.getElementById("appearance-form");
    if (!form) return;
    const presetSelect = document.getElementById("theme-preset");
    const fieldPrimary = document.getElementById("theme-primary");
    const fieldBg = document.getElementById("theme-bg");

    const current = themeApi.get() || {};
    const baseColors = Object.assign({
      primary: "#22e3ff",
      primary2: "#6b7dff",
      accent: "#b06bff",
      secondary: "#ff9d4a",
      bg: "#06070f",
      bg2: "#0a0d1a"
    }, current.colors || {});

    function readTheme() {
      return {
        presetId: "custom",
        colors: {
          primary: fieldPrimary ? fieldPrimary.value : baseColors.primary,
          primary2: baseColors.primary2,
          accent: baseColors.accent,
          secondary: baseColors.secondary,
          bg: fieldBg ? fieldBg.value : baseColors.bg,
          bg2: baseColors.bg2
        }
      };
    }

    function applyCustomPreview() {
      themeApi.set(readTheme(), true);
      if (presetSelect) presetSelect.value = "custom";
      setFormStatus("appearance", { dirty: true, kind: "pending", text: "Unsaved changes." });
      const line = form.parentElement && form.parentElement.querySelector(".settings-save-state");
      if (line) {
        line.textContent = "Unsaved changes.";
        line.classList.remove("settings-save-state--success", "settings-save-state--error", "settings-save-state--idle");
        line.classList.add("settings-save-state--pending");
      }
    }

    if (fieldPrimary) fieldPrimary.addEventListener("input", applyCustomPreview);
    if (fieldBg) fieldBg.addEventListener("input", applyCustomPreview);
    if (fieldPrimary) fieldPrimary.addEventListener("change", applyCustomPreview);
    if (fieldBg) fieldBg.addEventListener("change", applyCustomPreview);

    if (presetSelect) {
      presetSelect.addEventListener("change", function () {
        const id = presetSelect.value;
        if (id === "custom") return;
        const next = themeApi.setPreset(id, true);
        const colors = next && next.colors ? next.colors : {};
        if (fieldPrimary && colors.primary) fieldPrimary.value = colors.primary;
        if (fieldBg && colors.bg) fieldBg.value = colors.bg;
        setFormStatus("appearance", { dirty: true, kind: "pending", text: "Unsaved changes." });
      });
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const theme = themeApi.get ? themeApi.get() : readTheme();
      const profileApi = window.CBV2.profile;
      if (!profileApi || typeof profileApi.update !== "function") {
        setFormStatus("appearance", { dirty: false, kind: "success", text: "Saved locally." });
        if (window.CBV2.toast) window.CBV2.toast.success("Theme saved locally.");
        window.CBV2.renderCurrentRoute();
        return;
      }
      const profile = (profileApi.get && profileApi.get()) || null;
      const prefs = (profile && profile.preferences && typeof profile.preferences === "object") ? profile.preferences : {};
      try {
        await profileApi.update({
          preferences: Object.assign({}, prefs, {
            appearance: { theme: theme }
          })
        });
        setFormStatus("appearance", { dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("Theme saved and synced.");
      } catch (err) {
        setFormStatus("appearance", { dirty: false, kind: "error", text: "Saved locally. Cloud sync failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("Saved locally. Cloud sync failed.");
      }
      window.CBV2.renderCurrentRoute();
    });

    const reset = document.getElementById("appearance-reset");
    if (reset) {
      reset.addEventListener("click", function () {
        const next = themeApi.setPreset("aurora", true);
        const colors = next && next.colors ? next.colors : {};
        if (fieldPrimary && colors.primary) fieldPrimary.value = colors.primary;
        if (fieldBg && colors.bg) fieldBg.value = colors.bg;
        if (presetSelect) presetSelect.value = "aurora";
        setFormStatus("appearance", { dirty: true, kind: "pending", text: "Unsaved changes." });
      });
    }
  }

  window.CBV2.routes.settings = renderView;
  window.CBV2.afterRender.settings = function () {
    maybeBackfillJobPreferences();
    bindForm();
    bindProfile();
    bindJobPreferences();
    bindAiPreferences();
    bindApplyAssist();
    bindSavedCvSettings();
    bindCareerAssetsSettings();
    bindAppearance();
    // Phase Billing: bind handlers for the Billing & Plan tab when it's
    // the active section.
    if (window.CBV2.settingsBilling && typeof window.CBV2.settingsBilling.bind === "function") {
      window.CBV2.settingsBilling.bind();
    }

    // If the user clicked "Profile & avatar" in the user menu we arrive at
    // #/settings?tab=profile. Scroll-focus the profile card so it's obvious.
    try {
      const params = window.CBV2.getRouteParams ? window.CBV2.getRouteParams() : {};
      if (params && params.tab === "profile") {
        const el = document.getElementById("profile-section");
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("is-highlighted");
          setTimeout(function () { el.classList.remove("is-highlighted"); }, 1200);
        }
      }
      // PayStack callback handler — when checkout returns the user
      // here with ?billing=success, show a success toast and reload
      // entitlements so the new plan reflects immediately (the
      // webhook may have already fired by now, but a fresh load is
      // race-safe). The param is consumed once via a guard flag so a
      // page refresh doesn't re-trigger the toast.
      if (params && params.billing === "success" && !window.__cbv2BillingSuccessHandled) {
        window.__cbv2BillingSuccessHandled = true;
        const ent = window.CBV2 && window.CBV2.entitlements;
        if (ent && typeof ent.load === "function") {
          ent.load(true).catch(function () { /* non-fatal */ });
        }
        if (window.CBV2.toast) {
          window.CBV2.toast.success("Payment received — your plan is being activated. This usually takes a few seconds.");
        }
        // Strip ?billing=success from the URL so a refresh doesn't
        // re-toast. Keep the rest of the hash intact (#/settings?tab=account).
        try {
          const url = new URL(window.location.href);
          const hash = url.hash || "";
          const qIdx = hash.indexOf("?");
          if (qIdx >= 0) {
            const pathPart = hash.slice(0, qIdx);
            const search = new URLSearchParams(hash.slice(qIdx + 1));
            search.delete("billing");
            const cleaned = search.toString();
            const newHash = pathPart + (cleaned ? "?" + cleaned : "");
            history.replaceState({}, "", url.origin + url.pathname + url.search + newHash);
          }
        } catch (e) { /* non-fatal */ }
      } else if (params && params.billing === "cancelled") {
        if (window.CBV2.toast) {
          window.CBV2.toast.info("Checkout cancelled — your plan is unchanged.");
        }
      }
    } catch (e) { /* non-fatal */ }
  };
})();
