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

function sanitizeText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeLocalStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  };
}

function run() {
  const window = { CBV2: { sanitizeText } };
  const ctx = vm.createContext({
    window,
    localStorage: makeLocalStorage(),
    console,
    Date,
    Math,
    JSON,
    URL,
    Number,
    String,
    Object,
    Array,
    RegExp,
    isNaN
  });

  loadScript(ctx, "src/js/services/jobs/job.notes.js");
  loadScript(ctx, "src/js/app/store.js");

  const remoteStoreSrc = fs.readFileSync(path.resolve(__dirname, "..", "src/js/app/store.remote.js"), "utf8");
  assert.ok(
    remoteStoreSrc.includes("notes: buildPipelineNotesFromJob(job)"),
    "cloud store must use the shared pipeline note builder"
  );
  assert.ok(
    remoteStoreSrc.includes("refreshApplicationsFromRemote"),
    "cloud store must refresh applications created by the extension without a manual page refresh"
  );
  assert.ok(
    !remoteStoreSrc.includes('notes: (job.url ? "Source: " + job.url'),
    "cloud store must not save only Source and Location"
  );

  const app = ctx.window.CBV2.store.saveJobAsApplication({
    id: "adzuna_5714280596",
    source: "Adzuna",
    title: "Fire Engineer",
    company: "ExecutivePlacements.com",
    location: "Johannesburg, Gauteng",
    url: "https://www.adzuna.co.za/details/5714280596?utm_medium=api",
    employmentType: "Full-time",
    descriptionText: "About the job: Design and install fire suppression systems. Responsibilities: Prepare fire reports. Requirements: 3-5 years fire protection experience."
  });

  assert.ok(app.notes.includes("Imported from Adzuna via CareerBoost job search."));
  assert.ok(app.notes.includes("Source: https://www.adzuna.co.za/details/5714280596"));
  assert.ok(app.notes.includes("Location: Johannesburg, Gauteng"));
  assert.ok(app.notes.includes("Job description snapshot:"));
  assert.ok(app.notes.includes("Design and install fire suppression systems"));
  assert.ok(app.notes.includes("Responsibilities"));

  const parsed = ctx.window.CBV2.jobNotes.parseImportedNotes(app.notes);
  assert.strictEqual(parsed.location, "Johannesburg, Gauteng");
  assert.ok(parsed.description.includes("3-5 years fire protection experience"));

  const longDescription = "Start of full posting. " + "Responsibilities: ".repeat(350) + "Final retained requirement.";
  const longApp = ctx.window.CBV2.store.saveJobAsApplication({
    id: "adzuna_long",
    source: "Adzuna",
    title: "Software Engineering Manager",
    company: "Capital One",
    location: "London, UK",
    url: "https://www.adzuna.co.uk/jobs/land/ad/5716108708",
    descriptionText: longDescription
  });
  assert.ok(
    longApp.notes.includes("Final retained requirement."),
    "pipeline notes should preserve long job descriptions instead of cutting them early"
  );

  const redirected = ctx.window.CBV2.store.saveJobAsApplication({
    id: "adzuna_redirect",
    source: "Reed.co.uk",
    providerSource: "Adzuna",
    finalSource: "Reed.co.uk",
    title: "Mechanical Engineer",
    company: "Morson Edge",
    location: "Somers Town, North West London",
    url: "https://www.reed.co.uk/jobs/mechanical-engineer/123",
    finalUrl: "https://www.reed.co.uk/jobs/mechanical-engineer/123",
    descriptionText: "What you'll do\n• Deliver mechanical building services\n\nWhat we're looking for\n• Project delivery experience"
  });
  assert.ok(
    redirected.notes.includes("Imported from Adzuna via CareerBoost job search."),
    "pipeline notes should keep the original discovery provider"
  );
  assert.ok(redirected.notes.includes("Found via: Adzuna"));
  assert.ok(redirected.notes.includes("Opens at: Reed.co.uk"));
  assert.ok(redirected.notes.includes("Deliver mechanical building services"));

  const searchSnapshot = {
    jobs: [{
      id: "persisted_job_1",
      source: "Adzuna",
      title: "Mechanical Engineer",
      company: "Morson Edge",
      location: "London, UK",
      url: "https://www.adzuna.co.uk/details/1",
      descriptionText: "Full retained description"
    }],
    query: "mechanical engineer",
    at: Date.now(),
    total: 1,
    sort: "newest",
    filters: { location: "London", sort: "newest", activeOnly: true }
  };
  ctx.window.CBV2.store.setLastJobSearchResults(searchSnapshot);
  const restored = ctx.window.CBV2.store.getLastJobSearchResults();
  assert.strictEqual(restored.jobs.length, 1, "last job-search result set should persist in the local store");
  assert.strictEqual(restored.query, "mechanical engineer");
  assert.strictEqual(ctx.window.CBV2.store.getJobSearchState().lastQuery, "mechanical engineer");
  ctx.window.CBV2.store.clearLastJobSearchResults();
  assert.strictEqual(ctx.window.CBV2.store.getLastJobSearchResults(), null, "clear should remove persisted search results");

  console.log("Job pipeline notes tests passed.");
}

run();
