// POST /functions/v1/stripe-portal
// Body: (none)
// Auth: authenticated user.
//
// Creates a Stripe Billing Portal session and returns { url }. The
// portal lets users update card, change plan, cancel, view invoices
// — without us having to build any of that UI.
//
// Env required:
//   STRIPE_SECRET_KEY
//   SITE_URL                 redirect target after portal session
//
// The user must have a stripe_customer_id in subscriptions (set by
// stripe-checkout / webhook). Without one we return 400 with a hint
// to subscribe first.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

Deno.serve(withCors(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try { user = await getAuthedUser(req); }
  catch (err) { return errorResponse((err as Error).message || "Sign in required", 401); }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return errorResponse("STRIPE_SECRET_KEY not set", 503);
  const siteUrl = Deno.env.get("SITE_URL") || "https://app.example.com";

  const svc = getServiceClient();
  const { data: sub } = await svc
    .from("subscriptions")
    .select("stripe_customer_id, plan_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const customerId = sub?.stripe_customer_id;
  if (!customerId) {
    return errorResponse(
      "No Stripe customer yet. Subscribe to a paid plan first via the pricing page.",
      400,
      { needsCheckout: true }
    );
  }

  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("return_url", siteUrl + "/#/settings?section=billing");

  const stripeRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: params.toString(),
  });
  const json = await stripeRes.json();
  if (!stripeRes.ok || !json.url) {
    return errorResponse("Stripe portal error: " + (json?.error?.message || "unknown"), 502);
  }
  return jsonResponse({ ok: true, url: json.url });
}));
