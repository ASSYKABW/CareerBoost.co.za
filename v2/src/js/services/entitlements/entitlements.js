// Phase Billing: client-side entitlements service.
//
// Provides a stable API for the rest of the app to ask:
//   - Is the user allowed to use feature X?
//   - How many of quota Y do they have left this month?
//   - If they can't, what plan unlocks it?
//
// State is cached per session and refreshed:
//   - On sign-in (cold load)
//   - 30s after a quota-consuming action (so the next click sees the
//     new remaining count)
//   - On window focus after 60s+ idle (catches webhook updates)
//   - On explicit refresh() call (after a successful checkout)
//
// IMPORTANT: this module is ADVISORY ONLY for UX. The backend RPC
// consume_quota is the authority — it's row-locked and won't let a
// user exceed their plan even if they bypass the frontend. We use it
// here to render upgrade prompts before the user clicks a button that
// would fail.
//
// API:
//   await entitlements.load()                      // refresh from backend
//   entitlements.get()                              // current cached object or null
//   entitlements.canUseFeature("voice_mode")       // boolean
//   entitlements.canConsume("ai_resumes", n=1)     // boolean
//   entitlements.remaining("ai_resumes")           // number | null (null = unlimited)
//   entitlements.planId()                          // "free" | "plus" | "pro" | "career"
//   entitlements.planLabel()                       // "Free" | "Plus" | "Pro" | "Career"
//   entitlements.upgradeNeededFor(feature)         // returns smallest plan that unlocks
//   entitlements.recordConsumption(quotaKey)       // optimistically decrement cached count
//   entitlements.onChange(fn)                      // notify listeners on state change

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.entitlements && window.CBV2.entitlements._installed) return;

  const FREE_FALLBACK = {
    plan_id: "free",
    plan_label: "Free",
    status: "active",
    has_active_subscription: false,
    limits: {
      monthly: { ai_resumes: 1, ai_covers: 2, ai_mocks: 1, ai_research: 1, ai_question_banks: 1, ai_bullets: 10 },
      caps:    { saved_jobs: 5 },
      features:{ voice_mode: false, priority_ai: false, personal_analytics: false }
    },
    usage: { ai_resumes: 0, ai_covers: 0, ai_mocks: 0, ai_research: 0, ai_question_banks: 0, ai_bullets: 0 }
  };

  const state = {
    data: null,           // last loaded entitlements
    loadedAt: 0,
    loading: null,        // in-flight promise (dedupe parallel calls)
    listeners: [],
  };

  function notify() {
    state.listeners.forEach(function (fn) {
      try { fn(get()); } catch (e) { /* ignore listener error */ }
    });
  }

  // Where to call. Returns null if backend isn't configured (offline
  // / local-preview mode); callers should treat as free tier.
  function endpoint() {
    const c = window.CBV2 && window.CBV2.config;
    if (!c || !c.isBackendEnabled || !c.isBackendEnabled()) return null;
    return c.getFunctionsUrl() + "/get-entitlements";
  }

  async function load(force) {
    if (state.loading) return state.loading;
    if (!force && state.data && (Date.now() - state.loadedAt) < 30_000) return state.data;
    const url = endpoint();
    if (!url) {
      state.data = FREE_FALLBACK;
      state.loadedAt = Date.now();
      notify();
      return state.data;
    }
    const auth = window.CBV2 && window.CBV2.auth;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) {
      // Signed-out users get the free fallback (used by landing pricing).
      state.data = FREE_FALLBACK;
      state.loadedAt = Date.now();
      notify();
      return state.data;
    }

    state.loading = (async function () {
      try {
        // Prefer SDK invoke when available (better auth handling).
        const client = auth.getClient && auth.getClient();
        let body;
        if (client && client.functions && typeof client.functions.invoke === "function") {
          const invoked = await client.functions.invoke("get-entitlements", { body: {} });
          if (invoked.error) throw invoked.error;
          body = invoked.data;
        } else {
          const token = await auth.getAccessToken();
          const resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
              apikey: window.CBV2.config.getSupabaseAnon(),
            },
            body: "{}",
          });
          body = await resp.json();
          if (!resp.ok || !body || body.ok === false) throw new Error(body?.error || "Entitlements fetch failed.");
        }
        if (body && body.entitlements) {
          state.data = body.entitlements;
        } else {
          state.data = FREE_FALLBACK;
        }
        state.loadedAt = Date.now();
        notify();
        return state.data;
      } catch (err) {
        // Soft-fail: don't break the app if entitlements are
        // unreachable — fall back to free-tier limits. The backend RPC
        // is still the source of truth on actual consumption.
        if (console && console.warn) console.warn("[entitlements] load failed:", err && err.message ? err.message : err);
        state.data = state.data || FREE_FALLBACK;
        state.loadedAt = Date.now();
        notify();
        return state.data;
      } finally {
        state.loading = null;
      }
    })();
    return state.loading;
  }

  function get() {
    return state.data;
  }

  function planId() {
    return (state.data && state.data.plan_id) || "free";
  }
  function planLabel() {
    return (state.data && state.data.plan_label) || "Free";
  }

  function limits() {
    return (state.data && state.data.limits) || FREE_FALLBACK.limits;
  }
  function usage() {
    return (state.data && state.data.usage) || FREE_FALLBACK.usage;
  }

  // Feature flag check. Returns true when:
  //   - The feature is explicitly enabled on the plan
  //   - OR no entitlements have loaded yet (optimistic; the backend
  //     will reject if necessary)
  function canUseFeature(featureKey) {
    if (!state.data) return false;
    const features = (limits().features) || {};
    return !!features[featureKey];
  }

  // Quota check. Returns true if user has `amount` units left.
  // monthly_limit === null means unlimited.
  function canConsume(quotaKey, amount) {
    amount = amount || 1;
    const monthly = (limits().monthly) || {};
    const u = usage()[quotaKey] || 0;
    const lim = monthly[quotaKey];
    if (lim === null || lim === undefined) return true; // unlimited
    return (u + amount) <= lim;
  }

  function remaining(quotaKey) {
    const monthly = (limits().monthly) || {};
    const lim = monthly[quotaKey];
    if (lim === null || lim === undefined) return null;
    const u = usage()[quotaKey] || 0;
    return Math.max(0, lim - u);
  }

  // Same idea for item-cap (e.g. saved jobs total). Caller passes the
  // current count of items they hold; we compare against the cap.
  function canHoldMore(capKey, currentCount, additional) {
    additional = additional || 1;
    const caps = (limits().caps) || {};
    const cap = caps[capKey];
    if (cap === null || cap === undefined) return true;
    return (currentCount + additional) <= cap;
  }

  // Plan ordering — used for "what plan unlocks this?" copy.
  const PLAN_ORDER = ["free", "plus", "pro", "career"];

  // Returns the cheapest plan that unlocks a feature/quota — used by
  // the upgrade modal to render "Upgrade to <Plan>" copy with the
  // right tier name and price.
  function upgradeNeededFor(spec) {
    // spec: { feature: "voice_mode" } or { quota: "ai_resumes" }
    // We hard-code the plan unlocks because we don't have the catalog
    // loaded client-side. (Source of truth is plan_catalog in DB.)
    const PLAN_UNLOCKS = {
      // feature → smallest plan with feature == true
      voice_mode: "pro",
      priority_ai: "career",
      personal_analytics: "plus",
      // quota → smallest plan where the quota >= reasonable usage
      ai_resumes: "plus",
      ai_covers: "plus",
      ai_research: "plus",
      ai_question_banks: "plus",
      ai_mocks: "plus",
      ai_bullets: "plus",
      saved_jobs: "plus",
    };
    const key = spec.feature || spec.quota;
    return PLAN_UNLOCKS[key] || "pro";
  }

  // Optimistic decrement so the next click sees the new remaining
  // count immediately without waiting for a backend roundtrip. The
  // real value gets reconciled on next load().
  function recordConsumption(quotaKey, amount) {
    amount = amount || 1;
    if (!state.data || !state.data.usage) return;
    if (typeof state.data.usage[quotaKey] !== "number") return;
    state.data.usage[quotaKey] += amount;
    notify();
    // Reload from backend in 30s to reconcile (after the AI call has
    // had time to fire consume_quota server-side).
    setTimeout(function () { load(true).catch(function () {}); }, 30_000);
  }

  function onChange(fn) {
    if (typeof fn === "function") state.listeners.push(fn);
  }

  // Wire to auth state changes — load on signin, clear on signout.
  function wireAuth(attempts) {
    attempts = attempts || 0;
    const auth = window.CBV2 && window.CBV2.auth;
    if (auth && typeof auth.onChange === "function") {
      auth.onChange(function () {
        if (auth.isAuthenticated && auth.isAuthenticated()) {
          load(true).catch(function () {});
        } else {
          state.data = FREE_FALLBACK;
          state.loadedAt = Date.now();
          notify();
        }
      });
      // Also fire once now (we might be entering an already-authed session).
      if (auth.isAuthenticated && auth.isAuthenticated()) {
        load(true).catch(function () {});
      }
      return;
    }
    if (attempts < 50) {
      setTimeout(function () { wireAuth(attempts + 1); }, 100);
    }
  }
  wireAuth();

  // Re-load on window focus if data is older than 60s — catches
  // post-checkout updates without polling.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", function () {
      if (state.loadedAt && Date.now() - state.loadedAt > 60_000) {
        load(true).catch(function () {});
      }
    });
  }

  window.CBV2.entitlements = {
    load: load,
    get: get,
    planId: planId,
    planLabel: planLabel,
    limits: limits,
    usage: usage,
    canUseFeature: canUseFeature,
    canConsume: canConsume,
    remaining: remaining,
    canHoldMore: canHoldMore,
    upgradeNeededFor: upgradeNeededFor,
    recordConsumption: recordConsumption,
    onChange: onChange,
    _installed: true,
    // Plan ordering exposed for the upgrade modal.
    _PLAN_ORDER: PLAN_ORDER,
  };
})();
