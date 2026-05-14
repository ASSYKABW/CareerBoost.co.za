// Phase 8: Admin realtime channels.
//
// Subscribes to Supabase Realtime Postgres changes for the admin
// console. Two channels:
//
//   1. admin_incidents       → on INSERT/UPDATE, refresh admin metrics
//                              so the Health/Risk panel updates without
//                              the operator clicking Refresh.
//   2. admin_audit_log       → on INSERT, mark the audit cache dirty
//                              so the next render fetches fresh data.
//
// Connection lifecycle:
//   - Channels are created on first admin-route render (afterRender hook).
//   - They are torn down when the operator navigates away from /admin
//     OR signs out.
//   - State exposed via window.CBV2.adminRealtime.state() →
//     { status: "connecting" | "live" | "stale" | "off", lastEventAt }
//   - admin.route.js renderToolbar shows a "Live" / "Stale" chip
//     reflecting this state.

(function () {
  window.CBV2 = window.CBV2 || {};

  const state = {
    status: "off",   // "off" | "connecting" | "live" | "error"
    lastEventAt: 0,
    channels: [],
    listeners: [],
  };

  function notify() {
    state.listeners.forEach(function (fn) {
      try { fn(getState()); } catch (e) { /* ignore */ }
    });
  }

  function getState() {
    return {
      status: state.status,
      lastEventAt: state.lastEventAt,
      isConnected: state.status === "live",
    };
  }

  function setStatus(next) {
    if (state.status === next) return;
    state.status = next;
    notify();
    // The toolbar chip is part of the admin route render; re-render
    // when the status flips so the chip reflects the current state.
    if (typeof window.CBV2.renderCurrentRoute === "function" && isAdminRoute()) {
      window.CBV2.renderCurrentRoute();
    }
  }

  function teardown() {
    if (!state.channels.length) {
      setStatus("off");
      return;
    }
    const auth = window.CBV2 && window.CBV2.auth;
    const client = auth && auth.getClient && auth.getClient();
    state.channels.forEach(function (ch) {
      if (!ch) return;
      try {
        if (client && typeof client.removeChannel === "function") {
          client.removeChannel(ch);
        } else if (typeof ch.unsubscribe === "function") {
          ch.unsubscribe();
        }
      } catch (e) { /* ignore */ }
    });
    state.channels = [];
    setStatus("off");
  }

  function isAdminRoute() {
    const st = window.CBV2 && window.CBV2.getState && window.CBV2.getState();
    return Boolean(st && st.route === "admin");
  }

  function isAdminAuthed() {
    const access = window.CBV2 && window.CBV2.adminAccess;
    if (!access || typeof access.canAccess !== "function") return false;
    if (!access.canAccess()) return false;
    const c = window.CBV2.config;
    if (!c || !c.isBackendEnabled || !c.isBackendEnabled()) return false;
    return true;
  }

  // Mark a cache dirty by zeroing its loadedAt — admin.route.js fetchers
  // re-fetch when (Date.now() - loadedAt > TTL). Setting loadedAt = 0
  // forces the next render's lazy-fetch to fire.
  function bumpCache(remote) {
    if (!remote) return;
    remote.loadedAt = 0;
  }

  function setup() {
    if (state.channels.length) return; // already up
    if (!isAdminRoute() || !isAdminAuthed()) return;
    const auth = window.CBV2 && window.CBV2.auth;
    const client = auth && auth.getClient && auth.getClient();
    if (!client || typeof client.channel !== "function") {
      // SDK without realtime support (older bundle) → fall back to
      // staying "off" silently; the polling-based UI still works.
      setStatus("off");
      return;
    }
    setStatus("connecting");

    // Incidents channel — refresh admin-overview when any incident row
    // changes so the operator sees acks/resolutions in real time.
    const incidentsCh = client
      .channel("admin-realtime-incidents")
      .on("postgres_changes", {
        event: "*",                       // INSERT/UPDATE/DELETE
        schema: "public",
        table: "admin_incidents",
      }, function () {
        state.lastEventAt = Date.now();
        setStatus("live");
        // Force the admin-overview cache to refresh on next render.
        const adminRemote = window.CBV2.adminHelpers && window.CBV2.adminHelpers.adminRemote;
        bumpCache(adminRemote);
        // Trigger a re-fetch + re-render if we're on admin.
        if (isAdminRoute() && window.CBV2.adminMetrics && window.CBV2.adminMetrics.fetch) {
          window.CBV2.adminMetrics.fetch(true);
        }
      })
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          state.lastEventAt = Date.now();
          setStatus("live");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setStatus("error");
        } else if (status === "CLOSED") {
          // Don't override "off" — channels close on teardown.
          if (state.status !== "off") setStatus("error");
        }
      });
    state.channels.push(incidentsCh);

    // Audit log channel — when a new audit entry lands, mark the audit
    // cache dirty so the next visit to Operations/Reports sees it.
    const auditCh = client
      .channel("admin-realtime-audit")
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "admin_audit_log",
      }, function () {
        state.lastEventAt = Date.now();
        const auditRemote = window.CBV2.adminHelpers && window.CBV2.adminHelpers.adminAuditRemote;
        bumpCache(auditRemote);
        // If the operator is currently on a section that displays the
        // audit log, force-fetch.
        const st = window.CBV2 && window.CBV2.getRouteParams && window.CBV2.getRouteParams();
        const section = st && st.section;
        if ((section === "operations" || section === "reports") && window.CBV2.adminAudit && window.CBV2.adminAudit.fetch) {
          window.CBV2.adminAudit.fetch({ force: true });
        }
      })
      .subscribe();
    state.channels.push(auditCh);
  }

  // Re-evaluate every time the route or auth changes. The router fires
  // afterRender, but we also tear down on sign-out via the auth listener.
  function refresh() {
    if (isAdminRoute() && isAdminAuthed()) {
      setup();
    } else {
      teardown();
    }
  }

  // Hook into auth state changes (sign-out tears channels down).
  function wireAuth(attempts) {
    attempts = attempts || 0;
    const auth = window.CBV2 && window.CBV2.auth;
    if (auth && typeof auth.onChange === "function") {
      auth.onChange(refresh);
      return;
    }
    if (attempts < 50) {
      setTimeout(function () { wireAuth(attempts + 1); }, 100);
    }
  }
  wireAuth();

  window.CBV2.adminRealtime = {
    setup: setup,
    teardown: teardown,
    refresh: refresh,
    state: getState,
    onChange: function (fn) {
      if (typeof fn === "function") state.listeners.push(fn);
    },
  };
})();
