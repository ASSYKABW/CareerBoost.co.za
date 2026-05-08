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
  const storeData = {
    applications: [{
      id: "app_saved",
      company: "BuildSafe",
      role: "Fire Protection Engineer",
      stage: "saved",
      priority: "high",
      jobUrl: "https://example.com/fire-protection-engineer",
      nextAction: "Tailor resume and apply",
      notes: [
        "Source: https://example.com/fire-protection-engineer",
        "Location: Pretoria, South Africa",
        "",
        "Job description snapshot:",
        "Role Description Fire Protection Engineer responsible for sprinkler systems, fire detection, building codes, compliance reports, and hydraulic calculations."
      ].join("\n")
    }],
    events: [],
    savedJobs: [],
    resume: {
      base: "Fire protection engineer with 5 years of experience. Designed sprinkler systems and fire detection systems for industrial sites. Delivered compliance reports and building code reviews.",
      structured: {
        summary: "Fire protection engineer",
        skills: ["fire protection", "sprinkler systems", "building codes"],
        experience: [{
          role: "Fire Engineer",
          company: "SafeWorks",
          bullets: [{ text: "Designed sprinkler systems for 12 industrial facilities and improved compliance review speed by 30%." }]
        }]
      },
      tailored: null,
      savedCVs: [],
      careerAssets: [{
        id: "asset_1",
        text: "Delivered fire detection and sprinkler design packages for 12 industrial facilities.",
        tags: ["fire protection", "sprinkler systems"],
        source: "resume-lab"
      }],
      updatedAt: new Date().toISOString()
    },
    jobSearch: {
      roleProfile: {
        targetTitles: ["Fire Protection Engineer"],
        mustHaveSkills: ["fire protection", "sprinkler systems", "hydraulic calculations", "smoke control"],
        excludeKeywords: [],
        seniority: "mid",
        strictMode: false
      },
      lastFilters: { location: "Pretoria, South Africa", remoteOnly: false }
    }
  };
  const window = {
    CBV2: {
      auth: { getUser: () => ({ email: "candidate@example.com" }) },
      profile: {
        get: () => ({
          full_name: "Candidate Example",
          headline: "Fire protection engineer",
          preferences: {
            profile: {
              about: "Fire protection engineer focused on industrial safety.",
              experienceYears: 5,
              skills: ["fire protection", "sprinkler systems"],
              industries: ["Engineering"]
            }
          }
        })
      },
      store: {
        getAll: () => storeData,
        getJobSearchState: () => storeData.jobSearch,
        getEffectiveResumeBaseText: () => storeData.resume.base
      },
      jobNotes: {
        parseImportedNotes: (notes) => ({
          source: "https://example.com/fire-protection-engineer",
          location: "Pretoria, South Africa",
          description: String(notes || "").split("Job description snapshot:")[1] || ""
        })
      }
    }
  };
  return vm.createContext({
    window,
    console,
    Date,
    Set,
    JSON,
    Number,
    String,
    Math
  });
}

function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/services/candidate/candidate.intelligence.js");
  const intelApi = ctx.window.CBV2.candidateIntel;
  const model = intelApi.build();
  assert.ok(model.scores.readiness >= 60, "complete profile should produce useful readiness");
  assert.ok(model.evidence.count >= 2, "resume and assets should produce evidence");
  assert.ok(model.skills.missingTarget.includes("smoke control"), "missing target skills should be exposed");

  const scored = intelApi.scoreSavedApplications(ctx.window.CBV2.store.getAll().applications);
  assert.strictEqual(scored.scored.length, 1, "saved application should be scored");
  assert.ok(scored.scored[0].score >= 60, "relevant saved role should score as promising or better");

  const aiSummary = intelApi.summarizeForAi("cover-letter-generate", {
    company: "BuildSafe",
    role: "Fire Protection Engineer",
    jobDescription: "Smoke control, sprinkler systems, compliance reports, and hydraulic calculations."
  });
  assert.strictEqual(aiSummary.skill, "cover-letter-generate", "AI capsule should keep the calling skill");
  assert.ok(aiSummary.promptBrief.includes("Readiness:"), "AI capsule should include a compact prompt brief");
  assert.ok(aiSummary.guardrails.some((x) => /Never invent/i.test(x)), "AI capsule should include truth guardrails");
  assert.ok(aiSummary.jobLens.missing.includes("Smoke Control"), "AI capsule should expose job-specific weak evidence");

  console.log("Candidate intelligence tests passed.");
}

run();
