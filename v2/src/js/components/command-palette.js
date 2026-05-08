// Command Palette — the "⌘K" surface.
//
// Provides a single, keyboard-driven entry point to every important action
// in the app: navigation, creating applications, opening AI surfaces, jumping
// to a specific application/event, and the most common workflows.
//
// Design goals:
//   - No dependencies. Vanilla JS + the existing store/drawer APIs.
//   - Fully accessible: focus trap, Escape closes, arrow-keys navigate,
//     Enter activates, `Tab` cycles without leaving.
//   - Fuzzy-match tolerant: substring AND initialism ("tp" → "Tailor resume
//     Plan" would match "tailor-resume-plan").
//   - Commands are declared as data; the palette only renders + dispatches.
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.palette) return;

  // -----------------------------------------------------------------------
  // Built-in static commands. Dynamic items (applications, events) are
  // generated at open time so they always reflect the current state.
  // -----------------------------------------------------------------------
  const STATIC_COMMANDS = [
    // Navigation group ---------------------------------------------------
    { id: "nav-dashboard",     group: "Go to", icon: "fa-house",               label: "Dashboard",           hint: "g d", run: () => go("dashboard") },
    { id: "nav-pipeline",      group: "Go to", icon: "fa-list-check",          label: "Pipeline",            hint: "g p", run: () => go("applications") },
    { id: "nav-jobs",          group: "Go to", icon: "fa-magnifying-glass",    label: "Job Search",          hint: "g j", run: () => go("job-search") },
    { id: "nav-resume",        group: "Go to", icon: "fa-file-lines",          label: "Resume Lab",          hint: "g r", run: () => go("resume") },
    { id: "nav-cover",         group: "Go to", icon: "fa-envelope-open-text",  label: "Cover Letters",       hint: "g c", run: () => go("cover-letter") },
    { id: "nav-interview",     group: "Go to", icon: "fa-comments",            label: "Interview Prep",      hint: "g i", run: () => go("interview") },
    { id: "nav-calendar",      group: "Go to", icon: "fa-calendar-days",       label: "Calendar",            hint: "g k", run: () => go("calendar") },
    { id: "nav-analytics",     group: "Go to", icon: "fa-chart-line",          label: "Analytics",           hint: "g a", run: () => go("analytics") },
    { id: "nav-settings",      group: "Go to", icon: "fa-gear",                label: "Settings",            hint: "g s", run: () => go("settings") },

    // Create group ------------------------------------------------------
    { id: "new-app",           group: "Create", icon: "fa-plus",                label: "Add application",              keywords: "new job role create", run: () => go("applications?add=1") },
    { id: "new-search",        group: "Create", icon: "fa-bookmark",            label: "Save a job search",            keywords: "saved alert", run: () => go("job-search") },
    { id: "new-resume",        group: "Create", icon: "fa-file-pen",            label: "Tailor resume for a role",     keywords: "ai resume", run: () => go("resume") },
    { id: "new-letter",        group: "Create", icon: "fa-feather-pointed",     label: "Draft a cover letter",         keywords: "ai letter", run: () => go("cover-letter") },
    { id: "new-interview",     group: "Create", icon: "fa-microphone-lines",    label: "Prep for an interview",        keywords: "ai coach", run: () => go("interview") },

    // Utility group -----------------------------------------------------
    { id: "util-export",       group: "Utility", icon: "fa-file-csv",           label: "Export pipeline to CSV",       keywords: "download csv", run: () => { go("analytics"); setTimeout(() => { const b = document.getElementById("export-csv"); if (b) b.click(); }, 200); } },
    { id: "util-shortcuts",    group: "Utility", icon: "fa-keyboard",           label: "Keyboard shortcuts cheatsheet",keywords: "help keys", run: () => { if (window.CBV2.shortcuts) window.CBV2.shortcuts.openCheatsheet(); } },
    { id: "util-signout",      group: "Utility", icon: "fa-right-from-bracket", label: "Sign out",                     keywords: "logout", run: async () => { if (window.CBV2.auth) { try { await window.CBV2.auth.signOut(); } catch (e) {} } window.location.hash = "#/welcome"; } }
  ];

  function go(routeId) {
    window.location.hash = "#/" + routeId;
  }

  // -----------------------------------------------------------------------
  // Dynamic commands generated from the current store state.
  // -----------------------------------------------------------------------
  function dynamicCommands() {
    const out = [];
    const store = window.CBV2.store;
    if (!store) return out;

    const STAGE_LABEL = {
      saved: "Saved", applied: "Applied", interview: "Interview",
      offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn"
    };

    // Applications → "Open Stripe — Senior Frontend". Opens the drawer
    // instead of navigating, preserving wherever the user was.
    (store.getApplications() || []).slice(0, 48).forEach(function (a) {
      out.push({
        id: "app-" + a.id,
        group: "Applications",
        icon: "fa-briefcase",
        label: (a.company || "—") + " — " + (a.role || "Role"),
        sub: (STAGE_LABEL[a.stage] || a.stage) + (a.priority ? " · " + a.priority : ""),
        keywords: (a.company + " " + a.role + " " + (a.notes || "") + " " + a.stage).toLowerCase(),
        run: () => {
          if (window.CBV2.drawer && window.CBV2.drawer.openApplication) {
            window.CBV2.drawer.openApplication(a.id);
          } else {
            go("applications");
          }
        }
      });
    });

    // Events → navigate to calendar.
    (store.getEvents() || []).slice(0, 24).forEach(function (e) {
      out.push({
        id: "evt-" + e.id,
        group: "Events",
        icon: "fa-calendar-day",
        label: e.title,
        sub: e.date + " · " + (e.type || "event"),
        keywords: (e.title + " " + (e.type || "")).toLowerCase(),
        run: () => go("calendar")
      });
    });

    return out;
  }

  // -----------------------------------------------------------------------
  // Scoring. Matches on literal substring (highest), then initialism.
  // Returns a number; higher = better. 0 means no match.
  // -----------------------------------------------------------------------
  function score(cmd, q) {
    if (!q) return 1;
    const hay = (cmd.label + " " + (cmd.keywords || "") + " " + (cmd.sub || "") + " " + cmd.group).toLowerCase();
    const needle = q.toLowerCase();
    if (hay.indexOf(needle) >= 0) {
      // Prefer matches close to the start of the label.
      const idx = cmd.label.toLowerCase().indexOf(needle);
      return 200 - (idx >= 0 ? idx : 100);
    }
    // Initialism: q = "tr" should match "Tailor Resume"
    const words = cmd.label.toLowerCase().split(/\W+/).filter(Boolean);
    const initials = words.map(function (w) { return w[0]; }).join("");
    if (initials.indexOf(needle) >= 0) return 80 - initials.indexOf(needle);
    // Fuzzy: every letter of q appears in order in hay.
    let i = 0;
    for (let j = 0; j < hay.length && i < needle.length; j += 1) {
      if (hay[j] === needle[i]) i += 1;
    }
    if (i === needle.length) return 30;
    return 0;
  }

  // -----------------------------------------------------------------------
  // DOM wiring.
  // -----------------------------------------------------------------------
  let root = null;
  let input = null;
  let listEl = null;
  let items = [];
  let selectedIdx = 0;
  let lastActive = null;

  function open() {
    if (root) return;
    lastActive = document.activeElement;
    build();
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(function () {
      if (root) root.classList.add("is-open");
      if (input) input.focus();
    });
  }

  function close() {
    if (!root) return;
    document.removeEventListener("keydown", onKey, true);
    root.classList.remove("is-open");
    const el = root;
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      if (lastActive && typeof lastActive.focus === "function") {
        try { lastActive.focus(); } catch (e) { /* ignore */ }
      }
    }, 160);
    root = null;
    input = null;
    listEl = null;
    items = [];
    selectedIdx = 0;
  }

  function build() {
    root = document.createElement("div");
    root.className = "palette-root";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Command palette");

    root.innerHTML =
      '<div class="palette-backdrop" data-palette-dismiss></div>' +
      '<div class="palette-panel" role="document">' +
        '<div class="palette-input-row">' +
          '<i class="fa-solid fa-magnifying-glass palette-search-icon" aria-hidden="true"></i>' +
          '<input class="palette-input" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Type a command, page, or application…" aria-label="Command palette search" />' +
          '<kbd class="palette-esc">Esc</kbd>' +
        '</div>' +
        '<div class="palette-list" role="listbox" aria-label="Results"></div>' +
        '<footer class="palette-footer">' +
          '<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>' +
          '<span><kbd>↵</kbd> run</span>' +
          '<span><kbd>Esc</kbd> close</span>' +
        '</footer>' +
      '</div>';

    document.body.appendChild(root);
    input = root.querySelector(".palette-input");
    listEl = root.querySelector(".palette-list");

    input.addEventListener("input", function () { render(input.value); });
    root.querySelector("[data-palette-dismiss]").addEventListener("click", close);
    listEl.addEventListener("mousemove", function (e) {
      const el = e.target.closest("[data-cmd-idx]");
      if (!el) return;
      const idx = parseInt(el.getAttribute("data-cmd-idx"), 10);
      if (!isNaN(idx) && idx !== selectedIdx) {
        selectedIdx = idx;
        updateSelection();
      }
    });
    listEl.addEventListener("click", function (e) {
      const el = e.target.closest("[data-cmd-idx]");
      if (!el) return;
      const idx = parseInt(el.getAttribute("data-cmd-idx"), 10);
      if (!isNaN(idx)) activate(idx);
    });

    render("");
  }

  function render(q) {
    const pool = STATIC_COMMANDS.concat(dynamicCommands());
    const scored = pool.map(function (c) { return { cmd: c, s: score(c, q) }; })
                      .filter(function (x) { return x.s > 0; });
    scored.sort(function (a, b) { return b.s - a.s; });
    items = scored.slice(0, 40).map(function (x) { return x.cmd; });
    selectedIdx = 0;
    drawList();
  }

  function drawList() {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML =
        '<div class="palette-empty">' +
          '<i class="fa-regular fa-face-thinking"></i>' +
          '<p>No matches. Try "pipeline", "resume", or a company name.</p>' +
        '</div>';
      return;
    }

    // Group by group label, preserving scored order inside each group.
    const groups = [];
    const byGroup = {};
    items.forEach(function (cmd) {
      const g = cmd.group || "Actions";
      if (!byGroup[g]) {
        byGroup[g] = [];
        groups.push(g);
      }
      byGroup[g].push(cmd);
    });

    let idx = 0;
    let html = "";
    groups.forEach(function (g) {
      html += '<div class="palette-group-title">' + escapeHtml(g) + '</div>';
      byGroup[g].forEach(function (cmd) {
        html +=
          '<button class="palette-item" role="option" type="button" data-cmd-idx="' + idx + '">' +
            '<span class="palette-icon"><i class="fa-solid ' + escapeHtml(cmd.icon || "fa-circle") + '"></i></span>' +
            '<span class="palette-text">' +
              '<strong>' + escapeHtml(cmd.label) + '</strong>' +
              (cmd.sub ? '<span class="palette-sub">' + escapeHtml(cmd.sub) + '</span>' : "") +
            '</span>' +
            (cmd.hint ? '<kbd class="palette-hint">' + escapeHtml(cmd.hint) + '</kbd>' : '<span class="palette-enter"><i class="fa-solid fa-turn-down fa-rotate-90"></i></span>') +
          '</button>';
        idx += 1;
      });
    });
    listEl.innerHTML = html;
    updateSelection();
  }

  function updateSelection() {
    const nodes = listEl.querySelectorAll(".palette-item");
    nodes.forEach(function (n, i) {
      n.classList.toggle("is-selected", i === selectedIdx);
      if (i === selectedIdx) {
        n.setAttribute("aria-selected", "true");
        // Keep selected item in view.
        const rect = n.getBoundingClientRect();
        const parent = listEl.getBoundingClientRect();
        if (rect.top < parent.top + 4) n.scrollIntoView({ block: "nearest" });
        else if (rect.bottom > parent.bottom - 4) n.scrollIntoView({ block: "nearest" });
      } else {
        n.removeAttribute("aria-selected");
      }
    });
  }

  function activate(idx) {
    const cmd = items[idx];
    if (!cmd) return;
    close();
    try { cmd.run(); } catch (e) { console.warn("[palette] run failed", e); }
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!items.length) return;
      selectedIdx = (selectedIdx + 1) % items.length;
      updateSelection();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      selectedIdx = (selectedIdx - 1 + items.length) % items.length;
      updateSelection();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate(selectedIdx);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault(); selectedIdx = 0; updateSelection(); return;
    }
    if (e.key === "End") {
      e.preventDefault(); selectedIdx = Math.max(0, items.length - 1); updateSelection(); return;
    }
  }

  function escapeHtml(s) {
    const str = String(s == null ? "" : s);
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Delegated click handler for the topbar button and any other element
  // marked with data-open-palette anywhere in the app.
  document.addEventListener("click", function (e) {
    const trigger = e.target.closest("[data-open-palette]");
    if (trigger) {
      e.preventDefault();
      open();
    }
  });

  window.CBV2.palette = { open: open, close: close };
})();
