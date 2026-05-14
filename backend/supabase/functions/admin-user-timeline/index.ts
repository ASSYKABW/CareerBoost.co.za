// POST /functions/v1/admin-user-timeline
// Body: { userId: uuid }
// Auth: admin role only (via getAuthedAdmin).
//
// Returns the full per-user timeline for the admin Users board drill-down.
// Wraps the admin_user_timeline SECURITY DEFINER RPC introduced in
// migration 0014. The RPC also performs an admin role check — this
// function adds the standard cors/auth scaffolding and short-circuits
// non-admin callers before even hitting Postgres.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

interface Body { userId?: string }

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const userId = String(body.userId || "").trim();
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return errorResponse("userId is required and must be a uuid.", 400);
  }

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("admin_user_timeline", { target_user_id: userId });
  if (error) {
    return errorResponse("Timeline read failed: " + error.message, 502);
  }
  if (!data) {
    return errorResponse("No timeline for user " + userId, 404);
  }

  return jsonResponse({
    ok: true,
    timeline: data,
  });
});
