// Embeddings helper — single entry point for generating + caching vector
// embeddings. Used by the embeddings Edge Function (direct call) and by
// jobs-rerank (composes embed + cosine).
//
// Caching strategy:
//   - 30-day TTL on embeddings_cache (text→vector mappings rarely change).
//   - Cache key = sha256(model + normalized_text). Normalization strips
//     leading/trailing whitespace and collapses internal whitespace, so
//     "  Hello   World " and "Hello World" share the same vector.
//   - Reads + writes go through service role (RLS deny for users).

import { getServiceClient } from "./auth.ts";

export type EmbeddingModel =
  | "text-embedding-3-small"
  | "text-embedding-3-large"
  | "text-embedding-004";

const DEFAULT_MODEL: EmbeddingModel = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;
const CACHE_TTL_DAYS = 30;
const MAX_TEXT_LEN = 32_000; // ~8000 tokens; safe under OpenAI's 8191 limit

export interface EmbedRequest {
  texts: string[];
  model?: EmbeddingModel;
}

export interface EmbedResult {
  /** Same length as request.texts. NaN-free, NEVER null. */
  vectors: number[][];
  model: string;
  dimensions: number;
  /** Per-text cache hits/misses for telemetry. */
  cacheHits: number;
  cacheMisses: number;
  /** Tokens billed by the upstream provider on this call (cache misses only). */
  inputTokens: number;
  /** USD cost of this call. */
  costUsd: number;
}

function normalizeText(text: string): string {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, MAX_TEXT_LEN);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildCacheKey(model: string, normalizedText: string): Promise<string> {
  return await sha256Hex(model.toLowerCase() + "|" + normalizedText);
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------
interface CachedRow {
  cache_key: string;
  vector: number[] | string;  // Postgres vector type returns as string in some clients
}

async function readCacheBatch(keys: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!keys.length) return out;
  try {
    const admin = getServiceClient();
    const { data, error } = await admin
      .from("embeddings_cache")
      .select("cache_key, vector")
      .in("cache_key", keys)
      .gt("expires_at", new Date().toISOString());
    if (error || !data) return out;
    (data as CachedRow[]).forEach((row) => {
      if (!row.cache_key || row.vector == null) return;
      const arr = parseVector(row.vector);
      if (arr.length) out.set(row.cache_key, arr);
    });
    // Best-effort hit-count bumps in parallel; don't await.
    keys.forEach((k) => {
      if (out.has(k)) {
        admin.rpc("embeddings_cache_increment_hit", { p_cache_key: k })
          .then(() => {}, () => {});
      }
    });
  } catch {
    // Cache failure must never break the request — caller will see a miss
    // and fall through to provider call.
  }
  return out;
}

/** pgvector returns either number[] (newer drivers) or "[1,2,3]" string. */
function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") {
    try {
      const trimmed = raw.replace(/^\[/, "").replace(/\]$/, "");
      if (!trimmed) return [];
      return trimmed.split(",").map((s) => Number(s.trim()));
    } catch {
      return [];
    }
  }
  return [];
}

async function writeCacheBatch(
  rows: Array<{ key: string; model: string; dimensions: number; text: string; vector: number[] }>,
): Promise<void> {
  if (!rows.length) return;
  try {
    const admin = getServiceClient();
    const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 86_400_000).toISOString();
    const payload = rows.map((r) => ({
      cache_key: r.key,
      model: r.model,
      dimensions: r.dimensions,
      // pgvector accepts the bracket-string form on insert.
      vector: "[" + r.vector.join(",") + "]",
      text_preview: r.text.slice(0, 200),
      hit_count: 0,
      expires_at: expiresAt,
    }));
    await admin.from("embeddings_cache").upsert(payload, { onConflict: "cache_key" });
  } catch {
    // Cache write failure must not break the request.
  }
}

// ---------------------------------------------------------------------------
// Provider — OpenAI embeddings (text-embedding-3-small/large)
// ---------------------------------------------------------------------------
async function callOpenAIEmbeddings(
  model: EmbeddingModel,
  texts: string[],
): Promise<{ vectors: number[][]; inputTokens: number }> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  const vectors = (data?.data || []).map((d: { embedding?: number[] }) => d.embedding || []);
  const inputTokens = data?.usage?.total_tokens ?? data?.usage?.prompt_tokens ?? 0;
  return { vectors, inputTokens };
}

// ---------------------------------------------------------------------------
// Public entry — embed a batch of texts with cache + provider fallback.
// ---------------------------------------------------------------------------
export async function embedBatch(req: EmbedRequest): Promise<EmbedResult> {
  const model = req.model || DEFAULT_MODEL;
  const dimensions = DEFAULT_DIMENSIONS; // text-embedding-3-small default

  if (!Array.isArray(req.texts) || !req.texts.length) {
    return {
      vectors: [],
      model,
      dimensions,
      cacheHits: 0,
      cacheMisses: 0,
      inputTokens: 0,
      costUsd: 0,
    };
  }

  const normalized = req.texts.map(normalizeText);
  const keys = await Promise.all(normalized.map((t) => buildCacheKey(model, t)));
  const cached = await readCacheBatch(keys);

  // Build the list of (index, text) that need fresh embeddings.
  const missingIdx: number[] = [];
  const missingText: string[] = [];
  keys.forEach((k, i) => {
    if (!cached.has(k)) {
      missingIdx.push(i);
      missingText.push(normalized[i] || " ");
    }
  });

  let inputTokens = 0;
  let freshVectors: number[][] = [];
  if (missingText.length) {
    const result = await callOpenAIEmbeddings(model, missingText);
    freshVectors = result.vectors;
    inputTokens = result.inputTokens;

    // Persist fresh embeddings to cache.
    const writes = missingIdx.map((origIdx, freshIdx) => ({
      key: keys[origIdx],
      model,
      dimensions: freshVectors[freshIdx]?.length || dimensions,
      text: normalized[origIdx] || "",
      vector: freshVectors[freshIdx] || [],
    })).filter((row) => row.vector.length > 0);
    if (writes.length) writeCacheBatch(writes).catch(() => {});
  }

  // Stitch: cache hits + fresh embeddings into the original-order array.
  const vectors: number[][] = new Array(req.texts.length);
  let freshCursor = 0;
  keys.forEach((k, i) => {
    const fromCache = cached.get(k);
    if (fromCache) {
      vectors[i] = fromCache;
    } else {
      vectors[i] = freshVectors[freshCursor++] || [];
    }
  });

  const cacheHits = cached.size;
  const cacheMisses = missingIdx.length;
  const costUsd = computeEmbeddingCost(model, inputTokens);

  return { vectors, model, dimensions, cacheHits, cacheMisses, inputTokens, costUsd };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------
const PRICE_PER_M_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-004":     0.0,
};

function computeEmbeddingCost(model: string, tokens: number): number {
  const price = PRICE_PER_M_TOKENS[model] ?? 0.02;
  return Number(((tokens / 1_000_000) * price).toFixed(6));
}

// ---------------------------------------------------------------------------
// Cosine similarity (between two equal-length vectors).
// ---------------------------------------------------------------------------
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
