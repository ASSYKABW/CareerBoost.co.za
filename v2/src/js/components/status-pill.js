// Backend health pill shown in the topbar.
// Polls a light auth check every ~60s when signed in. States:
//   healthy  — green dot "Online"
//   degraded — amber dot "Degraded"
//   offline  — red dot   "Offline"
//   local    — neutral pill "Local mode"
(function () {
  window.CBV2 = window.CBV2 || {};

  const state = {
    status: "idle",
    lastChecked: 0,
    running: false
  };

  function config() { return window.CBV2.config || {}; }
  function auth() { return window.CBV2.auth || {}; }

  function toneFor(status) {
    switch (status) {
      case "healthy": return "green";
      case "degraded": return "warning";
      case "offline": return "rose";
      case "local": return "violet";
      default: return "cyan";
    }
  }

  function labelFor(status) {
    switch (status) {
      case "healthy": return "Online";
      case "degraded": return "Degraded";
      case "offline": return "Offline";
      case "local": return "Local mode";
      default: return "Checking…";
    }
  }

  function render() {
    const cfg = config();
    const a = auth();
    if (!cfg.isBackendEnabled || !cfg.isBackendEnabled()) {
      state.status = "local";
    } else if (!a.isAuthenticated || !a.isAuthenticated()) {
      state.status = "idle";
    }

    const tone = toneFor(state.status);
    const label = labelFor(state.status);

    return (
      '<a class="status-pill chip ' + tone + '" href="#/settings" title="View backend diagnostics" data-status-pill>' +
        '<span class="status-pill-dot"></span>' +
        '<span class="status-pill-label">' + label + '</span>' +
      '</a>'
    );
  }

  async function probe() {
    if (state.running) return;
    const cfg = config();
    const a = auth();
    if (!cfg.isBackendEnabled || !cfg.isBackendEnabled()) {
      state.status = "local";
      repaint();
      return;
    }
    if (!a.isAuthenticated || !a.isAuthenticated()) {
      state.status = "idle";
      repaint();
      return;
    }
    state.running = true;
    try {
      const client = a.getClient();
      const user = a.getUser();
      if (!client || !user) throw new Error("No client");
      // Cheapest signed-in round-trip: fetch own profile row.
      const { error } = await Promise.race([
        client.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle(),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, 8000); })
      ]);
      state.status = error ? "degraded" : "healthy";
    } catch (e) {
      state.status = "offline";
    } finally {
      state.running = false;
      state.lastChecked = Date.now();
      repaint();
    }
  }

  function repaint() {
    const host = document.querySelector("[data-status-pill-slot]");
    if (!host) return;
    host.innerHTML = render();
  }

  window.CBV2.statusPill = {
    render: render,
    probe: probe,
    mount: function () {
      repaint();
      probe();
      // Re-probe every 60s if page visible; on visibility change, immediate probe.
      if (!window.CBV2.statusPill._timer) {
        window.CBV2.statusPill._timer = setInterval(function () {
          if (document.visibilityState === "visible") probe();
        }, 60000);
      }
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && Date.now() - state.lastChecked > 30000) {
          probe();
        }
      });
    }
  };
})();
