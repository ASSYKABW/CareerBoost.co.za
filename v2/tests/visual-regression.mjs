/* eslint-disable no-console */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const snapshotRoot = path.resolve(__dirname, "__snapshots__");
const baselineDir = path.join(snapshotRoot, "baseline");
const actualDir = path.join(snapshotRoot, "actual");
const updateBaselines = process.argv.includes("--update");

const types = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const seed = {
  applications: [
    {
      id: "app_visual_saved",
      company: "BuildSafe",
      role: "Fire Protection Engineer",
      stage: "saved",
      priority: "high",
      appliedAt: "2026-05-06",
      jobUrl: "https://linkedin.com/jobs/view/123",
      nextAction: "Tailor resume and apply",
      notes: [
        "Imported from LinkedIn via CareerBoost extension.",
        "Source: https://linkedin.com/jobs/view/123",
        "Location: Pretoria, South Africa",
        "",
        "Job description snapshot:",
        "Role Description: Fire Protection Engineer responsible for sprinkler systems, fire detection, smoke control, compliance reports, and hydraulic calculations.",
        "Requirements: 3-5 years of fire protection experience."
      ].join("\n")
    },
    {
      id: "app_visual_interview",
      company: "EY",
      role: "Junior Consulting Engineer",
      stage: "interview",
      priority: "medium",
      appliedAt: "2026-05-01",
      nextAction: "Prepare interview stories",
      notes: "Power and utilities consulting role."
    }
  ],
  events: [{
    id: "evt_visual",
    date: "2026-05-08",
    title: "EY interview",
    type: "interview",
    appId: "app_visual_interview"
  }],
  savedJobs: [],
  savedSearches: [],
  resume: {
    base: "Fire protection engineer with 5 years of sprinkler systems, fire detection, compliance reports, and hydraulic calculations experience.",
    tailored: null,
    structured: {
      header: {
        name: "Candidate Example",
        title: "Fire Protection Engineer",
        email: "candidate@example.com",
        phone: "",
        location: "Pretoria",
        links: []
      },
      summary: "Fire protection engineer focused on fire detection and sprinkler systems.",
      experience: [{
        id: "exp1",
        company: "SafeWorks",
        role: "Fire Engineer",
        location: "Pretoria",
        startDate: "2021",
        endDate: "2026",
        current: false,
        bullets: [{ id: "b1", text: "Designed sprinkler systems and fire detection packages for 12 industrial facilities." }]
      }],
      education: [],
      skills: { groups: [{ id: "sk1", label: "Engineering", items: ["Fire protection", "Sprinkler systems", "Hydraulic calculations"] }] },
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      references: [],
      updatedAt: "2026-05-06T00:00:00.000Z",
      source: "test"
    },
    tailor: null,
    savedCVs: [],
    defaultSavedCvId: "",
    careerAssets: [{
      id: "asset1",
      name: "Sprinkler delivery",
      type: "achievement",
      text: "Designed sprinkler systems and fire detection packages for 12 industrial facilities.",
      tags: ["fire protection"],
      source: "test"
    }],
    updatedAt: "2026-05-06T00:00:00.000Z"
  },
  coverLetter: { lastResult: null, variants: [], activeVariantId: "", sentLog: [], rolePacks: [], activeRolePackId: "" },
  interview: { lastSet: null, mockSession: null, intelSession: null },
  jobSearch: {
    lastQuery: "fire engineer",
    lastFilters: {
      remoteOnly: false,
      postedWithinDays: 14,
      sort: "relevance",
      location: "Pretoria",
      jobType: [],
      experienceLevel: [],
      activeOnly: true,
      searchRegion: "global",
      locationStrictness: "strict"
    },
    nlqEnabled: true,
    openGoogleAfterSearch: false,
    roleProfile: {
      targetTitles: ["Fire Protection Engineer"],
      seniority: "mid",
      mustHaveSkills: ["fire protection", "sprinkler systems", "hydraulic calculations"],
      excludeKeywords: [],
      strictMode: false
    },
    analytics: { runs: [] },
    apiKeys: { adzunaAppId: "", adzunaAppKey: "", adzunaCountry: "za", museKey: "" }
  }
};

const viewports = [
  { name: "desktop", width: 1440, height: 950 },
  { name: "mobile", width: 390, height: 844 }
];

const routes = [
  { name: "dashboard", hash: "#/dashboard", mustMatch: /Candidate intelligence/i },
  { name: "applications", hash: "#/applications", mustMatch: /Application flow/i },
  { name: "resume", hash: "#/resume", mustMatch: /resume|CV/i },
  { name: "cover-letter", hash: "#/cover-letter", mustMatch: /cover letter|letter/i },
  { name: "interview", hash: "#/interview", mustMatch: /Interview Command Center/i },
  { name: "analytics", hash: "#/analytics", mustMatch: /Analytics/i },
  { name: "job-search", hash: "#/job-search", mustMatch: /Search command|Job Search/i },
  { name: "settings", hash: "#/settings", mustMatch: /Settings|Candidate control center/i }
];

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent(String(req.url || "/").split("?")[0]);
      if (urlPath === "/" || urlPath === "/index.html") urlPath = "/index.html";
      const file = path.normalize(path.join(root, urlPath));
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const data = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream"
      });
      res.end(data);
    } catch (_) {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function resolveBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_) {
      // Try the next installed browser.
    }
  }
  return "";
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

async function captureRoute(page, baseUrl, route, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${baseUrl}${route.hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#route-view", { timeout: 10000 });
  await page.addStyleTag({
    content: [
      "*, *::before, *::after {",
      "  animation-delay: 0s !important;",
      "  animation-duration: 0s !important;",
      "  animation-iteration-count: 1 !important;",
      "  transition-delay: 0s !important;",
      "  transition-duration: 0s !important;",
      "  scroll-behavior: auto !important;",
      "}",
      ".provider-marquee-track { transform: none !important; }"
    ].join("\n")
  });
  await page.waitForTimeout(350);
  const text = await page.locator("#route-view").innerText({ timeout: 10000 });
  if (route.mustMatch && !route.mustMatch.test(text)) {
    throw new Error(`${route.hash} missing expected text pattern: ${route.mustMatch}`);
  }
  if (/Route Error|Could not render this page|undefined|NaN/i.test(text)) {
    throw new Error(`${route.hash} rendered suspicious text`);
  }
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
  if (overflow > 24) throw new Error(`${route.hash} has document horizontal overflow: ${overflow}px`);
  return page.screenshot({ fullPage: false });
}

async function main() {
  await fs.mkdir(baselineDir, { recursive: true });
  await fs.mkdir(actualDir, { recursive: true });

  const server = createServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const executablePath = await resolveBrowserExecutable();
  const browser = await chromium.launch(Object.assign(
    { headless: true },
    executablePath ? { executablePath } : {}
  ));
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.addInitScript((storeSeed) => {
    const fixedNow = new Date("2026-05-07T12:00:00+02:00").getTime();
    const RealDate = Date;
    class StableDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedNow]));
      }
      static now() { return fixedNow; }
    }
    StableDate.UTC = RealDate.UTC;
    StableDate.parse = RealDate.parse;
    window.Date = StableDate;
    window.CB_CONFIG = Object.assign({}, window.CB_CONFIG || {}, { forceLocal: true });
    localStorage.setItem("cbv2_store_v1", JSON.stringify(storeSeed));
    localStorage.removeItem("cbv2.activeRoleContext");
  }, seed);

  const actualManifest = {};
  const changed = [];
  const created = [];

  try {
    for (const viewport of viewports) {
      for (const route of routes) {
        const name = `${viewport.name}-${route.name}.png`;
        const actualFile = path.join(actualDir, name);
        const baselineFile = path.join(baselineDir, name);
        const screenshot = await captureRoute(page, baseUrl, route, viewport);
        await fs.writeFile(actualFile, screenshot);
        const actualHash = sha256(screenshot);
        actualManifest[name] = {
          hash: actualHash,
          bytes: screenshot.byteLength,
          route: route.hash,
          viewport: { width: viewport.width, height: viewport.height }
        };

        const hasBaseline = await fileExists(baselineFile);
        if (updateBaselines || !hasBaseline) {
          await fs.writeFile(baselineFile, screenshot);
          created.push(name);
          continue;
        }

        const baselineHash = sha256(await fs.readFile(baselineFile));
        if (baselineHash !== actualHash) changed.push(name);
      }
    }

    await fs.writeFile(path.join(snapshotRoot, "actual-manifest.json"), JSON.stringify(actualManifest, null, 2));
    if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(" | ")}`);
    if (changed.length) {
      throw new Error(`Visual regression changed: ${changed.join(", ")}. Run with --update to accept intentional design changes.`);
    }
    const suffix = created.length ? ` Baselines created/updated: ${created.length}.` : "";
    console.log(`Visual regression passed.${suffix}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
