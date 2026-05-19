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

// Pre-existing bug fix (May 2026): the RPC `get_user_entitlements` uses
// `auth.uid()` to identify the caller, but the previous version of this
// function used a service-role client to invoke it — service-role calls
// have `auth.uid() = NULL`, so the RPC's "authentication required" guard
// always tripped and the function 502'd with
// "Entitlements RPC failed: authentication required".
//
// The frontend soft-failed to FREE_FALLBACK limits, which masked this
// for months. Diagnosed via scripts/diagnose-get-entitlements.js.
//
// Fix: forward the caller's user JWT to a user-scoped client so
// auth.uid() resolves to their actual user ID inside the RPC.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  let user;
  try { user = await getAuthedUser(req); }
  catch (err) { return errorResponse((err as Error).message || "Sign in required", 401); }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnon) {
    return errorResponse("Server misconfigured: SUPABASE_URL/ANON_KEY missing.", 500);
  }

  // User-scoped client — forwards the caller's JWT so auth.uid() inside
  // the RPC returns their ID. RPC is SECURITY DEFINER so it still runs
  // with elevated permissions to read subscriptions/usage_counters/etc.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient.rpc("get_user_entitlements", { target_user_id: user.id });
  if (error) return errorResponse("Entitlements RPC failed: " + error.message, 502);

  return jsonResponse({ ok: true, entitlements: data });
});
