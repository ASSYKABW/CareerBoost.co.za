// POST /functions/v1/admin-promote-user
// Body: { targetEmail?: string, targetUserId?: string, roles: string[], note?: string }
// Auth: admin gate via getAuthedAdmin.
//
// Sets app_metadata.role and app_metadata.roles on the target user via the
// admin_promote_user RPC (SECURITY DEFINER + audit-logged at the DB level).
//
// Pass roles: [] (or null/omit) to DEMOTE — strips role + roles from
// app_metadata entirely.
//
// Safeguards:
//   1. Caller must be admin (getAuthedAdmin gate).
//   2. Requested roles must all be in the caller's allowedRoles set.
//      Prevents an "admin" from setting a target to "owner" if owner isn't
//      in the caller's permitted set.
//   3. Caller cannot demote themselves (would lock them out instantly).
//   4. Target lookup by email is service-role only.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";

interface Body {
  targetEmail?: string;
  targetUserId?: string;
  roles?: string[] | null;
  note?: string;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // Day 3.3: CSRF nonce required for promote/demote (security-critical mutation).
  const csrf = checkAdminCsrf(req);
  if (!csrf.ok) return errorResponse(csrf.error, csrf.status);

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  // Day 3.4: per-operator rate limit.
  const rate = await enforceAdminRate(admin, "admin-promote-user");
  if (!rate.allowed) return errorResponse(rate.reason || "Rate limit exceeded.", 429);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const meta = extractRequestMeta(req);
  const svc = getServiceClient();

  // ---- Resolve target user ---------------------------------------------------
  let targetId = (body.targetUserId || "").trim();
  let targetEmail = (body.targetEmail || "").trim().toLowerCase();
  if (!targetId && !targetEmail) {
    return errorResponse("targetUserId or targetEmail is required.", 400);
  }
  if (!targetId && targetEmail) {
    // Look up user id by email. listUsers() returns all; we filter client-side
    // because Supabase admin doesn't expose getUserByEmail directly.
    let page = 1;
    const perPage = 1000;
    let foundId: string | null = null;
    let foundEmail: string | null = null;
    for (;;) {
      const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
      if (error) {
        await logAdminAction(admin, "promote_user", {
          targetEmail,
          payload: { stage: "lookup", error: error.message },
          resultStatus: "failed",
          errorMessage: error.message,
          ...meta,
        });
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
      await logAdminAction(admin, "promote_user", {
        targetEmail,
        payload: { stage: "lookup", outcome: "not-found" },
        resultStatus: "failed",
        errorMessage: "Target user not found.",
        ...meta,
      });
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

  // ---- Validate requested roles ----------------------------------------------
  const requestedRoles = Array.isArray(body.roles)
    ? body.roles.map((r) => String(r || "").toLowerCase().trim()).filter(Boolean)
    : [];
  const isDemote = requestedRoles.length === 0;

  // All requested roles must be in the caller's allowedRoles set.
  if (!isDemote) {
    const allowed = new Set(admin.allowedRoles.map((r) => r.toLowerCase()));
    const denied = requestedRoles.filter((r) => !allowed.has(r));
    if (denied.length > 0) {
      await logAdminAction(admin, "promote_user", {
        targetUserId: targetId,
        targetEmail,
        payload: { requestedRoles, denied, allowedRoles: admin.allowedRoles },
        resultStatus: "failed",
        errorMessage: "Some requested roles are not in the caller's allowedRoles set.",
        ...meta,
      });
      return errorResponse(
        "Cannot grant roles outside ADMIN_ROLES env: " + denied.join(", "),
        403,
      );
    }
  }

  // Prevent self-demotion lockout. (Promoting yourself to add another role
  // is fine; demoting yourself isn't — that's a "shoot myself in the foot"
  // operation that should be done through the DB by another admin.)
  if (isDemote && targetId === admin.id) {
    return errorResponse(
      "You cannot demote yourself. Ask another admin to remove your role.",
      400,
    );
  }

  // ---- Call the SECURITY DEFINER RPC -----------------------------------------
  const note = typeof body.note === "string" ? body.note.slice(0, 300) : "";
  try {
    const { data, error } = await svc.rpc("admin_promote_user", {
      p_admin_user_id: admin.id,
      p_admin_email: admin.email,
      p_target_user_id: targetId,
      p_target_email: targetEmail,
      p_roles: isDemote ? null : requestedRoles,
      p_note: note,
      p_ip: meta.ip,
      p_user_agent: meta.userAgent,
    });
    if (error) throw new Error(error.message);
    return jsonResponse({
      ok: true,
      action: isDemote ? "demote_user" : "promote_user",
      auditId: data,
      target: { id: targetId, email: targetEmail, roles: isDemote ? [] : requestedRoles },
    });
  } catch (err) {
    const message = (err as Error).message || "Promote RPC failed.";
    await logAdminAction(admin, "promote_user", {
      targetUserId: targetId,
      targetEmail,
      payload: { requestedRoles, isDemote, error: message },
      resultStatus: "failed",
      errorMessage: message,
      ...meta,
    });
    return errorResponse(message, 502);
  }
});
