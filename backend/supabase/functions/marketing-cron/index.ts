// POST /functions/v1/marketing-cron
//
// Server-side cadence job for the Marketing engine (Phase 2). Generates content
// server-side (no per-user AI quota — reuses callLLM + the content-generate
// prompt + the Brand Kit voice) and lands everything as status='needs_review'
// so a human always approves before anything goes live.
//
// Auth: an X-Cron-Secret header matching the CRON_SECRET env (the scheduler),
// OR an admin JWT (the "Run cadence now" button in Content Studio).
//
// Body: { task: "draft" | "newsletter-draft" | "publish-due" }
//   draft            — 1 on-brand draft, type/topic rotates by day
//   newsletter-draft — the weekly "SA Job Market Pulse" newsletter draft
//   publish-due      — publish scheduled pieces whose scheduled_at has passed

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { prompts } from "../_shared/prompts.ts";
import { callLLM, callProvider, providerHasKey, extractJson } from "../_shared/llm.ts";
import { SKILL_ROUTING, maxTokensFor, temperatureFor } from "../_shared/routing.ts";
import { validateSkillPayload } from "../_shared/schemas.ts";

// Evergreen, SA-flavoured topic rotation for the auto-draft cadence. The
// scheduler runs ~3×/week; each run picks the next entry by day so content
// varies. Operators edit or replace before publishing.
const TOPIC_ROTATION: Array<{ type: string; brief: string }> = [
  { type: "blog", brief: "The resume mistakes that quietly cost South African job seekers interviews — and how to fix each one." },
  { type: "social_linkedin", brief: "A short, motivating LinkedIn post for job seekers about turning a rejection into momentum this week." },
  { type: "blog", brief: "How to tailor your CV to a specific job description, with a simple before/after example." },
  { type: "social_x", brief: "One punchy tip for job seekers about following up after an application without being annoying." },
  { type: "blog", brief: "ATS-friendly CV formatting in 2026: what actually matters and what's a myth." },
  { type: "social_linkedin", brief: "Why a generic CV gets ignored, and the few lines that make a recruiter stop scrolling." },
  { type: "blog", brief: "Interview prep in a weekend: a practical checklist for South African candidates." },
];

interface BrandVoice {
  tone?: string;
  readingLevel?: string;
  do?: string[];
  dont?: string[];
}

async function getBrandVoice(svc: ReturnType<typeof getServiceClient>): Promise<BrandVoice> {
  try {
    const { data } = await svc.from("brand_settings").select("voice_tone").eq("id", "default").maybeSingle();
    const vt = data?.voice_tone;
    return (vt && typeof vt === "object") ? vt as BrandVoice : {};
  } catch {
    return {};
  }
}

async function generate(contentType: string, brief: string, brandVoice: BrandVoice, facts?: string): Promise<Record<string, unknown>> {
  const spec = prompts["content-generate"];
  const input = { contentType, brief, brandVoice, data: facts || "" };
  const callInput = {
    systemStable: spec.systemStable,
    user: spec.userTemplate(input),
    temperature: temperatureFor("content-generate"),
    maxTokens: maxTokensFor("content-generate"),
  };
  // Prefer the routed provider/model (Anthropic Sonnet) when its key is set;
  // otherwise fall back to the default provider chain.
  const route = SKILL_ROUTING["content-generate"];
  const out = providerHasKey(route.provider)
    ? await callProvider(route.provider, { ...callInput, model: route.model })
    : await callLLM(callInput);
  const parsed = extractJson<Record<string, unknown>>(out.text);
  validateSkillPayload("content-generate", parsed);
  return parsed;
}

function rowFromGenerated(type: string, brief: string, d: Record<string, unknown>): Record<string, unknown> {
  let body = String(d.body || "");
  const tags = Array.isArray(d.hashtags) ? (d.hashtags as unknown[]).map(String) : [];
  if (tags.length && type.indexOf("social") === 0) body += "\n\n" + tags.join(" ");
  return {
    type,
    title: String(d.title || brief).slice(0, 240),
    body,
    excerpt: String(d.excerpt || "").slice(0, 600),
    seo: (d.seo && typeof d.seo === "object") ? d.seo : {},
    status: "needs_review",
    created_by: "ai",
    prompt_version: "content-generate@v1.0.0",
    source_data: { brief, hashtags: tags, generatedBy: "marketing-cron" },
  };
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // ── auth: cron secret OR admin JWT ───────────────────────────────────
  const cronSecret = (Deno.env.get("CRON_SECRET") || "").trim();
  const provided = (req.headers.get("X-Cron-Secret") || "").trim();
  const bySecret = !!cronSecret && provided === cronSecret;
  if (!bySecret) {
    try {
      await getAuthedAdmin(req);
    } catch (err) {
      return errorResponse((err as Error).message || "Unauthorized", 403);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const task = String(body.task || "draft");
  const svc = getServiceClient();

  // ── publish-due (no AI) ───────────────────────────────────────────────
  if (task === "publish-due") {
    const nowIso = new Date().toISOString();
    const { data, error } = await svc
      .from("content_pieces")
      .update({ status: "published", published_at: nowIso, updated_at: nowIso })
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso)
      .select("id");
    if (error) return errorResponse("publish-due failed: " + error.message, 500);
    return jsonResponse({ ok: true, task, published: (data ?? []).length });
  }

  // ── draft / newsletter-draft (AI) ─────────────────────────────────────
  const voice = await getBrandVoice(svc);

  try {
    if (task === "newsletter-draft") {
      const brief = "Weekly 'SA Job Market Pulse' newsletter for CareerBoost subscribers: " +
        "a short, encouraging issue with 2-3 sections — one practical job-search tip, " +
        "one mindset/motivation note, and a soft CTA to use CareerBoost. Friendly and concrete.";
      const d = await generate("newsletter", brief, voice);
      const row = rowFromGenerated("newsletter", brief, d);
      row.channel = "newsletter";
      const { data, error } = await svc.from("content_pieces").insert(row).select("id, title").maybeSingle();
      if (error) return errorResponse("newsletter-draft insert failed: " + error.message, 500);
      return jsonResponse({ ok: true, task, piece: data });
    }

    // default: a single rotating content draft
    const idx = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) % TOPIC_ROTATION.length;
    const topic = TOPIC_ROTATION[idx];
    const d = await generate(topic.type, topic.brief, voice);
    const row = rowFromGenerated(topic.type, topic.brief, d);
    const { data, error } = await svc.from("content_pieces").insert(row).select("id, title, type").maybeSingle();
    if (error) return errorResponse("draft insert failed: " + error.message, 500);
    return jsonResponse({ ok: true, task: "draft", piece: data });
  } catch (err) {
    return errorResponse("Generation failed: " + ((err as Error).message || String(err)), 502);
  }
}));
