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

function makeStorage() {
  const data = {};
  return {
    getItem: (key) => Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; }
  };
}

function makeContext() {
  const window = {
    localStorage: makeStorage(),
    CBV2: {
      jobNotes: {
        parseImportedNotes: (notes) => {
          const raw = String(notes || "");
          return {
            source: "https://linkedin.com/jobs/view/123",
            location: "Pretoria, South Africa",
            description: raw.split("Job description snapshot:")[1] || ""
          };
        }
      }
    }
  };
  return vm.createContext({
    window,
    console,
    Date,
    JSON,
    String
  });
}

function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/services/candidate/role.context.js");
  const roleContext = ctx.window.CBV2.roleContext;
  const app = {
    id: "app_123",
    company: "BuildSafe",
    role: "Fire Protection Engineer",
    stage: "saved",
    priority: "high",
    jobUrl: "https://linkedin.com/jobs/view/123",
    nextAction: "Tailor resume and apply",
    notes: [
      "Imported from LinkedIn via CareerBoost extension.",
      "Source: https://linkedin.com/jobs/view/123",
      "Location: Pretoria, South Africa",
      "",
      "Job description snapshot:",
      "Role Description: Sprinkler systems, smoke control, and compliance reports."
    ].join("\n")
  };

  const saved = roleContext.useApplication(app, { destination: "resume", origin: "test" });
  assert.strictEqual(saved.company, "BuildSafe");
  assert.strictEqual(saved.destination, "resume");
  assert.ok(saved.jobDescription.includes("Sprinkler systems"), "job description should be extracted");

  const loaded = roleContext.get();
  assert.strictEqual(loaded.appId, "app_123");
  assert.strictEqual(loaded.role, "Fire Protection Engineer");
  assert.ok(roleContext.keyFor(loaded).includes("app_123"), "context key should include app id");

  const match = roleContext.findApplication([app], loaded);
  assert.strictEqual(match.id, "app_123");

  roleContext.clear();
  assert.strictEqual(roleContext.get(), null);

  console.log("Role context tests passed.");
}

run();
