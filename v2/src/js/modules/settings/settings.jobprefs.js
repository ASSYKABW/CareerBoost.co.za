// Settings → Job Search Profile (target roles, skills, location, remote,
// recency, seniority, strict mode) + one-time legacy backfill.
//
// P1: extracted from settings.route.js. Self-contained render()/bind() with its
// own save-state + section-scoped re-render (.settings-jobprefs-card). Saving
// updates the in-memory Job Search defaults (store.setJobSearchState) AND the
// cloud profile via settingsShared (serialized + deep-merged).
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsJobPrefs = window.CBV2.settingsJobPrefs || {};

  // Trailing note shown on the save-state line in every state.
  const TRAILER = " These values also update in-memory Job Search defaults instantly.";
  let status = { dirty: false, kind: "idle", text: "" };
  let prefMigrationTried = false;

  function statusText() { return status.dirty ? "Unsaved changes." : (status.text || "No recent changes."); }
  function statusKind() { return status.dirty ? "pending" : (status.kind || "idle"); }

  function setStatus(patch) {
    status = Object.assign({}, status, patch || {});
    const line = document.querySelector(".settings-jobprefs-card .settings-save-state");
    if (line) {
      line.textContent = statusText() + TRAILER;
      line.className = "settings-save-state settings-save-state--" + statusKind();
    }
  }

  function rerenderSection() {
    const el = document.querySelector(".settings-jobprefs-card");
    if (!el) return;
    el.outerHTML = render();
    bind();
  }

  function savePrefs(patch) {
    return (window.CBV2.settingsShared && window.CBV2.settingsShared.savePreferencePatch)
      ? window.CBV2.settingsShared.savePreferencePatch(patch)
      : Promise.resolve(null);
  }

  function render() {
    const st = window.CBV2.sanitizeText;
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
    return `
      <section class="card panel-lg settings-section settings-jobprefs-card">
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
        <p class="settings-save-state settings-save-state--${st(statusKind())}">${st(statusText())}${TRAILER}</p>
      </section>
    `;
  }

  function bind() {
    const form = document.getElementById("job-preferences-form");
    if (!form) return;
    const markDirty = function () { setStatus({ dirty: true, kind: "pending", text: "Unsaved changes." }); };
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
        await savePrefs({
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
        setStatus({ dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("Preferences saved.");
      } catch (err) {
        setStatus({ dirty: false, kind: "error", text: "Saved locally. Cloud sync failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("Cloud sync failed.");
      }
      rerenderSection();
    });
  }

  // One-time migration of legacy flat prefs (targetRole/location/remote) into
  // the structured jobPreferences object. No-ops once jobPreferences exists.
  async function backfill() {
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
      await savePrefs({ jobPreferences: jobPreferences });
    } catch (e) {
      // Non-fatal. Migration can retry on next route mount.
      prefMigrationTried = false;
    }
  }

  window.CBV2.settingsJobPrefs.render = render;
  window.CBV2.settingsJobPrefs.bind = bind;
  window.CBV2.settingsJobPrefs.backfill = backfill;
})();
