// Apply Assist — Greenhouse content script (Phase 2a stub).
//
// Phase 2a scope:
//   - Detect when we're on a Greenhouse application form.
//   - Ask background.js for an apply intent matching this URL.
//   - Log the result so we can verify the bridge end-to-end.
//
// Phase 2b will replace this stub with the full adapter (field detection,
// fill logic, file upload, floating panel UI). Until then the script is
// observably inert — no DOM changes, no network calls outside the
// extension boundary, no risk of breaking the existing capture flow on
// Greenhouse job-listing pages.

(function () {
  // Apply pages on Greenhouse follow predictable shapes:
  //   - boards.greenhouse.io/{company}/jobs/{id}/apply        (older)
  //   - job-boards.greenhouse.io/{company}/jobs/{id}          (newer; form embedded)
  //   - {company}.greenhouse.io/jobs/{id}/apply               (legacy custom)
  // The strongest signal across all three is an <form id="application_form">
  // or the presence of the file-upload row used by every Greenhouse form.
  function looksLikeApplyForm() {
    if (document.getElementById("application_form")) return true;
    if (document.querySelector("form[action*='applications']")) return true;
    if (document.querySelector("input[type='file'][name*='resume']")) return true;
    // The newer embedded form has divs with these data attributes:
    if (document.querySelector("[data-test='apply-now-button']")) return false; // unopened apply CTA, not the form itself
    return false;
  }

  function log(label, data) {
    // Tag every log so it's grep-friendly when users send debug reports.
    if (data !== undefined) console.log("[CareerBoost Apply Assist] " + label, data);
    else console.log("[CareerBoost Apply Assist] " + label);
  }

  async function lookupIntent() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({
          type: "CB_APPLY_INTENT_LOOKUP",
          applyUrl: location.href,
          consume: false
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

  async function bootstrap() {
    if (!looksLikeApplyForm()) {
      // Capture-flow content script handles the job listing case; we
      // stay quiet to avoid double-injection.
      return;
    }
    log("Greenhouse apply form detected: " + location.href);
    const intent = await lookupIntent();
    if (!intent) {
      log("No active apply intent found for this URL. (Did you click 'Apply Assist' from CareerBoost?)");
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
    // Phase 2b: hand `intent` to the Greenhouse adapter + render the panel.
  }

  // Apply forms sometimes hydrate after document_idle (especially the newer
  // embedded ones). Retry once a second for ~5s before giving up.
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
