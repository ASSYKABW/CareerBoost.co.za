// POST /functions/v1/referral
//
// User-facing referral endpoint for the marketing engine.
//
// Body: { action: "my-code" | "leaderboard" }
//   my-code     — (authed user) get-or-create the caller's referral code and
//                 return it + a shareable URL + the caller's referral stats.
//   leaderboard — (authed admin) top referrers (via security-definer RPC).
//
// Referrals themselves are RECORDED by signup-attribution when a new user
// signs up carrying ?ref=<code>. This endpoint never grants rewards — that's
// a deliberate manual/operator step (see migration 0036).

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getAuthedUser, getServiceClient } from "../_shared/auth.ts";

// Unambiguous charset (no 0/O/1/I/L) for human-shareable codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 7;

function siteUrl(): string {
  const raw = (Deno.env.get("SITE_URL") || "https://www.careerboost.co.za").trim();
  return raw.replace(/\/+$/, "");
}

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || "my-code");
  const svc = getServiceClient();

  // ── leaderboard (admin) ───────────────────────────────────────────────
  if (action === "leaderboard") {
    try {
      await getAuthedAdmin(req);
    } catch (err) {
      return errorResponse((err as Error).message || "Admin required", 403);
    }
    const { data, error } = await svc.rpc("marketing_referral_leaderboard");
    if (error) return errorResponse("Leaderboard failed: " + error.message, 502);
    return jsonResponse({ ok: true, leaderboard: data ?? [] });
  }

  // ── my-code (authed user) ─────────────────────────────────────────────
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse((err as Error).message || "Sign in required.", 401);
  }

  // Get-or-create the caller's code.
  let code: string | null = null;
  try {
    const { data: existing } = await svc
      .from("referral_codes")
      .select("code")
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing?.code) {
      code = existing.code as string;
    } else {
      // Insert with retry on the (rare) code collision.
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = generateCode();
        const { error } = await svc
          .from("referral_codes")
          .insert({ code: candidate, user_id: user.id });
        if (!error) { code = candidate; break; }
        // Unique violation on user_id means a concurrent create won — re-read.
        if (error.code === "23505") {
          const { data: row } = await svc
            .from("referral_codes")
            .select("code")
            .eq("user_id", user.id)
            .maybeSingle();
          if (row?.code) { code = row.code as string; break; }
          // else it was a code collision — loop and try a new candidate.
        } else {
          return errorResponse("Could not create referral code: " + error.message, 502);
        }
      }
    }
  } catch (err) {
    return errorResponse("Referral code lookup failed: " + (err as Error).message, 502);
  }

  if (!code) return errorResponse("Could not allocate a referral code, please retry.", 503);

  // Stats: how many this user has referred + how many were rewarded.
  let referrals = 0;
  let rewarded = 0;
  try {
    const { count: total } = await svc
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_id", user.id);
    referrals = total ?? 0;
    const { count: rew } = await svc
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_id", user.id)
      .eq("status", "rewarded");
    rewarded = rew ?? 0;
  } catch { /* stats are best-effort */ }

  return jsonResponse({
    ok: true,
    code,
    url: siteUrl() + "/?ref=" + code,
    stats: { referrals, rewarded },
  });
}));
