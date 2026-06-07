// Shared promo state — reads the public promo_settings row (anon-readable
// via RLS) once and caches it, so the landing banner and the in-app upgrade
// modal both reflect what the admin Promotions panel has configured. No
// hardcoded dates: turning the campaign off in admin turns the banner +
// note off everywhere.
(function () {
  window.CBV2 = window.CBV2 || {};

  var cache = null;     // { enabled, percent, end_date, plans, intervals } | null
  var loaded = false;
  var inflight = null;

  function client() {
    var a = window.CBV2.auth;
    return a && a.getClient && a.getClient();
  }

  // Load + cache once. Retry-friendly: if the Supabase client isn't ready
  // yet we DON'T mark loaded, so a later caller can try again.
  function load() {
    if (loaded) return Promise.resolve(cache);
    if (inflight) return inflight;
    var c = client();
    if (!c || !c.from) return Promise.resolve(null);
    inflight = c.from("promo_settings")
      .select("enabled,percent,end_date,plans,intervals")
      .eq("id", 1)
      .maybeSingle()
      .then(function (res) {
        cache = (res && res.data) || null;
        loaded = true;
        inflight = null;
        return cache;
      })
      .catch(function () { inflight = null; return null; });
    return inflight;
  }

  function withinWindow(p) {
    if (!p.end_date) return true;
    var end = Date.parse(String(p.end_date) + "T23:59:59Z");
    return isNaN(end) || Date.now() <= end;
  }

  // Active in general (banner) or for a specific interval/plan (modal).
  function isActive(interval, planId) {
    if (!cache || !cache.enabled) return false;
    if (!withinWindow(cache)) return false;
    if (interval && Array.isArray(cache.intervals) && cache.intervals.indexOf(interval) < 0) return false;
    if (planId && Array.isArray(cache.plans) && cache.plans.indexOf(planId) < 0) return false;
    return true;
  }

  // Word for the discounted period, based on which intervals are enabled.
  function periodWord() {
    if (cache && Array.isArray(cache.intervals) &&
        cache.intervals.indexOf("monthly") < 0 && cache.intervals.indexOf("annual") >= 0) {
      return "year";
    }
    return "month";
  }

  window.CBV2.promo = {
    load: load,
    current: function () { return cache; },
    isActive: isActive,
    percent: function () { return cache && cache.percent != null ? cache.percent : 30; },
    periodWord: periodWord,
  };
})();
