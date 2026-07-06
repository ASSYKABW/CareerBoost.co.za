/* eslint-disable no-console */
// Unit coverage for the honest "measurable impact" detector that replaces the
// old `/\d/.test(text)` quantified-bullet check.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadQuality() {
  const window = { CBV2: { resume: {} } };
  const ctx = vm.createContext({ window, console, Date, JSON, String, Math, RegExp, Number, Array, Object });
  const abs = path.resolve(__dirname, "..", "src/js/modules/resume/resume.quality.js");
  vm.runInContext(fs.readFileSync(abs, "utf8"), ctx, { filename: "resume.quality.js" });
  return ctx.window.CBV2.resume.quality;
}

function run() {
  const q = loadQuality();
  assert.ok(q && typeof q.hasImpactMetric === "function", "hasImpactMetric is exported");

  const shouldMatch = [
    "Increased checkout conversion by 32%",
    "Cut cloud spend from $1.2M to $780k",
    "Grew the design system to 45 components",
    "Reduced p95 latency from 900ms to 220ms",
    "Scaled the platform to 10,000 daily active users",
    "Led a team of 12 engineers across 3 markets",
    "Doubled trial-to-paid conversion in two quarters",
    "Shipped 3x faster after introducing CI/CD",
    "Ranked #1 CSAT in a 40-person support org",
    "Improved NPS from 22 to 51",
    "Saved 15 hours per week by automating reporting",
    "Closed 120 enterprise deals worth €4M"
  ];
  const shouldNotMatch = [
    "Owned the product roadmap in 2021",
    "Migrated the codebase to ES6 modules",
    "Provided 24/7 on-call support",
    "Collaborated with cross-functional partners",
    "Responsible for stakeholder communication",
    "Worked on the checkout redesign",
    "5 years of experience in fintech",  // time unit w/o a change cue
    "Available Monday to Friday",
    "Python 3 and Node microservices"
  ];

  const falseNeg = shouldMatch.filter(function (b) { return !q.hasImpactMetric(b); });
  const falsePos = shouldNotMatch.filter(function (b) { return q.hasImpactMetric(b); });

  assert.deepStrictEqual(falseNeg, [], "no measurable bullets should be missed");
  assert.deepStrictEqual(falsePos, [], "no non-measurable bullets should be flagged");

  // The old check would have called all of these "quantified" because they
  // contain a digit — assert we now reject the year/version/date cases.
  assert.strictEqual(q.hasImpactMetric("Owned the product roadmap in 2021"), false, "bare year is not impact");
  assert.strictEqual(q.hasImpactMetric("Provided 24/7 on-call support"), false, "24/7 is not impact");
  assert.strictEqual(q.hasImpactMetric(""), false, "empty is not impact");
  assert.strictEqual(q.hasImpactMetric(null), false, "null is safe");

  console.log("resume-impact-metric.test.js passed");
}

run();
