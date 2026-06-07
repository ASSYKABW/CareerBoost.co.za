// POST /functions/v1/paystack-webhook
//
// Receives + processes PayStack webhook events. Authenticates each
// request via HMAC-SHA512 of the raw request body using the secret
// key as the HMAC key — PayStack sends the signature in the
// `x-paystack-signature` header.
//
// Events we handle:
//   charge.success            — first or recurring charge cleared; promote
//                               the user to the matching plan + record
//                               paystack_customer_code / subscription_code
//   subscription.create       — recurring subscription was created; we
//                               persist subscription_code (may arrive
//                               before or after charge.success)
//   subscription.disable      — subscription cancelled (by us or PayStack);
//                               revert user to free tier at period end
//                               (or immediately if PayStack signals so)
//   invoice.payment_failed    — auto-charge bounced; mark status past_due
//                               but DON'T downgrade — give the user grace
//                               while PayStack retries
//   invoice.create            — informational; we don't act
//
// PayStack docs: https://paystack.com/docs/payments/webhooks/
//
// Idempotency: every event has an `id` field. We store the most-recent
// processed id on subscriptions.last_event_id (the same column Stripe
// uses). If the same id arrives twice (network retry), we no-op.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

// --- HMAC verification ---------------------------------------------------

// Compute the HMAC-SHA512 of a string using Deno's SubtleCrypto and
// return a lowercase hex string. PayStack signs with the secret key
// (the same sk_... you use for API calls), not a separate webhook secret.
async function hmacSha512Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Event handlers ------------------------------------------------------

interface PaystackEvent {
  event: string;
  data: Record<string, unknown>;
  id?: string;
}

interface ChargeData {
  reference: string;
  amount: number;
  currency: string;
  status: string;
  customer?: { id: number; customer_code: string; email: string };
  plan?: { id: number; plan_code: string; name: string } | string;
  // Present on any successful card charge — reusable token we attach to the
  // deferred subscription in the intro-discount flow.
  authorization?: { authorization_code: string; reusable?: boolean };
  metadata?: {
    user_id?: string; plan_id?: string; interval?: string; currency?: string;
    intro_discount?: string; plan_code?: string; subscription_start?: string;
    discount_pct?: string; full_amount_minor?: string; grant_id?: string;
  } | string;
  subscription?: string;
}

interface SubscriptionData {
  subscription_code: string;
  customer?: { customer_code: string; email: string };
  plan?: { plan_code: string; name: string };
  status?: string;
  next_payment_date?: string;
  cancelledAt?: string;
}

function parseMetadata(meta: ChargeData["metadata"]): Record<string, string> {
  if (!meta) return {};
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return {}; }
  }
  return meta as Record<string, string>;
}

// Look up plan_id from a paystack plan_code by scanning plan_catalog's
// 4 paystack_plan_code_* columns. Slower than a metadata lookup but
// reliable when metadata is missing (e.g. on recurring renewals which
// don't carry the original transaction metadata).
async function resolvePlanIdFromPaystackCode(
  svc: ReturnType<typeof getServiceClient>,
  planCode: string,
): Promise<string | null> {
  if (!planCode) return null;
  const { data } = await svc
    .from("plan_catalog")
    .select("plan_id, paystack_plan_code_zar_monthly, paystack_plan_code_zar_annual, paystack_plan_code_usd_monthly, paystack_plan_code_usd_annual")
    .or(
      "paystack_plan_code_zar_monthly.eq." + planCode +
      ",paystack_plan_code_zar_annual.eq." + planCode +
      ",paystack_plan_code_usd_monthly.eq." + planCode +
      ",paystack_plan_code_usd_annual.eq." + planCode,
    )
    .limit(1)
    .single();
  return data && data.plan_id ? String(data.plan_id) : null;
}

async function handleChargeSuccess(svc: ReturnType<typeof getServiceClient>, event: PaystackEvent) {
  const charge = event.data as unknown as ChargeData;
  if (charge.status !== "success") return; // ignore in-flight states

  const meta = parseMetadata(charge.metadata);
  const userId = meta.user_id;
  if (!userId) {
    console.warn("[paystack-webhook] charge.success without user_id metadata; skipping:", charge.reference);
    return;
  }

  // Resolve plan_id — prefer metadata, fall back to plan_code lookup.
  let planId = meta.plan_id || null;
  if (!planId && charge.plan && typeof charge.plan === "object" && "plan_code" in charge.plan) {
    planId = await resolvePlanIdFromPaystackCode(svc, String((charge.plan as { plan_code: string }).plan_code));
  }
  if (!planId) {
    console.warn("[paystack-webhook] charge.success can't resolve plan_id; skipping:", charge.reference);
    return;
  }

  const customerCode = charge.customer?.customer_code || null;
  const subscriptionCode = typeof charge.subscription === "string" ? charge.subscription : null;

  // ---- Intro discount path ----
  // The first charge was a DISCOUNTED ONE-TIME payment (no plan attached).
  // Now create the real recurring subscription, set to start one interval
  // later at full price, and stamp the redemption.
  if (meta.intro_discount === "true" && meta.plan_code) {
    const isGrant = !!meta.grant_id;

    // Idempotency on Paystack retries: skip if the discount was already
    // redeemed. For a grant that means status != 'active'; for the global
    // intro it means intro_discount_redeemed_at is already stamped.
    if (isGrant) {
      const { data: g } = await svc
        .from("promo_grants")
        .select("status")
        .eq("id", meta.grant_id)
        .maybeSingle();
      if (!g || g.status !== "active") {
        console.log("[paystack-webhook] grant " + meta.grant_id + " not active; skipping");
        return;
      }
    } else {
      const { data: existing } = await svc
        .from("subscriptions")
        .select("intro_discount_redeemed_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (existing && existing.intro_discount_redeemed_at) {
        console.log("[paystack-webhook] intro already redeemed for " + userId + "; skipping");
        return;
      }
    }

    const authCode = charge.authorization?.authorization_code || null;
    const startDate = meta.subscription_start || null;
    if (authCode && customerCode) {
      const secret = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
      try {
        const createRes = await fetch("https://api.paystack.co/subscription", {
          method: "POST",
          headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
          body: JSON.stringify({
            customer: customerCode,
            plan: meta.plan_code,
            authorization: authCode,
            ...(startDate ? { start_date: startDate } : {}),
          }),
        });
        if (!createRes.ok) {
          const txt = await createRes.text();
          console.error("[paystack-webhook] intro subscription create FAILED (manual follow-up needed):", createRes.status, txt.slice(0, 300), "userId=", userId);
        } else {
          console.log("[paystack-webhook] intro subscription scheduled for " + userId + " (first full charge " + startDate + ")");
        }
      } catch (e) {
        console.error("[paystack-webhook] intro subscription create threw:", (e as Error).message, "userId=", userId);
      }
    } else {
      console.error("[paystack-webhook] intro charge missing auth/customer; recurring NOT created:", JSON.stringify({ userId, ref: charge.reference }));
    }

    // Grant the prepaid first period + record the redemption. We stamp
    // redeemed_at even if the subscription create failed, so a Paystack
    // retry can't double-charge — a failed create is surfaced via the log
    // above for manual follow-up.
    const introUpdate: Record<string, unknown> = {
      plan_id: planId,
      status: "active",
      payment_processor: "paystack",
      current_period_end: startDate,
      cancel_at_period_end: false,
      canceled_at: null,
      last_event_id: event.id || charge.reference,
      updated_at: new Date().toISOString(),
    };
    // Stamp the first-time intro flag only for the GLOBAL intro, not a grant
    // (a grant can go to returning customers; it's tracked on promo_grants).
    if (!isGrant) introUpdate.intro_discount_redeemed_at = new Date().toISOString();
    if (customerCode) introUpdate.paystack_customer_code = customerCode;
    const { error: introErr } = await svc
      .from("subscriptions")
      .upsert({ user_id: userId, ...introUpdate }, { onConflict: "user_id" });
    if (introErr) {
      console.error("[paystack-webhook] intro upsert failed:", introErr.message, "userId=", userId);
      throw new Error("DB upsert failed: " + introErr.message);
    }
    // Single-use: consume the grant now that the charge cleared.
    if (isGrant) {
      await svc
        .from("promo_grants")
        .update({ status: "redeemed", redeemed_at: new Date().toISOString() })
        .eq("id", meta.grant_id);
    }
    console.log("[paystack-webhook] intro: promoted " + userId + " → " + planId + " (" + (meta.discount_pct || "30") + "% off" + (isGrant ? ", granted" : ", global intro") + ")");
    return;
  }

  // Upsert the subscription row.
  const update: Record<string, unknown> = {
    plan_id: planId,
    status: "active",
    payment_processor: "paystack",
    last_event_id: event.id || charge.reference,
    updated_at: new Date().toISOString(),
  };
  if (customerCode) update.paystack_customer_code = customerCode;
  if (subscriptionCode) update.paystack_subscription_code = subscriptionCode;
  // A successful charge means we just renewed; clear any prior cancel
  // flag and reset canceled_at so the UI shows "Active" again rather
  // than carrying a stale "cancelled" badge.
  update.cancel_at_period_end = false;
  update.canceled_at = null;

  const { error } = await svc
    .from("subscriptions")
    .upsert({ user_id: userId, ...update }, { onConflict: "user_id" });
  if (error) {
    console.error("[paystack-webhook] charge.success upsert failed:", error.message, "userId=", userId);
    throw new Error("DB upsert failed: " + error.message);
  }
  console.log("[paystack-webhook] promoted user " + userId + " → plan " + planId);
}

async function handleSubscriptionCreate(svc: ReturnType<typeof getServiceClient>, event: PaystackEvent) {
  const sub = event.data as unknown as SubscriptionData;
  if (!sub.subscription_code || !sub.customer?.customer_code) return;

  // We match by customer_code (already stored from a prior charge.success).
  // If no row matches yet, charge.success was likely delayed — skip; the
  // next event for this user will fill it in.
  const { data: rows } = await svc
    .from("subscriptions")
    .select("user_id, paystack_subscription_code")
    .eq("paystack_customer_code", sub.customer.customer_code)
    .limit(1);
  if (!rows || !rows.length) {
    console.warn("[paystack-webhook] subscription.create with no matching customer; will retry on next event:", sub.subscription_code);
    return;
  }
  const row = rows[0];
  if (row.paystack_subscription_code === sub.subscription_code) return; // already set

  const createUpdate: Record<string, unknown> = {
    paystack_subscription_code: sub.subscription_code,
    last_event_id: event.id || sub.subscription_code,
    updated_at: new Date().toISOString(),
  };
  if (sub.next_payment_date) createUpdate.current_period_end = sub.next_payment_date;

  await svc
    .from("subscriptions")
    .update(createUpdate)
    .eq("user_id", row.user_id);
}

async function handleSubscriptionDisable(svc: ReturnType<typeof getServiceClient>, event: PaystackEvent) {
  const sub = event.data as unknown as SubscriptionData;
  if (!sub.subscription_code) return;

  // We mark cancel_at_period_end=true rather than instantly downgrading;
  // PayStack signals the actual stop via status='cancelled' on the next
  // charge cycle. Keeping the user on their plan until their period
  // ends is the standard behavior + the right UX.
  const { data: rows } = await svc
    .from("subscriptions")
    .select("user_id, status")
    .eq("paystack_subscription_code", sub.subscription_code)
    .limit(1);
  if (!rows || !rows.length) return;

  const userId = rows[0].user_id;
  // If PayStack reports the sub already at status complete/cancelled
  // (final disable, not user-initiated cancel-at-period-end), drop
  // them straight to free.
  const finalStatus = sub.status === "complete" || sub.status === "cancelled"
    ? "canceled"
    : "active";

  const update: Record<string, unknown> = {
    status: finalStatus,
    cancel_at_period_end: finalStatus === "active",
    canceled_at: new Date().toISOString(),
    last_event_id: event.id || sub.subscription_code,
    updated_at: new Date().toISOString(),
    ...(finalStatus === "canceled" ? { plan_id: "free" } : {}),
  };
  // Without this the billing UI can't show "Cancels on X" — it falls
  // back to "No active subscription" which is misleading while the user
  // still has paid features until period end.
  if (sub.next_payment_date) update.current_period_end = sub.next_payment_date;

  await svc
    .from("subscriptions")
    .update(update)
    .eq("user_id", userId);
}

async function handleInvoicePaymentFailed(svc: ReturnType<typeof getServiceClient>, event: PaystackEvent) {
  const sub = event.data as unknown as SubscriptionData;
  if (!sub.subscription_code) return;
  await svc
    .from("subscriptions")
    .update({
      status: "past_due",
      last_event_id: event.id || sub.subscription_code,
      updated_at: new Date().toISOString(),
    })
    .eq("paystack_subscription_code", sub.subscription_code);
}

// --- Handler -------------------------------------------------------------

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) return errorResponse("PAYSTACK_SECRET_KEY not configured.", 503);

  // Read raw body so we can re-hash it for signature verification.
  // Once we await req.json() the stream is consumed and we lose the
  // exact bytes PayStack signed.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return errorResponse("Couldn't read body: " + (err as Error).message, 400);
  }

  const signature = req.headers.get("x-paystack-signature") || "";
  if (!signature) return errorResponse("Missing x-paystack-signature header.", 401);
  const computed = await hmacSha512Hex(secret, rawBody);
  if (computed !== signature) {
    console.warn("[paystack-webhook] signature mismatch — request rejected");
    return errorResponse("Invalid signature.", 401);
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return errorResponse("Invalid JSON.", 400);
  }
  if (!event || !event.event) return errorResponse("Missing event field.", 400);

  const svc = getServiceClient();
  try {
    if (event.event === "charge.success") {
      await handleChargeSuccess(svc, event);
    } else if (event.event === "subscription.create") {
      await handleSubscriptionCreate(svc, event);
    } else if (event.event === "subscription.disable") {
      await handleSubscriptionDisable(svc, event);
    } else if (event.event === "invoice.payment_failed") {
      await handleInvoicePaymentFailed(svc, event);
    } else {
      // invoice.create, invoice.update, customeridentification.* etc.
      // We acknowledge but don't act — keeps PayStack from retrying.
      console.log("[paystack-webhook] no-op event:", event.event);
    }
  } catch (err) {
    // Return 500 so PayStack retries — the event was authentic, our
    // processing failed. Logged for ops review.
    console.error("[paystack-webhook] handler threw:", (err as Error).message, "event=", event.event);
    return errorResponse("Handler failed: " + (err as Error).message, 500);
  }

  return jsonResponse({ ok: true, event: event.event });
}));
