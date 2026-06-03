// GET /functions/v1/content-public
//
// Public read endpoint for the marketing engine. Service_role read, CORS-open,
// cached. Query param `resource` selects what to return:
//   (none) | brand   — the published brand config (site hydration)
//   posts            — published blog posts (list, newest first)
//   post&slug=<slug> — a single published blog post (full body)
//   announcements    — active published announcements (in-app banner)
//
// Mirrors testimonials-public.

import { getServiceClient } from "../_shared/auth.ts";
import { handleOptions, withCors } from "../_shared/cors.ts";

const BRAND_FALLBACK = {
  wordmark: "CareerBoost",
  tagline: "BUILT FOR AMBITION",
  primary_color: "#7cf0ff",
  accent_color: "#a888ff",
  logo_variant: "full",
  og_image_url: null as string | null,
};

function jsonOut(payload: unknown, maxAge = 300): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=60`,
    },
  });
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const resource = (url.searchParams.get("resource") || "brand").toLowerCase();
  const svc = getServiceClient();

  // ── published blog posts (list) ──────────────────────────────────────
  if (resource === "posts") {
    try {
      const { data, error } = await svc
        .from("content_pieces")
        .select("title, slug, excerpt, og_image_url, published_at, seo")
        .eq("type", "blog")
        .eq("status", "published")
        .not("slug", "is", null)
        .order("published_at", { ascending: false })
        .limit(60);
      if (error) throw error;
      return jsonOut({ ok: true, posts: data ?? [] });
    } catch (err) {
      console.error("[content-public] posts:", (err as Error).message);
      return jsonOut({ ok: true, posts: [] });
    }
  }

  // ── single published blog post ───────────────────────────────────────
  if (resource === "post") {
    const slug = (url.searchParams.get("slug") || "").trim().toLowerCase();
    if (!slug) return jsonOut({ ok: false, error: "slug required", post: null });
    try {
      const { data, error } = await svc
        .from("content_pieces")
        .select("title, slug, body, excerpt, og_image_url, published_at, seo")
        .eq("type", "blog")
        .eq("status", "published")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return jsonOut({ ok: true, post: data ?? null });
    } catch (err) {
      console.error("[content-public] post:", (err as Error).message);
      return jsonOut({ ok: true, post: null });
    }
  }

  // ── active in-app announcements ──────────────────────────────────────
  if (resource === "announcements") {
    try {
      const { data, error } = await svc
        .from("content_pieces")
        .select("id, title, body, published_at")
        .eq("type", "announcement")
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(3);
      if (error) throw error;
      return jsonOut({ ok: true, announcements: data ?? [] }, 120);
    } catch (err) {
      console.error("[content-public] announcements:", (err as Error).message);
      return jsonOut({ ok: true, announcements: [] }, 120);
    }
  }

  // ── default: published brand config ──────────────────────────────────
  let brand = BRAND_FALLBACK;
  try {
    const { data, error } = await svc
      .from("brand_settings")
      .select("wordmark, tagline, primary_color, accent_color, logo_variant, og_image_url")
      .eq("id", "default")
      .maybeSingle();
    if (!error && data) brand = { ...BRAND_FALLBACK, ...data };
  } catch (err) {
    console.error("[content-public] brand read failed:", (err as Error).message);
  }
  return new Response(
    req.method === "HEAD" ? null : JSON.stringify({ ok: true, brand }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
      },
    },
  );
}));
