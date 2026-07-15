// Settings → AI personalization (mode, tone, length, per-module toggles,
// consent) + local usage stats.
//
// P1: extracted from settings.route.js. Self-contained render()/bind() with its
// own save-state and section-scoped re-render (saving swaps only this card via
// its .settings-ai-card container). Writes through settingsShared so it can't
// clobber other sections' preferences.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsAi = window.CBV2.settingsAi || {};

  let status = { dirty: false, kind: "idle", text: "" };

  function statusText() { return status.dirty ? "Unsaved changes." : (status.text || "No recent changes."); }
  function statusKind() { return status.dirty ? "pending" : (status.kind || "idle"); }

  function setStatus(patch) {
    status = Object.assign({}, status, patch || {});
    const line = document.querySelector(".settings-ai-card .settings-save-state");
    if (line) {
      line.textContent = statusText();
      line.className = "settings-save-state settings-save-state--" + statusKind();
    }
  }

  function rerenderSection() {
    const el = document.querySelector(".settings-ai-card");
    if (!el) return;
    el.outerHTML = render();
    bind();
  }

  function getMetricNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function renderAiUsageStats(telemetry) {
    const st = window.CBV2.sanitizeText;
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

  function render() {
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
    return `
      <section class="card panel-lg settings-section settings-ai-card">
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
        <p class="settings-save-state settings-save-state--${statusKind()}">${statusText()}</p>
        ${renderAiUsageStats(telemetry)}
      </section>
    `;
  }

  function bind() {
    const form = document.getElementById("ai-preferences-form");
    if (!form) return;
    const markDirty = function () {
      setStatus({ dirty: true, kind: "pending", text: "Unsaved changes." });
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
        await window.CBV2.settingsShared.savePreferencePatch({ aiPreferences: next });
        if (!next.consentTelemetry && window.CBAI && window.CBAI.telemetry && typeof window.CBAI.telemetry.clear === "function") {
          window.CBAI.telemetry.clear();
        }
        setStatus({ dirty: false, kind: "success", text: "Saved & synced." });
        if (window.CBV2.toast) window.CBV2.toast.success("AI preferences saved.");
      } catch (err) {
        setStatus({ dirty: false, kind: "error", text: "Save failed." });
        if (window.CBV2.toast) window.CBV2.toast.error("AI preferences save failed.");
      }
      rerenderSection();
    });
  }

  window.CBV2.settingsAi.render = render;
  window.CBV2.settingsAi.bind = bind;
})();
