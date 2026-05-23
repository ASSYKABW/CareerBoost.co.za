// One-shot: log the Font Awesome subset opportunity as an admin_incident.
//
// Week 2 #4 perf delivered the Google Fonts trim + preload but
// deferred the Font Awesome subset because doing it right requires
// Fontello/IcoMoon tooling (selecting the 230 icons we use, generating
// a custom woff2 + CSS). That's a separate ~2hr sit-down. Logged here
// so the operator sees it on the Health board until done.

const fs = require("fs");
const path = require("path");

function loadEnv() {
  const text = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
  const out = {};
  text.split("\n").forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq <= 0) return;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  });
  return out;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL;
const SVC = env.SUPABASE_SERVICE_ROLE_KEY;

(async function () {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admin_incidents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      Prefer: "resolution=ignore-duplicates",
    },
    body: JSON.stringify({
      dedup_key: "perf:fa-subset",
      kind: "tech-debt",
      severity: "info",
      status: "open",
      title: "Font Awesome subset deferred — ~250KB win still on the table",
      body:
        "Week 2 #4 perf shipped the Google Fonts trim (Space Grotesk dropped, Inter trimmed 5 weights → 3, JetBrains Mono trimmed 2 → 1) for ~120KB savings.\n\n" +
        "Font Awesome subset is the bigger remaining win: we use 230 unique icons out of FA's 2,000+. Self-hosting only those 230 cuts ~250KB off first paint (current all.min.css = ~30KB CSS + 3 webfonts ≈ 310KB total; a 230-icon subset would be ~30KB CSS + 30KB woff2 ≈ 60KB).\n\n" +
        "How to ship:\n" +
        "  1. Visit fontello.com (or icomoon.io)\n" +
        "  2. Search/import each of the 230 icons used (see audit script `npm run audit:fa-usage`)\n" +
        "  3. Download the bundle — extract CSS + woff2\n" +
        "  4. Drop into v2/src/styles/fonts/ + v2/src/styles/icons/\n" +
        "  5. Replace the cdnjs <link> in index.html with the self-hosted one\n" +
        "  6. Resolve this incident\n\n" +
        "Estimated effort: 1.5h.",
      section: "operations",
      payload: {
        icons_in_use: 230,
        current_load_kb: 310,
        target_load_kb: 60,
        estimated_savings_kb: 250,
        tooling: "fontello.com OR icomoon.io",
        estimated_effort_hours: 1.5,
        detected_at: new Date().toISOString(),
      },
    }),
  });
  if (res.status === 201 || res.status === 200 || res.status === 409) {
    console.log("✓ Logged (status " + res.status + ")");
  } else {
    console.log("✗ Failed:", res.status, await res.text());
  }
})();
