// POST /functions/v1/admin-testimonials
//
// Admin-only CRUD for the testimonials table.
// Requires admin role + AAL2 (same as all admin edge functions).
//
// Actions:
//   list    — return all rows (all statuses, pending first)
//   update  — edit name / role / company / quote / sort_order / admin_note
//   approve — set status=approved, approved_at=now()
//   reject  — set status=rejected, optional admin_note
//   delete  — hard delete

import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

type Action = "list" | "update" | "approve" | "reject" | "delete";

const STATUS_ORDER: Record<string, number> = { pending: 0, approved: 1, rejected: 2 };

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedAdmin(req);
  } catch (err) {
    return errorResponse((err as Error).message, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const action = String(body.action ?? "") as Action;
  const svc = getServiceClient();

  // ── list ────────────────────────────────────────────────────────────
  if (action === "list") {
    const { data, error } = await svc
      .from("testimonials")
      .select("*")
      .order("submitted_at", { ascending: false });
    if (error) return errorResponse("Failed to load testimonials: " + error.message, 500);

    const sorted = [...(data ?? [])].sort(
      (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
    );
    return jsonResponse({ ok: true, testimonials: sorted });
  }

  // ── update ──────────────────────────────────────────────────────────
  if (action === "update") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);

    const patch: Record<string, unknown> = {};
    if (body.name        !== undefined) patch.name        = String(body.name).trim();
    if (body.role        !== undefined) patch.role        = String(body.role).trim();
    if (body.company     !== undefined) patch.company     = String(body.company).trim();
    if (body.quote       !== undefined) patch.quote       = String(body.quote).trim();
    if (body.sort_order  !== undefined) patch.sort_order  = Number(body.sort_order) || 0;
    if (body.admin_note  !== undefined) patch.admin_note  = String(body.admin_note).trim() || null;

    if (patch.quote && String(patch.quote).length < 10) {
      return errorResponse("Quote is too short.", 400);
    }

    const { error } = await svc.from("testimonials").update(patch).eq("id", id);
    if (error) return errorResponse("Update failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── approve ─────────────────────────────────────────────────────────
  if (action === "approve") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);
    const { error } = await svc.from("testimonials").update({
      status: "approved",
      approved_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return errorResponse("Approve failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── reject ───────────────────────────────────────────────────────────
  if (action === "reject") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);
    const patch: Record<string, unknown> = { status: "rejected" };
    if (body.admin_note) patch.admin_note = String(body.admin_note).trim();
    const { error } = await svc.from("testimonials").update(patch).eq("id", id);
    if (error) return errorResponse("Reject failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── delete ───────────────────────────────────────────────────────────
  if (action === "delete") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);
    const { error } = await svc.from("testimonials").delete().eq("id", id);
    if (error) return errorResponse("Delete failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  return errorResponse("Unknown action: " + String(action), 400);
});
