// Apply Assist — Greenhouse content script orchestrator (Phase 2b).
//
// Detects an apply form, fetches the matching intent from background, then
// hands the intent off to the Greenhouse adapter and mounts the floating
// panel to surface progress. No DOM changes happen until an intent is
// confirmed for this URL — the script stays silent on every other
// greenhouse.io page (job listings continue to use capture-base.js).
//
// FEATURE GATE: APPLY_ASSIST_ENABLED defaults to false because V1 only
// supports Greenhouse. Shipping a one-ATS panel to every greenhouse.io
// visitor would create a confusing dead-end ("click Apply Assist from
// CareerBoost… but the button doesn't exist yet"). Flip to true once
// (a) at least one more ATS adapter ships (Lever) AND (b) the
// corresponding web-app feature flag is on. Keep these two in sync.

const APPLY_ASSIST_ENABLED = false;

(function () {
  if (!APPLY_ASSIST_ENABLED) return;

  function looksLikeApplyForm() {
    if (document.getElementById("application_form")) return true;
    if (document.querySelector("form[action*='applications']")) return true;
    if (document.querySelector("input[type='file'][name*='resume' i]")) return true;
    if (document.querySelector("input[type='file'][id*='resume' i]")) return true;
    return false;
  }

  function log(label, data) {
    if (data !== undefined) console.log("[CareerBoost Apply Assist] " + label, data);
    else console.log("[CareerBoost Apply Assist] " + label);
  }

  function lookupIntent(consume) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({
          type: "CB_APPLY_INTENT_LOOKUP",
          applyUrl: location.href,
          consume: !!consume
        }, function (response) {
          if (chrome.runtime.lastError) {
            log("intent lookup error", chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response && response.ok ? response.intent : null);
        });
      } catch (e) {
        log("intent lookup threw", e && e.message);
        resolve(null);
      }
    });
  }

  async function runFill(intent) {
    const panel = window.__CBApplyAssistPanel;
    const greenhouse = window.__CBApplyAssistGreenhouse;
    if (!greenhouse || typeof greenhouse.fill !== "function") {
      log("Greenhouse adapter not loaded");
      if (panel) panel.setKind("error", { error: "Greenhouse adapter not loaded." });
      return;
    }

    if (panel) panel.show({ kind: "filling", intent: intent, stats: { filled: 0, skipped: 0, errors: 0, screening: 0 } });

    let stats;
    try {
      stats = await greenhouse.fill(intent, {
        onProgress: function (s) { if (panel) panel.updateStats(s); }
      });
    } catch (e) {
      log("adapter threw", e && e.message);
      if (panel) panel.setKind("error", { error: (e && e.message) || "Adapter threw." });
      return;
    }

    log("fill complete", stats);
    if (panel) panel.setKind("filled", { stats: stats });
  }

  async function bootstrap() {
    if (!looksLikeApplyForm()) {
      // Quiet: this is a job listing page or some other greenhouse URL.
      return;
    }
    log("Greenhouse apply form detected: " + location.href);

    const panel = window.__CBApplyAssistPanel;
    const intent = await lookupIntent(false);

    if (!intent) {
      log("No active apply intent for this URL.");
      if (panel) panel.show({ kind: "no-intent" });
      return;
    }
    log("Loaded apply intent", {
      id: intent.id,
      jobId: intent.payload && intent.payload.jobId,
      hasResume: !!(intent.payload && intent.payload.resume),
      hasProfile: !!(intent.payload && intent.payload.profile),
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt
    });

    await runFill(intent);

    // Wire the panel's Re-fill button so the user can re-trigger the
    // adapter without re-loading the page. Re-fill consumes the cached
    // intent the first time only; subsequent re-fills reuse what's still
    // in memory (we keep `intent` in this closure).
    if (panel && typeof panel.onRefill === "function") {
      panel.onRefill(function () { runFill(intent); });
    }
  }

  // Greenhouse forms occasionally hydrate after document_idle (especially
  // the newer embedded variant). Poll for up to ~5s before giving up.
  let tries = 0;
  function poll() {
    if (looksLikeApplyForm()) {
      bootstrap();
      return;
    }
    tries += 1;
    if (tries < 6) setTimeout(poll, 1000);
  }
  poll();
})();
