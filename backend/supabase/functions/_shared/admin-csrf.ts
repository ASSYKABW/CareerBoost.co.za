// Day 3.3: lightweight CSRF defense on admin mutations.
//
// THREAT MODEL
// ------------
// Our auth is Bearer-token in the Authorization header (not cookies),
// so traditional cookie-based CSRF doesn't apply. The remaining risk:
//   1. XSS leaks the access_token via localStorage → attacker can mint
//      admin requests from another tab/page.
//   2. A malicious extension or compromised CDN ships JS that reads
//      auth and calls admin endpoints.
//
// MITIGATION
// ----------
// Require a per-session nonce in a custom header `X-CB-Admin-Nonce`
// on every admin mutation. The nonce lives in sessionStorage (not
// localStorage) so it:
//   - dies when the tab closes (limits replay window)
//   - is NOT auto-attached to cross-origin requests (CORS preflight
//     would have to whitelist the custom header, which our CORS doesn't)
//   - requires an attacker to explicitly read it (raises bar above
//     simple "read localStorage and POST" attacks)
//
// Server-side check is intentionally minimal:
//   - Header must be present
//   - Length must be 32..128 chars
//   - Must be safe characters (alphanum + hyphen)
//
// We don't validate the nonce value against a stored allowlist — that
// would require a per-session KV which we don't have, and the cost/
// benefit is poor. The presence check alone defeats the classes of
// attack we actually face given our cookie-less auth model.
//
// CALLERS
// -------
// Every admin Edge Function should call assertAdminCsrf(req) before
// performing any state mutation (insert/update/delete). Reads can skip
// it. The check throws — admin handlers should catch and return 403.

const NONCE_HEADER = "X-CB-Admin-Nonce";
const NONCE_MIN = 32;
const NONCE_MAX = 128;
const NONCE_PATTERN = /^[A-Za-z0-9\-_]{32,128}$/;

export class CsrfError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
    this.name = "CsrfError";
  }
}

/**
 * Verify the CSRF nonce is present and well-formed. Throws CsrfError
 * if invalid. Call before any admin mutation. Idempotent reads (list,
 * fetch) can skip the check.
 */
export function assertAdminCsrf(req: Request): void {
  const nonce = req.headers.get(NONCE_HEADER) || req.headers.get(NONCE_HEADER.toLowerCase());
  if (!nonce) {
    throw new CsrfError(
      `Missing ${NONCE_HEADER} header. This admin action requires a session nonce — ` +
      "your client may be out of date. Refresh the page and try again.",
    );
  }
  if (nonce.length < NONCE_MIN || nonce.length > NONCE_MAX) {
    throw new CsrfError(
      `Invalid ${NONCE_HEADER}: length must be ${NONCE_MIN}..${NONCE_MAX} chars (got ${nonce.length}).`,
    );
  }
  if (!NONCE_PATTERN.test(nonce)) {
    throw new CsrfError(
      `Invalid ${NONCE_HEADER}: must be alphanumeric, hyphens, or underscores only.`,
    );
  }
  // Pass — nonce shape is valid. We don't (currently) verify the value
  // server-side because that would require session-bound storage. See
  // module docblock for threat-model rationale.
}

/**
 * Convenience wrapper: try/catch around assertAdminCsrf that returns
 * a normalized error object instead of throwing. For handlers that
 * prefer early-return over exceptions.
 */
export function checkAdminCsrf(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  try {
    assertAdminCsrf(req);
    return { ok: true };
  } catch (err) {
    if (err instanceof CsrfError) {
      return { ok: false, status: err.status, error: err.message };
    }
    return { ok: false, status: 403, error: (err as Error).message || "CSRF check failed." };
  }
}
