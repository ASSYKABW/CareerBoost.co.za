// POST /functions/v1/content-track
//
// Public, unauthenticated view/click/share logging for marketing content.
// Called by the blog page (and other public content surfaces) to record an
// event into content_events. Service_role insert, CORS-open. Fire-and-forget:
// always returns ok so it never blocks the page.
//
// Body: { slug: string, event: "view"|"click"|"share", anon_id?, referrer? }

import { getServiceClient } from "../_shared/auth.ts";
import { handleOptions, withCors } from "../_shared/cors.ts";

const EVENTS = ["view", "click", "share"];

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const ok = (extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ ok: true, ...extra }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return ok({ skipped: "bad-json" }); }

  const slug = String(body.slug ?? "").trim().toLowerCase().slice(0, 200);
  const event = String(body.event ?? "").trim();
  if (!slug || !EVENTS.includes(event)) return ok({ skipped: "invalid" });

  try {
    const svc = getServiceClient();
    await svc.from("content_events").insert({
      slug,
      event,
      anon_id: body.anon_id !== undefined ? String(body.anon_id).slice(0, 64) : null,
      referrer: body.referrer !== undefined ? String(body.referrer).slice(0, 300) : null,
    });
  } catch (err) {
    // Never fail the caller for a tracking insert.
    console.error("[content-track] insert failed:", (err as Error).message);
  }
  return ok();
}));
