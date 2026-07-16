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
  const posted = [];
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
    // Anonymous visitors reach usage-ingest through config, not the DB client.
    CBV2: {
      config: {
        isBackendEnabled: function () { return true; },
        getFunctionsUrl: function () { return "https://fn.test/functions/v1"; },
        getSupabaseAnon: function () { return "anon-key"; }
      }
    },
    location: { hash: "#/resume", hostname: "careerboost.co.za", search: "?utm_source=linkedin&utm_medium=social&utm_campaign=launch" },
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
    URLSearchParams: URLSearchParams,
    JSON: JSON,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    // A real arrival: referred by LinkedIn, carrying UTM tags.
    document: { referrer: "https://www.linkedin.com/feed/update/urn:li:activity:123?trk=public" },
    fetch: function (url, opts) {
      posted.push({ url: url, headers: (opts && opts.headers) || {}, keepalive: !!(opts && opts.keepalive), body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true });
    }
  });

  loadScript(ctx, "src/js/app/usage-tracker.js");
  assert.strictEqual(typeof window.CBV2.usage.track, "function", "usage tracker should register");

  window.CBV2.usage.track("resume_uploaded", {
    resumeText: "do not store this",
    characterCount: 4200,
    nested: { step: "upload", apiKey: "nope" }
  }, { module: "resume", route: "resume" });

  assert.strictEqual(window.CBV2.usage.pendingCount(), 2, "session start and event should queue before flush");

  // ── Logged-out visitor: events go to usage-ingest, never through the DB
  // client (they have no session to write with). This is the half of the
  // funnel that did not exist before 0053 made usage_events.user_id nullable.
  await window.CBV2.usage.flush();
  assert.strictEqual(inserted.length, 0, "unauthenticated flush should not write to the DB");
  assert.strictEqual(sessions.length, 0, "unauthenticated sessions should not write");
  assert.strictEqual(posted.length, 1, "unauthenticated flush should post to usage-ingest");

  const anon = posted[0];
  assert.ok(anon.url.endsWith("/usage-ingest"), "anonymous events should go to the ingest function");
  assert.ok(anon.keepalive, "ingest should survive the unload after the last page view");
  assert.ok(anon.body.anonymous_id, "ingest should carry the anonymous id");
  assert.strictEqual(anon.body.events.length, 2, "both queued events should be sent");
  assert.strictEqual(anon.body.events[0].event_name, "session_start", "first event should mark session start");
  assert.ok(!anon.body.events.some(function (e) { return e.user_id; }), "anonymous payload must never claim a user id");

  // Acquisition, captured once at session start.
  const startMeta = anon.body.events[0].metadata;
  assert.strictEqual(startMeta.referrer, "linkedin.com", "referrer should reduce to a bare hostname");
  assert.strictEqual(startMeta.utmSource, "linkedin", "utm_source should be captured");
  assert.strictEqual(startMeta.utmMedium, "social", "utm_medium should be captured");
  assert.strictEqual(startMeta.utmCampaign, "launch", "utm_campaign should be captured");

  // Redaction has to hold on the anonymous path too — it is now the path most
  // events actually take.
  const upload = anon.body.events[1];
  assert.strictEqual(upload.event_name, "resume_uploaded", "event name should be normalized");
  assert.strictEqual(upload.module, "resume", "event module should be recorded");
  assert.strictEqual(upload.metadata.characterCount, 4200, "safe metadata should be preserved");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(upload.metadata, "resumeText"), false, "document body text should be removed");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(upload.metadata.nested, "apiKey"), false, "secret-like nested fields should be removed");

  // ── Signed in: events go to usage_events carrying the user id.
  window.CBV2.auth = {
    isAuthenticated: function () { return true; },
    getClient: function () { return client; },
    getUser: function () { return { id: "user-123" }; }
  };

  window.CBV2.usage.track("resume_uploaded", { characterCount: 99 }, { module: "resume", route: "resume" });
  await window.CBV2.usage.flush();
  await window.CBV2.usage.flushSession();
  assert.strictEqual(posted.length, 1, "signed-in events should not go through the anonymous ingest");
  assert.strictEqual(inserted.length, 1, "authenticated flush should insert a batch");
  assert.strictEqual(inserted[0][0].user_id, "user-123", "event should use signed-in user id");
  assert.strictEqual(inserted[0][0].event_name, "resume_uploaded", "event name should be normalized");
  assert.strictEqual(inserted[0][0].module, "resume", "event module should be recorded");
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
