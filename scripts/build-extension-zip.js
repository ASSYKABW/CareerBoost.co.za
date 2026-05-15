#!/usr/bin/env node
// Packages extension/ into v2/careerboost-extension.zip so it can be
// served as a static download from the web app.
// Run: node scripts/build-extension-zip.js

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root  = path.resolve(__dirname, "..");
const src   = path.join(root, "extension");
const dest  = path.join(root, "v2", "careerboost-extension.zip");

if (!fs.existsSync(src)) {
  console.error("extension/ folder not found");
  process.exit(1);
}

if (fs.existsSync(dest)) fs.unlinkSync(dest);

// Use PowerShell on Windows, zip on Unix
if (process.platform === "win32") {
  execSync(
    `powershell -Command "Compress-Archive -Path '${src}\\*' -DestinationPath '${dest}'"`,
    { stdio: "inherit" }
  );
} else {
  execSync(`cd "${src}" && zip -r "${dest}" .`, { stdio: "inherit" });
}

const { size } = fs.statSync(dest);
console.log(`careerboost-extension.zip — ${(size / 1024).toFixed(1)} KB`);
