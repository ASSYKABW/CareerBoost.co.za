// POST /functions/v1/admin-send-email
//
// Operator-triggered transactional email send via Resend. Replaces
// the previous mailto: + intent-only audit flow. Each recipient
// becomes one row in admin_email_log + one Resend API call.
//
// Body:
//   {
//     subject: string,
//     bodyHtml: string,           // HTML body. Plain text auto-derived.
//     recipients: [               // 1..200 recipients
//       { userId?: uuid, email: string },
//       ...
//     ],
//     bulkBatchId?: uuid          // client can pass one to group, else
//                                 // we generate one
//   }
//
// Response:
//   {
//     ok: true,
//     batchId: uuid,
//     total: N,
//     sent: N,
//     failed: M,
//     results: [ { email, status, error?, messageId?, logId } ... ]
//   }
//
// Gates (all 4 mirror the other admin RPCs):
//   - CSRF nonce header (admin-csrf)
//   - Admin role + AAL2 (getAuthedAdmin)
//   - Per-operator rate limit (30 mutations / 5 min)
//   - Per-batch upper bound: 200 recipients to prevent runaway sends

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { logAdminAction, extractRequestMeta } from "../_shared/admin-audit.ts";

const RESEND_API = "https://api.resend.com/emails";
const MAX_RECIPIENTS = 200;
const MAX_SUBJECT = 200;
const MAX_BODY = 100_000; // 100KB — generous for HTML emails

interface Recipient {
  userId?: string;
  email: string;
}
interface Body {
  subject?: string;
  bodyHtml?: string;
  recipients?: Recipient[];
  bulkBatchId?: string;
}

// Resend send-result per recipient (mirrors the structure returned to
// the client).
interface SendResult {
  email: string;
  userId: string | null;
  status: "sent" | "failed";
  messageId: string | null;
  error: string | null;
  logId: string;
}

// Derive a plain-text version of the HTML so Resend's text/* part is
// non-empty (improves deliverability — gmail in particular flags
// HTML-only mail). Very rough strip; bullet-proof would use a real
// HTML→text lib, but we're working with operator-typed strings, not
// crawled web pages.
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // CSRF before auth (cheap reject).
  const csrf = checkAdminCsrf(req);
  if (!csrf.ok) return errorResponse(csrf.error, csrf.status);

  // Admin gate.
  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  // Rate limit.
  const rate = await enforceAdminRate(admin, "admin-send-email");
  if (!rate.allowed) return errorResponse(rate.reason || "Rate limit exceeded.", 429);

  // Parse + validate body.
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const subject = String(body.subject || "").trim();
  const bodyHtml = String(body.bodyHtml || "").trim();
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];

  if (!subject) return errorResponse("subject is required.", 400);
  if (subject.length > MAX_SUBJECT) return errorResponse("subject must be " + MAX_SUBJECT + " chars or fewer.", 400);
  if (!bodyHtml) return errorResponse("bodyHtml is required.", 400);
  if (bodyHtml.length > MAX_BODY) return errorResponse("bodyHtml must be " + MAX_BODY + " chars or fewer.", 400);
  if (!recipients.length) return errorResponse("recipients[] cannot be empty.", 400);
  if (recipients.length > MAX_RECIPIENTS) {
    return errorResponse("recipients[] capped at " + MAX_RECIPIENTS + " per batch.", 400);
  }

  // Normalize + dedupe recipients by email.
  const seen = new Set<string>();
  const cleanRecipients: Recipient[] = [];
  for (const r of recipients) {
    if (!r || typeof r.email !== "string") continue;
    const email = r.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    cleanRecipients.push({ userId: r.userId, email });
  }
  if (!cleanRecipients.length) return errorResponse("No valid recipient emails after normalization.", 400);

  // Resend creds.
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  const fromName = Deno.env.get("RESEND_FROM_NAME") || "CareerBoost";
  if (!resendKey || !fromEmail) {
    return errorResponse(
      "Resend not configured. Operator: set RESEND_API_KEY + RESEND_FROM_EMAIL in Supabase secrets " +
      "(see docs/RESEND-SETUP.md).",
      503,
    );
  }
  const fromHeader = fromName + " <" + fromEmail + ">";

  const svc = getServiceClient();
  const meta = extractRequestMeta(req);
  const batchId = body.bulkBatchId && /^[0-9a-f-]{36}$/i.test(body.bulkBatchId)
    ? body.bulkBatchId
    : crypto.randomUUID();
  const bodyText = htmlToText(bodyHtml);
  const results: SendResult[] = [];

  // Sequential — we hit Resend's rate limits if we fire all 200 in
  // parallel. ~10 emails/sec is the documented safe rate; sequential
  // with sub-100ms latency gets us there.
  for (const r of cleanRecipients) {
    // Pre-insert a queued row so even if the Resend call hangs we
    // have a record of the attempt.
    const { data: logRow, error: insertErr } = await svc
      .from("admin_email_log")
      .insert({
        operator_id: admin.id,
        operator_email: admin.email || "",
        recipient_user_id: r.userId || null,
        recipient_email: r.email,
        subject,
        body_chars: bodyHtml.length,
        status: "queued",
        bulk_batch_id: batchId,
      })
      .select("id")
      .single();

    if (insertErr || !logRow) {
      results.push({
        email: r.email,
        userId: r.userId || null,
        status: "failed",
        messageId: null,
        error: "Log insert failed: " + (insertErr?.message || "unknown"),
        logId: "",
      });
      continue;
    }
    const logId = logRow.id;

    try {
      const psRes = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + resendKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromHeader,
          to: [r.email],
          subject,
          html: bodyHtml,
          text: bodyText,
          // Resend tags surface on their dashboard + webhook events,
          // making it easy to filter for operator-triggered sends.
          // Resend tag VALUES must match /^[A-Za-z0-9_-]+$/ — no @ or .
          // so the operator's email needs sanitizing (jonathan@gmail.com
          // → jonathan_gmail_com). Replace every disallowed char with _.
          tags: [
            { name: "source", value: "admin-console" },
            { name: "batch_id", value: batchId },
            {
              name: "operator",
              value: String(admin.email || admin.id)
                .replace(/[^A-Za-z0-9_-]/g, "_")
                .slice(0, 60),
            },
          ],
        }),
      });
      const responseText = await psRes.text();
      let resendJson: { id?: string; message?: string; name?: string } = {};
      try { resendJson = JSON.parse(responseText); } catch (_e) { /* non-JSON */ }

      if (!psRes.ok || !resendJson.id) {
        const errMsg = "Resend HTTP " + psRes.status + ": " + (resendJson.message || resendJson.name || responseText.slice(0, 200));
        await svc
          .from("admin_email_log")
          .update({ status: "failed", failed_at: new Date().toISOString(), error_message: errMsg })
          .eq("id", logId);
        results.push({
          email: r.email,
          userId: r.userId || null,
          status: "failed",
          messageId: null,
          error: errMsg,
          logId,
        });
        continue;
      }

      await svc
        .from("admin_email_log")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          resend_message_id: resendJson.id,
        })
        .eq("id", logId);

      results.push({
        email: r.email,
        userId: r.userId || null,
        status: "sent",
        messageId: resendJson.id,
        error: null,
        logId,
      });
    } catch (err) {
      const errMsg = "Network error: " + ((err as Error).message || "unknown");
      await svc
        .from("admin_email_log")
        .update({ status: "failed", failed_at: new Date().toISOString(), error_message: errMsg })
        .eq("id", logId);
      results.push({
        email: r.email,
        userId: r.userId || null,
        status: "failed",
        messageId: null,
        error: errMsg,
        logId,
      });
    }
  }

  const sentCount = results.filter((r) => r.status === "sent").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  // One audit row per batch — operators can drill into admin_email_log
  // for per-recipient detail. Body NEVER goes into audit payload (PII).
  await logAdminAction(admin, "send_email_batch", {
    payload: {
      subject,
      batchId,
      total: cleanRecipients.length,
      sent: sentCount,
      failed: failedCount,
      bodyChars: bodyHtml.length,
    },
    // logAdminAction only models success/failed — collapse partial
    // into "failed" with the detail in errorMessage so operators can
    // still see "23 of 25 sent" when they review the audit log.
    resultStatus: failedCount === 0 ? "success" : "failed",
    errorMessage: failedCount === 0
      ? undefined
      : (sentCount === 0
          ? "All " + cleanRecipients.length + " sends failed"
          : failedCount + " of " + cleanRecipients.length + " sends failed (partial)"),
    ...meta,
  });

  return jsonResponse({
    ok: true,
    batchId,
    total: cleanRecipients.length,
    sent: sentCount,
    failed: failedCount,
    results,
  });
});
