// Apply Assist — Greenhouse adapter (Phase 2b).
//
// Greenhouse runs in two flavours that we need to support:
//
//   1. Classic boards (boards.greenhouse.io/{co}/jobs/{id}/apply)
//      Server-rendered Rails form. Field IDs are stable:
//        #first_name, #last_name, #email, #phone, #resume, #cover_letter
//      Custom screening questions render as:
//        #job_application_answers_attributes_{i}_text_value
//        with a sibling <label>.
//
//   2. New embedded boards (job-boards.greenhouse.io/{co}/jobs/{id})
//      React-rendered form embedded into the listing page. IDs are less
//      stable, so we lean on aria-label / labels + autocomplete tokens.
//
// We always try classic selectors first, then fall back to label-based
// lookup via the shared adapter-base helpers.
//
// Public surface: window.__CBApplyAssistGreenhouse = { fill(intent, hooks) }
//
//   intent.payload.profile     = applyAssist profile snapshot from web app
//   intent.payload.resume      = { filename, mime, base64 }   (may be absent)
//   intent.payload.coverLetter = { text }                     (Phase 3+)
//
//   hooks = { onProgress(stat), onScreeningQuestion(q) } — both optional
//
// Returns: { filled, skipped, screening, errors, totals }

(function () {
  if (window.__CBApplyAssistGreenhouse) return;
  const base = window.__CBApplyAssistBase;
  if (!base) {
    console.warn("[CareerBoost Apply Assist] adapter-base.js missing — Greenhouse adapter cannot run.");
    return;
  }

  // ---------- field map ----------
  //
  // Each entry: array of selectors tried in order. Empty/invalid selectors
  // are skipped silently. Order matters: classic IDs first, then generic
  // attribute selectors, finally autocomplete tokens for the newest forms.
  const FIELD_SELECTORS = {
    firstName: [
      "#first_name",
      "input[name='job_application[first_name]']",
      "input[autocomplete='given-name']",
      "input[name='firstName']"
    ],
    lastName: [
      "#last_name",
      "input[name='job_application[last_name]']",
      "input[autocomplete='family-name']",
      "input[name='lastName']"
    ],
    email: [
      "#email",
      "input[type='email']",
      "input[autocomplete='email']",
      "input[name='email']"
    ],
    phone: [
      "#phone",
      "input[type='tel']",
      "input[autocomplete='tel']",
      "input[name='phone']"
    ],
    location: [
      "#job_application_location",
      "input[name='job_application[location]']",
      "input[autocomplete='address-level2']",
      "input[name='location']"
    ],
    resume: [
      "#resume",
      "input[type='file'][name*='resume' i]",
      "input[type='file'][id*='resume' i]"
    ],
    coverLetterFile: [
      "#cover_letter",
      "input[type='file'][name*='cover_letter' i]",
      "input[type='file'][id*='cover_letter' i]"
    ],
    coverLetterText: [
      "textarea[name*='cover_letter' i]",
      "textarea[id*='cover_letter' i]"
    ]
  };

  // Label fallback patterns — used when selectors come up empty AND for
  // links (which Greenhouse renders as custom "URLs" fields with the
  // network name in the label, e.g. "LinkedIn URL").
  const LABEL_FALLBACKS = {
    firstName:    ["first name", "given name"],
    lastName:     ["last name", "family name", "surname"],
    email:        ["email"],
    phone:        ["phone"],
    location:     ["location", "city"],
    linkedin:     ["linkedin"],
    github:       ["github"],
    portfolio:    ["portfolio"],
    website:      ["website", "personal site"]
  };

  function findField(kind) {
    const fromSel = base.findFirst(FIELD_SELECTORS[kind] || []);
    if (fromSel) return fromSel;
    const labels = LABEL_FALLBACKS[kind] || [];
    for (let i = 0; i < labels.length; i += 1) {
      const hit = base.findByLabel(labels[i]);
      if (hit) return hit;
    }
    return null;
  }

  // ---------- screening-question detection ----------
  //
  // Greenhouse renders custom questions in a few shapes:
  //   - Text:    #job_application_answers_attributes_{i}_text_value
  //   - Long:    textarea inside .application-question
  //   - Single:  input[type='radio'][name='job_application[answers_attributes][{i}][boolean_value]']
  //   - Select:  select inside .application-question
  //
  // We collect them generically by walking the application form for any
  // field whose closest ".question" / ".application-question" ancestor
  // has visible label text we haven't already filled from the profile map.
  function collectScreeningQuestions(alreadyFilledInputs) {
    const filled = new Set(alreadyFilledInputs);
    const wrappers = Array.from(document.querySelectorAll(
      ".application-question, .field--custom, [class*='custom-question']"
    ));
    const out = [];
    wrappers.forEach(function (wrap) {
      const labelEl = wrap.querySelector("label, .question-label, legend");
      const labelText = labelEl ? String(labelEl.textContent || "").replace(/\s+/g, " ").trim() : "";
      if (!labelText) return;
      const fields = Array.from(wrap.querySelectorAll("input, select, textarea"))
        .filter(function (el) { return base.isVisible(el) && !filled.has(el); });
      if (!fields.length) return;
      out.push({
        wrapper: wrap,
        labelText: labelText,
        fields: fields,
        required: !!wrap.querySelector("[aria-required='true'], .required, .field--required")
      });
    });
    return out;
  }

  // ---------- main fill orchestration ----------

  async function fill(intent, hooks) {
    hooks = hooks || {};
    const onProgress = typeof hooks.onProgress === "function" ? hooks.onProgress : null;
    const onScreening = typeof hooks.onScreeningQuestion === "function" ? hooks.onScreeningQuestion : null;

    const payload = (intent && intent.payload) || {};
    const profile = payload.profile && typeof payload.profile === "object" ? payload.profile : {};
    const identity = profile.identity || {};
    const location = identity.location || {};
    const links = profile.links || {};

    const stats = {
      filled: 0,
      skipped: 0,
      errors: 0,
      screening: 0,
      details: [] // [{label, kind, status}]
    };
    const filledInputs = [];

    function tryFill(kind, value) {
      if (value == null || value === "") {
        stats.skipped += 1;
        return false;
      }
      const input = findField(kind);
      if (!input) {
        stats.skipped += 1;
        stats.details.push({ kind: kind, label: base.labelTextFor(input) || kind, status: "not-on-form" });
        return false;
      }
      let ok = false;
      if (input.tagName === "SELECT") ok = base.setSelect(input, value);
      else if (input.type === "checkbox") ok = base.setCheckbox(input, Boolean(value));
      else ok = base.setReactValue(input, value);
      if (ok) {
        stats.filled += 1;
        filledInputs.push(input);
        base.highlight(input, "ok");
        stats.details.push({ kind: kind, label: base.labelTextFor(input) || kind, status: "filled" });
        if (onProgress) onProgress(stats);
      } else {
        stats.errors += 1;
        base.highlight(input, "error");
        stats.details.push({ kind: kind, label: base.labelTextFor(input) || kind, status: "fill-failed" });
      }
      return ok;
    }

    // Identity + contact
    tryFill("firstName", identity.legalFirstName || identity.preferredName);
    tryFill("lastName",  identity.legalLastName);
    tryFill("email",     identity.email);
    tryFill("phone",     identity.phone);
    tryFill("location",  [location.city, location.state, location.country].filter(Boolean).join(", "));

    // Links — Greenhouse usually renders one "Website" field by default;
    // custom forms expose LinkedIn/GitHub separately via label.
    tryFill("linkedin",  links.linkedin);
    tryFill("github",    links.github);
    tryFill("portfolio", links.portfolio || links.website);
    tryFill("website",   links.website);

    // Resume file upload (only when the page actually has a file input).
    if (payload.resume && payload.resume.base64) {
      const resumeInput = findField("resume");
      if (resumeInput) {
        try {
          const file = base.base64ToFile(
            payload.resume.base64,
            payload.resume.filename || "resume.pdf",
            payload.resume.mime || "application/pdf"
          );
          const ok = base.uploadFile(resumeInput, file);
          if (ok) {
            stats.filled += 1;
            filledInputs.push(resumeInput);
            base.highlight(resumeInput, "ok");
            stats.details.push({ kind: "resume", label: "Resume", status: "filled" });
            if (onProgress) onProgress(stats);
          } else {
            stats.errors += 1;
            base.highlight(resumeInput, "error");
            stats.details.push({ kind: "resume", label: "Resume", status: "upload-blocked" });
          }
        } catch (e) {
          stats.errors += 1;
          stats.details.push({ kind: "resume", label: "Resume", status: "upload-threw: " + (e && e.message) });
        }
      } else {
        stats.skipped += 1;
      }
    }

    // Cover letter as text (Phase 3 will populate from AI). Phase 2b only
    // wires the plumbing — if the intent ships a coverLetter.text we drop
    // it into the textarea when one exists.
    if (payload.coverLetter && payload.coverLetter.text) {
      const cv = findField("coverLetterText");
      if (cv) {
        const ok = base.setReactValue(cv, payload.coverLetter.text);
        if (ok) {
          stats.filled += 1;
          filledInputs.push(cv);
          base.highlight(cv, "ok");
          stats.details.push({ kind: "coverLetter", label: "Cover letter", status: "filled" });
          if (onProgress) onProgress(stats);
        }
      }
    }

    // Screening questions: highlight + count + emit. We do NOT auto-fill
    // these — that's Phase 3 (screening-answer AI skill). Yellow border
    // signals "you need to look at this".
    const screening = collectScreeningQuestions(filledInputs);
    screening.forEach(function (q) {
      q.fields.forEach(function (f) { base.highlight(f, "screening"); });
      stats.screening += 1;
      if (onScreening) onScreening(q);
    });

    stats.totals = {
      filled: stats.filled,
      skipped: stats.skipped,
      errors: stats.errors,
      screening: stats.screening
    };
    if (onProgress) onProgress(stats);
    return stats;
  }

  window.__CBApplyAssistGreenhouse = { fill: fill };
})();
