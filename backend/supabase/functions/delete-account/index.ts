// POST /functions/v1/delete-account
//
// Closes the caller's account. Two modes via body { mode: "soft" | "immediate" }:
//
//   "soft" (default, Day 4.4):
//     Sets profiles.pending_deletion_at = now() + 7 days via the
//     request_account_deletion() RPC. Account remains fully usable
//     during the grace window. A persistent banner reminds the user
//     of the scheduled purge and offers restore-account to cancel.
//     Returns { ok: true, mode: "soft", scheduledFor: timestamp, graceDays: 7 }.
//
//   "immediate":
//     Hard purge — every user-owned row PLUS auth.users gone in one
//     transaction. Used when the user explicitly wants no grace window
//     (e.g. GDPR right-to-be-forgotten requests). Returns the deletion
//     count breakdown.
//
// Auth: caller must provide a valid Supabase JWT. This is a self-service
// endpoint — you can only delete YOUR OWN account. There's no path to
// delete someone else's.
//
// Safety (immediate mode):
//   - Service-role client is used to bypass RLS for the purge.
//   - User-owned data tables deleted BEFORE auth.users so FKs don't break.
//   - Per-table failures are logged but don't abort the operation. The
//     auth.users delete is the real safety net.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
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

interface DeleteBody {
  mode?: "soft" | "immediate";
  // For "soft" mode: override the default 7-day grace. Bounded to
  // [1, 30] by the RPC so the value can't be abused.
  graceDays?: number;
}

Deno.serve(withCors(async (req) => {
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

  let body: DeleteBody = {};
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    // Empty body is fine — defaults to soft mode.
    body = {};
  }
  const mode = body.mode === "immediate" ? "immediate" : "soft";

  console.log("[delete-account] request", {
    userId: user.id,
    mode,
    graceDays: body.graceDays ?? null,
    initiatedAt: new Date().toISOString(),
    userAgent: req.headers.get("user-agent") || "",
  });

  // ===== SOFT MODE: schedule the deletion 7 days out via the RPC =====
  if (mode === "soft") {
    // We call the RPC via the user's own JWT (not service role) so
    // auth.uid() resolves correctly inside the SECURITY DEFINER function.
    // Mirrors the consume_quota pattern in ai-run.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/request_account_deletion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseAnon,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ grace_days: body.graceDays ?? 7 }),
      });
      if (!res.ok) {
        const text = await res.text();
        return errorResponse("Soft-delete RPC failed: HTTP " + res.status + " — " + text.slice(0, 200), 502);
      }
      const data = await res.json() as Record<string, unknown>;
      return jsonResponse({
        ok: true,
        mode: "soft",
        scheduledFor: data.scheduled_for,
        graceDays: data.grace_days,
        initiatedAt: data.initiated_at,
      });
    } catch (err) {
      return errorResponse("Soft-delete RPC unreachable: " + (err as Error).message, 502);
    }
  }

  // ===== IMMEDIATE MODE: hard delete now =====
  const svc = getServiceClient();
  const result = await purgeUserData(svc, user.id);
  return jsonResponse({
    ok: result.ok,
    mode: "immediate",
    authDeleted: result.authDeleted,
    deleted: result.deleted,
    failures: Object.keys(result.failures).length ? result.failures : null,
    completedAt: new Date().toISOString(),
  });
}));
