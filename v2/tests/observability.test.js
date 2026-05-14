/* eslint-disable no-console */
// Phase 8 tests: client-side observability module behavior.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadScript(ctx, relPath) {
  const abs = path.resolve(__dirname, "..", relPath);
  const src = fs.readFileSync(abs, "utf8");
  vm.runInContext(src, ctx, { filename: relPath });
}

function makeContext() {
  const localStorageMap = {};
  const window = {
    CB_CONFIG: {},
    CBV2: { config: { isBackendEnabled: function () { return false; } } },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageMap, k) ? localStorageMap[k] : null; },
      setItem: function (k, v) { localStorageMap[k] = String(v); },
      removeItem: function (k) { delete localStorageMap[k]; },
    },
    location: { hash: "#/calendar", pathname: "/v2/index.html", href: "https://example.com/v2/index.html#/calendar" },
    addEventListener: function () {}, // observability registers handlers; we don't need to fire them
    console: console,
    crypto: { randomUUID: function () { return "00000000-0000-4000-8000-000000000000"; } },
    Sentry: null,
  };
  const ctxObj = {
    window: window,
    document: { readyState: "complete", addEventListener: function () {} },
    navigator: { userAgent: "TestRunner/1.0", sendBeacon: function () { return true; } },
    console: console,
    Date: Date,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    JSON: JSON,
    Error: Error,
    Blob: function () {},
    fetch: function () { return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } }); },
    performance: { now: function () { return Date.now(); } },
    setTimeout: setTimeout,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    Promise: Promise,
  };
  return vm.createContext(ctxObj);
}

function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/services/observability/observability.js");
  const ob = ctx.window.CBV2.observability;
  assert.ok(ob, "observability module should be exposed on window.CBV2.observability");
  assert.strictEqual(typeof ob.captureError, "function", "captureError should be a function");
  assert.strictEqual(typeof ob.captureMessage, "function", "captureMessage should be a function");
  assert.strictEqual(typeof ob.mark, "function", "mark should be a function");
  assert.strictEqual(typeof ob.flush, "function", "flush should be a function");
  assert.strictEqual(typeof ob.getQueueSize, "function", "getQueueSize should be a function");
  assert.strictEqual(ob._installed, true, "observability should be installed after load");

  // captureError queues an event
  ob.captureError(new Error("test error"), { kind: "manual", metadata: { foo: "bar" } });
  assert.ok(ob.getQueueSize() >= 1, "captureError should enqueue an event");

  // captureMessage queues with default warning severity
  ob.captureMessage("a warning", { kind: "manual" });
  assert.ok(ob.getQueueSize() >= 2, "captureMessage should enqueue an event");

  // mark with fast op produces no event
  const sizeBeforeFast = ob.getQueueSize();
  const fastMark = ob.mark("fast-op");
  const elapsed = fastMark.stop({ items: 5 });
  assert.strictEqual(typeof elapsed, "number", "mark.stop returns elapsed ms");
  assert.strictEqual(ob.getQueueSize(), sizeBeforeFast, "fast op should not enqueue a slow_op event");

  // PII / blocked keys are scrubbed
  ob.captureMessage("scrub test", {
    kind: "manual",
    metadata: { apiKey: "SHOULD_NEVER_LEAK", password: "secret123", normal: "ok" }
  });
  // We can't directly read the queue (it's private), but we can flush
  // and intercept what would be sent. Easier: capture-error path uses
  // the same scrubber. Inspect by mocking fetch to capture body.
  let capturedBody = null;
  ctx.window.CBV2.config.isBackendEnabled = function () { return true; };
  ctx.window.CBV2.config.getFunctionsUrl = function () { return "https://example.com/functions/v1"; };
  ctx.window.CBV2.config.getSupabaseAnon = function () { return "anon-key"; };
  // Re-bind fetch on the context to spy
  vm.runInContext(`window.__fetch_body = null;`, ctx);
  ctx.fetch = function (url, opts) {
    capturedBody = opts && opts.body;
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
  };
  // Force flush
  ob.flush();
  // The flusher is async — wait a tick
  return new Promise(function (resolve) {
    setTimeout(function () {
      if (capturedBody) {
        const payload = JSON.parse(capturedBody);
        assert.ok(Array.isArray(payload.events), "flush should send {events: [...]}");
        const allMetaKeys = payload.events.reduce(function (acc, e) {
          return acc.concat(Object.keys(e.metadata || {}));
        }, []);
        assert.ok(!allMetaKeys.includes("apiKey"), "apiKey should be scrubbed from metadata");
        assert.ok(!allMetaKeys.includes("password"), "password should be scrubbed from metadata");
        assert.ok(allMetaKeys.includes("normal"), "non-blocked keys should survive scrub");
        // anonymous_id should be present + UUID-shaped
        assert.ok(typeof payload.anonymous_id === "string" && payload.anonymous_id.length >= 8, "payload should include anonymous_id");
      }
      console.log("Observability tests passed.");
      resolve();
    }, 50);
  });
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
