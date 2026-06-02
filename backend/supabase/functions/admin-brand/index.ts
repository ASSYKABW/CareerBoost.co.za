// POST /functions/v1/admin-brand
//
// Admin-only read/update of the singleton brand_settings row.
// Requires admin role + AAL2 (getAuthedAdmin), like all admin edge functions.
//
// Actions:
//   get     — return the brand_settings row
//   update  — patch wordmark / tagline / colors / logo_variant / og_image_url / voice_tone

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

function normalizeColor(value: unknown, fallback: string): string {
  const s = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : fallback;
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
      .from("brand_settings")
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (error) return errorResponse("Failed to load brand: " + error.message, 500);
    return jsonResponse({ ok: true, brand: data });
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === "update") {
    const patch: Record<string, unknown> = {};
    if (body.wordmark !== undefined) {
      patch.wordmark = String(body.wordmark).trim().slice(0, 80) || "CareerBoost";
    }
    if (body.tagline !== undefined) {
      patch.tagline = String(body.tagline).trim().slice(0, 120);
    }
    if (body.primary_color !== undefined) {
      patch.primary_color = normalizeColor(body.primary_color, "#7cf0ff");
    }
    if (body.accent_color !== undefined) {
      patch.accent_color = normalizeColor(body.accent_color, "#a888ff");
    }
    if (body.logo_variant !== undefined) {
      const v = String(body.logo_variant);
      patch.logo_variant = ["mark", "wordmark", "full"].includes(v) ? v : "full";
    }
    if (body.og_image_url !== undefined) {
      patch.og_image_url = String(body.og_image_url).trim() || null;
    }
    if (body.voice_tone !== undefined && body.voice_tone && typeof body.voice_tone === "object") {
      patch.voice_tone = body.voice_tone;
    }

    if (Object.keys(patch).length === 0) {
      return errorResponse("No editable fields supplied.", 400);
    }
    patch.updated_at = new Date().toISOString();
    patch.updated_by = admin.id;

    const { error } = await svc.from("brand_settings").update(patch).eq("id", "default");
    if (error) return errorResponse("Brand update failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
