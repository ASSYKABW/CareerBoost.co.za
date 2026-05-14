/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function assertHasAll(source, values, message) {
  values.forEach((value) => {
    assert.ok(source.includes(value), `${message}: ${value}`);
  });
}

function run() {
  const fn = read("backend/supabase/functions/admin-overview/index.ts");
  const migration = read("backend/supabase/migrations/0009_admin_production_hardening.sql");
  // Phase D: admin.route.js was split into helpers + per-section files. The
  // export buttons + privacy/freshness HTML now live in sections/reports.js
  // and sections/settings.js. Read the combined module source for assertions.
  const adminRoute = [
    "v2/src/js/modules/admin/admin.route.js",
    "v2/src/js/modules/admin/admin-helpers.js",
    "v2/src/js/modules/admin/sections/reports.js",
    "v2/src/js/modules/admin/sections/settings.js",
    "v2/src/js/modules/admin/sections/logs.js"
  ].map(read).join("\n");

  const blockedKeys = [
    "apiKey",
    "accessToken",
    "refreshToken",
    "password",
    "secret",
    "resume",
    "coverLetter",
    "jobDescription",
    "rawText",
    "html"
  ];

  assertHasAll(fn, blockedKeys, "admin backend privacy controls should block sensitive metadata keys");
  assertHasAll(migration, blockedKeys, "migration privacy constraints should block sensitive metadata keys");
  assert.ok(/octet_length\(metadata::text\) <= 4096/.test(migration), "telemetry metadata should have a payload size guard");
  assert.ok((migration.match(/force row level security/g) || []).length >= 2, "usage telemetry tables should force RLS");
  assert.ok(/revoke all on public\.usage_events from anon/.test(migration), "anonymous usage event reads should be revoked");
  assert.ok(/revoke all on public\.usage_sessions from anon/.test(migration), "anonymous usage session reads should be revoked");

  assertHasAll(migration, [
    "usage_events_category_module_occurred_idx",
    "usage_events_user_session_idx",
    "usage_sessions_last_activity_idx",
    "usage_sessions_user_started_idx",
    "usage_sessions_modules_gin_idx",
    "usage_sessions_routes_gin_idx",
    "saved_jobs_source_saved_idx",
    "saved_searches_user_last_run_idx",
    "applications_stage_updated_idx",
    "ai_usage_status_created_idx",
    "profiles_onboarding_updated_idx"
  ], "hardening migration should add production query indexes");

  assert.ok(/const dataFreshness = \{/.test(fn), "admin backend should aggregate freshness diagnostics");
  assert.ok(/freshnessSignals\.slice\(0, 4\)/.test(fn), "freshness diagnostics should surface operator alerts");
  assert.ok(/staleDataSignals: freshnessSignals\.length/.test(fn), "response should include stale-data signal count");
  assert.ok(/const csvReports = \{[\s\S]*cohortRetention:[\s\S]*dataFreshness:[\s\S]*accountHealth:/m.test(fn), "CSV reports should include cohorts, freshness, and account health");
  assert.ok(/const exportManifest = Object\.keys\(csvReports\)/.test(fn), "backend should describe export packages");
  assert.ok(/privacyControls: ADMIN_PRIVACY_CONTROLS/.test(fn), "backend diagnostics should expose privacy controls");
  assert.ok(/Candidate resume bodies, cover-letter text, job descriptions/.test(fn), "admin audit should state excluded candidate content");
  assert.ok(/Privacy controls are active/.test(fn), "release checks should include privacy controls");
  assert.ok(/Telemetry is fresh/.test(fn), "release checks should include stale-data warnings");

  assert.ok(/data-admin-export="cohortRetention"/.test(adminRoute), "admin UI should expose cohort CSV export");
  assert.ok(/data-admin-export="dataFreshness"/.test(adminRoute), "admin UI should expose freshness CSV export");
  assert.ok(/Privacy controls/.test(adminRoute), "admin UI should show privacy guardrails");
  assert.ok(/Stale signals/.test(adminRoute), "admin UI should show stale-data warnings");

  console.log("Admin production hardening tests passed.");
}

run();
