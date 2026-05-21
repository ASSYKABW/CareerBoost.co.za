// POST /functions/v1/restore-account
//
// Day 4.4 — Cancels a pending soft-delete (set by delete-account in
// "soft" mode). Calls the cancel_account_deletion() RPC via the user's
// own JWT so auth.uid() resolves correctly. Idempotent — calling when
// no deletion is pending still returns ok.
//
// Auth: caller must provide a valid Supabase JWT. Self-service only.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/cancel_account_deletion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnon,
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    if (!res.ok) {
      const text = await res.text();
      return errorResponse("Cancel RPC failed: HTTP " + res.status + " — " + text.slice(0, 200), 502);
    }
    const data = await res.json() as Record<string, unknown>;
    console.log("[restore-account] cancelled pending deletion", {
      userId: user.id,
      restoredAt: data.restored_at,
    });
    return jsonResponse({
      ok: true,
      restored: true,
      restoredAt: data.restored_at,
    });
  } catch (err) {
    return errorResponse("Cancel RPC unreachable: " + (err as Error).message, 502);
  }
});
