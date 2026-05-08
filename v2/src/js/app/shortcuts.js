// Global keyboard shortcuts.
//  "/"  -> focus topbar search
//  "?"  -> open shortcuts cheatsheet (?)
//  "g d/j/p/r/c/i/a/s"  -> go to dashboard/jobs/pipeline/resume/cover/interview/analytics/settings
//  "Escape" -> close any open modal/cheatsheet
(function () {
  window.CBV2 = window.CBV2 || {};

  const ROUTES = {
    d: "dashboard",
    j: "job-search",
    p: "applications",
    r: "resume",
    c: "cover-letter",
    i: "interview",
    a: "analytics",
    s: "settings",
    k: "calendar"
  };

  const SHORTCUTS_LIST = [
    { keys: "⌘ K", label: "Open command palette" },
    { keys: "/", label: "Open command palette (alt)" },
    { keys: "?", label: "Show this cheatsheet" },
    { keys: "g d", label: "Go to Dashboard" },
    { keys: "g j", label: "Go to Job Search" },
    { keys: "g p", label: "Go to Pipeline" },
    { keys: "g r", label: "Go to Resume Lab" },
    { keys: "g c", label: "Go to Cover Letters" },
    { keys: "g i", label: "Go to Interview Prep" },
    { keys: "g k", label: "Go to Calendar" },
    { keys: "g a", label: "Go to Analytics" },
    { keys: "g s", label: "Go to Settings" },
    { keys: "Esc", label: "Close dialog / clear focus" }
  ];

  let gPending = false;
  let gTimer = null;

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function focusSearch() {
    // Phase E: the topbar "search" is now a button that opens the command
    // palette. Prefer the palette when available; fall back to focusing any
    // legacy <input class="topbar-search"> for older views.
    if (window.CBV2.palette && typeof window.CBV2.palette.open === "function") {
      window.CBV2.palette.open();
      return;
    }
    const el = document.querySelector("input.topbar-search, .topbar-search[data-legacy]");
    if (el && typeof el.focus === "function") {
      el.focus();
      if (typeof el.select === "function") el.select();
    }
  }

  function go(routeId) {
    window.location.hash = "#/" + routeId;
  }

  function closeCheatsheet() {
    const existing = document.getElementById("cbv2-cheatsheet");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function openCheatsheet() {
    closeCheatsheet();
    const scrim = document.createElement("div");
    scrim.id = "cbv2-cheatsheet";
    scrim.className = "shortcut-scrim";
    scrim.setAttribute("role", "dialog");
    scrim.setAttribute("aria-modal", "true");
    scrim.setAttribute("aria-label", "Keyboard shortcuts");

    const rows = SHORTCUTS_LIST.map(function (s) {
      const keys = s.keys.split(" ").map(function (k) {
        return '<kbd>' + k + '</kbd>';
      }).join(" <span class='kbd-plus'>then</span> ");
      return '<li><div class="shortcut-keys">' + keys + "</div><span>" + s.label + "</span></li>";
    }).join("");

    scrim.innerHTML =
      '<div class="shortcut-card" role="document">' +
        '<div class="shortcut-head">' +
          '<h2>Keyboard shortcuts</h2>' +
          '<button class="btn-ghost" data-shortcut-close type="button" aria-label="Close">' +
            '<i class="fa-solid fa-xmark"></i>' +
          '</button>' +
        '</div>' +
        '<ul class="shortcut-list">' + rows + '</ul>' +
        '<p class="ai-meta" style="margin-top:12px;">Shortcuts are ignored while typing in an input.</p>' +
      '</div>';

    scrim.addEventListener("click", function (e) {
      if (e.target === scrim) closeCheatsheet();
    });
    scrim.querySelector("[data-shortcut-close]").addEventListener("click", closeCheatsheet);
    document.body.appendChild(scrim);
  }

  window.CBV2.shortcuts = {
    openCheatsheet: openCheatsheet,
    closeCheatsheet: closeCheatsheet
  };

  function handleKey(e) {
    // ⌘K / Ctrl+K → open the command palette. This is intentionally allowed
    // even when focus is inside an input — that's the conventional behavior
    // (Linear, Notion, Raycast, GitHub) so the shortcut is always reachable.
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (window.CBV2.palette && typeof window.CBV2.palette.open === "function") {
        window.CBV2.palette.open();
      }
      return;
    }

    // Always allow Escape out of dialogs.
    if (e.key === "Escape") {
      closeCheatsheet();
      return;
    }
    if (isTypingTarget(e.target)) return;
    // Ignore when any other modifier is held (browser may be handling it).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "/") {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      openCheatsheet();
      return;
    }
    if (gPending) {
      const key = (e.key || "").toLowerCase();
      if (ROUTES[key]) {
        e.preventDefault();
        gPending = false;
        clearTimeout(gTimer);
        go(ROUTES[key]);
      } else if (key !== "g") {
        gPending = false;
        clearTimeout(gTimer);
      }
      return;
    }
    if (e.key === "g" || e.key === "G") {
      gPending = true;
      clearTimeout(gTimer);
      gTimer = setTimeout(function () { gPending = false; }, 900);
    }
  }

  document.addEventListener("keydown", handleKey);
})();
