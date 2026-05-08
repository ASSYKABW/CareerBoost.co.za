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

function makeContext() {
  const window = {
    CBV2: {
      sanitizeText,
      candidateIntel: {
        build: () => ({
          scores: { readiness: 76 },
          evidence: { count: 7, quantifiedCount: 3 },
          roleProfile: { targetTitles: ["Fire Protection Engineer"] },
          resume: { savedCvCount: 2 },
          skills: {
            top: ["fire protection", "sprinkler systems"],
            matchedTarget: ["fire protection"]
          },
          gaps: [{ label: "Add evidence for smoke control" }],
          nextActions: [{ label: "Improve target evidence", href: "#/resume" }]
        }),
        formatSkill: (skill) => String(skill).replace(/\b\w/g, (m) => m.toUpperCase())
      }
    }
  };
  return vm.createContext({
    window,
    console,
    URL,
    RegExp,
    String,
    Object,
    Array,
    JSON
  });
}

function run() {
  const ctx = makeContext();
  loadScript(ctx, "src/js/services/jobs/job.notes.js");
  loadScript(ctx, "src/js/components/ui-kit.js");

  const notes = [
    "Imported from LinkedIn via CareerBoost extension.",
    "Source: https://www.linkedin.com/jobs/view/123/",
    "Location: Pretoria, Gauteng, South Africa",
    "",
    "Job description snapshot:",
    "Recruiter: Safe Talent",
    "Role Description: Fire Engineer responsible for fire detection.Responsibilities: Design sprinkler systems",
    "Requirements: 3-5 years fire protection experience"
  ].join("\n");

  const parsed = ctx.window.CBV2.jobNotes.parseImportedNotes(notes);
  assert.strictEqual(parsed.location, "Pretoria, Gauteng, South Africa");
  assert.ok(parsed.description.includes("Role Description"), "description should be extracted");

  const normalized = ctx.window.CBV2.jobNotes.normalizeJobDescription(parsed.description);
  assert.ok(/\n\nRole Description:\n/.test(normalized), "labels should become readable sections");
  assert.ok(/\n\nResponsibilities:\n/.test(normalized), "adjacent labels should be separated");

  const html = ctx.window.CBV2.jobNotes.renderImportedSnapshot({ notes });
  assert.ok(html.includes("Imported job description"), "snapshot should render title");
  assert.ok(html.includes("drawer-job-section-title"), "snapshot should render structured sections");
  assert.ok(!html.includes("<script>"), "snapshot should be sanitized");

  const adzunaNotes = ctx.window.CBV2.jobNotes.buildImportedNotes({
    source: "Adzuna",
    title: "Fire Engineer",
    company: "ExecutivePlacements.com",
    location: "Johannesburg, Gauteng",
    url: "https://www.adzuna.co.za/details/5714280596",
    descriptionText: "About the job: Design and install fire suppression systems. Requirements: 3-5 years fire protection experience."
  });
  assert.ok(adzunaNotes.includes("Imported from Adzuna via CareerBoost job search."));
  assert.ok(adzunaNotes.includes("Job description snapshot:"));
  assert.ok(adzunaNotes.includes("Design and install fire suppression systems"));
  const adzunaParsed = ctx.window.CBV2.jobNotes.parseImportedNotes(adzunaNotes);
  assert.strictEqual(adzunaParsed.location, "Johannesburg, Gauteng");
  assert.ok(adzunaParsed.description.includes("Requirements"), "Adzuna description should be captured for pipeline notes");

  const reedNotes = ctx.window.CBV2.jobNotes.buildImportedNotes({
    source: "UK",
    title: "Senior Software Engineering Manager",
    company: "Capital One",
    location: "London, UK",
    url: "https://www.adzuna.co.uk/jobs/land/ad/5716108708",
    descriptionText: [
      "White Collar Factory Senior Software Engineering Manager What you'll do",
      "• Lead a cross-functional group of engineering teams",
      "• Coach engineering managers",
      "What we're looking for",
      "• Experience leading engineering teams",
      "What you'll get to learn (any previous experience would be advantageous)",
      "• Cloud and AWS"
    ].join("\n")
  });
  assert.ok(reedNotes.includes("Imported from Adzuna via CareerBoost job search."), "source should be inferred from Adzuna UK URL");
  const reedHtml = ctx.window.CBV2.jobNotes.renderImportedSnapshot({ notes: reedNotes });
  assert.ok(reedHtml.includes("What You'll Do"), "Reed-style headings should become structured sections");
  assert.ok(reedHtml.includes("Lead a cross-functional group"), "bullet content should be preserved");
  assert.ok(reedHtml.includes("adzuna.co.uk"), "source meta should show a compact host instead of an overflowing URL");

  const empty = ctx.window.CBV2.ui.emptyState({
    icon: "fa-compass",
    title: "Nothing urgent",
    body: "Add a role.",
    actions: [{ label: "Open", href: "#/applications", className: "btn-primary" }]
  });
  assert.ok(empty.includes("empty-state"));
  assert.ok(empty.includes("#/applications"));

  const card = ctx.window.CBV2.ui.candidateIntelligenceCard({
    title: "Candidate intelligence",
    badge: "Shared profile model"
  });
  assert.ok(card.includes("76"), "candidate card should render readiness score");
  assert.ok(card.includes("Fire Protection"), "candidate card should render formatted skills");
  assert.ok(card.includes("Improve target evidence"), "candidate card should render actions");

  console.log("Phase 5 shared UI tests passed.");
}

run();
