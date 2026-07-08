/* eslint-disable no-console */
// Proves the job-search "fit" engine is now synonym-aware: a role profile
// targeting "swe" / "react" matches a "Senior Software Engineer" job that
// mentions "ReactJS" — which the old substring (indexOf) matcher missed.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadInto(ctx, relPath) {
  const abs = path.resolve(__dirname, "..", relPath);
  vm.runInContext(fs.readFileSync(abs, "utf8"), ctx, { filename: relPath });
}

function run() {
  const window = {};
  const ctx = vm.createContext({ window, console, Date, JSON, String, Math, RegExp, Set, Map, Array, Object, Number });
  loadInto(ctx, "src/js/app/utils/semantic-match.js"); // provides window.CBV2.semanticMatch
  loadInto(ctx, "src/js/services/jobs/job.intent.js"); // provides window.CBJobs.intent
  const intent = ctx.window.CBJobs.intent;
  assert.ok(intent && typeof intent.evaluateJobIntent === "function", "intent engine loaded");

  const job = {
    title: "Senior Software Engineer",
    company: "Acme",
    location: "Cape Town",
    tags: ["reactjs", "nodejs"],
    descriptionText: "We build with ReactJS and Node. TypeScript a plus.",
  };

  // 1. Synonym title match: profile targets "swe" → should match "Software Engineer".
  const out = intent.evaluateJobIntent(job, {
    targetTitles: ["swe"],
    mustHaveSkills: ["react", "typescript"],
    seniority: "senior",
  });
  assert.strictEqual(out.matchedTitle, "swe", "'swe' matches 'Software Engineer' title via synonyms");
  assert.ok(out.matchedSkills.indexOf("react") >= 0, "'react' matches 'ReactJS' via synonyms");
  assert.ok(out.matchedSkills.indexOf("typescript") >= 0, "'typescript' matches the description");
  assert.ok(out.score >= 80, "strong synonym match yields a high fit score (got " + out.score + ")");
  assert.strictEqual(out.pass, true, "job passes role-intent");

  // 2. A genuinely unrelated role must still NOT match (no false positives).
  const marketingJob = {
    title: "Social Media Marketing Manager",
    company: "Acme",
    location: "Cape Town",
    tags: ["marketing", "content"],
    descriptionText: "Own the brand's social calendar and campaigns.",
  };
  const out2 = intent.evaluateJobIntent(marketingJob, { targetTitles: ["swe"], mustHaveSkills: ["react"] });
  assert.strictEqual(out2.matchedTitle, "", "unrelated title does not match 'swe'");
  assert.strictEqual(out2.matchedSkills.length, 0, "no engineering skills matched in a marketing role");

  // 3. Fallback path (no semanticMatch loaded) still works via substring.
  const window2 = {};
  const ctx2 = vm.createContext({ window: window2, console, Date, JSON, String, Math, RegExp, Set, Map, Array, Object, Number });
  loadInto(ctx2, "src/js/services/jobs/job.intent.js");
  const out3 = ctx2.window.CBJobs.intent.evaluateJobIntent(job, { targetTitles: ["software engineer"] });
  assert.strictEqual(out3.matchedTitle, "software engineer", "substring fallback still matches exact title");

  console.log("job-intent-semantic.test.js passed");
}

run();
