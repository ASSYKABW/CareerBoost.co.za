// POST /functions/v1/jobs-search
// Tier A only: in-app listings come from documented feeds/APIs or approved
// sources. LinkedIn/Indeed remain handoff/import workflows unless official
// partner access is configured elsewhere.
//
// Phase 3: Adzuna fan-out (up to 8 country requests per query) is now cached
// at the Edge layer with a 15-minute TTL keyed on (query + filters). Repeat
// searches within that window skip the upstream HTTP fan-out entirely.
import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";
import { buildKvKey, readKvCache, writeKvCache } from "../_shared/kv-cache.ts";

interface Filters {
  remoteOnly?: boolean;
  postedWithinDays?: number;
  sort?: "newest" | "relevance" | "match" | "oldest" | "role-fit";
  location?: string;
  jobType?: string[];
  experienceLevel?: string[];
  activeOnly?: boolean;
  searchRegion?: string;
  locationStrictness?: "strict" | "balanced" | "broad";
}

interface NlqHints {
  keywords?: string[];
  location?: string | null;
  remote?: boolean;
  postedWithinDays?: number;
  seniority?: string;
}

interface Body {
  query?: string;
  filters?: Filters;
  nlq?: NlqHints;
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
  providerSource?: string;
  finalUrl?: string;
  finalSource?: string;
  sourceTrust?: {
    reportedSource?: string;
    urlHost?: string;
    finalUrlHost?: string;
    urlVerified?: boolean;
    reason?: string;
    warning?: string;
  };
}

interface SourceStatus {
  name: string;
  count: number;
  ok: boolean;
  error?: string;
}

const TIMEOUT_MS = 12_000;
const ENRICH_TIMEOUT_MS = 4_500;
const MAX_PER_SOURCE = 50;
const DESCRIPTION_LIMIT = 24_000;
const ENRICH_PER_SOURCE = 18;

const ADZUNA_COUNTRIES: Record<string, string[]> = {
  global: ["za", "gb", "us", "au", "ca", "de", "nl", "fr", "sg", "in"],
  africa: ["za"],
  europe: ["gb", "de", "fr", "nl", "es", "it"],
  north_america: ["us", "ca"],
  asia_pacific: ["au", "sg", "in"],
};

const JOB_TYPE_TERMS: Record<string, string[]> = {
  full_time: ["full time", "full-time", "permanent"],
  part_time: ["part time", "part-time"],
  contract: ["contract", "contractor", "freelance"],
  internship: ["intern", "internship", "graduate"],
  temporary: ["temporary", "temp"],
};

const EXP_LEVEL_TERMS: Record<string, string[]> = {
  internship: ["intern", "internship", "placement", "graduate"],
  entry: ["entry", "junior", "jr", "new grad", "graduate"],
  associate: ["associate"],
  mid_senior: ["mid", "intermediate", "senior", "sr", "staff"],
  director_plus: ["director", "head of", "vp", "vice president", "principal"],
};

const QUERY_NOISE = new Set([
  "apply", "career", "careers", "hiring", "job", "jobs", "role", "roles", "position", "positions",
  "work", "remote", "hybrid", "onsite", "on-site", "full", "time", "fulltime", "full-time",
  "part", "contract", "permanent", "temporary", "internship", "entry", "junior", "senior",
  "lead", "principal", "staff", "mid", "engineer", "engineering", "developer", "manager",
]);

const REGION_TERMS: Record<string, string[]> = {
  africa: ["africa", "south africa", "za", "gauteng", "pretoria", "centurion", "johannesburg", "cape town", "durban", "kenya", "nigeria", "ghana"],
  europe: ["europe", "emea", "uk", "united kingdom", "england", "london", "germany", "berlin", "france", "netherlands", "spain", "italy"],
  north_america: ["north america", "usa", "united states", "us", "canada", "new york", "california", "texas", "toronto", "vancouver"],
  asia_pacific: ["asia", "apac", "australia", "au", "sydney", "melbourne", "singapore", "india", "japan", "tokyo"],
};

function safeString(v: unknown): string {
  return String(v ?? "").trim();
}

function stripHtml(input: unknown): string {
  return safeString(input)
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
    .trim();
}

function clipDescription(input: unknown): string {
  return stripHtml(input).slice(0, DESCRIPTION_LIMIT).trim();
}

function hostFromUrl(url: string): string {
  try {
    return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function slugSourceLabel(label: string): string {
  return String(label || "source")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "source";
}

function inferSourceFromUrl(url: string): string {
  const host = hostFromUrl(url);
  if (!host) return "";
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
  if (host === "indeed.com" || host.endsWith(".indeed.com")) return "Indeed";
  if (host === "adzuna.com" || host.endsWith(".adzuna.com") || host.startsWith("adzuna.")) return "Adzuna";
  if (host === "reed.co.uk" || host.endsWith(".reed.co.uk")) return "Reed.co.uk";
  if (host === "remotive.com" || host.endsWith(".remotive.com")) return "Remotive";
  if (host === "jobmail.co.za" || host.endsWith(".jobmail.co.za")) return "Jobmail";
  if (host === "bebee.com" || host.endsWith(".bebee.com")) return "beBee";
  if (host.includes("rpo-recruitment") || host.includes("rporecruitment")) return "RPO Recruitment";
  if (host.includes("executiveplacements")) return "ExecutivePlacements.com";
  if (host.includes("careerjunction")) return "CareerJunction";
  if (host.includes("pnet")) return "PNet";
  if (host.includes("glassdoor")) return "Glassdoor";
  if (host.includes("ziprecruiter")) return "ZipRecruiter";
  if (host.includes("workdayjobs") || host.includes("myworkdayjobs")) return "Workday";
  return host
    .replace(/\.(co\.uk|co\.za|com\.au|com|org|net|io|ai|co|jobs)$/i, "")
    .split(".")
    .pop()!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function collectJsonLdJobDescriptions(node: unknown, out: string[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectJsonLdJobDescriptions(item, out));
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const typeRaw = obj["@type"];
  const types = Array.isArray(typeRaw) ? typeRaw : [typeRaw];
  const isJobPosting = types.some((t) => /jobposting/i.test(String(t || "")));
  if (isJobPosting && typeof obj.description === "string") {
    out.push(obj.description);
  }
  collectJsonLdJobDescriptions(obj["@graph"], out);
}

function extractJsonLdDescription(html: string): string {
  const descriptions: string[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const raw = (match[1] || "")
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&amp;/g, "&")
      .trim();
    if (!raw) continue;
    try {
      collectJsonLdJobDescriptions(JSON.parse(raw), descriptions);
    } catch {
      // Non-critical: many boards ship malformed or multiple JSON-LD blocks.
    }
  }
  return descriptions
    .map((x) => clipDescription(x))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function extractHtmlDescriptionFallback(html: string): string {
  const candidates: string[] = [];
  const patterns = [
    /<(?:section|article|div)[^>]+(?:id|class)=["'][^"']*(?:job[-_\s]?description|jobDescription|jobs-description|description__text|posting-description)[^"']*["'][^>]*>([\s\S]{200,120000}?)<\/(?:section|article|div)>/gi,
    /<(?:main|article)[^>]*>([\s\S]{500,160000}?)<\/(?:main|article)>/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      const text = clipDescription(match[1] || "");
      if (text.length >= 200) candidates.push(text);
    }
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

function extractDescriptionFromHtml(html: string): string {
  if (!html) return "";
  return extractJsonLdDescription(html) || extractHtmlDescriptionFallback(html);
}

async function fetchListingEnrichment(url: string): Promise<{
  finalUrl: string;
  finalSource: string;
  descriptionText: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
        "user-agent": "CareerBoost job listing resolver",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = res.url || url;
    const contentType = res.headers.get("content-type") || "";
    let descriptionText = "";
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      const html = await res.text();
      descriptionText = extractDescriptionFromHtml(html);
    }
    return {
      finalUrl,
      finalSource: inferSourceFromUrl(finalUrl),
      descriptionText,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function enrichJobDestinations(jobs: CanonicalJobOut[]): Promise<CanonicalJobOut[]> {
  const out = jobs.map((job) => ({ ...job }));
  const targetIndexes = out
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => {
      const host = hostFromUrl(job.url);
      return job.sourceId === "adzuna" || job.source === "Adzuna" || host.includes("adzuna.");
    })
    .slice(0, ENRICH_PER_SOURCE);

  await Promise.all(targetIndexes.map(async ({ job, index }) => {
    try {
      const enriched = await fetchListingEnrichment(job.url);
      const finalUrl = enriched.finalUrl || job.url;
      const finalHost = hostFromUrl(finalUrl);
      const originalHost = hostFromUrl(job.url);
      const finalSource = enriched.finalSource || inferSourceFromUrl(finalUrl);

      if (finalUrl && finalUrl !== job.url) {
        out[index].finalUrl = finalUrl;
        out[index].url = finalUrl;
      }
      if (finalSource && finalSource !== job.source) {
        out[index].providerSource = job.source;
        out[index].finalSource = finalSource;
        out[index].source = finalSource;
        out[index].sourceId = slugSourceLabel(finalSource);
        out[index].sourceTrust = {
          reportedSource: job.source,
          urlHost: originalHost,
          finalUrlHost: finalHost,
          urlVerified: true,
          reason: `Found via ${job.source}; final listing opens at ${finalSource}.`,
          warning: `Found via ${job.source}, but the final listing opens at ${finalSource}.`,
        };
      }
      if (enriched.descriptionText && enriched.descriptionText.length > (job.descriptionText || "").length + 120) {
        out[index].descriptionText = enriched.descriptionText.slice(0, DESCRIPTION_LIMIT);
      }
    } catch {
      // Keep the provider result if redirect/detail enrichment is blocked.
    }
  }));

  return out;
}

function toDateIso(input: unknown): string {
  const raw = safeString(input);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function normalizeTokens(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
    .slice(0, 16);
}

function uniqueStrings(items: unknown[], max = 16): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const item of items || []) {
    const s = safeString(item);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function queryTerms(body: Body): string[] {
  const q = safeString(body.query);
  const nlq = body.nlq || {};
  const parts = [
    ...normalizeTokens(q),
    ...uniqueStrings(nlq.keywords || [], 12).flatMap((x) => normalizeTokens(x)),
  ].filter((x) => !QUERY_NOISE.has(x));
  return uniqueStrings(parts, 18).map((x) => x.toLowerCase());
}

function searchText(job: CanonicalJobOut): string {
  return [
    job.title,
    job.company,
    job.location,
    job.employmentType,
    job.tags.join(" "),
    job.descriptionText,
  ].join(" ").toLowerCase();
}

function daysSince(iso: string): number {
  if (!iso) return 9999;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 9999;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function matchesJobType(job: CanonicalJobOut, filters: Filters): boolean {
  const picked = Array.isArray(filters.jobType) ? filters.jobType : [];
  if (!picked.length) return true;
  const text = searchText(job);
  return picked.some((key) => {
    const terms = JOB_TYPE_TERMS[key] || [key.replace(/_/g, " ")];
    return terms.some((term) => text.includes(term));
  });
}

function matchesExperience(job: CanonicalJobOut, filters: Filters): boolean {
  const picked = Array.isArray(filters.experienceLevel) ? filters.experienceLevel : [];
  if (!picked.length) return true;
  const text = searchText(job);
  return picked.some((key) => {
    const terms = EXP_LEVEL_TERMS[key] || [key.replace(/_/g, " ")];
    return terms.some((term) => text.includes(term));
  });
}

function matchesLocation(job: CanonicalJobOut, filters: Filters): boolean {
  const wanted = safeString(filters.location).toLowerCase();
  const strictness = filters.locationStrictness || "strict";
  if (!wanted) return true;
  if (job.remote && /remote|anywhere|work from home|wfh/.test(wanted)) return true;
  const loc = safeString(job.location).toLowerCase();
  if (loc.includes(wanted)) return true;
  const text = searchText(job);
  if (/south africa|\bsa\b|\bza\b/.test(wanted) && /\b(za|south africa|gauteng|pretoria|centurion|johannesburg|cape town|durban)\b/.test(text)) return true;
  if (/united kingdom|\buk\b/.test(wanted) && /\b(uk|united kingdom|england|london|manchester)\b/.test(text)) return true;
  if (/united states|\busa\b|\bus\b/.test(wanted) && /\b(us|usa|united states|new york|california|texas)\b/.test(text)) return true;
  const tokens = normalizeTokens(wanted).filter((x) => x.length > 2);
  if (!tokens.length) return true;
  const hits = tokens.reduce((sum, token) => sum + (loc.includes(token) ? 1 : 0), 0);
  if (strictness === "strict") return hits >= Math.min(tokens.length, 2);
  return hits > 0;
}

function matchesRegion(job: CanonicalJobOut, filters: Filters): boolean {
  const region = safeString(filters.searchRegion || "global").toLowerCase();
  if (!region || region === "global") return true;
  const terms = REGION_TERMS[region] || [];
  if (!terms.length) return true;
  const text = searchText(job);
  return terms.some((term) => text.includes(term));
}

function matchesQuery(job: CanonicalJobOut, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = searchText(job);
  const strong = safeString(job.title + " " + job.company).toLowerCase();
  return terms.some((term) => strong.includes(term)) ||
    terms.filter((term) => text.includes(term)).length >= Math.min(2, terms.length);
}

function applyFilters(jobs: CanonicalJobOut[], body: Body): CanonicalJobOut[] {
  const filters: Filters = body.filters || {};
  const terms = queryTerms(body);
  const postedWithinDays = Number(filters.postedWithinDays || body.nlq?.postedWithinDays || 0) || 0;
  const remoteOnly = !!(filters.remoteOnly || body.nlq?.remote);
  return jobs.filter((job) => {
    if (!job.url || !job.title) return false;
    if (remoteOnly && !job.remote) return false;
    if (postedWithinDays > 0 && daysSince(job.postedAt) > postedWithinDays) return false;
    if (!matchesLocation(job, filters)) return false;
    if (!matchesRegion(job, filters)) return false;
    if (!matchesJobType(job, filters)) return false;
    if (!matchesExperience(job, filters)) return false;
    if (!matchesQuery(job, terms)) return false;
    return true;
  });
}

function formatSalary(min: unknown, max: unknown, currency: unknown): string {
  const lo = Number(min || 0);
  const hi = Number(max || 0);
  const code = safeString(currency).toUpperCase();
  if (!lo && !hi) return "";
  if (lo && hi) return `${code ? code + " " : ""}${Math.round(lo / 1000)}k-${Math.round(hi / 1000)}k`;
  return `${code ? code + " " : ""}${Math.round((lo || hi) / 1000)}k`;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "CareerBoost job discovery",
      },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
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

function dedupeJobs(jobs: CanonicalJobOut[]): CanonicalJobOut[] {
  const seen: Record<string, boolean> = {};
  const out: CanonicalJobOut[] = [];
  for (const job of jobs) {
    const key = safeString(job.url).replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase() ||
      `${job.company}|${job.title}|${job.location}`.toLowerCase();
    if (!key || seen[key]) continue;
    seen[key] = true;
    out.push(job);
  }
  return out;
}

function sortJobs(jobs: CanonicalJobOut[], body: Body): CanonicalJobOut[] {
  const sort = body.filters?.sort || "newest";
  const terms = queryTerms(body);
  function relevance(job: CanonicalJobOut): number {
    const text = searchText(job);
    return terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
  }
  return jobs.slice().sort((a, b) => {
    if (sort === "oldest") return (Date.parse(a.postedAt) || 0) - (Date.parse(b.postedAt) || 0);
    if (sort === "relevance" || sort === "role-fit") {
      const diff = relevance(b) - relevance(a);
      if (diff) return diff;
    }
    return (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0);
  });
}

async function runRemotive(body: Body): Promise<CanonicalJobOut[]> {
  const url = new URL("https://remotive.com/api/remote-jobs");
  const q = safeString(body.query || queryTerms(body).join(" "));
  if (q) url.searchParams.set("search", q.slice(0, 120));
  const data = await fetchJson(url.toString()) as { jobs?: Record<string, unknown>[] };
  const rows = Array.isArray(data.jobs) ? data.jobs : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const tags = uniqueStrings([
      item.category,
      item.job_type,
      ...(Array.isArray(item.tags) ? item.tags : []),
    ], 8).map((x) => x.toLowerCase());
    const loc = safeString(item.candidate_required_location || "Remote");
    const out: CanonicalJobOut = {
      id: await stableId("remotive", safeString(item.url), safeString(item.id || item.title)),
      title: safeString(item.title),
      company: safeString(item.company_name),
      location: loc || "Remote",
      url: safeString(item.url),
      remote: true,
      postedAt: toDateIso(item.publication_date),
      tags,
      descriptionText: clipDescription(item.description),
      salary: safeString(item.salary),
      logo: safeString(item.company_logo),
      source: "Remotive",
      sourceId: "remotive",
      sourceType: "api",
      employmentType: safeString(item.job_type || "remote").toLowerCase(),
    };
    return out;
  }));
}

async function runArbeitnow(body: Body): Promise<CanonicalJobOut[]> {
  const data = await fetchJson("https://www.arbeitnow.com/api/job-board-api") as {
    data?: Record<string, unknown>[];
  };
  const rows = Array.isArray(data.data) ? data.data : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const tags = uniqueStrings([
      ...(Array.isArray(item.tags) ? item.tags : []),
      ...(Array.isArray(item.job_types) ? item.job_types : []),
    ], 8).map((x) => x.toLowerCase());
    const loc = safeString(item.location || (item.remote ? "Remote" : ""));
    const url = safeString(item.url);
    const out: CanonicalJobOut = {
      id: await stableId("arbeitnow", url, safeString(item.slug || item.title)),
      title: safeString(item.title),
      company: safeString(item.company_name),
      location: loc || "Not specified",
      url,
      remote: !!item.remote || /remote|anywhere|work from home/i.test(loc),
      postedAt: toDateIso(item.created_at),
      tags,
      descriptionText: clipDescription(item.description),
      salary: "",
      logo: "",
      source: "Arbeitnow",
      sourceId: "arbeitnow",
      sourceType: "api",
      employmentType: tags.find((x) => /full|part|contract|intern|temp/.test(x)) || "not_specified",
    };
    return out;
  }));
}

async function runJobicy(body: Body): Promise<CanonicalJobOut[]> {
  const url = new URL("https://jobicy.com/api/v2/remote-jobs");
  url.searchParams.set("count", String(MAX_PER_SOURCE));
  const firstKeyword = queryTerms(body)[0];
  if (firstKeyword) url.searchParams.set("tag", firstKeyword);
  const data = await fetchJson(url.toString()) as { jobs?: Record<string, unknown>[] };
  const rows = Array.isArray(data.jobs) ? data.jobs : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const tags = uniqueStrings([
      item.jobIndustry,
      item.jobType,
      item.jobLevel,
    ], 8).map((x) => x.toLowerCase());
    const loc = safeString(item.jobGeo || "Remote");
    const out: CanonicalJobOut = {
      id: await stableId("jobicy", safeString(item.url), safeString(item.id || item.jobSlug || item.jobTitle)),
      title: safeString(item.jobTitle),
      company: safeString(item.companyName),
      location: loc || "Remote",
      url: safeString(item.url),
      remote: true,
      postedAt: toDateIso(item.pubDate),
      tags,
      descriptionText: clipDescription(item.jobDescription || item.jobExcerpt),
      salary: formatSalary(item.annualSalaryMin, item.annualSalaryMax, item.salaryCurrency),
      logo: safeString(item.companyLogo),
      source: "Jobicy",
      sourceId: "jobicy",
      sourceType: "api",
      employmentType: safeString(item.jobType || "remote").toLowerCase(),
    };
    return out;
  }));
}

function adzunaCountries(region: string): string[] {
  return (ADZUNA_COUNTRIES[region] || ADZUNA_COUNTRIES.global).slice(0, 8);
}

const ADZUNA_CACHE_TTL_SECONDS = 15 * 60; // 15 min

async function runAdzunaUncached(body: Body): Promise<CanonicalJobOut[]> {
  const appId = safeString(Deno.env.get("ADZUNA_APP_ID"));
  const appKey = safeString(Deno.env.get("ADZUNA_APP_KEY"));
  if (!appId || !appKey) throw new Error("ADZUNA_APP_ID or ADZUNA_APP_KEY is not configured.");
  const filters: Filters = body.filters || {};
  const countries = adzunaCountries(safeString(filters.searchRegion || "global"));
  const q = safeString(body.query || queryTerms(body).join(" "));
  const pages = countries.map(async (country) => {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1`);
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", "35");
    if (q) url.searchParams.set("what", q.slice(0, 120));
    if (filters.remoteOnly) url.searchParams.set("where", "remote");
    else if (filters.location) url.searchParams.set("where", safeString(filters.location).slice(0, 100));
    if ((Number(filters.postedWithinDays) || 0) > 0) {
      url.searchParams.set("max_days_old", String(Number(filters.postedWithinDays)));
    }
    const data = await fetchJson(url.toString()) as { results?: Record<string, unknown>[] };
    const rows = Array.isArray(data.results) ? data.results : [];
    return Promise.all(rows.map(async (item) => {
      const location = item.location as { display_name?: string } | undefined;
      const company = item.company as { display_name?: string } | undefined;
      const category = item.category as { label?: string } | undefined;
      const loc = safeString(location?.display_name);
      return {
        id: await stableId("adzuna", safeString(item.redirect_url), safeString(item.id || item.title)),
        title: safeString(item.title),
        company: safeString(company?.display_name),
        location: loc,
        url: safeString(item.redirect_url),
        remote: /remote|work from home|wfh|anywhere/i.test(`${loc} ${item.title}`),
        postedAt: toDateIso(item.created),
        tags: uniqueStrings([category?.label, item.contract_time, item.contract_type, `country:${country}`], 8)
          .map((x) => x.toLowerCase()),
        descriptionText: clipDescription(item.description),
        salary: formatSalary(item.salary_min, item.salary_max, country.toUpperCase()),
        logo: "",
        source: "Adzuna",
        sourceId: "adzuna",
        sourceType: "api" as const,
        employmentType: safeString(item.contract_time || item.contract_type || "not_specified").toLowerCase(),
      };
    }));
  });
  const nested = await Promise.all(pages);
  return nested.flat();
}

// Cache wrapper for Adzuna. Cache key = (query + filters that change results).
// `searchRegion` matters because it determines which countries we fan out to;
// `remoteOnly` and `postedWithinDays` change Adzuna's filter params; `location`
// changes the `where` parameter. Other body fields (sort, jobType client-side
// filters) don't change the upstream call so they're excluded from the key.
async function runAdzuna(body: Body): Promise<CanonicalJobOut[]> {
  const filters: Filters = body.filters || {};
  const cacheParts = {
    q: safeString(body.query || queryTerms(body).join(" ")).toLowerCase().trim(),
    region: safeString(filters.searchRegion || "global").toLowerCase(),
    remoteOnly: !!filters.remoteOnly,
    location: safeString(filters.location).toLowerCase().trim(),
    postedWithinDays: Number(filters.postedWithinDays) || 0,
  };
  const cacheKey = await buildKvKey(cacheParts);
  const cached = await readKvCache<CanonicalJobOut[]>("adzuna", cacheKey);
  if (cached.payload) {
    return cached.payload;
  }
  const fresh = await runAdzunaUncached(body);
  // Don't cache empty result sets — they're often a transient upstream blip,
  // and re-trying soon is cheap (one user-initiated re-search).
  if (fresh.length > 0) {
    writeKvCache("adzuna", cacheKey, fresh, ADZUNA_CACHE_TTL_SECONDS).catch(() => {});
  }
  return fresh;
}

async function runSource(
  name: string,
  runner: () => Promise<CanonicalJobOut[]>,
  body: Body,
): Promise<{ jobs: CanonicalJobOut[]; source: SourceStatus }> {
  try {
    const raw = await runner();
    const filtered = applyFilters(raw, body).slice(0, MAX_PER_SOURCE);
    const enriched = await enrichJobDestinations(filtered);
    return {
      jobs: enriched,
      source: { name, count: enriched.length, ok: true },
    };
  } catch (err) {
    return {
      jobs: [],
      source: {
        name,
        count: 0,
        ok: false,
        error: (err as Error).message || "Source failed.",
      },
    };
  }
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const runs = await Promise.all([
    runSource("Remotive", () => runRemotive(body), body),
    runSource("Arbeitnow", () => runArbeitnow(body), body),
    runSource("Jobicy", () => runJobicy(body), body),
    runSource("Adzuna", () => runAdzuna(body), body),
  ]);

  const jobs = sortJobs(dedupeJobs(runs.flatMap((r) => r.jobs)), body).slice(0, 80);
  const sources = runs.map((r) => r.source);
  const warnings = [
    "LinkedIn and Indeed are handled as handoff/import sources unless official partner access is configured.",
  ];

  return jsonResponse({
    ok: true,
    provider: "backend",
    jobs,
    sources,
    warnings,
  });
});
