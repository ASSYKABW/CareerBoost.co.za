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
  const window = {
    CBJobs: {},
    CBV2: {
      config: {
        isFeatureEnabled: function () { return true; }
      }
    }
  };
  return vm.createContext({
    window: window,
    console: console,
    Date: Date,
    Map: Map,
    Set: Set,
    JSON: JSON,
    Promise: Promise,
    Number: Number,
    String: String,
    Math: Math,
    URL: URL
  });
}

async function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/services/jobs/job.intent.js");

  const intent = ctx.window.CBJobs.intent;
  const job = {
    title: "Senior React Engineer",
    company: "Acme",
    tags: ["react", "typescript"],
    descriptionText: "Build frontend with React and TypeScript"
  };
  const strictProfile = {
    targetTitles: ["frontend engineer"],
    seniority: "senior",
    mustHaveSkills: ["react", "typescript"],
    excludeKeywords: [],
    strictMode: true
  };
  const broadProfile = Object.assign({}, strictProfile, { strictMode: false });

  assert.strictEqual(intent.evaluateJobIntent(job, strictProfile).pass, false, "strict mode should reject title mismatch");
  assert.strictEqual(intent.evaluateJobIntent(job, broadProfile).pass, true, "broad mode should allow near match via skills");

  ctx.window.CBJobs.normalize = {
    makeKey: function (c, t) { return (c + "|" + t).toLowerCase(); },
    makeUrlKey: function (u) { return String(u || "").toLowerCase(); },
    detectRemote: function (loc) { return /remote/i.test(String(loc || "")); },
    daysSince: function () { return 0; }
  };
  let providerCalls = 0;
  ctx.window.CBJobs.providers = [{
    id: "mock",
    label: "Mock",
    priority: 1,
    isFallback: false,
    search: function () {
      providerCalls += 1;
      return Promise.resolve({
        ok: true,
        jobs: [{
          id: "j1",
          title: "Senior React Engineer",
          company: "Acme",
          url: "https://acme.test/jobs/1",
          location: "Remote",
          tags: ["react", "typescript"],
          postedAt: new Date().toISOString(),
          descriptionText: "React TypeScript"
        }]
      });
    }
  }];

  loadScript(ctx, "src/js/services/jobs/job.search.js");

  const rp1 = {
    targetTitles: ["Frontend Engineer", "React Developer"],
    seniority: "senior",
    mustHaveSkills: ["TypeScript", "React"],
    excludeKeywords: ["intern"],
    strictMode: true
  };
  const rp2 = {
    targetTitles: ["react developer", "frontend engineer"],
    seniority: "senior",
    mustHaveSkills: ["react", "typescript"],
    excludeKeywords: ["intern"],
    strictMode: true
  };

  await ctx.window.CBJobs.search({ query: "react", roleProfile: rp1, sort: "newest" });
  await ctx.window.CBJobs.search({ query: "react", roleProfile: rp2, sort: "newest" });
  assert.strictEqual(providerCalls, 1, "equivalent role profiles should share cache key");

  ctx.window.CBJobs.clearCache();
  ctx.window.CBJobs.providers = [{
    id: "external-search",
    label: "LinkedIn",
    priority: 1,
    sourceType: "api",
    search: function () {
      return Promise.resolve({
        ok: true,
        jobs: [{
          id: "source_truth_1",
          title: "Fire Engineer",
          company: "RPO Recruitment",
          source: "LinkedIn",
          sourceId: "rapidapi-linkedin",
          sourceType: "api",
          url: "https://www.rpo-recruitment.com/jobs/fire-engineer",
          location: "Cape Town, South Africa",
          descriptionText: "Fire engineering role with consulting project delivery."
        }]
      });
    }
  }];
  const sourceTruth = await ctx.window.CBJobs.search({
    query: "fire engineer",
    roleProfile: {},
    sort: "newest"
  });
  assert.strictEqual(sourceTruth.jobs.length, 1, "source-truth provider should return one job");
  assert.strictEqual(sourceTruth.jobs[0].source, "RPO Recruitment", "URL host should override misleading LinkedIn labels");
  assert.strictEqual(sourceTruth.jobs[0].sourceId, "rpo-recruitment", "sourceId should follow the verified source");
  assert.ok(
    sourceTruth.jobs[0].sourceTrust && /Provider reported LinkedIn/.test(sourceTruth.jobs[0].sourceTrust.warning || ""),
    "source trust should explain corrected provider labels"
  );

  ctx.window.CBJobs.clearCache();
  ctx.window.CBJobs.providers = [{
    id: "adzuna",
    label: "Adzuna",
    priority: 1,
    sourceType: "api",
    search: function () {
      return Promise.resolve({
        ok: true,
        jobs: [{
          id: "adzuna_uk_1",
          title: "Senior Software Engineering Manager",
          company: "Capital One",
          source: "Adzuna",
          sourceId: "adzuna",
          sourceType: "api",
          url: "https://www.adzuna.co.uk/jobs/land/ad/5716108708",
          location: "London, UK",
          descriptionText: "What you'll do\n• Lead engineering teams\n\nWhat we're looking for\n• Engineering leadership"
        }]
      });
    }
  }];
  const adzunaUk = await ctx.window.CBJobs.search({
    query: "software engineering manager",
    roleProfile: {},
    sort: "newest"
  });
  assert.strictEqual(adzunaUk.jobs.length, 1, "Adzuna UK result should be retained");
  assert.strictEqual(adzunaUk.jobs[0].source, "Adzuna", "adzuna.co.uk should not be displayed as UK");
  assert.ok(!adzunaUk.jobs[0].sourceTrust.warning, "Adzuna UK should not produce a fake source mismatch warning");

  console.log("Phase 6 contract tests passed.");
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
