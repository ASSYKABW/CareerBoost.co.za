// POST /functions/v1/client-telemetry
// Body: { events: TelemetryEvent[] }
//
// Authenticated AND anonymous callers are both allowed:
//   - Authenticated (sign-in completed):
//       events.user_id = auth.uid()
//       events.anonymous_id = null
//   - Anonymous (pre-signup landing page errors):
//       events.user_id = null
//       events.anonymous_id = body's anonymous_id (UUID-ish string)
//
// Rate-limit (best-effort, in-memory per Edge Function instance):
//   - 60 events / minute per (user_id || anonymous_id || IP)
//   - Excess events are silently dropped (200 response with dropped count)
//
// Privacy:
//   - Hard 4KB ceiling on metadata, 8KB on stack, 1KB on message
//   - Blocked-key scrub on metadata (same vocabulary as usage_events)
//   - DB trigger reinforces the metadata guard
//   - No PII fields accepted in the schema by design
//
// This function is a write-only sink. Reads happen via the admin
// console which uses service_role.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

interface TelemetryEvent {
  severity?: "error" | "warning" | "info";
  event_kind?: string;
  message?: string;
  stack?: string;
  source_url?: string;
  line_no?: number;
  col_no?: number;
  route?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
  occurred_at?: string;
  anonymous_id?: string;
}

const MAX_BATCH = 20;
const ALLOWED_SEVERITIES = new Set(["error", "warning", "info"]);
const ALLOWED_KINDS = new Set([
  "unhandled_error", "unhandled_rejection", "console_error",
  "slow_op", "route_error", "api_error", "boot_error",
  "manual", "perf_mark"
]);
const BLOCKED_METADATA_KEYS = new Set([
  "apiKey","api_key","accessToken","access_token","refreshToken","refresh_token",
  "password","secret","resume","cv","coverLetter","cover_letter","jobDescription",
  "job_description","description","document","rawText","raw_text","html"
]);

// Simple in-memory rate limiter. Per Edge Function instance only — under
// load Supabase may have multiple instances and the limit is effectively
// per-instance, but that's acceptable for telemetry. The DB constraints
// + payload size caps provide the real protection.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

function rateLimitKey(req: Request, userId: string | null, anonId: string | null): string {
  if (userId) return "u:" + userId;
  if (anonId) return "a:" + anonId;
  // Fallback to IP. Cloudflare populates cf-connecting-ip; x-forwarded-for as backup.
  const ip = req.headers.get("cf-connecting-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
  return "ip:" + ip;
}

function checkRate(key: string, slots: number): { allowed: number; dropped: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    const allow = Math.min(slots, RATE_LIMIT);
    rateBuckets.set(key, { count: allow, resetAt: now + RATE_WINDOW_MS });
    return { allowed: allow, dropped: Math.max(0, slots - RATE_LIMIT) };
  }
  const remaining = Math.max(0, RATE_LIMIT - bucket.count);
  const allow = Math.min(slots, remaining);
  bucket.count += allow;
  return { allowed: allow, dropped: slots - allow };
}

// Pull user from the Authorization header without throwing. Anonymous
// callers (no token) are valid here.
async function tryAuthedUser(req: Request) {
  try {
    const auth = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return null;
    const svc = getServiceClient();
    // svc.auth.getUser(token) validates the JWT via Supabase Auth.
    const { data, error } = await svc.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

function clamp(value: unknown, maxBytes: number): string | null {
  if (value == null) return null;
  const str = String(value);
  if (!str.length) return null;
  // ASCII-fast path: most error messages are ASCII so byte length ≈ char length.
  // For longer strings we trust the slice and let the DB constraint reject overflows.
  return str.slice(0, maxBytes);
}

function scrubMetadata(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (BLOCKED_METADATA_KEYS.has(k)) continue;
    // Drop nested objects beyond 2 levels to keep payload bounded.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = "[object]";
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 10);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeEvent(raw: TelemetryEvent, userId: string | null, anonId: string | null, userAgent: string | null): Record<string, unknown> | null {
  const severity = (raw.severity && ALLOWED_SEVERITIES.has(raw.severity)) ? raw.severity : "error";
  const kind = (raw.event_kind && ALLOWED_KINDS.has(raw.event_kind)) ? raw.event_kind : "manual";
  const message = clamp(raw.message, 1024);
  if (!message) return null;
  const stack = clamp(raw.stack, 8192);
  const sourceUrl = clamp(raw.source_url, 512);
  const route = clamp(raw.route, 256);
  const ua = clamp(raw.user_agent || userAgent, 512);
  const occurredAt = typeof raw.occurred_at === "string" && raw.occurred_at
    ? raw.occurred_at
    : new Date().toISOString();
  return {
    user_id: userId,
    anonymous_id: userId ? null : anonId,
    severity,
    event_kind: kind,
    message,
    stack,
    source_url: sourceUrl,
    line_no: Number.isFinite(raw.line_no) ? Number(raw.line_no) : null,
    col_no:  Number.isFinite(raw.col_no)  ? Number(raw.col_no)  : null,
    route,
    user_agent: ua,
    metadata: scrubMetadata(raw.metadata),
    occurred_at: occurredAt,
  };
}

Deno.serve(withCors(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: { events?: TelemetryEvent[]; anonymous_id?: string } = {};
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (!events.length) {
    return jsonResponse({ ok: true, inserted: 0, dropped: 0, note: "No events" });
  }

  const user = await tryAuthedUser(req);
  const userId = user ? user.id : null;
  const anonId = !userId && typeof body.anonymous_id === "string" ? body.anonymous_id.slice(0, 64) : null;
  const ua = req.headers.get("user-agent") || null;

  // Rate-limit by user/anon-id/IP.
  const rateKey = rateLimitKey(req, userId, anonId);
  const { allowed, dropped: rateDropped } = checkRate(rateKey, events.length);
  if (allowed === 0) {
    return jsonResponse({ ok: true, inserted: 0, dropped: events.length, note: "Rate limited" });
  }

  const rows: Record<string, unknown>[] = [];
  let invalid = 0;
  for (let i = 0; i < allowed; i++) {
    const normalized = normalizeEvent(events[i], userId, anonId, ua);
    if (normalized) rows.push(normalized); else invalid++;
  }

  if (!rows.length) {
    return jsonResponse({ ok: true, inserted: 0, dropped: events.length, invalid, note: "No valid events" });
  }

  const svc = getServiceClient();
  const { error } = await svc.from("client_telemetry").insert(rows);
  if (error) {
    // Don't 500 — the frontend backs off on errors but we want the
    // collector to be resilient. Surface as 200 with error detail so
    // the client can log it (avoiding infinite recursion: an error in
    // the error-logging endpoint shouldn't get re-logged).
    return jsonResponse({ ok: false, inserted: 0, dropped: rows.length, invalid, error: error.message });
  }

  return jsonResponse({
    ok: true,
    inserted: rows.length,
    dropped: rateDropped + invalid,
    invalid,
    rate_limited: rateDropped,
  });
}));
