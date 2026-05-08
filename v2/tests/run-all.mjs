/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const node = process.execPath;
const args = new Set(process.argv.slice(2));

const runBrowser = args.has("--browser") || args.has("--all");
const runVisual = args.has("--visual") || args.has("--all") || args.has("--update-visual");
const updateVisual = args.has("--update-visual");

if (args.has("--help")) {
  console.log([
    "CareerBoost test runner",
    "",
    "Default: syntax checks + unit/contract tests",
    "  --browser        add browser smoke tests",
    "  --visual         add visual regression compare",
    "  --update-visual  refresh visual regression baselines",
    "  --all            run syntax, unit, browser, and visual checks"
  ].join("\n"));
  process.exit(0);
}

async function collectFiles(dir, matcher, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__snapshots__" || entry.name === "node_modules") continue;
      await collectFiles(full, matcher, out);
    } else if (matcher(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

function rel(file) {
  return path.relative(root, file);
}

function run(commandArgs, label) {
  console.log(`\n== ${label}`);
  console.log(`${path.basename(node)} ${commandArgs.join(" ")}`);
  const result = spawnSync(node, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runCheck(file) {
  run(["--check", rel(file)], `syntax: ${rel(file)}`);
}

const sourceFiles = await collectFiles(path.join(root, "src", "js"), (file) => file.endsWith(".js"));
const testJsFiles = await collectFiles(path.join(root, "tests"), (file) => file.endsWith(".js") || file.endsWith(".mjs"));
for (const file of sourceFiles.concat(testJsFiles)) {
  runCheck(file);
}

const unitTests = (await collectFiles(path.join(root, "tests"), (file) => file.endsWith(".test.js")))
  .map(rel);
for (const test of unitTests) {
  run([test], `unit: ${test}`);
}

if (runBrowser) {
  ["tests/phase4.browser-smoke.mjs", "tests/phase5.visual-smoke.mjs"].forEach((test) => {
    run([test], `browser: ${test}`);
  });
}

if (runVisual) {
  const visualArgs = ["tests/visual-regression.mjs"];
  if (updateVisual) visualArgs.push("--update");
  run(visualArgs, updateVisual ? "visual regression: update baselines" : "visual regression");
}

console.log("\nCareerBoost test runner passed.");
