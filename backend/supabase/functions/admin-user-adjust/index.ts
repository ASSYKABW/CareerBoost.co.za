// POST /functions/v1/admin-user-adjust
// Body: { targetUserId: uuid, action: "grant_quota" | "reset_quota"
//                                  | "change_plan" | "add_note"
//                                  | "send_email",
//         payload?: {...action-specific...} }
//
// Wraps the admin_user_adjust RPC (migration 0018, extended in 0019).
// Same pattern as admin-promote-user: getAuthedAdmin gates the caller,
// the RPC is SECURITY DEFINER + service-role-only, every call writes to
// admin_audit_log so the operations trail is centralized.
//
// Payload shapes:
//   grant_quota:  { quota: "ai_resumes"|"ai_covers"|..., amount: int 1..1000 }
//   reset_quota:  {}   (no fields needed)
//   change_plan:  { planId: "free"|"plus"|"pro"|"career" }
//   add_note:     { note: string (1..2000 chars) }
//   send_email:   { subject: string (1..200), bodyLength: int (1..10000) }
//                 The actual email is sent client-side via mailto: — this
//                 RPC only records the intent. We store subject + body
//                 length (not body) because the body is in the operator's
//                 Sent folder and may contain PII shared by the user.
//
// Self-target safeguards:
//   - All actions on yourself are allowed; audit log catches misuse.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";

const VALID_ACTIONS = new Set([
  "grant_quota",
  "reset_quota",
  "change_plan",
  "add_note",
  "send_email",
]);

interface Body {
  targetUserId?: string;
  targetEmail?: string;
  action?: string;
  payload?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const meta = extractRequestMeta(req);
  const svc = getServiceClient();

  // ---- Validate action ------------------------------------------------------
  const action = String(body.action || "").trim();
  if (!VALID_ACTIONS.has(action)) {
    return errorResponse(
      "Unsupported action: " + (action || "(missing)") +
      ". Must be one of: " + Array.from(VALID_ACTIONS).join(", "),
      400,
    );
  }

  // ---- Resolve target user (id OR email) ------------------------------------
  let targetId = (body.targetUserId || "").trim();
  let targetEmail = (body.targetEmail || "").trim().toLowerCase();
  if (!targetId && !targetEmail) {
    return errorResponse("targetUserId or targetEmail is required.", 400);
  }
  if (!targetId && targetEmail) {
    // Walk auth.users pages until we find the email. Same pattern as
    // admin-promote-user — cap at 5000 to bound the walk.
    let page = 1;
    const perPage = 1000;
    let foundId: string | null = null;
    let foundEmail: string | null = null;
    for (;;) {
      const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
      if (error) {
        return errorResponse("Failed to look up target user: " + error.message, 502);
      }
      const batch = ((data?.users || []) as unknown) as Array<Record<string, unknown>>;
      const hit = batch.find((u) => String(u.email || "").toLowerCase() === targetEmail);
      if (hit) {
        foundId = String(hit.id || "");
        foundEmail = String(hit.email || "") || null;
        break;
      }
      if (batch.length < perPage) break;
      if (page * perPage >= 5000) break;
      page += 1;
    }
    if (!foundId) {
      return errorResponse("No user with that email exists.", 404);
    }
    targetId = foundId;
    if (foundEmail) targetEmail = foundEmail.toLowerCase();
  } else if (targetId && !targetEmail) {
    const { data, error } = await svc.auth.admin.getUserById(targetId);
    if (!error && data?.user?.email) {
      targetEmail = String(data.user.email).toLowerCase();
    }
  }

  // ---- Per-action payload validation (client-side defence in depth) --------
  // The RPC re-validates everything server-side; these checks are just to
  // return a clean 400 error instead of a 502 wrapper around a Postgres
  // exception. Each one mirrors the RPC's check.
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

  if (action === "grant_quota") {
    const quota = String(payload.quota || "").toLowerCase();
    const amount = Number(payload.amount);
    const validQuotas = ["ai_resumes", "ai_covers", "ai_mocks", "ai_research", "ai_question_banks"];
    if (!quota || !validQuotas.includes(quota)) {
      return errorResponse("payload.quota must be one of: " + validQuotas.join(", "), 400);
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
      return errorResponse("payload.amount must be an integer 1..1000.", 400);
    }
  } else if (action === "change_plan") {
    const planId = String(payload.planId || "").toLowerCase();
    if (!planId) {
      return errorResponse("payload.planId is required.", 400);
    }
    // We don't pre-check plan_catalog membership here — the RPC does and
    // returns a clean error. Skipping the extra round-trip.
  } else if (action === "add_note") {
    const note = String(payload.note || "").trim();
    if (!note) {
      return errorResponse("payload.note cannot be empty.", 400);
    }
    if (note.length > 2000) {
      return errorResponse("payload.note must be 2000 chars or fewer.", 400);
    }
  } else if (action === "send_email") {
    const subject = String(payload.subject || "").trim();
    const bodyLength = Number(payload.bodyLength);
    if (!subject) {
      return errorResponse("payload.subject cannot be empty.", 400);
    }
    if (subject.length > 200) {
      return errorResponse("payload.subject must be 200 chars or fewer.", 400);
    }
    if (!Number.isFinite(bodyLength) || bodyLength < 1 || bodyLength > 10000) {
      return errorResponse("payload.bodyLength must be an integer 1..10000.", 400);
    }
    if (!targetEmail) {
      return errorResponse("Cannot record send_email — target has no email address.", 400);
    }
  }

  // ---- Call the RPC ---------------------------------------------------------
  try {
    const { data, error } = await svc.rpc("admin_user_adjust", {
      p_admin_user_id: admin.id,
      p_admin_email: admin.email,
      p_target_user_id: targetId,
      p_target_email: targetEmail,
      p_action: action,
      p_payload: payload,
      p_ip: meta.ip,
      p_user_agent: meta.userAgent,
    });
    if (error) throw new Error(error.message);
    return jsonResponse({
      ok: true,
      result: data,
      target: { id: targetId, email: targetEmail },
    });
  } catch (err) {
    const message = (err as Error).message || "Admin user adjust failed.";
    // RPC failures still log the FAILED attempt via the shared helper so the
    // audit trail captures the intent + error. (The RPC's own audit insert
    // only runs on the success path because it's the last statement.)
    await logAdminAction(admin, action, {
      targetUserId: targetId,
      targetEmail,
      payload: { ...payload, attempted: true },
      resultStatus: "failed",
      errorMessage: message,
      ...meta,
    });
    return errorResponse(message, 502);
  }
});
