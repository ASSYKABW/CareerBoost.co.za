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

function makeContext() {
  const window = { CBV2: {} };
  return vm.createContext({
    window,
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    RegExp,
    isFinite
  });
}

function run() {
  const ctx = makeContext();
  [
    "src/js/modules/resume/resume.quality.js",
    "src/js/modules/job-search/job-search.shared.js",
    "src/js/modules/analytics/analytics.shared.js",
    "src/js/modules/settings/settings.meta.js"
  ].forEach(function (file) { loadScript(ctx, file); });

  const quality = ctx.window.CBV2.resume.quality;
  assert.strictEqual(quality.clampScore(126), 100);
  assert.strictEqual(quality.scoreTone(88), "green");
  assert.strictEqual(quality.readinessLabel(58), "Needs stronger evidence");

  const search = ctx.window.CBV2.jobSearchShared;
  assert.strictEqual(search.normalizeSortValue("match"), "newest");
  assert.strictEqual(search.sortLabel("role-fit"), "Role fit first");
  const fitChip = search.fitChipLabel(73);
  assert.strictEqual(fitChip.cls, "green");
  assert.strictEqual(fitChip.text, "Strong fit");
  assert.strictEqual(search.displaySourceLabel("LinkedIn (RapidAPI)"), "LinkedIn");

  const analytics = ctx.window.CBV2.analyticsShared;
  assert.strictEqual(analytics.STAGE_ORDER.slice(0, 3).join(","), "saved,applied,interview");
  assert.strictEqual(analytics.stageLabel("offer"), "Offer");
  assert.strictEqual(analytics.pct(72.4), "72%");

  const settings = ctx.window.CBV2.settingsMeta;
  assert.strictEqual(settings.normalizeTab("profile"), "me");
  assert.strictEqual(settings.normalizeTab("unknown"), "overview");
  assert.strictEqual(settings.visibleTabs(false).some(function (tab) { return tab.id === "advanced"; }), false);
  assert.strictEqual(settings.canAccessAdvanced({ app_metadata: { roles: ["Developer"] } }), true);
  assert.ok(settings.summary("data-privacy").includes("cloud sync"));

  console.log("Phase 5 route split tests passed.");
}

run();
