/* eslint-disable no-console */
// Regression coverage for Resume Lab JD matching.
//
// Guards the bug where buildResumeCorpus did `(r.skills || []).forEach(...)`
// against the real structured shape `skills: { groups: [{ items: [] }] }`.
// That threw, which (a) dropped every skill from JD keyword matching and
// (b) crashed getResumeHealth — and therefore the whole Resume Lab render —
// the moment a job description was analyzed.
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
  const window = {};
  const ctx = vm.createContext({ window, console, Date, JSON, String, Math, RegExp, Set, Map, Array, Object });
  return ctx;
}

// A resume in the real structured shape produced by resume.model.js.
function structuredResume() {
  return {
    summary: "Product designer who ships accessible interfaces.",
    skills: {
      groups: [
        { label: "Core skills", items: ["Figma", "TypeScript", "Design Systems"] },
        { label: "Tools", items: ["Storybook", "Jira"] }
      ]
    },
    experience: [
      {
        role: "Product Designer",
        company: "Acme",
        bullets: [
          { text: "Led a redesign that lifted activation." },
          { text: "Built a component library in Figma." }
        ]
      }
    ],
    projects: [],
    certifications: [],
    languages: [{ name: "English", level: "Native" }]
  };
}

function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/app/utils/semantic-match.js");
  const sm = ctx.window.CBV2.semanticMatch;
  assert.ok(sm && typeof sm.buildResumeCorpus === "function", "semanticMatch.buildResumeCorpus is exported");

  // 1. The exact shape that used to throw must NOT throw, and must include the
  //    skill items in the corpus.
  const resume = structuredResume();
  let corpus;
  assert.doesNotThrow(function () { corpus = sm.buildResumeCorpus(resume); },
    "buildResumeCorpus must not throw on the { groups: [...] } skills shape");
  assert.ok(corpus.includes("Figma"), "skill items appear in the corpus");
  assert.ok(corpus.includes("TypeScript"), "skill items from the first group appear");
  assert.ok(corpus.includes("Storybook"), "skill items from later groups appear too");
  assert.ok(corpus.includes("Product Designer"), "experience role is in the corpus");

  // 2. A JD keyword that ONLY exists in the skills section must count as
  //    covered. This is the real payoff — skills are where ATS keywords live.
  const tokens = sm.tokenize(corpus);
  assert.strictEqual(sm.semanticHas(tokens, "Figma"), true, "skills-only keyword is matched");
  assert.strictEqual(sm.semanticHas(tokens, "TS"), true, "synonym of a skill (TS→TypeScript) is matched");
  assert.strictEqual(sm.semanticHas(tokens, "Kubernetes"), false, "absent keyword is not matched");

  // 3. Legacy shapes are tolerated (old stored resumes).
  const legacyArray = Object.assign(structuredResume(), { skills: ["React", "GraphQL"] });
  let legacyCorpus;
  assert.doesNotThrow(function () { legacyCorpus = sm.buildResumeCorpus(legacyArray); },
    "flat string-array skills shape is tolerated");
  assert.ok(legacyCorpus.includes("React"), "legacy array skills are included");

  const legacyObjArray = Object.assign(structuredResume(), { skills: [{ name: "Rust" }] });
  assert.ok(sm.buildResumeCorpus(legacyObjArray).includes("Rust"), "legacy [{name}] skills are included");

  // 4. Empty / malformed input is safe.
  assert.strictEqual(sm.buildResumeCorpus(null), "", "null resume returns empty string");
  assert.strictEqual(sm.buildResumeCorpus({}), "", "empty resume returns empty string");
  assert.doesNotThrow(function () { sm.buildResumeCorpus({ skills: { groups: [{ items: [null, ""] }] } }); },
    "null/blank skill items are skipped without throwing");

  console.log("resume-matching.test.js passed");
}

run();
