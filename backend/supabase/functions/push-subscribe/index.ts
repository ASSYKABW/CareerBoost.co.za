// POST /functions/v1/push-subscribe
//
// Stores or removes a PWA Web Push subscription for the authenticated user.
//
// Body:
//   { action: "subscribe", subscription: { endpoint, keys: { p256dh, auth } } }
//   { action: "unsubscribe", endpoint: string }
//   { action: "status" }   → { ok, count }   (how many devices this user has)
//
// The browser-level notification permission grant is the consent; this just
// persists the subscription so the sender can reach the device.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

interface PushSub {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse((err as Error).message || "Sign in required.", 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || "subscribe");
  const svc = getServiceClient();

  if (action === "status") {
    const { count } = await svc
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    return jsonResponse({ ok: true, count: count ?? 0 });
  }

  if (action === "unsubscribe") {
    const endpoint = String(body.endpoint || "").trim();
    if (!endpoint) return errorResponse("endpoint is required.", 400);
    // Scope the delete to the caller so one user can't remove another's row.
    const { error } = await svc
      .from("push_subscriptions")
      .delete()
      .eq("user_id", user.id)
      .eq("endpoint", endpoint);
    if (error) return errorResponse("Unsubscribe failed: " + error.message, 502);
    return jsonResponse({ ok: true });
  }

  // subscribe (default)
  const sub = (body.subscription || {}) as PushSub;
  const endpoint = String(sub.endpoint || "").trim();
  const p256dh = String(sub.keys?.p256dh || "").trim();
  const auth = String(sub.keys?.auth || "").trim();
  if (!endpoint || !p256dh || !auth) {
    return errorResponse("subscription with endpoint + keys.p256dh + keys.auth is required.", 400);
  }
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) {
    return errorResponse("Invalid endpoint.", 400);
  }

  const now = new Date().toISOString();
  // Upsert by endpoint: a device re-subscribing (or moving between users)
  // updates the existing row rather than duplicating.
  const { error } = await svc
    .from("push_subscriptions")
    .upsert({
      user_id: user.id,
      endpoint,
      p256dh,
      auth,
      user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
      failure_count: 0,
      last_active_at: now,
    }, { onConflict: "endpoint" });
  if (error) return errorResponse("Could not save subscription: " + error.message, 502);

  return jsonResponse({ ok: true });
}));
