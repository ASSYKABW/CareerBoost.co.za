// Allow the client to call Edge Functions from any origin during development,
// and from your configured production origin when SITE_URL is set.
// In production we refuse to fall back to "*" — set SITE_URL explicitly.
const RAW_SITE_URL = Deno.env.get("SITE_URL");
const ENVIRONMENT = (Deno.env.get("ENVIRONMENT") ?? Deno.env.get("DENO_ENV") ?? "").toLowerCase();
const IS_PRODUCTION = ENVIRONMENT === "production" || ENVIRONMENT === "prod";

if (!RAW_SITE_URL) {
  if (IS_PRODUCTION) {
    // Loud failure — Edge Function refuses to serve when prod is misconfigured.
    throw new Error(
      "[cors] SITE_URL is not set in production. Refusing to fall back to wildcard CORS. " +
      "Set SITE_URL to your site origin (e.g. https://app.example.com).",
    );
  }
  console.warn(
    "[cors] SITE_URL is unset — falling back to wildcard '*' for development. " +
    "Set SITE_URL before deploying to production.",
  );
}

const SITE_URL = RAW_SITE_URL ?? "*";

export const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_URL,
  "Access-Control-Allow-Headers":
    // Day 3.3: x-cb-admin-nonce is the per-session CSRF token required
    // on admin mutations. Must be in the allowlist or browsers will
    // reject preflight from any non-same-origin caller.
    "authorization, x-client-info, apikey, content-type, x-cb-admin-nonce",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

// --- Origin allowlist (staging support) ------------------------------------
// The static corsHeaders above only ever names the production SITE_URL, so
// Vercel preview deploys and localhost can't call the functions from a browser
// (their requests fail CORS preflight). withCors() reflects the caller's
// Origin back when it's on the allowlist — production SITE_URL, our Vercel
// preview deploys (careerboost-*.vercel.app), localhost, or anything listed in
// the ALLOWED_ORIGINS env var — and otherwise falls back to SITE_URL so
// unknown origins stay blocked. These functions are JWT-authenticated, so this
// only governs which browser origins may call them; a cross-origin site still
// can't act without a valid login token.
const EXTRA_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (SITE_URL === "*") return true;
  if (origin === SITE_URL) return true;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if ((u.protocol === "http:" || u.protocol === "https:") &&
        (host === "localhost" || host === "127.0.0.1")) {
      return true;
    }
    // Our Vercel preview / staging deploys: careerboost-*.vercel.app
    if (u.protocol === "https:" && host.startsWith("careerboost") && host.endsWith(".vercel.app")) {
      return true;
    }
  } catch (_) {
    // Malformed Origin header — treat as not allowed.
  }
  return false;
}

export function resolveAllowedOrigin(req: Request): string {
  const origin = req.headers.get("Origin") ?? "";
  return isAllowedOrigin(origin) ? origin : SITE_URL;
}

function corsHeadersForOrigin(origin: string): Record<string, string> {
  return { ...corsHeaders, "Access-Control-Allow-Origin": origin };
}

// Wraps a Deno.serve handler so the CORS Allow-Origin reflects an allowlisted
// caller. It answers the OPTIONS preflight here and overwrites Allow-Origin on
// the way out, so the existing jsonResponse/errorResponse/handleOptions calls
// inside handlers need no changes. The resolved origin is a per-request local,
// so this is safe under concurrent requests.
export function withCors(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const origin = resolveAllowedOrigin(req);
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeadersForOrigin(origin) });
    }
    let res: Response;
    try {
      res = await handler(req);
    } catch (err) {
      res = new Response(
        JSON.stringify({ ok: false, error: (err as Error)?.message || "Internal error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    if (!headers.has("Vary")) headers.set("Vary", "Origin");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse({ ok: false, error: message, ...extra }, { status });
}
