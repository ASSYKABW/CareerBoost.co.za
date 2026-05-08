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
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

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
