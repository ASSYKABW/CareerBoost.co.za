// Diagnose the get-entitlements 502 reported from the browser.
//
// Signs in as the existing load-test user (provisioned by
// scripts/load-test-quota-race.ts), gets a fresh user JWT, then makes
// EXACTLY the same POST that the browser makes — so any error response
// shows up as a real readable JSON body instead of the SDK's opaque
// "Edge Function returned a non-2xx status code".
//
// Also calls the get_user_entitlements RPC directly (bypassing the
// edge function) so we can tell whether the bug lives in the function
// layer or the SQL layer.
//
// Run:
//   cd backend
//   node scripts/diagnose-get-entitlements.js
//
// Requires SUPABASE_URL + SUPABASE_ANON_KEY in backend/.env (already
// there). Service-role key not needed for this diagnostic.

const fs = require("fs");
const path = require("path");

// --- env loader ------------------------------------------------------------

function loadEnv() {
  const p = path.resolve(__dirname, "..", ".env");
  const out = {};
  try {
    const text = fs.readFileSync(p, "utf8");
    text.split("\n").forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const eq = t.indexOf("=");
      if (eq <= 0) return;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    });
  } catch (_e) {}
  return out;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL;
const ANON_KEY = env.SUPABASE_ANON_KEY;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in backend/.env");
  process.exit(1);
}

// --- step 1: sign in as the load-test user ---------------------------------

const TEST_EMAIL = "loadtest+quota@careerboost.co.za";
const TEST_PASSWORD = "LoadTest!Quota-2026";

async function signIn() {
  console.log("→ step 1: sign in as", TEST_EMAIL);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
    },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    console.error("  ✗ signIn failed:", res.status, JSON.stringify(body, null, 2));
    console.error("");
    console.error("  Hint: the test user might not exist yet. Run:");
    console.error("    npm run test:quota-race:setup");
    console.error("  to provision it, then re-run this script.");
    process.exit(2);
  }
  console.log("  ✓ got access_token (", body.access_token.length, "chars )");
  console.log("    user_id:", body.user?.id);
  console.log("");
  return { token: body.access_token, userId: body.user?.id };
}

// --- step 2: call get-entitlements (the failing path) ---------------------

async function callEntitlementsFunction(token) {
  console.log("→ step 2: POST get-entitlements with user JWT");
  const url = `${SUPABASE_URL}/functions/v1/get-entitlements`;
  console.log("  url:", url);

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  const elapsed = Date.now() - start;

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  console.log("  HTTP status:", res.status, res.statusText, `(${elapsed}ms)`);
  console.log("  response headers:");
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase().startsWith("x-") || k === "content-type" || k === "server") {
      console.log("    ", k, "=", v);
    }
  }
  console.log("  response body:");
  console.log("    ", typeof body === "string" ? body : JSON.stringify(body, null, 4).split("\n").join("\n     "));
  console.log("");
  return { status: res.status, body, headers: res.headers };
}

// --- step 3: call the RPC directly (skip the edge function) ----------------

async function callRpcDirectly(token, userId) {
  console.log("→ step 3: POST get_user_entitlements RPC directly (bypass edge function)");
  const url = `${SUPABASE_URL}/rest/v1/rpc/get_user_entitlements`;
  console.log("  url:", url);

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ target_user_id: userId }),
  });
  const elapsed = Date.now() - start;

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  console.log("  HTTP status:", res.status, res.statusText, `(${elapsed}ms)`);
  console.log("  response body:");
  console.log("    ", typeof body === "string" ? body : JSON.stringify(body, null, 4).split("\n").join("\n     "));
  console.log("");
  return { status: res.status, body };
}

// --- run ------------------------------------------------------------------

(async function main() {
  console.log("Diagnose: get-entitlements 502\n");
  const { token, userId } = await signIn();
  const fn = await callEntitlementsFunction(token);
  const rpc = await callRpcDirectly(token, userId);

  console.log("─".repeat(60));
  console.log("VERDICT:");
  if (fn.status === 200 && rpc.status === 200) {
    console.log("  ✓ Both work. The 502 is transient — try again from the browser.");
    console.log("    Possibly the function had a cold-start spike when it was tested.");
  } else if (fn.status >= 500 && rpc.status === 200) {
    console.log("  ✗ Edge function fails but RPC works.");
    console.log("    Bug is in the edge function (get-entitlements/index.ts or _shared/).");
    console.log("    Look at the response body above for the actual error.");
  } else if (fn.status >= 500 && rpc.status >= 400) {
    console.log("  ✗ Both layers fail. Bug is in the SQL RPC (get_user_entitlements).");
    console.log("    Look at the RPC response body above for the Postgres error.");
  } else if (fn.status >= 400 && fn.status < 500) {
    console.log("  ✗ Edge function returns 4xx. Probably an auth/validation issue.");
    console.log("    Look at the function response body above.");
  } else {
    console.log("  ? Unexpected combination. Inspect both responses above.");
  }
})().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
