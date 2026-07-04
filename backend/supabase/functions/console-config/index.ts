// POST /functions/v1/console-config
// Body: { action: "get"|"set-route"|"clear-route"|"set-key"|"clear-key",
//         skill?, provider?, model?, key? }
// Auth: admin role + AAL2/MFA (getAuthedAdmin). Mutations additionally require
// the X-CB-Admin-Nonce CSRF header and are audit-logged + rate-limited.
//
// Powers the Console "Model Control" panel (Phase A of CareerBoost Command).
//   get         → per-skill routing table: smart default, env overrides,
//                 admin (runtime_config) override, and the EFFECTIVE route,
//                 plus which providers have keys configured and a curated
//                 model catalog per provider.
//   set-route   → { skill | "_global", provider?, model? } — live override,
//                 takes effect in ai-run within ~45s (runtime-config cache).
//   clear-route → { skill } — remove the override (back to env/defaults).
//
// State lives in runtime_config key 'ai_routing' (migration 0046). This
// endpoint stores current state; the change history lives in admin_audit_log.
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";
import { SKILL_ROUTING, modelOverride } from "../_shared/routing.ts";
import { providerHasKey, type LLMProvider } from "../_shared/llm.ts";
import { bustRuntimeConfig, getRuntimeConfig, type AiRouteOverride } from "../_shared/runtime-config.ts";
import type { Skill } from "../_shared/schemas.ts";

const PROVIDERS: LLMProvider[] = ["anthropic", "openai", "gemini", "groq"];

// Curated model choices per provider for the panel dropdowns. Union of what
// SKILL_ROUTING already uses + current-generation Anthropic ids. The UI also
// allows free-text, so this list is a convenience, not a constraint.
function modelCatalog(): Record<string, string[]> {
  const catalog: Record<string, Set<string>> = {
    anthropic: new Set(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-5", "claude-opus-4-8"]),
    openai: new Set(), gemini: new Set(), groq: new Set(),
  };
  for (const skill of Object.keys(SKILL_ROUTING) as Skill[]) {
    const r = SKILL_ROUTING[skill];
    if (r && catalog[r.provider]) catalog[r.provider].add(r.model);
  }
  const out: Record<string, string[]> = {};
  for (const p of Object.keys(catalog)) out[p] = Array.from(catalog[p]).sort();
  return out;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const action = String(body.action || "get");

  // CSRF before auth on mutations (same order as admin-user-adjust).
  if (action !== "get") {
    const csrf = checkAdminCsrf(req);
    if (!csrf.ok) return errorResponse(csrf.error, csrf.status);
  }

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  const svc = getServiceClient();
  const routing = await getRuntimeConfig<Record<string, AiRouteOverride>>("ai_routing", {});

  // ── get ───────────────────────────────────────────────────────────
  if (action === "get") {
    const available = PROVIDERS.filter(providerHasKey);
    const globalEnv = (Deno.env.get("LLM_PROVIDER") || "").trim();
    const globalDb = routing["_global"] || null;

    const skills = (Object.keys(SKILL_ROUTING) as Skill[]).sort().map((skill) => {
      const def = SKILL_ROUTING[skill];
      const envProvider = (Deno.env.get("AI_ROUTING_" + skill.toUpperCase().replace(/-/g, "_")) || "").trim();
      const envModel = modelOverride(skill);
      const db = routing[skill] || null;

      // Mirror ai-run's effective precedence for display:
      //   admin(skill→global) > env global > env skill > smart default.
      const adminProvider = (db && db.provider) || (globalDb && globalDb.provider) || "";
      const effectiveProvider = adminProvider || globalEnv || envProvider || def.provider;
      const source = adminProvider ? "admin" : (globalEnv || envProvider) ? "env" : "default";
      const adminModel = db ? db.model : (globalDb ? globalDb.model : undefined);
      const effectiveModel =
        (adminModel && (!adminProvider || adminProvider === effectiveProvider) ? adminModel : "") ||
        envModel ||
        (effectiveProvider === def.provider ? def.model : "(provider default)");

      return {
        skill, tier: def.tier,
        defaultProvider: def.provider, defaultModel: def.model,
        envProvider: envProvider || null, envModel: envModel || null,
        db,
        effectiveProvider, effectiveModel, source,
      };
    });

    return jsonResponse({
      ok: true,
      config: {
        skills,
        global: globalDb,
        globalEnv: globalEnv || null,
        availableProviders: available,
        modelCatalog: modelCatalog(),
      },
    });
  }

  // ── mutations ─────────────────────────────────────────────────────
  const rate = await enforceAdminRate(admin, "console-config");
  if (!rate.allowed) return errorResponse(rate.reason || "Admin rate limit exceeded.", 429);

  const meta = extractRequestMeta(req);

  // ── set-key / clear-key (live provider API-key override) ──────────
  // Lets the operator rotate a dead/dry key from the Console without a
  // redeploy. Stored in runtime_config 'provider_keys'; getProviderKey()
  // reads it (override beats env). The key value is NEVER returned to the
  // browser and NEVER written to the audit log — only the provider name.
  if (action === "set-key" || action === "clear-key") {
    const provider = String(body.provider || "").trim().toLowerCase();
    if (!PROVIDERS.includes(provider as LLMProvider)) {
      return errorResponse("provider must be one of: " + PROVIDERS.join(", "), 400);
    }
    const keys = await getRuntimeConfig<Record<string, string>>("provider_keys", {});
    const next: Record<string, string> = { ...keys };

    if (action === "set-key") {
      const key = String(body.key || "").trim();
      if (key.length < 8 || key.length > 512) {
        return errorResponse("That key looks wrong (expected 8–512 characters).", 400);
      }
      if (/\s/.test(key)) return errorResponse("Key must not contain spaces.", 400);
      next[provider] = key;
    } else {
      if (!keys[provider]) return jsonResponse({ ok: true, provider, hasOverride: false }); // already clear
      delete next[provider];
    }

    const { error } = await svc.from("runtime_config").upsert({
      key: "provider_keys", value: next, updated_by: admin.id, updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (error) {
      return errorResponse(
        "Save failed: " + error.message +
        (error.message.includes("runtime_config") || error.code === "42P01"
          ? " — apply migration 0046_runtime_config_and_agents.sql first."
          : ""),
        500,
      );
    }
    bustRuntimeConfig("provider_keys");
    await logAdminAction(admin, action === "set-key" ? "config_set_provider_key" : "config_clear_provider_key", {
      payload: { provider }, resultStatus: "success", ...meta,
    });
    return jsonResponse({ ok: true, provider, hasOverride: action === "set-key" });
  }

  const skill = String(body.skill || "").trim();
  const validSkill = skill === "_global" || Object.prototype.hasOwnProperty.call(SKILL_ROUTING, skill);
  if (!validSkill) return errorResponse("Unknown skill: " + (skill || "(missing)"), 400);

  if (action === "set-route") {
    const provider = String(body.provider || "").trim().toLowerCase();
    const model = String(body.model || "").trim().slice(0, 120);
    if (provider && !PROVIDERS.includes(provider as LLMProvider)) {
      return errorResponse("provider must be one of: " + PROVIDERS.join(", "), 400);
    }
    if (!provider && !model) return errorResponse("Provide a provider and/or model.", 400);
    if (model && !/^[A-Za-z0-9._\-\/]+$/.test(model)) {
      return errorResponse("model contains invalid characters.", 400);
    }

    const next = { ...routing };
    next[skill] = {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
    const { error } = await svc.from("runtime_config").upsert({
      key: "ai_routing", value: next, updated_by: admin.id, updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (error) {
      return errorResponse(
        "Save failed: " + error.message +
        (error.message.includes("runtime_config") || error.code === "42P01"
          ? " — apply migration 0046_runtime_config_and_agents.sql first."
          : ""),
        500,
      );
    }
    bustRuntimeConfig("ai_routing");
    await logAdminAction(admin, "config_set_route", {
      payload: { skill, provider: provider || null, model: model || null, previous: routing[skill] || null },
      resultStatus: "success", ...meta,
    });
    return jsonResponse({ ok: true, skill, route: next[skill] });
  }

  if (action === "clear-route") {
    if (!routing[skill]) return jsonResponse({ ok: true, skill, route: null }); // already clear
    const next = { ...routing };
    const previous = next[skill];
    delete next[skill];
    const { error } = await svc.from("runtime_config").upsert({
      key: "ai_routing", value: next, updated_by: admin.id, updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (error) return errorResponse("Clear failed: " + error.message, 500);
    bustRuntimeConfig("ai_routing");
    await logAdminAction(admin, "config_clear_route", {
      payload: { skill, previous }, resultStatus: "success", ...meta,
    });
    return jsonResponse({ ok: true, skill, route: null });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
