// Phase 4.5: In-app modal service replacing window.confirm / .prompt /
// .alert across the candidate-facing app.
//
// Why:
//   1. Native browser dialogs can't be styled (or branded), look
//      different on every OS, and break the visual continuity of the
//      product. Candidates filling out their dream job application
//      shouldn't see a Windows-95-grade gray box.
//   2. Native confirm/prompt are SYNCHRONOUS and block the event loop —
//      which means our usage_events ticker, observability flush, and
//      auth refresh all pause until the user clicks. Promise-based
//      modals don't.
//   3. Drag-and-drop, swipe, keyboard nav etc. behave differently
//      around native modals on iOS/Android. An HTML dialog gives us
//      one consistent shape.
//
// API (drop-in replacements):
//   await window.CBV2.modal.confirm({ title, body, confirmLabel?, cancelLabel?, tone? }) → boolean
//   await window.CBV2.modal.prompt({ title, body, defaultValue?, placeholder?, multiline?, required?, validate? }) → string|null
//   await window.CBV2.modal.alert({ title, body, okLabel?, tone? }) → undefined
//
// Convenience shims for raw-string callers:
//   window.CBV2.modal.confirmText("Delete this?")
//   window.CBV2.modal.promptText("Name:", "default")
//
// Modal stack: clicking outside the card OR pressing Esc cancels the
// modal (returns false / null). Pressing Enter in a single-line prompt
// confirms. Tab is trapped within the modal so keyboard nav stays put.
//
// Tone: "default" | "danger" | "info" — colors the confirm button.
// Danger style is reserved for destructive actions (delete, demote).
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.modal && window.CBV2.modal._installed) return;

  const STACK = [];     // currently open modals, for cleanup on route change
  let stylesInjected = false;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    // We inject the modal styles inline rather than depend on the main
    // CSS bundle so the modal works even before stylesheets finish
    // loading — important for early bootstrap errors.
    const style = document.createElement("style");
    style.id = "cb-modal-service-styles";
    style.textContent = (
      ".cb-modal-backdrop{" +
        "position:fixed;inset:0;z-index:2147483646;" +
        "background:rgba(2,6,18,0.78);backdrop-filter:blur(6px);" +
        "display:flex;align-items:center;justify-content:center;" +
        "padding:20px;animation:cb-modal-fade 140ms ease;" +
      "}" +
      "@keyframes cb-modal-fade{from{opacity:0}to{opacity:1}}" +
      ".cb-modal-card{" +
        "background:linear-gradient(180deg,#101728 0%,#0a0f1d 100%);" +
        "border:1px solid rgba(94,234,212,0.18);" +
        "border-radius:16px;padding:24px;max-width:520px;width:100%;" +
        "box-shadow:0 24px 80px rgba(0,0,0,0.5);color:#f8fbff;" +
        "animation:cb-modal-pop 160ms cubic-bezier(0.16,1,0.3,1);" +
      "}" +
      "@keyframes cb-modal-pop{from{transform:scale(0.96);opacity:0}to{transform:scale(1);opacity:1}}" +
      ".cb-modal-card--danger{border-color:rgba(244,63,94,0.4);}" +
      ".cb-modal-card--info{border-color:rgba(34,227,255,0.32);}" +
      ".cb-modal-title{margin:0 0 12px;font-size:18px;font-weight:600;color:#f8fbff;}" +
      ".cb-modal-body{margin:0 0 18px;font-size:14px;line-height:1.55;color:rgba(248,251,255,0.78);}" +
      ".cb-modal-body strong{color:#f8fbff;}" +
      ".cb-modal-input{" +
        "width:100%;padding:10px 12px;border-radius:8px;" +
        "background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.12);" +
        "color:#f8fbff;font-size:14px;font-family:inherit;margin-bottom:8px;" +
      "}" +
      ".cb-modal-input:focus{outline:none;border-color:rgba(94,234,212,0.6);box-shadow:0 0 0 2px rgba(94,234,212,0.18);}" +
      ".cb-modal-textarea{min-height:96px;resize:vertical;}" +
      ".cb-modal-error{margin:4px 0 12px;font-size:12px;color:#fda4af;}" +
      ".cb-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px;}" +
      ".cb-modal-btn{" +
        "padding:9px 18px;border-radius:8px;font-size:14px;font-weight:600;" +
        "border:1px solid transparent;cursor:pointer;font-family:inherit;" +
        "transition:transform 120ms ease,background-color 120ms ease;" +
      "}" +
      ".cb-modal-btn:hover{transform:translateY(-1px);}" +
      ".cb-modal-btn--cancel{background:transparent;color:rgba(248,251,255,0.7);border-color:rgba(255,255,255,0.16);}" +
      ".cb-modal-btn--cancel:hover{background:rgba(255,255,255,0.04);color:#f8fbff;}" +
      ".cb-modal-btn--confirm{background:#5eead4;color:#062018;}" +
      ".cb-modal-btn--confirm:hover{background:#7ff0dd;}" +
      ".cb-modal-btn--danger{background:#f43f5e;color:#fff;}" +
      ".cb-modal-btn--danger:hover{background:#fb5b76;}"
    );
    document.head.appendChild(style);
  }

  function escAttr(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Core open primitive. Returns a promise that resolves with the
  // outcome of whichever button (or escape/backdrop) closed the modal.
  function open(spec) {
    injectStyles();
    return new Promise(function (resolve) {
      const backdrop = document.createElement("div");
      backdrop.className = "cb-modal-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      const tone = spec.tone === "danger" ? "danger" : spec.tone === "info" ? "info" : "default";
      const confirmClass = tone === "danger" ? "cb-modal-btn--danger" : "cb-modal-btn--confirm";

      let inputHtml = "";
      if (spec.kind === "prompt") {
        const placeholder = escAttr(spec.placeholder || "");
        const initial = escAttr(spec.defaultValue || "");
        inputHtml = spec.multiline
          ? '<textarea class="cb-modal-input cb-modal-textarea" placeholder="' + placeholder + '">' + initial + '</textarea>'
          : '<input type="text" class="cb-modal-input" placeholder="' + placeholder + '" value="' + initial + '" />';
      }

      const showCancel = spec.kind !== "alert";
      backdrop.innerHTML = (
        '<div class="cb-modal-card cb-modal-card--' + tone + '">' +
          (spec.title ? '<h2 class="cb-modal-title">' + escAttr(spec.title) + '</h2>' : '') +
          (spec.body ? '<div class="cb-modal-body">' + escAttr(spec.body) + '</div>' : '') +
          inputHtml +
          '<div class="cb-modal-error" hidden></div>' +
          '<div class="cb-modal-actions">' +
            (showCancel
              ? '<button type="button" class="cb-modal-btn cb-modal-btn--cancel" data-cb-modal="cancel">' +
                escAttr(spec.cancelLabel || "Cancel") + '</button>'
              : '') +
            '<button type="button" class="cb-modal-btn ' + confirmClass + '" data-cb-modal="confirm">' +
              escAttr(spec.confirmLabel || spec.okLabel || (spec.kind === "alert" ? "OK" : "Confirm")) +
            '</button>' +
          '</div>' +
        '</div>'
      );

      let resolved = false;
      function finish(result) {
        if (resolved) return;
        resolved = true;
        const idx = STACK.indexOf(handle);
        if (idx >= 0) STACK.splice(idx, 1);
        document.removeEventListener("keydown", onKey, true);
        try { backdrop.remove(); } catch (e) { /* ignore */ }
        // Restore focus to the element that opened the modal so keyboard
        // users land back where they were.
        try { if (spec._returnFocus && typeof spec._returnFocus.focus === "function") spec._returnFocus.focus(); } catch (e) { /* ignore */ }
        resolve(result);
      }

      function readInput() {
        const node = backdrop.querySelector(".cb-modal-input");
        return node ? String(node.value || "") : "";
      }
      function showError(msg) {
        const err = backdrop.querySelector(".cb-modal-error");
        if (!err) return;
        if (!msg) { err.hidden = true; err.textContent = ""; return; }
        err.hidden = false; err.textContent = msg;
      }

      function attemptConfirm() {
        if (spec.kind === "prompt") {
          const value = readInput();
          if (spec.required && !value.trim()) {
            showError("This field is required.");
            return;
          }
          if (typeof spec.validate === "function") {
            const err = spec.validate(value);
            if (err) { showError(err); return; }
          }
          finish(value);
        } else {
          // confirm / alert
          finish(spec.kind === "alert" ? undefined : true);
        }
      }
      function attemptCancel() {
        if (spec.kind === "prompt") finish(null);
        else if (spec.kind === "alert") finish(undefined);
        else finish(false);
      }

      function onKey(event) {
        // Only respond if this is the top modal on the stack.
        if (STACK[STACK.length - 1] !== handle) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          attemptCancel();
          return;
        }
        if (event.key === "Enter" && spec.kind === "prompt" && !spec.multiline) {
          // Enter confirms single-line prompts. Don't intercept in
          // textarea — users need newlines there.
          if (event.target && event.target.tagName === "TEXTAREA") return;
          event.preventDefault();
          attemptConfirm();
          return;
        }
        if (event.key === "Tab") {
          // Trap focus within the modal.
          const focusable = backdrop.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])");
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            try { last.focus(); } catch (e) { /* ignore */ }
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            try { first.focus(); } catch (e) { /* ignore */ }
          }
        }
      }

      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) {
          // Click on backdrop = cancel (mirrors native confirm UX).
          attemptCancel();
        }
      });
      backdrop.addEventListener("click", function (event) {
        const action = event.target && event.target.getAttribute && event.target.getAttribute("data-cb-modal");
        if (action === "confirm") attemptConfirm();
        if (action === "cancel") attemptCancel();
      });
      document.addEventListener("keydown", onKey, true);

      const handle = { finish: finish };
      STACK.push(handle);
      document.body.appendChild(backdrop);

      // Initial focus: input if prompt, otherwise the confirm button.
      // Defer to a microtask so the element has been laid out.
      setTimeout(function () {
        const input = backdrop.querySelector(".cb-modal-input");
        if (input) {
          try {
            input.focus();
            // Select the default value so users can type over it.
            if (typeof input.select === "function") input.select();
          } catch (e) { /* ignore */ }
        } else {
          const confirmBtn = backdrop.querySelector('[data-cb-modal="confirm"]');
          if (confirmBtn) try { confirmBtn.focus(); } catch (e) { /* ignore */ }
        }
      }, 0);
    });
  }

  // Public API — drop-in replacements.
  function confirmDialog(spec) {
    if (typeof spec === "string") spec = { body: spec };
    return open(Object.assign({}, spec, {
      kind: "confirm",
      _returnFocus: document.activeElement,
    }));
  }
  function promptDialog(spec) {
    if (typeof spec === "string") spec = { body: spec };
    return open(Object.assign({}, spec, {
      kind: "prompt",
      _returnFocus: document.activeElement,
    }));
  }
  function alertDialog(spec) {
    if (typeof spec === "string") spec = { body: spec };
    return open(Object.assign({}, spec, {
      kind: "alert",
      _returnFocus: document.activeElement,
    }));
  }

  // Closes the topmost modal — useful if a route change orphans a modal.
  function closeAll() {
    while (STACK.length) {
      const top = STACK[STACK.length - 1];
      try { top.finish(false); } catch (e) { STACK.pop(); }
    }
  }

  window.CBV2.modal = {
    confirm: confirmDialog,
    prompt: promptDialog,
    alert: alertDialog,
    confirmText: function (msg) { return confirmDialog({ body: msg }); },
    promptText: function (msg, def) { return promptDialog({ body: msg, defaultValue: def }); },
    alertText: function (msg) { return alertDialog({ body: msg }); },
    closeAll: closeAll,
    _installed: true,
  };
})();
