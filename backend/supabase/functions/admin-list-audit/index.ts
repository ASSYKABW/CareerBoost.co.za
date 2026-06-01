// POST/GET /functions/v1/admin-list-audit
// Body: { page?: number, perPage?: number, action?: string, adminEmail?: string, targetEmail?: string, since?: ISO, until?: ISO }
// Auth: admin gate via getAuthedAdmin.
//
// Paginated read over admin_audit_log. The table has full audit trail
// for every admin mutation (promote/demote/incident-ack/resolve/etc).
// All fields are operational metadata only — privacy guard at the DB
// blocks sensitive keys from being written in the first place.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

interface Body {
  page?: number;
  perPage?: number;
  action?: string;
  adminEmail?: string;
  targetEmail?: string;
  since?: string;
  until?: string;
}

const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 50;

Deno.serve(withCors(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  let body: Body = {};
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Body;
    } catch {
      body = {};
    }
  }

  const page = Math.max(1, Number(body.page) || 1);
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, Number(body.perPage) || DEFAULT_PER_PAGE));
  const actionFilter = (body.action || "").toString().toLowerCase().trim();
  const adminEmailFilter = (body.adminEmail || "").toString().toLowerCase().trim();
  const targetEmailFilter = (body.targetEmail || "").toString().toLowerCase().trim();
  const since = (body.since || "").toString().trim();
  const until = (body.until || "").toString().trim();

  const svc = getServiceClient();
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let query = svc
    .from("admin_audit_log")
    .select(
      "id, admin_user_id, admin_email, action, target_user_id, target_email, payload, result_status, error_message, ip_address, user_agent, occurred_at",
      { count: "exact" },
    )
    .order("occurred_at", { ascending: false })
    .range(from, to);

  if (actionFilter) query = query.ilike("action", "%" + actionFilter + "%");
  if (adminEmailFilter) query = query.ilike("admin_email", "%" + adminEmailFilter + "%");
  if (targetEmailFilter) query = query.ilike("target_email", "%" + targetEmailFilter + "%");
  if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) query = query.gte("occurred_at", since);
  if (until && /^\d{4}-\d{2}-\d{2}/.test(until)) query = query.lte("occurred_at", until);

  const { data, error, count } = await query;
  if (error) {
    return errorResponse("Failed to read audit log: " + error.message, 502);
  }

  const total = typeof count === "number" ? count : (data || []).length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  // Action mix for the summary chip strip.
  let actionMix: Array<{ action: string; count: number }> = [];
  try {
    const { data: mixData, error: mixError } = await svc
      .from("admin_audit_log")
      .select("action")
      .gte("occurred_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(2000);
    if (!mixError && Array.isArray(mixData)) {
      const counts: Record<string, number> = {};
      (mixData as Array<{ action?: string }>).forEach((row) => {
        const k = String(row.action || "unknown");
        counts[k] = (counts[k] || 0) + 1;
      });
      actionMix = Object.keys(counts)
        .map((k) => ({ action: k, count: counts[k] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
    }
  } catch {
    /* mix is best-effort */
  }

  return jsonResponse({
    ok: true,
    generatedAt: new Date().toISOString(),
    access: {
      adminEmail: admin.email,
      roles: admin.roles,
      allowedRoles: admin.allowedRoles,
    },
    page: {
      page,
      perPage,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      action: actionFilter,
      adminEmail: adminEmailFilter,
      targetEmail: targetEmailFilter,
      since,
      until,
    },
    entries: data || [],
    actionMix,
  });
}));
