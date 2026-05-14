// POST /functions/v1/stripe-webhook
// Stripe webhook receiver — handles subscription lifecycle events and
// writes the canonical state into public.subscriptions.
//
// Configure on Stripe Dashboard:
//   1. Developers → Webhooks → Add endpoint
//   2. Endpoint URL = https://<project>.supabase.co/functions/v1/stripe-webhook
//   3. Subscribe to events:
//        checkout.session.completed
//        customer.subscription.updated
//        customer.subscription.deleted
//        invoice.paid
//        invoice.payment_failed
//   4. Copy the signing secret → set STRIPE_WEBHOOK_SECRET on the function.
//
// Env required:
//   STRIPE_SECRET_KEY       (for cross-referencing subscription objects)
//   STRIPE_WEBHOOK_SECRET   whsec_...
//
// We verify the Stripe signature on every request — UNSIGNED requests
// are rejected immediately. This is the only mutation path for
// subscriptions; everything else (frontend, RPCs) is read-only.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

// Map Stripe price IDs back to plan_id. We learn the price IDs from
// env vars (same source as stripe-checkout) so the mapping is single-
// sourced.
function planFromPriceId(): Record<string, string> {
  const map: Record<string, string> = {};
  const entries: Array<[string, string]> = [
    ["STRIPE_PRICE_PLUS_MONTHLY",   "plus"],
    ["STRIPE_PRICE_PLUS_ANNUAL",    "plus"],
    ["STRIPE_PRICE_PRO_MONTHLY",    "pro"],
    ["STRIPE_PRICE_PRO_ANNUAL",     "pro"],
    ["STRIPE_PRICE_CAREER_MONTHLY", "career"],
    ["STRIPE_PRICE_CAREER_ANNUAL",  "career"],
  ];
  entries.forEach(([envVar, planId]) => {
    const priceId = Deno.env.get(envVar);
    if (priceId) map[priceId] = planId;
  });
  return map;
}

// Stripe signature verification. Stripe signs the raw payload with
// HMAC-SHA256. We use Web Crypto to verify without an SDK.
async function verifySignature(rawBody: string, sigHeader: string, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  // sigHeader looks like: t=1700000000,v1=abcdef...,v1=...
  const parts: Record<string, string[]> = {};
  sigHeader.split(",").forEach((p) => {
    const [k, v] = p.split("=");
    if (!k || !v) return;
    (parts[k] = parts[k] || []).push(v);
  });
  const timestamp = parts.t?.[0];
  const v1s = parts.v1 || [];
  if (!timestamp || !v1s.length) return false;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  // Replay protection: reject events older than tolerance.
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSec > toleranceSec) return false;
  const signed = timestamp + "." + rawBody;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time compare against any v1 candidate.
  return v1s.some((candidate) => {
    if (candidate.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function fetchSubscription(stripeKey: string, subscriptionId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(subscriptionId), {
    headers: { Authorization: "Bearer " + stripeKey, "Stripe-Version": "2024-06-20" },
  });
  if (!res.ok) return null;
  return await res.json();
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeKey || !webhookSecret) {
    return errorResponse("Stripe env not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET).", 503);
  }
  const sigHeader = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();
  const ok = await verifySignature(rawBody, sigHeader, webhookSecret);
  if (!ok) return errorResponse("Invalid Stripe signature.", 400);

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); }
  catch { return errorResponse("Invalid JSON payload.", 400); }

  const eventId = String(event.id || "");
  const eventType = String(event.type || "");
  const data = (event.data as Record<string, unknown>) || {};
  const object = (data.object as Record<string, unknown>) || {};

  const priceToPlanId = planFromPriceId();
  const svc = getServiceClient();

  // Helper — find a Supabase user_id given a Stripe object that has
  // metadata.cb_user_id OR a customer id we recognize.
  async function resolveUserId(): Promise<string | null> {
    const metadata = (object.metadata as Record<string, unknown>) || {};
    if (typeof metadata.cb_user_id === "string" && metadata.cb_user_id) return metadata.cb_user_id;
    // checkout.session has client_reference_id.
    if (typeof object.client_reference_id === "string" && object.client_reference_id) {
      return object.client_reference_id;
    }
    const customerId = typeof object.customer === "string" ? object.customer : null;
    if (customerId) {
      const { data: sub } = await svc
        .from("subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (sub?.user_id) return sub.user_id;
    }
    return null;
  }

  function planIdFromItems(items: unknown): string {
    if (!items || typeof items !== "object") return "free";
    const data = (items as Record<string, unknown>).data;
    if (!Array.isArray(data) || !data.length) return "free";
    const first = data[0] as Record<string, unknown>;
    const price = (first?.price as Record<string, unknown>) || {};
    const priceId = String(price.id || "");
    return priceToPlanId[priceId] || "free";
  }

  function statusFromStripe(s: string): string {
    // Stripe statuses: incomplete, incomplete_expired, trialing, active,
    // past_due, canceled, unpaid, paused. Our column constraint allows
    // most of these directly.
    if (s === "incomplete_expired") return "canceled";
    return s || "active";
  }

  // Route per event type. Each writes the canonical row.
  try {
    if (eventType === "checkout.session.completed") {
      // The subscription object isn't fully embedded — fetch by id.
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
      const customerId = typeof object.customer === "string" ? object.customer : null;
      const userId = await resolveUserId();
      if (!userId) return jsonResponse({ ok: true, note: "no user_id resolved" });
      if (!subscriptionId) {
        // One-time purchase or pre-subscription session — just record customer.
        await svc.from("subscriptions").upsert({
          user_id: userId,
          stripe_customer_id: customerId || undefined,
          last_event_id: eventId,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        return jsonResponse({ ok: true });
      }
      const subscription = await fetchSubscription(stripeKey, subscriptionId);
      const planId = planIdFromItems(subscription?.items);
      const status = statusFromStripe(String(subscription?.status || "active"));
      const cpe = subscription?.current_period_end ? new Date(Number(subscription.current_period_end) * 1000).toISOString() : null;
      await svc.from("subscriptions").upsert({
        user_id: userId,
        plan_id: planId,
        status: status,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        current_period_end: cpe,
        cancel_at_period_end: !!subscription?.cancel_at_period_end,
        last_event_id: eventId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      return jsonResponse({ ok: true, plan_id: planId });
    }

    if (eventType === "customer.subscription.updated" || eventType === "customer.subscription.created") {
      const userId = await resolveUserId();
      if (!userId) return jsonResponse({ ok: true, note: "no user_id resolved" });
      const subscriptionId = typeof object.id === "string" ? object.id : null;
      const planId = planIdFromItems((object as Record<string, unknown>).items);
      const status = statusFromStripe(String((object as Record<string, unknown>).status || "active"));
      const cpe = (object as Record<string, unknown>).current_period_end
        ? new Date(Number((object as Record<string, unknown>).current_period_end) * 1000).toISOString()
        : null;
      await svc.from("subscriptions").upsert({
        user_id: userId,
        plan_id: planId,
        status: status,
        stripe_customer_id: typeof object.customer === "string" ? object.customer : null,
        stripe_subscription_id: subscriptionId,
        current_period_end: cpe,
        cancel_at_period_end: !!(object as Record<string, unknown>).cancel_at_period_end,
        canceled_at: (object as Record<string, unknown>).canceled_at
          ? new Date(Number((object as Record<string, unknown>).canceled_at) * 1000).toISOString() : null,
        last_event_id: eventId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      return jsonResponse({ ok: true });
    }

    if (eventType === "customer.subscription.deleted") {
      const userId = await resolveUserId();
      if (!userId) return jsonResponse({ ok: true, note: "no user_id resolved" });
      // Downgrade to free; keep stripe ids for history.
      await svc.from("subscriptions").update({
        plan_id: "free",
        status: "canceled",
        canceled_at: new Date().toISOString(),
        cancel_at_period_end: false,
        last_event_id: eventId,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
      return jsonResponse({ ok: true });
    }

    if (eventType === "invoice.payment_failed") {
      const userId = await resolveUserId();
      if (!userId) return jsonResponse({ ok: true, note: "no user_id resolved" });
      // Don't downgrade immediately — Stripe will retry, eventually
      // fire subscription.deleted if it fails for good.
      await svc.from("subscriptions").update({
        status: "past_due",
        last_event_id: eventId,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
      return jsonResponse({ ok: true });
    }

    if (eventType === "invoice.paid") {
      const userId = await resolveUserId();
      if (!userId) return jsonResponse({ ok: true, note: "no user_id resolved" });
      await svc.from("subscriptions").update({
        status: "active",
        last_event_id: eventId,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
      return jsonResponse({ ok: true });
    }

    // Unhandled but acknowledged — Stripe expects 200 or it'll retry.
    return jsonResponse({ ok: true, note: "ignored event type " + eventType });
  } catch (err) {
    console.error("stripe-webhook error", err);
    return errorResponse("Webhook handler error: " + ((err as Error).message || "unknown"), 500);
  }
});
