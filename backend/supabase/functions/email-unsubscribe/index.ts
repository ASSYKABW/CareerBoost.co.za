// GET|POST /functions/v1/email-unsubscribe?u=<userId>&k=<token>
//
// Public, no-login unsubscribe from marketing email. The link carries the
// user id + their per-user random token (profiles.email_unsub_token); we match
// both before acting, so the URL can't be used to unsubscribe arbitrary users.
//
//   GET  → human clicks the link in an email → returns a small HTML page.
//   POST → RFC 8058 one-click (Gmail/Apple "Unsubscribe" button hits the
//          List-Unsubscribe-Post URL) → returns 200, no body needed.
//
// Effect (idempotent): clears marketing_consent, appends an opt_out audit
// event, and adds an email_suppressions row. Always returns 200 so we never
// leak whether a given id/token pair was valid.

import { handleOptions, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

function page(title: string, message: string): Response {
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    "<title>" + title + " — CareerBoost</title>" +
    "<style>body{margin:0;background:#05070f;color:#eaf6ff;font-family:Inter,system-ui,sans-serif;" +
    "display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;}" +
    ".card{max-width:440px;background:#0d1326;border:1px solid rgba(255,255,255,0.09);border-radius:18px;padding:36px 28px;}" +
    "h1{font-size:22px;margin:0 0 10px;} p{color:rgba(240,244,255,0.7);line-height:1.6;margin:0 0 18px;}" +
    "a{color:#7cf0ff;font-weight:600;text-decoration:none;}</style></head><body>" +
    '<div class="card"><h1>' + title + "</h1><p>" + message + "</p>" +
    '<a href="https://www.careerboost.co.za/">Back to CareerBoost</a></div></body></html>';
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function doUnsubscribe(userId: string, token: string): Promise<boolean> {
  if (!userId || !token) return false;
  const svc = getServiceClient();
  const { data: prof } = await svc
    .from("profiles")
    .select("user_id, email_unsub_token")
    .eq("user_id", userId)
    .maybeSingle();
  if (!prof || !prof.email_unsub_token || prof.email_unsub_token !== token) return false;

  const now = new Date().toISOString();
  await svc.from("profiles").update({
    marketing_consent: false,
    marketing_consent_at: now,
    marketing_consent_source: "unsubscribe_link",
  }).eq("user_id", userId);

  await svc.from("email_consent_events").insert({
    user_id: userId,
    action: "opt_out",
    source: "unsubscribe_link",
  });

  // Resolve the email for the suppression row.
  let email = "";
  try {
    const { data } = await svc.auth.admin.getUserById(userId);
    email = (data.user?.email || "").trim().toLowerCase();
  } catch { /* best effort */ }
  if (email) {
    await svc.from("email_suppressions").upsert(
      { user_id: userId, email, reason: "unsubscribe", detail: "one-click link" },
      { onConflict: "email" },
    );
  }
  return true;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const userId = (url.searchParams.get("u") || "").trim();
  const token = (url.searchParams.get("k") || "").trim();
  const ok = await doUnsubscribe(userId, token);

  // RFC 8058 one-click: just acknowledge.
  if (req.method === "POST") {
    return new Response(JSON.stringify({ ok }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return ok
    ? page("You're unsubscribed", "You won't receive any more marketing emails from CareerBoost. Account and security emails (like password resets) will still reach you.")
    : page("Link expired", "We couldn't process this unsubscribe link. You can manage email preferences anytime in Settings → Data &amp; Privacy.");
}));
