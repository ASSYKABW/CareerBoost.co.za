// POST /functions/v1/company-intel-search
// Auth: Supabase JWT via getAuthedUser().
// Uses Google Custom Search (same secrets as external-search: GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX).
//
// Body: { company: string; role?: string }
// Response: { ok: true, hits: Hit[], queries: string[], cacheHit?: boolean, warnings?: string[] }
//
// Phase 3 changes:
//   - 7 CSE queries now run in PARALLEL (was sequential, 7 × ~600ms = 4.2s).
//   - Full response cached in kv_cache (namespace=cse) for 24h. Two users
//     asking about the same company within 24h cost ONE Google CSE bill.
//   - Cache key includes role since queries differ when role is set.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";
import { buildKvKey, readKvCache, writeKvCache } from "../_shared/kv-cache.ts";

interface Hit {
  title: string;
  url: string;
  snippet: string;
  query: string;
}

interface CseItem {
  title?: string;
  link?: string;
  snippet?: string;
}

interface CachedResponse {
  hits: Hit[];
  queries: string[];
  warnings: string[];
}

const CSE_TIMEOUT_MS = 12_000;
const MAX_TOTAL_HITS = 36;
const RESULTS_PER_QUERY = 8;
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

function getCseCredentials(): { key: string; cx: string } | null {
  const key = String(Deno.env.get("GOOGLE_CSE_API_KEY") || "").trim();
  const cx = String(Deno.env.get("GOOGLE_CSE_CX") || "").trim();
  if (!key || !cx) return null;
  return { key, cx };
}

async function fetchGoogleCse(
  q: string,
  creds: { key: string; cx: string },
): Promise<{ items: CseItem[]; query: string; error?: string }> {
  const maxQ = 1750;
  const query = q.length > maxQ ? q.slice(0, maxQ) : q;
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", creds.key);
  u.searchParams.set("cx", creds.cx);
  u.searchParams.set("q", query);
  u.searchParams.set("num", String(RESULTS_PER_QUERY));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CSE_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { signal: ac.signal });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = json?.error as { message?: string } | undefined;
      const msg = errObj?.message || `HTTP ${res.status}`;
      return { items: [], query: q, error: msg };
    }
    const items = Array.isArray(json.items) ? json.items as CseItem[] : [];
    return { items, query: q };
  } catch (e) {
    const msg = (e as Error).name === "AbortError"
      ? "Google CSE request timed out"
      : String((e as Error).message || e);
    return { items: [], query: q, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function safeCompanyQuoted(name: string): string {
  const t = String(name || "")
    .trim()
    .replace(/[\s\n\r]+/g, " ")
    .replace(/"/g, " ")
    .slice(0, 100);
  return t ? `"${t}"` : "";
}

function buildQueries(company: string, role: string): string[] {
  const c = safeCompanyQuoted(company);
  if (!c) return [];
  const r = String(role || "").trim().replace(/"/g, " ").slice(0, 64);
  const q: string[] = [
    `${c} interview process`,
    `${c} interview experience`,
    `${c} (site:glassdoor.com OR site:reddit.com OR site:teamblind.com) interview`,
    `${c} site:levels.fyi interview`,
    `${c} hiring interview questions`,
  ];
  if (r) {
    q.push(`${c} ${r} interview`);
  }
  return q.slice(0, 7);
}

function normalizeUrlKey(link: string): string {
  try {
    const u = new URL(link);
    u.hash = "";
    return u.toString().toLowerCase();
  } catch {
    return String(link || "").trim().toLowerCase();
  }
}

/** Normalize cache-key inputs so capitalization / whitespace don't fragment. */
function cacheNormalize(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
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

  let body: { company?: string; role?: string };
  try {
    body = (await req.json()) as { company?: string; role?: string };
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const company = String(body.company || "").trim();
  if (!company || company.length < 2) {
    return errorResponse("company is required (min 2 characters)", 400);
  }
  const role = String(body.role || "").trim();

  // ---- Cache lookup (24h TTL on cse namespace) ----
  const cacheKey = await buildKvKey({
    company: cacheNormalize(company),
    role: cacheNormalize(role),
  });
  const cached = await readKvCache<CachedResponse>("cse", cacheKey);
  if (cached.payload) {
    return jsonResponse({
      ok: true,
      company,
      role: role || null,
      queries: cached.payload.queries,
      hits: cached.payload.hits,
      warnings: cached.payload.warnings,
      cacheHit: true,
      cacheAgeSeconds: cached.ageSeconds,
    }, { headers: { "X-Cache": "HIT" } });
  }

  const creds = getCseCredentials();
  if (!creds) {
    return errorResponse(
      "Google CSE not configured. Set GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX on this function (same as external-search).",
      503,
    );
  }

  const queries = buildQueries(company, role);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const hits: Hit[] = [];

  // Phase 3: parallel fan-out. ~7 queries × 600ms each → ~600ms total wall-clock.
  // Order is preserved (Promise.all maintains positional results) so dedupe
  // priority is identical to the old sequential behavior.
  const results = await Promise.all(
    queries.map((q) => fetchGoogleCse(q, creds)),
  );

  for (const res of results) {
    if (res.error) {
      warnings.push(`Query failed (${res.query.slice(0, 48)}…): ${res.error}`);
      continue;
    }
    for (const item of res.items) {
      const url = String(item.link || "").trim();
      const title = String(item.title || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const snippet = String(item.snippet || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const key = normalizeUrlKey(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      hits.push({ title: title || url, url, snippet: snippet.slice(0, 600), query: res.query });
      if (hits.length >= MAX_TOTAL_HITS) break;
    }
    if (hits.length >= MAX_TOTAL_HITS) break;
  }

  if (!hits.length && !warnings.length) {
    warnings.push("No search results returned — try a different company phrase.");
  }

  // Cache the full result set (fire-and-forget). Skip caching obviously broken
  // states (zero hits + all queries errored) so transient outages don't poison.
  const allErrored = warnings.length > 0 && hits.length === 0;
  if (!allErrored) {
    writeKvCache("cse", cacheKey, { hits, queries, warnings }, CACHE_TTL_SECONDS)
      .catch(() => {});
  }

  return jsonResponse({
    ok: true,
    company,
    role: role || null,
    queries,
    hits,
    warnings,
    cacheHit: false,
  }, { headers: { "X-Cache": "MISS" } });
}));
