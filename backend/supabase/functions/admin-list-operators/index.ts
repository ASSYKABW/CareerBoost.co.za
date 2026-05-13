// GET/POST /functions/v1/admin-list-operators
// Auth: admin gate via getAuthedAdmin.
// Returns the list of users currently holding an admin-permitted role
// (anything in admin.allowedRoles, sourced from ADMIN_ROLES env).
//
// Phase C: powers the Operator Management panel in Admin Settings so
// existing admins can see who else has access without DB shell.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

function normalizedRoles(value: unknown): string[] {
  return ([] as unknown[])
    .concat(value as never)
    .map((role) => String(role || "").toLowerCase().trim())
    .filter(Boolean);
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "GET" && req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  const svc = getServiceClient();
  const warnings: string[] = [];

  // Paginate auth.users (Supabase admin API caps at 1000/page).
  const users: Array<Record<string, unknown>> = [];
  try {
    let page = 1;
    const perPage = 1000;
    for (;;) {
      const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const batch = (data?.users || []) as unknown as Array<Record<string, unknown>>;
      users.push(...batch);
      if (batch.length < perPage || users.length >= 5000) break;
      page += 1;
    }
  } catch (err) {
    warnings.push("auth.users: " + ((err as Error).message || "unable to list users"));
  }

  const allowed = new Set(admin.allowedRoles.map((r) => r.toLowerCase()));

  const operators = users
    .map((user) => {
      const roles = [
        ...normalizedRoles((user.app_metadata as Record<string, unknown> | undefined)?.role),
        ...normalizedRoles((user.app_metadata as Record<string, unknown> | undefined)?.roles),
      ];
      const dedupedRoles = Array.from(new Set(roles));
      const adminRoles = dedupedRoles.filter((r) => allowed.has(r));
      return { user, roles: dedupedRoles, adminRoles };
    })
    .filter((row) => row.adminRoles.length > 0)
    .map((row) => ({
      id: row.user.id,
      email: row.user.email || null,
      createdAt: row.user.created_at || null,
      lastSignInAt: row.user.last_sign_in_at || null,
      roles: row.roles,
      adminRoles: row.adminRoles,
      isSelf: row.user.id === admin.id,
    }))
    .sort((a, b) => {
      // Self first, then by created_at desc.
      if (a.isSelf && !b.isSelf) return -1;
      if (!a.isSelf && b.isSelf) return 1;
      const da = Date.parse(String(a.createdAt || "")) || 0;
      const db = Date.parse(String(b.createdAt || "")) || 0;
      return db - da;
    });

  return jsonResponse({
    ok: true,
    generatedAt: new Date().toISOString(),
    access: {
      adminEmail: admin.email,
      roles: admin.roles,
      allowedRoles: admin.allowedRoles,
    },
    operators,
    operatorCount: operators.length,
    warnings,
  });
});
