// Thin wrapper around the Supabase JS SDK.
// The SDK is loaded globally via CDN in index.html as `window.supabase`.
// Exposes a consistent API that the rest of the app can use without caring
// whether the backend is enabled.
(function () {
  window.CBV2 = window.CBV2 || {};

  const state = {
    client: null,
    session: null,
    user: null,
    ready: false,
    listeners: []
  };

  function ensureClient() {
    if (state.client) return state.client;
    if (!window.CBV2.config.isBackendEnabled()) return null;
    const sb = window.supabase;
    if (!sb || typeof sb.createClient !== "function") {
      console.warn("[auth] Supabase SDK not loaded — backend features disabled.");
      return null;
    }
    state.client = sb.createClient(
      window.CBV2.config.getSupabaseUrl(),
      window.CBV2.config.getSupabaseAnon(),
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "cbv2_auth_v1"
        }
      }
    );

    // Day 4.1 — wrap client.functions.invoke so every Edge Function
    // call auto-reports to the sync monitor. Network errors + 5xx
    // count as failures; 4xx (auth/quota/bad-request) do NOT — those
    // are logic errors, not sync problems, and surfacing a "having
    // trouble syncing" banner for a quota_exhausted would be wrong.
    try {
      if (state.client && state.client.functions && typeof state.client.functions.invoke === "function") {
        const originalInvoke = state.client.functions.invoke.bind(state.client.functions);
        state.client.functions.invoke = async function patchedInvoke(name, options) {
          try {
            const result = await originalInvoke(name, options);
            const mon = window.CBV2 && window.CBV2.syncMonitor;
            if (mon) {
              if (result && result.error) {
                const status = result.error.context && typeof result.error.context.status === "number"
                  ? result.error.context.status
                  : 0;
                // Only count network/5xx as a sync failure. 4xx is the
                // server speaking back correctly — not "trouble syncing".
                if (status === 0 || status >= 500) {
                  mon.recordFailure(name + " → HTTP " + (status || "network"));
                } else {
                  mon.recordSuccess();
                }
              } else {
                mon.recordSuccess();
              }
            }
            return result;
          } catch (err) {
            const mon = window.CBV2 && window.CBV2.syncMonitor;
            if (mon) mon.recordFailure(name + " threw: " + ((err && err.message) || "unknown"));
            throw err;
          }
        };
      }
    } catch (e) {
      console.warn("[auth] sync-monitor patch failed (non-fatal):", e);
    }

    return state.client;
  }

  function notify() {
    state.listeners.forEach(function (fn) {
      try { fn(state.session); } catch (e) { /* ignore */ }
    });
  }

  function trackUsage(eventName, metadata) {
    const usage = window.CBV2 && window.CBV2.usage;
    if (usage && typeof usage.track === "function") {
      usage.track(eventName, metadata || {}, { module: "auth", category: "auth", route: "auth" });
    }
  }

  // The whole app boot awaits init() before the public landing page paints.
  // getSession() is localStorage-first and normally instant, but when the
  // stored token is expired it makes a network refresh — and it carries no
  // timeout of its own. A stall there (Supabase paused, a slow SA mobile
  // connection, an unreachable network) used to block the ENTIRE boot behind
  // the "Loading your workspace…" splash with no escape but an 8s hint. A
  // marketing page must never wait on the auth subsystem to appear. So we cap
  // the wait: past this, we proceed as signed-out and let the auth listener
  // (registered up front, below) reconcile if a session lands a moment later.
  const AUTH_INIT_TIMEOUT_MS = 3500;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("auth init timed out after " + ms + "ms"));
      }, ms);
      Promise.resolve(promise).then(
        function (v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
        function (e) { if (settled) return; settled = true; clearTimeout(timer); reject(e); }
      );
    });
  }

  async function init() {
    const client = ensureClient();
    if (!client) { state.ready = true; return null; }

    // Register the auth-state listener BEFORE awaiting getSession, so a session
    // that arrives late (a slow refresh, or after the timeout above) is still
    // caught and reconciled rather than lost.
    client.auth.onAuthStateChange(function (_evt, session) {
      state.session = session || null;
      state.user = session ? session.user : null;
      notify();
    });

    try {
      const res = await withTimeout(client.auth.getSession(), AUTH_INIT_TIMEOUT_MS);
      const data = res && res.data;
      state.session = data ? data.session : null;
      state.user = state.session ? state.session.user : null;
    } catch (e) {
      // Timed out or errored — boot as signed-out for now. The listener above
      // keeps state.session if it already resolved, and will correct us if the
      // session shows up after this point. Never leave the app on the splash.
      if (window.__CAREERBOOST_AUTH_DEBUG) console.warn("[auth] getSession slow/failed, booting unauthed:", (e && e.message) || e);
    }
    state.ready = true;

    return state.session;
  }

  async function signInWithPassword(email, password) {
    const client = ensureClient();
    if (!client) throw new Error("Backend not configured.");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    trackUsage("sign_in", { method: "password" });
    return data;
  }

  // Build a redirect URL that survives email clicks from other devices.
  // CB_CONFIG.siteUrl (if set) is the canonical production origin so
  // emails sent to a user's phone or another browser still land there.
  // BUT: when the page is loaded from a local context (file://,
  // localhost, 127.0.0.1), prefer the current origin so OAuth and
  // reset links round-trip back to where the user actually is. This
  // avoids "DNS_PROBE_FINISHED_NXDOMAIN" when the production domain
  // isn't live yet.
  function buildRedirect(hashPath) {
    const cfg = (typeof window !== "undefined" && window.CB_CONFIG) || {};
    const cfgUrl = (cfg.siteUrl || "").trim();
    const loc = (typeof window !== "undefined" && window.location) || {};
    const origin = String(loc.origin || "");
    const isLocal =
      /^file:/i.test(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin);
    const useCfg = cfgUrl && !isLocal;
    const base = useCfg
      ? cfgUrl.replace(/\/+$/, "")
      : ((loc.origin || "") + (loc.pathname || "")).replace(/\/+$/, "");
    return base + hashPath;
  }

  async function signUpWithPassword(email, password, fullName) {
    const client = ensureClient();
    if (!client) throw new Error("Backend not configured.");
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName || "" },
        // Dedicated landing route that shows a polished "You're in!"
        // message before routing to the dashboard.
        emailRedirectTo: buildRedirect("#/auth/confirmed")
      }
    });
    if (error) throw error;
    trackUsage("sign_up", { method: "password", hasFullName: Boolean(fullName) });
    return data;
  }

  async function signInWithOAuth(provider) {
    const client = ensureClient();
    if (!client) throw new Error("Backend not configured.");
    const redirectTo = buildRedirect("#/auth/confirmed");
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo }
    });
    if (error) throw error;
    trackUsage("auth_oauth_started", { provider: provider || "oauth" });
    return data;
  }

  async function sendPasswordReset(email) {
    const client = ensureClient();
    if (!client) throw new Error("Backend not configured.");
    // P3 reset: point the recovery link at the new #/auth/reset route
    // (auth.reset.js) which provides the "type your new password" UI.
    // Previously this went to #/auth?reset=1 which silently dropped
    // users on the sign-in page with no way to actually reset.
    const redirectTo = buildRedirect("#/auth/reset");
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }

  // P3 (signup security): verify a 6-digit OTP from the confirmation
  // email. Supabase's email template needs to include {{ .Token }} for
  // this to work — see docs/SUPABASE-EMAIL-OTP.md for the dashboard
  // change. The link in the email (using {{ .ConfirmationURL }}) still
  // works as a fallback for users who can't see / type the code.
  //
  // On success the returned session is automatically stored by the
  // SDK and onChange listeners (including the router) fire.
  async function verifyEmailOtp(email, token) {
    const client = ensureClient();
    if (!client) throw new Error("Backend not configured.");
    // Supabase OTP length is configurable in the dashboard (6-10
    // digits, default 6). Accept any length in that range so the
    // helper works regardless of dashboard setting.
    const cleaned = String(token || "").replace(/\D/g, "").slice(0, 10);
    if (cleaned.length < 6 || cleaned.length > 10) {
      throw new Error("Enter the code from your email (6-10 digits).");
    }
    const { data, error } = await client.auth.verifyOtp({
      email: String(email || "").trim().toLowerCase(),
      token: cleaned,
      type: "signup"
    });
    if (error) throw error;
    trackUsage("verify_email_otp", { method: "otp", length: cleaned.length });
    return data;
  }

  // Resend the signup confirmation email. Rate-limited by Supabase to
  // 1 per 60s per email (default), so the UI debounces accordingly.
  async function resendSignupOtp(email) {
    const client = ensureClient();
    if (!client) throw new Error("Backend not configured.");
    const { error } = await client.auth.resend({
      type: "signup",
      email: String(email || "").trim().toLowerCase(),
      options: { emailRedirectTo: buildRedirect("#/auth/confirmed") }
    });
    if (error) throw error;
    trackUsage("resend_signup_otp", {});
  }

  async function signOut() {
    const client = ensureClient();
    if (!client) return;
    trackUsage("sign_out", { method: "user" });
    await client.auth.signOut();
  }

  function getSession() { return state.session; }
  function getUser() { return state.user; }
  function isAuthenticated() { return Boolean(state.session); }
  function isReady() { return state.ready; }
  function getClient() { return state.client; }
  function onChange(fn) { state.listeners.push(fn); }

  async function getAccessToken() {
    const client = ensureClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }

  window.CBV2.auth = {
    init,
    signInWithPassword,
    signUpWithPassword,
    signInWithOAuth,
    sendPasswordReset,
    verifyEmailOtp,
    resendSignupOtp,
    signOut,
    getSession,
    getUser,
    getClient,
    getAccessToken,
    isAuthenticated,
    isReady,
    onChange
  };
})();
