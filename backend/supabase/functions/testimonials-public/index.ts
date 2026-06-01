// GET /functions/v1/testimonials-public
//
// Public read endpoint. Returns approved testimonials sorted by sort_order.
// Used by the landing page to hydrate the testimonials section dynamically —
// no code deploy needed when an operator approves a new quote.
//
// Response fields are the public-safe subset (no email, no admin_note).
// Cached for 5 minutes (CDN/browser); stale-while-revalidate for smooth UX.

import { getServiceClient } from "../_shared/auth.ts";
import { handleOptions, withCors } from "../_shared/cors.ts";

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const svc = getServiceClient();
  const { data, error } = await svc
    .from("testimonials")
    .select("name, role, company, quote, avatar_url, rating")
    .eq("status", "approved")
    .order("sort_order", { ascending: true })
    .order("approved_at",  { ascending: true });

  if (error) {
    console.error("[testimonials-public] query error:", error.message);
    // Return empty list rather than 5xx — landing page degrades gracefully.
    return new Response(JSON.stringify({ ok: true, testimonials: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  const testimonials = (data ?? []).map((t) => ({
    name:       t.name,
    role:       t.role       ?? "",
    company:    t.company    ?? "",
    quote:      t.quote,
    avatar_url: t.avatar_url ?? null,
    rating:     t.rating     ?? null,
  }));

  return new Response(
    req.method === "HEAD" ? null : JSON.stringify({ ok: true, testimonials }),
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
