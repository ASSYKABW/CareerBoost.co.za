(function () {
  window.CBV2 = window.CBV2 || {};

  function getSt() {
    return window.CBV2.sanitizeText;
  }

  function searchAll(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const store = window.CBV2.store;
    const results = [];

    store.getApplications().forEach(function (a) {
      const hay = (a.company + " " + a.role + " " + (a.notes || "")).toLowerCase();
      if (hay.indexOf(q) >= 0) {
        results.push({
          type: "application",
          label: a.company + " — " + a.role,
          sub: "Stage: " + a.stage,
          href: "#/applications"
        });
      }
    });

    store.getEvents().forEach(function (e) {
      if (e.title.toLowerCase().indexOf(q) >= 0) {
        results.push({
          type: "event",
          label: e.title,
          sub: e.date + " · " + e.type,
          href: "#/calendar"
        });
      }
    });

    const routes = [
      { id: "dashboard", label: "Dashboard" },
      { id: "applications", label: "Pipeline" },
      { id: "resume", label: "Resume Lab" },
      { id: "cover-letter", label: "Cover Letter Studio" },
      { id: "interview", label: "Interview Prep" },
      { id: "analytics", label: "Analytics" },
      { id: "calendar", label: "Calendar" }
    ];
    routes.forEach(function (r) {
      if (r.label.toLowerCase().indexOf(q) >= 0) {
        results.push({
          type: "page",
          label: r.label,
          sub: "Open " + r.label,
          href: "#/" + r.id
        });
      }
    });

    return results.slice(0, 8);
  }

  function renderResults(results) {
    const st = getSt();
    if (!results.length) {
      return '<div class="search-empty">No matches</div>';
    }
    return results
      .map(function (r) {
        return (
          '<a class="search-item" href="' +
          st(r.href) +
          '" data-search-item="1">' +
          '<span class="chip cyan">' +
          st(r.type) +
          "</span>" +
          '<div class="search-text"><strong>' +
          st(r.label) +
          "</strong>" +
          '<span class="ai-meta">' +
          st(r.sub) +
          "</span></div>" +
          "</a>"
        );
      })
      .join("");
  }

  window.CBV2.bindGlobalSearch = function () {
    // Phase E: the topbar search is now a button opening the command
    // palette. Only wire up when an actual <input class="topbar-search"> is
    // present (legacy or future re-mount). Otherwise let the palette own it.
    const input = document.querySelector("input.topbar-search");
    if (!input) return;

    let dropdown = document.getElementById("search-dropdown");
    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.id = "search-dropdown";
      dropdown.className = "search-dropdown";
      dropdown.hidden = true;
      input.parentNode && input.parentNode.insertBefore(dropdown, input.nextSibling);
    }

    function close() {
      dropdown.hidden = true;
    }

    function open(results) {
      dropdown.innerHTML = renderResults(results);
      dropdown.hidden = false;
      dropdown.querySelectorAll("[data-search-item]").forEach(function (el) {
        el.addEventListener("click", function () {
          setTimeout(close, 0);
        });
      });
    }

    input.addEventListener("input", function () {
      const q = input.value;
      if (!q.trim()) {
        close();
        return;
      }
      open(searchAll(q));
    });

    input.addEventListener("focus", function () {
      if (input.value.trim()) {
        open(searchAll(input.value));
      }
    });

    document.addEventListener("click", function (e) {
      if (!dropdown.contains(e.target) && e.target !== input) {
        close();
      }
    });
  };
})();
