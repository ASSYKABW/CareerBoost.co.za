// POST /functions/v1/paystack-portal
//
// Returns the PayStack customer-portal management link for the caller's
// current subscription. The user is sent there to update their card,
// view invoices, or cancel.
//
// Body: (empty — derived from JWT)
//
// Response:
//   { ok: true, url: "https://paystack.com/manage/subscriptions/SUB_xxxxx/..." }
//
// PayStack endpoint used:
//   GET /subscription/:subscription_code/manage/link
//   → returns a short-lived signed URL the user can open.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

const PAYSTACK_BASE = "https://api.paystack.co";

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

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) return errorResponse("PAYSTACK_SECRET_KEY not configured.", 503);

  // Look up the user's PayStack subscription code.
  const svc = getServiceClient();
  const { data: sub, error: subErr } = await svc
    .from("subscriptions")
    .select("paystack_subscription_code, payment_processor, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (subErr) {
    return errorResponse("Couldn't read your subscription: " + subErr.message, 502);
  }
  if (!sub || !sub.paystack_subscription_code) {
    return errorResponse(
      "No active PayStack subscription found. If you upgraded via Stripe, use the Stripe portal instead.",
      404,
    );
  }
  if (sub.payment_processor !== "paystack") {
    return errorResponse(
      "Your subscription is billed by " + (sub.payment_processor || "another provider") + ", not PayStack.",
      400,
    );
  }

  // Ask PayStack for the management link.
  let psRes;
  try {
    psRes = await fetch(
      PAYSTACK_BASE + "/subscription/" + encodeURIComponent(sub.paystack_subscription_code) + "/manage/link",
      { headers: { Authorization: "Bearer " + secret } },
    );
  } catch (err) {
    return errorResponse("PayStack unreachable: " + (err as Error).message, 502);
  }
  if (!psRes.ok) {
    const txt = await psRes.text();
    return errorResponse(
      "PayStack portal link request failed (HTTP " + psRes.status + "): " + txt.slice(0, 300),
      502,
    );
  }
  const psJson = await psRes.json() as { status: boolean; message: string; data?: { link: string } };
  if (!psJson.status || !psJson.data?.link) {
    return errorResponse("PayStack returned no link: " + (psJson.message || "unknown"), 502);
  }

  return jsonResponse({ ok: true, url: psJson.data.link });
}));
