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
  const app = {
    id: "app_p4",
    company: "BuildSafe",
    role: "Fire Protection Engineer",
    stage: "saved",
    priority: "high",
    appliedAt: "2026-05-06",
    jobUrl: "https://www.linkedin.com/jobs/view/123/",
    nextAction: "Tailor resume and apply",
    notes: [
      "Imported from LinkedIn via CareerBoost extension.",
      "Source: https://www.linkedin.com/jobs/view/123/",
      "Location: Pretoria, South Africa",
      "",
      "Job description snapshot:",
      "Role Description: Fire Protection Engineer responsible for sprinkler systems, fire detection, smoke control, compliance reports, hydraulic calculations, and site assessments."
    ].join("\n")
  };
  const all = {
    applications: [app],
    resume: {
      base: "Fire protection engineer with 5 years of sprinkler systems, fire detection, compliance reports, hydraulic calculations, and site assessments experience. Designed 12 sprinkler systems.",
      structured: {
        header: { name: "Candidate Example", title: "Fire Protection Engineer", email: "candidate@example.com", phone: "+27123456789", location: "Pretoria" },
        summary: "Fire protection engineer with 5 years of sprinkler systems, fire detection, and hydraulic calculations experience.",
        experience: [{
          role: "Fire Engineer",
          company: "SafeWorks",
          bullets: [
            { text: "Designed 12 sprinkler and fire detection packages for industrial facilities." },
            { text: "Improved compliance reporting quality by 30% across site assessments." },
            { text: "Led hydraulic calculations for high-risk building services projects." },
            { text: "Implemented smoke control review process for client submissions." },
            { text: "Coordinated contractors during site visits and commissioning." },
            { text: "Delivered cost estimates for fire suppression upgrades." }
          ]
        }],
        skills: { groups: [{ label: "Engineering", items: ["Sprinkler systems", "Fire detection", "Hydraulic calculations"] }] },
        projects: []
      },
      savedCVs: [{ id: "cv1", name: "Fire Engineer CV", baseText: "sprinkler systems", structured: {}, updatedAt: "2026-05-01T00:00:00.000Z" }],
      tailored: { data: { summary: "Tailored for fire protection" } },
      careerAssets: []
    },
    coverLetter: {
      lastResult: null,
      variants: [{ id: "v1", label: "Variant A", subject: "Application", body: "Dear Hiring Team,\n\nI am excited to apply for the Fire Protection Engineer role at BuildSafe. I designed 12 sprinkler systems and improved compliance reporting by 30%.\n\nThank you for your consideration.\n\nBest regards,\nCandidate", template: "professional-clean" }],
      rolePacks: [{ id: "p1", name: "Fire roles", role: "Fire Protection Engineer", tone: "professional", length: "medium", strengths: "sprinkler systems, fire detection" }],
      sentLog: [],
      activeVariantId: "",
      activeRolePackId: ""
    },
    interview: {
      lastSet: null,
      mockSession: null,
      intelSession: {
        intelPackEnvelope: {
          data: {
            processOverview: "Expect role-depth and safety compliance questions.",
            citedInsights: [{ sourceTitle: "BuildSafe careers", url: "https://example.com/careers", insight: "The company values safety and client delivery." }],
            recommendedReads: [{ title: "Safety note", url: "https://example.com/safety", reason: "Understand company priorities." }]
          }
        },
        hits: []
      }
    }
  };
  const window = {
    CBV2: {
      store: {
        getAll: () => all,
        getApplications: () => all.applications
      },
      jobNotes: {
        parseImportedNotes: () => ({
          source: "https://www.linkedin.com/jobs/view/123/",
          location: "Pretoria, South Africa",
          description: "Fire Protection Engineer responsible for sprinkler systems, fire detection, smoke control, compliance reports, hydraulic calculations, and site assessments."
        })
      },
      candidateIntel: {
        getCandidateCorpus: () => ({
          raw: all.resume.base,
          normalized: all.resume.base.toLowerCase(),
          hasResume: true,
          hasStructured: true,
          hasTailored: true
        }),
        scoreSavedApplications: () => ({
          scored: [{
            app,
            score: 84,
            strengths: ["Resume overlaps with sprinkler systems."],
            risks: ["Smoke control evidence should be clearer."]
          }]
        })
      }
    }
  };
  return { ctx: vm.createContext({ window, console, Date, JSON, String, Number, Math, Set, URL }), app, all };
}

function run() {
  const { ctx, app, all } = makeContext();
  loadScript(ctx, "src/js/services/candidate/product.intelligence.js");
  const api = ctx.window.CBV2.productIntel;

  const interview = api.interviewPrep({ app, company: app.company, role: app.role, stage: "first" }, { all });
  assert.strictEqual(interview.sourceConfidence, "Source-backed");
  assert.ok(interview.questionBank.length >= 6);
  assert.ok(interview.weakDrills.length >= 1);
  assert.ok(interview.sources.length >= 1);

  const resume = api.resumeLab(all.resume.structured, { all, health: { score: 91, roleMatch: 78, ats: { score: 88 }, comp: { score: 94 } } });
  assert.strictEqual(resume.versionCount, 1);
  assert.ok(resume.readyCount >= 5);
  assert.ok(resume.beforeAfter.improvements.length >= 2);

  const cover = api.coverStudio(all.coverLetter, {
    subject: "Application",
    body: all.coverLetter.variants[0].body,
    company: "BuildSafe",
    role: "Fire Protection Engineer"
  });
  assert.ok(cover.quality.score >= 70);
  assert.strictEqual(cover.variants.length, 1);
  assert.strictEqual(cover.rolePacks.length, 1);

  const recs = api.analyticsRecommendations(all.applications, { all });
  assert.ok(recs.some((r) => /Apply priority/i.test(r.title)));

  console.log("Product intelligence tests passed.");
}

run();
