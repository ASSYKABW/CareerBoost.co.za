// Apply Assist — shared DOM helpers used by every ATS adapter.
//
// Job: do the small, finicky things consistently. Every ATS has its own
// selectors and quirks; the helpers in here handle the pieces that are
// identical across all of them (React-safe value setters, file upload via
// DataTransfer, label-based lookup, accessible highlighting).
//
// Public surface: window.__CBApplyAssistBase
//   findFirst(selectors)               → Element | null
//   findByLabel(labelText, opts)       → Element | null
//   setReactValue(input, value)        → boolean
//   setSelect(select, value)           → boolean
//   setCheckbox(input, checked)        → boolean
//   uploadFile(input, file)            → boolean
//   base64ToFile(b64, filename, mime)  → File
//   labelTextFor(input)                → string
//   highlight(input, kind)             → void  ("ok" | "warn" | "error" | "screening" | "clear")
//   isVisible(el)                      → boolean

(function () {
  if (window.__CBApplyAssistBase) return;

  // ---------- selection ----------

  function findFirst(selectors) {
    if (!Array.isArray(selectors)) selectors = [selectors];
    for (let i = 0; i < selectors.length; i += 1) {
      const sel = selectors[i];
      if (!sel) continue;
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (e) { /* invalid selector, skip */ }
    }
    return null;
  }

  // Many ATS fields are easier to find by the visible label than by selector.
  // We look at <label for="x">, wrapping <label>, aria-labelledby, and
  // aria-label. Match is case-insensitive substring by default; pass
  // { exact: true } when you need it.
  function findByLabel(labelText, opts) {
    const target = String(labelText || "").trim().toLowerCase();
    if (!target) return null;
    const exact = !!(opts && opts.exact);
    const allInputs = Array.from(document.querySelectorAll("input, select, textarea"));
    for (let i = 0; i < allInputs.length; i += 1) {
      const input = allInputs[i];
      if (!isVisible(input)) continue;
      const txt = labelTextFor(input);
      if (!txt) continue;
      const t = txt.toLowerCase();
      if (exact ? t === target : t.indexOf(target) >= 0) return input;
    }
    return null;
  }

  function labelTextFor(input) {
    if (!input) return "";
    // 1. Explicit <label for="id">
    if (input.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(input.id) + '"]');
      if (lbl) return cleanText(lbl.textContent);
    }
    // 2. Wrapping <label>
    let walker = input.parentElement;
    for (let i = 0; walker && i < 5; i += 1) {
      if (walker.tagName === "LABEL") return cleanText(walker.textContent);
      walker = walker.parentElement;
    }
    // 3. aria-labelledby
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const refs = labelledBy.split(/\s+/).map(function (id) {
        return document.getElementById(id);
      }).filter(Boolean);
      if (refs.length) {
        return cleanText(refs.map(function (r) { return r.textContent || ""; }).join(" "));
      }
    }
    // 4. aria-label
    const aria = input.getAttribute("aria-label");
    if (aria) return cleanText(aria);
    // 5. Closest field-wrapper that contains a label-like element.
    const wrapper = input.closest("[class*='field'], [class*='question'], fieldset, .form-group, .form-field");
    if (wrapper) {
      const candidate = wrapper.querySelector("label, .label, .question-label, legend");
      if (candidate) return cleanText(candidate.textContent);
    }
    // 6. Placeholder is a weak fallback but better than nothing.
    return cleanText(input.getAttribute("placeholder") || "");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/(["\\#.:>+~()[\]])/g, "\\$1");
  }

  function cleanText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    // offsetParent is null for display:none. For position:fixed elements
    // it can also be null, so we also check getClientRects as a backstop.
    if (el.offsetParent !== null) return true;
    const rects = el.getClientRects ? el.getClientRects() : null;
    return !!(rects && rects.length);
  }

  // ---------- value setters ----------

  // Native setter trick: React (and other frameworks) wrap the input's
  // value setter to observe changes. Calling input.value = x directly
  // updates the DOM but the framework's state stays stale, so the field
  // appears filled but submits empty. The fix is to call the native
  // descriptor setter and then dispatch the events frameworks listen to.
  function setReactValue(input, value) {
    if (!input) return false;
    const v = value == null ? "" : String(value);
    if (input.value === v) return true;
    try {
      const proto = input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(input, v);
      else input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      try { input.value = v; return true; } catch (_e) { return false; }
    }
  }

  // Match an option by exact value first, then case-insensitive label, then
  // a "contains" pass. Returns true when something was actually selected.
  function setSelect(select, value) {
    if (!select || select.tagName !== "SELECT") return false;
    const v = String(value == null ? "" : value);
    if (!v) return false;
    const options = Array.from(select.options || []);
    const lower = v.toLowerCase();

    let match =
      options.find(function (o) { return o.value === v; }) ||
      options.find(function (o) { return String(o.value).toLowerCase() === lower; }) ||
      options.find(function (o) { return cleanText(o.textContent).toLowerCase() === lower; }) ||
      options.find(function (o) { return cleanText(o.textContent).toLowerCase().indexOf(lower) >= 0; });

    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setCheckbox(input, checked) {
    if (!input || input.type !== "checkbox") return false;
    const desired = !!checked;
    if (input.checked === desired) return true;
    input.checked = desired;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // ---------- file upload ----------

  // Programmatic file injection. Browsers block setting .files directly
  // for security, but DataTransfer + .files = dt.files is the documented
  // escape hatch and works in Chrome/Edge for real <input type="file">.
  // Fails (returns false) inside sandboxed iframes (Workday) — caller
  // should fall back to "please upload this manually" UX.
  function uploadFile(input, file) {
    if (!input || input.tagName !== "INPUT" || input.type !== "file") return false;
    if (!(file instanceof File)) return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.files && input.files.length === 1;
    } catch (e) {
      return false;
    }
  }

  function base64ToFile(b64, filename, mime) {
    const data = String(b64 || "");
    const type = String(mime || "application/octet-stream");
    const bytes = atob(data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
    return new File([arr], String(filename || "upload"), { type });
  }

  // ---------- highlight ----------

  // Adds a class to the closest field wrapper (so the cue surrounds the
  // whole row, not just the input). Falls back to the input itself.
  function highlight(input, kind) {
    if (!input) return;
    const target =
      input.closest("[class*='field'], [class*='question'], .form-group, fieldset, label") ||
      input;
    [
      "cbaa-hl-ok",
      "cbaa-hl-warn",
      "cbaa-hl-error",
      "cbaa-hl-screening"
    ].forEach(function (cls) { target.classList.remove(cls); });
    if (kind === "ok") target.classList.add("cbaa-hl-ok");
    else if (kind === "warn") target.classList.add("cbaa-hl-warn");
    else if (kind === "error") target.classList.add("cbaa-hl-error");
    else if (kind === "screening") target.classList.add("cbaa-hl-screening");
    // "clear" falls through to no class.
  }

  window.__CBApplyAssistBase = {
    findFirst,
    findByLabel,
    setReactValue,
    setSelect,
    setCheckbox,
    uploadFile,
    base64ToFile,
    labelTextFor,
    highlight,
    isVisible
  };
})();
