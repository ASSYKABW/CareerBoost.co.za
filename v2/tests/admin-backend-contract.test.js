/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function run() {
  const auth = read("backend/supabase/functions/_shared/auth.ts");
  const fn = read("backend/supabase/functions/admin-overview/index.ts");
  const usageMigration = read("backend/supabase/migrations/0007_usage_events.sql");
  const sessionMigration = read("backend/supabase/migrations/0008_usage_sessions.sql");
  const hardeningMigration = read("backend/supabase/migrations/0009_admin_production_hardening.sql");
  const config = read("backend/supabase/config.toml");
  const pkg = read("backend/package.json");

  assert.ok(/export async function getAuthedAdmin/.test(auth), "shared auth should expose getAuthedAdmin");
  assert.ok(/app_metadata/.test(auth), "admin guard should read protected app metadata");
  assert.ok(!/user_metadata[\s\S]{0,120}Admin/.test(auth), "admin guard should not rely on user metadata");
  assert.ok(/getAuthedAdmin\(req\)/.test(fn), "admin-overview must verify admin access");
  assert.ok(/svc\.auth\.admin\.listUsers/.test(fn), "admin-overview should read Supabase Auth users via service role");
  assert.ok(/from\("applications"\)/.test(fn), "admin-overview should aggregate pipeline records");
  assert.ok(/from\("ai_usage"\)/.test(fn), "admin-overview should aggregate AI telemetry");
  assert.ok(/from\("usage_events"\)/.test(fn), "admin-overview should aggregate usage events");
  assert.ok(/from\("usage_sessions"\)/.test(fn), "admin-overview should aggregate usage sessions");
  assert.ok(/create table if not exists public\.usage_events/.test(usageMigration), "usage_events migration should create the event table");
  assert.ok(/enable row level security/.test(usageMigration), "usage_events migration should enable RLS");
  assert.ok(/owner_insert/.test(usageMigration), "usage_events migration should allow owner inserts");
  assert.ok(/create table if not exists public\.usage_sessions/.test(sessionMigration), "usage_sessions migration should create the session table");
  assert.ok(/duration_seconds/.test(sessionMigration), "usage_sessions migration should store session duration");
  assert.ok(/device_type/.test(sessionMigration), "usage_sessions migration should store device class");
  assert.ok(/preview_mode/.test(sessionMigration), "usage_sessions migration should store preview mode");
  assert.ok(/owner_update/.test(sessionMigration), "usage_sessions migration should allow owner session updates");
  assert.ok(/usage_events_metadata_privacy_guard/.test(hardeningMigration), "hardening migration should guard usage event metadata");
  assert.ok(/usage_sessions_metadata_privacy_guard/.test(hardeningMigration), "hardening migration should guard usage session metadata");
  assert.ok(/force row level security/.test(hardeningMigration), "hardening migration should force RLS on telemetry tables");
  assert.ok(/revoke all on public\.usage_events from anon/.test(hardeningMigration), "hardening migration should block anonymous usage_events access");
  assert.ok(/revoke all on public\.usage_sessions from anon/.test(hardeningMigration), "hardening migration should block anonymous usage_sessions access");
  assert.ok(/usage_sessions_modules_gin_idx/.test(hardeningMigration), "hardening migration should index usage session modules");
  assert.ok(/usage_sessions_routes_gin_idx/.test(hardeningMigration), "hardening migration should index usage session routes");
  assert.ok(/saved_jobs_source_saved_idx/.test(hardeningMigration), "hardening migration should index saved job source freshness");
  assert.ok(/applications_stage_updated_idx/.test(hardeningMigration), "hardening migration should index application stage freshness");
  assert.ok(/ai_usage_status_created_idx/.test(hardeningMigration), "hardening migration should index AI operational status");
  assert.ok(/alerts/.test(fn), "admin-overview should return operator alerts");
  assert.ok(/sourceIssues/.test(fn), "admin-overview should expose source truth diagnostics");
  assert.ok(/recentFailures/.test(fn), "admin-overview should expose recent AI failures");
  assert.ok(/pipelineCount/.test(fn), "admin-overview should enrich user rows with work counts");
  assert.ok(/product:\s*\{/.test(fn), "admin-overview should expose product intelligence");
  assert.ok(/activationScore/.test(fn), "admin-overview should calculate activation score");
  assert.ok(/activationFunnel/.test(fn), "admin-overview should calculate the strict activation funnel");
  assert.ok(/first-tailored-asset/.test(fn), "admin-overview should include the first tailored asset step");
  assert.ok(/largestDropOff/.test(fn), "admin-overview should expose the largest activation drop-off");
  assert.ok(/MODULE_CATALOG/.test(fn), "admin-overview should define the tracked product modules");
  assert.ok(/moduleEngagement/.test(fn), "admin-overview should expose per-module engagement metrics");
  assert.ok(/avgEventsPerSession/.test(fn), "admin-overview should expose per-module depth");
  assert.ok(/retention:\s*\{/.test(fn), "admin-overview should expose retention metrics");
  assert.ok(/cohortRetention/.test(fn), "admin-overview should expose true signup-week retention cohorts");
  assert.ok(/cohortSummary/.test(fn), "admin-overview should summarize cohort retention");
  assert.ok(/week1Retention/.test(fn), "admin-overview should calculate week 1 retention");
  assert.ok(/activeSessions/.test(fn), "admin-overview should expose usage session counts");
  assert.ok(/avgSessionSeconds/.test(fn), "admin-overview should expose average session length");
  assert.ok(/sessionsByDevice/.test(fn), "admin-overview should expose session device mix");
  assert.ok(/topRoutes/.test(fn), "admin-overview should expose route views");
  assert.ok(/byProvider/.test(fn), "admin-overview should expose provider-level AI metrics");
  assert.ok(/quality:\s*\{/.test(fn), "admin-overview should expose job feed quality metrics");
  assert.ok(/const reports = \{/.test(fn), "admin-overview should expose operator reports");
  assert.ok(/healthScore/.test(fn), "admin-overview should calculate reporting health score");
  assert.ok(/actionQueue/.test(fn), "admin-overview should expose operator action queue");
  assert.ok(/executiveSummary/.test(fn), "admin-overview should expose executive report summary");
  assert.ok(/governance:\s*\{/.test(fn), "admin-overview should expose governance metadata");
  assert.ok(/controlCenter/.test(fn), "admin-overview should expose operations control center");
  assert.ok(/serviceLevels/.test(fn), "admin-overview should expose service-level checks");
  assert.ok(/incidents/.test(fn), "admin-overview should expose incident queue");
  assert.ok(/runbooks/.test(fn), "admin-overview should expose operator runbooks");
  assert.ok(/releaseReadiness/.test(fn), "admin-overview should expose release readiness checks");
  assert.ok(/ADMIN_PRIVACY_CONTROLS/.test(fn), "admin-overview should expose admin privacy controls");
  assert.ok(/dataFreshness/.test(fn), "admin-overview should expose stale-data diagnostics");
  assert.ok(/staleDataSignals/.test(fn), "admin-overview should expose stale-data signal counts");
  assert.ok(/exportManifest/.test(fn), "admin-overview should expose export manifest metadata");
  assert.ok(/Privacy controls are active/.test(fn), "release readiness should include privacy controls");
  assert.ok(/Telemetry is fresh/.test(fn), "release readiness should include telemetry freshness");
  assert.ok(/cohortRetention/.test(fn), "admin-overview should export cohort retention reports");
  assert.ok(/dataFreshness: freshnessSignals/.test(fn), "admin-overview should export freshness reports");
  assert.ok(/const support = \{/.test(fn), "admin-overview should expose user support health");
  assert.ok(/supportAccounts/.test(fn), "admin-overview should calculate account support rows");
  assert.ok(/supportQueues/.test(fn), "admin-overview should expose support queue counts");
  assert.ok(/accountHealth/.test(fn), "admin-overview should export account health reports");
  assert.ok(/\[functions\.admin-overview\]/.test(config), "Supabase config should register admin-overview");
  assert.ok(/fn:deploy:admin/.test(pkg), "backend package should expose admin deploy script");

  // Phase E1: Command Center contract.
  const outcomesMigration = read("backend/supabase/migrations/0012_interview_outcomes.sql");
  assert.ok(/create table if not exists public\.interview_outcomes/.test(outcomesMigration), "outcomes migration should create interview_outcomes table");
  assert.ok(/outcome_type in \('interview', 'offer'/.test(outcomesMigration), "outcomes migration should constrain outcome_type values");
  assert.ok(/octet_length\(notes\) <= 4096/.test(outcomesMigration), "outcomes migration should cap notes at 4KB");
  assert.ok(/alter table public\.interview_outcomes enable row level security/.test(outcomesMigration), "outcomes migration should enable RLS");
  assert.ok(/force row level security/.test(outcomesMigration), "outcomes migration should force RLS");
  assert.ok(/interview_outcomes_owner_select/.test(outcomesMigration), "outcomes migration should expose owner select policy");
  assert.ok(/interview_outcomes_owner_insert/.test(outcomesMigration), "outcomes migration should allow owner inserts");
  assert.ok(/create or replace view public\.v_admin_outcome_rollup/.test(outcomesMigration), "outcomes migration should expose the admin rollup view");
  assert.ok(/create or replace view public\.v_admin_outcome_by_channel/.test(outcomesMigration), "outcomes migration should expose the by-channel view");
  assert.ok(/revoke all on public\.interview_outcomes from anon/.test(outcomesMigration), "outcomes migration should revoke anon access");

  assert.ok(/from\("v_admin_outcome_rollup"\)/.test(fn), "admin-overview should read the outcome rollup view");
  assert.ok(/from\("v_admin_outcome_by_channel"\)/.test(fn), "admin-overview should read the outcome channel view");
  assert.ok(/const northStar = \{/.test(fn), "admin-overview should compute the northStar block");
  assert.ok(/const aarrr = \[/.test(fn), "admin-overview should compute the AARRR pirate-metrics block");
  assert.ok(/stage: "acquisition"[\s\S]*stage: "activation"[\s\S]*stage: "retention"[\s\S]*stage: "revenue"[\s\S]*stage: "referral"/.test(fn), "AARRR block must include all five stages");
  assert.ok(/const priorities = priorityCandidates/.test(fn), "admin-overview should compute today's priorities");
  assert.ok(/const weeklyChanges = \[/.test(fn), "admin-overview should compute weekly changes");
  assert.ok(/const outcomesBlock = \{/.test(fn), "admin-overview should compute outcomes block");
  assert.ok(/northStar,\s*aarrr,\s*priorities,\s*weeklyChanges,\s*outcomes: outcomesBlock/.test(fn), "admin-overview response should expose Command Center blocks at top level");

  // Phase E2: Growth & Acquisition contract.
  const acquisitionMigration = read("backend/supabase/migrations/0013_acquisition_attribution.sql");
  assert.ok(/add column if not exists utm_source/.test(acquisitionMigration), "acquisition migration should add utm_source column");
  assert.ok(/add column if not exists utm_medium/.test(acquisitionMigration), "acquisition migration should add utm_medium column");
  assert.ok(/add column if not exists utm_campaign/.test(acquisitionMigration), "acquisition migration should add utm_campaign column");
  assert.ok(/add column if not exists referrer_host/.test(acquisitionMigration), "acquisition migration should add referrer_host column");
  assert.ok(/add column if not exists country_code/.test(acquisitionMigration), "acquisition migration should add country_code column");
  assert.ok(/add column if not exists signup_at/.test(acquisitionMigration), "acquisition migration should add signup_at column");
  assert.ok(/profiles_utm_source_size_chk/.test(acquisitionMigration), "acquisition migration should cap utm_source size");
  assert.ok(/profiles_landing_path_size_chk/.test(acquisitionMigration), "acquisition migration should cap landing_path size");
  assert.ok(/create or replace view public\.v_admin_acquisition_channels/.test(acquisitionMigration), "acquisition migration should expose channels view");
  assert.ok(/create or replace view public\.v_admin_acquisition_geo/.test(acquisitionMigration), "acquisition migration should expose geo view");
  assert.ok(/create or replace view public\.v_admin_acquisition_landing/.test(acquisitionMigration), "acquisition migration should expose landing view");
  assert.ok(/create or replace view public\.v_admin_acquisition_referrers/.test(acquisitionMigration), "acquisition migration should expose referrers view");
  assert.ok(/quality_score/.test(acquisitionMigration), "acquisition channels view should expose quality_score");

  const signupAttributionFn = read("backend/supabase/functions/signup-attribution/index.ts");
  assert.ok(/getAuthedUser\(req\)/.test(signupAttributionFn), "signup-attribution should verify auth");
  assert.ok(/cf-ipcountry/.test(signupAttributionFn), "signup-attribution should read cf-ipcountry header");
  assert.ok(/signup_at/.test(signupAttributionFn), "signup-attribution should write signup_at");
  assert.ok(/firstTouch/.test(signupAttributionFn), "signup-attribution should implement first-touch attribution");
  assert.ok(/\.upsert\(/.test(signupAttributionFn), "signup-attribution should upsert profile");

  assert.ok(/from\("v_admin_acquisition_channels"\)/.test(fn), "admin-overview should read the acquisition channels view");
  assert.ok(/from\("v_admin_acquisition_geo"\)/.test(fn), "admin-overview should read the acquisition geo view");
  assert.ok(/from\("v_admin_acquisition_landing"\)/.test(fn), "admin-overview should read the acquisition landing view");
  assert.ok(/from\("v_admin_acquisition_referrers"\)/.test(fn), "admin-overview should read the acquisition referrers view");
  assert.ok(/const growthBlock = \{/.test(fn), "admin-overview should compute the growth block");
  assert.ok(/growthRecommendations/.test(fn), "admin-overview should compute growth recommendations");
  assert.ok(/growth: growthBlock/.test(fn), "admin-overview response should expose the growth block");

  assert.ok(/\[functions\.signup-attribution\]/.test(config), "Supabase config should register signup-attribution");
  assert.ok(/fn:deploy:signup-attribution/.test(pkg), "backend package should expose signup-attribution deploy script");

  console.log("Admin backend contract tests passed.");
}

run();
