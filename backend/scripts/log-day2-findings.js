// Log all Day 2 testing findings to admin_incidents.
// One-shot script — run once after Day 2 testing is complete.

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

const FINDINGS = [
  {
    dedup_key: "ux:r5-queue-no-snooze",
    kind: "feature-deferred",
    severity: "info",
    title: "R5 AI Review Queue has no Snooze action (defer-an-item feature)",
    body:
      "Discovered during Day 2 Test 8.3. The queue currently supports: per-item 'Review' (routes to R4 preview) + 'Review all' bulk. No Snooze button to push an item to a later session. Not a bug — design choice to funnel all actions through R4 preview. If user feedback requests Snooze later, add it as a 3rd per-item action (Review / Snooze / Dismiss). Estimated effort: 90 min (state field + UI + dedupe-on-next-critique-run).",
    section: "operations",
    payload: { discoveredDuring: "Day 2 Test 8.3", recommendedAction: "defer-until-user-asks" }
  },
  {
    dedup_key: "ux:r5-queue-no-dismiss",
    kind: "feature-deferred",
    severity: "info",
    title: "R5 queue has no standalone Dismiss action",
    body:
      "Day 2 Test 8.2 showed each queue item only has a 'Review' button that opens the R4 preview. Dismissing a suggestion requires opening the preview then clicking Cancel. Quicker UX would be per-item Dismiss icon on the queue list. Estimated effort: 30 min. Low priority — current path works.",
    section: "operations",
    payload: { discoveredDuring: "Day 2 Test 8.2" }
  },
  {
    dedup_key: "ux:billing-meter-wording-confusing",
    kind: "ops-polish",
    severity: "info",
    title: "Billing meter wording 'of 1 used / 1 left' is confusing",
    body:
      "Day 2 Test 4.3 screenshot showed the Settings -> Billing usage meter rendering each quota as 'of 1 used' with '1 left'. Looks like used count isn't being displayed at all (always reads as 'of N used'). Should be '0 of 1 used | 1 left' or 'Used: 0 / 1' or 'Remaining: 1 of 1'. Estimated effort: 15 min in settings.billing.js.",
    section: "operations",
    payload: { file: "v2/src/js/modules/settings/settings.billing.js", discoveredDuring: "Day 2 Test 4.3" }
  },
  {
    dedup_key: "ux:admin-mobile-unpolished",
    kind: "ops-polish",
    severity: "info",
    title: "Admin UI not optimized for mobile (operator-side)",
    body:
      "Operator noted during Day 2 Test 2.6: admin console looks rough on phone (sidebar doesn't collapse, tables overflow, freshness chips wrap). Admin is operator-only so lower priority than user-facing mobile (which all passed Day 2 tests). Make sidebar collapsible + tables wrap properly. Estimated effort: 2 hours.",
    section: "operations",
    payload: { discoveredDuring: "Day 2 Test 2.6", recommendedAction: "defer-until-needed" }
  }
];

(async function () {
  for (const f of FINDINGS) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/admin_incidents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SVC,
        Authorization: `Bearer ${SVC}`,
        Prefer: "resolution=ignore-duplicates"
      },
      body: JSON.stringify({
        ...f,
        status: "open",
        payload: f.payload || {}
      })
    });
    const tag = res.status === 201 || res.status === 200 ? "✓" : (res.status === 409 ? "↺ (already logged)" : "✗");
    console.log(`${tag}  ${f.dedup_key}  (HTTP ${res.status})`);
  }
})();
