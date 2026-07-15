// Settings → Profile & avatar, plus the shared identity widgets.
//
// P1: extracted from settings.route.js. Unlike the other section extractions,
// the profile "hero" + completeness are ALSO used by the Overview tab, so this
// module exposes them (renderHero, computeCompleteness) for route.js to call
// alongside the Profile-tab render()/bind(). Avatar upload/remove/refresh keep
// a full renderCurrentRoute() — the avatar also appears in the sidebar + hero,
// so a section-scoped swap wouldn't be enough there; the field save updates in
// place (status line only) as before.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsProfile = window.CBV2.settingsProfile || {};

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
    const st = window.CBV2.sanitizeText;
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

  function computeCompleteness(user, profile, roleProfile) {
    let score = 0;
    if (user && user.email) score += 20;
    if (profile && profile.full_name) score += 25;
    if (profile && profile.headline) score += 20;
    if (profile && profile.avatar_url) score += 15;
    if (roleProfile && Array.isArray(roleProfile.targetTitles) && roleProfile.targetTitles.length) score += 20;
    return Math.max(0, Math.min(100, score));
  }

  function getCompletionTasks(user, profile, roleProfile) {
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

  function renderHero() {
    const st = window.CBV2.sanitizeText;
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
    const completeness = computeCompleteness(user, profile, roleProfile);
    const tasks = getCompletionTasks(user, profile, roleProfile);
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

  function render() {
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    if (!backendOn) return "";
    const auth = window.CBV2.auth;
    if (!auth || !auth.isAuthenticated()) return "";
    const st = window.CBV2.sanitizeText;
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
    el.innerHTML = message ? icon + window.CBV2.sanitizeText(message) : "";
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

  function bind() {
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

  window.CBV2.settingsProfile.render = render;
  window.CBV2.settingsProfile.bind = bind;
  window.CBV2.settingsProfile.renderHero = renderHero;
  window.CBV2.settingsProfile.computeCompleteness = computeCompleteness;
})();
