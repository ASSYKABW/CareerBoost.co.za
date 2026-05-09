// Shared button + preview-modal infrastructure for all vendor content scripts.
//
// Phase 6 refactor: previously every vendor (LinkedIn) duplicated ~150 lines
// of UI plumbing — button injection, modal markup, save handler, status
// messaging. Adding Indeed/Greenhouse/Lever would have meant 4× of that.
// Now each vendor script is ~30 lines that calls __CBCapture.setupAutoInject
// with vendor-specific extractors and URL canonicalizers.
//
// Vendor scripts inject this file FIRST in their manifest entry, then their
// own content script. Both run in the same isolated world so window.__CBCapture
// is available to the vendor script as a normal global.

(function () {
  if (window.__CBCapture) return;

  const ROOT_ID = "careerboost-capture-root";
  const MODAL_ID = "careerboost-capture-modal";

  // ---------- HTML helpers ----------
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }
  function clean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }
  function cleanMultiline(value) {
    return String(value == null ? "" : value)
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .split(/\n+/)
      .map(function (line) { return line.replace(/[ ]{2,}/g, " ").trim(); })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  // ---------- Cross-script messaging ----------
  function sendMessage(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(payload, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "No extension response." });
        });
      } catch (err) {
        resolve({ ok: false, error: (err && err.message) || "Send failed." });
      }
    });
  }

  // ---------- Modal lifecycle ----------
  function setStatus(text, tone) {
    const el = document.querySelector(".careerboost-modal-status");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.tone = tone || "";
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
  }

  function fieldValue(id) {
    const el = document.getElementById(id);
    return el ? clean(el.value) : "";
  }

  function multilineFieldValue(id) {
    const el = document.getElementById(id);
    return el ? cleanMultiline(el.value) : "";
  }

  function openPreview(opts) {
    closeModal();
    const job = opts.job;
    const vendor = opts.vendor || "extension";
    const pageUrl = opts.pageUrl || (typeof location !== "undefined" ? location.href : "");
    const diagnostics = opts.diagnostics || null;

    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.innerHTML =
      '<div class="careerboost-modal-backdrop" data-careerboost-close="1"></div>' +
      '<section class="careerboost-modal-card" role="dialog" aria-modal="true" aria-label="Save job to CareerBoost">' +
        '<button type="button" class="careerboost-modal-x" data-careerboost-close="1" aria-label="Close">x</button>' +
        '<p class="careerboost-eyebrow">CareerBoost Capture · ' + escapeHtml(vendor) + '</p>' +
        '<h2>Save this job to your Pipeline</h2>' +
        '<label>Job title<input id="careerboost-title" value="' + escapeAttr(job.title || "") + '" /></label>' +
        '<label>Company<input id="careerboost-company" value="' + escapeAttr(job.company || "") + '" /></label>' +
        '<label>Location<input id="careerboost-location" value="' + escapeAttr(job.location || "") + '" /></label>' +
        '<label>URL<input id="careerboost-url" value="' + escapeAttr(job.url || pageUrl) + '" /></label>' +
        '<label class="careerboost-check"><input id="careerboost-remote" type="checkbox"' + (job.remote ? " checked" : "") + ' /> Remote / hybrid signal visible</label>' +
        '<details>' +
          '<summary>Description snapshot</summary>' +
          '<textarea id="careerboost-description">' + escapeHtml(job.descriptionText || "") + '</textarea>' +
        '</details>' +
        '<div class="careerboost-modal-actions">' +
          '<button type="button" class="careerboost-secondary" data-careerboost-close="1">Cancel</button>' +
          '<button type="button" class="careerboost-primary" id="careerboost-save-job">Save to Pipeline</button>' +
        '</div>' +
        '<p class="careerboost-modal-status" aria-live="polite"></p>' +
      '</section>';
    document.documentElement.appendChild(modal);

    modal.addEventListener("click", function (event) {
      if (event.target && event.target.getAttribute && event.target.getAttribute("data-careerboost-close") === "1") {
        closeModal();
      }
    });

    const save = document.getElementById("careerboost-save-job");
    if (save) {
      save.addEventListener("click", async function () {
        save.disabled = true;
        setStatus("Saving to CareerBoost...", "");
        const remoteEl = document.getElementById("careerboost-remote");
        const payload = {
          title: fieldValue("careerboost-title") || job.title || "Job posting",
          company: fieldValue("careerboost-company") || job.company || "Unknown company",
          location: fieldValue("careerboost-location"),
          url: fieldValue("careerboost-url") || pageUrl,
          remote: !!(remoteEl && remoteEl.checked),
          postedAt: job.postedAt || null,
          tags: Array.isArray(job.tags) ? job.tags : [vendor],
          descriptionText: multilineFieldValue("careerboost-description").slice(0, 24000),
          salary: job.salary || null,
          logo: job.logo || null
        };
        const response = await sendMessage({
          type: "CB_IMPORT_JOB",
          job: payload,
          pageUrl: pageUrl,
          vendor: vendor,
          // Phase 6: extraction diagnostics so the backend can detect when
          // a vendor's adapter starts returning weak data (vendor changed
          // their HTML or stopped shipping JSON-LD).
          diagnostics: Object.assign({
            extractor: job._source || "selectors",
            titleLen: payload.title ? payload.title.length : 0,
            descriptionLen: payload.descriptionText ? payload.descriptionText.length : 0,
            hadJsonLd: job._source === "json-ld"
          }, diagnostics || {})
        });
        save.disabled = false;
        if (!response || !response.ok) {
          const msg = response && response.error ? response.error : "Could not save this job.";
          setStatus(msg, "error");
          if (/not connected|sign in|session|refresh token|reconnect/i.test(msg)) {
            sendMessage({ type: "CB_OPEN_OPTIONS" });
          }
          return;
        }
        setStatus("Saved to your CareerBoost Pipeline.", "success");
        setTimeout(closeModal, 900);
      });
    }
  }

  // ---------- Button injection ----------
  function injectButton(opts) {
    if (!opts.isJobPage()) return;
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.dataset.vendor = opts.vendor || "";
    root.innerHTML =
      '<button type="button" class="careerboost-save-button" aria-label="Save this job to CareerBoost">' +
        '<span class="careerboost-save-button__mark">CB</span>' +
        '<span>Save to CareerBoost</span>' +
      '</button>';
    const button = root.querySelector("button");
    if (button) {
      button.addEventListener("click", function () {
        const job = opts.extractJob();
        if (!job || !job.title) {
          // Surface a tiny inline note rather than failing silently. The user
          // can paste/edit fields in the modal even if extraction was thin.
          openPreview({
            job: { title: "", company: "", location: "", descriptionText: "", _source: "manual" },
            vendor: opts.vendor,
            pageUrl: location.href,
            diagnostics: { reason: "extractor returned empty" }
          });
          return;
        }
        openPreview({
          job: job,
          vendor: opts.vendor,
          pageUrl: location.href,
          diagnostics: opts.diagnostics ? opts.diagnostics() : null
        });
      });
    }
    document.documentElement.appendChild(root);
    root.classList.add("careerboost-floating");
  }

  // ---------- URL-change observer (SPA navigation) ----------
  function setupAutoInject(opts) {
    if (!opts || typeof opts.isJobPage !== "function" || typeof opts.extractJob !== "function") {
      console.warn("[CBCapture] setupAutoInject called without required isJobPage/extractJob.");
      return;
    }
    let lastUrl = location.href;
    let observerTimer = 0;

    function schedule() {
      window.clearTimeout(observerTimer);
      observerTimer = window.setTimeout(function () {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          const existing = document.getElementById(ROOT_ID);
          if (existing) existing.remove();
        }
        injectButton(opts);
      }, 350);
    }

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return observer;
  }

  window.__CBCapture = {
    setupAutoInject: setupAutoInject,
    openPreview: openPreview,
    closeModal: closeModal,
    sendMessage: sendMessage,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    clean: clean,
    cleanMultiline: cleanMultiline
  };
})();
