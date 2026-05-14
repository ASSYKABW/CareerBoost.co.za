// Phase Billing: tiny call-site helper that wraps the entitlement
// check + upgrade modal into one function.
//
// Usage at any call site that needs to gate an action:
//
//   const ok = await window.CBV2.entitlementGate.checkQuota("ai_resumes");
//   if (!ok) return; // user saw upgrade modal, chose cancel
//   // ...proceed with the AI call...
//   window.CBV2.entitlements.recordConsumption("ai_resumes");
//
// Or for feature flags:
//
//   const ok = await window.CBV2.entitlementGate.checkFeature("voice_mode");
//   if (!ok) return;
//
// Or for item caps (saved jobs):
//
//   const ok = window.CBV2.entitlementGate.checkCap("saved_jobs", currentCount);
//   if (!ok) {
//     await window.CBV2.upgradeModal.show({ reason:"cap_exceeded", cap:"saved_jobs" });
//     return;
//   }
//
// All three return a boolean: true if the action can proceed,
// false if blocked (and the modal has already been shown).

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.entitlementGate && window.CBV2.entitlementGate._installed) return;

  async function checkQuota(quotaKey, opts) {
    opts = opts || {};
    const ent = window.CBV2 && window.CBV2.entitlements;
    if (!ent) return true; // entitlements not loaded → don't block UX
    // Lazy-load if we have no data yet.
    if (!ent.get()) {
      try { await ent.load(); } catch (e) { /* fall through */ }
    }
    if (ent.canConsume(quotaKey, opts.amount || 1)) return true;
    // Quota exhausted — show modal.
    const upgrade = window.CBV2 && window.CBV2.upgradeModal;
    if (upgrade && typeof upgrade.show === "function") {
      await upgrade.show({
        reason: "quota_exhausted",
        quota: quotaKey,
      });
    }
    return false;
  }

  async function checkFeature(featureKey) {
    const ent = window.CBV2 && window.CBV2.entitlements;
    if (!ent) return true;
    if (!ent.get()) {
      try { await ent.load(); } catch (e) { /* fall through */ }
    }
    if (ent.canUseFeature(featureKey)) return true;
    const upgrade = window.CBV2 && window.CBV2.upgradeModal;
    if (upgrade && typeof upgrade.show === "function") {
      await upgrade.show({
        reason: "feature_locked",
        feature: featureKey,
      });
    }
    return false;
  }

  function checkCap(capKey, currentCount, additional) {
    const ent = window.CBV2 && window.CBV2.entitlements;
    if (!ent) return true;
    return ent.canHoldMore(capKey, currentCount, additional || 1);
  }

  async function showCapModal(capKey) {
    const upgrade = window.CBV2 && window.CBV2.upgradeModal;
    if (upgrade && typeof upgrade.show === "function") {
      await upgrade.show({ reason: "cap_exceeded", cap: capKey });
    }
  }

  window.CBV2.entitlementGate = {
    checkQuota: checkQuota,
    checkFeature: checkFeature,
    checkCap: checkCap,
    showCapModal: showCapModal,
    _installed: true,
  };
})();
