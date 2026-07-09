// POST /functions/v1/companies-search
//
// Phase 2: direct-from-company job aggregation. Reads the
// tracked_companies registry (admin-managed) and fans out in parallel
// to each active company's ATS Job Board API. Currently supports:
//   - Greenhouse  https://boards-api.greenhouse.io/v1/boards/{token}/jobs
//   - Lever       https://api.lever.co/v0/postings/{token}?mode=json
//   - Workable    https://apply.workable.com/api/v1/widget/accounts/{token}
// Each provider is implemented in its own normalizer below.
//
// Request body matches jobs-search where applicable so the frontend
// can share filter logic:
//   { query?, filters?: { location?, remoteOnly?, postedWithinDays?,
//                          searchRegion?, locationStrictness? }, nlq? }
//
// Response shape mirrors jobs-search:
//   { ok, jobs: CanonicalJobOut[], sources: SourceStatus[] }
//
// Why a separate function rather than inlining into jobs-search?
//   1. Different upstream cadence — ATS feeds change slowly (cache
//      30min comfortably), aggregator feeds change fast (15min).
//   2. Different failure modes — one company being down shouldn't
//      affect aggregator results.
//   3. Independent timeout budget — fanning out to 30 companies in
//      parallel could blow the 150s function timeout if combined
//      with the existing Adzuna fan-out.
//   4. Easier to add new ATS providers (Workable, SmartRecruiters,
//      Ashby) without bloating the main jobs-search function.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface Filters {
  remoteOnly?: boolean;
  postedWithinDays?: number;
  location?: string;
  searchRegion?: string;
  locationStrictness?: "strict" | "balanced" | "broad";
}

interface Body {
  query?: string;
  filters?: Filters;
  nlq?: { keywords?: string[]; location?: string | null; remote?: boolean };
}

interface CanonicalJobOut {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  remote: boolean;
  postedAt: string;
  tags: string[];
  descriptionText: string;
  salary: string;
  logo: string;
  source: string;
  sourceId: string;
  sourceType: "api";
  employmentType: string;
}

interface TrackedCompany {
  id: string;
  slug: string;
  ats: string;
  ats_token: string;
  name: string;
  careers_url: string | null;
  regions: string[];
  cache_ttl_s: number;
}

interface SourceStatus {
  name: string;
  ats: string;
  count: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const TIMEOUT_MS = 8000;            // per-company timeout
const MAX_COMPANIES_PER_REQUEST = 40; // safety cap so we never fan-out beyond 40 calls
const MAX_JOBS_PER_COMPANY = 15;    // cap per-company results to keep response payload manageable

// ----- helpers -------------------------------------------------------------

function safe(v: unknown): string { return v == null ? "" : String(v); }

function clipText(s: unknown, max = 1200): string {
  const raw = safe(s)
    // Greenhouse's `content` is HTML-ENTITY-encoded (&lt;div class=...&gt;), so
    // decode angle brackets FIRST — otherwise the tags survive as literal text
    // and the browser renders "<div class="content-intro">" in the card. Decode
    // brackets → strip the now-real tags → decode the remaining entities.
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<li[^>]*>/gi, " • ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return ""; } })
    .replace(/\s+/g, " ")
    .trim();
  return raw.length > max ? raw.slice(0, max) + "…" : raw;
}

function isoOrEmpty(d: unknown): string {
  if (!d) return "";
  const parsed = new Date(String(d));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function detectRemote(location: string, descriptionText = ""): boolean {
  const text = (location + " " + descriptionText.slice(0, 500)).toLowerCase();
  return /\bremote\b|\banywhere\b|\bwork[\s-]from[\s-]home\b|\bwfh\b/.test(text);
}

async function hashId(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function stableId(prefix: string, url: string, fallback: string): Promise<string> {
  return `${prefix}_${await hashId(url || fallback)}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...(init || {}),
      headers: { accept: "application/json", "user-agent": "CareerBoost job discovery", ...((init?.headers) || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ----- query filtering -----------------------------------------------------
// Companies APIs typically don't accept a search query, so we filter
// client-side here. Permissive matching by design — let the global
// ranker decide the final order.

function tokenize(s: string): string[] {
  return safe(s).toLowerCase().replace(/[^a-z0-9+#.\-\s]+/g, " ").split(/\s+/).filter((t) => t.length > 1);
}

// Whole-word (stem-tolerant) match so "fire" doesn't hit "firewall" while
// "engineer" still matches "engineering". Symbol terms fall back to substring.
function termMatches(text: string, term: string): boolean {
  if (!/^[a-z0-9]+$/.test(term)) return text.includes(term);
  return new RegExp("\\b" + term + "\\w{0,3}\\b").test(text);
}

function jobMatchesQuery(job: CanonicalJobOut, queryTokens: string[]): boolean {
  if (!queryTokens.length) return true;
  const text = (job.title + " " + job.company + " " + job.descriptionText).toLowerCase();
  // Require EVERY query token as a whole word. Previously ANY single token in
  // the title kept the job, so a "fire engineer" search flooded with these
  // tracked tech companies' generic "engineer" roles (GitLab/Twilio backend
  // engineers), and substring matching let "fire" hit "firewall".
  if (!queryTokens.every((t) => termMatches(text, t))) return false;
  // Title anchor: at least one token must appear in the TITLE — description-only
  // matches are not the role the user searched for.
  const title = job.title.toLowerCase();
  return queryTokens.some((t) => termMatches(title, t));
}

// ----- Greenhouse ----------------------------------------------------------

async function fetchGreenhouse(company: TrackedCompany): Promise<CanonicalJobOut[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.ats_token)}/jobs?content=true`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Greenhouse HTTP ${res.status}`);
  const json = await res.json() as { jobs?: Array<Record<string, unknown>> };
  const rows = Array.isArray(json.jobs) ? json.jobs : [];
  const out: CanonicalJobOut[] = [];
  for (const j of rows.slice(0, MAX_JOBS_PER_COMPANY * 3)) { // 3x cap to allow filter culling
    const id = safe(j.id);
    const title = safe(j.title);
    const url = safe(j.absolute_url);
    if (!title || !url) continue;
    const location = safe((j.location as { name?: string } | undefined)?.name) || "Not specified";
    const content = clipText(j.content);
    const postedAt = isoOrEmpty(j.updated_at || j.first_published);
    out.push({
      id: await stableId(`gh-${company.slug}`, url, id),
      title,
      company: company.name,
      location,
      url,
      remote: detectRemote(location, content),
      postedAt,
      tags: [],
      descriptionText: content,
      salary: "",
      logo: "",
      source: company.name,
      sourceId: `greenhouse:${company.ats_token}`,
      sourceType: "api",
      employmentType: "",
    });
  }
  return out;
}

// ----- Lever ---------------------------------------------------------------

async function fetchLever(company: TrackedCompany): Promise<CanonicalJobOut[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company.ats_token)}?mode=json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Lever HTTP ${res.status}`);
  const rows = await res.json() as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  const out: CanonicalJobOut[] = [];
  for (const j of rows.slice(0, MAX_JOBS_PER_COMPANY * 3)) {
    const id = safe(j.id);
    const title = safe(j.text);
    const hostedUrl = safe(j.hostedUrl);
    if (!title || !hostedUrl) continue;
    const categories = j.categories as { location?: string; team?: string; commitment?: string } | undefined;
    const location = safe(categories?.location) || "Not specified";
    const desc = clipText([j.description, j.descriptionPlain, j.additional].map(safe).join("\n"));
    const created = j.createdAt as number | string | undefined;
    const postedAt = typeof created === "number" ? new Date(created).toISOString() : isoOrEmpty(created);
    const employmentType = safe(categories?.commitment).toLowerCase().replace(/\s+/g, "_");
    out.push({
      id: await stableId(`lever-${company.slug}`, hostedUrl, id),
      title,
      company: company.name,
      location,
      url: hostedUrl,
      remote: detectRemote(location, desc),
      postedAt,
      tags: categories?.team ? [String(categories.team).toLowerCase()] : [],
      descriptionText: desc,
      salary: "",
      logo: "",
      source: company.name,
      sourceId: `lever:${company.ats_token}`,
      sourceType: "api",
      employmentType,
    });
  }
  return out;
}

// ----- Dispatcher ----------------------------------------------------------

async function fetchCompany(company: TrackedCompany): Promise<{ jobs: CanonicalJobOut[]; ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    let jobs: CanonicalJobOut[] = [];
    if (company.ats === "greenhouse") jobs = await fetchGreenhouse(company);
    else if (company.ats === "lever") jobs = await fetchLever(company);
    else throw new Error(`Unsupported ATS: ${company.ats}`);
    return { jobs, ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      jobs: [],
      ok: false,
      latencyMs: Date.now() - started,
      error: (err as Error).message || "Company fetch failed",
    };
  }
}

// ----- Region filter -------------------------------------------------------
// If user picked a non-global region, prefer companies tagged for that
// region. Companies tagged 'global' are always included (they hire
// remotely).

function pickCompaniesForRequest(all: TrackedCompany[], filters: Filters): TrackedCompany[] {
  const region = safe(filters.searchRegion || "global").toLowerCase();
  if (!region || region === "global") return all.slice(0, MAX_COMPANIES_PER_REQUEST);
  // Filter: companies tagged with this region OR tagged 'global'.
  const matching = all.filter((c) =>
    c.regions.some((r) => r.toLowerCase() === region || r.toLowerCase() === "global")
  );
  return (matching.length ? matching : all).slice(0, MAX_COMPANIES_PER_REQUEST);
}

// ----- Handler -------------------------------------------------------------

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedUser(req);
  } catch (err) {
    return errorResponse((err as Error).message || "Sign in required", 401);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Service-role client to read tracked_companies (admin-only table).
  const svcUrl = Deno.env.get("SUPABASE_URL");
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!svcUrl || !svcKey) {
    return errorResponse("Server misconfigured: SUPABASE_URL/SERVICE_ROLE_KEY missing", 500);
  }
  const svc = createClient(svcUrl, svcKey, { auth: { persistSession: false } });

  const { data: rows, error } = await svc
    .from("tracked_companies")
    .select("id, slug, ats, ats_token, name, careers_url, regions, cache_ttl_s")
    .eq("active", true);

  if (error) {
    return errorResponse(`Failed to load tracked_companies: ${error.message}`, 502);
  }

  const all = (rows || []) as TrackedCompany[];
  const filters: Filters = body.filters || {};
  const picked = pickCompaniesForRequest(all, filters);

  // Fan-out in parallel. Each company has its own timeout + error
  // isolation — one slow/dead company won't block the whole search.
  const fanoutStarted = Date.now();
  const results = await Promise.all(picked.map((c) => fetchCompany(c).then((r) => ({ company: c, ...r }))));
  const fanoutMs = Date.now() - fanoutStarted;

  // Apply query filter client-side (companies APIs don't accept queries).
  const queryStr = safe(body.query);
  const nlqKeywords = (body.nlq?.keywords || []).join(" ");
  const tokens = tokenize(queryStr + " " + nlqKeywords);
  const remoteOnly = !!(filters.remoteOnly || body.nlq?.remote);
  const postedWithinDays = Number(filters.postedWithinDays || 0) || 0;
  const dayMs = 86400000;
  const cutoffMs = postedWithinDays > 0 ? Date.now() - postedWithinDays * dayMs : 0;

  const merged: CanonicalJobOut[] = [];
  const sources: SourceStatus[] = [];

  for (const r of results) {
    const passed: CanonicalJobOut[] = [];
    for (const j of r.jobs) {
      if (!jobMatchesQuery(j, tokens)) continue;
      if (remoteOnly && !j.remote) continue;
      if (cutoffMs && j.postedAt) {
        const t = Date.parse(j.postedAt);
        if (t && t < cutoffMs) continue;
      }
      passed.push(j);
      if (passed.length >= MAX_JOBS_PER_COMPANY) break;
    }
    merged.push(...passed);
    sources.push({
      name: r.company.name,
      ats: r.company.ats,
      count: passed.length,
      ok: r.ok,
      latencyMs: r.latencyMs,
      ...(r.error ? { error: r.error } : {}),
    });
  }

  return jsonResponse({
    ok: true,
    provider: "companies",
    jobs: merged,
    sources,
    meta: {
      companiesQueried: picked.length,
      companiesAvailable: all.length,
      fanoutMs,
    },
  });
}));
