// POST /functions/v1/email-drip
//
// Lifecycle email sender. Enrols consented users into sequences, sends the
// steps that are due, and broadcasts the newest published newsletter — but
// ONLY to users who are currently consented (profiles.marketing_consent) and
// not on the suppression list. Every send carries a working one-click
// unsubscribe.
//
// Body: { task?: "run" | "drips" | "newsletter" }   (default "run")
// Auth: X-Cron-Secret == CRON_SECRET (scheduler) OR an admin JWT (manual).
//
// SAFETY: hard-gated behind EMAIL_DRIPS_ENABLED=true. Until an operator sets
// that secret, every call is a no-op — nothing is ever emailed by accident.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { resendConfigured, sendEmail, tagValue } from "../_shared/resend.ts";
import { SEQUENCES, type DripStep, type Sequence } from "./sequences.ts";

const SITE = (Deno.env.get("SITE_URL") || "https://www.careerboost.co.za").replace(/\/+$/, "");
const POLICY_VERSION = Deno.env.get("EMAIL_POLICY_VERSION") || "2026-06-05";
const MAX_PER_RUN = Number(Deno.env.get("EMAIL_DRIP_MAX") || "400");
const STALE_DAYS = 4;            // don't send a step overdue by more than this
const REENGAGE_MIN_DAYS = 14;    // inactivity window lower bound
const REENGAGE_MAX_DAYS = 45;    // ... and upper bound
const DAY_MS = 24 * 60 * 60 * 1000;

function dripsEnabled(): boolean {
  return (Deno.env.get("EMAIL_DRIPS_ENABLED") || "").trim().toLowerCase() === "true";
}

function functionsBase(): string {
  const u = Deno.env.get("SUPABASE_URL") || "";
  return u.replace(".supabase.co", ".functions.supabase.co").replace(/\/+$/, "");
}

function esc(s: string): string {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function randomToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Branded HTML wrapper with CTA + POPIA-compliant footer (sender identity +
// working unsubscribe). bodyHtml is the inner content.
function emailShell(heading: string, bodyHtml: string, cta: { label: string; url: string } | null, unsubUrl: string): string {
  const btn = cta
    ? '<tr><td style="padding:8px 0 4px;"><a href="' + esc(cta.url) + '" ' +
      'style="display:inline-block;background:#7cf0ff;color:#04121a;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;">' +
      esc(cta.label) + "</a></td></tr>"
    : "";
  return '<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>' +
    '<body style="margin:0;background:#f4f6fb;font-family:Inter,Arial,sans-serif;color:#1a2233;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;"><tr><td align="center">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e9f2;">' +
    '<tr><td style="background:#05070f;padding:18px 28px;"><span style="font-size:18px;font-weight:800;color:#ffffff;">Career<span style="color:#7cf0ff;">Boost</span></span></td></tr>' +
    '<tr><td style="padding:28px;">' +
    '<h1 style="font-size:21px;margin:0 0 14px;color:#0d1326;">' + esc(heading) + "</h1>" +
    bodyHtml +
    '<table role="presentation" cellpadding="0" cellspacing="0">' + btn + "</table>" +
    "</td></tr>" +
    '<tr><td style="padding:18px 28px;border-top:1px solid #eef0f6;font-size:12px;color:#8a93a6;line-height:1.6;">' +
    "CareerBoost · Built for ambition · South Africa<br />" +
    "You're receiving this because you opted in to marketing emails. " +
    '<a href="' + esc(unsubUrl) + '" style="color:#5566aa;">Unsubscribe</a> · ' +
    '<a href="' + SITE + '/#/settings?tab=data-privacy" style="color:#5566aa;">Email preferences</a>' +
    "</td></tr>" +
    "</table></td></tr></table></body></html>";
}

// Build a CTA URL with UTM in the REAL query string (before any #hash), because
// the attribution capture reads window.location.search, not the hash fragment.
function ctaWithUtm(path: string, campaign: string): string {
  const hashIdx = path.indexOf("#");
  const base = hashIdx >= 0 ? (path.slice(0, hashIdx) || "/") : path;
  const hash = hashIdx >= 0 ? path.slice(hashIdx) : "";
  const utm = "utm_source=email&utm_medium=drip&utm_campaign=" + encodeURIComponent(campaign);
  const sep = base.indexOf("?") >= 0 ? "&" : "?";
  return SITE + base + sep + utm + hash;
}

function renderStep(step: DripStep, seqKey: string, stepNo: number, unsubUrl: string): string {
  const body = step.paragraphs.map((p) => '<p style="font-size:15px;line-height:1.65;margin:0 0 14px;color:#33404f;">' + p + "</p>").join("");
  const campaign = seqKey + ":" + stepNo;
  const ctaUrl = ctaWithUtm(step.cta.path, campaign);
  return emailShell(step.heading, body, { label: step.cta.label, url: ctaUrl }, unsubUrl);
}

interface AuthInfo { email: string; lastSignInAt: number | null; }

// Build userId → {email, lastSignInAt} via the admin API (emails live in
// auth.users, not profiles). Paginated, capped — fine for the current scale;
// revisit with a profiles email mirror if the user base grows large.
async function buildAuthMap(svc: ReturnType<typeof getServiceClient>): Promise<Map<string, AuthInfo>> {
  const map = new Map<string, AuthInfo>();
  const perPage = 1000;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
    if (error) break;
    const users = data?.users || [];
    for (const u of users) {
      map.set(u.id, {
        email: (u.email || "").trim().toLowerCase(),
        lastSignInAt: u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : null,
      });
    }
    if (users.length < perPage) break;
  }
  return map;
}

interface ConsentInfo { signupAt: number | null; unsubToken: string | null; }

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // Auth: cron secret OR admin JWT.
  const cronSecret = (Deno.env.get("CRON_SECRET") || "").trim();
  const provided = (req.headers.get("X-Cron-Secret") || "").trim();
  if (!(cronSecret && provided === cronSecret)) {
    try { await getAuthedAdmin(req); } catch (err) { return errorResponse((err as Error).message || "Unauthorized", 403); }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const task = String(body.task || "run");

  if (!dripsEnabled()) {
    return jsonResponse({ ok: true, enabled: false, note: "Set EMAIL_DRIPS_ENABLED=true to start sending." });
  }
  if (!resendConfigured()) {
    return errorResponse("Resend not configured (RESEND_API_KEY/RESEND_FROM_EMAIL).", 503);
  }

  const svc = getServiceClient();
  const now = Date.now();
  const nowIso = new Date().toISOString();

  // DB kill-switch: operators pause drips from the admin UI without touching
  // function env. Both gates (env + this flag) must be clear to send.
  {
    const { data: bs } = await svc.from("brand_settings").select("drips_paused").eq("id", "default").maybeSingle();
    if (bs && bs.drips_paused) {
      return jsonResponse({ ok: true, enabled: true, paused: true, note: "Drips paused by operator (brand_settings.drips_paused)." });
    }
  }

  // Current consented users (state for fast filtering + enrolment).
  const consented = new Map<string, ConsentInfo>();
  {
    const { data } = await svc
      .from("profiles")
      .select("user_id, signup_at, email_unsub_token")
      .eq("marketing_consent", true)
      .limit(50000);
    (data ?? []).forEach((r) => consented.set(r.user_id as string, {
      signupAt: r.signup_at ? new Date(r.signup_at as string).getTime() : null,
      unsubToken: (r.email_unsub_token as string) || null,
    }));
  }

  const suppressed = new Set<string>();
  {
    const { data } = await svc.from("email_suppressions").select("email").limit(100000);
    (data ?? []).forEach((r) => suppressed.add(String(r.email).toLowerCase()));
  }

  const authMap = await buildAuthMap(svc);
  const fnBase = functionsBase();
  const summary = { enabled: true, task, enrolled: 0, sent: 0, skipped: 0, failed: 0, completed: 0, newsletter: 0 };
  let budget = MAX_PER_RUN;

  // Ensure a user has an unsubscribe token; persist if we mint one.
  async function ensureToken(userId: string, info: ConsentInfo): Promise<string> {
    if (info.unsubToken) return info.unsubToken;
    const t = randomToken();
    await svc.from("profiles").update({ email_unsub_token: t }).eq("user_id", userId);
    info.unsubToken = t;
    return t;
  }

  // Log a successful automated send into admin_email_log (unified tracking).
  async function logSend(userId: string, email: string, subject: string, html: string, sendType: string, seqKey: string | null, campaign: string | null, batchId: string | null, messageId: string) {
    try {
      await svc.from("admin_email_log").insert({
        operator_id: null,
        operator_email: "system:" + sendType,
        recipient_user_id: userId,
        recipient_email: email,
        subject,
        body_chars: html.length,
        status: "sent",
        sent_at: nowIso,
        resend_message_id: messageId,
        send_type: sendType,
        sequence_key: seqKey,
        campaign,
        bulk_batch_id: batchId,
      });
    } catch (err) {
      console.error("[email-drip] log insert failed:", (err as Error).message);
    }
  }

  // ── enrol users into a sequence (idempotent via unique constraint) ──────
  async function enrol(seq: Sequence) {
    const rows: Record<string, unknown>[] = [];
    if (seq.kind === "reengagement") {
      for (const [userId] of consented) {
        const a = authMap.get(userId);
        const lsi = a?.lastSignInAt ?? null;
        if (lsi == null) continue;
        const days = (now - lsi) / DAY_MS;
        if (days >= REENGAGE_MIN_DAYS && days <= REENGAGE_MAX_DAYS) {
          rows.push({ user_id: userId, sequence_key: seq.key, step_index: 0, anchor_at: nowIso, status: "enrolled" });
        }
      }
    } else {
      const cutoff = now - seq.enrollWithinDays * DAY_MS;
      for (const [userId, info] of consented) {
        if (info.signupAt == null || info.signupAt < cutoff) continue;
        rows.push({ user_id: userId, sequence_key: seq.key, step_index: 0, anchor_at: new Date(info.signupAt).toISOString(), status: "enrolled" });
      }
    }
    // Chunked upsert with ignoreDuplicates so existing progress is untouched.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await svc.from("email_drip_state").upsert(chunk, { onConflict: "user_id,sequence_key", ignoreDuplicates: true });
      if (!error) summary.enrolled += chunk.length; // upper bound (dupes ignored)
    }
  }

  // ── send the steps that are due for a sequence ──────────────────────────
  async function sendDue(seq: Sequence) {
    const { data: states } = await svc
      .from("email_drip_state")
      .select("id, user_id, step_index, anchor_at, status")
      .eq("sequence_key", seq.key)
      .eq("status", "enrolled")
      .order("updated_at", { ascending: true })
      .limit(2000);

    for (const row of states ?? []) {
      if (budget <= 0) break;
      const userId = row.user_id as string;
      const stepIdx = row.step_index as number;
      const step = seq.steps[stepIdx];

      // Out of steps → complete.
      if (!step) {
        await svc.from("email_drip_state").update({ status: "completed", updated_at: nowIso }).eq("id", row.id);
        summary.completed++;
        continue;
      }

      // Consent withdrawn or suppressed → stop the sequence.
      const info = consented.get(userId);
      const auth = authMap.get(userId);
      const email = auth?.email || "";
      if (!info) { await svc.from("email_drip_state").update({ status: "stopped", updated_at: nowIso }).eq("id", row.id); continue; }
      if (!email) { summary.skipped++; continue; }
      if (suppressed.has(email)) { await svc.from("email_drip_state").update({ status: "stopped", updated_at: nowIso }).eq("id", row.id); continue; }

      const anchor = new Date(row.anchor_at as string).getTime();
      const dueAt = anchor + step.dayOffset * DAY_MS;
      if (dueAt > now) continue; // not due yet

      // Too overdue (e.g. drips just turned on for an older account) → advance
      // without sending so we never blast a backlog.
      if (now - dueAt > STALE_DAYS * DAY_MS) {
        const nextIdx = stepIdx + 1;
        await svc.from("email_drip_state").update({
          step_index: nextIdx,
          status: nextIdx >= seq.steps.length ? "completed" : "enrolled",
          updated_at: nowIso,
        }).eq("id", row.id);
        summary.skipped++;
        continue;
      }

      const token = await ensureToken(userId, info);
      const unsubUrl = fnBase + "/email-unsubscribe?u=" + encodeURIComponent(userId) + "&k=" + encodeURIComponent(token);
      const html = renderStep(step, seq.key, stepIdx, unsubUrl);
      const campaign = seq.key + ":" + stepIdx;

      const res = await sendEmail({
        to: email,
        subject: step.subject,
        html,
        headers: {
          "List-Unsubscribe": "<" + unsubUrl + ">",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [
          { name: "source", value: "drip" },
          { name: "sequence", value: tagValue(seq.key) },
          { name: "step", value: String(stepIdx) },
        ],
      });
      budget--;

      if (res.ok) {
        const nextIdx = stepIdx + 1;
        await svc.from("email_drip_state").update({
          step_index: nextIdx,
          last_sent_at: nowIso,
          status: nextIdx >= seq.steps.length ? "completed" : "enrolled",
          updated_at: nowIso,
        }).eq("id", row.id);
        await logSend(userId, email, step.subject, html, "drip", seq.key, campaign, null, res.id || "");
        summary.sent++;
        if (nextIdx >= seq.steps.length) summary.completed++;
      } else {
        summary.failed++;
        console.error("[email-drip] send failed", seq.key, stepIdx, res.error);
      }
    }
  }

  // ── newsletter broadcast: newest published, not yet broadcast ───────────
  async function newsletter() {
    const { data: pieces } = await svc
      .from("content_pieces")
      .select("id, title, body, source_data")
      .eq("type", "newsletter")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(5);
    const piece = (pieces ?? []).find((p) => {
      const sd = (p.source_data && typeof p.source_data === "object") ? p.source_data as Record<string, unknown> : {};
      return !sd.broadcast_done;
    });
    if (!piece) return;

    // Recipients already sent this issue (idempotent across runs).
    const already = new Set<string>();
    {
      const { data } = await svc.from("admin_email_log").select("recipient_email").eq("bulk_batch_id", piece.id).limit(100000);
      (data ?? []).forEach((r) => already.add(String(r.recipient_email).toLowerCase()));
    }

    const bodyParas = String(piece.body || "").replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
      .map((p) => '<p style="font-size:15px;line-height:1.65;margin:0 0 14px;color:#33404f;">' + esc(p).replace(/\n/g, "<br />") + "</p>").join("");

    let sentThisRun = 0;
    let remaining = false;
    for (const [userId, info] of consented) {
      if (budget <= 0) { remaining = true; break; }
      const email = authMap.get(userId)?.email || "";
      if (!email || suppressed.has(email) || already.has(email)) continue;

      const token = await ensureToken(userId, info);
      const unsubUrl = fnBase + "/email-unsubscribe?u=" + encodeURIComponent(userId) + "&k=" + encodeURIComponent(token);
      const ctaUrl = SITE + "/?utm_source=email&utm_medium=newsletter&utm_campaign=" + encodeURIComponent(String(piece.id));
      const html = emailShell(String(piece.title || "CareerBoost newsletter"), bodyParas, { label: "Open CareerBoost", url: ctaUrl }, unsubUrl);

      const res = await sendEmail({
        to: email,
        subject: String(piece.title || "Your CareerBoost update"),
        html,
        headers: {
          "List-Unsubscribe": "<" + unsubUrl + ">",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [{ name: "source", value: "newsletter" }],
      });
      budget--;

      if (res.ok) {
        await logSend(userId, email, String(piece.title || ""), html, "newsletter", null, String(piece.id), String(piece.id), res.id || "");
        sentThisRun++;
        summary.newsletter++;
      } else {
        summary.failed++;
      }
    }

    // Mark the issue done once everyone has been processed this run.
    if (!remaining) {
      const sd = (piece.source_data && typeof piece.source_data === "object") ? piece.source_data as Record<string, unknown> : {};
      await svc.from("content_pieces").update({
        source_data: { ...sd, broadcast_done: true, broadcast_at: nowIso },
      }).eq("id", piece.id);
    }
    console.log("[email-drip] newsletter issue", piece.id, "sent", sentThisRun, "done", !remaining);
  }

  try {
    if (task === "run" || task === "drips") {
      for (const seq of SEQUENCES) {
        await enrol(seq);
        await sendDue(seq);
      }
    }
    if (task === "run" || task === "newsletter") {
      await newsletter();
    }
  } catch (err) {
    return errorResponse("Drip run failed: " + ((err as Error).message || String(err)), 500);
  }

  return jsonResponse({ ok: true, ...summary });
}));
