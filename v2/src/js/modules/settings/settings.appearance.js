// Settings → Appearance (theme preset + key colors).
//
// P1: extracted from the settings.route.js monolith into a self-contained
// sub-module (render() + bind()), matching the settingsBilling / settingsPush
// pattern. Also the first section to use section-scoped re-render — saving the
// theme re-renders only this card instead of the whole Settings page.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsAppearance = window.CBV2.settingsAppearance || {};

  // Local save-state (was viewState.formStatus.appearance in the monolith).
  let status = { dirty: false, kind: "idle", text: "" };

  function statusText() { return status.dirty ? "Unsaved changes." : (status.text || "Changes apply instantly."); }
  function statusKind() { return status.dirty ? "pending" : (status.kind || "idle"); }

  function setStatus(patch) {
    status = Object.assign({}, status, patch || {});
    const line = document.querySelector(".settings-appearance-card .settings-save-state");
    if (line) {
      line.textContent = statusText();
      line.className = "settings-save-state settings-save-state--" + statusKind();
    }
  }

  // Section-scoped re-render: swap only this card's markup, then re-bind it.
  function rerenderSection() {
    const el = document.querySelector(".settings-appearance-card");
    if (!el) return;
    el.outerHTML = render();
    bind();
  }

  function render() {
    const st = window.CBV2.sanitizeText;
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
        <p class="settings-save-state settings-save-state--${st(statusKind())}">${st(statusText())}</p>
      </section>
    `;
  }

  function bind() {
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
      setStatus({ dirty: true, kind: "pending", text: "Unsaved changes." });
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
        setStatus({ dirty: true, kind: "pending", text: "Unsaved changes." });
      });
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const theme = themeApi.get ? themeApi.get() : readTheme();
      const profileApi = window.CBV2.profile;
      if (!profileApi || typeof profileApi.update !== "function") {
        setStatus({ dirty: false, kind: "success", text: "Saved locally." });
        if (window.CBV2.toast) window.CBV2.toast.success("Theme saved locally.");
        rerenderSection();
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
        setStatus({ dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("Theme saved and synced.");
      } catch (err) {
        setStatus({ dirty: false, kind: "error", text: "Saved locally. Cloud sync failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("Saved locally. Cloud sync failed.");
      }
      rerenderSection();
    });

    const reset = document.getElementById("appearance-reset");
    if (reset) {
      reset.addEventListener("click", function () {
        const next = themeApi.setPreset("aurora", true);
        const colors = next && next.colors ? next.colors : {};
        if (fieldPrimary && colors.primary) fieldPrimary.value = colors.primary;
        if (fieldBg && colors.bg) fieldBg.value = colors.bg;
        if (presetSelect) presetSelect.value = "aurora";
        setStatus({ dirty: true, kind: "pending", text: "Unsaved changes." });
      });
    }
  }

  window.CBV2.settingsAppearance.render = render;
  window.CBV2.settingsAppearance.bind = bind;
})();
