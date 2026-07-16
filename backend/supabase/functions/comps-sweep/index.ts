// POST /functions/v1/comps-sweep
//
// Expires lapsed free-month comps. Cron-only (X-Cron-Secret) — no user auth.
//
// WHY THIS EXISTS
// Nothing in the entitlement path checks an end date: get_user_entitlements
// maps subscriptions.plan_id → plan_catalog.limits, and job-scout's planTier
// reads plan_id + status='active'. Paid plans only ever get demoted because
// the Stripe/PayStack webhooks flip them back when billing stops. A comp has
// no processor and therefore no webhook — so without this sweep an admin's
// "1 free month of Pro" would silently last forever.
//
// A comp is identified as: plan_id <> 'free', no processor linkage at all, and
// a current_period_end in the past. Those are demoted to free, and their
// promo_grants rows are marked expired. Real paid subscriptions are never
// touched (they always carry a processor id).
//
// Body: { dryRun?: boolean } — dryRun reports what it would do, changing nothing.

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

// Reuses the cron secret the existing job-scout workflows already use, so this
// needs no new Supabase/GitHub secret to start working.
function cronSecretFromEnv(): string {
  return (
    Deno.env.get("COMPS_SWEEP_CRON_SECRET") ||
    Deno.env.get("JOB_SCOUT_CRON_SECRET") ||
    Deno.env.get("CRON_SECRET") ||
    ""
  ).trim();
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const expected = cronSecretFromEnv();
  const provided = (req.headers.get("X-Cron-Secret") || "").trim();
  if (!expected || !provided || provided !== expected) {
    return errorResponse("Unauthorized.", 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* body optional */ }
  const dryRun = body.dryRun === true;

  const svc = getServiceClient();
  const nowIso = new Date().toISOString();

  // Lapsed comps: a non-free plan, no processor behind it, period end in the past.
  const { data, error } = await svc
    .from("subscriptions")
    .select("user_id, plan_id, current_period_end")
    .neq("plan_id", "free")
    .is("payment_processor", null)
    .is("stripe_subscription_id", null)
    .is("paystack_subscription_code", null)
    .not("current_period_end", "is", null)
    .lt("current_period_end", nowIso)
    .limit(500);
  if (error) return errorResponse("Sweep lookup failed: " + error.message, 500);

  const rows = (data || []) as Array<Record<string, unknown>>;
  const userIds = rows.map((r) => String(r.user_id));
  const sample = rows.slice(0, 20).map((r) => ({
    user_id: String(r.user_id),
    plan_id: String(r.plan_id ?? ""),
    ended: String(r.current_period_end ?? ""),
  }));

  if (dryRun || userIds.length === 0) {
    return jsonResponse({ ok: true, dryRun: dryRun, expired: userIds.length, sample });
  }

  const { error: demoteErr } = await svc
    .from("subscriptions")
    .update({
      plan_id: "free",
      status: "active",
      current_period_end: null,
      cancel_at_period_end: false,
      updated_at: nowIso,
    })
    .in("user_id", userIds);
  if (demoteErr) return errorResponse("Demote failed: " + demoteErr.message, 500);

  // Close out the grant rows so the Promo Center stops showing them as active.
  const { error: grantErr } = await svc
    .from("promo_grants")
    .update({ status: "expired" })
    .eq("kind", "free_months")
    .eq("status", "active")
    .in("user_id", userIds)
    .lt("expires_at", nowIso);
  if (grantErr) {
    // Plans are already demoted (the thing that matters); report but don't fail.
    return jsonResponse({ ok: true, expired: userIds.length, sample, grantUpdateError: grantErr.message });
  }

  return jsonResponse({ ok: true, expired: userIds.length, sample });
}));
