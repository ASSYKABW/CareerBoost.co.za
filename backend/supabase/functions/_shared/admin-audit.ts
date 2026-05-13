// Admin audit log writer — every admin mutation goes through here.
//
// Phase C foundation. Two entry points:
//   - logAdminAction(admin, action, opts) — generic write via admin_log_action RPC.
//   - extractRequestMeta(req) — pulls IP + user-agent for telemetry context.
//
// The Postgres-side admin_audit_log table enforces:
//   - action length 2..80 chars
//   - payload size <= 4096 bytes
//   - payload key blocklist (apiKey, accessToken, password, resume, etc.)
// so even a buggy caller can't accidentally leak secrets.

import { getServiceClient } from "./auth.ts";
import type { AuthedAdmin } from "./auth.ts";

// Same key blocklist as the usage tables + admin_audit_log check constraint.
// Client-side defense in addition to the DB constraint.
const DISALLOWED_KEYS = new Set([
  "apiKey", "api_key", "accessToken", "access_token", "refreshToken", "refresh_token",
  "password", "secret", "resume", "cv", "coverLetter", "cover_letter",
  "jobDescription", "job_description", "rawText", "raw_text", "html",
]);

function sanitizePayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, unknown> = {};
  Object.keys(payload).forEach((key) => {
    if (DISALLOWED_KEYS.has(key)) return;
    const v = payload[key];
    if (v == null) return;
    if (typeof v === "string") {
      // Cap individual string values at 500 chars so we never balloon the row.
      out[key] = v.length > 500 ? v.slice(0, 500) + "…" : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    } else if (Array.isArray(v)) {
      // Shallow-stringify arrays; cap at 32 items.
      out[key] = v.slice(0, 32).map((item) => {
        if (typeof item === "string") return item.slice(0, 200);
        if (typeof item === "number" || typeof item === "boolean") return item;
        try { return JSON.stringify(item).slice(0, 200); } catch { return String(item).slice(0, 200); }
      });
    } else if (typeof v === "object") {
      // One level of nesting only.
      const nested: Record<string, unknown> = {};
      Object.keys(v as Record<string, unknown>).slice(0, 16).forEach((k2) => {
        if (DISALLOWED_KEYS.has(k2)) return;
        const v2 = (v as Record<string, unknown>)[k2];
        if (typeof v2 === "string") nested[k2] = v2.length > 200 ? v2.slice(0, 200) + "…" : v2;
        else if (typeof v2 === "number" || typeof v2 === "boolean") nested[k2] = v2;
      });
      out[key] = nested;
    }
  });
  return out;
}

export interface AuditOptions {
  targetUserId?: string | null;
  targetEmail?: string | null;
  payload?: Record<string, unknown>;
  resultStatus?: "success" | "failed";
  errorMessage?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Pull client IP + user-agent from request headers. Deno Deploy sets these via
 * x-forwarded-for / x-real-ip. Returns nulls when unavailable.
 */
export function extractRequestMeta(req: Request): RequestMeta {
  const headers = req.headers;
  let ip: string | null = null;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) ip = fwd.split(",")[0].trim();
  if (!ip) ip = headers.get("x-real-ip") || null;
  // Strip surrounding brackets from IPv6 if present.
  if (ip && ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  const userAgent = (headers.get("user-agent") || "").slice(0, 500) || null;
  return { ip, userAgent };
}

/**
 * Write a row to admin_audit_log via the SECURITY DEFINER RPC.
 * Failures are swallowed (telemetry must never break the request) but
 * surfaced as `false` so callers can decide whether to add a warning.
 */
export async function logAdminAction(
  admin: AuthedAdmin,
  action: string,
  opts: AuditOptions = {},
): Promise<boolean> {
  try {
    const svc = getServiceClient();
    const payload = sanitizePayload(opts.payload);
    const { error } = await svc.rpc("admin_log_action", {
      p_admin_user_id: admin.id,
      p_admin_email: admin.email,
      p_action: action,
      p_target_user_id: opts.targetUserId || null,
      p_target_email: opts.targetEmail || null,
      p_payload: payload,
      p_result_status: opts.resultStatus || "success",
      p_error_message: opts.errorMessage || null,
      p_ip: opts.ip || null,
      p_user_agent: opts.userAgent || null,
    });
    if (error) {
      // Log to function logs so we can see it in the dashboard.
      console.error("[admin-audit] log_action failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[admin-audit] log_action threw:", (err as Error).message);
    return false;
  }
}
