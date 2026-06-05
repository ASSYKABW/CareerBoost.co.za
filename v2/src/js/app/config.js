// Runtime config for the CareerBoost client.
// Leave the values below blank to run fully offline (localStorage mode).
// Fill them in AFTER deploying the Supabase backend (see /backend/README.md).
(function () {
  window.CB_CONFIG = Object.assign(
    {
      // Paste these from Supabase Dashboard → Settings → API
      supabaseUrl: "https://kddffkhwpbngiupfmcse.supabase.co",
      supabaseAnon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkZGZma2h3cGJuZ2l1cGZtY3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MjE4MDAsImV4cCI6MjA5MjE5NzgwMH0.glvjjwKq3JeOy8HF71JfwzW0m45DvwK8tSbnqxu-JY8",
      // If blank, it's derived from supabaseUrl: https://<ref>.functions.supabase.co
      functionsUrl: "",
      // PWA Web Push: paste the VAPID *public* key here after generating a
      // keypair (`npx web-push generate-vapid-keys`). Leave blank to keep push
      // dormant — the Settings "Push notifications" card stays hidden until set.
      // The matching PRIVATE key goes in Supabase function secrets, never here.
      vapidPublicKey: "",
      // Canonical production origin (no trailing slash). When set, auth
      // email redirects (signup confirmation, OAuth, password reset)
      // point HERE so the link works regardless of which device opens
      // the email. Leave blank for local dev — the auth flow falls
      // back to the current origin + pathname (works in the same
      // browser session that signed up). MUST also be listed in
      // Supabase Dashboard → Authentication → URL Configuration →
      // Additional Redirect URLs.
      // Examples:  "https://careerboost.app"  |  "https://www.careerboost.app"
      //
      // Production canonical URL. Vercel hosts both apex + www, but the
      // apex 307-redirects to www so www is the canonical destination
      // for OAuth/email-confirmation round-trips. This URL MUST also
      // be present in Supabase Dashboard → Authentication → URL
      // Configuration → Site URL field AND in the Additional Redirect
      // URLs allowlist.
      siteUrl: "https://www.careerboost.co.za",
      // Force local-only mode even if supabase keys are set (useful for demos)
      forceLocal: false,
      // Admin console access is granted from Supabase Auth app_metadata roles.
      // Do not put candidate emails here; set roles on the user in Supabase.
      adminAccess: {
        roles: ["admin", "owner", "developer"]
      },
      // Show Google + LinkedIn sign-in buttons. Set to true AFTER you've
      // configured those providers in the Supabase Dashboard.
      // Phase 4: enabled by default — Google OAuth is the highest-leverage
      // conversion lift. Disable here if you haven't configured providers yet.
      oauthEnabled: true,
      // Which OAuth providers to surface on auth + landing CTAs.
      oauthProviders: ["google"],
      // LinkedIn-style listings via Google Programmable Search (Custom Search JSON
      // API). Set GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX on the external-search and
      // company-intel-search Edge Functions; disable here if you do not want the extra call each search.
      externalSearch: {
        enabled: true,
        provider: "all"
      },
      // Feature flags for controlled rollouts.
      featureFlags: {
        searchStrictConstraints: true,
        searchExplainability: true,
        // V1 in-app AI guidance panel (floating bottom-right). Flip to
        // true for your own account to test before wider rollout.
        aiChatPanel: true,
        // Apply Assist (Chrome extension auto-fills ATS forms). V1 scoped
        // to Greenhouse only — disabled until at least Lever ships so the
        // feature isn't visibly "Greenhouse-only" to most users. See
        // Settings → Admin → "Apply Assist (deferred)" for re-enable
        // criteria.
        applyAssist: false
      }
    },
    window.CB_CONFIG || {}
  );

  // Canonical Supabase functions URL. Both "<ref>.supabase.co/functions/v1"
  // and the legacy "<ref>.functions.supabase.co" work, but the canonical
  // path form has the most consistent JWT + CORS handling.
  function derivedFunctionsUrl(supabaseUrl) {
    if (!supabaseUrl) return "";
    return String(supabaseUrl).replace(/\/+$/, "") + "/functions/v1";
  }

  window.CBV2 = window.CBV2 || {};
  window.CBV2.config = {
    /** Session-only: signed-in user forces guest-style in-browser job providers (see docs/JOB_SEARCH_ARCHITECTURE.md). */
    isForceClientJobSearch: function () {
      try {
        if (typeof sessionStorage === "undefined") return false;
        return sessionStorage.getItem("cb_force_client_job_search") === "1";
      } catch (e) {
        return false;
      }
    },
    isBackendEnabled: function () {
      const c = window.CB_CONFIG;
      return Boolean(c && !c.forceLocal && c.supabaseUrl && c.supabaseAnon);
    },
    /** Signed-in + cloud: Job Search uses jobs-search only (see docs/JOB_SEARCH_ARCHITECTURE.md). */
    isCloudJobSearchPrimary: function () {
      if (this.isForceClientJobSearch()) return false;
      if (!this.isBackendEnabled()) return false;
      const auth = window.CBV2 && window.CBV2.auth;
      return Boolean(auth && typeof auth.isAuthenticated === "function" && auth.isAuthenticated());
    },
    getSupabaseUrl: function () {
      return window.CB_CONFIG.supabaseUrl;
    },
    getSupabaseAnon: function () {
      return window.CB_CONFIG.supabaseAnon;
    },
    getFunctionsUrl: function () {
      return (
        window.CB_CONFIG.functionsUrl ||
        derivedFunctionsUrl(window.CB_CONFIG.supabaseUrl)
      );
    },
    isFeatureEnabled: function (name) {
      const ff = (window.CB_CONFIG && window.CB_CONFIG.featureFlags) || {};
      if (!Object.prototype.hasOwnProperty.call(ff, name)) return true;
      return !!ff[name];
    }
  };
})();
