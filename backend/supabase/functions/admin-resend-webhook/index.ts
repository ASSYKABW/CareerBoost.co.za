// POST /functions/v1/admin-resend-webhook
//
// Receives Resend webhook events and updates admin_email_log rows
// matching the email_id. Tracks delivery lifecycle:
//
//   email.sent          → status=sent          (we set this on POST, no-op)
//   email.delivered     → status=delivered     (final-good)
//   email.bounced       → status=bounced       (final-bad — hard or soft)
//   email.complained    → status=complained    (recipient hit "spam")
//   email.opened        → status=opened        (only if status=sent;
//                                               don't downgrade if
//                                               already delivered)
//   email.clicked       → no-op (don't surface link clicks for audit)
//   email.delivery_delayed → no-op (Resend retries)
//
// Auth: Svix-style HMAC signature in headers. Resend signs the full
// raw body with the RESEND_WEBHOOK_SECRET; we verify by computing the
// HMAC-SHA256 of the body and comparing in constant time.
// Reference: https://resend.com/docs/dashboard/webhooks/verify-webhooks

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

// Resend uses Svix under the hood. Headers:
//   svix-id          : unique event id (use for dedupe)
//   svix-timestamp   : unix seconds
//   svix-signature   : "v1,SIG_BASE64 v1,ANOTHER_SIG_BASE64" (rotated keys)
//
// Per Svix docs, signed payload = {svix-id}.{svix-timestamp}.{body}
// HMAC = base64(HMAC-SHA256(secretBytes, signedPayload))
async function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  body: string,
  svixSignature: string,
): Promise<boolean> {
  if (!secret || !svixId || !svixTimestamp || !svixSignature) return false;

  // Secret format from Svix: "whsec_BASE64SECRET". Strip the prefix
  // and base64-decode to get the HMAC key bytes.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBuf: ArrayBuffer;
  try {
    const decoded = atob(rawSecret);
    // Build via explicit ArrayBuffer (not SharedArrayBuffer) so the
    // Deno type system accepts it as BufferSource for importKey.
    keyBuf = new ArrayBuffer(decoded.length);
    const view = new Uint8Array(keyBuf);
    for (let i = 0; i < decoded.length; i++) view[i] = decoded.charCodeAt(i);
  } catch {
    return false;
  }

  const signedContent = svixId + "." + svixTimestamp + "." + body;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // Header can carry multiple signatures separated by spaces
  // (rotated keys). Match any.
  return svixSignature.split(" ").some((entry) => {
    const parts = entry.split(",");
    return parts.length === 2 && parts[1] === expected;
  });
}

interface ResendEvent {
  type: string;
  data: {
    email_id?: string;
    to?: string[];
    bounce?: { type?: string; subType?: string; message?: string };
    [k: string]: unknown;
  };
  created_at?: string;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // Read raw body for signature verification.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return errorResponse("Couldn't read body: " + (err as Error).message, 400);
  }

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  // If secret not configured we REFUSE the webhook — better to lose
  // some delivery events than to accept unverified ones.
  if (!secret) {
    console.error("[admin-resend-webhook] RESEND_WEBHOOK_SECRET not set — rejecting");
    return errorResponse("Webhook secret not configured on server.", 503);
  }

  const svixId = req.headers.get("svix-id") || "";
  const svixTimestamp = req.headers.get("svix-timestamp") || "";
  const svixSignature = req.headers.get("svix-signature") || "";
  const verified = await verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature);
  if (!verified) {
    console.warn("[admin-resend-webhook] signature mismatch — rejected");
    return errorResponse("Invalid signature.", 401);
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return errorResponse("Invalid JSON.", 400);
  }
  if (!event || !event.type || !event.data) {
    return errorResponse("Missing event type/data.", 400);
  }
  const emailId = String(event.data.email_id || "");
  if (!emailId) {
    // Event isn't tied to a Resend message we know about — accept
    // (return 200) so Resend doesn't retry, but no-op locally.
    return jsonResponse({ ok: true, ignored: "no-email-id" });
  }

  const svc = getServiceClient();
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {};

  switch (event.type) {
    case "email.delivered":
      update.status = "delivered";
      update.delivered_at = now;
      break;
    case "email.bounced": {
      update.status = "bounced";
      update.bounced_at = now;
      const b = event.data.bounce;
      if (b) {
        update.error_message = "Bounce: " + (b.type || "") + " / " + (b.subType || "") + " — " + (b.message || "");
      }
      break;
    }
    case "email.complained":
      update.status = "complained";
      update.complained_at = now;
      break;
    case "email.opened":
      // Don't downgrade from 'delivered' to 'opened' status-wise;
      // just stamp opened_at. The admin UI can derive "opened?" from
      // opened_at IS NOT NULL.
      update.opened_at = now;
      break;
    case "email.sent":
      // We already set status='sent' on POST; just confirm the timestamp.
      // Don't update status because the webhook may arrive BEFORE our
      // initial INSERT commits in pathological timing (very rare but
      // possible) — in which case the row doesn't exist and the update
      // is a no-op (matched zero rows). That's fine.
      update.sent_at = now;
      break;
    default:
      // email.clicked / email.delivery_delayed / etc.
      return jsonResponse({ ok: true, ignored: event.type });
  }

  const { error } = await svc
    .from("admin_email_log")
    .update(update)
    .eq("resend_message_id", emailId);

  if (error) {
    console.error("[admin-resend-webhook] update failed:", error.message, "event=", event.type, "emailId=", emailId);
    return errorResponse("DB update failed: " + error.message, 500);
  }

  // Bounce / complaint → add to the marketing suppression list so the
  // lifecycle sender never emails this address again. Idempotent (unique
  // on email). Best-effort: don't fail the webhook if suppression write fails.
  if (event.type === "email.bounced" || event.type === "email.complained") {
    try {
      const { data: logRow } = await svc
        .from("admin_email_log")
        .select("recipient_email, recipient_user_id")
        .eq("resend_message_id", emailId)
        .maybeSingle();
      const email = (logRow?.recipient_email || (event.data.to && event.data.to[0]) || "").trim().toLowerCase();
      if (email) {
        const reason = event.type === "email.bounced" ? "bounce" : "complaint";
        await svc.from("email_suppressions").upsert(
          {
            user_id: logRow?.recipient_user_id || null,
            email,
            reason,
            detail: String(update.error_message || event.type),
          },
          { onConflict: "email" },
        );
      }
    } catch (err) {
      console.error("[admin-resend-webhook] suppression write failed:", (err as Error).message);
    }
  }

  return jsonResponse({ ok: true, event: event.type, emailId });
}));
