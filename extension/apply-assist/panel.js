// Apply Assist — floating status panel (Phase 2b).
//
// Bottom-right card mounted on the ATS page after the adapter runs.
// Shows what was filled, what still needs the user, and gives a Re-fill
// + Hide control. Always visible when there's an active intent; also
// renders a "no intent" state so the user knows the extension noticed
// the apply form (avoids the "did anything happen?" silence).
//
// Public surface: window.__CBApplyAssistPanel
//   show(state)          — { kind, intent?, stats?, error?, screeningQs? }
//   updateStats(stats)
//   onRefill(fn)
//   close()
//
// State `kind` values:
//   "no-intent"   — apply form detected but no intent loaded
//   "filling"     — adapter currently working
//   "filled"      — adapter done, here are the counts
//   "error"       — adapter threw; show fallback copy

(function () {
  if (window.__CBApplyAssistPanel) return;

  const PANEL_ID = "cb-apply-assist-panel";
  const listeners = { refill: [], hide: [], close: [] };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else node.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        if (typeof c === "string") node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      });
    }
    return node;
  }

  function ensureMounted() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = el("div", { id: PANEL_ID, class: "cbaa-panel cbaa-panel--hidden", role: "complementary", "aria-label": "CareerBoost Apply Assist" });
    document.body.appendChild(panel);
    return panel;
  }

  function renderHeader() {
    return el("div", { class: "cbaa-head" }, [
      el("div", { class: "cbaa-head-title" }, [
        el("span", { class: "cbaa-dot" }),
        el("div", null, [
          el("strong", null, "Apply Assist"),
          el("small", null, "CareerBoost")
        ])
      ]),
      el("button", {
        type: "button",
        class: "cbaa-iconbtn",
        title: "Hide panel",
        "aria-label": "Hide Apply Assist panel",
        onclick: function () { hide(); }
      }, "—")
    ]);
  }

  function renderBodyForState(state) {
    const body = el("div", { class: "cbaa-body" });

    if (state.kind === "no-intent") {
      body.appendChild(el("p", { class: "cbaa-msg" },
        "Apply form detected. To auto-fill, open this from your CareerBoost pipeline using the Apply Assist button."));
      return body;
    }

    if (state.kind === "error") {
      body.appendChild(el("p", { class: "cbaa-msg cbaa-msg--error" },
        state.error || "Apply Assist could not run. Please fill the form manually."));
      return body;
    }

    // filling | filled — both render the same status grid.
    const s = state.stats || { filled: 0, skipped: 0, errors: 0, screening: 0 };
    const tone = state.kind === "filling" ? "cyan" : (s.errors ? "warn" : "ok");

    const summaryLine = state.kind === "filling"
      ? "Auto-filling fields…"
      : s.filled === 0
        ? "Nothing to fill — please complete manually."
        : "Filled " + s.filled + " field" + (s.filled === 1 ? "" : "s") + ".";

    body.appendChild(el("p", { class: "cbaa-msg cbaa-msg--" + tone }, summaryLine));

    const grid = el("div", { class: "cbaa-grid" }, [
      statTile("Filled",     String(s.filled),     "ok"),
      statTile("Skipped",    String(s.skipped),    "subtle"),
      statTile("Errors",     String(s.errors),     s.errors ? "warn" : "subtle"),
      statTile("Screening",  String(s.screening),  s.screening ? "screening" : "subtle")
    ]);
    body.appendChild(grid);

    if (s.screening > 0) {
      body.appendChild(el("p", { class: "cbaa-hint" },
        "Screening questions are highlighted yellow on the form. Apply Assist never guesses answers to factual questions — please review and answer them yourself."));
    }

    if (state.kind === "filled") {
      const actions = el("div", { class: "cbaa-actions" }, [
        el("button", {
          type: "button",
          class: "cbaa-btn cbaa-btn--ghost",
          onclick: function () { emit("refill"); }
        }, "Re-fill"),
        el("p", { class: "cbaa-finefoot" },
          "You always click Submit yourself. Apply Assist never submits on your behalf.")
      ]);
      body.appendChild(actions);
    }

    return body;
  }

  function statTile(label, value, tone) {
    return el("div", { class: "cbaa-tile cbaa-tile--" + (tone || "subtle") }, [
      el("strong", null, value),
      el("span", null, label)
    ]);
  }

  function render(state) {
    const panel = ensureMounted();
    panel.classList.remove("cbaa-panel--hidden", "cbaa-panel--collapsed");
    panel.innerHTML = "";
    panel.appendChild(renderHeader());
    panel.appendChild(renderBodyForState(state || { kind: "no-intent" }));
  }

  function hide() {
    const panel = ensureMounted();
    panel.classList.add("cbaa-panel--collapsed");
    // Replace the body with a tiny "Apply Assist hidden" peek bar so the
    // user can bring it back. Keep the header for the show toggle.
    panel.innerHTML = "";
    panel.appendChild(el("button", {
      type: "button",
      class: "cbaa-peek",
      title: "Show Apply Assist",
      onclick: function () { emit("show-from-peek"); }
    }, [
      el("span", { class: "cbaa-dot" }),
      "Apply Assist"
    ]));
    emit("hide");
  }

  function close() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
    emit("close");
  }

  function emit(name) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(); } catch (e) { /* listener error doesn't kill flow */ }
    });
  }

  function on(name, fn) {
    if (!listeners[name]) listeners[name] = [];
    if (typeof fn === "function") listeners[name].push(fn);
  }

  // Public API
  let currentState = null;
  function show(state) {
    currentState = state || currentState || { kind: "no-intent" };
    render(currentState);
  }
  function updateStats(stats) {
    if (!currentState) return;
    currentState = Object.assign({}, currentState, { stats: stats, kind: currentState.kind === "filling" ? "filling" : currentState.kind });
    render(currentState);
  }
  function setKind(kind, extra) {
    currentState = Object.assign({}, currentState || {}, extra || {}, { kind: kind });
    render(currentState);
  }

  // Wire the peek-bar's "show" click back to a full render of the last
  // known state, so collapse → expand is a no-op visually.
  on("show-from-peek", function () { render(currentState || { kind: "no-intent" }); });

  window.__CBApplyAssistPanel = {
    show: show,
    updateStats: updateStats,
    setKind: setKind,
    hide: hide,
    close: close,
    onRefill: function (fn) { on("refill", fn); },
    onHide: function (fn) { on("hide", fn); },
    onClose: function (fn) { on("close", fn); }
  };
})();
