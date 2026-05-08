// POST /functions/v1/job-import
// Tier C — user-initiated job capture (browser extension / trusted client).
// Auth: Supabase user JWT (Authorization: Bearer <access_token>), validated via getAuthedUser().
// Writes: public.saved_jobs by default, or public.applications when
// target="pipeline". Uses service role only on the backend.
//
// Body (JSON):
// {
//   vendor: string,                 // e.g. "linkedin", "greenhouse", "lever"
//   captureMethod?: "extension"|"manual",
//   target?: "saved_jobs"|"pipeline"|"both",
//   pageUrl?: string,
//   job: {
//     title: string,
//     company?: string,
//     location?: string,
//     url: string,                   // canonical apply or listing URL (https)
//     remote?: boolean,
//     postedAt?: string | null,     // ISO string if known
//     tags?: string[],
//     descriptionText?: string,
//     salary?: string | null,
//     logo?: string | null
//   }
// }
import { corsHeaders, errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

const DESCRIPTION_LIMIT = 24_000;

interface JobPayload {
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  remote?: boolean;
  postedAt?: string | null;
  tags?: string[];
  descriptionText?: string;
  salary?: string | null;
  logo?: string | null;
}

interface ImportBody {
  vendor?: string;
  captureMethod?: "extension" | "manual";
  target?: "saved_jobs" | "pipeline" | "both";
  pageUrl?: string;
  job?: JobPayload;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeHttpUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("URL must be http(s).");
  }
  // Strip fragments for stable dedupe keys.
  u.hash = "";
  return u.href;
}

function vendorLabel(vendor: string): string {
  const v = vendor.toLowerCase().trim();
  const map: Record<string, string> = {
    linkedin: "LinkedIn",
    glassdoor: "Glassdoor",
    monster: "Monster",
    wellfound: "Wellfound",
    greenhouse: "Greenhouse",
    lever: "Lever",
  };
  return map[v] || vendor;
}

function makeExternalId(vendor: string, canonicalUrl: string): string {
  // Keep deterministic + human-debuggable; fits client-side id style used elsewhere.
  return `capture:${vendor.toLowerCase().trim()}:${canonicalUrl}`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function cleanDescriptionText(value: unknown, max = DESCRIPTION_LIMIT): string {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return errorResponse("Invalid JSON body.");
  }

  if (!isNonEmptyString(body.vendor)) return errorResponse("Missing vendor.");
  if (!body.job) return errorResponse("Missing job.");

  const vendor = body.vendor.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(vendor)) {
    return errorResponse("Invalid vendor id.");
  }

  const j = body.job;
  if (!isNonEmptyString(j.title)) return errorResponse("Missing job.title.");
  if (!isNonEmptyString(j.url)) return errorResponse("Missing job.url.");

  let canonicalUrl = "";
  try {
    canonicalUrl = normalizeHttpUrl(j.url!);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Invalid job.url.");
  }

  const svc = getServiceClient();

  const externalId = makeExternalId(vendor, canonicalUrl);
  const source = vendorLabel(vendor);
  const remote = Boolean(j.remote);
  const postedAt = j.postedAt ? String(j.postedAt) : null;

  const descriptionText = cleanDescriptionText(j.descriptionText);

  const payload = {
    tier: "C",
    captureMethod: body.captureMethod ?? "extension",
    target: body.target ?? "saved_jobs",
    pageUrl: body.pageUrl ?? null,
    vendor,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 24) : [],
    descriptionText,
    salary: j.salary ?? null,
    logo: j.logo ?? null,
  };

  const row = {
    user_id: user.id,
    external_id: externalId,
    source,
    title: j.title!.trim(),
    company: j.company?.trim() || null,
    location: j.location?.trim() || null,
    url: canonicalUrl,
    remote,
    posted_at: postedAt,
    payload,
  };

  const target = body.target ?? "saved_jobs";
  let savedJob: unknown = null;
  let application: unknown = null;

  if (target === "saved_jobs" || target === "both") {
    const { data, error } = await svc
      .from("saved_jobs")
      .upsert(row, { onConflict: "user_id,external_id" })
      .select("id, external_id, saved_at")
      .single();

    if (error) {
      return errorResponse("Failed to save job: " + error.message, 500);
    }
    savedJob = data;
  }

  if (target === "pipeline" || target === "both") {
    const existing = await svc
      .from("applications")
      .select("id")
      .eq("user_id", user.id)
      .eq("source_url", canonicalUrl)
      .limit(1)
      .maybeSingle();

    if (existing.error) {
      return errorResponse("Failed to check pipeline duplicate: " + existing.error.message, 500);
    }

    const appRow = {
      user_id: user.id,
      company: j.company?.trim() || vendorLabel(vendor),
      role: j.title!.trim(),
      stage: "saved",
      priority: "medium",
      applied_at: todayIsoDate(),
      next_action: "Tailor resume and apply",
      notes:
        `Imported from ${source} via CareerBoost extension.\n` +
        `Source: ${canonicalUrl}` +
        (j.location?.trim() ? `\nLocation: ${j.location.trim()}` : "") +
        (descriptionText
          ? `\n\nJob description snapshot:\n${descriptionText}`
          : ""),
      source_url: canonicalUrl,
      location: j.location?.trim() || null,
      salary: j.salary ?? null,
      remote,
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 24) : [],
    };

    const result = existing.data?.id
      ? await svc
        .from("applications")
        .update(appRow)
        .eq("id", existing.data.id)
        .select("id, company, role, stage, source_url")
        .single()
      : await svc
        .from("applications")
        .insert(appRow)
        .select("id, company, role, stage, source_url")
        .single();

    if (result.error) {
      return errorResponse("Failed to save to pipeline: " + result.error.message, 500);
    }
    application = result.data;
  }

  return jsonResponse({
    ok: true,
    target,
    savedJob,
    application,
  });
});
