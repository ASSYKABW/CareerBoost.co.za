// P2: Load test for the atomic quota path.
//
// Why: the consume_quota RPC (migration 0016) uses `for update` row-level
// locking to prevent two parallel AI requests from both consuming the
// last unit of a user's quota. This test verifies the lock actually
// holds under contention — fires N concurrent calls and asserts that
// EXACTLY the expected number are allowed (no over-consumption, no
// double-spend).
//
// Run (from backend/):
//   npm run test:quota-race:setup     # one-time test user provision
//   npm run test:quota-race            # the race + assertions
//   npm run test:quota-race:teardown  # delete the test user
//
// Required env vars — checked in this order:
//   1. Process env (Powershell `$env:SUPABASE_URL = "..."` or bash export)
//   2. backend/.env file (auto-loaded if shell env is unset)
//
//   SUPABASE_URL                  https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     service role key (for user provisioning)
//   SUPABASE_ANON_KEY             anon key (for the user JWT path)
//
// Get the values from Supabase Dashboard → Project Settings → API.
// Paste them into backend/.env as KEY=value (no quotes needed) and
// re-run. The script reads .env automatically — no shell export needed.
//
// Cost note: each run consumes quota on a real DB. Safe because the
// test user is isolated. Never run against a real user account.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Auto-load backend/.env if the keys aren't in process env. Saves the
// operator from having to remember the PowerShell vs bash export
// syntax. We parse manually (no dep) — comments, blank lines, quoted
// values all handled. If you ALSO have them in shell env, those win.
async function loadDotenv(): Promise<Record<string, string>> {
  const path = new URL("../.env", import.meta.url);
  try {
    const text = await Deno.readTextFile(path);
    const out: Record<string, string> = {};
    text.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip wrapping quotes if present.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    });
    return out;
  } catch {
    return {};
  }
}

const dotenv = await loadDotenv();

function reqEnv(name: string): string {
  const v = Deno.env.get(name) || dotenv[name];
  if (!v || v.startsWith("<") /* placeholder like "<from dashboard>" */) {
    console.error(`✗ Missing or placeholder value for ${name}.`);
    console.error("");
    console.error("Need these three in backend/.env (or in your shell env):");
    console.error("  SUPABASE_URL=https://kddffkhwpbngiupfmcse.supabase.co");
    console.error("  SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...   (Project Settings → API → service_role secret)");
    console.error("  SUPABASE_ANON_KEY=eyJhbGc...           (Project Settings → API → anon public)");
    console.error("");
    console.error("Get them at: https://supabase.com/dashboard/project/kddffkhwpbngiupfmcse/settings/api");
    Deno.exit(1);
  }
  return v;
}

const SUPABASE_URL = reqEnv("SUPABASE_URL");
const SERVICE_KEY = reqEnv("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = reqEnv("SUPABASE_ANON_KEY");

const TEST_USER_EMAIL = "loadtest+quota@careerboost.co.za";
const TEST_USER_PASSWORD = "LoadTest!Quota-2026";
const QUOTA_KEY = "ai_resumes";              // free plan = 1/month
const RACE_CONCURRENCY = 10;                  // 10 concurrent calls
const EXPECTED_ALLOWED = 1;                   // only 1 should succeed at limit=1

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function findUser(): Promise<string | null> {
  // listUsers is paginated; for our single-test user just scan page 1.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error("listUsers: " + error.message);
  const hit = (data?.users || []).find((u) => u.email === TEST_USER_EMAIL);
  return hit ? hit.id : null;
}

async function setup() {
  console.log("→ setup: provisioning test user", TEST_USER_EMAIL);
  let userId = await findUser();
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error("createUser: " + error.message);
    userId = data?.user?.id || null;
    if (!userId) throw new Error("createUser returned no id");
    console.log("  created user", userId);
  } else {
    console.log("  found existing user", userId);
  }

  // Force the subscription to 'free' plan + zero out the counters so
  // we start each race from a clean limit=1, used=0 state.
  await admin.from("subscriptions").upsert(
    { user_id: userId, plan_id: "free", status: "active", updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  await admin.from("usage_counters").upsert(
    {
      user_id: userId,
      ai_resumes: 0,
      ai_covers: 0,
      ai_mocks: 0,
      ai_research: 0,
      ai_question_banks: 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  console.log("  reset plan=free + counters=0");
  console.log("✓ setup complete\n");
  return userId;
}

async function teardown() {
  console.log("→ teardown: removing test user");
  const userId = await findUser();
  if (!userId) {
    console.log("  no test user found, nothing to clean");
    return;
  }
  // delete cascades subscriptions, usage_counters, etc. via FK on delete cascade.
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error("deleteUser: " + error.message);
  console.log("✓ teardown complete\n");
}

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

async function signInAsTestUser(): Promise<string> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await userClient.auth.signInWithPassword({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  });
  if (error) throw new Error("signInWithPassword: " + error.message);
  const token = data?.session?.access_token;
  if (!token) throw new Error("signIn returned no access_token");
  return token;
}

async function callConsumeQuota(jwt: string): Promise<{ allowed: boolean; raw: unknown }> {
  // We call the RPC directly via PostgREST so each request is a fresh
  // HTTP call — that's the actual concurrency surface we care about.
  // Using a single supabase-js client would multiplex over one HTTP/2
  // connection which is fine but harder to reason about.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_quota`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY!,
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify({ quota_key: QUOTA_KEY, amount: 1 }),
  });
  const raw = await res.json();
  return { allowed: !!raw?.allowed, raw };
}

async function run() {
  // Re-run setup to reset the counter to 0 before each race.
  const userId = await setup();

  console.log(`→ race: firing ${RACE_CONCURRENCY} concurrent consume_quota("${QUOTA_KEY}") calls`);
  console.log(`  expected: exactly ${EXPECTED_ALLOWED} allowed=true (limit for free plan)`);

  const jwt = await signInAsTestUser();
  const t0 = Date.now();

  // Fire them all without awaiting in sequence — Promise.allSettled
  // collects results without short-circuiting on any single error.
  const results = await Promise.allSettled(
    Array.from({ length: RACE_CONCURRENCY }, () => callConsumeQuota(jwt))
  );

  const elapsed = Date.now() - t0;
  console.log(`  ${RACE_CONCURRENCY} requests completed in ${elapsed}ms (${(elapsed / RACE_CONCURRENCY).toFixed(1)}ms avg)\n`);

  let allowed = 0;
  let denied = 0;
  let errored = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errored += 1;
      console.log(`  [${i}] ERROR  ${r.reason}`);
      return;
    }
    const { allowed: ok, raw } = r.value;
    if (ok) {
      allowed += 1;
      console.log(`  [${i}] ALLOW  used=${(raw as any).used}/${(raw as any).limit}`);
    } else {
      denied += 1;
      const reason = (raw as any).reason || "denied";
      console.log(`  [${i}] DENY   ${reason}  used=${(raw as any).used}/${(raw as any).limit}`);
    }
  });

  console.log("");
  console.log(`Result: allowed=${allowed}  denied=${denied}  errored=${errored}`);

  // Verify the final counter matches the allowed count — if the lock
  // didn't hold we'd see used > 1 even though only 1 was reported allowed.
  const { data: counterRow } = await admin
    .from("usage_counters")
    .select("ai_resumes")
    .eq("user_id", userId)
    .single();
  const finalCount = counterRow?.ai_resumes ?? -1;
  console.log(`Final counter ai_resumes = ${finalCount}`);

  // Assertions.
  const issues: string[] = [];
  if (allowed !== EXPECTED_ALLOWED) {
    issues.push(`FAIL: expected ${EXPECTED_ALLOWED} allowed, got ${allowed} — lock NOT holding`);
  }
  if (finalCount !== allowed) {
    issues.push(`FAIL: counter (${finalCount}) doesn't match allowed count (${allowed})`);
  }
  if (errored > 0) {
    issues.push(`WARN: ${errored} requests errored — network or auth issue, not a lock issue`);
  }
  if (issues.length === 0) {
    console.log("\n✓ PASS — atomic lock held: exactly 1 succeeded, counter matches.\n");
    Deno.exit(0);
  } else {
    console.log("");
    issues.forEach((m) => console.log("✗ " + m));
    console.log("");
    Deno.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

const cmd = (Deno.args[0] || "run").toLowerCase();
try {
  if (cmd === "setup") {
    await setup();
  } else if (cmd === "teardown") {
    await teardown();
  } else if (cmd === "run") {
    await run();
  } else {
    console.error(`Unknown command: ${cmd}. Use one of: setup, run, teardown.`);
    Deno.exit(2);
  }
} catch (err) {
  console.error("FATAL:", (err as Error).message);
  Deno.exit(1);
}
