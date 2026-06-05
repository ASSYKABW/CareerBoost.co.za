// POST /functions/v1/email-consent
//
// User-facing marketing-email consent (POPIA single opt-in). The caller acts
// on THEIR OWN profile (auth.uid()).
//
// Body:
//   { action: "get" }                 → { ok, consent, since }
//   { action: "set", consent: bool }  → opt in/out; writes profiles state,
//                                        appends an audit event, and toggles the
//                                        unsubscribe suppression accordingly.
//
// Every change is recorded in email_consent_events (the POPIA proof). Opting
// out also writes an email_suppressions row; opting back in clears the
// 'unsubscribe' suppression (but never bounce/complaint — those are technical).

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

// Bump when the privacy policy / consent wording materially changes, so each
// stored consent records exactly what the user agreed to.
const POLICY_VERSION = Deno.env.get("EMAIL_POLICY_VERSION") || "2026-06-05";

function reqMeta(req: Request) {
  const ip = req.headers.get("cf-connecting-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
  const ua = (req.headers.get("user-agent") || "").slice(0, 300) || null;
  return { ip, ua };
}

function newToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse((err as Error).message || "Sign in required.", 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || "get");
  const svc = getServiceClient();
  const email = (user.email || "").trim().toLowerCase();

  // ── get current state ─────────────────────────────────────────────────
  if (action === "get") {
    const { data } = await svc
      .from("profiles")
      .select("marketing_consent, marketing_consent_at")
      .eq("user_id", user.id)
      .maybeSingle();
    return jsonResponse({
      ok: true,
      consent: !!(data && data.marketing_consent),
      since: (data && data.marketing_consent_at) || null,
    });
  }

  // ── set (opt in / out) ────────────────────────────────────────────────
  if (action === "set") {
    const consent = body.consent === true;
    const { ip, ua } = reqMeta(req);
    const now = new Date().toISOString();

    const patch: Record<string, unknown> = {
      user_id: user.id,
      marketing_consent: consent,
      marketing_consent_at: now,
      marketing_consent_source: "settings",
      marketing_consent_version: POLICY_VERSION,
    };
    if (consent) patch.email_unsub_token = newToken();

    const { error: upErr } = await svc.from("profiles").upsert(patch, { onConflict: "user_id" });
    if (upErr) return errorResponse("Could not save preference: " + upErr.message, 502);

    // Audit trail — the POPIA proof.
    await svc.from("email_consent_events").insert({
      user_id: user.id,
      action: consent ? "opt_in" : "opt_out",
      source: "settings",
      policy_version: POLICY_VERSION,
      ip,
      user_agent: ua,
    });

    // Suppression list: opt-out suppresses; opt-in clears a prior unsubscribe.
    if (email) {
      if (consent) {
        await svc.from("email_suppressions").delete().eq("email", email).eq("reason", "unsubscribe");
      } else {
        await svc.from("email_suppressions").upsert(
          { user_id: user.id, email, reason: "unsubscribe", detail: "via settings" },
          { onConflict: "email" },
        );
      }
    }

    return jsonResponse({ ok: true, consent, since: now });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
