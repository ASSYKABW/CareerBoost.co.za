// POST /functions/v1/usage-ingest
//
// Anonymous website analytics ingest — the pre-signup half of usage_events.
//
// WHY THIS EXISTS
// Signed-in clients write usage_events directly (RLS: user_id = auth.uid()).
// A logged-out visitor can't: RLS blocks the insert, and until 0053 the column
// was NOT NULL anyway. So the product could only ever see people from sign-in
// onward. This endpoint is the missing write path: it takes a batch from a
// visitor, validates/sanitises it, and inserts with user_id = NULL and the
// visitor's anonymous_id via the service client.
//
// The browser must never write this table directly, so no anon RLS policy was
// added — everything anonymous comes through here, rate-limited.
//
// IDENTITY: the client stamps the SAME persistent localStorage anonymous_id on
// every event and never clears it at signup. So a visitor's pre-signup rows
// (user_id NULL) and their later signed-in rows (user_id set) share one
// anonymous_id — stitching the full journey is just a join. This endpoint never
// accepts a user_id from the body; it cannot be used to forge activity for an
// account.
//
// Body: { anonymous_id: string, events: [{ event_name, event_category, module,
//         route, session_id, source, metadata, occurred_at }] }
// Always returns 200 (fire-and-forget) so analytics can never block a page.

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

const MAX_BATCH = 25;
const MAX_METADATA_KEYS = 24;
const MAX_STRING = 300;
const RATE_LIMIT = 120;          // events per window, per visitor/IP
const RATE_WINDOW_MS = 60_000;

// Never let candidate content or credentials ride along in analytics metadata.
// Mirrors client-telemetry's blocklist.
const BLOCKED_METADATA_KEYS = new Set([
  "apikey", "api_key", "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "password", "secret", "resume", "cv", "coverletter", "cover_letter", "jobdescription",
  "job_description", "description", "document", "rawtext", "raw_text", "html", "email",
]);

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return (fwd.split(",")[0] || "").trim() || "unknown";
}

function checkRate(key: string, want: number): number {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now >= b.resetAt) {
    rateBuckets.set(key, { count: 0, resetAt: now + RATE_WINDOW_MS });
    return Math.min(want, RATE_LIMIT);
  }
  const room = Math.max(0, RATE_LIMIT - b.count);
  return Math.min(want, room);
}
function commitRate(key: string, n: number): void {
  const b = rateBuckets.get(key);
  if (b) b.count += n;
}

function str(v: unknown, max = MAX_STRING): string {
  return String(v ?? "").trim().slice(0, max);
}

// Flat, shallow, string-capped metadata with credential/content keys removed.
function sanitizeMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_METADATA_KEYS) break;
    if (BLOCKED_METADATA_KEYS.has(k.toLowerCase())) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") { out[k] = v; n++; continue; }
    if (typeof v === "string") { out[k] = v.slice(0, MAX_STRING); n++; continue; }
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((x) =>
        (typeof x === "number" || typeof x === "boolean") ? x : str(x, 120)
      );
      n++;
      continue;
    }
    // Objects are dropped rather than walked — analytics doesn't need depth,
    // and depth is how sensitive payloads sneak in.
  }
  return out;
}

function normalizeEvent(raw: unknown, anonId: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;

  const name = str(e.event_name, 80).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (name.length < 2 || name.length > 80) return null;

  const session = str(e.session_id, 120);
  if (session.length < 8) return null;

  const category = str(e.event_category, 80) || "workflow";
  if (category.length < 2) return null;

  let occurred = str(e.occurred_at, 40);
  const d = occurred ? new Date(occurred) : null;
  if (!d || Number.isNaN(d.getTime())) occurred = new Date().toISOString();
  else occurred = d.toISOString();

  return {
    user_id: null,                 // anonymous by definition — never from the body
    anonymous_id: anonId,
    event_name: name,
    event_category: category,
    module: str(e.module, 80) || null,
    route: str(e.route, 200) || null,
    session_id: session,
    source: str(e.source, 40) || "web",
    metadata: sanitizeMetadata(e.metadata),
    occurred_at: occurred,
  };
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: { anonymous_id?: string; events?: unknown[] } = {};
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  const anonId = str(body.anonymous_id, 64);
  if (!anonId) return jsonResponse({ ok: true, inserted: 0, dropped: 0, note: "No anonymous_id" });

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (!events.length) return jsonResponse({ ok: true, inserted: 0, dropped: 0, note: "No events" });

  const key = anonId || clientIp(req);
  const allowed = checkRate(key, events.length);
  if (allowed === 0) {
    return jsonResponse({ ok: true, inserted: 0, dropped: events.length, note: "Rate limited" });
  }

  const rows: Record<string, unknown>[] = [];
  let invalid = 0;
  for (let i = 0; i < allowed; i++) {
    const row = normalizeEvent(events[i], anonId);
    if (row) rows.push(row); else invalid++;
  }
  if (!rows.length) {
    return jsonResponse({ ok: true, inserted: 0, dropped: events.length, invalid, note: "No valid events" });
  }

  const svc = getServiceClient();
  const { error } = await svc.from("usage_events").insert(rows);
  if (error) {
    // Never 500 at a page: report and let the client back off.
    return jsonResponse({ ok: false, inserted: 0, dropped: rows.length, error: error.message });
  }
  commitRate(key, rows.length);

  return jsonResponse({ ok: true, inserted: rows.length, dropped: events.length - rows.length, invalid });
}));
