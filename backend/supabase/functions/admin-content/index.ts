// POST /functions/v1/admin-content
//
// Admin-only CRUD for content_pieces (the marketing content lifecycle).
// Requires admin role + AAL2 (getAuthedAdmin). Phase 0 is manual CRUD only —
// the AI "generate" action lands in Phase 1.
//
// Actions:
//   list        — return rows (optional status / type filters), newest first
//   get         — return one row by id
//   create      — insert a draft
//   update      — patch editable fields
//   set-status  — move through the lifecycle (sets published_at / reviewed_by)
//   delete      — hard delete

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const TYPES = [
  "blog", "social_linkedin", "social_x", "social_ig",
  "newsletter", "announcement", "push", "landing_variant",
  "landing_seo",
];
const STATUSES = [
  "draft", "needs_review", "approved", "scheduled", "published", "archived",
];

function clampStr(v: unknown, max: number): string {
  return String(v ?? "").slice(0, max);
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

  const action = String(body.action ?? "");
  const svc = getServiceClient();

  // ── scorecard (Phase 4 attribution) ───────────────────────────────────
  if (action === "scorecard") {
    const { data, error } = await svc.rpc("marketing_content_scorecard");
    if (error) return errorResponse("Scorecard failed: " + error.message, 500);
    return jsonResponse({ ok: true, scorecard: data ?? [] });
  }

  // ── list ────────────────────────────────────────────────────────────
  if (action === "list") {
    let q = svc.from("content_pieces")
      .select("id, type, title, slug, excerpt, status, channel, scheduled_at, published_at, created_by, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (body.status && STATUSES.includes(String(body.status))) q = q.eq("status", String(body.status));
    if (body.type && TYPES.includes(String(body.type))) q = q.eq("type", String(body.type));
    const { data, error } = await q;
    if (error) return errorResponse("Failed to load content: " + error.message, 500);
    return jsonResponse({ ok: true, content: data ?? [] });
  }

  // ── get ─────────────────────────────────────────────────────────────
  if (action === "get") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);
    const { data, error } = await svc.from("content_pieces").select("*").eq("id", id).maybeSingle();
    if (error) return errorResponse("Failed to load piece: " + error.message, 500);
    if (!data) return errorResponse("Not found.", 404);
    return jsonResponse({ ok: true, piece: data });
  }

  // ── create ──────────────────────────────────────────────────────────
  if (action === "create") {
    const type = TYPES.includes(String(body.type)) ? String(body.type) : "blog";
    const row: Record<string, unknown> = {
      type,
      title: clampStr(body.title, 240).trim(),
      body: clampStr(body.body, 200_000),
      excerpt: clampStr(body.excerpt, 600).trim(),
      channel: body.channel !== undefined ? clampStr(body.channel, 80).trim() || null : null,
      // AI-generated drafts land in needs_review; manual ones default to draft.
      status: STATUSES.includes(String(body.status)) ? String(body.status) : "draft",
      created_by: String(body.created_by) === "ai" ? "ai" : "operator",
    };
    if (body.slug !== undefined) {
      const slug = clampStr(body.slug, 200).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (slug) row.slug = slug;
    }
    if (body.seo && typeof body.seo === "object") row.seo = body.seo;
    if (body.prompt_version !== undefined) row.prompt_version = clampStr(body.prompt_version, 80);
    if (body.source_data && typeof body.source_data === "object") row.source_data = body.source_data;
    const { data, error } = await svc.from("content_pieces").insert(row).select().maybeSingle();
    if (error) return errorResponse("Create failed: " + error.message, 500);
    return jsonResponse({ ok: true, piece: data });
  }

  // ── update ──────────────────────────────────────────────────────────
  if (action === "update") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);
    const patch: Record<string, unknown> = {};
    if (body.type !== undefined && TYPES.includes(String(body.type))) patch.type = String(body.type);
    if (body.title !== undefined) patch.title = clampStr(body.title, 240).trim();
    if (body.body !== undefined) patch.body = clampStr(body.body, 200_000);
    if (body.excerpt !== undefined) patch.excerpt = clampStr(body.excerpt, 600).trim();
    if (body.channel !== undefined) patch.channel = clampStr(body.channel, 80).trim() || null;
    if (body.og_image_url !== undefined) patch.og_image_url = clampStr(body.og_image_url, 500).trim() || null;
    if (body.seo !== undefined && body.seo && typeof body.seo === "object") patch.seo = body.seo;
    if (body.slug !== undefined) {
      const slug = clampStr(body.slug, 200).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      patch.slug = slug || null;
    }
    if (Object.keys(patch).length === 0) return errorResponse("No editable fields supplied.", 400);
    patch.updated_at = new Date().toISOString();
    const { error } = await svc.from("content_pieces").update(patch).eq("id", id);
    if (error) return errorResponse("Update failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── set-status ────────────────────────────────────────────────────────
  if (action === "set-status") {
    const id = String(body.id ?? "").trim();
    const status = String(body.status ?? "");
    if (!id) return errorResponse("id is required.", 400);
    if (!STATUSES.includes(status)) return errorResponse("Invalid status.", 400);
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (status === "scheduled") {
      const at = String(body.scheduled_at ?? "").trim();
      if (!at) return errorResponse("scheduled_at is required to schedule.", 400);
      patch.scheduled_at = at;
    }
    if (status === "published") patch.published_at = new Date().toISOString();
    if (status === "approved" || status === "published") patch.reviewed_by = admin.id;
    const { error } = await svc.from("content_pieces").update(patch).eq("id", id);
    if (error) return errorResponse("Status change failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── delete ──────────────────────────────────────────────────────────
  if (action === "delete") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("id is required.", 400);
    const { error } = await svc.from("content_pieces").delete().eq("id", id);
    if (error) return errorResponse("Delete failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
