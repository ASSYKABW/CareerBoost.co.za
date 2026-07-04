// POST /functions/v1/console-publish
// Body: { action: "get-config" | "set-config" | "publish", url?, draftId? }
// Auth: admin role + AAL2/MFA (getAuthedAdmin) + CSRF (mutations) + rate limit
//       + audit.
//
// Auto-publish bridge (Phase D). The operator points this at ONE outbound
// webhook (Zapier "Catch Hook" / Make / Buffer / n8n / anything) via
// set-config. Then approving a draft in the Growth section and hitting
// Publish POSTs the draft JSON to that webhook SERVER-SIDE (the URL never
// touches the browser bundle) and marks the draft posted.
//
// Why a webhook and not direct APIs: LinkedIn/Meta/TikTok posting needs
// weeks-long developer-app approvals we don't control. A no-code automation
// receiving this JSON can fan it out to the real platforms today.
//
// Webhook URL lives in runtime_config key 'publish_webhook' (migration 0046).
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";
import { bustRuntimeConfig, getRuntimeConfig } from "../_shared/runtime-config.ts";

interface PubConfig { url?: string }

function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.protocol + "//" + url.host + "/…" + (u.length > 8 ? u.slice(-6) : "");
  } catch { return "(set)"; }
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const action = String(body.action || "get-config");

  if (action !== "get-config") {
    const csrf = checkAdminCsrf(req);
    if (!csrf.ok) return errorResponse(csrf.error, csrf.status);
  }

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const m = (err as Error).message || "Admin access denied.";
    return errorResponse(m, m.includes("required") ? 403 : 401);
  }

  const svc = getServiceClient();
  const cfg = await getRuntimeConfig<PubConfig>("publish_webhook", {});

  // ── get-config ─────────────────────────────────────────────────────
  if (action === "get-config") {
    return jsonResponse({ ok: true, configured: !!cfg.url, urlMasked: cfg.url ? maskUrl(cfg.url) : null });
  }

  const rate = await enforceAdminRate(admin, "console-publish");
  if (!rate.allowed) return errorResponse(rate.reason || "Admin rate limit exceeded.", 429);
  const meta = extractRequestMeta(req);

  // ── set-config ─────────────────────────────────────────────────────
  if (action === "set-config") {
    const url = String(body.url || "").trim();
    if (url && !/^https:\/\/.+/i.test(url)) return errorResponse("Webhook URL must start with https://", 400);
    const { error } = await svc.from("runtime_config").upsert(
      { key: "publish_webhook", value: url ? { url } : {}, updated_by: admin.id, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    if (error) {
      return errorResponse("Save failed: " + error.message + (error.code === "42P01" ? " — apply migration 0046 first." : ""), 500);
    }
    bustRuntimeConfig("publish_webhook");
    await logAdminAction(admin, "publish_set_webhook", { payload: { configured: !!url }, resultStatus: "success", ...meta });
    return jsonResponse({ ok: true, configured: !!url });
  }

  // ── publish ────────────────────────────────────────────────────────
  if (action === "publish") {
    if (!cfg.url) return errorResponse("No publish webhook configured — set one first (Auto-publish setup).", 400);
    const draftId = String(body.draftId || "").trim();
    if (!draftId) return errorResponse("draftId required", 400);

    const { data: draft, error: dErr } = await svc.from("social_drafts").select("*").eq("id", draftId).maybeSingle();
    if (dErr) return errorResponse("Draft lookup failed: " + dErr.message, 500);
    if (!draft) return errorResponse("Draft not found.", 404);
    if (draft.status === "posted") return errorResponse("This draft is already posted.", 409);

    let ok = false, status = 0, respText = "";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(cfg.url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id, platform: draft.platform, hook: draft.hook,
          body: draft.body, hashtags: draft.hashtags, link: draft.link,
        }),
      });
      clearTimeout(timer);
      status = res.status; ok = res.ok; respText = (await res.text()).slice(0, 200);
    } catch (e) {
      return errorResponse("Webhook call failed: " + (e as Error).message, 502);
    }
    if (!ok) return errorResponse("Webhook returned HTTP " + status + ": " + respText, 502);

    await svc.from("social_drafts").update({ status: "posted", posted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", draftId);
    await logAdminAction(admin, "publish_draft", { payload: { draftId, platform: draft.platform, status }, resultStatus: "success", ...meta });
    return jsonResponse({ ok: true, status });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
