// POST /functions/v1/external-search
// Auth: Supabase JWT (validated via getAuthedUser()).
//
// Optional adapter: LinkedIn job discovery via Google Custom Search JSON API
// (official Google API). Targets single postings: site path jobs/view + URL
// and title filters drop aggregate "41,000+ jobs …" hub pages.
//
// Secrets (Supabase Edge):
//   GOOGLE_CSE_API_KEY — API key with Custom Search API enabled
//   GOOGLE_CSE_CX — Programmable Search Engine id (cx)
//
// Request body matches the client contract (query, filters, nlq, provider).
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";

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
  provider?: string;
}

interface CseItem {
  title?: string;
  link?: string;
  snippet?: string;
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
  sourceType: "xray" | "api";
  employmentType: string;
}

interface RapidApiConfig {
  key: string;
  host: string;
  url: string;
  method: "GET" | "POST";
  jobPath: string;
}

const PROVIDER_LINKEDIN = "google-cse-linkedin";
const PROVIDER_INDEED = "google-cse-indeed";
const PROVIDER_ALL = "all";
const CSE_TIMEOUT_MS = 12_000;
const RAPIDAPI_TIMEOUT_MS = 12_000;
const DESCRIPTION_LIMIT = 24_000;
const CLOSED_HINTS = [
  "no longer accepting applications",
  "applications closed",
  "position has been filled",
  "job has expired",
  "job expired",
  "hiring ended",
  "role has been filled",
];

const JOB_TYPE_TERMS: Record<string, string[]> = {
  full_time: ["full time", "full-time"],
  part_time: ["part time", "part-time"],
  contract: ["contract", "contractor", "freelance"],
  internship: ["intern", "internship", "graduate program"],
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
  "job",
  "jobs",
  "role",
  "roles",
  "career",
  "careers",
  "position",
  "positions",
  "hiring",
]);

const REGION_TERMS: Record<string, string[]> = {
  global: [],
  africa: ["africa", "south africa", "johannesburg", "cape town", "nigeria", "kenya"],
  europe: ["europe", "eu", "united kingdom", "germany", "france", "netherlands"],
  north_america: ["united states", "usa", "canada", "north america"],
  asia_pacific: ["asia pacific", "apac", "australia", "singapore", "india"],
};

function wrapXrayTerm(raw: string): string {
  const t = String(raw || "").trim();
  if (!t) return "";
  if (/[\s"]/.test(t)) return `"${t.replace(/"/g, '\\"')}"`;
  return t;
}

function seniorityXrayFragment(sen: string): string {
  const s = String(sen || "any").toLowerCase();
  if (s === "junior") return "(junior OR jr OR entry OR graduate)";
  if (s === "mid") return "(mid OR intermediate)";
  if (s === "senior") return "(senior OR sr OR snr)";
  if (s === "lead") return "(lead OR principal OR staff)";
  return "";
}

function uniqueStrings(arr: unknown[] | undefined, max: number): string[] {
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const x of arr || []) {
    const s = String(x || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeTokenArray(v: unknown, max: number): string[] {
  return uniqueStrings(Array.isArray(v) ? v : [], max).map((s) =>
    s.toLowerCase()
  );
}

function selectedTerms(values: string[], dict: Record<string, string[]>): string[] {
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const v of values) {
    const terms = dict[v] || [];
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
  }
  return out;
}

function orFragmentFromTerms(terms: string[]): string {
  const wrapped = terms.map((t) => wrapXrayTerm(t)).filter(Boolean);
  if (!wrapped.length) return "";
  return "(" + wrapped.join(" OR ") + ")";
}

function flattenText(parts: Array<string | undefined | null>): string {
  return parts
    .map((s) => String(s || "").toLowerCase())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferEmploymentType(title: string, snippet: string): string {
  const text = flattenText([title, snippet]);
  if (text.includes("part-time") || text.includes("part time")) return "part_time";
  if (text.includes("contract") || text.includes("contractor") || text.includes("freelance")) return "contract";
  if (text.includes("intern")) return "internship";
  if (text.includes("temporary") || text.includes(" temp ")) return "temporary";
  return "full_time";
}

function appearsClosedOrInactive(title: string, snippet: string): boolean {
  const text = flattenText([title, snippet]);
  return CLOSED_HINTS.some((h) => text.includes(h));
}

function includesAnyTerm(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t.toLowerCase()));
}

// Whole-word (stem-tolerant) match so "fire" doesn't hit "firewall" while
// "engineer" still matches "engineering". Symbol terms fall back to substring.
function termMatches(text: string, term: string): boolean {
  if (!/^[a-z0-9]+$/.test(term)) return text.includes(term);
  return new RegExp("\\b" + term + "\\w{0,3}\\b").test(text);
}

function locationTokens(raw: string): string[] {
  return String(raw || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3)
    .filter((x) =>
      ![
        "the",
        "and",
        "for",
        "with",
        "from",
        "city",
        "state",
        "country",
        "remote",
      ].includes(x)
    )
    .slice(0, 8);
}

function queryTerms(body: Body): string[] {
  const raw: string[] = [];
  const q = String(body.query || "").trim();
  if (q) raw.push(...q.split(/[^a-z0-9+#.]+/i));
  for (const t of uniqueStrings(body.nlq?.keywords, 12)) {
    raw.push(...t.split(/[^a-z0-9+#.]+/i));
  }
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const term of raw) {
    const key = String(term || "").toLowerCase().trim();
    if (key.length < 2 || QUERY_NOISE.has(key) || seen[key]) continue;
    seen[key] = true;
    out.push(key);
    if (out.length >= 10) break;
  }
  return out;
}

/** True when URL is a LinkedIn job posting (/jobs/view/<id>), not search/hub. */
function isLinkedInSingleJobViewUrl(link: string): boolean {
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase();
    // Accept regional subdomains too (e.g. za.linkedin.com, uk.linkedin.com).
    if (!(host === "linkedin.com" || host.endsWith(".linkedin.com"))) return false;
    if (/\/jobs\/view\/[^/?#]+/i.test(u.pathname)) return true;
    // Google often returns search URLs carrying a concrete posting id.
    if (/\/jobs\/search\/?/i.test(u.pathname) && /\d{6,}/.test(u.searchParams.get("currentJobId") || "")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** True when URL is an Indeed job posting, not search/hub. */
function isIndeedSingleJobViewUrl(link: string): boolean {
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase();
    if (!(host === "indeed.com" || host.endsWith(".indeed.com"))) return false;
    if (/\/viewjob/i.test(u.pathname)) return true;
    if (/\/rc\/clk/i.test(u.pathname) && /\bjk=/.test(u.search)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Aggregate SERP pages ("41,000+ … jobs in United States") slip through CSE
 * occasionally; drop them even if the URL looks odd.
 */
function isLinkedInJobsHubTitleOrSnippet(title: string, snippet: string): boolean {
  const t = String(title || "") + " " + String(snippet || "");
  if (/\d[\d,]*\s*\+\s*(jobs?|job listings|opportunities|roles?)\b/i.test(t)) {
    return true;
  }
  if (/\d[\d,]*\s*\+\s*[^\n]{0,80}\s+jobs?\s+in\b/i.test(t)) return true;
  if (/\btoday'?s\s+top\s+\d[\d,]*\+/i.test(t)) return true;
  if (/\bget\s+notified\s+about\s+new\s+.*jobs?\s+in\b/i.test(t)) return true;
  return false;
}

function isIndeedJobsHubTitleOrSnippet(title: string, snippet: string): boolean {
  const t = String(title || "") + " " + String(snippet || "");
  if (/\d[\d,]*\s*\+?\s*jobs?\b/i.test(t) && /\bin\b/i.test(t)) return true;
  if (/\bjobs,\s*employment in\b/i.test(t)) return true;
  if (/\bcareer advice|salary guide|hiring lab\b/i.test(t)) return true;
  return false;
}

/** Mirrors client `buildLinkedInGoogleXrayQuery` using request body fields. */
function buildLinkedInGoogleCseQuery(body: Body): string {
  const filters = body.filters || {};
  const nlq = body.nlq || {};
  const parts: string[] = ["site:linkedin.com/jobs/view"];

  const titleTerms: string[] = [];
  const q = String(body.query || "").trim();
  if (q) titleTerms.push(wrapXrayTerm(q));
  for (const t of uniqueStrings(nlq.keywords, 12)) {
    const w = wrapXrayTerm(t);
    if (w && !titleTerms.includes(w)) titleTerms.push(w);
  }
  if (titleTerms.length) parts.push(`(${titleTerms.join(" OR ")})`);

  parts.push("(job OR jobs OR career OR hiring)");

  const remoteOnly = !!(filters.remoteOnly || nlq.remote);
  if (remoteOnly) parts.push(`(remote OR "work from home" OR wfh)`);

  const senFrag = seniorityXrayFragment(String(nlq.seniority || "any"));
  if (senFrag) parts.push(senFrag);

  const loc = String(filters.location || nlq.location || "").trim();
  if (loc) parts.push(wrapXrayTerm(loc));

  const region = String(filters.searchRegion || "global").toLowerCase();
  const regionFrag = orFragmentFromTerms(REGION_TERMS[region] || []);
  if (regionFrag) parts.push(regionFrag);

  const jobTypes = normalizeTokenArray(filters.jobType, 8);
  const jobTypeFrag = orFragmentFromTerms(selectedTerms(jobTypes, JOB_TYPE_TERMS));
  if (jobTypeFrag) parts.push(jobTypeFrag);

  const expLevels = normalizeTokenArray(filters.experienceLevel, 8);
  const expFrag = orFragmentFromTerms(selectedTerms(expLevels, EXP_LEVEL_TERMS));
  if (expFrag) parts.push(expFrag);

  const pwd = Number(filters.postedWithinDays || nlq.postedWithinDays || 0) ||
    0;
  if (pwd > 0) {
    parts.push(`("past week" OR "last 7 days" OR "this week")`);
  }

  if (filters.activeOnly !== false) {
    parts.push('-("no longer accepting applications" OR "applications closed" OR "position has been filled" OR "job expired")');
  }

  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function buildIndeedGoogleCseQuery(body: Body): string {
  const filters = body.filters || {};
  const nlq = body.nlq || {};
  const parts: string[] = ["site:indeed.com/viewjob"];

  const titleTerms: string[] = [];
  const q = String(body.query || "").trim();
  if (q) titleTerms.push(wrapXrayTerm(q));
  for (const t of uniqueStrings(nlq.keywords, 12)) {
    const w = wrapXrayTerm(t);
    if (w && !titleTerms.includes(w)) titleTerms.push(w);
  }
  if (titleTerms.length) parts.push(`(${titleTerms.join(" OR ")})`);

  parts.push("(job OR jobs OR career OR hiring)");

  const remoteOnly = !!(filters.remoteOnly || nlq.remote);
  if (remoteOnly) parts.push(`(remote OR "work from home" OR wfh)`);

  const senFrag = seniorityXrayFragment(String(nlq.seniority || "any"));
  if (senFrag) parts.push(senFrag);

  const loc = String(filters.location || nlq.location || "").trim();
  if (loc) parts.push(wrapXrayTerm(loc));

  const region = String(filters.searchRegion || "global").toLowerCase();
  const regionFrag = orFragmentFromTerms(REGION_TERMS[region] || []);
  if (regionFrag) parts.push(regionFrag);

  const jobTypes = normalizeTokenArray(filters.jobType, 8);
  const jobTypeFrag = orFragmentFromTerms(selectedTerms(jobTypes, JOB_TYPE_TERMS));
  if (jobTypeFrag) parts.push(jobTypeFrag);

  const expLevels = normalizeTokenArray(filters.experienceLevel, 8);
  const expFrag = orFragmentFromTerms(selectedTerms(expLevels, EXP_LEVEL_TERMS));
  if (expFrag) parts.push(expFrag);

  const pwd = Number(filters.postedWithinDays || nlq.postedWithinDays || 0) || 0;
  if (pwd > 0) {
    parts.push(`("past week" OR "last 7 days" OR "this week")`);
  }

  if (filters.activeOnly !== false) {
    parts.push('-("no longer accepting applications" OR "applications closed" OR "position has been filled" OR "job expired")');
  }

  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function parseCompanyFromCse(title: string, snippet: string): string {
  const t = title.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const segs = t.split(/\s*(?:[-·–—|])\s+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const last = segs[segs.length - 1] || "";
    if (last && !/^(full[\s-]?time|part[\s-]?time|contract|intern)/i.test(last)) {
      return last;
    }
    if (segs.length >= 2) return segs[segs.length - 2] || "";
  }
  const firstLine = String(snippet || "").split(/\n|\. /)[0]?.trim() || "";
  if (firstLine.length > 2 && firstLine.length < 120) return firstLine;
  return "LinkedIn listing";
}

function cleanTitle(raw: string): string {
  return String(raw || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .trim();
}

function cleanIndeedTitle(raw: string): string {
  return String(raw || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*Indeed\.com\s*$/i, "")
    .replace(/\s*\|\s*Indeed\s*$/i, "")
    .trim();
}

function parseCompanyFromIndeed(title: string, snippet: string): string {
  const t = cleanIndeedTitle(title);
  const segs = t.split(/\s*(?:[-·–—|])\s+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const candidate = segs[segs.length - 1] || "";
    if (candidate && !/^(full[\s-]?time|part[\s-]?time|contract|intern)/i.test(candidate)) return candidate;
  }
  const firstLine = String(snippet || "").split(/\n|\. /)[0]?.trim() || "";
  if (firstLine.length > 2 && firstLine.length < 120) return firstLine;
  return "Indeed listing";
}

function parseJsonPath(input: unknown, path: string): unknown {
  const p = String(path || "").trim();
  if (!p) return input;
  const parts = p
    .replace(/^\$+\.?/, "")
    .split(".")
    .map((x) => x.trim())
    .filter(Boolean);
  let cur: unknown = input;
  for (const key of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function str(v: unknown): string {
  return String(v == null ? "" : v).trim();
}

function boolLike(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const val = parseJsonPath(obj, k);
    const s = str(val);
    if (s) return s;
  }
  return "";
}

function slugSourceLabel(label: string): string {
  return String(label || "source")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "source";
}

function inferSourceFromUrl(url: string): string {
  let host = "";
  try {
    host = new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  if (!host) return "";
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
  if (host === "indeed.com" || host.endsWith(".indeed.com")) return "Indeed";
  if (host === "adzuna.com" || host.endsWith(".adzuna.com") || host.startsWith("adzuna.")) return "Adzuna";
  if (host === "remotive.com" || host.endsWith(".remotive.com")) return "Remotive";
  if (host === "reed.co.uk" || host.endsWith(".reed.co.uk")) return "Reed.co.uk";
  if (host === "jobmail.co.za" || host.endsWith(".jobmail.co.za")) return "Jobmail";
  if (host === "bebee.com" || host.endsWith(".bebee.com")) return "beBee";
  if (host.includes("rpo-recruitment") || host.includes("rporecruitment")) return "RPO Recruitment";
  if (host.includes("executiveplacements")) return "ExecutivePlacements.com";
  if (host.includes("careerjunction")) return "CareerJunction";
  if (host.includes("pnet")) return "PNet";
  if (host.includes("glassdoor")) return "Glassdoor";
  if (host.includes("ziprecruiter")) return "ZipRecruiter";
  if (host.includes("workdayjobs") || host.includes("myworkdayjobs")) return "Workday";
  const compact = host
    .replace(/\.(co\.uk|co\.za|com\.au|com|org|net|io|ai|co|jobs)$/i, "")
    .split(".")
    .pop() || host;
  return compact
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function clipDescription(value: unknown): string {
  return str(value)
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
    .slice(0, DESCRIPTION_LIMIT);
}

function pickArray(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  return [];
}

function getRapidApiLinkedInConfig(): RapidApiConfig | null {
  const key = String(Deno.env.get("RAPIDAPI_KEY") || "").trim();
  const host = String(Deno.env.get("RAPIDAPI_HOST") || "").trim();
  const url = String(Deno.env.get("RAPIDAPI_LINKEDIN_URL") || "").trim();
  if (!key || !host || !url) return null;
  const methodRaw = String(Deno.env.get("RAPIDAPI_LINKEDIN_METHOD") || "GET").toUpperCase().trim();
  const method: "GET" | "POST" = methodRaw === "POST" ? "POST" : "GET";
  const jobPath = String(Deno.env.get("RAPIDAPI_LINKEDIN_JOB_PATH") || "data").trim() || "data";
  return { key, host, url, method, jobPath };
}

// Map a typed location to JSearch's 2-letter market code. Defaults to "us"
// only when nothing matches (JSearch requires a country).
function jsearchCountryFromLocation(loc: string): string {
  const text = String(loc || "").toLowerCase();
  if (/south africa|\bza\b|cape town|johannesburg|durban|pretoria|centurion|gauteng|stellenbosch/.test(text)) return "za";
  if (/united kingdom|\buk\b|london|manchester|edinburgh|bristol|leeds|england|scotland/.test(text)) return "gb";
  if (/canada|toronto|vancouver|montreal/.test(text)) return "ca";
  if (/australia|sydney|melbourne|brisbane|perth/.test(text)) return "au";
  if (/germany|berlin|munich|hamburg|frankfurt/.test(text)) return "de";
  if (/netherlands|amsterdam|rotterdam|utrecht/.test(text)) return "nl";
  if (/france|paris|lyon|marseille/.test(text)) return "fr";
  if (/singapore/.test(text)) return "sg";
  if (/india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune/.test(text)) return "in";
  return "us";
}

function buildRapidApiLinkedInRequest(
  body: Body,
): { url: string; init: RequestInit } {
  const cfg = getRapidApiLinkedInConfig();
  if (!cfg) throw new Error("RapidAPI LinkedIn not configured");
  const filters = body.filters || {};
  const payload = {
    query: String(body.query || "").trim(),
    location: String(filters.location || body.nlq?.location || "").trim(),
    page: 1,
    limit: 25,
    remoteOnly: !!(filters.remoteOnly || body.nlq?.remote),
    postedWithinDays: Number(filters.postedWithinDays || body.nlq?.postedWithinDays || 0) || 0,
    sort: String(filters.sort || "newest"),
  };

  const headers: Record<string, string> = {
    "X-RapidAPI-Key": cfg.key,
    "X-RapidAPI-Host": cfg.host,
    "Content-Type": "application/json",
  };

  // JSearch expects a single "query" phrase and specific pagination/date params.
  if (cfg.method === "GET" && cfg.host.toLowerCase().includes("jsearch.p.rapidapi.com")) {
    const q = String(payload.query || "").trim();
    const loc = String(payload.location || "").trim();
    const u = new URL(cfg.url);
    // Operators often paste the API base URL as the secret; JSearch's search
    // endpoint lives at /search. A bare "/" path returns RapidAPI's
    // "Endpoint '/' does not exist" — repair it instead of failing.
    if (!u.pathname || u.pathname === "/") u.pathname = "/search";
    u.searchParams.set("query", loc && q ? `${q} jobs in ${loc}` : (q || "software engineer jobs"));
    u.searchParams.set("page", "1");
    u.searchParams.set("num_pages", "1");
    // Derive the market from the typed location — this was hardcoded "us",
    // which silently geo-filtered away South African (and all non-US) results.
    u.searchParams.set("country", jsearchCountryFromLocation(loc));
    u.searchParams.set(
      "date_posted",
      payload.postedWithinDays > 0 && payload.postedWithinDays <= 7 ? "week" : "all",
    );
    return {
      url: u.toString(),
      init: { method: "GET", headers },
    };
  }

  if (cfg.method === "POST") {
    return {
      url: cfg.url,
      init: { method: "POST", headers, body: JSON.stringify(payload) },
    };
  }

  const u = new URL(cfg.url);
  Object.entries(payload).forEach(([k, v]) => {
    if (v === "" || v == null) return;
    u.searchParams.set(k, String(v));
  });
  return {
    url: u.toString(),
    init: { method: "GET", headers },
  };
}

async function fetchRapidApiLinkedIn(
  body: Body,
): Promise<{ jobs: CanonicalJobOut[]; source: { name: string; count: number; ok: boolean; error?: string } }> {
  const cfg = getRapidApiLinkedInConfig();
  if (!cfg) {
    return {
      jobs: [],
      source: { name: "LinkedIn", count: 0, ok: false, error: "LinkedIn direct feed is not configured." },
    };
  }

  const req = buildRapidApiLinkedInRequest(body);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RAPIDAPI_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, Object.assign({}, req.init, { signal: ac.signal }));
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const msg = str(parseJsonPath(json, "message")) || str(parseJsonPath(json, "error")) || `HTTP ${res.status}`;
      return { jobs: [], source: { name: "LinkedIn", count: 0, ok: false, error: msg } };
    }

    // Some RapidAPI providers return HTTP 200 with a logical failure payload.
    // Treat that as failure so fallback lanes can run.
    if (json && Object.prototype.hasOwnProperty.call(json, "success") && boolLike(parseJsonPath(json, "success")) === false) {
      const msg = str(parseJsonPath(json, "message")) || "LinkedIn direct feed returned an invalid response";
      return { jobs: [], source: { name: "LinkedIn", count: 0, ok: false, error: msg } };
    }

    // Resolve the jobs array resiliently: the configured path first, then the
    // shapes used by the common RapidAPI job providers (JSearch = "data").
    let rows: Record<string, unknown>[] = [];
    for (const path of [cfg.jobPath, "data", "jobs", "results", "data.jobs"]) {
      rows = pickArray(parseJsonPath(json, path));
      if (rows.length) break;
    }
    const out: CanonicalJobOut[] = [];
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];
      const title = pickString(item, ["title", "job_title", "position", "name"]);
      const company = pickString(item, ["company", "company_name", "organization", "company.name", "employer_name"]);
      const url = pickString(item, ["linkedin_url", "job_url", "url", "link", "apply_url", "job_apply_link"]);
      if (!title || !company || !url) continue;
      const location = pickString(item, ["location", "job_location", "city", "formatted_location"]);
      const descriptionText = clipDescription(pickString(item, ["description", "snippet", "summary", "job_description"]));
      const postedAt = pickString(item, ["postedAt", "posted_at", "date_posted", "listed_at", "job_posted_at_datetime_utc", "job_posted_at"]);
      const salary = pickString(item, ["salary", "salary_text", "compensation", "job_salary_string", "job_salary"]);
      const emp = pickString(item, ["employmentType", "employment_type", "job_type", "job_employment_type"]).toLowerCase() || "full_time";
      const publisher = pickString(item, ["publisher", "job_publisher", "source", "site"]);
      const source = inferSourceFromUrl(url) || publisher || "Web job feed";
      const sourceSlug = slugSourceLabel(source);
      const remote =
        boolLike(parseJsonPath(item, "remote")) ||
        boolLike(parseJsonPath(item, "job_is_remote")) ||
        /remote|work from home|wfh|anywhere/i.test([title, location, descriptionText].join(" "));
      const idSeed = pickString(item, ["id", "job_id", "urn", "tracking_id"]) || url;
      out.push({
        id: `rapid_li_${await hashJobId(idSeed)}`,
        title,
        company,
        location,
        url,
        remote,
        postedAt: postedAt ? String(postedAt).slice(0, 10) : "",
        tags: sourceSlug && sourceSlug !== "source" ? [sourceSlug] : [],
        descriptionText,
        salary,
        logo: pickString(item, ["logo", "company_logo", "company.logo"]),
        source,
        sourceId: source === "LinkedIn" ? "rapidapi-linkedin" : `rapidapi-${sourceSlug}`,
        sourceType: "api",
        employmentType: emp,
      });
    }

    const sourceName = out.some((j) => j.source !== "LinkedIn") ? "Web job feed" : "LinkedIn";
    // When the feed answers 200 but we surface nothing, say WHY — otherwise
    // operators see an opaque "returned no jobs" and can't tell a quota/shape
    // problem from genuine zero coverage.
    let emptyDiag = "";
    if (out.length === 0) {
      const status = str(parseJsonPath(json, "status")) || str(parseJsonPath(json, "message"));
      const keys = Object.keys(json || {}).slice(0, 6).join(",");
      emptyDiag = `upstream 200, parsed ${rows.length} rows` +
        (status ? `, status="${status.slice(0, 60)}"` : "") +
        (keys ? `, keys=[${keys}]` : "");
    }
    return {
      jobs: out,
      source: {
        name: sourceName,
        count: out.length,
        ok: true,
        ...(emptyDiag ? { error: emptyDiag } : {}),
      },
    };
  } catch (e) {
    const msg = (e as Error).name === "AbortError"
      ? "LinkedIn direct feed timed out"
      : String((e as Error).message || e);
    return {
      jobs: [],
      source: { name: "LinkedIn", count: 0, ok: false, error: msg },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function hashJobId(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url),
  );
  const bytes = new Uint8Array(digest).slice(0, 12);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getCseCredentials(): { key: string; cx: string } | null {
  const key = String(Deno.env.get("GOOGLE_CSE_API_KEY") || "").trim();
  const cx = String(Deno.env.get("GOOGLE_CSE_CX") || "").trim();
  if (!key || !cx) return null;
  return { key, cx };
}

async function fetchGoogleCse(
  q: string,
  creds: { key: string; cx: string },
): Promise<{ items: CseItem[]; error?: string }> {
  const maxQ = 1800;
  const query = q.length > maxQ ? q.slice(0, maxQ) : q;
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", creds.key);
  u.searchParams.set("cx", creds.cx);
  u.searchParams.set("q", query);
  u.searchParams.set("num", "10");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CSE_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { signal: ac.signal });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = json?.error as { message?: string } | undefined;
      const msg = errObj?.message || `HTTP ${res.status}`;
      return { items: [], error: msg };
    }
    const items = Array.isArray(json.items) ? json.items as CseItem[] : [];
    return { items };
  } catch (e) {
    const msg = (e as Error).name === "AbortError"
      ? "Google CSE request timed out"
      : String((e as Error).message || e);
    return { items: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function mapCseItemToJob(item: CseItem): CanonicalJobOut | null {
  const link = String(item.link || "").trim();
  if (!link || !isLinkedInSingleJobViewUrl(link)) return null;
  const rawTitle = cleanTitle(String(item.title || ""));
  const snippet = String(item.snippet || "").trim();
  if (!rawTitle) return null;
  if (isLinkedInJobsHubTitleOrSnippet(rawTitle, snippet)) return null;
  const company = parseCompanyFromCse(rawTitle, snippet);

  const remote = /remote|work from home|wfh|anywhere/i.test(
    rawTitle + " " + snippet,
  );
  const locMatch = snippet.match(
    /\b([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+)*,\s*[A-Z]{2})\b/,
  );
  const location = locMatch ? locMatch[1] : "";
  const employmentType = inferEmploymentType(rawTitle, snippet);

  return {
    id: "", // filled async
    title: rawTitle,
    company,
    location,
    url: link,
    remote,
    postedAt: "",
    tags: ["linkedin", "google-cse"],
    descriptionText: clipDescription(snippet),
    salary: "",
    logo: "",
    source: "LinkedIn (Google)",
    sourceId: PROVIDER_LINKEDIN,
    sourceType: "xray",
    employmentType: employmentType,
  };
}

function mapCseItemToIndeedJob(item: CseItem): CanonicalJobOut | null {
  const link = String(item.link || "").trim();
  if (!link || !isIndeedSingleJobViewUrl(link)) return null;
  const rawTitle = cleanIndeedTitle(String(item.title || ""));
  const snippet = String(item.snippet || "").trim();
  if (!rawTitle) return null;
  if (isIndeedJobsHubTitleOrSnippet(rawTitle, snippet)) return null;
  const company = parseCompanyFromIndeed(rawTitle, snippet);

  const remote = /remote|work from home|wfh|anywhere/i.test(rawTitle + " " + snippet);
  const locMatch = snippet.match(/\b([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+)*,\s*[A-Z]{2})\b/);
  const location = locMatch ? locMatch[1] : "";
  const employmentType = inferEmploymentType(rawTitle, snippet);

  return {
    id: "",
    title: rawTitle,
    company,
    location,
    url: link,
    remote,
    postedAt: "",
    tags: ["indeed", "google-cse"],
    descriptionText: clipDescription(snippet),
    salary: "",
    logo: "",
    source: "Indeed (Google)",
    sourceId: PROVIDER_INDEED,
    sourceType: "xray",
    employmentType,
  };
}

function jobMatchesRequestedFilters(job: CanonicalJobOut, body: Body): boolean {
  const filters = body.filters || {};
  const strictness = String(filters.locationStrictness || "strict").toLowerCase();
  const text = flattenText([
    job.title,
    job.company,
    job.descriptionText,
    job.location,
    job.employmentType,
  ]);

  if (filters.activeOnly !== false && appearsClosedOrInactive(job.title, job.descriptionText)) {
    return false;
  }

  const location = String(filters.location || "").trim();
  if (location) {
    const wanted = location.toLowerCase();
    const locTokens = locationTokens(location);
    const locHits = locTokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
    const hasLocMatch = locTokens.length
      ? locHits > 0
      : text.includes(wanted);
    const countryAliasMatch =
      (/south africa|\bsa\b|\bza\b/.test(wanted) && /\b(za|south africa|gauteng|pretoria|centurion|johannesburg|cape town|durban)\b/.test(text)) ||
      (/united kingdom|\buk\b/.test(wanted) && /\b(uk|united kingdom|england|london|manchester)\b/.test(text)) ||
      (/united states|\busa\b|\bus\b/.test(wanted) && /\b(us|usa|united states|new york|california|texas)\b/.test(text));
    if (!countryAliasMatch) {
      if (strictness === "strict") {
        if (locTokens.length >= 2) {
          if (locHits < 2 && !(filters.remoteOnly && job.remote)) return false;
        } else if (!hasLocMatch && !(filters.remoteOnly && job.remote)) return false;
      } else if (strictness === "balanced") {
        if (!hasLocMatch && !(filters.remoteOnly && job.remote)) return false;
      } else {
        // broad: allow remote jobs to pass even if location token not present.
        if (!hasLocMatch && !job.remote && wanted !== "remote") return false;
      }
    }
  }

  const terms = queryTerms(body);
  if (terms.length) {
    // Require EVERY query term as a whole word — previously any single term
    // hitting the title passed, so "fire engineer" matched any generic
    // "engineer" role, and substring matching let "fire" hit "firewall".
    if (!terms.every((t) => termMatches(text, t))) return false;
    // Title anchor: at least one query term must appear in the TITLE. A job is
    // what its title says — terms buried only in the description (e.g. a pump
    // sales role whose body mentions "fire" and "engineer") are not the role
    // the user searched for.
    const titleText = flattenText([job.title]);
    if (!terms.some((t) => termMatches(titleText, t))) return false;
  }

  const region = String(filters.searchRegion || "global").toLowerCase();
  const regionTerms = REGION_TERMS[region] || [];
  if (regionTerms.length) {
    const regionText = flattenText([job.location, job.descriptionText, job.title]);
    if (!includesAnyTerm(regionText, regionTerms) && !job.remote) {
      if (strictness === "strict") return false;
    }
  }

  const jobTypes = normalizeTokenArray(filters.jobType, 8);
  if (jobTypes.length) {
    const wanted = selectedTerms(jobTypes, JOB_TYPE_TERMS);
    const universe = selectedTerms(Object.keys(JOB_TYPE_TERMS), JOB_TYPE_TERMS);
    const hasTypeSignal = includesAnyTerm(text, universe);
    // Phase 2.1: only enforce when we have a clear type signal in snippet/title.
    if (hasTypeSignal && !includesAnyTerm(text, wanted)) return false;
  }

  const expLevels = normalizeTokenArray(filters.experienceLevel, 8);
  if (expLevels.length) {
    const wanted = selectedTerms(expLevels, EXP_LEVEL_TERMS);
    const universe = selectedTerms(Object.keys(EXP_LEVEL_TERMS), EXP_LEVEL_TERMS);
    const hasExpSignal = includesAnyTerm(text, universe);
    // Phase 2.1: keep jobs when experience isn't explicitly stated by source snippet.
    if (hasExpSignal && !includesAnyTerm(text, wanted)) return false;
  }

  return true;
}

async function runGoogleCseLinkedInXray(
  body: Body,
): Promise<{
  jobs: CanonicalJobOut[];
  source: { name: string; count: number; ok: boolean; error?: string };
}> {
  const creds = getCseCredentials();
  if (!creds) {
    return {
      jobs: [],
      source: {
        name: "LinkedIn (Google CSE)",
        count: 0,
        ok: false,
        error:
          "Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX. Set both as Supabase secrets.",
      },
    };
  }

  async function mapItemsToJobs(items: CseItem[], filterBody: Body): Promise<CanonicalJobOut[]> {
    const out: CanonicalJobOut[] = [];
    for (let i = 0; i < items.length; i++) {
      const mapped = mapCseItemToJob(items[i]);
      if (!mapped) continue;
      if (!jobMatchesRequestedFilters(mapped, filterBody)) continue;
      mapped.id = `gcse_${await hashJobId(mapped.url)}`;
      out.push(mapped);
    }
    return out;
  }

  const q = buildLinkedInGoogleCseQuery(body) ||
    "site:linkedin.com/jobs/view (job OR jobs OR career OR hiring)";
  const first = await fetchGoogleCse(q, creds);
  if (first.error) {
    return {
      jobs: [],
      source: { name: "LinkedIn (Google CSE)", count: 0, ok: false, error: first.error },
    };
  }
  let jobs = await mapItemsToJobs(first.items, body);

  // Phase 2.1 fallback: if strict filters return nothing, relax query constraints
  // while preserving the user's core query and remote preference.
  if (!jobs.length) {
    const relaxedBody: Body = {
      query: body.query,
      provider: body.provider,
      nlq: body.nlq,
      filters: Object.assign({}, body.filters || {}, {
        location: "",
        jobType: [],
        experienceLevel: [],
        postedWithinDays: 0,
      }),
    };
    const q2 = buildLinkedInGoogleCseQuery(relaxedBody) ||
      "site:linkedin.com/jobs/view (job OR jobs OR career OR hiring)";
    const second = await fetchGoogleCse(q2, creds);
    if (!second.error) {
      jobs = await mapItemsToJobs(second.items, relaxedBody);
    }
  }

  // Final fallback: keep quality gates, but don't force active-only when the
  // upstream snippet does not include clear status language.
  if (!jobs.length && body.filters && body.filters.activeOnly !== false) {
    const relaxedActiveBody: Body = {
      query: body.query,
      provider: body.provider,
      nlq: body.nlq,
      filters: Object.assign({}, body.filters, { activeOnly: false }),
    };
    const q3 = buildLinkedInGoogleCseQuery(relaxedActiveBody) ||
      "site:linkedin.com/jobs/view (job OR jobs OR career OR hiring)";
    const third = await fetchGoogleCse(q3, creds);
    if (!third.error) {
      jobs = await mapItemsToJobs(third.items, relaxedActiveBody);
    }
  }

  // Ultimate fallback for LinkedIn lane: broad jobs scope query, then apply
  // the same map/filter pipeline. This prevents complete dropouts on narrow
  // x-ray variants while still keeping quality gates in place.
  if (!jobs.length) {
    const broadQ = "site:linkedin.com/jobs " +
      (String(body.query || "").trim() || "(job OR jobs OR career)");
    const fourth = await fetchGoogleCse(broadQ, creds);
    if (!fourth.error) {
      jobs = await mapItemsToJobs(fourth.items, body);
    }
  }

  return {
    jobs,
    source: {
      name: "LinkedIn (Google CSE)",
      count: jobs.length,
      ok: true,
    },
  };
}

async function runLinkedInWithRapidApiPrimary(
  body: Body,
): Promise<{
  jobs: CanonicalJobOut[];
  source: { name: string; count: number; ok: boolean; error?: string };
}> {
  const primary = await fetchRapidApiLinkedIn(body);
  if (primary.source.ok && primary.jobs.length > 0) {
    return primary;
  }
  const fallback = await runGoogleCseLinkedInXray(body);
  if (fallback.source.ok) {
    const why = primary.source.error || "LinkedIn direct feed returned no jobs";
    fallback.source.name = "LinkedIn verified search";
    fallback.source.error = `Direct LinkedIn feed unavailable; used verified LinkedIn page search. ${why}`;
  }
  return fallback;
}

async function runGoogleCseIndeed(
  body: Body,
): Promise<{
  jobs: CanonicalJobOut[];
  source: { name: string; count: number; ok: boolean; error?: string };
}> {
  const creds = getCseCredentials();
  if (!creds) {
    return {
      jobs: [],
      source: {
        name: "Indeed (Google CSE)",
        count: 0,
        ok: false,
        error:
          "Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX. Set both as Supabase secrets.",
      },
    };
  }

  async function mapItemsToJobs(items: CseItem[], filterBody: Body): Promise<CanonicalJobOut[]> {
    const out: CanonicalJobOut[] = [];
    for (let i = 0; i < items.length; i++) {
      const mapped = mapCseItemToIndeedJob(items[i]);
      if (!mapped) continue;
      if (!jobMatchesRequestedFilters(mapped, filterBody)) continue;
      mapped.id = `gcse_${await hashJobId(mapped.url)}`;
      out.push(mapped);
    }
    return out;
  }

  const q = buildIndeedGoogleCseQuery(body) ||
    "site:indeed.com/viewjob (job OR jobs OR career OR hiring)";
  const first = await fetchGoogleCse(q, creds);
  if (first.error) {
    return {
      jobs: [],
      source: { name: "Indeed (Google CSE)", count: 0, ok: false, error: first.error },
    };
  }
  let jobs = await mapItemsToJobs(first.items, body);

  if (!jobs.length) {
    const relaxedBody: Body = {
      query: body.query,
      provider: body.provider,
      nlq: body.nlq,
      filters: Object.assign({}, body.filters || {}, {
        location: "",
        jobType: [],
        experienceLevel: [],
        postedWithinDays: 0,
      }),
    };
    const q2 = buildIndeedGoogleCseQuery(relaxedBody) ||
      "site:indeed.com/viewjob (job OR jobs OR career OR hiring)";
    const second = await fetchGoogleCse(q2, creds);
    if (!second.error) {
      jobs = await mapItemsToJobs(second.items, relaxedBody);
    }
  }

  if (!jobs.length) {
    const broadQ = "site:indeed.com/jobs " +
      (String(body.query || "").trim() || "(job OR jobs OR career)");
    const third = await fetchGoogleCse(broadQ, creds);
    if (!third.error) {
      jobs = await mapItemsToJobs(third.items, body);
    }
  }

  return {
    jobs,
    source: {
      name: "Indeed (Google CSE)",
      count: jobs.length,
      ok: true,
    },
  };
}

function dedupeJobsByUrl(jobs: CanonicalJobOut[]): CanonicalJobOut[] {
  const seen: Record<string, boolean> = {};
  const out: CanonicalJobOut[] = [];
  for (const j of jobs) {
    const key = String(j.url || "").trim().toLowerCase();
    if (!key) continue;
    if (seen[key]) continue;
    seen[key] = true;
    out.push(j);
  }
  return out;
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
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const requested = String(body.provider || "").trim();

  const supportedProviders = [PROVIDER_LINKEDIN, PROVIDER_INDEED, PROVIDER_ALL];
  if (requested && !supportedProviders.includes(requested)) {
    return jsonResponse({
      ok: true,
      provider: "external-search",
      jobs: [],
      sources: [{
        name: requested,
        count: 0,
        ok: false,
        error: `Unknown provider "${requested}". Supported: "${PROVIDER_LINKEDIN}", "${PROVIDER_INDEED}", "${PROVIDER_ALL}".`,
      }],
      warnings: [],
    });
  }

  const runLinkedIn = !requested || requested === PROVIDER_LINKEDIN || requested === PROVIDER_ALL;
  // Default runs BOTH lanes. Previously Indeed only ran when the client sent
  // provider:"indeed"|"all" — the app never set it, so users with Google CSE
  // configured never saw a single Indeed row.
  const runIndeed = !requested || requested === PROVIDER_INDEED || requested === PROVIDER_ALL;

  const sources: { name: string; count: number; ok: boolean; error?: string }[] = [];
  let jobs: CanonicalJobOut[] = [];

  if (runLinkedIn) {
    const li = await runLinkedInWithRapidApiPrimary(body);
    jobs = jobs.concat(li.jobs);
    sources.push(li.source);
  }
  if (runIndeed) {
    const ind = await runGoogleCseIndeed(body);
    jobs = jobs.concat(ind.jobs);
    sources.push(ind.source);
  }

  jobs = dedupeJobsByUrl(jobs);

  const warnings: string[] = [];
  if (!getCseCredentials()) {
    warnings.push(
      "Enable LinkedIn/Indeed via Google results: create a Programmable Search Engine (search the entire web), enable Custom Search API, set GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX.",
    );
  }

  return jsonResponse({
    ok: true,
    provider: "external-search",
    jobs,
    sources,
    warnings,
  });
}));
