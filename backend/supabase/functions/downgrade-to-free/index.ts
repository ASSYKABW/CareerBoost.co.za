// POST /functions/v1/downgrade-to-free
//
// Self-service "switch to Free plan" endpoint. Used by the Settings →
// Billing & Plan page when the user wants to cancel but:
//   (a) PayStack has no subscription_code for them (test-mode quirk
//       where charge.success fires without subscription.create), OR
//   (b) Their PayStack portal call failed for some reason and they
//       just want OUT.
//
// What it does:
//   - Authenticates the caller via their JWT.
//   - If they have an active paystack_subscription_code, attempts to
//     disable it on PayStack's side first (best-effort, doesn't block
//     the local downgrade if PayStack rejects).
//   - Sets subscriptions.plan_id='free', status='canceled',
//     paystack_subscription_code=NULL, payment_processor=NULL.
//   - Returns { ok: true, downgraded: true }.
//
// Auth: signed-in users only. Operates on the caller's own row.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

const PAYSTACK_BASE = "https://api.paystack.co";

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

  const svc = getServiceClient();

  // Look up the current subscription state.
  const { data: subData, error: subErr } = await svc
    .from("subscriptions")
    .select("plan_id, status, payment_processor, paystack_subscription_code, paystack_customer_code")
    .eq("user_id", user.id)
    .maybeSingle();
  if (subErr) {
    return errorResponse("Couldn't read your subscription: " + subErr.message, 502);
  }

  // Best-effort: tell PayStack to disable the subscription if we have
  // a code AND a secret. Failures here don't block the local downgrade
  // — the user explicitly asked to leave, so we honor that locally.
  if (subData && subData.paystack_subscription_code) {
    const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (secret) {
      try {
        // PayStack requires the email-token from a separate fetch to
        // /subscription/:code/manage/link OR we can just call /subscription/disable
        // with the code + token. Simplest: disable directly via POST.
        // Docs: https://paystack.com/docs/api/subscription/#disable
        const dis = await fetch(PAYSTACK_BASE + "/subscription/disable", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + secret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code: subData.paystack_subscription_code,
            // Token is required by PayStack but can be the subscription
            // code itself for self-service cancellation via API. If this
            // fails, the local downgrade still proceeds.
            token: subData.paystack_subscription_code,
          }),
        });
        if (!dis.ok) {
          const t = await dis.text();
          console.warn("[downgrade-to-free] PayStack disable returned", dis.status, t.slice(0, 200));
        }
      } catch (err) {
        console.warn("[downgrade-to-free] PayStack disable threw:", (err as Error).message);
      }
    }
  }

  // Local downgrade — this is the source of truth.
  const { error: updErr } = await svc
    .from("subscriptions")
    .update({
      plan_id: "free",
      status: "canceled",
      cancel_at_period_end: false,
      canceled_at: new Date().toISOString(),
      paystack_subscription_code: null,
      // We leave paystack_customer_code intact so any past invoices
      // remain linkable to a customer record. payment_processor is
      // cleared so the next upgrade picks the current processor cleanly.
      payment_processor: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);
  if (updErr) {
    return errorResponse("Local downgrade failed: " + updErr.message, 502);
  }

  console.log("[downgrade-to-free] user", user.id, "switched to free");

  return jsonResponse({
    ok: true,
    downgraded: true,
    plan_id: "free",
    previousPlan: subData ? subData.plan_id : null,
  });
});
