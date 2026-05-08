// Single unified toast channel used across modules.
// Usage: window.CBV2.toast.success("Saved!") / .error("Nope") / .info("...")
// All toasts stack in the top-right, auto-dismiss, and are keyboard-friendly.
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.toast) return;

  const HOST_ID = "cbv2-toast-host";
  const DEFAULTS = { duration: 3600, dismissible: true };

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-atomic", "false");
    document.body.appendChild(host);
    return host;
  }

  function iconFor(kind) {
    if (kind === "success") return "fa-circle-check";
    if (kind === "error") return "fa-circle-xmark";
    if (kind === "warning") return "fa-triangle-exclamation";
    return "fa-circle-info";
  }

  function show(message, options) {
    const opts = Object.assign({ kind: "info" }, DEFAULTS, options || {});
    const host = ensureHost();

    const el = document.createElement("div");
    el.className = "toast toast--" + opts.kind;
    el.setAttribute("role", opts.kind === "error" ? "alert" : "status");

    const icon = document.createElement("i");
    icon.className = "fa-solid " + iconFor(opts.kind);
    icon.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "toast-body";
    if (opts.title) {
      const h = document.createElement("strong");
      h.textContent = opts.title;
      body.appendChild(h);
    }
    const msg = document.createElement("span");
    msg.textContent = String(message || "");
    body.appendChild(msg);

    el.appendChild(icon);
    el.appendChild(body);

    if (opts.dismissible) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-close";
      close.setAttribute("aria-label", "Dismiss");
      close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      close.addEventListener("click", function () { dismiss(el); });
      el.appendChild(close);
    }

    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("is-visible"); });

    const timer = setTimeout(function () { dismiss(el); }, opts.duration);
    el.addEventListener("mouseenter", function () { clearTimeout(timer); });

    return { dismiss: function () { dismiss(el); } };
  }

  function dismiss(el) {
    if (!el || !el.parentNode) return;
    el.classList.remove("is-visible");
    el.classList.add("is-leaving");
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  window.CBV2.toast = {
    show: show,
    info: function (m, o) { return show(m, Object.assign({ kind: "info" }, o || {})); },
    success: function (m, o) { return show(m, Object.assign({ kind: "success" }, o || {})); },
    warning: function (m, o) { return show(m, Object.assign({ kind: "warning" }, o || {})); },
    error: function (m, o) { return show(m, Object.assign({ kind: "error", duration: 6000 }, o || {})); }
  };
})();
