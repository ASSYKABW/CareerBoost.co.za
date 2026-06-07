// POST /functions/v1/my-discount
//
// Authed. Returns the effective intro discount available to the CALLER for
// their next subscription, so the in-app banner can nudge them. Mirrors the
// resolution order in paystack-checkout:
//   1. An active per-account grant (promo_grants) — works for anyone.
//   2. Otherwise the global campaign (promo_settings), for first-time subs.
//
// Response: { ok: true, discount: { active, percent, source, endsAt } }
// (promo_grants is service-role only, so this must run server-side.)

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  const svc = getServiceClient();
  const now = new Date();
  const none = { active: false, percent: 0, source: null as string | null, endsAt: null as string | null };

  // 1. Per-account grant (highest priority).
  const { data: grant } = await svc
    .from("promo_grants")
    .select("percent, expires_at")
    .eq("user_id", user.id)
    .eq("kind", "percent")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (
    grant && Number(grant.percent) > 0 && Number(grant.percent) < 100 &&
    (!grant.expires_at || new Date(String(grant.expires_at)) > now)
  ) {
    return jsonResponse({
      ok: true,
      discount: {
        active: true,
        percent: Number(grant.percent),
        source: "grant",
        endsAt: grant.expires_at ? String(grant.expires_at) : null,
      },
    });
  }

  // 2. Global campaign for genuine first-time subscribers.
  const { data: promo } = await svc
    .from("promo_settings")
    .select("enabled, percent, end_date")
    .eq("id", 1)
    .maybeSingle();
  if (
    promo && promo.enabled && Number(promo.percent) > 0 && Number(promo.percent) < 100 &&
    (!promo.end_date || new Date(String(promo.end_date) + "T23:59:59Z") > now)
  ) {
    const { data: sub } = await svc
      .from("subscriptions")
      .select("plan_id, paystack_customer_code, stripe_customer_id, intro_discount_redeemed_at")
      .eq("user_id", user.id)
      .maybeSingle();
    const firstTime = !sub || (
      (!sub.plan_id || sub.plan_id === "free") &&
      !sub.paystack_customer_code &&
      !sub.stripe_customer_id &&
      !sub.intro_discount_redeemed_at
    );
    if (firstTime) {
      return jsonResponse({
        ok: true,
        discount: {
          active: true,
          percent: Number(promo.percent),
          source: "global",
          endsAt: promo.end_date ? String(promo.end_date) : null,
        },
      });
    }
  }

  return jsonResponse({ ok: true, discount: none });
}));
