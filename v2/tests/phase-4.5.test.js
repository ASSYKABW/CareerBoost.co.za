/* eslint-disable no-console */
// Phase 4.5 tests:
//   1. Modal service API surface + fallback behavior
//   2. Interviewer personas — frontend list matches backend directive set
//   3. Backend interview-session-step prompt injects the persona directive

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function readFile(rel) {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

function loadScript(ctx, relPath) {
  vm.runInContext(readFile(relPath), ctx, { filename: relPath });
}

function makeBrowserContext() {
  const window = { CBV2: {} };
  const doc = {
    readyState: "complete",
    addEventListener: function () {},
    createElement: function () {
      return {
        textContent: "",
        innerHTML: "",
        appendChild: function () {},
        addEventListener: function () {},
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        setAttribute: function () {},
        remove: function () {},
        get firstElementChild() { return null; }
      };
    },
    head: { appendChild: function () {} },
    body: { appendChild: function () {} },
  };
  return vm.createContext({
    window: window,
    document: doc,
    console: console,
    Date: Date,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    Promise: Promise,
    setTimeout: setTimeout,
    setInterval: function () { return 0; },
    clearInterval: function () {},
  });
}

function run() {
  // ─── Modal service surface ──────────────────────────────────────────
  const modalCtx = makeBrowserContext();
  loadScript(modalCtx, "src/js/components/modal-service.js");
  const modal = modalCtx.window.CBV2.modal;
  assert.ok(modal, "modal service should expose window.CBV2.modal");
  assert.strictEqual(typeof modal.confirm, "function", "modal.confirm should be a function");
  assert.strictEqual(typeof modal.prompt, "function", "modal.prompt should be a function");
  assert.strictEqual(typeof modal.alert, "function", "modal.alert should be a function");
  assert.strictEqual(typeof modal.confirmText, "function", "modal.confirmText should be a function");
  assert.strictEqual(typeof modal.promptText, "function", "modal.promptText should be a function");
  assert.strictEqual(typeof modal.closeAll, "function", "modal.closeAll should be a function");
  assert.strictEqual(modal._installed, true, "modal should be marked installed after load");
  // confirm/prompt/alert all return promises.
  const p1 = modal.confirm({ title: "Test", body: "Body" });
  assert.ok(p1 && typeof p1.then === "function", "modal.confirm should return a Promise");
  const p2 = modal.prompt({ title: "Test", body: "Body" });
  assert.ok(p2 && typeof p2.then === "function", "modal.prompt should return a Promise");
  const p3 = modal.alert({ title: "Test", body: "Body" });
  assert.ok(p3 && typeof p3.then === "function", "modal.alert should return a Promise");
  console.log("Modal service tests passed.");

  // ─── Personas module ────────────────────────────────────────────────
  const personasCtx = makeBrowserContext();
  loadScript(personasCtx, "src/js/modules/interview/interview.personas.js");
  const personas = personasCtx.window.CBV2.interviewPersonas;
  assert.ok(personas, "personas module should expose window.CBV2.interviewPersonas");
  const list = personas.list();
  assert.strictEqual(list.length, 4, "should expose 4 personas");
  const ids = list.map(function (p) { return p.id; });
  // deepEqual (not deepStrictEqual) because VM-context arrays have a
  // different prototype than the test's host Array; structural match
  // is what we actually care about here.
  assert.deepEqual(
    Array.from(ids).sort(),
    ["executive_panel", "friendly_recruiter", "hostile_skeptic", "technical_lead"],
    "persona ids should match the canonical set"
  );
  // Each persona has required shape.
  list.forEach(function (p) {
    assert.ok(p.id, "persona has id");
    assert.ok(p.label, "persona has label");
    assert.ok(p.icon, "persona has icon");
    assert.ok(p.tone, "persona has tone");
    assert.ok(p.tagline && p.tagline.length > 10, "persona has tagline of substance");
    assert.ok(Array.isArray(p.traits) && p.traits.length >= 3, "persona has 3+ traits");
    assert.ok(["easy", "medium", "hard"].includes(p.difficulty), "persona has valid difficulty");
    assert.ok(p.promptDirective && p.promptDirective.indexOf("PERSONA OVERRIDE") === 0,
      "persona prompt directive starts with PERSONA OVERRIDE");
  });
  // Default returns technical_lead.
  assert.strictEqual(personas.getDefault().id, "technical_lead", "default persona is technical_lead");
  // Unknown id returns null.
  assert.strictEqual(personas.get("nonexistent"), null, "unknown id returns null");
  // getPromptDirective returns directive text.
  const directive = personas.getPromptDirective("friendly_recruiter");
  assert.ok(directive.length > 200, "directive should be substantive (>200 chars)");
  assert.ok(directive.includes("WARM RECRUITER"), "friendly_recruiter directive should mention WARM RECRUITER");
  console.log("Personas module tests passed.");

  // ─── Backend prompt injection contract ──────────────────────────────
  const promptsSrc = readFile("../backend/supabase/functions/_shared/prompts.ts");
  // The INTERVIEW_PERSONAS const exists and has 4 ids matching frontend.
  assert.ok(/const INTERVIEW_PERSONAS:\s*Record<string,\s*string>\s*=/.test(promptsSrc),
    "prompts.ts should define INTERVIEW_PERSONAS constant");
  ids.forEach(function (id) {
    assert.ok(promptsSrc.indexOf(id + ":") >= 0,
      "prompts.ts should declare directive for persona id " + id);
  });
  // personaDirective helper exists and reads interviewerPersona from input.
  assert.ok(/function personaDirective\(input: unknown\): string/.test(promptsSrc),
    "prompts.ts should expose personaDirective()");
  assert.ok(/interviewerPersona/.test(promptsSrc),
    "prompts.ts should read input.interviewerPersona");
  // interview-session-step userTemplate injects the persona.
  const sessionStep = promptsSrc.indexOf('"interview-session-step":');
  assert.ok(sessionStep >= 0, "interview-session-step prompt should exist");
  const sessionStepBlock = promptsSrc.slice(sessionStep, sessionStep + 3500);
  assert.ok(/const persona = personaDirective\(input\)/.test(sessionStepBlock),
    "interview-session-step userTemplate should call personaDirective");
  assert.ok(/persona\s*\+/.test(sessionStepBlock),
    "interview-session-step userTemplate should prepend the directive");

  // Frontend ↔ backend directive parity. The TS source uses string
  // concatenation with line breaks, so substring match would be brittle
  // — instead we assert distinctive phrases unique to each persona's
  // directive are present in the backend source.
  // Phrases must fit on ONE source line in prompts.ts (which line-breaks
  // every ~60 chars during string concatenation). Pick short distinctive
  // markers per persona.
  const distinctivePhrases = {
    friendly_recruiter: ["WARM RECRUITER", "salary expectations"],
    technical_lead: ["TECHNICAL LEAD", "scaling, observability"],
    executive_panel: ["VP / Director", "executive presence"],
    hostile_skeptic: ["HOSTILE SKEPTIC", "biggest failure"],
  };
  Object.keys(distinctivePhrases).forEach(function (id) {
    const phrases = distinctivePhrases[id];
    phrases.forEach(function (phrase) {
      // The phrase must appear in BOTH the frontend persona directive
      // AND the backend prompts.ts.
      const front = personas.get(id);
      assert.ok(front && front.promptDirective.includes(phrase),
        "frontend persona " + id + " should mention: " + phrase);
      assert.ok(promptsSrc.indexOf(phrase) >= 0,
        "backend prompts.ts should mention: " + phrase + " (persona " + id + ")");
    });
  });
  console.log("Backend persona injection contract tests passed.");
}

run();
