// POST /functions/v1/jobs-search
// Tier A only: in-app listings come from documented feeds/APIs or approved
// sources. LinkedIn/Indeed remain handoff/import workflows unless official
// partner access is configured elsewhere.
//
// Phase 3: Adzuna fan-out (up to 8 country requests per query) is now cached
// at the Edge layer with a 15-minute TTL keyed on (query + filters). Repeat
// searches within that window skip the upstream HTTP fan-out entirely.
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
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

interface QualityReject {
  /** Job title or top of description contains a "closed/expired" disclaimer. */
  closed: number;
  /** postedAt is older than MAX_JOB_AGE_DAYS. */
  stale: number;
  /** Title looks like spam (all-caps + long). */
  spam: number;
}

interface SourceStatus {
  name: string;
  count: number;
  ok: boolean;
  error?: string;
  /** Total rows the upstream provider returned before any filtering. */
  rawCount?: number;
  /** Quality-gate rejection breakdown per source. Surfaces in the response
   *  so operators can tune thresholds without re-deploying. */
  rejects?: QualityReject;
}

const TIMEOUT_MS = 12_000;
const ENRICH_TIMEOUT_MS = 4_500;
const MAX_PER_SOURCE = 50;
const DESCRIPTION_LIMIT = 24_000;
const ENRICH_PER_SOURCE = 18;

// Phase 1.7: trimmed Adzuna country fan-out. Free-tier limit is 25
// calls/min — fanning out to 10 countries in parallel exhausts the
// bucket on the first search of the minute, then ALL Adzuna calls
// 429 for the rest of the minute (which is why "global" searches
// were returning 0 Adzuna results consistently).
//
// New defaults are tuned for an SA-based product (ZA always anchors
// the search), with 2-3 high-volume regions in global mode instead
// of 10. Other regions get the same trimming.
const ADZUNA_COUNTRIES: Record<string, string[]> = {
  global: ["za", "gb", "us"],         // was 10 → 3. Covers ~80% of English-speaking job volume.
  africa: ["za"],                      // unchanged
  europe: ["gb", "de", "nl"],          // was 6 → 3. UK + DE + NL covers most English-speaking EU listings.
  north_america: ["us", "ca"],         // unchanged
  asia_pacific: ["au", "sg"],          // was 3 → 2. AU + SG covers most English-speaking APAC.
};

// Phase 1.7: detect country from user's typed location. If they typed
// "Cape Town" we shouldn't fan-out to US + UK — just hit ZA. Returns
// null if the location doesn't match a recognized country pattern.
function inferAdzunaCountryFromLocation(loc: string): string | null {
  if (!loc) return null;
  const text = loc.toLowerCase();
  if (/south africa|\bza\b|cape town|johannesburg|durban|pretoria|centurion|gauteng|stellenbosch/.test(text)) return "za";
  if (/united kingdom|\buk\b|london|manchester|edinburgh|bristol|leeds|england|scotland/.test(text)) return "gb";
  if (/united states|\busa\b|\bus\b|new york|california|texas|seattle|boston|chicago|los angeles|san francisco/.test(text)) return "us";
  if (/canada|toronto|vancouver|montreal/.test(text)) return "ca";
  if (/australia|sydney|melbourne|brisbane|perth/.test(text)) return "au";
  if (/germany|berlin|munich|hamburg|frankfurt/.test(text)) return "de";
  if (/netherlands|amsterdam|rotterdam|utrecht/.test(text)) return "nl";
  if (/france|paris|lyon|marseille/.test(text)) return "fr";
  if (/singapore/.test(text)) return "sg";
  if (/india|bangalore|mumbai|delhi|hyderabad|pune/.test(text)) return "in";
  return null;
}

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
  "lead", "principal", "staff", "mid",
  // NOTE: role/function words (engineer, engineering, developer, manager) are
  // intentionally NOT noise — they carry the query's core intent. Stripping
  // "engineer" from "Software Engineer" left just "software", so matchesQuery +
  // relevance ranked far too broadly (a marketing role mentioning "software"
  // could survive a "software engineer" search). Seniority/employment words
  // stay above because dedicated filters (experience level, job type) cover them.
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

// -----------------------------------------------------------------------
// Cross-source URL resolution (Fix #2 — pre-dedup duplicate killer).
//
// Some providers wrap the real listing URL behind a redirect (notably
// Adzuna: redirect_url → real ATS/board page). Without resolving these,
// the cross-source dedupe can't see that two providers are pointing at
// the same underlying listing.
//
// The heavyweight `enrichJobDestinations` resolves URLs AND fetches the
// full HTML for description enhancement — but it's capped at 18 jobs
// per source. That's good for description quality but leaves a long
// tail of unresolved redirector URLs in the merged list.
//
// `resolveRedirectsForDedup` is the lighter sibling: a HEAD-ish GET
// with a tight 2s timeout, bounded concurrency, no HTML parsing. It
// runs on the MERGED list (after every source returns) so a single
// pass covers cross-source duplicates that no per-source step can see.
// -----------------------------------------------------------------------

const REDIRECTOR_HOST_PATTERNS: RegExp[] = [
  /(?:^|\.)adzuna\./i,
  /(?:^|\.)indeedjobs\./i,
  /(?:^|\.)jobg8\./i,
  /(?:^|\.)joble\./i,
];

const URL_RESOLVE_TIMEOUT_MS = 2_000;
const URL_RESOLVE_CONCURRENCY = 8;
// Cap to keep p99 wall time bounded. 50 resolutions at 2s timeout, 8 wide
// → ~12.5s worst case if every request hangs. Practically: most resolve
// in <500ms so this is rarely the bottleneck.
const URL_RESOLVE_MAX_PER_SEARCH = 50;

function isRedirectorHost(url: string): boolean {
  const host = hostFromUrl(url);
  if (!host) return false;
  return REDIRECTOR_HOST_PATTERNS.some((re) => re.test(host));
}

async function resolveFinalUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.5",
        "user-agent": "CareerBoost job listing resolver",
      },
      signal: controller.signal,
    });
    const finalUrl = res.url || url;
    // We only need res.url; release the connection without buffering the body.
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return finalUrl;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRedirectsForDedup(
  jobs: CanonicalJobOut[],
): Promise<{ jobs: CanonicalJobOut[]; resolvedCount: number }> {
  // Index every job that (a) is a known redirector URL and (b) hasn't
  // already been resolved by per-source enrichJobDestinations (which
  // sets `finalUrl`). Cap to keep wall time bounded.
  const indexes = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => !job.finalUrl && isRedirectorHost(job.url))
    .slice(0, URL_RESOLVE_MAX_PER_SEARCH);
  if (!indexes.length) return { jobs, resolvedCount: 0 };

  const out = jobs.slice();
  let cursor = 0;
  let resolved = 0;

  async function worker() {
    while (cursor < indexes.length) {
      const next = cursor++;
      const { job, index } = indexes[next];
      const finalUrl = await resolveFinalUrl(job.url);
      if (!finalUrl || finalUrl === job.url) continue;

      const originalHost = hostFromUrl(job.url);
      const finalHost = hostFromUrl(finalUrl);
      const finalSource = inferSourceFromUrl(finalUrl);

      out[index] = {
        ...job,
        finalUrl,
        url: finalUrl,
        providerSource: job.providerSource || job.source,
        finalSource: finalSource || job.finalSource,
        source: finalSource || job.source,
        sourceId: finalSource ? slugSourceLabel(finalSource) : job.sourceId,
        sourceTrust: job.sourceTrust || {
          reportedSource: job.source,
          urlHost: originalHost,
          finalUrlHost: finalHost,
          urlVerified: true,
          reason: `Found via ${job.source}; final listing opens at ${finalSource || finalHost}.`,
          warning: `Found via ${job.source}, but the final listing opens at ${finalSource || finalHost}.`,
        },
      };
      resolved += 1;
    }
  }

  const workers = Math.min(URL_RESOLVE_CONCURRENCY, indexes.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { jobs: out, resolvedCount: resolved };
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
  // Remote jobs are location-independent — a candidate in any city can
  // do remote work, so a remote job should match ANY typed location
  // unless the user is in strict mode AND explicitly mentioned remote.
  //
  // Old behavior (pre-May 2026): remote jobs were killed unless the
  // location field itself said "remote". That meant a search for
  // "Cape Town" returned 0 results from Remotive/Arbeitnow/Jobicy
  // even though those APIs return ~100% remote jobs that any Cape
  // Town candidate could take. Operator confirmed search felt broken.
  if (job.remote) {
    if (strictness === "strict") {
      // Strict mode: only include remote jobs if the user explicitly
      // typed remote/anywhere — they're saying "I want a city-specific
      // role" otherwise.
      return /remote|anywhere|work from home|wfh/.test(wanted);
    }
    return true; // balanced or broad — remote always considered a match
  }
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
  // Same reasoning as matchesLocation: remote jobs are region-
  // independent for the candidate's purposes. A Cape Town candidate
  // searching "Africa" region should still see remote jobs even if
  // the job's posting text doesn't mention Africa terms.
  if (job.remote) return true;
  const text = searchText(job);
  return terms.some((term) => text.includes(term));
}

// Whole-word (stem-tolerant) term match. Substring matching wrongly let "fire"
// match "firewall"; requiring a word boundary + up to 3 trailing chars keeps
// "engineer"→"engineering" and "fire"→"fires" while rejecting "firewall". Symbol
// terms (c++, c#, .net) fall back to substring since \b doesn't apply to them.
function termMatches(text: string, term: string): boolean {
  if (!/^[a-z0-9]+$/.test(term)) return text.includes(term);
  return new RegExp("\\b" + term + "\\w{0,3}\\b").test(text);
}

function matchesQuery(job: CanonicalJobOut, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = searchText(job);
  // Require EVERY query term to appear as a whole word. Previously ANY single
  // term hitting the title passed, so "fire engineer" matched every generic
  // "backend engineer" role; and substring matching let "fire" hit "firewall".
  if (!terms.every((term) => termMatches(text, term))) return false;
  // Title anchor: at least one query term must appear in the TITLE. A job is
  // what its title says — a sales-manager role whose description merely
  // mentions "fire" and "engineer" is not what the user searched for.
  const title = safeString(job.title).toLowerCase();
  return terms.some((term) => termMatches(title, term));
}

// -----------------------------------------------------------------------
// Quality gates — server-side spam/stale/closed filter.
//
// Until now this aggregator passed almost everything through. Adzuna in
// particular caches for 15 min and serves jobs up to ~60 days old; recruiters
// also leave "no longer accepting applications" disclaimers in the body of
// otherwise valid listings. These gates run BEFORE the user/intent filters so
// (1) bad jobs never count against the per-source cap, and (2) we get an
// honest "rejects" tally per source for the response payload.
//
// Thresholds are env-overridable so ops can tune without a redeploy:
//   JOBS_MAX_AGE_DAYS  (default 60)  — recency floor in days
// -----------------------------------------------------------------------

const MAX_JOB_AGE_DAYS = Math.max(1, Number(Deno.env.get("JOBS_MAX_AGE_DAYS") || "60"));
const SPAM_TITLE_MIN_LEN = 50;

// Recruiters use a small set of phrases to mark a listing dead. We scan the
// title and the first 800 chars of the description (where disclaimers live).
// Keep this list tight — a false-positive on a legit job is worse than missing
// an occasional dead one. The /\b.../i anchors keep us from matching
// "we will close applications soon" or similar negation-adjacent phrasing.
const CLOSED_PATTERNS: RegExp[] = [
  /no longer accepting applications/i,
  /applications? (?:are )?closed/i,
  /position (?:has been )?filled/i,
  /this (?:job|position|role|posting|opportunity) (?:has |is )?(?:expired|no longer (?:available|open))/i,
  /we (?:are|'re) no longer accepting/i,
  /(?:job|posting) (?:has )?expired/i,
];

function isLikelyClosed(job: CanonicalJobOut): boolean {
  const head = (
    String(job.title || "") + "\n" +
    String(job.descriptionText || "").slice(0, 800)
  );
  return CLOSED_PATTERNS.some((re) => re.test(head));
}

function isTitleSpam(job: CanonicalJobOut): boolean {
  const t = String(job.title || "").trim();
  if (t.length < SPAM_TITLE_MIN_LEN) return false;
  // Letters-only test: skip digits/punctuation when judging caps. Need at
  // least 20 letters of evidence to avoid killing legit short acronym titles.
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 20) return false;
  return letters === letters.toUpperCase();
}

function isTooStale(job: CanonicalJobOut): boolean {
  if (!job.postedAt) return false;           // unparseable → keep (many feeds skip dates)
  const age = daysSince(job.postedAt);
  if (age >= 9999) return false;             // daysSince sentinel for "unknown"
  return age > MAX_JOB_AGE_DAYS;
}

function newQualityCounter(): QualityReject {
  return { closed: 0, stale: 0, spam: 0 };
}

function applyFilters(
  jobs: CanonicalJobOut[],
  body: Body,
  rejects?: QualityReject,
): CanonicalJobOut[] {
  const filters: Filters = body.filters || {};
  const terms = queryTerms(body);
  const postedWithinDays = Number(filters.postedWithinDays || body.nlq?.postedWithinDays || 0) || 0;
  const remoteOnly = !!(filters.remoteOnly || body.nlq?.remote);
  return jobs.filter((job) => {
    if (!job.url || !job.title) return false;

    // Quality gates first — these are the cheap "is this a real job?" checks
    // that should kill rows regardless of the user's filters.
    if (isLikelyClosed(job)) { if (rejects) rejects.closed += 1; return false; }
    if (isTooStale(job))     { if (rejects) rejects.stale  += 1; return false; }
    if (isTitleSpam(job))    { if (rejects) rejects.spam   += 1; return false; }

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

// Like fetchJson but supports custom method/headers (auth tokens, POST bodies)
// for providers that need them (Jooble POST, Reed/USAJobs/Findwork auth). Same
// timeout + JSON handling so every provider behaves consistently.
async function fetchJsonWith(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "user-agent": "CareerBoost job discovery",
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string })?.error || `HTTP ${res.status}`);
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

async function runArbeitnow(_body: Body): Promise<CanonicalJobOut[]> {
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

function adzunaCountries(region: string, location?: string): string[] {
  // Phase 1.7: prefer location-inferred country when user typed a city.
  // Otherwise fall back to region map. Reduces fan-out dramatically
  // (often 1 country instead of 3-10) which fixes the per-minute
  // rate-limit exhaustion and also returns more relevant jobs.
  const inferred = location ? inferAdzunaCountryFromLocation(location) : null;
  if (inferred) {
    // Use the inferred country, plus the user's region peers as
    // fallback in case the inferred country has thin coverage.
    // Cap at 3 max calls to stay well below the 25/min limit.
    const regionPeers = ADZUNA_COUNTRIES[region] || ADZUNA_COUNTRIES.global;
    const out = [inferred];
    for (const peer of regionPeers) {
      if (out.length >= 3) break;
      if (peer !== inferred) out.push(peer);
    }
    return out;
  }
  return (ADZUNA_COUNTRIES[region] || ADZUNA_COUNTRIES.global).slice(0, 3);
}

const ADZUNA_CACHE_TTL_SECONDS = 15 * 60; // 15 min

async function runAdzunaUncached(body: Body): Promise<CanonicalJobOut[]> {
  const appId = safeString(Deno.env.get("ADZUNA_APP_ID"));
  const appKey = safeString(Deno.env.get("ADZUNA_APP_KEY"));
  if (!appId || !appKey) throw new Error("ADZUNA_APP_ID or ADZUNA_APP_KEY is not configured.");
  const filters: Filters = body.filters || {};
  const countries = adzunaCountries(
    safeString(filters.searchRegion || "global"),
    safeString(filters.location || "")
  );
  const q = safeString(body.query || queryTerms(body).join(" "));
  const pages = countries.map(async (country) => {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1`);
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", "50"); // Adzuna's per-page max — maximize raw supply per call
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

// ---------------------------------------------------------------------------
// Additional Tier-A sources. The Muse + RemoteOK are keyless (always on).
// Jooble / USAJobs / Reed / Findwork are key-gated: they return [] silently
// when their secret isn't configured, so they add coverage the moment an
// operator sets the key (no redeploy of the client). LinkedIn/Indeed remain
// Tier B (handoff) / Tier C (import) — no legal open search API exists.
// ---------------------------------------------------------------------------

// The Muse — public API (optional THE_MUSE_API_KEY raises the rate limit).
// Fetches 2 pages (20 rows each) in parallel — one page starves the strict
// relevance filter downstream.
async function runTheMuse(body: Body): Promise<CanonicalJobOut[]> {
  const loc = safeString(body.filters?.location || body.nlq?.location || "");
  const apiKey = safeString(Deno.env.get("THE_MUSE_API_KEY"));
  const pageUrls = ["1", "2"].map((page) => {
    const url = new URL("https://www.themuse.com/api/public/jobs");
    url.searchParams.set("page", page);
    if (loc) url.searchParams.set("location", loc);
    if (apiKey) url.searchParams.set("api_key", apiKey);
    return url.toString();
  });
  const pages = await Promise.all(pageUrls.map(async (u) => {
    try {
      const data = await fetchJson(u) as { results?: Record<string, unknown>[] };
      return Array.isArray(data.results) ? data.results : [];
    } catch {
      return []; // one page failing shouldn't kill the source
    }
  }));
  const rows = pages.flat();
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const company = item.company && typeof item.company === "object"
      ? safeString((item.company as Record<string, unknown>).name) : "";
    const locations = Array.isArray(item.locations)
      ? (item.locations as Record<string, unknown>[]).map((l) => safeString(l?.name)).filter(Boolean) : [];
    const loc2 = locations.join("; ");
    const landing = item.refs && typeof item.refs === "object"
      ? safeString((item.refs as Record<string, unknown>).landing_page) : "";
    const levels = Array.isArray(item.levels)
      ? (item.levels as Record<string, unknown>[]).map((l) => safeString(l?.name)) : [];
    const categories = Array.isArray(item.categories)
      ? (item.categories as Record<string, unknown>[]).map((c) => safeString(c?.name)) : [];
    const out: CanonicalJobOut = {
      id: await stableId("themuse", landing, safeString(item.id || item.name)),
      title: safeString(item.name),
      company,
      location: loc2 || "Not specified",
      url: landing,
      remote: /remote|flexible/i.test(loc2),
      postedAt: toDateIso(item.publication_date),
      tags: uniqueStrings([...categories, ...levels, safeString(item.type)], 8).map((x) => x.toLowerCase()),
      descriptionText: clipDescription(item.contents),
      salary: "",
      logo: "",
      source: "The Muse",
      sourceId: "themuse",
      sourceType: "api",
      employmentType: safeString(item.type || "").toLowerCase(),
    };
    return out;
  }));
}

// RemoteOK — public JSON. Item [0] is a legal/attribution notice (skip it).
// Their ToS requires linking back to the RemoteOK job URL, which we do.
async function runRemoteOk(_body: Body): Promise<CanonicalJobOut[]> {
  const raw = await fetchJson("https://remoteok.com/api");
  const rows = Array.isArray(raw) ? raw as Record<string, unknown>[] : [];
  const jobs = rows.filter((r) => r && typeof r === "object" && r.position);
  return Promise.all(jobs.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const url = safeString(item.url || item.apply_url);
    const out: CanonicalJobOut = {
      id: await stableId("remoteok", url, safeString(item.id || item.slug || item.position)),
      title: safeString(item.position),
      company: safeString(item.company),
      location: safeString(item.location) || "Remote",
      url,
      remote: true,
      postedAt: toDateIso(item.date),
      tags: uniqueStrings(Array.isArray(item.tags) ? item.tags : [], 8).map((x) => x.toLowerCase()),
      descriptionText: clipDescription(item.description),
      salary: formatSalary(item.salary_min, item.salary_max, "USD"),
      logo: safeString(item.company_logo || item.logo),
      source: "RemoteOK",
      sourceId: "remoteok",
      sourceType: "api",
      employmentType: "remote",
    };
    return out;
  }));
}

// Jooble — big aggregator (strong local coverage). POST with JSON body.
async function runJooble(body: Body): Promise<CanonicalJobOut[]> {
  const key = safeString(Deno.env.get("JOOBLE_API_KEY"));
  if (!key) return [];
  const keywords = safeString(body.query || queryTerms(body).join(" ")).slice(0, 120);
  const location = safeString(body.filters?.location || body.nlq?.location || "");
  const data = await fetchJsonWith(`https://jooble.org/api/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keywords, location }),
  }) as { jobs?: Record<string, unknown>[] };
  const rows = Array.isArray(data.jobs) ? data.jobs : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const url = safeString(item.link);
    const loc = safeString(item.location);
    const out: CanonicalJobOut = {
      id: await stableId("jooble", url, safeString(item.id || item.title)),
      title: safeString(item.title),
      company: safeString(item.company),
      location: loc || "Not specified",
      url,
      remote: /remote|anywhere|work from home/i.test(loc + " " + safeString(item.title)),
      postedAt: toDateIso(item.updated),
      tags: uniqueStrings([safeString(item.type), safeString(item.source)], 6).map((x) => x.toLowerCase()),
      descriptionText: clipDescription(item.snippet),
      salary: safeString(item.salary),
      logo: "",
      source: "Jooble",
      sourceId: "jooble",
      sourceType: "api",
      employmentType: safeString(item.type || "").toLowerCase(),
    };
    return out;
  }));
}

// USAJobs — official US government API. Needs an API key + the registered email
// as the User-Agent (their auth model).
async function runUsaJobs(body: Body): Promise<CanonicalJobOut[]> {
  const key = safeString(Deno.env.get("USAJOBS_API_KEY"));
  const email = safeString(Deno.env.get("USAJOBS_EMAIL"));
  if (!key || !email) return [];
  const url = new URL("https://data.usajobs.gov/api/search");
  const q = safeString(body.query || queryTerms(body).join(" ")).slice(0, 120);
  if (q) url.searchParams.set("Keyword", q);
  const loc = safeString(body.filters?.location || body.nlq?.location || "");
  if (loc) url.searchParams.set("LocationName", loc);
  url.searchParams.set("ResultsPerPage", String(MAX_PER_SOURCE));
  const data = await fetchJsonWith(url.toString(), {
    headers: { "Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": key },
  }) as { SearchResult?: { SearchResultItems?: Record<string, unknown>[] } };
  const rows = Array.isArray(data?.SearchResult?.SearchResultItems) ? data.SearchResult!.SearchResultItems! : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (row) => {
    const d = (row.MatchedObjectDescriptor || {}) as Record<string, unknown>;
    const url2 = safeString(d.PositionURI);
    const remun = Array.isArray(d.PositionRemuneration) ? d.PositionRemuneration[0] as Record<string, unknown> : null;
    const details = ((d.UserArea as Record<string, unknown>)?.Details || {}) as Record<string, unknown>;
    const out: CanonicalJobOut = {
      id: await stableId("usajobs", url2, safeString(d.PositionID || d.PositionTitle)),
      title: safeString(d.PositionTitle),
      company: safeString(d.OrganizationName),
      location: safeString(d.PositionLocationDisplay) || "United States",
      url: url2,
      remote: /remote|telework/i.test(safeString(details.TeleworkEligible) + " " + safeString(d.PositionTitle)),
      postedAt: toDateIso(d.PublicationStartDate),
      tags: [],
      descriptionText: clipDescription(details.JobSummary || d.QualificationSummary),
      salary: remun ? formatSalary(remun.MinimumRange, remun.MaximumRange, remun.CurrencyCode) : "",
      logo: "",
      source: "USAJobs",
      sourceId: "usajobs",
      sourceType: "api",
      employmentType: "government",
    };
    return out;
  }));
}

// Reed (UK) — Basic auth with the API key as the username, blank password.
async function runReed(body: Body): Promise<CanonicalJobOut[]> {
  const key = safeString(Deno.env.get("REED_API_KEY"));
  if (!key) return [];
  const url = new URL("https://www.reed.co.uk/api/1.0/search");
  const q = safeString(body.query || queryTerms(body).join(" ")).slice(0, 120);
  if (q) url.searchParams.set("keywords", q);
  const loc = safeString(body.filters?.location || body.nlq?.location || "");
  if (loc) url.searchParams.set("locationName", loc);
  url.searchParams.set("resultsToTake", String(MAX_PER_SOURCE));
  const data = await fetchJsonWith(url.toString(), {
    headers: { Authorization: "Basic " + btoa(key + ":") },
  }) as { results?: Record<string, unknown>[] };
  const rows = Array.isArray(data.results) ? data.results : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const jobUrl = safeString(item.jobUrl) || `https://www.reed.co.uk/jobs/${safeString(item.jobId)}`;
    const loc2 = safeString(item.locationName);
    const out: CanonicalJobOut = {
      id: await stableId("reed", jobUrl, safeString(item.jobId || item.jobTitle)),
      title: safeString(item.jobTitle),
      company: safeString(item.employerName),
      location: loc2 || "United Kingdom",
      url: jobUrl,
      remote: /remote|work from home/i.test(loc2 + " " + safeString(item.jobTitle)),
      postedAt: toDateIso(item.date),
      tags: [],
      descriptionText: clipDescription(item.jobDescription),
      salary: formatSalary(item.minimumSalary, item.maximumSalary, item.currency || "GBP"),
      logo: "",
      source: "Reed",
      sourceId: "reed",
      sourceType: "api",
      employmentType: "",
    };
    return out;
  }));
}

// Findwork.dev — tech-focused. Token auth header.
async function runFindwork(body: Body): Promise<CanonicalJobOut[]> {
  const key = safeString(Deno.env.get("FINDWORK_API_KEY"));
  if (!key) return [];
  const url = new URL("https://findwork.dev/api/jobs/");
  const q = safeString(body.query || queryTerms(body).join(" ")).slice(0, 120);
  if (q) url.searchParams.set("search", q);
  const loc = safeString(body.filters?.location || body.nlq?.location || "");
  if (loc) url.searchParams.set("location", loc);
  const data = await fetchJsonWith(url.toString(), {
    headers: { Authorization: "Token " + key },
  }) as { results?: Record<string, unknown>[] };
  const rows = Array.isArray(data.results) ? data.results : [];
  return Promise.all(rows.slice(0, MAX_PER_SOURCE).map(async (item) => {
    const url2 = safeString(item.url);
    const out: CanonicalJobOut = {
      id: await stableId("findwork", url2, safeString(item.id || item.role)),
      title: safeString(item.role),
      company: safeString(item.company_name),
      location: safeString(item.location) || (item.remote ? "Remote" : "Not specified"),
      url: url2,
      remote: !!item.remote,
      postedAt: toDateIso(item.date_posted),
      tags: uniqueStrings(Array.isArray(item.keywords) ? item.keywords : [], 8).map((x) => x.toLowerCase()),
      descriptionText: clipDescription(item.text),
      salary: "",
      logo: "",
      source: "Findwork",
      sourceId: "findwork",
      sourceType: "api",
      employmentType: safeString(item.employment_type || "").toLowerCase(),
    };
    return out;
  }));
}

async function runSource(
  name: string,
  runner: () => Promise<CanonicalJobOut[]>,
  body: Body,
): Promise<{ jobs: CanonicalJobOut[]; source: SourceStatus }> {
  try {
    const raw = await runner();
    const rejects = newQualityCounter();
    const filtered = applyFilters(raw, body, rejects).slice(0, MAX_PER_SOURCE);
    const enriched = await enrichJobDestinations(filtered);
    // Post-enrich re-check: the live listing page may reveal a "closed"
    // disclaimer the upstream feed didn't carry. Currently only Adzuna jobs
    // are enriched (see enrichJobDestinations), so this catches dead Adzuna
    // redirects without affecting other sources.
    const survivors = enriched.filter((job) => {
      if (isLikelyClosed(job)) { rejects.closed += 1; return false; }
      return true;
    });
    return {
      jobs: survivors,
      source: {
        name,
        count: survivors.length,
        ok: true,
        rawCount: raw.length,
        rejects,
      },
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

Deno.serve(withCors(async (req) => {
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
    // Added Tier-A feeds. Keyless: The Muse, RemoteOK. Key-gated (skip until the
    // secret is set): Jooble, USAJobs, Reed, Findwork.
    runSource("The Muse", () => runTheMuse(body), body),
    runSource("RemoteOK", () => runRemoteOk(body), body),
    runSource("Jooble", () => runJooble(body), body),
    runSource("USAJobs", () => runUsaJobs(body), body),
    runSource("Reed", () => runReed(body), body),
    runSource("Findwork", () => runFindwork(body), body),
  ]);

  // Fix #2: resolve redirector URLs across the merged list before dedupe
  // so two sources pointing at the same real listing collapse into one row.
  const merged = runs.flatMap((r) => r.jobs);
  const { jobs: urlResolved, resolvedCount } = await resolveRedirectsForDedup(merged);
  const beforeDedupe = urlResolved.length;
  const deduped = dedupeJobs(urlResolved);
  const duplicatesRemoved = beforeDedupe - deduped.length;
  const jobs = sortJobs(deduped, body).slice(0, 80);

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
    // Operator visibility: how the merged list shrank through each gate.
    dedupe: {
      merged: beforeDedupe,
      afterDedupe: deduped.length,
      duplicatesRemoved,
      urlsResolved: resolvedCount,
    },
  });
}));
