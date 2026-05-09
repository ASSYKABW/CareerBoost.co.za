// POST /functions/v1/embeddings
// Auth: Supabase JWT via getAuthedUser().
// Body: { texts: string[], model?: "text-embedding-3-small" | "text-embedding-3-large" }
// Response: {
//   ok: true,
//   vectors: number[][],    // same length as request.texts
//   model: string,
//   dimensions: number,
//   cacheHits: number,
//   cacheMisses: number,
//   inputTokens: number,    // billed (cache misses only)
//   costUsd: number
// }
//
// Most callers won't hit this directly — jobs-rerank uses the embedBatch
// helper internally. This endpoint is exposed for cases where the client
// wants raw vectors (e.g. resume evidence sorting in Phase 5C).
//
// Cost guard: capped at 32 texts per call. Each text capped at ~32K chars.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";
import { embedBatch, type EmbeddingModel } from "../_shared/embeddings.ts";

const MAX_TEXTS_PER_CALL = 32;

interface Body {
  texts?: unknown;
  model?: string;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const texts = Array.isArray(body.texts)
    ? (body.texts.filter((t) => typeof t === "string") as string[])
    : [];
  if (!texts.length) {
    return errorResponse("`texts` must be a non-empty array of strings.", 400);
  }
  if (texts.length > MAX_TEXTS_PER_CALL) {
    return errorResponse(
      `Too many texts: ${texts.length} > ${MAX_TEXTS_PER_CALL}. Split into smaller batches.`,
      400,
    );
  }

  const model = (typeof body.model === "string" ? body.model : "text-embedding-3-small") as EmbeddingModel;

  const started = Date.now();
  try {
    const result = await embedBatch({ texts, model });
    const latencyMs = Date.now() - started;

    // Telemetry — model + cost. Skill is reported as "embeddings" so it shows
    // up alongside chat-completion calls in the per-skill rollups.
    try {
      await getServiceClient().from("ai_usage").insert({
        user_id: user.id,
        request_id: crypto.randomUUID(),
        skill: "embeddings",
        provider: "openai",
        model: result.model,
        prompt_version: "embeddings@v1.0.0",
        status: "success",
        latency_ms: latencyMs,
        input_tokens: result.inputTokens || null,
        output_tokens: 0,
        cost_usd: result.costUsd || null,
      });
    } catch { /* telemetry must not break the request */ }

    return jsonResponse({
      ok: true,
      vectors: result.vectors,
      model: result.model,
      dimensions: result.dimensions,
      cacheHits: result.cacheHits,
      cacheMisses: result.cacheMisses,
      inputTokens: result.inputTokens,
      costUsd: result.costUsd,
      latencyMs,
    });
  } catch (err) {
    const message = (err as Error).message || "Embeddings call failed";
    try {
      await getServiceClient().from("ai_usage").insert({
        user_id: user.id,
        request_id: crypto.randomUUID(),
        skill: "embeddings",
        prompt_version: "embeddings@v1.0.0",
        status: "failed",
        latency_ms: Date.now() - started,
        error: message.slice(0, 500),
      });
    } catch { /* ignore */ }
    return errorResponse(message, 502);
  }
});
