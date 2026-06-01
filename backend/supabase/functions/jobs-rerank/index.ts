// POST /functions/v1/jobs-rerank
// Auth: Supabase JWT via getAuthedUser().
//
// Body: {
//   resume: string,                 // candidate's base resume text
//   jobs: [{ id: string, text: string }],   // jobs to rank (id + composite text)
//   topN?: number                   // optional cap; default 12
// }
//
// Response: {
//   ok: true,
//   ranked: [{ id, similarity, rank }],   // sorted by similarity desc
//   model: string,
//   cacheHits: number,
//   cacheMisses: number,
//   costUsd: number,
//   latencyMs: number
// }
//
// What it does:
//   1. Embeds the resume + each job's text in a single batch call (1 + N
//      vectors per request).
//   2. Computes cosine similarity between the resume vector and each job
//      vector.
//   3. Returns ranked positions.
//
// Why a separate function from `embeddings`:
//   - Encapsulates the rerank algorithm so the client doesn't need to know
//     about cosine math.
//   - One round-trip from the client (vs. embed + then rerank in two calls).
//   - Future-proof for adding more sophisticated rerankers (cross-encoder,
//     learned-to-rank, etc.) without changing the client API.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";
import { embedBatch, cosineSimilarity, type EmbeddingModel } from "../_shared/embeddings.ts";

const MAX_JOBS_PER_CALL = 24;
const DEFAULT_TOP_N = 12;
const DEFAULT_MODEL: EmbeddingModel = "text-embedding-3-small";

interface JobInput {
  id?: unknown;
  text?: unknown;
}

interface Body {
  resume?: unknown;
  jobs?: unknown;
  topN?: unknown;
  model?: unknown;
}

Deno.serve(withCors(async (req) => {
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

  const resume = typeof body.resume === "string" ? body.resume.trim() : "";
  if (!resume || resume.length < 30) {
    return errorResponse("`resume` must be a non-empty string (>=30 chars).", 400);
  }

  const jobsRaw = Array.isArray(body.jobs) ? body.jobs : [];
  const jobs = jobsRaw
    .map((j: JobInput) => ({
      id: typeof j?.id === "string" ? j.id : "",
      text: typeof j?.text === "string" ? j.text.trim() : "",
    }))
    .filter((j) => j.id && j.text);
  if (!jobs.length) {
    return errorResponse("`jobs` must be an array of {id, text} pairs.", 400);
  }
  if (jobs.length > MAX_JOBS_PER_CALL) {
    return errorResponse(
      `Too many jobs: ${jobs.length} > ${MAX_JOBS_PER_CALL}. Cap topN before calling.`,
      400,
    );
  }

  const topN = Math.max(1, Math.min(MAX_JOBS_PER_CALL, Number(body.topN) || DEFAULT_TOP_N));
  const model = (typeof body.model === "string" ? body.model : DEFAULT_MODEL) as EmbeddingModel;

  const started = Date.now();
  try {
    // Single batch: [resume, job_1, job_2, ..., job_N]. Cache hits on the
    // resume mean repeated rerank calls within the same session pay only
    // for the new job texts.
    const result = await embedBatch({
      texts: [resume, ...jobs.map((j) => j.text)],
      model,
    });

    const resumeVec = result.vectors[0] || [];
    if (!resumeVec.length) {
      throw new Error("Resume embedding came back empty.");
    }

    const ranked = jobs
      .map((job, i) => ({
        id: job.id,
        similarity: cosineSimilarity(resumeVec, result.vectors[i + 1] || []),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN)
      .map((row, i) => ({
        id: row.id,
        // Round to 4 decimals — anything more is noise and bloats payload.
        similarity: Number(row.similarity.toFixed(4)),
        rank: i + 1,
      }));

    const latencyMs = Date.now() - started;

    // Telemetry
    try {
      await getServiceClient().from("ai_usage").insert({
        user_id: user.id,
        request_id: crypto.randomUUID(),
        skill: "jobs-rerank",
        provider: "openai",
        model: result.model,
        prompt_version: "jobs-rerank@v1.0.0",
        status: "success",
        latency_ms: latencyMs,
        input_tokens: result.inputTokens || null,
        output_tokens: 0,
        cost_usd: result.costUsd || null,
      });
    } catch { /* ignore */ }

    return jsonResponse({
      ok: true,
      ranked,
      model: result.model,
      cacheHits: result.cacheHits,
      cacheMisses: result.cacheMisses,
      costUsd: result.costUsd,
      latencyMs,
    });
  } catch (err) {
    const message = (err as Error).message || "Rerank call failed";
    try {
      await getServiceClient().from("ai_usage").insert({
        user_id: user.id,
        request_id: crypto.randomUUID(),
        skill: "jobs-rerank",
        prompt_version: "jobs-rerank@v1.0.0",
        status: "failed",
        latency_ms: Date.now() - started,
        error: message.slice(0, 500),
      });
    } catch { /* ignore */ }
    return errorResponse(message, 502);
  }
}));
