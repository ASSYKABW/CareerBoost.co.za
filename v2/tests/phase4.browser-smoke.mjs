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

const seed = {
  applications: [{
    id: "app_phase4",
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
      "Role Description: Fire Protection Engineer responsible for sprinkler systems, fire detection, smoke control, compliance reports, and hydraulic calculations."
    ].join("\n")
  }],
  events: [],
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
    lastQuery: "",
    lastFilters: {
      remoteOnly: false,
      postedWithinDays: 0,
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

async function main() {
  const server = createServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const executablePath = await resolveBrowserExecutable();
  const browser = await chromium.launch(Object.assign(
    { headless: true },
    executablePath ? { executablePath } : {}
  ));
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.addInitScript((storeSeed) => {
    window.CB_CONFIG = Object.assign({}, window.CB_CONFIG || {}, { forceLocal: true });
    localStorage.setItem("cbv2_store_v1", JSON.stringify(storeSeed));
    localStorage.removeItem("cbv2.activeRoleContext");
  }, seed);

  await page.goto(`${baseUrl}#/applications`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-app-id="app_phase4"]', { timeout: 10000 });
  await page.click('[data-app-id="app_phase4"]');
  await page.waitForSelector(".app-command-center", { timeout: 10000 });
  const drawer = await page.locator(".app-command-center").innerText();
  if (!drawer.toLowerCase().includes("application command center")) throw new Error("application command center missing");

  await page.click('.app-command-material[href="#/resume"]');
  await page.waitForURL(/#\/resume$/, { timeout: 10000 });
  await page.waitForSelector(".role-context-banner", { timeout: 10000 });
  const resumeRole = await page.locator("#tailor-target-role").inputValue();
  if (resumeRole !== "Fire Protection Engineer") throw new Error(`resume role context not loaded: ${resumeRole}`);

  await page.goto(`${baseUrl}#/cover-letter`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#cover-form", { timeout: 10000 });
  const company = await page.locator('input[name="company"]').inputValue();
  if (company !== "BuildSafe") throw new Error(`cover company context not loaded: ${company}`);

  await page.goto(`${baseUrl}#/interview`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".interview-target-chips", { timeout: 10000 });
  const chips = await page.locator(".interview-target-chips").innerText();
  if (!chips.includes("BuildSafe") || !chips.includes("Fire Protection Engineer")) {
    throw new Error(`interview context not loaded: ${chips}`);
  }

  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(" | ")}`);
  await browser.close();
  server.close();
  console.log("Phase 4 browser smoke passed.");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
