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

function makeContext(options) {
  let capturedPayload = null;
  const prefs = Object.assign({
    personalizedMode: true,
    tone: "professional",
    responseLength: "balanced",
    localeStyle: "global",
    modules: {
      jobSearch: true,
      resume: true,
      coverLetter: true,
      interview: true
    }
  }, options && options.aiPreferences || {});

  const window = {
    CBV2: {
      profile: {
        get: () => ({
          full_name: "Candidate Example",
          headline: "Fire Protection Engineer",
          preferences: {
            profile: {
              about: "Fire protection engineer focused on industrial safety.",
              skills: ["Fire Protection", "Sprinkler Systems"]
            },
            jobPreferences: {
              roleProfile: {
                targetTitles: ["Fire Engineer"]
              }
            },
            aiPreferences: prefs
          }
        })
      },
      candidateIntel: {
        summarizeForAi: (skill, input) => ({
          version: 1,
          skill,
          readiness: 76,
          target: {
            roles: ["Fire Engineer"],
            missingSkills: ["Smoke Control"]
          },
          skills: ["Fire Protection", "Sprinkler Systems"],
          evidence: [{
            text: "Delivered fire detection and sprinkler design packages for 12 industrial facilities.",
            quantified: true
          }],
          promptBrief: "Readiness: 76/100. Missing target evidence: Smoke Control.",
          sourceCompany: input && input.company
        })
      }
    },
    CBAI: {
      schemas: {
        "cover-letter-generate": (data) => Boolean(data && typeof data.subject === "string" && typeof data.body === "string")
      },
      promptVersions: {
        "cover-letter-generate": "cover-letter-generate@test"
      },
      providers: [{
        name: "capture-provider",
        run: (payload) => {
          capturedPayload = payload;
          return Promise.resolve({
            ok: true,
            requestId: payload.requestId,
            model: "test-model",
            latencyMs: 1,
            confidence: 0.9,
            warnings: [],
            data: {
              subject: "Application - Fire Engineer",
              body: "Candidate-specific body."
            }
          });
        }
      }]
    }
  };

  const ctx = vm.createContext({
    window,
    console,
    Date,
    Math,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean
  });
  ctx.getCapturedPayload = () => capturedPayload;
  return ctx;
}

async function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/ai/ai.orchestrator.js");
  await ctx.window.CBAI.runSkill("cover-letter-generate", {
    company: "BuildSafe",
    role: "Fire Engineer"
  });
  const payload = ctx.getCapturedPayload();
  assert.ok(payload, "provider should receive a payload");
  assert.strictEqual(payload.input.company, "BuildSafe", "original input should remain present");
  assert.ok(payload.input.__aiContext, "personalized AI context should be attached");
  assert.strictEqual(payload.input.__aiContext.module, "coverLetter");
  assert.strictEqual(payload.input.__aiContext.candidate.readiness, 76);
  assert.strictEqual(payload.input.__aiContext.candidate.sourceCompany, "BuildSafe");
  assert.ok(
    payload.input.__aiContext.contextRules.some((rule) => /Do not invent facts/i.test(rule)),
    "context should include truthfulness guardrails"
  );

  const disabledCtx = makeContext({
    aiPreferences: {
      modules: { coverLetter: false }
    }
  });
  loadScript(disabledCtx, "src/js/ai/ai.orchestrator.js");
  await disabledCtx.window.CBAI.runSkill("cover-letter-generate", {
    company: "BuildSafe",
    role: "Fire Engineer"
  });
  assert.ok(!disabledCtx.getCapturedPayload().input.__aiContext, "disabled modules should not receive context");

  console.log("AI context propagation tests passed.");
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
