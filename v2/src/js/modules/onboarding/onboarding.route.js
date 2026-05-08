// 3-step onboarding wizard shown to newly-signed-up users.
// Step 1: target role + industries + location preferences
// Step 2: paste base resume (or skip)
// Step 3: pick preferred job boards & confirm
// Finalising marks profiles.onboarding_completed = true and lands on dashboard.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const INDUSTRIES = [
    "Software / Engineering", "Data / AI", "Design / UX", "Product", "Marketing",
    "Sales", "Finance", "Consulting", "Healthcare", "Education", "Operations", "Other"
  ];

  const BOARDS = [
    { id: "remotive", label: "Remotive", desc: "Remote-only roles, tech focus", free: true },
    { id: "arbeitnow", label: "Arbeitnow", desc: "EU jobs, strong in DE/UK", free: true },
    { id: "jobicy", label: "Jobicy", desc: "Curated remote roles", free: true },
    { id: "muse", label: "The Muse", desc: "Mid/large companies, US-centric", free: true },
    { id: "adzuna", label: "Adzuna", desc: "Global aggregator (needs API key)", free: false }
  ];

  const viewState = {
    step: 1,
    targetRole: "",
    location: "",
    remotePref: "any",
    industries: [],
    resumeText: "",
    resumeSkipped: false,
    boards: ["remotive", "arbeitnow", "jobicy", "muse"],
    busy: false,
    error: ""
  };

  function st() { return window.CBV2.sanitizeText; }
  function s(x) { return st()(x); }
  function renderBrand() {
    if (window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function") {
      return window.CBV2.brandKit.logo({ compact: false, tagline: true });
    }
    return "Career<span>Boost</span>";
  }

  // ---------------------------------------------------------------------------
  // Profile helpers (hit Supabase directly from client; RLS enforces ownership)
  // ---------------------------------------------------------------------------
  async function fetchProfile() {
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) return null;
    const client = auth.getClient();
    const user = auth.getUser();
    if (!client || !user) return null;
    const { data, error } = await client.from("profiles")
      .select("*").eq("user_id", user.id).maybeSingle();
    if (error) return null;
    return data;
  }

  async function saveProfile(patch) {
    const auth = window.CBV2.auth;
    const client = auth && auth.getClient();
    const user = auth && auth.getUser();
    if (!client || !user) throw new Error("Not signed in.");
    const row = Object.assign({ user_id: user.id }, patch);
    const { error } = await client.from("profiles").upsert(row);
    if (error) throw error;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderProgress() {
    return (
      '<div class="onboarding-progress" role="progressbar" aria-valuenow="' + viewState.step +
        '" aria-valuemin="1" aria-valuemax="3">' +
        [1, 2, 3].map(function (n) {
          const cls = n < viewState.step ? "done" : (n === viewState.step ? "active" : "");
          return '<span class="progress-step ' + cls + '">' +
            '<span class="dot">' + (n < viewState.step ? '<i class="fa-solid fa-check"></i>' : n) + '</span>' +
            '<span class="progress-label">' +
            (n === 1 ? "Role" : n === 2 ? "Resume" : "Sources") +
            '</span></span>';
        }).join('<span class="progress-line"></span>') +
      '</div>'
    );
  }

  function renderStep1() {
    const inds = INDUSTRIES.map(function (i) {
      const active = viewState.industries.indexOf(i) >= 0;
      return '<button class="chip-btn ' + (active ? "is-active" : "") + '" type="button" data-industry="' + s(i) + '">' + s(i) + '</button>';
    }).join("");

    return (
      '<h2>Tell us about your next role.</h2>' +
      '<p class="welcome-lead">This powers every AI skill and your first job search. You can change any of it later.</p>' +

      '<label class="ob-field">' +
        '<span>What role are you targeting?</span>' +
        '<input id="ob-role" type="text" placeholder="e.g. Senior Frontend Engineer" value="' + s(viewState.targetRole) + '" />' +
      '</label>' +

      '<div class="ob-row-2">' +
        '<label class="ob-field">' +
          '<span>Where?</span>' +
          '<input id="ob-location" type="text" placeholder="e.g. Remote · EU · Cape Town" value="' + s(viewState.location) + '" />' +
        '</label>' +
        '<label class="ob-field">' +
          '<span>Remote preference</span>' +
          '<select id="ob-remote">' +
            ['any', 'remote', 'hybrid', 'onsite'].map(function (v) {
              const label = v === 'any' ? 'Any' : v.charAt(0).toUpperCase() + v.slice(1);
              return '<option value="' + v + '"' + (viewState.remotePref === v ? ' selected' : '') + '>' + label + '</option>';
            }).join('') +
          '</select>' +
        '</label>' +
      '</div>' +

      '<div class="ob-field">' +
        '<span>Industries (pick up to 3)</span>' +
        '<div class="chip-group">' + inds + '</div>' +
      '</div>'
    );
  }

  function renderStep2() {
    return (
      '<h2>Paste your current resume.</h2>' +
      '<p class="welcome-lead">We keep it private — only you see it. The AI uses this as grounding for every tailored resume and cover letter. You can skip and add it later.</p>' +

      '<label class="ob-field">' +
        '<span>Base resume (plain text)</span>' +
        '<textarea id="ob-resume" rows="12" placeholder="Paste your resume here, or skip for now.">' + s(viewState.resumeText) + '</textarea>' +
      '</label>' +
      '<p class="ai-meta"><i class="fa-solid fa-lock"></i> Stored encrypted in your account · never used to train models</p>'
    );
  }

  function renderStep3() {
    const boards = BOARDS.map(function (b) {
      const active = viewState.boards.indexOf(b.id) >= 0;
      const badge = b.free ? '<span class="chip green">Free</span>' : '<span class="chip warning">Needs key</span>';
      return (
        '<label class="board-card ' + (active ? "is-active" : "") + '">' +
          '<input type="checkbox" data-board="' + b.id + '"' + (active ? ' checked' : '') + ' />' +
          '<div class="board-copy">' +
            '<div class="board-title">' + s(b.label) + ' ' + badge + '</div>' +
            '<div class="board-desc">' + s(b.desc) + '</div>' +
          '</div>' +
        '</label>'
      );
    }).join("");

    return (
      '<h2>Pick the job boards you want searched.</h2>' +
      '<p class="welcome-lead">Pick two or more for broad coverage. You can toggle these anytime on the Job Search page.</p>' +
      '<div class="board-grid">' + boards + '</div>' +
      '<p class="ai-meta" style="margin-top:12px;">Need Adzuna? Add your key later in Settings — we\'ll automatically light it up.</p>'
    );
  }

  function renderView() {
    const body =
      viewState.step === 1 ? renderStep1() :
      viewState.step === 2 ? renderStep2() :
      renderStep3();

    const backDisabled = viewState.step === 1 || viewState.busy;
    const nextLabel =
      viewState.step === 3 ? (viewState.busy ? 'Finishing...' : 'Finish setup') :
      'Continue';

    const secondary = viewState.step === 2
      ? '<button class="btn-ghost" id="ob-skip" type="button">Skip for now</button>'
      : "";

    return (
      '<section class="ob-wrap">' +
        '<div class="ob-card">' +
          '<div class="auth-brand ob-brand">' + renderBrand() + "</div>" +
          renderProgress() +

          '<div class="ob-body">' + body + '</div>' +

          (viewState.error
            ? '<div class="ai-notice rose"><i class="fa-solid fa-circle-xmark"></i><div>' + s(viewState.error) + '</div></div>'
            : "") +

          '<div class="ob-actions">' +
            '<button class="btn-ghost" id="ob-back" type="button"' + (backDisabled ? ' disabled' : '') + '>' +
              '<i class="fa-solid fa-arrow-left"></i> Back' +
            '</button>' +
            '<div class="ob-actions-right">' +
              secondary +
              '<button class="btn-primary" id="ob-next" type="button"' + (viewState.busy ? ' disabled' : '') + '>' +
                (viewState.busy
                  ? '<i class="fa-solid fa-circle-notch fa-spin"></i> '
                  : '') +
                s(nextLabel) +
                (viewState.busy || viewState.step === 3 ? '' : ' <i class="fa-solid fa-arrow-right"></i>') +
              '</button>' +
            '</div>' +
          '</div>' +

          '<p class="ai-meta" style="text-align:center;margin-top:14px;">You can revisit and edit everything from Settings.</p>' +
        '</div>' +
      '</section>'
    );
  }

  // ---------------------------------------------------------------------------
  // Input handlers
  // ---------------------------------------------------------------------------
  function readStep1() {
    const r = document.getElementById("ob-role");
    const l = document.getElementById("ob-location");
    const rem = document.getElementById("ob-remote");
    if (r) viewState.targetRole = r.value.trim();
    if (l) viewState.location = l.value.trim();
    if (rem) viewState.remotePref = rem.value;
  }

  function readStep2() {
    const t = document.getElementById("ob-resume");
    if (t) viewState.resumeText = t.value;
  }

  function validateStep1() {
    readStep1();
    if (!viewState.targetRole) { viewState.error = "Please enter a target role."; return false; }
    viewState.error = "";
    return true;
  }

  async function finish() {
    readStep2();
    if (!viewState.boards.length) {
      viewState.error = "Pick at least one job board.";
      renderRoute();
      return;
    }

    viewState.busy = true;
    viewState.error = "";
    renderRoute();

    try {
      const existingProfile = await fetchProfile();
      const existingPreferences = (existingProfile && existingProfile.preferences && typeof existingProfile.preferences === "object")
        ? existingProfile.preferences
        : {};
      const roleProfile = {
        targetTitles: viewState.targetRole ? [viewState.targetRole] : [],
        seniority: "any",
        mustHaveSkills: [],
        excludeKeywords: [],
        strictMode: false
      };
      const preferences = {
        targetRole: viewState.targetRole,
        location: viewState.location,
        remote: viewState.remotePref,
        industries: viewState.industries,
        boards: viewState.boards,
        // New canonical settings shape (kept alongside legacy keys for compatibility).
        jobPreferences: {
          roleProfile: roleProfile,
          location: viewState.location,
          remoteOnly: viewState.remotePref === "remote",
          postedWithinDays: 0,
          seniority: "any",
          strictMode: false,
          updatedAt: new Date().toISOString()
        },
        onboardedAt: new Date().toISOString()
      };

      await saveProfile({
        preferences: Object.assign({}, existingPreferences, preferences),
        onboarding_completed: true
      });

      // Hydrate in-memory search defaults immediately so dashboard/job-search are
      // personalized even before the next full app bootstrap.
      if (window.CBV2.store && typeof window.CBV2.store.setJobSearchState === "function") {
        const js = window.CBV2.store.getJobSearchState ? window.CBV2.store.getJobSearchState() : {};
        window.CBV2.store.setJobSearchState({
          roleProfile: roleProfile,
          lastFilters: Object.assign({}, (js && js.lastFilters) || {}, {
            location: viewState.location,
            remoteOnly: viewState.remotePref === "remote",
            postedWithinDays: 0
          })
        });
      }

      if (viewState.resumeText && viewState.resumeText.trim()) {
        try {
          window.CBV2.store.setResumeBase(viewState.resumeText.trim());
        } catch (e) { /* non-fatal */ }
      }

      if (window.CBV2.toast) {
        window.CBV2.toast.success("You're all set — welcome to CareerBoost!");
      }

      window.location.hash = "#/dashboard";
    } catch (err) {
      viewState.error = (err && err.message) || "Couldn't save your setup. Please try again.";
      viewState.busy = false;
      renderRoute();
    }
  }

  function onNext() {
    if (viewState.busy) return;
    if (viewState.step === 1) {
      if (!validateStep1()) { renderRoute(); return; }
      viewState.step = 2;
      renderRoute();
      return;
    }
    if (viewState.step === 2) {
      readStep2();
      viewState.step = 3;
      renderRoute();
      return;
    }
    finish();
  }

  function onBack() {
    if (viewState.step === 1 || viewState.busy) return;
    if (viewState.step === 2) readStep2();
    viewState.step -= 1;
    renderRoute();
  }

  function onSkipResume() {
    viewState.resumeText = "";
    viewState.resumeSkipped = true;
    viewState.step = 3;
    renderRoute();
  }

  function toggleIndustry(name) {
    const idx = viewState.industries.indexOf(name);
    if (idx >= 0) viewState.industries.splice(idx, 1);
    else {
      if (viewState.industries.length >= 3) return;
      viewState.industries.push(name);
    }
    renderRoute();
  }

  function toggleBoard(id) {
    const idx = viewState.boards.indexOf(id);
    if (idx >= 0) viewState.boards.splice(idx, 1);
    else viewState.boards.push(id);
    renderRoute();
  }

  function bindHandlers() {
    const next = document.getElementById("ob-next");
    if (next) next.addEventListener("click", onNext);
    const back = document.getElementById("ob-back");
    if (back) back.addEventListener("click", onBack);
    const skip = document.getElementById("ob-skip");
    if (skip) skip.addEventListener("click", onSkipResume);

    document.querySelectorAll("[data-industry]").forEach(function (el) {
      el.addEventListener("click", function () {
        toggleIndustry(el.getAttribute("data-industry"));
      });
    });
    document.querySelectorAll("[data-board]").forEach(function (el) {
      el.addEventListener("change", function () {
        toggleBoard(el.getAttribute("data-board"));
      });
    });

    // Hydrate text field changes on unload so we don't lose input between steps.
    const role = document.getElementById("ob-role");
    if (role) role.addEventListener("input", function () { viewState.targetRole = role.value; });
    const loc = document.getElementById("ob-location");
    if (loc) loc.addEventListener("input", function () { viewState.location = loc.value; });
    const rem = document.getElementById("ob-remote");
    if (rem) rem.addEventListener("change", function () { viewState.remotePref = rem.value; });
    const res = document.getElementById("ob-resume");
    if (res) res.addEventListener("input", function () { viewState.resumeText = res.value; });

    // Enter on step 1 role input advances.
    if (role) {
      role.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); onNext(); }
      });
    }
  }

  function renderRoute() {
    const outlet = document.getElementById("route-view");
    if (outlet) outlet.innerHTML = renderView();
    bindHandlers();
  }

  // Pre-hydrate from any existing profile (so re-entering edits don't wipe).
  async function hydrateFromProfile() {
    try {
      const p = await fetchProfile();
      if (p && p.preferences) {
        const pref = p.preferences || {};
        const jp = (pref.jobPreferences && typeof pref.jobPreferences === "object") ? pref.jobPreferences : null;
        const roleProfile = jp && jp.roleProfile ? jp.roleProfile : null;
        const firstRole = roleProfile && Array.isArray(roleProfile.targetTitles) && roleProfile.targetTitles[0]
          ? roleProfile.targetTitles[0]
          : "";
        if (pref.targetRole || firstRole) viewState.targetRole = pref.targetRole || firstRole;
        if (pref.location || (jp && jp.location)) viewState.location = pref.location || jp.location;
        if (pref.remote) viewState.remotePref = pref.remote;
        else if (jp && typeof jp.remoteOnly === "boolean") viewState.remotePref = jp.remoteOnly ? "remote" : "any";
        if (Array.isArray(pref.industries)) viewState.industries = pref.industries.slice(0, 3);
        if (Array.isArray(pref.boards) && pref.boards.length) viewState.boards = pref.boards;
      }
    } catch (e) { /* ignore */ }
    renderRoute();
  }

  window.CBV2.routes.onboarding = renderView;
  window.CBV2.afterRender.onboarding = function () {
    bindHandlers();
    hydrateFromProfile();
  };

  window.CBV2.onboarding = {
    fetchProfile: fetchProfile,
    saveProfile: saveProfile
  };
})();
