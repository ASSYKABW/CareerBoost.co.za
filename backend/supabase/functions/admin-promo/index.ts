// POST /functions/v1/admin-promo
//
// Admin-only read/update of the promotions config. Requires admin role +
// AAL2 (getAuthedAdmin), like all admin edge functions.
//
// Actions:
//   get     — return the singleton promo_settings row
//   update  — patch enabled / percent / end_date / plans / intervals
//
// The paystack-checkout function reads promo_settings at runtime and the
// public site reads it for the banner, so changes here go live with no
// deploy. (Phase 2 will add per-account grant/revoke actions here.)

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const VALID_PLANS = ["plus", "pro", "career"];
const VALID_INTERVALS = ["monthly", "annual"];

function cleanList(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).toLowerCase().trim();
    if (allowed.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// Resolve a user id from an email. Supabase admin has no getByEmail, so we
// page through listUsers and match client-side (same as admin-promote-user).
async function resolveUserIdByEmail(
  svc: ReturnType<typeof getServiceClient>,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase().trim();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error("User lookup failed: " + error.message);
    const batch = ((data?.users || []) as unknown) as Array<Record<string, unknown>>;
    const hit = batch.find((u) => String(u.email || "").toLowerCase() === target);
    if (hit) return String(hit.id || "");
    if (batch.length < perPage) break;
    if (page * perPage >= 5000) break;
    page += 1;
  }
  return null;
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
      .from("promo_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) return errorResponse("Failed to load promo settings: " + error.message, 500);
    return jsonResponse({ ok: true, promo: data });
  }

  // ── update ────────────────────────────────────────────────────────────
  if (action === "update") {
    const patch: Record<string, unknown> = {};

    if (body.enabled !== undefined) {
      patch.enabled = body.enabled === true || body.enabled === "true";
    }
    if (body.percent !== undefined) {
      // Clamp into range rather than reject — keeps the save robust against
      // an empty/NaN read from the form.
      let n = Math.round(Number(body.percent));
      if (!Number.isFinite(n)) n = 30;
      patch.percent = Math.min(99, Math.max(1, n));
    }
    if (body.end_date !== undefined) {
      // Accept any parseable date (incl. locale formats like "10/06/2026")
      // and normalize to YYYY-MM-DD; blank/unparseable → no end date.
      const s = String(body.end_date ?? "").trim();
      if (s === "") {
        patch.end_date = null;
      } else {
        const d = new Date(s);
        patch.end_date = Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      }
    }
    if (body.plans !== undefined) {
      const plans = cleanList(body.plans, VALID_PLANS);
      if (plans.length === 0) return errorResponse("Select at least one plan.", 400);
      patch.plans = plans;
    }
    if (body.intervals !== undefined) {
      const intervals = cleanList(body.intervals, VALID_INTERVALS);
      if (intervals.length === 0) return errorResponse("Select at least one billing interval.", 400);
      patch.intervals = intervals;
    }

    if (Object.keys(patch).length === 0) {
      return errorResponse("No editable fields supplied.", 400);
    }
    patch.updated_at = new Date().toISOString();
    patch.updated_by = admin.id;

    // Upsert keeps it robust even if the seed row is somehow missing.
    const { error } = await svc
      .from("promo_settings")
      .upsert({ id: 1, ...patch }, { onConflict: "id" });
    if (error) return errorResponse("Promo update failed: " + error.message, 500);
    return jsonResponse({ ok: true });
  }

  // ── grants-list ─────────────────────────────────────────────────────────
  // Lists BOTH kinds: percent discounts and free-month comps. (This used to
  // filter kind='percent', which made comps invisible in the Promo Center even
  // though its list renderer already knows how to show them.)
  if (action === "grants-list") {
    const { data, error } = await svc
      .from("promo_grants")
      .select("id, user_id, kind, percent, free_months, plan_id, status, note, expires_at, redeemed_at, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return errorResponse("Failed to list grants: " + error.message, 500);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const grants: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      let email = "";
      try {
        const { data: u } = await svc.auth.admin.getUserById(String(r.user_id));
        email = String(u?.user?.email || "");
      } catch (_e) { /* leave blank if the user was deleted */ }
      grants.push({ ...r, email });
    }
    return jsonResponse({ ok: true, grants });
  }

  // ── grant-create ────────────────────────────────────────────────────────
  // Two kinds:
  //   percent      → a coupon applied to their NEXT checkout (paystack-checkout
  //                  reads it at runtime). Nothing changes for them until they pay.
  //   free_months  → a comp: we put them on `plan_id` right now for N months.
  //                  Applied straight to `subscriptions` because that is what
  //                  every entitlement path already reads (get_user_entitlements
  //                  maps subscriptions.plan_id → plan_catalog.limits, and
  //                  job-scout's planTier reads plan_id + status='active').
  if (action === "grant-create") {
    const email = String(body.email ?? "").toLowerCase().trim();
    if (!email || email.indexOf("@") < 0) return errorResponse("A valid email is required.", 400);

    const kind = String(body.kind ?? "percent").toLowerCase().trim();
    if (kind !== "percent" && kind !== "free_months") {
      return errorResponse("kind must be 'percent' or 'free_months'.", 400);
    }

    // Validate the per-kind payload before touching the user directory.
    let pct = 0;
    let planId = "";
    let months = 0;
    if (kind === "percent") {
      pct = Math.round(Number(body.percent));
      if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
        return errorResponse("percent must be between 1 and 99.", 400);
      }
    } else {
      planId = String(body.plan_id ?? "").toLowerCase().trim();
      if (!VALID_PLANS.includes(planId)) {
        return errorResponse("plan_id must be one of: " + VALID_PLANS.join(", ") + ".", 400);
      }
      months = Math.round(Number(body.free_months));
      if (!Number.isFinite(months) || months < 1 || months > 24) {
        return errorResponse("free_months must be between 1 and 24.", 400);
      }
    }

    let expiresAt: string | null = null;
    const exp = String(body.expires_at ?? "").trim();
    if (exp !== "") {
      const d = new Date(exp);
      if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
    }

    let userId: string | null;
    try {
      userId = await resolveUserIdByEmail(svc, email);
    } catch (e) {
      return errorResponse((e as Error).message, 502);
    }
    if (!userId) return errorResponse("No account found with that email.", 404);

    if (kind === "percent") {
      const { error } = await svc.from("promo_grants").insert({
        user_id: userId,
        kind: "percent",
        percent: pct,
        note: body.note ? String(body.note).slice(0, 200) : null,
        granted_by: admin.id,
        expires_at: expiresAt,
        status: "active",
      });
      if (error) return errorResponse("Grant failed: " + error.message, 500);
      return jsonResponse({ ok: true, kind: "percent", percent: pct });
    }

    // ── free_months (comp) ────────────────────────────────────────────────
    const { data: subRow, error: subErr } = await svc
      .from("subscriptions")
      .select("plan_id, status, current_period_end, payment_processor, stripe_subscription_id, paystack_subscription_code")
      .eq("user_id", userId)
      .maybeSingle();
    if (subErr) return errorResponse("Subscription lookup failed: " + subErr.message, 500);
    const sub = (subRow || null) as Record<string, unknown> | null;

    // Never overwrite a live processor subscription: we would clobber their real
    // billing state and then fight the webhook over it. Comps are for accounts
    // that aren't currently paying (which is exactly what the Console promises).
    const hasLiveBilling = !!sub &&
      (!!sub.payment_processor || !!sub.stripe_subscription_id || !!sub.paystack_subscription_code) &&
      String(sub.status ?? "") !== "canceled";
    if (hasLiveBilling) {
      return errorResponse(
        "That account has an active paid subscription. Comp it only after they cancel, or send a % discount instead.",
        409,
      );
    }

    // Stack onto an unexpired comp on the SAME plan (so "another month" extends
    // rather than truncates); otherwise the comp starts now.
    const now = new Date();
    const existingEnd = sub && sub.current_period_end ? new Date(String(sub.current_period_end)) : null;
    const samePlanStillRunning = !!sub && String(sub.plan_id ?? "") === planId &&
      !!existingEnd && !Number.isNaN(existingEnd.getTime()) && existingEnd.getTime() > now.getTime();
    const end = new Date(samePlanStillRunning ? (existingEnd as Date) : now);
    end.setMonth(end.getMonth() + months);
    const endIso = end.toISOString();

    const { error: grantErr } = await svc.from("promo_grants").insert({
      user_id: userId,
      kind: "free_months",
      free_months: months,
      plan_id: planId,
      note: body.note ? String(body.note).slice(0, 200) : null,
      granted_by: admin.id,
      // The comp is in force immediately and lapses at `expires_at`; the
      // comps-sweep job flips it to 'expired' and demotes the plan.
      expires_at: endIso,
      redeemed_at: now.toISOString(),
      status: "active",
    });
    if (grantErr) return errorResponse("Grant failed: " + grantErr.message, 500);

    // status='active' (not 'trialing') on purpose: job-scout's planTier only
    // honours 'active', and get_user_entitlements keys limits off plan_id.
    const { error: upErr } = await svc.from("subscriptions").upsert({
      user_id: userId,
      plan_id: planId,
      status: "active",
      current_period_end: endIso,
      cancel_at_period_end: true, // a comp does not auto-renew
      updated_at: now.toISOString(),
    }, { onConflict: "user_id" });
    if (upErr) return errorResponse("Comp applied to grant log but the plan update failed: " + upErr.message, 500);

    return jsonResponse({
      ok: true,
      kind: "free_months",
      plan_id: planId,
      free_months: months,
      extended: samePlanStillRunning,
      current_period_end: endIso,
    });
  }

  // ── grant-revoke ────────────────────────────────────────────────────────
  // For a percent coupon this just voids the row. For a free-months comp the
  // plan is already applied, so revoking must also take the tier back —
  // otherwise the button would silently do nothing the user can feel.
  if (action === "grant-revoke") {
    const id = String(body.id ?? "").trim();
    if (!id) return errorResponse("Grant id required.", 400);

    const { data: gRow, error: gErr } = await svc
      .from("promo_grants")
      .select("id, user_id, kind, plan_id, status")
      .eq("id", id)
      .maybeSingle();
    if (gErr) return errorResponse("Revoke failed: " + gErr.message, 500);
    if (!gRow) return errorResponse("Grant not found.", 404);
    const grant = gRow as Record<string, unknown>;

    const { error } = await svc
      .from("promo_grants")
      .update({ status: "revoked" })
      .eq("id", id)
      .eq("status", "active");
    if (error) return errorResponse("Revoke failed: " + error.message, 500);

    let demoted = false;
    if (String(grant.kind ?? "") === "free_months" && String(grant.status ?? "") === "active") {
      // Only demote if the plan is still the comped one AND still has no
      // processor behind it (they may have started paying since the comp).
      const { data: sRow } = await svc
        .from("subscriptions")
        .select("plan_id, payment_processor, stripe_subscription_id, paystack_subscription_code")
        .eq("user_id", String(grant.user_id))
        .maybeSingle();
      const s = (sRow || null) as Record<string, unknown> | null;
      const stillComp = !!s && String(s.plan_id ?? "") === String(grant.plan_id ?? "") &&
        !s.payment_processor && !s.stripe_subscription_id && !s.paystack_subscription_code;
      if (stillComp) {
        await svc.from("subscriptions").update({
          plan_id: "free",
          status: "active",
          current_period_end: null,
          cancel_at_period_end: false,
          updated_at: new Date().toISOString(),
        }).eq("user_id", String(grant.user_id));
        demoted = true;
      }
    }
    return jsonResponse({ ok: true, demoted });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
