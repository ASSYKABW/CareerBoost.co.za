// One-shot: log Playwright E2E happy-path as an admin_incident.
//
// Week 2 #5 from the production hardening list. Deferred from
// the Week 2 batch because the higher-impact items (Resend,
// CSP, perf, status page) shipped first. Logged here so it
// surfaces on the Health board until tackled.

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
      dedup_key: "qa:playwright-e2e",
      kind: "coverage-gap",
      severity: "info",
      status: "open",
      title: "Playwright E2E happy-path test not yet set up",
      body:
        "Week 2 #5 from the production hardening list. Deferred for the Week 2 batch.\n\n" +
        "Goal: one Playwright test that runs on every Vercel deploy and exercises the user-critical golden path:\n" +
        "  signup -> verify email -> save a job -> generate a resume\n" +
        "If the test fails, the Vercel build fails -> bad deploy never goes live.\n\n" +
        "How to ship:\n" +
        "  1. npm install --save-dev @playwright/test\n" +
        "  2. npx playwright install --with-deps chromium\n" +
        "  3. Create tests/e2e/happy-path.spec.js with the 4-step user flow\n" +
        "  4. Add npm script: \"test:e2e\": \"playwright test\"\n" +
        "  5. Add Vercel build hook OR GitHub Action that runs npm run test:e2e\n" +
        "     against the preview URL before promoting to production\n" +
        "  6. For email OTP step: use Mailosaur or Resend Inbound Email to capture\n" +
        "     the verify code automatically, OR seed a confirmed test user via\n" +
        "     auth.admin.createUser and skip the email step\n" +
        "  7. Resolve this incident\n\n" +
        "Estimated effort: 3h.\n\n" +
        "Trade-off: useful insurance against regression but not blocking launch. " +
        "Pre-launch, real-user testing catches more than automated bots can. " +
        "Worth the 3h after the first 10-20 paying users hit the product and the surface " +
        "of \"can't afford to break this\" features expands.",
      section: "operations",
      payload: {
        item_in_plan: "Week 2 #5",
        deferred_in_favor_of: ["Resend transactional", "AI failure spike detection", "CSP report-only", "Perf trim", "Status page"],
        estimated_effort_hours: 3,
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
