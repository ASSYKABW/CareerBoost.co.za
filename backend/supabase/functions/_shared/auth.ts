// Extract the authenticated user from a Supabase JWT on the incoming request.
// We use the service-role client only to *read* the user; we never return
// service-role tokens to the caller.
//
// Phase 3: in-memory JWT verification cache.
// `client.auth.getUser(token)` does a network round-trip to Supabase Auth on
// every call (~100-200ms). For an Edge Function instance handling rapid calls
// from the same user (e.g. interview mock turn-by-turn, repeated AI requests),
// this is a meaningful fraction of total latency. We cache the {user_id, email}
// keyed on the JWT's signature segment with a TTL bounded by the JWT's `exp`
// claim — so an expired token is never served from cache.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface AuthedUser {
  id: string;
  email: string | null;
}

export interface AuthedAdmin extends AuthedUser {
  roles: string[];
  /** Resolved list of admin-permitted role names (from ADMIN_ROLES env).
   *  Exposed so the frontend can mirror the same allowlist for UX gates
   *  without hardcoding a separate copy that can drift. */
  allowedRoles: string[];
}

interface CachedAuth {
  user: AuthedUser;
  /** Wall-clock expiry (ms since epoch). Hard upper bound on cache validity. */
  expiresAt: number;
}

// Per-isolate cache. Edge Functions share an isolate per warm instance, so the
// same user hammering the AI from one tab benefits across calls. Capped to
// avoid unbounded memory in long-lived isolates (Supabase rotates them
// aggressively but defensive is cheap).
const AUTH_CACHE = new Map<string, CachedAuth>();
const AUTH_CACHE_MAX = 256;
// Absolute floor on TTL even when the JWT itself expires later. A 5-min
// ceiling means a session revocation on the Auth server propagates within
// 5 minutes worst-case (rotated tokens hit the cache fresh).
const AUTH_CACHE_MAX_TTL_MS = 5 * 60 * 1000;

function decodeJwtExpMs(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return 0;
    // Base64url decode the payload.
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Day 3.2 — Read the `aal` (authenticator assurance level) claim from
// the JWT payload. Supabase sets this to "aal1" after a password sign-
// in and "aal2" after a successful mfa.verify call. Returns "" if the
// token is malformed or the claim is missing (callers should treat
// empty as aal1 — the most pessimistic interpretation).
function decodeJwtAal(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return "";
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { aal?: string };
    return typeof json.aal === "string" ? json.aal.toLowerCase() : "";
  } catch {
    return "";
  }
}

function cacheKeyFor(token: string): string {
  // Use the signature segment as the key — it's unique per token and
  // (unlike sha256) requires no async work.
  const parts = token.split(".");
  return parts.length === 3 ? parts[2] : token;
}

function pruneCacheIfFull(): void {
  if (AUTH_CACHE.size < AUTH_CACHE_MAX) return;
  // Drop the 32 oldest entries by insertion order (Map preserves insertion).
  const it = AUTH_CACHE.keys();
  for (let i = 0; i < 32; i++) {
    const next = it.next();
    if (next.done) break;
    AUTH_CACHE.delete(next.value);
  }
}

export async function getAuthedUser(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Missing Authorization header.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnon) {
    throw new Error("Server misconfigured: SUPABASE_URL/ANON_KEY missing.");
  }

  // A common pitfall: the anon key is also a valid JWT accepted at the platform
  // level, but it has no user. Detect that case explicitly so we return a
  // clearer error than a generic "Invalid or expired session."
  if (token === supabaseAnon) {
    throw new Error("Received anon key, not a user session token. Please sign in.");
  }

  // ---- Cache lookup ----
  const key = cacheKeyFor(token);
  const cached = AUTH_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }
  if (cached) {
    AUTH_CACHE.delete(key); // expired; clean up
  }

  // ---- Cache miss → verify with Supabase Auth ----
  const client = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error) {
    throw new Error("Session rejected by Supabase Auth: " + error.message);
  }
  if (!data?.user) {
    throw new Error("No user attached to this token.");
  }

  const user: AuthedUser = { id: data.user.id, email: data.user.email ?? null };

  // Compute TTL: min(jwt.exp, now + 5min). Skip cache if exp is invalid/past.
  const expMs = decodeJwtExpMs(token);
  const now = Date.now();
  const expiresAt = expMs > now
    ? Math.min(expMs, now + AUTH_CACHE_MAX_TTL_MS)
    : 0;
  if (expiresAt > now + 5_000) {
    pruneCacheIfFull();
    AUTH_CACHE.set(key, { user, expiresAt });
  }

  return user;
}

export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizedRoles(value: unknown): string[] {
  return []
    .concat(value as never)
    .map((role) => String(role || "").toLowerCase().trim())
    .filter(Boolean);
}

function allowedAdminRoles(): string[] {
  return (Deno.env.get("ADMIN_ROLES") || "admin,owner,developer")
    .split(",")
    .map((role) => role.toLowerCase().trim())
    .filter(Boolean);
}

// Day 3.2 — feature flag for aal2 enforcement. On by default. Set
// ADMIN_REQUIRE_AAL2=false (or 0/off/no) in edge function env to
// temporarily disable, e.g. emergency rollback if the client gate
// breaks. The flag is read on every call so no redeploy needed to
// flip it — just `supabase secrets set ADMIN_REQUIRE_AAL2=false`.
function requireAal2(): boolean {
  const flag = (Deno.env.get("ADMIN_REQUIRE_AAL2") || "true").trim().toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "off" && flag !== "no";
}

export async function getAuthedAdmin(req: Request): Promise<AuthedAdmin> {
  const user = await getAuthedUser(req);
  const svc = getServiceClient();
  const { data, error } = await svc.auth.admin.getUserById(user.id);
  if (error) {
    throw new Error("Unable to verify admin role: " + error.message);
  }
  const appMeta = (data.user?.app_metadata || {}) as Record<string, unknown>;
  const roles = [
    ...normalizedRoles(appMeta.role),
    ...normalizedRoles(appMeta.roles),
  ];
  const allowed = allowedAdminRoles();
  const isAdmin = roles.some((role) => allowed.includes(role));
  if (!isAdmin) {
    throw new Error("Admin role required.");
  }

  // Day 3.2 — enforce aal2 for admin operations. The role check above
  // is necessary but not sufficient: an attacker with a stolen password
  // (no second factor) reaches /admin RPCs without this. We decode the
  // bearer token's `aal` claim and reject anything that isn't aal2.
  //
  // The error message points to BOTH paths (challenge if you have a
  // factor, enroll if you don't) so an operator hitting this cold
  // knows what to do without reading docs. The client-side gate on
  // /admin normally catches aal1 before any RPC fires, so seeing this
  // error in practice usually means UI bypass or a stale token.
  if (requireAal2()) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const aal = decodeJwtAal(token);
    if (aal !== "aal2") {
      throw new Error(
        "Two-factor verification required for admin operations. " +
        "Visit /admin and enter your 6-digit code; if you have not " +
        "enrolled a TOTP factor yet, do so at /mfa-setup.html first."
      );
    }
  }

  return { id: user.id, email: user.email, roles, allowedRoles: allowed };
}
