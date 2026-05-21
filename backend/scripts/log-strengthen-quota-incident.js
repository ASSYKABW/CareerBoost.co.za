// One-shot: log the strengthen-bullet quota gap to admin_incidents.
// Discovered during Day 2 testing — feature works perfectly (real AI,
// great variety) but isn't metered, which is a billing leak.

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
      dedup_key: "billing:strengthen-bullet-unmetered",
      kind: "billing-leak",
      severity: "warning",
      status: "open",
      title: "strengthen-bullet AI skill bypasses quota system (billing leak)",
      body:
        "Discovered during Day 2 Test 4.3. The Strengthen action fires 3 parallel Claude Sonnet calls (one per variant: TIGHT/ACTION-FIRST/SCOPE-LED) but is NOT registered in the quota meter. Settings → Billing shows resume_tailorings, cover_letters, mock_interviews, company_research, question_banks — no entry for bullet rewrites.\n\nImpact: a free-tier user can burn unlimited API spend by clicking Strengthen repeatedly. At scale this is a real cost leak.\n\nFix options:\n  (a) Add ai_bullets quota key to plan_catalog limits (free: 10, paid: 50/250) and call consume_quota('ai_bullets') before each Strengthen request.\n  (b) Charge against ai_resumes since strengthen IS a resume-improvement action — adjusts ratio: free 1 resume = 3 strengthen calls.\n  (c) Treat as unlimited but cache aggressively (per-input-hash) so repeat calls are free.\n\nRecommended: (a) — proper accounting + clear UX in the meter. Add the quota key, gate the bullet-strengthen skill behind consume_quota, surface in the user-side meter.\n\nEstimated effort: 1.5 hours.",
      section: "operations",
      payload: {
        skill: "bullet-strengthen",
        callsPerInvocation: 3,
        provider: "claude-sonnet",
        currentQuota: null,
        recommendedQuotaKey: "ai_bullets",
        recommendedFreeLimit: 10,
        detectedAt: new Date().toISOString(),
        detectedDuring: "Day 2 Test 4.3",
        estimatedEffort: "1.5 hours",
      },
    }),
  });
  if (res.status === 201 || res.status === 200 || res.status === 409) {
    console.log("✓ Logged (status " + res.status + ")");
  } else {
    console.log("✗ Failed:", res.status, await res.text());
  }
})();
