// POST /functions/v1/password-recovery-update
//
// Updates the caller's password using service-role privileges.
//
// Why this exists: Supabase rejects client-side `updateUser({password})`
// with "AAL2 session is required" when the project has MFA enforcement
// turned on. That makes password RESET impossible — by definition the
// recovery session is AAL1 (just email proof). A user who lost their
// MFA device AND forgot their password could never recover.
//
// This endpoint takes the user's recovery JWT, identifies them via
// auth.uid(), then uses service-role admin API to set their password.
// The security model: holding a valid recovery JWT == proof of email
// control == sufficient for password reset. That's the same security
// posture every other SaaS uses (Stripe, GitHub, etc.).
//
// Body: { password: string }
// Auth: Any valid JWT (recovery sessions included).

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

interface Body {
  password?: string;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // ---- Authenticate the caller ----
  // We use getAuthedUser which validates the JWT (recovery sessions
  // are valid JWTs — they just have a low AAL). The user.id we get
  // back is the account being recovered.
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length < 10) {
    return errorResponse("Password must be at least 10 characters.", 400);
  }
  if (password.length > 200) {
    return errorResponse("Password too long.", 400);
  }
  // Mirror the client-side checks defensively — the UI enforces these
  // but a direct API caller shouldn't be able to bypass them.
  if (!/[A-Za-z]/.test(password)) {
    return errorResponse("Password must contain a letter.", 400);
  }
  if (!/\d/.test(password)) {
    return errorResponse("Password must contain a number.", 400);
  }
  const commonBlocklist = [
    "password", "password1", "qwerty", "12345678",
    "1234567890", "letmein", "iloveyou", "abc12345",
  ];
  if (commonBlocklist.indexOf(password.toLowerCase()) >= 0) {
    return errorResponse("That password is too common. Choose a stronger one.", 400);
  }

  // ---- Apply the update via service-role ----
  // admin.updateUserById bypasses the AAL2 client gate because it's
  // running with service-role privileges. The auth check above (a
  // valid JWT that resolved to user.id) is what authorizes this.
  const svc = getServiceClient();
  try {
    const { error } = await svc.auth.admin.updateUserById(user.id, { password });
    if (error) {
      console.error("[password-recovery-update] updateUserById failed:", error.message, "userId=", user.id);
      return errorResponse("Couldn't update password: " + error.message, 502);
    }
  } catch (err) {
    console.error("[password-recovery-update] updateUserById threw:", err);
    return errorResponse("Couldn't update password: " + (err as Error).message, 502);
  }

  console.log("[password-recovery-update] success for user", user.id);
  return jsonResponse({ ok: true, updated: true });
}));
