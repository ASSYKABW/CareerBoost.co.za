// POST /functions/v1/push-send
//
// Sends PWA Web Push notifications. Uses the battle-tested `web-push` library
// (VAPID + RFC 8291 payload encryption) so we don't hand-roll crypto.
//
// Body:
//   { action: "stats" }                         → { ok, subscribers, paused }
//   { action: "pause", paused: bool }           → toggle the kill-switch
//   { action: "send", title, body, url?, tag?,  → broadcast / targeted send
//     segment?: "all"|"users", userIds?: [] }
//
// Auth: admin JWT (manual send from the console) OR X-Cron-Secret == CRON_SECRET
// (for future automated triggers). Gated behind configured VAPID secrets AND
// brand_settings.push_paused = false. Dead subscriptions (404/410) are pruned.

import webpush from "npm:web-push@3.6.7";
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const MAX_PER_RUN = Number(Deno.env.get("PUSH_MAX") || "2000");

function vapidConfigured(): boolean {
  return !!(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY"));
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // Auth: cron secret OR admin JWT. Accept the Job Scout secret too, so the
  // job-scout cron runner can fire "your agent found N roles" pushes without a
  // separate shared secret.
  const provided = (req.headers.get("X-Cron-Secret") || "").trim();
  const cronSecrets = [Deno.env.get("CRON_SECRET"), Deno.env.get("JOB_SCOUT_CRON_SECRET")]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  if (!(provided && cronSecrets.includes(provided))) {
    try { await getAuthedAdmin(req); } catch (err) { return errorResponse((err as Error).message || "Unauthorized", 403); }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || "send");
  const svc = getServiceClient();

  if (action === "stats") {
    const { count } = await svc.from("push_subscriptions").select("id", { count: "exact", head: true });
    const { data: bs } = await svc.from("brand_settings").select("push_paused").eq("id", "default").maybeSingle();
    return jsonResponse({ ok: true, subscribers: count ?? 0, paused: !!(bs && bs.push_paused) });
  }

  if (action === "pause") {
    const paused = body.paused === true;
    const { error } = await svc.from("brand_settings").update({ push_paused: paused }).eq("id", "default");
    if (error) return errorResponse("Could not update pause state: " + error.message, 500);
    return jsonResponse({ ok: true, paused });
  }

  // ── send ──────────────────────────────────────────────────────────────
  if (!vapidConfigured()) {
    return errorResponse("Push not configured. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (and VAPID_SUBJECT) secrets.", 503);
  }
  const { data: bs } = await svc.from("brand_settings").select("push_paused").eq("id", "default").maybeSingle();
  if (bs && bs.push_paused) {
    return jsonResponse({ ok: true, paused: true, note: "Push paused by operator (brand_settings.push_paused)." });
  }

  const title = String(body.title || "").trim();
  const message = String(body.body || "").trim();
  if (!title) return errorResponse("title is required.", 400);

  const payload = JSON.stringify({
    title: title.slice(0, 120),
    body: message.slice(0, 300),
    url: String(body.url || "/").slice(0, 500),
    tag: body.tag ? String(body.tag).slice(0, 60) : undefined,
  });

  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") || "mailto:hello@careerboost.co.za",
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!,
  );

  // Target audience.
  let q = svc.from("push_subscriptions").select("id, endpoint, p256dh, auth, failure_count").limit(MAX_PER_RUN);
  const segment = String(body.segment || "all");
  if (segment === "users" && Array.isArray(body.userIds) && body.userIds.length) {
    q = q.in("user_id", (body.userIds as unknown[]).map(String).slice(0, 1000));
  }
  const { data: subs, error } = await q;
  if (error) return errorResponse("Could not load subscriptions: " + error.message, 500);

  let sent = 0, failed = 0, pruned = 0;
  for (const s of (subs ?? []) as SubRow[]) {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 * 60 * 24, timeout: 10000 });
      sent++;
      if (s.failure_count > 0) {
        await svc.from("push_subscriptions").update({ failure_count: 0, last_active_at: new Date().toISOString() }).eq("id", s.id);
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 0;
      if (status === 404 || status === 410) {
        // Gone — the subscription expired or was revoked. Prune it.
        await svc.from("push_subscriptions").delete().eq("id", s.id);
        pruned++;
      } else {
        failed++;
        const fc = (s.failure_count || 0) + 1;
        if (fc >= 5) { await svc.from("push_subscriptions").delete().eq("id", s.id); pruned++; }
        else { await svc.from("push_subscriptions").update({ failure_count: fc }).eq("id", s.id); }
        console.error("[push-send] failed", status, (err as Error).message);
      }
    }
  }

  return jsonResponse({ ok: true, sent, failed, pruned, total: (subs ?? []).length });
}));
