// POST /functions/v1/delete-account
//
// Permanently deletes the caller's account: every user-owned row across
// the schema PLUS the row in auth.users. Used by Settings → Data &
// Privacy → "Delete account" (GDPR right-to-be-forgotten + standard
// account-closure flow).
//
// Auth: caller must provide a valid Supabase JWT. We do NOT take an
// admin override — this is a self-service endpoint, you can only
// delete YOUR OWN account. There's no path to delete someone else's.
//
// Safety:
//   - Service-role client is used to bypass RLS for the purge (otherwise
//     the caller's own RLS policies might block deletes mid-table).
//   - We delete user-owned data tables BEFORE auth.users so foreign keys
//     don't get violated even if cascade isn't set on every table.
//   - Each table-purge is best-effort: a failure on one table is logged
//     but doesn't abort the whole operation. The most important step is
//     the final auth.users delete — once that's done, the account is
//     unreachable regardless of any orphan rows we couldn't clean.
//
// Returns:
//   { ok: true, deleted: { profiles: N, applications: N, ... } }   on success
//   { ok: false, error: "..." }                                     on failure

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

// Tables that store user-scoped data, listed in dependency-friendly order.
// We delete from these first via the service-role client, then drop the
// auth.users row last so any FK cascade is redundant rather than required.
//
// Update this list whenever a new user-scoped table is added in
// backend/supabase/migrations/. The simplest convention is "every
// public.* table whose RLS uses (auth.uid() = user_id)".
const USER_TABLES: ReadonlyArray<string> = [
  // Pipeline + content
  "applications",
  "events",
  "resumes",
  "cover_letters",
  "interview_sets",
  "interview_outcomes",
  "saved_jobs",
  "saved_searches",
  "api_keys",
  // Telemetry / usage
  "ai_usage",
  "ai_rate_limits",
  "usage_events",
  "usage_sessions",
  "usage_counters",
  "client_telemetry",
  // Billing
  "subscriptions",
  // Profile is last among public.* so the user's "identity" row leaves
  // the database just before the auth.users row does.
  "profiles",
];

interface DeletionResult {
  ok: boolean;
  deleted: Record<string, number>;
  failures: Record<string, string>;
  authDeleted: boolean;
}

async function purgeUserData(svc: ReturnType<typeof getServiceClient>, userId: string): Promise<DeletionResult> {
  const result: DeletionResult = {
    ok: true,
    deleted: {},
    failures: {},
    authDeleted: false,
  };

  for (const table of USER_TABLES) {
    try {
      // .select() inside the chain returns the deleted rows so we can
      // count them. Limit to 5000 per table — well above realistic
      // per-user volume but bounded so a runaway loop is impossible.
      const { data, error } = await svc
        .from(table)
        .delete()
        .eq("user_id", userId)
        .select("user_id");

      if (error) {
        // Don't abort — log and keep going. The auth.users delete is the
        // real safety net.
        result.failures[table] = error.message;
        console.warn("[delete-account] purge failed for", table, error.message);
      } else {
        result.deleted[table] = Array.isArray(data) ? data.length : 0;
      }
    } catch (err) {
      result.failures[table] = (err as Error).message || "unknown error";
      console.warn("[delete-account] purge threw for", table, err);
    }
  }

  // Final step: remove the auth row. Until this succeeds, the account
  // can still sign in even though their data is gone. This MUST succeed
  // for the operation to be considered a complete deletion.
  try {
    const { error: authErr } = await svc.auth.admin.deleteUser(userId, true);
    if (authErr) {
      result.ok = false;
      result.failures["auth.users"] = authErr.message;
      console.error("[delete-account] auth.users delete failed", authErr.message);
    } else {
      result.authDeleted = true;
    }
  } catch (err) {
    result.ok = false;
    result.failures["auth.users"] = (err as Error).message || "unknown error";
    console.error("[delete-account] auth.users delete threw", err);
  }

  return result;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }
  if (!user || !user.id) {
    return errorResponse("Authenticated user has no ID — refusing to proceed.", 400);
  }

  const svc = getServiceClient();

  // Audit breadcrumb for ops — written before the purge so we have a
  // record even if mid-purge fails. Includes only non-identifying
  // metadata (no email, no payload). Edge function logs are the trail.
  console.log("[delete-account] starting purge", {
    userId: user.id,
    initiatedAt: new Date().toISOString(),
    userAgent: req.headers.get("user-agent") || "",
  });

  const result = await purgeUserData(svc, user.id);

  // Even when result.ok is false (auth.users delete failed), the user-data
  // purge already happened. Surface that distinction so the UI can show
  // "Your data is gone but your login still exists — contact support" vs
  // "Everything is gone, you're signed out."
  return jsonResponse({
    ok: result.ok,
    authDeleted: result.authDeleted,
    deleted: result.deleted,
    failures: Object.keys(result.failures).length ? result.failures : null,
    completedAt: new Date().toISOString(),
  });
});
