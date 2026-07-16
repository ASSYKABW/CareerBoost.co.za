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
import { buildFacts, type ScannedJob, type MarketFacts } from "../_shared/market-facts.ts";

// ── Live market scan ────────────────────────────────────────────────────
// Broad, SA-relevant segments. Kept small on purpose: each scan fans out to
// every job provider, so this is the slow part of the job.
const MARKET_SEGMENTS: Array<{ id: string; label: string; query: string }> = [
  { id: "software-developer", label: "software developer", query: "software developer" },
  { id: "data-analyst", label: "data analyst", query: "data analyst" },
  { id: "accountant", label: "accountant", query: "accountant" },
  { id: "sales-representative", label: "sales representative", query: "sales representative" },
];

// Monday (UTC) of the given date — the snapshot's week key.
function weekStartUtc(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay();                 // 0=Sun
  x.setUTCDate(x.getUTCDate() - ((dow + 6) % 7));
  return x.toISOString().slice(0, 10);
}

// Call our own jobs-search server-side. It accepts X-Cron-Secret for exactly
// this kind of internal use, so no user session is involved.
async function scanSegment(query: string): Promise<ScannedJob[]> {
  const base = Deno.env.get("SUPABASE_URL") || "";
  const secret = (Deno.env.get("JOB_SCOUT_CRON_SECRET") || Deno.env.get("CRON_SECRET") || "").trim();
  if (!base || !secret) return [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(`${base}/functions/v1/jobs-search`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Cron-Secret": secret,
        apikey: Deno.env.get("SUPABASE_ANON_KEY") || "",
      },
      // Constrain to SA: the content claims "the South African job market", so
      // the sample must actually BE the South African job market. Without this
      // the scan pulls in US/Canada remote listings and every percentage we
      // publish would quietly be about the wrong country.
      body: JSON.stringify({
        query,
        filters: {
          remoteOnly: false,
          postedWithinDays: 30,
          sort: "newest",
          location: "South Africa",
          locationStrictness: "balanced",
        },
      }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return Array.isArray(j.jobs) ? (j.jobs as ScannedJob[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

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

// ── auto-learn: bias the cadence toward themes that actually convert ──────
//
// Each rotation entry is a recurring theme, identified by its `brief` (which
// marketing-cron stamps into source_data.brief on every draft). We score the
// published descendants of each theme by on-site engagement (content_events)
// + attributed signups (profiles.utm_campaign = slug), then pick the best
// theme most of the time and explore the full rotation the rest of the time.
// Falls back to plain day-rotation on cold start / insufficient data, and is
// fully defensive — any failure degrades to the original rotation.
const EVENT_WEIGHT: Record<string, number> = { view: 1, click: 3, share: 5 };
const SIGNUP_WEIGHT = 10;

interface Selection {
  type: string;
  brief: string;
  mode: "explore" | "exploit" | "cold-start" | "no-signal" | "error";
  score?: number;
}

async function pickTopic(
  svc: ReturnType<typeof getServiceClient>,
  dayIdx: number,
): Promise<Selection> {
  const rotation = TOPIC_ROTATION[dayIdx % TOPIC_ROTATION.length];
  const fallback = (mode: Selection["mode"]): Selection => ({ type: rotation.type, brief: rotation.brief, mode });

  // ~40% of runs explore: cycle the whole rotation so every theme — including
  // off-site social posts that carry no on-site tracking — keeps getting made.
  if (dayIdx % 5 < 2) return fallback("explore");

  try {
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const { data: pieces } = await svc
      .from("content_pieces")
      .select("slug, source_data")
      .eq("status", "published")
      .not("slug", "is", null)
      .gte("published_at", since)
      .limit(500);
    if (!pieces || pieces.length < 3) return fallback("cold-start");

    const slugs = pieces.map((p) => p.slug as string);
    const [evRes, sgRes] = await Promise.all([
      svc.from("content_events").select("slug, event").in("slug", slugs).limit(20000),
      svc.from("profiles").select("utm_campaign").in("utm_campaign", slugs).limit(5000),
    ]);
    const events = evRes.data ?? [];
    if (events.length < 15) return fallback("cold-start");

    // Per-slug performance score.
    const slugScore: Record<string, number> = {};
    slugs.forEach((s) => { slugScore[s] = 0; });
    events.forEach((e) => {
      const w = EVENT_WEIGHT[String(e.event)] ?? 0;
      if (e.slug != null) slugScore[e.slug as string] = (slugScore[e.slug as string] ?? 0) + w;
    });
    (sgRes.data ?? []).forEach((r) => {
      const c = r.utm_campaign as string | null;
      if (c && c in slugScore) slugScore[c] += SIGNUP_WEIGHT;
    });

    // Aggregate by theme (brief) → average score per published descendant.
    const byBrief: Record<string, { score: number; n: number }> = {};
    pieces.forEach((p) => {
      const sd = p.source_data && typeof p.source_data === "object" ? p.source_data as Record<string, unknown> : null;
      const brief = sd ? String(sd.brief || "") : "";
      if (!brief) return;
      if (!byBrief[brief]) byBrief[brief] = { score: 0, n: 0 };
      byBrief[brief].score += slugScore[p.slug as string] ?? 0;
      byBrief[brief].n += 1;
    });

    let best: { type: string; brief: string } | null = null;
    let bestAvg = -1;
    for (const entry of TOPIC_ROTATION) {
      const agg = byBrief[entry.brief];
      if (!agg || agg.n === 0) continue;
      const avg = agg.score / agg.n;
      if (avg > bestAvg) { bestAvg = avg; best = entry; }
    }
    if (best && bestAvg > 0) return { type: best.type, brief: best.brief, mode: "exploit", score: Number(bestAvg.toFixed(2)) };
    return fallback("no-signal");
  } catch {
    return fallback("error");
  }
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

  // ── market-scan (no AI) ───────────────────────────────────────────────
  // Scans the live SA job market per segment and stores one honest snapshot
  // per week. This is what gives the content engine something true to say.
  if (task === "market-scan") {
    const weekStart = weekStartUtc(new Date());
    const only = String(body.segment || "").trim();
    const segs = only ? MARKET_SEGMENTS.filter((s) => s.id === only) : MARKET_SEGMENTS;
    if (!segs.length) return errorResponse("Unknown segment: " + only, 400);

    const results: Array<Record<string, unknown>> = [];
    for (const seg of segs) {
      try {
        const jobs = await scanSegment(seg.query);
        const facts: MarketFacts = buildFacts(jobs);
        const { error } = await svc.from("market_snapshots").upsert({
          week_start: weekStart,
          segment: seg.id,
          label: seg.label,
          scanned: facts.scanned,
          sufficient: facts.sufficient,
          facts: facts as unknown as Record<string, unknown>,
        }, { onConflict: "week_start,segment" });
        results.push({
          segment: seg.id,
          scanned: facts.scanned,
          sufficient: facts.sufficient,
          remoteShare: facts.remoteShare,
          topSkills: facts.topSkills.slice(0, 5).map((s) => s.name),
          stored: !error,
          storeError: error ? error.message : undefined,
        });
      } catch (e) {
        // One bad segment must not sink the whole scan.
        results.push({ segment: seg.id, error: String((e as Error).message || e) });
      }
    }
    return jsonResponse({ ok: true, task, week_start: weekStart, segments: results });
  }

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

    // default: a single rotating content draft, biased by what's converting
    const dayIdx = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    const topic = await pickTopic(svc, dayIdx);
    const d = await generate(topic.type, topic.brief, voice);
    const row = rowFromGenerated(topic.type, topic.brief, d);
    row.source_data = {
      ...(row.source_data as Record<string, unknown>),
      selection: { mode: topic.mode, score: topic.score ?? null },
    };
    const { data, error } = await svc.from("content_pieces").insert(row).select("id, title, type").maybeSingle();
    if (error) return errorResponse("draft insert failed: " + error.message, 500);
    return jsonResponse({ ok: true, task: "draft", piece: data, selection: { mode: topic.mode, score: topic.score ?? null } });
  } catch (err) {
    return errorResponse("Generation failed: " + ((err as Error).message || String(err)), 502);
  }
}));
