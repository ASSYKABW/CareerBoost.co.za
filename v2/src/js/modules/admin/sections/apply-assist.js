// Admin section — "Apply Assist (deferred)".
//
// Reminder card for the deferred Apply Assist feature. The code shipped
// (Phases 1, 2a, 2b, 2c, 2c+) but is hidden behind a feature flag because
// V1 only supports Greenhouse — surfacing a one-ATS button would confuse
// users who try LinkedIn/Indeed and conclude the product is broken.
//
// This section documents:
//   - What was shipped vs. what's deferred
//   - Where the feature flag lives
//   - What gates re-enabling
//   - A session-scoped "enable for me" toggle for testing
//
// Source-of-truth for the gating logic:
//   - Web app:   CB_CONFIG.featureFlags.applyAssist (v2/src/js/app/config.js)
//   - Extension: APPLY_ASSIST_ENABLED constant (extension/apply-assist/greenhouse.apply.js)

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.adminSections = window.CBV2.adminSections || {};

  const SHIPPED_PHASES = [
    { id: "1",   label: "Phase 1 — Apply Profile schema + Settings tab",     commit: "7827c26" },
    { id: "2a",  label: "Phase 2a — Web app ↔ extension bridge + intent store", commit: "3bcd5a4" },
    { id: "2b",  label: "Phase 2b — Greenhouse adapter + floating panel UI", commit: "1f4b34a" },
    { id: "2c",  label: "Phase 2c — Pipeline button + launch flow",          commit: "49291f5" },
    { id: "2c+", label: "Phase 2c+ — Job URL field on Add Application + drawer edit", commit: "1424be3" }
  ];

  const DEFERRED_PHASES = [
    { id: "3", label: "Phase 3 — AI suggestions for screening questions",            why: "Needs the panel + adapter from Phase 2 in production use first to learn what real questions look like." },
    { id: "4", label: "Phase 4 — Submission detection + auto-promote pipeline stage", why: "Per-ATS submit-success heuristics; clean to ship after Phase 3 telemetry exists." }
  ];

  const REENABLE_CRITERIA = [
    "At least one more ATS adapter ships (Lever is the obvious next — ~1 week, similar to Greenhouse).",
    "Web-app feature flag: set CB_CONFIG.featureFlags.applyAssist = true (v2/src/js/app/config.js).",
    "Extension: flip APPLY_ASSIST_ENABLED to true (extension/apply-assist/greenhouse.apply.js) and bump manifest version.",
    "Rebuild extension zip (node scripts/build-extension-zip.js) so the downloadable artifact matches.",
    "Smoke-test end-to-end against a real Greenhouse AND Lever apply form before announcing."
  ];

  const NEVER_SHIP_BOARDS = [
    {
      board: "LinkedIn EasyApply",
      reason: "LinkedIn ToS explicitly forbids automated form filling. Active enforcement (account bans). Lawsuit precedent (hiQ v LinkedIn). Putting users' primary job-search accounts at risk is not worth it."
    },
    {
      board: "Indeed Quick Apply",
      reason: "Popup modal flow plus similar ToS concerns. Keep as a 'handoff' source via the existing capture extension instead."
    }
  ];

  function st(s) {
    if (window.CBV2 && typeof window.CBV2.sanitizeText === "function") return window.CBV2.sanitizeText(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function currentFlagState() {
    const cfg = window.CB_CONFIG || {};
    const ff = cfg.featureFlags || {};
    return ff.applyAssist === true;
  }

  function sessionOverrideState() {
    try { return sessionStorage.getItem("cb_apply_assist_session_enabled") === "1"; }
    catch (e) { return false; }
  }

  function render(/* data */) {
    const flagOn = currentFlagState();
    const sessionOn = sessionOverrideState();
    const statusTone = flagOn ? "green" : (sessionOn ? "amber" : "subtle");
    const statusLabel = flagOn ? "Live for all users"
      : sessionOn ? "Off globally · enabled for this session"
      : "Deferred · hidden from all users";

    const shippedRows = SHIPPED_PHASES.map(function (p) {
      return (
        '<div class="admin-table-row admin-table-row--three">' +
          '<span><i class="fa-solid fa-check" style="color:#4ade80;"></i> ' + st(p.id) + '</span>' +
          '<span>' + st(p.label) + '</span>' +
          '<span><code>' + st(p.commit) + '</code></span>' +
        '</div>'
      );
    }).join("");

    const deferredRows = DEFERRED_PHASES.map(function (p) {
      return (
        '<div class="admin-action-card">' +
          '<i class="fa-solid fa-hourglass-half"></i>' +
          '<div>' +
            '<strong>' + st(p.id) + ' · ' + st(p.label) + '</strong>' +
            '<span>' + st(p.why) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    const reenableRows = REENABLE_CRITERIA.map(function (line, i) {
      return (
        '<div class="admin-action-card">' +
          '<i class="fa-solid fa-' + (i + 1) + '"></i>' +
          '<div><strong>' + st(line) + '</strong></div>' +
        '</div>'
      );
    }).join("");

    const neverShipRows = NEVER_SHIP_BOARDS.map(function (b) {
      return (
        '<div class="admin-action-card">' +
          '<i class="fa-solid fa-ban" style="color:#fbbf24;"></i>' +
          '<div>' +
            '<strong>' + st(b.board) + '</strong>' +
            '<span>' + st(b.reason) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    const toggleBtn = sessionOn
      ? '<button type="button" class="btn-ghost btn-sm" id="cb-aa-session-off"><i class="fa-solid fa-toggle-on"></i> Disable for this session</button>'
      : '<button type="button" class="btn-secondary btn-sm" id="cb-aa-session-on"><i class="fa-solid fa-toggle-off"></i> Enable for this session (testing)</button>';

    return (
      '<section class="admin-stat-grid">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head">' +
            '<div><span>Status</span><h2>Apply Assist</h2></div>' +
            '<span class="chip ' + st(statusTone) + '">' + st(statusLabel) + '</span>' +
          '</div>' +
          '<p class="admin-copy">' +
            'V1 of Apply Assist (browser extension auto-fills supported ATS forms on the candidate&rsquo;s behalf, user always clicks Submit) ' +
            'is fully built but deliberately hidden. Shipping a one-ATS feature is worse than not shipping &mdash; users who try LinkedIn or ' +
            'Indeed conclude the product is broken. Re-enable once a second ATS adapter (Lever) is in the box.' +
          '</p>' +
          '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
            toggleBtn +
          '</div>' +
        '</article>' +
      '</section>' +

      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Shipped</span><h2>Phases already in main</h2></div><span class="chip green">' + SHIPPED_PHASES.length + ' done</span></div>' +
          '<div class="admin-table">' +
            '<div class="admin-table-row admin-table-row--three admin-table-head"><span>Phase</span><span>Scope</span><span>Commit</span></div>' +
            shippedRows +
          '</div>' +
        '</article>' +

        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Deferred</span><h2>Still to build</h2></div><span class="chip amber">' + DEFERRED_PHASES.length + ' pending</span></div>' +
          '<div class="admin-action-list">' + deferredRows + '</div>' +
        '</article>' +
      '</section>' +

      '<section class="admin-grid admin-grid--two">' +
        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Re-enable checklist</span><h2>Gates before flipping the flag</h2></div></div>' +
          '<div class="admin-action-list">' + reenableRows + '</div>' +
        '</article>' +

        '<article class="admin-panel">' +
          '<div class="admin-panel-head"><div><span>Out of scope</span><h2>Boards we won&rsquo;t support</h2></div><span class="chip warning">ToS risk</span></div>' +
          '<div class="admin-action-list">' + neverShipRows + '</div>' +
        '</article>' +
      '</section>' +

      '<section class="admin-panel">' +
        '<div class="admin-panel-head"><div><span>Where to flip</span><h2>Source-of-truth files</h2></div></div>' +
        '<div class="admin-table">' +
          '<div class="admin-table-row admin-table-row--three admin-table-head"><span>Surface</span><span>File</span><span>Symbol</span></div>' +
          '<div class="admin-table-row admin-table-row--three"><span>Web app</span><span><code>v2/src/js/app/config.js</code></span><span><code>CB_CONFIG.featureFlags.applyAssist</code></span></div>' +
          '<div class="admin-table-row admin-table-row--three"><span>Extension</span><span><code>extension/apply-assist/greenhouse.apply.js</code></span><span><code>APPLY_ASSIST_ENABLED</code></span></div>' +
          '<div class="admin-table-row admin-table-row--three"><span>Manifest version</span><span><code>extension/manifest.json</code></span><span><code>version</code> (bump on re-enable)</span></div>' +
        '</div>' +
      '</section>'
    );
  }

  // Bind the session-toggle buttons after each render. admin.route's
  // dispatcher calls render() and inserts the HTML, then the click
  // handlers attach on the next user interaction via this listener.
  // We re-bind via a MutationObserver because admin sections don't
  // currently expose an afterRender hook.
  function bindToggleHandlers() {
    document.addEventListener("click", function (e) {
      const onBtn = e.target.closest && e.target.closest("#cb-aa-session-on");
      const offBtn = e.target.closest && e.target.closest("#cb-aa-session-off");
      if (onBtn) {
        try { sessionStorage.setItem("cb_apply_assist_session_enabled", "1"); } catch (_) {}
        if (window.CBV2 && window.CBV2.toast) {
          window.CBV2.toast.info("Session override on. Hard-refresh + check Settings → Apply Assist + the pipeline paper-plane.");
        }
        if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") window.CBV2.renderCurrentRoute();
      } else if (offBtn) {
        try { sessionStorage.removeItem("cb_apply_assist_session_enabled"); } catch (_) {}
        if (window.CBV2 && window.CBV2.toast) window.CBV2.toast.info("Session override cleared.");
        if (window.CBV2 && typeof window.CBV2.renderCurrentRoute === "function") window.CBV2.renderCurrentRoute();
      }
    });
  }
  bindToggleHandlers();

  window.CBV2.adminSections["apply-assist"] = { render: render };
})();
