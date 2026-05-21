// POST /functions/v1/admin-tracked-companies
//
// Phase 2.5: admin UI backend for managing the tracked_companies
// registry. Five verbs, all gated by admin role:
//
//   { action: "list" }
//     → { ok, companies: TrackedCompany[] }
//
//   { action: "probe", ats: "greenhouse"|"lever", ats_token: string }
//     → { ok: bool, jobsFound: number, error?: string }
//     Calls the ATS endpoint directly to verify the token works before
//     saving. No DB write. Lets operator test a token before adding.
//
//   { action: "upsert", company: {...} }
//     → { ok, company: TrackedCompany }
//     Insert or update by id. Required: slug, ats, ats_token, name.
//
//   { action: "toggle", id: uuid, active: bool }
//     → { ok }
//     Quick on/off without a full edit.
//
//   { action: "delete", id: uuid }
//     → { ok }
//     Hard delete. Use with care.
//
// Every mutation writes to admin_audit_log so the team can see who
// added/removed which company and when.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";

const VALID_ATS = new Set(["greenhouse", "lever", "workable", "smartrecruiters", "ashby"]);
const PROBE_TIMEOUT_MS = 8000;

interface CompanyInput {
  id?: string;
  slug?: string;
  ats?: string;
  ats_token?: string;
  name?: string;
  careers_url?: string;
  regions?: string[];
  active?: boolean;
  cache_ttl_s?: number;
  notes?: string;
}

interface Body {
  action?: string;
  id?: string;
  ats?: string;
  ats_token?: string;
  active?: boolean;
  company?: CompanyInput;
}

// ----- ATS probe -----------------------------------------------------------

async function probeAts(ats: string, token: string): Promise<{ ok: boolean; jobsFound: number; error?: string }> {
  if (!VALID_ATS.has(ats)) return { ok: false, jobsFound: 0, error: `Unsupported ATS: ${ats}` };
  if (!token) return { ok: false, jobsFound: 0, error: "Token is required" };

  let url: string;
  if (ats === "greenhouse") url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;
  else if (ats === "lever") url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  else return { ok: false, jobsFound: 0, error: `Probe not implemented for ATS: ${ats}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "CareerBoost admin probe" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, jobsFound: 0, error: `HTTP ${res.status} from ${ats}` };
    }
    const json = await res.json();
    let count = 0;
    if (ats === "greenhouse") count = Array.isArray(json?.jobs) ? json.jobs.length : 0;
    else if (ats === "lever") count = Array.isArray(json) ? json.length : 0;
    return { ok: true, jobsFound: count };
  } catch (err) {
    return { ok: false, jobsFound: 0, error: (err as Error).message || "Probe failed" };
  } finally {
    clearTimeout(timer);
  }
}

// ----- handler -------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // Admin gate
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

  const meta = extractRequestMeta(req);
  const svc = getServiceClient();
  const action = String(body.action || "").trim().toLowerCase();

  // Day 3.3: CSRF check on mutating actions only (list + probe are
  // read-only and don't need nonce — keeps the probe button cheap to
  // call repeatedly during operator data-entry).
  if (action !== "list" && action !== "probe") {
    const csrf = checkAdminCsrf(req);
    if (!csrf.ok) return errorResponse(csrf.error, csrf.status);
    // Day 3.4: rate-limit mutations only (list/probe stay free).
    const rate = await enforceAdminRate(admin, "admin-tracked-companies." + action);
    if (!rate.allowed) return errorResponse(rate.reason || "Rate limit exceeded.", 429);
  }

  // -- list --
  if (action === "list") {
    const { data, error } = await svc
      .from("tracked_companies")
      .select("id, slug, ats, ats_token, name, careers_url, regions, active, cache_ttl_s, notes, created_at, updated_at")
      .order("active", { ascending: false })
      .order("name", { ascending: true });
    if (error) return errorResponse("Failed to list: " + error.message, 502);
    return jsonResponse({ ok: true, companies: data || [] });
  }

  // -- probe -- (no DB write, no audit log; cheap to call repeatedly)
  if (action === "probe") {
    const ats = String(body.ats || "").trim().toLowerCase();
    const token = String(body.ats_token || "").trim();
    const result = await probeAts(ats, token);
    return jsonResponse({ ok: result.ok, jobsFound: result.jobsFound, error: result.error });
  }

  // -- upsert --
  if (action === "upsert") {
    const c = body.company || {};
    const slug = String(c.slug || "").trim().toLowerCase().replace(/[^a-z0-9\-]/g, "-");
    const ats = String(c.ats || "").trim().toLowerCase();
    const ats_token = String(c.ats_token || "").trim();
    const name = String(c.name || "").trim();

    if (!slug) return errorResponse("slug is required", 400);
    if (!VALID_ATS.has(ats)) return errorResponse(`ats must be one of: ${Array.from(VALID_ATS).join(", ")}`, 400);
    if (!ats_token) return errorResponse("ats_token is required", 400);
    if (!name) return errorResponse("name is required", 400);

    const row: Record<string, unknown> = {
      slug, ats, ats_token, name,
      careers_url: c.careers_url ? String(c.careers_url).trim().slice(0, 500) : null,
      regions: Array.isArray(c.regions) && c.regions.length
        ? c.regions.map((r) => String(r).trim().toLowerCase()).filter(Boolean).slice(0, 10)
        : ["global"],
      active: c.active === false ? false : true,
      cache_ttl_s: Math.max(60, Math.min(86400, Number(c.cache_ttl_s) || 1800)),
      notes: c.notes ? String(c.notes).slice(0, 2000) : null,
    };
    if (c.id) row.id = String(c.id);

    let resp;
    if (c.id) {
      resp = await svc.from("tracked_companies").update(row).eq("id", c.id).select().single();
    } else {
      resp = await svc.from("tracked_companies").upsert(row, { onConflict: "ats,ats_token" }).select().single();
    }
    if (resp.error) {
      await logAdminAction(admin, "tracked_companies.upsert", {
        targetUserId: null, targetEmail: null,
        payload: { slug, ats, ats_token, name, attempted: true },
        resultStatus: "failed", errorMessage: resp.error.message,
        ...meta,
      });
      return errorResponse("Upsert failed: " + resp.error.message, 502);
    }
    await logAdminAction(admin, "tracked_companies.upsert", {
      targetUserId: null, targetEmail: null,
      payload: { slug, ats, ats_token, name, id: (resp.data && resp.data.id) || c.id },
      resultStatus: "success",
      ...meta,
    });
    return jsonResponse({ ok: true, company: resp.data });
  }

  // -- toggle (active flag only) --
  if (action === "toggle") {
    const id = String(body.id || "").trim();
    if (!id) return errorResponse("id is required", 400);
    const active = !!body.active;
    const { data, error } = await svc.from("tracked_companies").update({ active }).eq("id", id).select().single();
    if (error) {
      await logAdminAction(admin, "tracked_companies.toggle", {
        targetUserId: null, targetEmail: null,
        payload: { id, active, attempted: true },
        resultStatus: "failed", errorMessage: error.message,
        ...meta,
      });
      return errorResponse("Toggle failed: " + error.message, 502);
    }
    await logAdminAction(admin, "tracked_companies.toggle", {
      targetUserId: null, targetEmail: null,
      payload: { id, active, slug: data?.slug, name: data?.name },
      resultStatus: "success",
      ...meta,
    });
    return jsonResponse({ ok: true, company: data });
  }

  // -- delete --
  if (action === "delete") {
    const id = String(body.id || "").trim();
    if (!id) return errorResponse("id is required", 400);
    // Fetch first so audit log captures what was deleted.
    const { data: existing } = await svc.from("tracked_companies").select("slug, name, ats, ats_token").eq("id", id).single();
    const { error } = await svc.from("tracked_companies").delete().eq("id", id);
    if (error) {
      await logAdminAction(admin, "tracked_companies.delete", {
        targetUserId: null, targetEmail: null,
        payload: { id, ...(existing || {}), attempted: true },
        resultStatus: "failed", errorMessage: error.message,
        ...meta,
      });
      return errorResponse("Delete failed: " + error.message, 502);
    }
    await logAdminAction(admin, "tracked_companies.delete", {
      targetUserId: null, targetEmail: null,
      payload: { id, ...(existing || {}) },
      resultStatus: "success",
      ...meta,
    });
    return jsonResponse({ ok: true });
  }

  return errorResponse(`Unsupported action: ${action}. Use list / probe / upsert / toggle / delete.`, 400);
});
