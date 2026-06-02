// GET /functions/v1/content-public
//
// Public read endpoint for the marketing engine. Returns the published brand
// config so the site can hydrate branding dynamically (no deploy needed to
// change the wordmark/tagline/colors). Phase 3 extends this to also return
// published content pieces (blog/announcements).
//
// Mirrors testimonials-public: service_role read, CORS-open, cached.

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

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  let brand = BRAND_FALLBACK;
  try {
    const svc = getServiceClient();
    const { data, error } = await svc
      .from("brand_settings")
      .select("wordmark, tagline, primary_color, accent_color, logo_variant, og_image_url")
      .eq("id", "default")
      .maybeSingle();
    if (!error && data) brand = { ...BRAND_FALLBACK, ...data };
  } catch (err) {
    console.error("[content-public] brand read failed:", (err as Error).message);
    // Fall through with BRAND_FALLBACK — the site always gets a usable brand.
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
