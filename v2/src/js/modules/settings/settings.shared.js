// Settings → shared helpers used across the extracted settings sub-modules.
//
// P1: hoisted out of settings.route.js so sub-modules (settings.ai.js, etc.)
// can write preferences the same safe way the monolith did. savePreferencePatch
// serializes writes and deep-merges into profile.preferences, so two
// near-simultaneous saves from different sections can't clobber each other.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsShared = window.CBV2.settingsShared || {};

  let _prefSaveChain = Promise.resolve();

  function deepMergePreferences(base, patch) {
    const out = Object.assign({}, base && typeof base === "object" ? base : {});
    Object.keys(patch || {}).forEach(function (k) {
      const pv = patch[k];
      const bv = out[k];
      if (pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv)) {
        out[k] = deepMergePreferences(bv, pv);
      } else {
        out[k] = pv;
      }
    });
    return out;
  }

  function savePreferencePatch(patch) {
    const run = function () {
      if (!(window.CBV2.profile && typeof window.CBV2.profile.update === "function")) {
        return Promise.resolve(null);
      }
      const current = (window.CBV2.profile.get && window.CBV2.profile.get()) || {};
      const preferences = (current.preferences && typeof current.preferences === "object") ? current.preferences : {};
      return window.CBV2.profile.update({ preferences: deepMergePreferences(preferences, patch) });
    };
    // Chain so concurrent saves serialize; a failed write doesn't break the
    // chain for the next writer.
    const result = _prefSaveChain.then(run, run);
    _prefSaveChain = result.then(function () {}, function () {});
    return result;
  }

  window.CBV2.settingsShared.deepMergePreferences = deepMergePreferences;
  window.CBV2.settingsShared.savePreferencePatch = savePreferencePatch;
})();
