/* eslint-disable no-console */
// Phase Billing tests:
//   1. Frontend entitlements module API surface + canConsume / remaining
//   2. Upgrade modal + entitlement gate API surface
//   3. Backend contract: migration shape, Stripe Edge Function shape,
//      config + package.json registration

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}
function readRoot(rel) {
  return fs.readFileSync(path.resolve(__dirname, "..", "..", rel), "utf8");
}
function loadScript(ctx, relPath) {
  vm.runInContext(read(relPath), ctx, { filename: relPath });
}

function makeBrowserContext() {
  const window = {
    CBV2: {
      config: { isBackendEnabled: function () { return false; } },
      // No auth.onChange → entitlements falls through to FREE_FALLBACK.
    }
  };
  const doc = {
    readyState: "complete",
    addEventListener: function () {},
    createElement: function () {
      return {
        textContent: "",
        innerHTML: "",
        appendChild: function () {},
        addEventListener: function () {},
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        setAttribute: function () {},
        remove: function () {},
        focus: function () {},
      };
    },
    head: { appendChild: function () {} },
    body: { appendChild: function () {} },
    getElementById: function () { return null; },
  };
  return vm.createContext({
    window: window,
    document: doc,
    console: console,
    Date: Date,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    Promise: Promise,
    setTimeout: setTimeout,
    setInterval: function () { return 0; },
    clearInterval: function () {},
    crypto: { randomUUID: function () { return "00000000-0000-4000-8000-000000000000"; } },
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } }); },
  });
}

function run() {
  // ─── Frontend entitlements ──────────────────────────────────────────
  const ctx = makeBrowserContext();
  loadScript(ctx, "src/js/services/entitlements/entitlements.js");
  const ent = ctx.window.CBV2.entitlements;
  assert.ok(ent, "entitlements should expose window.CBV2.entitlements");
  // API surface
  ["load","get","planId","planLabel","canUseFeature","canConsume","remaining","canHoldMore","upgradeNeededFor","recordConsumption","onChange"].forEach(function (k) {
    assert.strictEqual(typeof ent[k], "function", "entitlements." + k + " should be a function");
  });

  // Without loading from backend, get() is null.
  assert.strictEqual(ent.get(), null, "get() should be null before load");

  // After load() with backend disabled, we get the FREE_FALLBACK.
  return ent.load(true).then(function (data) {
    assert.ok(data, "load() should resolve to data");
    assert.strictEqual(data.plan_id, "free", "fallback plan should be free");

    // canConsume basics
    assert.strictEqual(ent.canConsume("ai_resumes", 1), true, "1 resume allowed on free");
    assert.strictEqual(ent.canConsume("ai_resumes", 2), false, "2 resumes exceeds free monthly limit of 1");

    // remaining: free starts with 1 resume, after recording 1 should be 0.
    assert.strictEqual(ent.remaining("ai_resumes"), 1, "free starts with 1 ai_resumes remaining");
    ent.recordConsumption("ai_resumes");
    assert.strictEqual(ent.remaining("ai_resumes"), 0, "after consumption remaining is 0");
    assert.strictEqual(ent.canConsume("ai_resumes", 1), false, "no resumes left to consume");

    // unlimited features (none on free)
    assert.strictEqual(ent.canUseFeature("voice_mode"), false, "voice_mode locked on free");
    assert.strictEqual(ent.canUseFeature("priority_ai"), false, "priority_ai locked on free");

    // canHoldMore: free has 5-saved-jobs cap
    assert.strictEqual(ent.canHoldMore("saved_jobs", 4, 1), true, "free can hold up to 5 saved");
    assert.strictEqual(ent.canHoldMore("saved_jobs", 5, 1), false, "free cannot add a 6th saved");

    // Upgrade mapping
    assert.strictEqual(ent.upgradeNeededFor({ feature: "voice_mode" }), "pro", "voice_mode unlocks at pro");
    assert.strictEqual(ent.upgradeNeededFor({ feature: "priority_ai" }), "career", "priority_ai unlocks at career");
    assert.strictEqual(ent.upgradeNeededFor({ quota: "ai_resumes" }), "plus", "ai_resumes upgrade goes to plus");

    console.log("Entitlements module tests passed.");
  })
  .then(function () {
    // ─── Upgrade modal + gate API surface ──────────────────────────────
    const ctx2 = makeBrowserContext();
    loadScript(ctx2, "src/js/services/entitlements/entitlements.js");
    loadScript(ctx2, "src/js/components/upgrade-modal.js");
    loadScript(ctx2, "src/js/services/entitlements/entitlement-gate.js");
    const modal = ctx2.window.CBV2.upgradeModal;
    const gate = ctx2.window.CBV2.entitlementGate;
    assert.ok(modal, "upgrade modal should expose window.CBV2.upgradeModal");
    assert.strictEqual(typeof modal.show, "function", "modal.show should be a function");
    assert.strictEqual(typeof modal.startCheckout, "function", "modal.startCheckout should be a function");
    assert.strictEqual(modal._installed, true, "upgrade modal should mark installed");
    assert.ok(gate, "entitlement gate should expose window.CBV2.entitlementGate");
    assert.strictEqual(typeof gate.checkQuota, "function", "gate.checkQuota should be a function");
    assert.strictEqual(typeof gate.checkFeature, "function", "gate.checkFeature should be a function");
    assert.strictEqual(typeof gate.checkCap, "function", "gate.checkCap should be a function");

    console.log("Upgrade modal + gate tests passed.");
  })
  .then(function () {
    // ─── Backend contract ──────────────────────────────────────────────
    const migration = readRoot("backend/supabase/migrations/0016_subscriptions.sql");
    assert.ok(/create table if not exists public\.plan_catalog/.test(migration),
      "migration creates plan_catalog");
    assert.ok(/create table if not exists public\.subscriptions/.test(migration),
      "migration creates subscriptions");
    assert.ok(/create table if not exists public\.usage_counters/.test(migration),
      "migration creates usage_counters");
    // Plans seeded
    ["'free'", "'plus'", "'pro'", "'career'"].forEach(function (id) {
      assert.ok(migration.indexOf(id) >= 0, "migration seeds " + id + " plan");
    });
    // RPCs
    assert.ok(/create or replace function public\.get_user_entitlements/.test(migration),
      "migration creates get_user_entitlements RPC");
    assert.ok(/create or replace function public\.consume_quota/.test(migration),
      "migration creates consume_quota RPC");
    // SECURITY DEFINER on both
    assert.ok(migration.match(/security definer/g)?.length >= 2,
      "both RPCs should be SECURITY DEFINER");
    // RLS
    assert.ok(/alter table public\.subscriptions enable row level security/.test(migration),
      "subscriptions has RLS enabled");
    assert.ok(/alter table public\.subscriptions force row level security/.test(migration),
      "subscriptions force RLS");
    assert.ok(/alter table public\.usage_counters enable row level security/.test(migration),
      "usage_counters has RLS enabled");
    // No client-side mutation
    assert.ok(/revoke insert, update, delete on public\.subscriptions from authenticated/.test(migration),
      "client cannot mutate subscriptions");
    assert.ok(/revoke insert, update, delete on public\.usage_counters from authenticated/.test(migration),
      "client cannot mutate usage_counters");

    // Edge Functions
    const checkout = readRoot("backend/supabase/functions/stripe-checkout/index.ts");
    assert.ok(/getAuthedUser\(req\)/.test(checkout), "stripe-checkout authenticates caller");
    assert.ok(/STRIPE_SECRET_KEY/.test(checkout), "stripe-checkout reads STRIPE_SECRET_KEY");
    assert.ok(/checkout\/sessions/.test(checkout), "stripe-checkout calls Stripe Checkout API");
    assert.ok(/cb_user_id/.test(checkout), "stripe-checkout tags subscription with cb_user_id");

    const webhook = readRoot("backend/supabase/functions/stripe-webhook/index.ts");
    assert.ok(/verifySignature/.test(webhook), "stripe-webhook verifies signature");
    assert.ok(/STRIPE_WEBHOOK_SECRET/.test(webhook), "stripe-webhook reads webhook secret");
    assert.ok(/checkout\.session\.completed/.test(webhook), "handles checkout.session.completed");
    assert.ok(/customer\.subscription\.updated/.test(webhook), "handles customer.subscription.updated");
    assert.ok(/customer\.subscription\.deleted/.test(webhook), "handles customer.subscription.deleted");
    assert.ok(/invoice\.payment_failed/.test(webhook), "handles invoice.payment_failed");
    assert.ok(/invoice\.paid/.test(webhook), "handles invoice.paid");
    assert.ok(/crypto\.subtle/.test(webhook), "uses Web Crypto for HMAC verification");

    const portal = readRoot("backend/supabase/functions/stripe-portal/index.ts");
    assert.ok(/getAuthedUser\(req\)/.test(portal), "stripe-portal authenticates caller");
    assert.ok(/billing_portal\/sessions/.test(portal), "stripe-portal calls Stripe Billing Portal API");

    const entFn = readRoot("backend/supabase/functions/get-entitlements/index.ts");
    assert.ok(/get_user_entitlements/.test(entFn), "get-entitlements calls the RPC");
    assert.ok(/getAuthedUser\(req\)/.test(entFn), "get-entitlements authenticates");

    // config.toml registration
    const cfg = readRoot("backend/supabase/config.toml");
    ["stripe-checkout","stripe-webhook","stripe-portal","get-entitlements"].forEach(function (fn) {
      assert.ok(cfg.indexOf("[functions." + fn + "]") >= 0, "config registers " + fn);
    });

    // package.json deploy scripts
    const pkg = readRoot("backend/package.json");
    ["fn:deploy:stripe-checkout","fn:deploy:stripe-webhook","fn:deploy:stripe-portal","fn:deploy:get-entitlements"].forEach(function (s) {
      assert.ok(pkg.indexOf(s) >= 0, "package.json has " + s + " deploy script");
    });

    console.log("Billing backend contract tests passed.");
  })
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

run();
