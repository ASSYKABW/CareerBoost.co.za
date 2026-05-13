// POST /functions/v1/admin-incident-update
// Body: { incidentId: string, action: "ack" | "resolve" | "snooze" | "reopen", note?: string, snoozeHours?: number }
// Auth: admin gate via getAuthedAdmin.
//
// Lifecycle:
//   open ──ack──> acknowledged ──resolve──> resolved
//      └────────resolve──────────────────────┘
//      └────────snooze─────────> snoozed (auto-reopens when snoozed_until < now)
//   resolved ──reopen──> open
//   acknowledged ──reopen──> open
//   snoozed ──reopen──> open
//
// Every transition is audit-logged via admin_log_action.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";

interface Body {
  incidentId?: string;
  action?: string;
  note?: string;
  snoozeHours?: number;
}

const VALID_ACTIONS = new Set(["ack", "acknowledge", "resolve", "snooze", "reopen"]);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const incidentId = (body.incidentId || "").trim();
  const rawAction = (body.action || "").trim().toLowerCase();
  const action = rawAction === "acknowledge" ? "ack" : rawAction;
  const note = (body.note || "").slice(0, 300);
  const snoozeHours = Number(body.snoozeHours) || 24;

  if (!incidentId) return errorResponse("incidentId is required.", 400);
  if (!VALID_ACTIONS.has(rawAction)) {
    return errorResponse("action must be one of: ack, resolve, snooze, reopen.", 400);
  }

  const meta = extractRequestMeta(req);
  const svc = getServiceClient();

  // Fetch the incident first so the audit log captures before/after state +
  // we can validate transitions.
  const { data: existing, error: readErr } = await svc
    .from("admin_incidents")
    .select("id, dedup_key, kind, status, severity, title, section")
    .eq("id", incidentId)
    .maybeSingle();
  if (readErr) {
    await logAdminAction(admin, "incident_" + action, {
      payload: { incidentId, error: readErr.message, stage: "lookup" },
      resultStatus: "failed",
      errorMessage: readErr.message,
      ...meta,
    });
    return errorResponse("Failed to read incident: " + readErr.message, 502);
  }
  if (!existing) {
    return errorResponse("Incident not found.", 404);
  }

  const now = new Date();
  let update: Record<string, unknown> = {};
  let logAction = "";

  if (action === "ack") {
    update = {
      status: "acknowledged",
      acknowledged_at: now.toISOString(),
      acknowledged_by: admin.id,
      notes: note ? note : null,
    };
    logAction = "acknowledge_incident";
  } else if (action === "resolve") {
    update = {
      status: "resolved",
      resolved_at: now.toISOString(),
      resolved_by: admin.id,
      notes: note ? note : null,
    };
    logAction = "resolve_incident";
  } else if (action === "snooze") {
    const until = new Date(now.getTime() + Math.max(1, snoozeHours) * 60 * 60 * 1000);
    update = {
      status: "snoozed",
      snoozed_until: until.toISOString(),
      notes: note ? note : null,
    };
    logAction = "snooze_incident";
  } else if (action === "reopen") {
    update = {
      status: "open",
      acknowledged_at: null,
      acknowledged_by: null,
      snoozed_until: null,
      resolved_at: null,
      resolved_by: null,
    };
    logAction = "reopen_incident";
  }

  const { data: updated, error: updErr } = await svc
    .from("admin_incidents")
    .update(update)
    .eq("id", incidentId)
    .select("id, dedup_key, kind, status, severity, title, section, acknowledged_at, snoozed_until, resolved_at, notes")
    .single();
  if (updErr) {
    await logAdminAction(admin, logAction, {
      payload: { incidentId, prevStatus: existing.status, error: updErr.message },
      resultStatus: "failed",
      errorMessage: updErr.message,
      ...meta,
    });
    return errorResponse("Failed to update incident: " + updErr.message, 502);
  }

  await logAdminAction(admin, logAction, {
    payload: {
      incidentId,
      dedupKey: existing.dedup_key,
      kind: existing.kind,
      title: existing.title,
      section: existing.section,
      prevStatus: existing.status,
      nextStatus: updated?.status,
      note: note || null,
      snoozeHours: action === "snooze" ? snoozeHours : null,
    },
    ...meta,
  });

  return jsonResponse({ ok: true, action: logAction, incident: updated });
});
