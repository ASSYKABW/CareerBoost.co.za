// GET /functions/v1/health
//
// Public health-check endpoint for uptime monitors (Better Stack,
// UptimeRobot, etc.). Returns 200 OK with basic status info when the
// edge function runtime + database are reachable; non-2xx otherwise
// so the monitor can flag the outage.
//
// What we check:
//   - Edge function runtime is alive (the fact that this code runs)
//   - Database can be reached (a trivial SELECT 1 against Postgres)
//
// Deliberately minimal. We DON'T check optional services (Stripe,
// PayStack, AI providers) because a transient blip there shouldn't
// cause the whole status page to red — those have their own monitors.
//
// Response shape:
//   { ok: true, ts: "2026-05-22T...Z", db: "ok" }      — healthy
//   { ok: false, ts: "...", db: "fail", error: "..." } — degraded
//
// No auth required. Safe to expose publicly.

import { handleOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  // Accept GET (uptime monitors) + HEAD (cheaper polling).
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const ts = new Date().toISOString();

  // Cheap DB ping — a trivial select to confirm we can round-trip
  // through Postgres. Times out fast so a stuck DB doesn't keep the
  // function hanging until the platform-level timeout (which would
  // look UP to the monitor instead of DOWN).
  let dbStatus = "ok";
  let dbError = "";
  try {
    const svc = getServiceClient();
    // Race the query against a 4s timeout. If the query is slow,
    // we report degraded rather than wait the full 60s default.
    const queryPromise = svc.rpc("get_user_entitlements", { target_user_id: "00000000-0000-0000-0000-000000000000" });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("DB timeout 4s")), 4000)
    );
    const { error } = await Promise.race([queryPromise, timeoutPromise]) as { error?: { message: string } };
    // We expect this RPC to fail (target user doesn't exist + RLS
    // forbidden), but any RESPONSE — error or success — means the DB
    // is reachable. We're testing connectivity, not data correctness.
    if (error) {
      // Some error messages indicate connectivity is fine; others
      // indicate real DB issues. "authentication required" / "forbidden"
      // mean DB is up but auth.uid() is null — that's fine for us.
      const msg = (error.message || "").toLowerCase();
      const isExpectedAuthError = /authentication|forbidden|permission/.test(msg);
      if (!isExpectedAuthError) {
        dbStatus = "fail";
        dbError = error.message;
      }
    }
  } catch (err) {
    dbStatus = "fail";
    dbError = (err as Error).message || "unknown";
  }

  const ok = dbStatus === "ok";
  const body = JSON.stringify({
    ok,
    ts,
    db: dbStatus,
    ...(dbError ? { error: dbError } : {}),
  });

  return new Response(req.method === "HEAD" ? null : body, {
    status: ok ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      // Cors so a JS client could fetch it too (rarely needed, but cheap).
      "Access-Control-Allow-Origin": "*",
    },
  });
});
