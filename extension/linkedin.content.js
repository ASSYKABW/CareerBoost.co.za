(function () {
  const ROOT_ID = "careerboost-linkedin-root";
  const MODAL_ID = "careerboost-linkedin-modal";
  let lastUrl = "";
  let observerTimer = 0;

  function textOf(selector) {
    const el = document.querySelector(selector);
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const text = textOf(selector);
      if (text) return text;
    }
    return "";
  }

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function cleanMultiline(text) {
    return String(text || "")
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .split(/\n+/)
      .map(function (line) { return line.replace(/[ ]{2,}/g, " ").trim(); })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function canonicalLinkedInJobUrl() {
    const href = location.href;
    const viewMatch = href.match(/linkedin\.com\/jobs\/view\/(\d+)/i);
    if (viewMatch) return `https://www.linkedin.com/jobs/view/${viewMatch[1]}/`;
    try {
      const u = new URL(href);
      const currentJobId = u.searchParams.get("currentJobId");
      if (currentJobId) return `https://www.linkedin.com/jobs/view/${currentJobId}/`;
      u.hash = "";
      return u.href;
    } catch (_err) {
      return href;
    }
  }

  function extractDescription() {
    const selectors = [
      "#job-details",
      ".jobs-description__content",
      ".jobs-box__html-content",
      ".description__text",
      "[data-test-job-description]"
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return cleanMultiline(el.innerText || el.textContent).slice(0, 24000);
    }
    return "";
  }

  function extractJob() {
    const title = firstText([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title h1",
      ".jobs-unified-top-card__job-title",
      ".top-card-layout__title",
      "h1"
    ]);
    const company = firstText([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      ".topcard__flavor"
    ]);
    const location = firstText([
      ".job-details-jobs-unified-top-card__primary-description-container .tvm__text",
      ".jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__workplace-type",
      ".topcard__flavor--bullet",
      "[data-test-job-location]"
    ]);
    const descriptionText = extractDescription();
    const combined = `${title} ${location} ${descriptionText}`;
    return {
      title: title || "LinkedIn job",
      company: company || "LinkedIn listing",
      location: location || "",
      url: canonicalLinkedInJobUrl(),
      remote: /remote|work from home|wfh/i.test(combined),
      postedAt: null,
      tags: ["linkedin"],
      descriptionText,
      salary: null,
      logo: null
    };
  }

  function isLikelyJobPage() {
    return /linkedin\.com\/jobs\//i.test(location.href) &&
      (/\/jobs\/view\//i.test(location.href) || /currentJobId=/.test(location.href) || document.querySelector("#job-details"));
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No extension response." });
      });
    });
  }

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

  function openPreview() {
    closeModal();
    const job = extractJob();
    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="careerboost-modal-backdrop" data-careerboost-close="1"></div>
      <section class="careerboost-modal-card" role="dialog" aria-modal="true" aria-label="Save LinkedIn job to CareerBoost">
        <button type="button" class="careerboost-modal-x" data-careerboost-close="1" aria-label="Close">x</button>
        <p class="careerboost-eyebrow">CareerBoost Capture</p>
        <h2>Save this LinkedIn job to Pipeline</h2>
        <label>Job title<input id="careerboost-title" value="${escapeAttr(job.title)}" /></label>
        <label>Company<input id="careerboost-company" value="${escapeAttr(job.company)}" /></label>
        <label>Location<input id="careerboost-location" value="${escapeAttr(job.location)}" /></label>
        <label>URL<input id="careerboost-url" value="${escapeAttr(job.url)}" /></label>
        <label class="careerboost-check"><input id="careerboost-remote" type="checkbox" ${job.remote ? "checked" : ""} /> Remote / hybrid signal visible</label>
        <details>
          <summary>Description snapshot</summary>
          <textarea id="careerboost-description">${escapeHtml(job.descriptionText)}</textarea>
        </details>
        <div class="careerboost-modal-actions">
          <button type="button" class="careerboost-secondary" data-careerboost-close="1">Cancel</button>
          <button type="button" class="careerboost-primary" id="careerboost-save-job">Save to Pipeline</button>
        </div>
        <p class="careerboost-modal-status" aria-live="polite"></p>
      </section>
    `;
    document.documentElement.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target && event.target.getAttribute("data-careerboost-close") === "1") closeModal();
    });
    const save = document.getElementById("careerboost-save-job");
    if (save) {
      save.addEventListener("click", async () => {
        save.disabled = true;
        setStatus("Saving to CareerBoost...", "");
        const remoteEl = document.getElementById("careerboost-remote");
        const payload = {
          title: fieldValue("careerboost-title") || "LinkedIn job",
          company: fieldValue("careerboost-company") || "LinkedIn listing",
          location: fieldValue("careerboost-location"),
          url: fieldValue("careerboost-url") || canonicalLinkedInJobUrl(),
          remote: !!(remoteEl && remoteEl.checked),
          postedAt: null,
          tags: ["linkedin"],
          descriptionText: multilineFieldValue("careerboost-description").slice(0, 24000),
          salary: null,
          logo: null
        };
        const response = await sendMessage({
          type: "CB_IMPORT_JOB",
          job: payload,
          pageUrl: location.href
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

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function injectButton() {
    if (!isLikelyJobPage()) return;
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button type="button" class="careerboost-save-button" aria-label="Save this job to CareerBoost">
        <span class="careerboost-save-button__mark">CB</span>
        <span>Save to CareerBoost</span>
      </button>
    `;
    const button = root.querySelector("button");
    if (button) button.addEventListener("click", openPreview);
    document.documentElement.appendChild(root);
    root.classList.add("careerboost-floating");
  }

  function scheduleInject() {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const existing = document.getElementById(ROOT_ID);
        if (existing) existing.remove();
      }
      injectButton();
    }, 350);
  }

  lastUrl = location.href;
  scheduleInject();
  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
