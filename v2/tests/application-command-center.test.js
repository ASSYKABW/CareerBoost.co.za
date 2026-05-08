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
    id: "app_cmd",
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
      "Role Description: Fire Protection Engineer responsible for sprinkler systems, fire detection, smoke control, compliance reports, and hydraulic calculations."
    ].join("\n")
  };
  const all = {
    applications: [app],
    resume: {
      base: "Fire protection engineer with 5 years of sprinkler systems, fire detection, compliance reports, and hydraulic calculations experience.",
      structured: { summary: "Fire protection engineer" },
      tailor: {
        jdRole: "Fire Protection Engineer",
        jdText: "sprinkler systems fire detection hydraulic calculations"
      },
      tailored: { data: { summary: "Tailored for fire protection" } },
      savedCVs: [],
      careerAssets: []
    },
    coverLetter: {
      lastResult: { data: { subject: "Application", body: "A tailored letter for BuildSafe and the Fire Protection Engineer role.".repeat(4) } },
      variants: [],
      rolePacks: [],
      sentLog: []
    },
    interview: {
      lastSet: null,
      mockSession: null,
      intelSession: null
    }
  };
  const events = [];
  const window = {
    CBV2: {
      store: {
        getAll: () => all,
        getApplications: () => all.applications
      },
      jobNotes: {
        parseImportedNotes: (notes) => {
          const raw = String(notes || "");
          if (!/Job description snapshot:/i.test(raw)) return null;
          return {
            source: "https://www.linkedin.com/jobs/view/123/",
            location: "Pretoria, South Africa",
            description: raw.split("Job description snapshot:")[1] || ""
          };
        }
      },
      candidateIntel: {
        build: () => ({}),
        scoreApplicationFit: () => ({
          score: 78,
          band: { label: "Strong fit", tone: "cyan", action: "Tailor and apply" },
          strengths: ["Resume evidence overlaps with sprinkler systems."],
          risks: ["Missing or weak resume evidence: smoke control."],
          subScores: { skills: 76, evidence: 80, readiness: 72 },
          hasDescription: true
        })
      }
    }
  };
  return { ctx: vm.createContext({ window, console, Date, JSON, String, Number, Math, URL, Array }), app, all, events };
}

function run() {
  const { ctx, app, all, events } = makeContext();
  loadScript(ctx, "src/js/services/candidate/application.command-center.js");
  const api = ctx.window.CBV2.applicationCommand;
  const model = api.build(app, { all, apps: all.applications, events });

  assert.strictEqual(model.source.name, "LinkedIn");
  assert.strictEqual(model.source.method, "Imported via CareerBoost extension");
  assert.strictEqual(model.materials.find((x) => x.id === "source").status, "ready");
  assert.strictEqual(model.materials.find((x) => x.id === "resume").status, "ready");
  assert.strictEqual(model.materials.find((x) => x.id === "cover").status, "partial");
  assert.strictEqual(model.next.label, "Apply and move forward");
  assert.ok(model.readiness >= 70, "ready source, fit, resume, and draft should produce strong readiness");

  const weak = Object.assign({}, app, { jobUrl: "", notes: "Manual note", stage: "saved" });
  const weakModel = api.build(weak, { all, apps: all.applications, events: [] });
  assert.strictEqual(weakModel.source.status, "missing");
  assert.strictEqual(weakModel.next.label, "Verify source and posting");

  console.log("Application command center tests passed.");
}

run();
