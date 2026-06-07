// POST /functions/v1/admin-promo
//
// Admin-only read/update of the promotions config. Requires admin role +
// AAL2 (getAuthedAdmin), like all admin edge functions.
//
// Actions:
//   get     — return the singleton promo_settings row
//   update  — patch enabled / percent / end_date / plans / intervals
//
// The paystack-checkout function reads promo_settings at runtime and the
// public site reads it for the banner, so changes here go live with no
// deploy. (Phase 2 will add per-account grant/revoke actions here.)

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const VALID_PLANS = ["plus", "pro", "career"];
const VALID_INTERVALS = ["monthly", "annual"];

function cleanList(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).toLowerCase().trim();
    if (allowed.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// Resolve a user id from an email. Supabase admin has no getByEmail, so we
// page through listUsers and match client-side (same as admin-promote-user).
async function resolveUserIdByEmail(
  svc: ReturnType<typeof getServiceClient>,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase().trim();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error("User lookup failed: " + error.message);
    const batch = ((data?.users || []) as unknown) as Array<Record<string, unknown>>;
    const hit = batch.find((u) => String(u.email || "").toLowerCase() === target);
    if (hit) return String(hit.id || "");
    if (batch.length < perPage) break;
    if (page * perPage >= 5000) break;
    page += 1;
  }
  return null;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    return errorResponse((err as Error).message, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const action = String(body.action ?? "get");
  const svc = getServiceClient();

  // ── get ───────────────────────────────────────────────────────────────
  if (action === "get") {
    const { data, error } = await svc
      .from("promo_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) return errorResponse("Failed to load promo settings: " + error.message, 500);
    return jsonResponse({ ok: true, promo: data });
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === "update") {
    const patch: Record<string, unknown> = {};

    if (body.enabled !== undefined) {
      patch.enabled = body.enabled === true || body.enabled === "true";
    }
    if (body.percent !== undefined) {
      // Clamp into range rather than reject — keeps the save robust against
      // an empty/NaN read from the form.
      let n = Math.round(Number(body.percent));
      if (!Number.isFinite(n)) n = 30;
      patch.percent = Math.min(99, Math.max(1, n));
    }
    if (body.end_date !== undefined) {
      // Accept any parseable date (incl. locale formats like "10/06/2026")
      // and normalize to YYYY-MM-DD; blank/unparseable → no end date.
      const s = String(body.end_date ?? "").trim();
      if (s === "") {
        patch.end_date = null;
      } else {
        const d = new Date(s);
        patch.end_date = Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      }
    }
    if (body.plans !== undefined) {
      const plans = cleanList(body.plans, VALID_PLANS);
      if (plans.length === 0) return errorResponse("Select at least one plan.", 400);
      patch.plans = plans;
    }
    if (body.intervals !== undefined) {
      const intervals = cleanList(body.intervals, VALID_INTERVALS);
      if (intervals.length === 0) return errorResponse("Select at least one billing interval.", 400);
      patch.intervals = intervals;
    }

    if (Object.keys(patch).length === 0) {
      return errorResponse("No editable fields supplied.", 400);
    }
    patch.updated_at = new Date().toISOString();
    patch.updated_by = admin.id;

    // Upsert keeps it robust even if the seed row is somehow missing.
    const { error } = await svc
      .from("promo_settings")
      .upsert({ id: 1, ...patch }, { onConflict: "id" });
    if (error) return errorResponse("Promo update failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── grants-list ─────────────────────────────────────────────────────────
  if (action === "grants-list") {
    const { data, error } = await svc
      .from("promo_grants")
      .select("id, user_id, percent, status, note, expires_at, redeemed_at, created_at")
      .eq("kind", "percent")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return errorResponse("Failed to list grants: " + error.message, 500);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const grants: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      let email = "";
      try {
        const { data: u } = await svc.auth.admin.getUserById(String(r.user_id));
        email = String(u?.user?.email || "");
      } catch (_e) { /* leave blank if the user was deleted */ }
      grants.push({ ...r, email });
    }
    return jsonResponse({ ok: true, grants });
  }

  // ── grant-create ────────────────────────────────────────────────────────
  if (action === "grant-create") {
    const email = String(body.email ?? "").toLowerCase().trim();
    if (!email || email.indexOf("@") < 0) return errorResponse("A valid email is required.", 400);

    const pct = Math.round(Number(body.percent));
    if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
      return errorResponse("percent must be between 1 and 99.", 400);
    }

    let expiresAt: string | null = null;
    const exp = String(body.expires_at ?? "").trim();
    if (exp !== "") {
      const d = new Date(exp);
      if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
    }

    let userId: string | null;
    try {
      userId = await resolveUserIdByEmail(svc, email);
    } catch (e) {
      return errorResponse((e as Error).message, 502);
    }
    if (!userId) return errorResponse("No account found with that email.", 404);

    const { error } = await svc.from("promo_grants").insert({
      user_id: userId,
      kind: "percent",
      percent: pct,
      note: body.note ? String(body.note).slice(0, 200) : null,
      granted_by: admin.id,
      expires_at: expiresAt,
      status: "active",
    });
    if (error) return errorResponse("Grant failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── grant-revoke ────────────────────────────────────────────────────────
  if (action === "grant-revoke") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("Grant id required.", 400);
    const { error } = await svc
      .from("promo_grants")
      .update({ status: "revoked" })
      .eq("id", id)
      .eq("status", "active");
    if (error) return errorResponse("Revoke failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
