/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadScript(ctx, relPath) {
  const abs = path.resolve(__dirname, "..", relPath);
  const src = fs.readFileSync(abs, "utf8");
  vm.runInContext(src, ctx, { filename: relPath });
}

function makeStorage() {
  const data = {};
  return {
    getItem: function (key) { return data[key] || null; },
    setItem: function (key, value) { data[key] = String(value); },
    removeItem: function (key) { delete data[key]; }
  };
}

async function run() {
  const inserted = [];
  const sessions = [];
  const client = {
    from: function (table) {
      assert.ok(["usage_events", "usage_sessions"].includes(table), "usage tracker should write only analytics tables");
      return {
        insert: function (rows) {
          assert.strictEqual(table, "usage_events", "event batches should write to usage_events");
          inserted.push(rows);
          return Promise.resolve({ data: rows, error: null });
        },
        upsert: function (row, options) {
          assert.strictEqual(table, "usage_sessions", "session rollups should write to usage_sessions");
          assert.strictEqual(options && options.onConflict, "session_id", "sessions should upsert by session_id");
          sessions.push(row);
          return Promise.resolve({ data: row, error: null });
        }
      };
    }
  };

  const window = {
    CBV2: {},
    location: { hash: "#/resume" },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    addEventListener: function () {},
    crypto: null,
    navigator: {
      userAgent: "Mozilla/5.0 Chrome/120.0",
      language: "en-ZA"
    },
    innerWidth: 1440,
    innerHeight: 900
  };

  const ctx = vm.createContext({
    window: window,
    console: console,
    Date: Date,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    URL: URL,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  });

  loadScript(ctx, "src/js/app/usage-tracker.js");
  assert.strictEqual(typeof window.CBV2.usage.track, "function", "usage tracker should register");

  window.CBV2.usage.track("resume_uploaded", {
    resumeText: "do not store this",
    characterCount: 4200,
    nested: { step: "upload", apiKey: "nope" }
  }, { module: "resume", route: "resume" });

  assert.strictEqual(window.CBV2.usage.pendingCount(), 2, "session start and event should queue before auth");
  await window.CBV2.usage.flush();
  assert.strictEqual(inserted.length, 0, "unauthenticated flush should not write");
  assert.strictEqual(sessions.length, 0, "unauthenticated sessions should not write");

  window.CBV2.auth = {
    isAuthenticated: function () { return true; },
    getClient: function () { return client; },
    getUser: function () { return { id: "user-123" }; }
  };

  await window.CBV2.usage.flush();
  await window.CBV2.usage.flushSession();
  assert.strictEqual(inserted.length, 1, "authenticated flush should insert a batch");
  assert.strictEqual(inserted[0][0].user_id, "user-123", "event should use signed-in user id");
  assert.strictEqual(inserted[0][0].event_name, "session_start", "first event should mark session start");
  assert.strictEqual(inserted[0][1].event_name, "resume_uploaded", "event name should be normalized");
  assert.strictEqual(inserted[0][1].module, "resume", "event module should be recorded");
  assert.strictEqual(inserted[0][1].metadata.characterCount, 4200, "safe metadata should be preserved");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(inserted[0][1].metadata, "resumeText"), false, "document body text should be removed");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(inserted[0][1].metadata.nested, "apiKey"), false, "secret-like nested fields should be removed");
  assert.ok(sessions.length >= 1, "session rollup should be upserted");
  assert.strictEqual(sessions[sessions.length - 1].user_id, "user-123", "session should use signed-in user id");
  assert.strictEqual(sessions[sessions.length - 1].browser, "Chrome", "session should capture browser family");
  assert.strictEqual(sessions[sessions.length - 1].device_type, "desktop", "session should capture device type");
  assert.ok(sessions[sessions.length - 1].event_count >= 2, "session should count activity events");

  window.CBV2.usage.trackRoute("job-search", { source: "nav", token: "secret" });
  await window.CBV2.usage.flush();
  await window.CBV2.usage.flushSession();
  assert.strictEqual(inserted.length, 2, "route views should write as usage events");
  assert.strictEqual(inserted[1][0].event_name, "view_route", "route tracking should use view_route");
  assert.strictEqual(inserted[1][0].route, "job-search", "route name should be recorded");
  assert.deepStrictEqual(inserted[1][0].metadata.paramKeys, ["source", "token"], "route params should store keys only");
  assert.ok(sessions[sessions.length - 1].route_count >= 1, "session should count route views");
  assert.ok(sessions[sessions.length - 1].routes.includes("job-search"), "session should store viewed route names");

  console.log("Usage tracker tests passed.");
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
