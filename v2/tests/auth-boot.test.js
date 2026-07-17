/* eslint-disable no-console */
// Regression guard for the boot gate.
//
// The whole app boot awaits auth.init() before the public landing page paints.
// init() awaits client.auth.getSession(), which has no timeout of its own — so
// a stalled handshake (Supabase paused, slow mobile, expired-token refresh)
// once blocked the ENTIRE boot behind "Loading your workspace…" forever. init()
// now races getSession() against a timeout and registers its auth listener up
// front so a late session still reconciles. This locks that in: load the REAL
// module, force getSession to hang, and prove init() still resolves.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.resolve(__dirname, "..", "src/js/auth/auth.service.js"), "utf8");

// Load the real module in a sandbox with a controllable Supabase client double.
function makeHarness(sessionMode) {
  let authCb = null;
  const client = {
    auth: {
      getSession: function () {
        if (sessionMode === "fast") return Promise.resolve({ data: { session: { user: { id: "u1" }, access_token: "t" } } });
        if (sessionMode === "reject") return Promise.reject(new Error("network down"));
        return new Promise(function () {}); // "hang": never settles
      },
      onAuthStateChange: function (cb) { authCb = cb; return { data: { subscription: { unsubscribe: function () {} } } }; }
    },
    functions: {}
  };
  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, Boolean: Boolean, Error: Error,
    Number: Number, String: String, Object: Object, Array: Array,
    window: {
      supabase: { createClient: function () { return client; } },
      CBV2: { config: { isBackendEnabled: function () { return true; }, getSupabaseUrl: function () { return "https://x.supabase.co"; }, getSupabaseAnon: function () { return "anon"; } } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "auth.service.js" });
  return { auth: sandbox.window.CBV2.auth, fireAuth: function (s) { if (authCb) authCb("SIGNED_IN", s); } };
}

async function run() {
  // 1. Fast path is unchanged.
  {
    const { auth } = makeHarness("fast");
    const t0 = Date.now();
    await auth.init();
    assert.ok(Date.now() - t0 < 800, "fast getSession should resolve quickly");
    assert.strictEqual(auth.isAuthenticated(), true, "fast getSession should capture the session");
    assert.strictEqual(auth.isReady(), true, "auth should be ready");
  }

  // 2. THE FIX: a hung getSession must not hang the boot.
  {
    const { auth } = makeHarness("hang");
    const t0 = Date.now();
    await auth.init(); // must resolve on its own via the internal timeout
    const ms = Date.now() - t0;
    assert.ok(ms >= 3000 && ms <= 6000, "hung getSession should resolve at the timeout (~3.5s), got " + ms + "ms");
    assert.strictEqual(auth.isAuthenticated(), false, "a hung handshake should boot signed-out so the landing paints");
    assert.strictEqual(auth.isReady(), true, "auth should be marked ready even on timeout");
  }

  // 3. A session that lands AFTER the timeout still reconciles (listener-first).
  {
    const { auth, fireAuth } = makeHarness("hang");
    await auth.init();
    assert.strictEqual(auth.isAuthenticated(), false, "still unauthed right after the timeout");
    fireAuth({ user: { id: "late" }, access_token: "late-token" });
    assert.strictEqual(auth.isAuthenticated(), true, "a late session must be caught by the auth listener");
    assert.strictEqual(auth.getUser().id, "late", "the reconciled user should be set");
  }

  // 4. A rejecting getSession is handled, not thrown.
  {
    const { auth } = makeHarness("reject");
    let threw = false;
    try { await auth.init(); } catch (e) { threw = true; }
    assert.strictEqual(threw, false, "init() must not throw when getSession rejects");
    assert.strictEqual(auth.isAuthenticated(), false, "a rejected handshake boots signed-out");
    assert.strictEqual(auth.isReady(), true, "auth should still be ready");
  }

  console.log("Auth boot tests passed.");
}

run().catch(function (err) { console.error(err); process.exit(1); });
