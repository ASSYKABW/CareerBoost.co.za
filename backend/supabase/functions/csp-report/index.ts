// POST /functions/v1/csp-report
//
// Receives CSP violation reports from the browser. The
// Content-Security-Policy-Report-Only header in vercel.json points
// browsers at this URL via the `report-uri` directive. Browsers
// POST one JSON document per violation.
//
// Two formats supported (browsers vary):
//   application/csp-report       — legacy (Chrome 60+, all current)
//   application/reports+json     — newer Report-To API (Firefox)
//
// We log each violation to console.error so it surfaces in the
// Supabase Edge Function logs. Operator reviews the log dashboard
// every few days during the report-only rollout to see what real
// violations look like before flipping CSP to enforcing mode.
//
// Why not write to DB: violation reports can be high-volume
// (one user's tab generates dozens during a single page render in
// some browsers). Logging to stdout is cheap and Supabase log
// retention is sufficient for the monitoring window. If we ever
// need historical analysis, swap in a csp_violations table.
//
// Auth: NONE. CSP reports are sent by the browser without any auth
// header (and can't be — the browser is reporting on its own
// behavior). The edge function must be deployed with --no-verify-jwt.
// Risk: someone could DoS-spam this endpoint. Mitigation: edge
// function platform has its own rate limits + reports are tiny
// JSON blobs (~500 bytes typically). Worst case we get noise in
// logs and pay a tiny bit of compute; nothing else is exposed.

import { errorResponse, handleOptions } from "../_shared/cors.ts";

// Some browsers send violations one at a time wrapped in
// { "csp-report": {...} }; others (Report-To API) send arrays of
// { type: "csp-violation", body: {...} }. Normalize both shapes
// before logging so the structured log is easy to grep.
interface CspReportEntry {
  documentURI?: string;
  document_uri?: string;
  blockedURI?: string;
  blocked_uri?: string;
  violatedDirective?: string;
  violated_directive?: string;
  effectiveDirective?: string;
  effective_directive?: string;
  sourceFile?: string;
  source_file?: string;
  lineNumber?: number;
  line_number?: number;
  columnNumber?: number;
  column_number?: number;
  referrer?: string;
  scriptSample?: string;
  script_sample?: string;
  statusCode?: number;
  status_code?: number;
  disposition?: string;
  [k: string]: unknown;
}

// Pull the most useful fields regardless of casing convention.
function summarize(entry: CspReportEntry): Record<string, unknown> {
  return {
    document_uri: entry.documentURI || entry.document_uri || null,
    blocked_uri: entry.blockedURI || entry.blocked_uri || null,
    violated_directive: entry.violatedDirective || entry.violated_directive ||
      entry.effectiveDirective || entry.effective_directive || null,
    source_file: entry.sourceFile || entry.source_file || null,
    line: entry.lineNumber || entry.line_number || null,
    column: entry.columnNumber || entry.column_number || null,
    script_sample: entry.scriptSample || entry.script_sample || null,
    disposition: entry.disposition || null,
    status: entry.statusCode || entry.status_code || null,
  };
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return errorResponse("Couldn't read body: " + (err as Error).message, 400);
  }
  if (!rawBody) {
    // Browser sent empty body — accept silently. Return 204 (CSP
    // report convention; no body expected back).
    return new Response(null, { status: 204 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Body wasn't valid JSON — log raw + acknowledge so the browser
    // doesn't retry.
    console.warn("[csp-report] non-json body:", rawBody.slice(0, 500));
    return new Response(null, { status: 204 });
  }

  // Normalize: collect an array of report entries regardless of
  // browser format.
  const entries: CspReportEntry[] = [];
  if (Array.isArray(parsed)) {
    // Report-To API: array of { type, body }
    for (const item of parsed as Array<{ type?: string; body?: CspReportEntry }>) {
      if (item && item.body) entries.push(item.body);
    }
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (obj["csp-report"] && typeof obj["csp-report"] === "object") {
      // Legacy report-uri: single { "csp-report": {...} }
      entries.push(obj["csp-report"] as CspReportEntry);
    } else {
      // Some browsers post the report fields at the top level.
      entries.push(obj as CspReportEntry);
    }
  }

  if (!entries.length) {
    return new Response(null, { status: 204 });
  }

  // Log structured + readable. Each entry becomes one log line.
  const ua = req.headers.get("user-agent") || "";
  for (const entry of entries) {
    const s = summarize(entry);
    console.warn("[csp-report]", JSON.stringify({ ...s, user_agent: ua.slice(0, 120) }));
  }

  return new Response(null, { status: 204 });
});
