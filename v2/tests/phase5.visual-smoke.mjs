/* eslint-disable no-console */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

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
      header: { name: "Candidate Example", title: "Fire Protection Engineer", email: "candidate@example.com", phone: "", location: "Pretoria", links: [] },
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

const routes = [
  { hash: "#/dashboard", mustMatch: /Candidate intelligence/i },
  { hash: "#/applications", mustMatch: /Application flow/i },
  { hash: "#/resume", mustMatch: /resume|CV/i },
  { hash: "#/cover-letter", mustMatch: /cover letter|letter/i },
  { hash: "#/interview", mustMatch: /Interview Command Center/i },
  { hash: "#/analytics", mustMatch: /Analytics/i },
  { hash: "#/job-search", mustMatch: /Search command|Job Search/i },
  { hash: "#/settings", mustMatch: /Settings|Candidate control center/i }
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

async function checkRoute(page, baseUrl, route, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}${route.hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#route-view", { timeout: 10000 });
  await page.waitForTimeout(350);
  const text = await page.locator("#route-view").innerText({ timeout: 10000 });
  if (route.mustMatch && !route.mustMatch.test(text)) {
    throw new Error(`${route.hash} missing expected text pattern: ${route.mustMatch}`);
  }
  if (/Route Error|Could not render this page/i.test(text)) {
    throw new Error(`${route.hash} rendered route error`);
  }
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
  if (overflow > 24) {
    throw new Error(`${route.hash} has document horizontal overflow: ${overflow}px`);
  }
  const screenshot = await page.screenshot({ fullPage: false });
  if (screenshot.byteLength < 18000) {
    throw new Error(`${route.hash} screenshot looks unexpectedly blank`);
  }
}

async function main() {
  const server = createServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const executablePath = await resolveBrowserExecutable();
  const browser = await chromium.launch(Object.assign(
    { headless: true },
    executablePath ? { executablePath } : {}
  ));
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.addInitScript((storeSeed) => {
    window.CB_CONFIG = Object.assign({}, window.CB_CONFIG || {}, { forceLocal: true });
    localStorage.setItem("cbv2_store_v1", JSON.stringify(storeSeed));
    localStorage.removeItem("cbv2.activeRoleContext");
  }, seed);

  for (const route of routes) {
    await checkRoute(page, baseUrl, route, { width: 1440, height: 950 });
  }
  for (const route of routes.slice(0, 5)) {
    await checkRoute(page, baseUrl, route, { width: 390, height: 844 });
  }

  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(" | ")}`);
  await browser.close();
  server.close();
  console.log("Phase 5 visual smoke passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
