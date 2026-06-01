// POST /functions/v1/paystack-checkout
//
// Initialises a PayStack transaction for the caller's chosen plan +
// interval + currency. Returns the hosted-checkout URL the frontend
// should redirect to.
//
// Body:
//   {
//     planId: "plus" | "pro" | "career",
//     interval: "monthly" | "annual",
//     currency: "ZAR" | "USD",
//     callbackUrl?: string   // where PayStack redirects after payment;
//                            // defaults to https://www.careerboost.co.za
//                            // /#/settings?tab=account&billing=success
//   }
//
// Response:
//   { ok: true, authorizationUrl, reference, planCode, amountMinor, currency }
//
// Auth: signed-in users only. The user's email is read from their JWT
// (not from the request body) — preventing a malicious caller from
// charging someone else.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

const PAYSTACK_BASE = "https://api.paystack.co";
const DEFAULT_CALLBACK = "https://www.careerboost.co.za/#/settings?tab=account&billing=success";

interface CheckoutBody {
  planId?: string;
  interval?: "monthly" | "annual";
  currency?: "ZAR" | "USD";
  callbackUrl?: string;
}

interface PlanRow {
  plan_id: string;
  label: string;
  price_zar_monthly: number | null;
  price_zar_annual: number | null;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
  paystack_plan_code_zar_monthly: string | null;
  paystack_plan_code_zar_annual: string | null;
  paystack_plan_code_usd_monthly: string | null;
  paystack_plan_code_usd_annual: string | null;
}

// PayStack expects "amount" in the smallest currency unit — kobo / cents.
// 1 ZAR = 100 cents; 1 USD = 100 cents. (NGN = kobo, same math.)
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

function pickPlanCodeAndPrice(plan: PlanRow, interval: string, currency: string): { code: string | null; price: number | null } {
  if (currency === "ZAR" && interval === "monthly") {
    return { code: plan.paystack_plan_code_zar_monthly, price: plan.price_zar_monthly };
  }
  if (currency === "ZAR" && interval === "annual") {
    return { code: plan.paystack_plan_code_zar_annual, price: plan.price_zar_annual };
  }
  if (currency === "USD" && interval === "monthly") {
    return { code: plan.paystack_plan_code_usd_monthly, price: plan.monthly_price_usd };
  }
  if (currency === "USD" && interval === "annual") {
    return { code: plan.paystack_plan_code_usd_annual, price: plan.annual_price_usd };
  }
  return { code: null, price: null };
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // ---- Auth ----
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }
  if (!user.email) {
    return errorResponse("Account has no email — required for PayStack billing.", 400);
  }

  // ---- Parse + validate body ----
  let body: CheckoutBody = {};
  try {
    body = (await req.json()) as CheckoutBody;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const planId = String(body.planId || "").toLowerCase().trim();
  const interval = String(body.interval || "monthly").toLowerCase().trim();
  const currency = String(body.currency || "ZAR").toUpperCase().trim();
  const callbackUrl = String(body.callbackUrl || DEFAULT_CALLBACK).trim();

  if (!["plus", "pro", "career"].includes(planId)) {
    return errorResponse("planId must be one of: plus, pro, career", 400);
  }
  if (!["monthly", "annual"].includes(interval)) {
    return errorResponse('interval must be "monthly" or "annual"', 400);
  }
  if (!["ZAR", "USD"].includes(currency)) {
    return errorResponse('currency must be "ZAR" or "USD"', 400);
  }

  // ---- PayStack secret key ----
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) {
    return errorResponse("PAYSTACK_SECRET_KEY not configured.", 503);
  }

  // ---- Look up plan + PayStack plan code for the chosen pair ----
  const svc = getServiceClient();
  const { data: planData, error: planErr } = await svc
    .from("plan_catalog")
    .select(
      "plan_id, label, " +
      "price_zar_monthly, price_zar_annual, monthly_price_usd, annual_price_usd, " +
      "paystack_plan_code_zar_monthly, paystack_plan_code_zar_annual, " +
      "paystack_plan_code_usd_monthly, paystack_plan_code_usd_annual"
    )
    .eq("plan_id", planId)
    .single();
  if (planErr || !planData) {
    return errorResponse("Plan not found: " + planId, 404);
  }
  const plan = (planData as unknown) as PlanRow;
  const { code: planCode, price } = pickPlanCodeAndPrice(plan, interval, currency);
  if (!planCode) {
    return errorResponse(
      "PayStack plan code missing for " + planId + " " + interval + " " + currency +
      ". Operator: create the Plan in PayStack dashboard, then UPDATE plan_catalog with the returned code.",
      503,
    );
  }
  if (!price || price <= 0) {
    return errorResponse("Plan price missing or zero for " + planId + " " + interval + " " + currency, 503);
  }

  // ---- Initialise the transaction with PayStack ----
  // The `plan` field tells PayStack this is a subscription transaction;
  // they'll set up the recurring schedule after the first successful charge.
  // Reference is auto-generated by PayStack if omitted.
  const initBody = {
    email: user.email,
    amount: toMinorUnits(price),
    currency,
    plan: planCode,
    callback_url: callbackUrl,
    metadata: {
      user_id: user.id,
      plan_id: planId,
      interval,
      currency,
      // Custom fields surface as line items in the PayStack admin UI —
      // useful for the operator to scan transactions later.
      custom_fields: [
        { display_name: "Plan",     variable_name: "plan",     value: planId },
        { display_name: "Interval", variable_name: "interval", value: interval },
        { display_name: "Currency", variable_name: "currency", value: currency },
      ],
    },
  };

  let psRes;
  try {
    psRes = await fetch(PAYSTACK_BASE + "/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initBody),
    });
  } catch (err) {
    return errorResponse("PayStack unreachable: " + (err as Error).message, 502);
  }
  if (!psRes.ok) {
    const txt = await psRes.text();
    return errorResponse(
      "PayStack init failed (HTTP " + psRes.status + "): " + txt.slice(0, 300),
      502,
    );
  }
  const psJson = await psRes.json() as {
    status: boolean;
    message: string;
    data?: { authorization_url: string; access_code: string; reference: string };
  };
  if (!psJson.status || !psJson.data) {
    return errorResponse("PayStack init returned non-success: " + (psJson.message || "unknown"), 502);
  }

  return jsonResponse({
    ok: true,
    authorizationUrl: psJson.data.authorization_url,
    reference: psJson.data.reference,
    planCode,
    planId,
    interval,
    currency,
    amountMinor: toMinorUnits(price),
  });
}));
