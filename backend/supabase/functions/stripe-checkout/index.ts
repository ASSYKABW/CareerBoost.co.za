// POST /functions/v1/stripe-checkout
// Body: { planId: "plus" | "pro" | "career", interval: "monthly" | "annual" }
// Auth: authenticated user (uses caller's JWT to identify them).
//
// Creates a Stripe Checkout Session for the requested plan and returns
// { url } to redirect the browser to. The caller's user_id is set as
// the Stripe customer's metadata.cb_user_id so the webhook can match
// the resulting subscription back to the Supabase user.
//
// Env required (set with: supabase secrets set --env-file ./.env):
//   STRIPE_SECRET_KEY            sk_live_... or sk_test_...
//   STRIPE_PRICE_PLUS_MONTHLY    price_...
//   STRIPE_PRICE_PLUS_ANNUAL     price_...
//   STRIPE_PRICE_PRO_MONTHLY     price_...
//   STRIPE_PRICE_PRO_ANNUAL      price_...
//   STRIPE_PRICE_CAREER_MONTHLY  price_...
//   STRIPE_PRICE_CAREER_ANNUAL   price_...
//   SITE_URL                     https://your-domain.com   (cors + success url)

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

interface Body { planId?: string; interval?: string; }

const PRICE_MAP: Record<string, Record<string, string | undefined>> = {
  plus:   { monthly: "STRIPE_PRICE_PLUS_MONTHLY",   annual: "STRIPE_PRICE_PLUS_ANNUAL" },
  pro:    { monthly: "STRIPE_PRICE_PRO_MONTHLY",    annual: "STRIPE_PRICE_PRO_ANNUAL" },
  career: { monthly: "STRIPE_PRICE_CAREER_MONTHLY", annual: "STRIPE_PRICE_CAREER_ANNUAL" },
};

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try { user = await getAuthedUser(req); }
  catch (err) { return errorResponse((err as Error).message || "Sign in required", 401); }

  let body: Body = {};
  try { body = await req.json(); } catch { body = {}; }
  const planId = String(body.planId || "").toLowerCase();
  const interval = body.interval === "annual" ? "annual" : "monthly";

  const priceEnvVar = PRICE_MAP[planId]?.[interval];
  if (!priceEnvVar) {
    return errorResponse("Unknown plan or interval. Valid plans: plus, pro, career.", 400);
  }
  const priceId = Deno.env.get(priceEnvVar);
  if (!priceId) {
    return errorResponse(
      "Stripe price not configured. Set " + priceEnvVar + " on the function with: supabase secrets set " + priceEnvVar + "=price_...",
      503
    );
  }
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return errorResponse("STRIPE_SECRET_KEY is not set on the function.", 503);
  }
  const siteUrl = Deno.env.get("SITE_URL") || "https://app.example.com";

  // Look up existing Stripe customer (in case the user already
  // checked out before and we have a customer id stored).
  const svc = getServiceClient();
  const { data: existing } = await svc
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const existingCustomerId = existing?.stripe_customer_id || null;

  // Build the Checkout Session via Stripe REST.
  // We use form-encoded body (Stripe's native format) so we don't need
  // a Stripe SDK in Deno — keeps the bundle small.
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", siteUrl + "/#/settings?section=billing&checkout=success");
  params.set("cancel_url", siteUrl + "/#/settings?section=billing&checkout=cancel");
  params.set("allow_promotion_codes", "true");
  params.set("billing_address_collection", "auto");
  params.set("client_reference_id", user.id);
  // metadata on the SUBSCRIPTION carries our user_id so the webhook
  // can always match back without depending on customer lookup.
  params.set("subscription_data[metadata][cb_user_id]", user.id);
  params.set("metadata[cb_user_id]", user.id);
  if (existingCustomerId) {
    params.set("customer", existingCustomerId);
  } else {
    params.set("customer_email", user.email || "");
    params.set("customer_creation", "always");
  }

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: params.toString(),
  });
  const stripeJson = await stripeRes.json();
  if (!stripeRes.ok) {
    const msg = stripeJson?.error?.message || "Stripe API error.";
    return errorResponse("Stripe: " + msg, 502);
  }
  if (!stripeJson.url) {
    return errorResponse("Stripe returned no checkout URL.", 502);
  }

  return jsonResponse({ ok: true, url: stripeJson.url, sessionId: stripeJson.id });
});
