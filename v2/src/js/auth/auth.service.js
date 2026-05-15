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

  async function init() {
    const client = ensureClient();
    if (!client) { state.ready = true; return null; }

    const { data } = await client.auth.getSession();
    state.session = data ? data.session : null;
    state.user = state.session ? state.session.user : null;
    state.ready = true;

    client.auth.onAuthStateChange(function (_evt, session) {
      state.session = session || null;
      state.user = session ? session.user : null;
      notify();
    });

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
    const redirectTo = buildRedirect("#/auth?reset=1");
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
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
