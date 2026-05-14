// POST /functions/v1/get-entitlements
// Body: (none) — reads caller from JWT
// Auth: authenticated user.
//
// Thin wrapper around the SECURITY DEFINER RPC public.get_user_entitlements
// for the frontend entitlements service. Returns the merged plan +
// limits + current usage + remaining quota in one JSON document.
//
// Why a function instead of letting the frontend hit the RPC directly?
//   1. CORS — the function uses our standard cors.ts allowlist.
//   2. Single endpoint shape — frontend doesn't need to know about
//      Postgres RPC vs Edge Function vs direct query; entitlements is
//      always at the same URL.
//   3. Future room to enrich (feature-flag overrides, A/B cohorts, etc.)
//      without changing the SQL.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  let user;
  try { user = await getAuthedUser(req); }
  catch (err) { return errorResponse((err as Error).message || "Sign in required", 401); }

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("get_user_entitlements", { target_user_id: user.id });
  if (error) return errorResponse("Entitlements RPC failed: " + error.message, 502);

  return jsonResponse({ ok: true, entitlements: data });
});
