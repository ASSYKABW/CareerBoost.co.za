// Day 3.4: per-operator admin mutation rate-limit guard.
//
// Wraps the check_and_increment_admin_rate Postgres RPC (migration
// 0024). Atomic check-and-increment: each call to enforceAdminRate()
// reserves a slot in the operator's current 5-min bucket. If the cap
// is exceeded, returns a non-ok result with a 429-shaped error that
// the calling Edge Function should surface directly to the client.
//
// Call BEFORE the actual mutation (after admin gate + CSRF) so a
// failed rate-limit check doesn't count against the legitimate work.
// The increment is unconditional once admitted — there's no "undo on
// failure" because (a) DDoS protection only works if every attempt
// counts, and (b) it would complicate the function for marginal
// fairness benefit.
//
// Default: 30 mutations / 5 min per operator. Override via the RPC's
// internal variable (would need a migration to change).

import { getServiceClient } from "./auth.ts";
import { logAdminAction } from "./admin-audit.ts";
import type { AuthedAdmin } from "./auth.ts";

export interface AdminRateDecision {
  allowed: boolean;
  count: number;
  limit: number;
  windowSeconds: number;
  reason?: string;
}

/**
 * Atomic check + increment. Returns the decision; caller stops on
 * `!allowed` and returns a 429 response. Fails OPEN on RPC errors
 * (an outage on the rate-limit table shouldn't block legitimate
 * admin work) but logs the failure so we notice.
 *
 * Auto-logs rate-limit denials to admin_audit_log via logAdminAction
 * so we have a record of which operator hit the cap, when, and on
 * which action. Useful for forensics if a session is compromised.
 *
 * @param admin  — full AuthedAdmin so denial auto-logs to audit
 * @param action — short tag like "admin-user-adjust.grant_quota"
 */
export async function enforceAdminRate(
  admin: AuthedAdmin | string,
  action: string,
): Promise<AdminRateDecision> {
  // Backwards-compat: callers can pass either AuthedAdmin or just the
  // userId string. New callers should pass AuthedAdmin so denial gets
  // logged to admin_audit_log.
  const adminUserId = typeof admin === "string" ? admin : admin.id;
  const adminObj = typeof admin === "string" ? null : admin;

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("check_and_increment_admin_rate", {
    p_admin_user_id: adminUserId,
    p_action: action.slice(0, 80),
  });

  if (error) {
    console.warn("[admin-rate-limit] RPC failed (failing open):", error.message);
    return {
      allowed: true,
      count: 0,
      limit: 30,
      windowSeconds: 300,
    };
  }

  const d = data as {
    allowed?: boolean;
    count?: number;
    limit?: number;
    window_s?: number;
    reason?: string;
  };

  const decision: AdminRateDecision = {
    allowed: !!d.allowed,
    count: Number(d.count) || 0,
    limit: Number(d.limit) || 30,
    windowSeconds: Number(d.window_s) || 300,
    reason: d.reason,
  };

  // Auto-log denials so the audit trail captures every blocked attempt.
  // Repeated denials from one operator = either runaway script or
  // compromised session, both worth knowing about.
  if (!decision.allowed && adminObj) {
    try {
      await logAdminAction(adminObj, "rate-limit.denied", {
        targetUserId: null,
        targetEmail: null,
        resultStatus: "failed",
        errorMessage: decision.reason || "Rate limit exceeded",
        payload: {
          attemptedAction: action,
          count: decision.count,
          limit: decision.limit,
          windowSeconds: decision.windowSeconds,
        },
      });
    } catch (_e) {
      // Log failure of the log itself shouldn't break the denial flow.
    }
  }

  return decision;
}
