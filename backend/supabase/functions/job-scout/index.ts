// POST /functions/v1/job-scout
// Auth: Supabase JWT via getAuthedUser().
//
// The user-facing Job Scout Agent API (Phase 1 — manual scans). One endpoint,
// action-routed, service-role DB access with per-user ownership enforced here
// (the job_scout_* tables are RLS deny-by-default; see migration 0049).
//
// Body: { action: "get" | "save" | "scan" | "update-finding", ... }
//
//   get            → { agent, findings (non-dismissed, newest 50), stats }
//   save           → { agent: {...config} } → validated upsert (one per user)
//   scan           → runs the existing search pipeline (jobs-search +
//                    external-search + companies-search, called with the
//                    caller's own JWT), fingerprints results, delta-filters
//                    against job_scout_seen, stores ≤ max_per_scan NEW
//                    findings, updates last_run stats.
//   update-finding → { findingId, status? , fit? } → review-state / fit patch.
//
// Phase 2 (cron) will reuse `scan` server-side; nothing here assumes a browser.

import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";
import { resendConfigured, sendEmail } from "../_shared/resend.ts";
import { callProvider, extractJson, type LLMProvider, providerHasKey } from "../_shared/llm.ts";
import { buildKvKey, readKvCache, writeKvCache } from "../_shared/kv-cache.ts";
import { getScoutHealth } from "../_shared/scout-health.ts";

const FINDINGS_LIMIT = 50;
// Deep Scan: how wide to fan the 10-board aggregator, and expansion cache TTL.
const DEEP_SCAN_MAX_TITLES = 6;
const DEEP_SCAN_CONCURRENCY = 3;
const TITLE_EXPAND_TTL_SECONDS = 24 * 60 * 60;
const MAX_PER_SCAN_CAP = 50;
const FN_TIMEOUT_MS = 25_000;

interface ScoutJob {
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  postedAt: string;
  salary: string;
  remote: boolean;
  tags: string[];
  descriptionText: string;
}

interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  target_titles: string[];
  must_have_skills: string[];
  exclude_keywords: string[];
  seniority: string;
  location: string;
  location_strictness: string;
  work_mode: string;
  active: boolean;
  cadence: string;
  max_per_scan: number;
  notify_push: boolean;
  notify_email: boolean;
  scan_count: number;
  upsell_sent: boolean;
  last_run_at: string | null;
  last_run_stats: Record<string, unknown> | null;
  last_notified_at: string | null;
}

// ---- Tier matrix ----------------------------------------------------------
// Free is a TRIAL (4 scans, ~5h apart, then stop + upsell). Paid tiers step up
// agent count, auto-scan rate, Deep-Scan breadth, results/scan and board access.
interface TierLimit {
  id: string;
  agents: number;
  scanQuota: number | null;   // null = unlimited
  intervalMs: number;         // auto-scan interval (min gap between cron runs)
  deepTitles: number;         // Deep-Scan expansion cap (<=1 disables expansion)
  maxPerScan: number;         // findings delivered per scan
  external: boolean;          // LinkedIn/Indeed (external-search) lane
}
const HOUR = 3_600_000;
const TIER_LIMITS: Record<string, TierLimit> = {
  free:   { id: "free",   agents: 1, scanQuota: 4,    intervalMs: 5 * HOUR - 5 * 60_000, deepTitles: 1, maxPerScan: 15, external: false },
  plus:   { id: "plus",   agents: 1, scanQuota: null, intervalMs: 23 * HOUR,             deepTitles: 3, maxPerScan: 20, external: false },
  pro:    { id: "pro",    agents: 3, scanQuota: null, intervalMs: 6 * HOUR - 5 * 60_000, deepTitles: 5, maxPerScan: 30, external: true },
  career: { id: "career", agents: 5, scanQuota: null, intervalMs: HOUR - 5 * 60_000,     deepTitles: 6, maxPerScan: 50, external: true },
};
function tierOf(planId: string): TierLimit {
  return TIER_LIMITS[String(planId || "").toLowerCase()] || TIER_LIMITS.free;
}
// Resolve a user's active plan id (free | plus | pro | career).
async function planTier(userId: string): Promise<TierLimit> {
  try {
    const admin = getServiceClient();
    const { data } = await admin
      .from("subscriptions")
      .select("plan_id, status")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { plan_id?: string; status?: string } | null;
    if (row && row.status === "active" && row.plan_id && TIER_LIMITS[row.plan_id.toLowerCase()]) {
      return TIER_LIMITS[row.plan_id.toLowerCase()];
    }
  } catch { /* fall through to free */ }
  return TIER_LIMITS.free;
}

function str(v: unknown, max = 200): string {
  return String(v ?? "").trim().slice(0, max);
}

function strArr(v: unknown, maxItems: number, maxLen = 60): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const item of v) {
    const t = String(item ?? "").trim().slice(0, maxLen);
    const k = t.toLowerCase();
    if (!t || seen[k]) continue;
    seen[k] = true;
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function oneOf(v: unknown, allowed: string[], fallback: string): string {
  const t = String(v ?? "").trim().toLowerCase();
  return allowed.includes(t) ? t : fallback;
}

function toClientAgent(row: AgentRow) {
  return {
    id: row.id,
    name: row.name,
    targetTitles: row.target_titles || [],
    mustHaveSkills: row.must_have_skills || [],
    excludeKeywords: row.exclude_keywords || [],
    seniority: row.seniority,
    location: row.location,
    locationStrictness: row.location_strictness,
    workMode: row.work_mode,
    active: row.active,
    cadence: row.cadence,
    maxPerScan: row.max_per_scan,
    notifyPush: row.notify_push !== false,
    notifyEmail: row.notify_email !== false,
    scanCount: row.scan_count || 0,
    lastRunAt: row.last_run_at,
    lastRunStats: row.last_run_stats || null,
  };
}

function fingerprintFor(job: ScoutJob): string {
  const url = str(job.url, 500).toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (url) return url;
  return [job.company, job.title, job.location]
    .map((s) => String(s || "").trim().toLowerCase())
    .join("|");
}

function compactJob(j: Record<string, unknown>): ScoutJob {
  return {
    title: str(j.title, 160),
    company: str(j.company, 120),
    location: str(j.location, 120),
    url: str(j.url, 500),
    source: str(j.source, 60),
    postedAt: str(j.postedAt, 40),
    salary: str(j.salary, 60),
    remote: j.remote === true,
    tags: strArr(j.tags, 6, 40),
    descriptionText: str(j.descriptionText, 700),
  };
}

function daysSince(iso: string | null): number {
  if (!iso) return 9999;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 9999;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// How a scan authenticates against the search functions: a user-triggered scan
// forwards the caller's own JWT; a cron scan (no user session) presents the
// shared cron secret, which the search functions accept as an internal caller.
interface ScanAuth {
  jwt?: string;
  cronSecret?: string;
}

function cronSecretFromEnv(): string {
  return (Deno.env.get("JOB_SCOUT_CRON_SECRET") || Deno.env.get("CRON_SECRET") || "").trim();
}

async function callSearchFn(
  name: string,
  payload: unknown,
  auth: ScanAuth,
): Promise<{ ok: boolean; jobs: Record<string, unknown>[]; error?: string }> {
  const base = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FN_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: anon,
    };
    if (auth.jwt) headers.Authorization = auth.jwt;
    if (auth.cronSecret) headers["X-Cron-Secret"] = auth.cronSecret;
    const res = await fetch(`${base}/functions/v1/${name}`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || json.ok === false) {
      return { ok: false, jobs: [], error: str(json.error, 200) || `HTTP ${res.status}` };
    }
    return { ok: true, jobs: Array.isArray(json.jobs) ? json.jobs as Record<string, unknown>[] : [] };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "timed out" : String((e as Error).message || e);
    return { ok: false, jobs: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Upper bound on agents any tier allows (Career = 5) — used to size queries.
const MAX_AGENTS_ANY = 5;

async function loadAgents(userId: string): Promise<AgentRow[]> {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_agents")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("agent load failed: " + error.message);
  return (data || []) as AgentRow[];
}

async function loadAgentById(agentId: string, userId: string): Promise<AgentRow | null> {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_agents")
    .select("*")
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error("agent load failed: " + error.message);
  const row = (data as AgentRow) || null;
  return row && row.user_id === userId ? row : null;
}

// All non-dismissed findings for the user, grouped by agent_id.
async function loadFindingsByAgent(userId: string): Promise<Record<string, unknown[]>> {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_findings")
    .select("id, agent_id, fingerprint, job, fit_score, fit_summary, fit_reasons, status, found_at")
    .eq("user_id", userId)
    .neq("status", "dismissed")
    .order("found_at", { ascending: false })
    .limit(FINDINGS_LIMIT * MAX_AGENTS_ANY);
  if (error) throw new Error("findings load failed: " + error.message);
  const byAgent: Record<string, unknown[]> = {};
  for (const f of (data || []) as Record<string, unknown>[]) {
    const aid = String(f.agent_id);
    (byAgent[aid] ||= []).push({
      id: f.id,
      fingerprint: f.fingerprint,
      job: f.job,
      fitScore: f.fit_score,
      fitSummary: f.fit_summary,
      fitReasons: f.fit_reasons,
      status: f.status,
      foundAt: f.found_at,
    });
  }
  return byAgent;
}

async function handleGet(userId: string) {
  const agents = await loadAgents(userId);
  const byAgent = agents.length ? await loadFindingsByAgent(userId) : {};
  const tier = await planTier(userId);
  let totalNew = 0;
  const out = agents.map((a) => {
    const findings = (byAgent[a.id] || []).slice(0, FINDINGS_LIMIT);
    const newCount = findings.filter((f) => (f as { status?: string }).status === "new").length;
    totalNew += newCount;
    const exhausted = tier.scanQuota != null && (a.scan_count || 0) >= tier.scanQuota;
    return Object.assign(toClientAgent(a), { findings, newCount, exhausted });
  });
  return jsonResponse({
    ok: true,
    agents: out,
    limit: tier.agents,
    tier: tier.id,
    scanQuota: tier.scanQuota,   // null = unlimited; UI shows "N of quota" when set
    autoIntervalHours: Math.round(tier.intervalMs / HOUR),
    stats: { totalNew, agentCount: out.length },
  });
}

async function handleSave(userId: string, body: Record<string, unknown>) {
  const input = (body.agent && typeof body.agent === "object" ? body.agent : {}) as Record<string, unknown>;
  const agentId = str(input.id, 60);
  const targetTitles = strArr(input.targetTitles, 5);
  if (!targetTitles.length) {
    return errorResponse("Add at least one target job title.", 400);
  }

  const admin = getServiceClient();
  const tier = await planTier(userId);

  // Creating a NEW agent → enforce the per-tier agent cap.
  if (!agentId) {
    const { count } = await admin
      .from("job_scout_agents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if ((count || 0) >= tier.agents) {
      return errorResponse(
        tier.id === "free"
          ? "Free includes 1 Job Agent. Upgrade to run more (Pro 3, Career 5)."
          : `Your ${tier.id} plan includes ${tier.agents} agent${tier.agents === 1 ? "" : "s"}.` +
            (tier.id !== "career" ? " Upgrade for more." : ""),
        403,
      );
    }
  } else {
    const existing = await loadAgentById(agentId, userId);
    if (!existing) return errorResponse("Agent not found.", 404);
  }

  // Cadence is the user's on/off preference; the real auto-scan RATE is set by
  // the tier at run time. Free is always automatic (5h ×4 trial), so we never
  // store "manual" for it.
  const requestedCadence = oneOf(input.cadence, ["manual", "daily", "hourly"], "manual");
  let cadence = requestedCadence;
  if (tier.id === "free" && cadence === "manual") cadence = "daily";

  const fields = {
    name: str(input.name, 60) || "My Job Agent",
    target_titles: targetTitles,
    must_have_skills: strArr(input.mustHaveSkills, 10),
    exclude_keywords: strArr(input.excludeKeywords, 10),
    seniority: oneOf(input.seniority, ["any", "junior", "mid", "senior", "lead"], "any"),
    location: str(input.location, 100),
    location_strictness: oneOf(input.locationStrictness, ["strict", "balanced", "broad"], "balanced"),
    work_mode: oneOf(input.workMode, ["any", "remote", "onsite"], "any"),
    active: input.active !== false,
    cadence,
    updated_at: new Date().toISOString(),
  };

  let saved: AgentRow;
  if (agentId) {
    const { data, error } = await admin
      .from("job_scout_agents")
      .update(fields)
      .eq("id", agentId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) return errorResponse("agent save failed: " + error.message, 500);
    saved = data as AgentRow;
  } else {
    const { data, error } = await admin
      .from("job_scout_agents")
      .insert(Object.assign({ user_id: userId }, fields))
      .select("*")
      .single();
    if (error) return errorResponse("agent save failed: " + error.message, 500);
    saved = data as AgentRow;
  }

  // Notify prefs live in columns from migration 0050 — persist separately so
  // save still works if 0050 hasn't been applied (unknown-column error is
  // returned in the result, not thrown; we ignore it).
  const notifyPush = input.notifyPush !== false;
  const notifyEmail = input.notifyEmail !== false;
  await admin
    .from("job_scout_agents")
    .update({ notify_push: notifyPush, notify_email: notifyEmail })
    .eq("id", saved.id);

  const client = toClientAgent(saved);
  client.notifyPush = notifyPush;
  client.notifyEmail = notifyEmail;
  return jsonResponse({ ok: true, agent: client, cadenceClamped: requestedCadence !== cadence });
}

async function handleDelete(userId: string, body: Record<string, unknown>) {
  const agentId = str(body.agentId, 60);
  if (!agentId) return errorResponse("agentId is required.", 400);
  const existing = await loadAgentById(agentId, userId);
  if (!existing) return errorResponse("Agent not found.", 404);
  const admin = getServiceClient();
  // seen + findings cascade via FK ON DELETE CASCADE (migration 0049).
  const { error } = await admin.from("job_scout_agents").delete().eq("id", agentId).eq("user_id", userId);
  if (error) return errorResponse("agent delete failed: " + error.message, 500);
  return jsonResponse({ ok: true });
}

async function handleScan(userId: string, authHeader: string, body: Record<string, unknown>) {
  const agentId = str(body.agentId, 60);
  const agent = agentId ? await loadAgentById(agentId, userId) : (await loadAgents(userId))[0] || null;
  if (!agent) return errorResponse("Set up your Job Agent first.", 400);
  if (!agent.active) return errorResponse("This agent is paused — activate it to scan.", 400);
  const tier = await planTier(userId);
  if (tier.scanQuota != null && (agent.scan_count || 0) >= tier.scanQuota) {
    return errorResponse(
      `You've used all ${tier.scanQuota} free scans. Upgrade to keep your agent hunting for new roles.`,
      403,
    );
  }
  const out = await runScanCore(agent, { jwt: authHeader }, tier);
  return jsonResponse({ ok: true, agentId: agent.id, newCount: out.newCount, findings: out.findings, stats: out.stats });
}

// Bounded-concurrency map — keeps the Deep Scan fan-out from opening N
// simultaneous edge-function calls.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return out;
}

// One cheap LLM call → related job titles the candidate would also apply to.
// Tries providers in cost order, first one with a key AND quota wins — so a
// Gemini 429 (free-tier exhaustion) transparently falls back to Groq/Anthropic.
const EXPAND_PROVIDERS: Array<{ provider: LLMProvider; model: string }> = [
  { provider: "gemini", model: "gemini-2.0-flash" },
  { provider: "groq", model: "llama-3.3-70b-versatile" },
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "openai", model: "gpt-4o-mini" },
];

async function llmExpandTitles(primary: string, base: string[], skills: string[]): Promise<string[]> {
  const systemStable =
    "You expand a job title into closely-related job titles a candidate would ALSO apply to. " +
    "Return ONLY real, commonly-used titles for the SAME profession and a similar seniority — synonyms, " +
    "adjacent specializations, and common naming variants. Never invent titles, never drift to unrelated " +
    'fields, and do not repeat the input titles. Respond as JSON: {"titles": ["...", ...]} with at most 5 items.';
  const user =
    "Target title: " + primary +
    (base.length > 1 ? "\nAlso targeting: " + base.slice(1).join(", ") : "") +
    (skills.length ? "\nKey skills: " + skills.join(", ") : "");
  const outputSchema = {
    type: "object",
    properties: { titles: { type: "array", items: { type: "string" } } },
    required: ["titles"],
  };

  let lastErr = "";
  for (const { provider, model } of EXPAND_PROVIDERS) {
    if (!providerHasKey(provider)) continue;
    try {
      const res = await callProvider(provider, {
        systemStable,
        user,
        model,
        outputSchema,
        temperature: 0.2,
        maxTokens: 220,
        timeoutMs: 12_000,
      });
      const parsed = extractJson<{ titles?: unknown }>(res.text);
      const titles = Array.isArray(parsed.titles) ? parsed.titles : [];
      const out = titles.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 5);
      if (out.length) return out;
    } catch (e) {
      lastErr = provider + ": " + String((e as Error).message || e);
    }
  }
  if (lastErr) throw new Error(lastErr);
  return [];
}

// Deep Scan title set = the agent's own titles + AI-expanded relatives, deduped
// and capped. Cached 24h keyed on the title/skill set. Any failure degrades
// gracefully to just the agent's own titles (a normal scan).
async function expandTitles(agent: AgentRow, maxTitles: number): Promise<string[]> {
  const base = strArr(agent.target_titles, 5);
  // Deep Scan disabled for this tier (maxTitles <= 1) → just the agent's own
  // titles, no AI expansion.
  if (!base.length || maxTitles <= 1) return base.slice(0, Math.max(1, maxTitles));
  const skills = strArr(agent.must_have_skills, 6);

  let expansions: string[] = [];
  try {
    const cacheKey = await buildKvKey({
      v: "scout-title-expand-1",
      titles: base.map((s) => s.toLowerCase()).sort(),
      skills: skills.map((s) => s.toLowerCase()).sort(),
    });
    const cached = await readKvCache<string[]>("other", cacheKey);
    if (cached.payload && Array.isArray(cached.payload)) {
      expansions = cached.payload;
    } else {
      expansions = await llmExpandTitles(base[0], base, skills);
      if (expansions.length) {
        writeKvCache("other", cacheKey, expansions, TITLE_EXPAND_TTL_SECONDS).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[job-scout] title expansion failed:", String((e as Error).message || e).slice(0, 200));
    expansions = [];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...base, ...expansions]) {
    const k = t.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= Math.min(DEEP_SCAN_MAX_TITLES, maxTitles)) break;
  }
  return out;
}

// The scan pipeline shared by user-triggered scans (JWT auth) and cron scans
// (internal secret). Throws on hard failures; returns delivery stats.
async function runScanCore(agent: AgentRow, auth: ScanAuth, tierArg?: TierLimit): Promise<{
  newCount: number;
  findings: unknown[];
  stats: Record<string, unknown>;
  exhausted?: boolean;
}> {
  const userId = agent.user_id;
  const tier = tierArg || await planTier(userId);
  // Recency window: since the last run (+1 day slack), clamped to [1, 30];
  // first scan looks back 14 days.
  const sinceDays = agent.last_run_at
    ? Math.max(1, Math.min(30, daysSince(agent.last_run_at) + 1))
    : 14;

  const primaryTitle = (agent.target_titles && agent.target_titles[0]) || "";
  const baseFilters = {
    location: agent.location || "",
    locationStrictness: agent.location_strictness || "balanced",
    remoteOnly: agent.work_mode === "remote",
    postedWithinDays: sinceDays,
    sort: "newest",
  };
  const skills = agent.must_have_skills || [];

  // DEEP SCAN: AI-expand the target titles into the whole family of related
  // roles ("Fire Engineer" → fire protection / safety / sprinkler engineer…),
  // then fan out the 10-board aggregator across each. external-search (LinkedIn/
  // Indeed via Google/JSearch) and companies-search stay single-query to protect
  // their tight quotas. Expansion is cached 24h, so it's ~one LLM call per
  // unique title-set, not per scan.
  const searchTitles = await expandTitles(agent, tier.deepTitles);

  const buildPayload = (title: string) => ({
    query: title,
    filters: baseFilters,
    nlq: {
      keywords: [title, ...skills].slice(0, 12),
      location: agent.location || null,
      remote: agent.work_mode === "remote",
    },
  });
  const primaryPayload = buildPayload(primaryTitle || (searchTitles[0] || ""));

  // jobs-search fan-out (bounded concurrency) + one companies. external-search
  // (LinkedIn/Indeed via Google/JSearch) is a Pro+ perk.
  const coreRuns = await mapWithConcurrency(
    searchTitles,
    DEEP_SCAN_CONCURRENCY,
    (t) => callSearchFn("jobs-search", buildPayload(t), auth),
  );
  const [external, companies] = await Promise.all([
    tier.external
      ? callSearchFn("external-search", primaryPayload, auth)
      : Promise.resolve({ ok: true, jobs: [] as Record<string, unknown>[], error: undefined as string | undefined }),
    callSearchFn("companies-search", primaryPayload, auth),
  ]);
  const coreJobs = coreRuns.flatMap((r) => r.jobs);
  const coreOk = coreRuns.some((r) => r.ok);
  const laneStats = {
    core: { ok: coreOk, count: coreJobs.length, titles: searchTitles.length },
    external: { ok: external.ok, count: external.jobs.length, error: external.error },
    companies: { ok: companies.ok, count: companies.jobs.length, error: companies.error },
    deepScan: searchTitles.length > 1,
    titlesSearched: searchTitles,
  };

  // Merge → compact → exclusion filter → in-batch dedupe by fingerprint.
  const excludes = (agent.exclude_keywords || []).map((x) => x.toLowerCase()).filter(Boolean);
  const byFp = new Map<string, ScoutJob>();
  for (const raw of [...coreJobs, ...external.jobs, ...companies.jobs]) {
    const job = compactJob(raw);
    if (!job.title || !job.url) continue;
    const text = (job.title + " " + job.descriptionText).toLowerCase();
    if (excludes.some((x) => text.includes(x))) continue;
    const fp = fingerprintFor(job);
    if (!byFp.has(fp)) byFp.set(fp, job);
  }
  const fetched = byFp.size;

  // Delta: drop fingerprints this agent has already surfaced.
  const admin = getServiceClient();
  const fps = Array.from(byFp.keys());
  const seen = new Set<string>();
  for (let i = 0; i < fps.length; i += 200) {
    const chunk = fps.slice(i, i + 200);
    const { data, error } = await admin
      .from("job_scout_seen")
      .select("fingerprint")
      .eq("agent_id", agent.id)
      .in("fingerprint", chunk);
    if (error) throw new Error("seen lookup failed: " + error.message);
    (data || []).forEach((r: { fingerprint: string }) => seen.add(r.fingerprint));
  }

  const cap = Math.max(1, Math.min(MAX_PER_SCAN_CAP, tier.maxPerScan, agent.max_per_scan || 30));
  const fresh = fps
    .filter((fp) => !seen.has(fp))
    .map((fp) => ({ fp, job: byFp.get(fp) as ScoutJob }))
    .sort((a, b) => (Date.parse(b.job.postedAt) || 0) - (Date.parse(a.job.postedAt) || 0))
    .slice(0, cap);

  let delivered: unknown[] = [];
  if (fresh.length) {
    const findingRows = fresh.map(({ fp, job }) => ({
      agent_id: agent.id,
      user_id: userId,
      fingerprint: fp,
      job,
      status: "new",
    }));
    const { data, error } = await admin
      .from("job_scout_findings")
      .upsert(findingRows, { onConflict: "agent_id,fingerprint", ignoreDuplicates: true })
      .select("id, fingerprint, job, fit_score, status, found_at");
    if (error) throw new Error("findings insert failed: " + error.message);
    delivered = (data || []).map((f: Record<string, unknown>) => ({
      id: f.id,
      fingerprint: f.fingerprint,
      job: f.job,
      fitScore: f.fit_score,
      status: f.status,
      foundAt: f.found_at,
    }));

    const seenRows = fresh.map(({ fp }) => ({ agent_id: agent.id, fingerprint: fp }));
    const { error: seenErr } = await admin
      .from("job_scout_seen")
      .upsert(seenRows, { onConflict: "agent_id,fingerprint", ignoreDuplicates: true });
    if (seenErr) console.error("[job-scout] seen insert failed:", seenErr.message);
  }

  // This scan counts against the tier quota (free trial = 4).
  const newScanCount = (agent.scan_count || 0) + 1;
  const quotaExhausted = tier.scanQuota != null && newScanCount >= tier.scanQuota;

  const stats = {
    fetched,
    newCount: delivered.length,
    sinceDays,
    deepScan: searchTitles.length > 1,
    titlesSearched: searchTitles,
    tier: tier.id,
    scanCount: newScanCount,
    scanQuota: tier.scanQuota,
    lanes: laneStats,
    trigger: auth.cronSecret ? "cron" : "manual",
    ranAt: new Date().toISOString(),
  };
  const nowIso = new Date().toISOString();
  // Existing columns — always safe to write.
  const agentUpdate: Record<string, unknown> = { last_run_at: nowIso, last_run_stats: stats };
  if (quotaExhausted) agentUpdate.active = false; // free trial used up → stop auto-scanning

  // Notify on SCHEDULED runs that delivered (a manual "Scan now" means the user
  // is already looking). Best-effort — a failure never affects the scan.
  if (auth.cronSecret && delivered.length > 0) {
    try {
      const notified = await notifyUser(agent, delivered as DeliveredFinding[]);
      if (notified) agentUpdate.last_notified_at = nowIso;
    } catch (e) {
      console.error("[job-scout] notify failed for agent", agent.id, String((e as Error).message || e));
    }
  }
  await admin.from("job_scout_agents").update(agentUpdate).eq("id", agent.id);

  // Trial-counter columns live in migration 0052 — write them SEPARATELY so the
  // scan still works if 0052 hasn't been applied (unknown-column error comes
  // back in the result, not as a throw; we ignore it). Pre-0052 free is simply
  // uncounted (effectively unlimited) until the columns exist.
  const trialUpdate: Record<string, unknown> = { scan_count: newScanCount };
  if (quotaExhausted && !agent.upsell_sent) trialUpdate.upsell_sent = true;
  await admin.from("job_scout_agents").update(trialUpdate).eq("id", agent.id);

  if (quotaExhausted && !agent.upsell_sent) {
    try { await sendUpsell(agent); } catch (_e) { /* best-effort */ }
  }

  return { newCount: delivered.length, findings: delivered, stats, exhausted: quotaExhausted };
}

interface DeliveredFinding { id: string; job: ScoutJob; }

const SITE = (Deno.env.get("SITE_URL") || "https://www.careerboost.co.za").replace(/\/+$/, "");
const FN_BASE = () => `${Deno.env.get("SUPABASE_URL") || ""}/functions/v1`;

// Deliver "your agent found N roles" via the channels the user left enabled.
// Returns true if at least one channel was attempted.
async function notifyUser(agent: AgentRow, delivered: DeliveredFinding[]): Promise<boolean> {
  const n = delivered.length;
  const top = delivered[0]?.job?.title || "a new role";
  const headline = `${n} new ${n === 1 ? "role" : "roles"} for ${agent.name}`;
  let attempted = false;

  // ---- PWA push (best-effort) --------------------------------------------
  if (agent.notify_push) {
    const secret = cronSecretFromEnv();
    if (secret) {
      attempted = true;
      try {
        await fetch(`${FN_BASE()}/push-send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Cron-Secret": secret },
          body: JSON.stringify({
            action: "send",
            segment: "users",
            userIds: [agent.user_id],
            title: "Your Job Agent found " + n + (n === 1 ? " new role" : " new roles"),
            body: n === 1 ? String(top).slice(0, 120) : `${top} + ${n - 1} more — tap to review.`,
            url: "/#/dashboard",
            tag: "job-scout",
          }),
        });
      } catch (e) {
        console.error("[job-scout] push-send failed:", String((e as Error).message || e));
      }
    }
  }

  // ---- Email digest (best-effort, compliant) ------------------------------
  if (agent.notify_email && resendConfigured()) {
    try {
      const admin = getServiceClient();
      const { data: prof } = await admin
        .from("profiles")
        .select("email, email_unsub_token")
        .eq("user_id", agent.user_id)
        .maybeSingle();
      const email = (prof as { email?: string } | null)?.email || "";
      if (email) {
        // Respect global email opt-outs.
        const { data: supp } = await admin
          .from("email_suppressions")
          .select("email")
          .eq("email", email.toLowerCase())
          .maybeSingle();
        if (!supp) {
          let token = (prof as { email_unsub_token?: string } | null)?.email_unsub_token || "";
          if (!token) {
            token = crypto.randomUUID().replace(/-/g, "");
            await admin.from("profiles").update({ email_unsub_token: token }).eq("user_id", agent.user_id);
          }
          const unsubUrl = `${FN_BASE()}/email-unsubscribe?u=${encodeURIComponent(agent.user_id)}&k=${encodeURIComponent(token)}`;
          attempted = true;
          const res = await sendEmail({
            to: email,
            subject: headline,
            html: buildDigestHtml(agent, delivered, unsubUrl),
            headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
            tags: [{ name: "type", value: "job-scout-digest" }],
          });
          if (res.ok) {
            await admin.from("admin_email_log").insert({
              user_id: agent.user_id,
              email,
              kind: "job_scout_digest",
              resend_message_id: res.id,
            }).then(() => {}, () => {}); // log table shape may vary; never fail the send
          }
        }
      }
    } catch (e) {
      console.error("[job-scout] email digest failed:", String((e as Error).message || e));
    }
  }

  return attempted;
}

// One-time "your free trial is used up" nudge (push + email), best-effort.
async function sendUpsell(agent: AgentRow): Promise<void> {
  const title = "Your free Job Agent scans are used up";
  const line = "Upgrade to keep " + agent.name + " hunting for new roles automatically.";
  const secret = cronSecretFromEnv();
  if (secret) {
    try {
      await fetch(`${FN_BASE()}/push-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cron-Secret": secret },
        body: JSON.stringify({
          action: "send", segment: "users", userIds: [agent.user_id],
          title, body: line, url: "/#/dashboard", tag: "job-scout-upsell",
        }),
      });
    } catch { /* ignore */ }
  }
  if (!resendConfigured()) return;
  try {
    const admin = getServiceClient();
    const { data: prof } = await admin.from("profiles").select("email, email_unsub_token").eq("user_id", agent.user_id).maybeSingle();
    const email = (prof as { email?: string } | null)?.email || "";
    if (!email) return;
    const { data: supp } = await admin.from("email_suppressions").select("email").eq("email", email.toLowerCase()).maybeSingle();
    if (supp) return;
    let token = (prof as { email_unsub_token?: string } | null)?.email_unsub_token || "";
    if (!token) { token = crypto.randomUUID().replace(/-/g, ""); await admin.from("profiles").update({ email_unsub_token: token }).eq("user_id", agent.user_id); }
    const unsubUrl = `${FN_BASE()}/email-unsubscribe?u=${encodeURIComponent(agent.user_id)}&k=${encodeURIComponent(token)}`;
    const dash = SITE + "/#/dashboard";
    const html =
      '<div style="background:#0a0d1a;padding:28px 0;font-family:Inter,Arial,sans-serif;">' +
        '<div style="max-width:520px;margin:0 auto;background:#0f1424;border:1px solid #1c2136;border-radius:16px;padding:26px;">' +
          '<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#22e3ff;font-weight:700;">CareerBoost · Job Agent</div>' +
          '<h1 style="color:#e9ecf8;font-size:21px;margin:8px 0 6px;">You’ve seen what your agent can do</h1>' +
          '<p style="color:#8d94ab;font-size:14px;line-height:1.55;margin:0 0 16px;">Your free agent ran its 4 scans and surfaced brand-new roles for you. Upgrade and it keeps hunting automatically — more agents, faster scans, LinkedIn &amp; Indeed coverage, and Deep Scan across every related title.</p>' +
          '<a href="' + escHtml(dash) + '" style="display:inline-block;background:linear-gradient(135deg,#22e3ff,#b06bff);color:#0a0d18;font-weight:700;font-size:14px;text-decoration:none;padding:11px 20px;border-radius:10px;">Upgrade &amp; keep hunting →</a>' +
          '<p style="color:#5a6179;font-size:12px;margin:22px 0 0;"><a href="' + escHtml(unsubUrl) + '" style="color:#5566aa;">Unsubscribe</a></p>' +
        "</div>" +
      "</div>";
    await sendEmail({
      to: email, subject: title, html,
      headers: { "List-Unsubscribe": `<${unsubUrl}>` },
      tags: [{ name: "type", value: "job-scout-upsell" }],
    });
  } catch { /* ignore */ }
}

function escHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildDigestHtml(agent: AgentRow, delivered: DeliveredFinding[], unsubUrl: string): string {
  const rows = delivered.slice(0, 6).map((f) => {
    const j = f.job || ({} as ScoutJob);
    const meta = [j.company, j.location].filter(Boolean).map(escHtml).join(" · ");
    return (
      '<tr><td style="padding:12px 0;border-bottom:1px solid #1c2136;">' +
        '<a href="' + escHtml(j.url || SITE) + '" style="color:#e9ecf8;font-weight:600;font-size:15px;text-decoration:none;">' + escHtml(j.title || "New role") + "</a>" +
        (meta ? '<div style="color:#8d94ab;font-size:13px;margin-top:3px;">' + meta + "</div>" : "") +
      "</td></tr>"
    );
  }).join("");
  const n = delivered.length;
  const dash = SITE + "/#/dashboard";
  return (
    '<div style="background:#0a0d1a;padding:28px 0;font-family:Inter,Arial,sans-serif;">' +
      '<div style="max-width:520px;margin:0 auto;background:#0f1424;border:1px solid #1c2136;border-radius:16px;padding:26px;">' +
        '<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#22e3ff;font-weight:700;">CareerBoost · Job Agent</div>' +
        '<h1 style="color:#e9ecf8;font-size:21px;margin:8px 0 4px;">Your agent found ' + n + " new " + (n === 1 ? "role" : "roles") + "</h1>" +
        '<p style="color:#8d94ab;font-size:14px;margin:0 0 16px;">Fresh matches for <strong style="color:#c9d0e6;">' + escHtml(agent.name) + "</strong> that you haven’t seen before.</p>" +
        '<table style="width:100%;border-collapse:collapse;">' + rows + "</table>" +
        '<a href="' + escHtml(dash) + '" style="display:inline-block;margin-top:20px;background:linear-gradient(135deg,#22e3ff,#b06bff);color:#0a0d18;font-weight:700;font-size:14px;text-decoration:none;padding:11px 20px;border-radius:10px;">Review in CareerBoost →</a>' +
        '<p style="color:#5a6179;font-size:12px;margin:22px 0 0;">You get these because your Job Agent’s email alerts are on. Turn them off in the agent settings, or <a href="' + escHtml(unsubUrl) + '" style="color:#5566aa;">unsubscribe</a>.</p>' +
      "</div>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Cron (Phase 2): secret-authenticated batch runner. Picks due agents by
// cadence + last_run_at (oldest first), enforces the paid gate for hourly at
// RUN time (plan changes apply instantly, no webhook wiring needed), and runs
// scans with bounded concurrency. Caps keep one tick well inside the edge
// runtime's wall clock: ≤10 agents × ~8s ÷ 3 workers ≈ 30s.
// ---------------------------------------------------------------------------

const CRON_PICK_LIMIT = 40;
const CRON_RUN_CAP = 10;
const CRON_CONCURRENCY = 3;

async function handleCron() {
  if ((Deno.env.get("JOB_SCOUT_DISABLED") || "").trim() === "1") {
    return jsonResponse({ ok: true, skipped: "JOB_SCOUT_DISABLED=1" });
  }
  const secret = cronSecretFromEnv();
  if (!secret) return errorResponse("Cron secret not configured on the server.", 503);

  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_agents")
    .select("*")
    .eq("active", true)
    .neq("cadence", "manual")
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(CRON_PICK_LIMIT);
  if (error) return errorResponse("cron pick failed: " + error.message, 500);

  // Resolve each candidate's tier, then keep the ones that are DUE at their
  // tier's auto-scan rate and haven't exhausted a scan quota (free trial).
  const now = Date.now();
  const due: Array<{ agent: AgentRow; tier: TierLimit }> = [];
  for (const a of ((data || []) as AgentRow[])) {
    if (due.length >= CRON_RUN_CAP) break;
    const tier = await planTier(a.user_id);
    if (tier.scanQuota != null && (a.scan_count || 0) >= tier.scanQuota) continue; // trial used up
    if (a.last_run_at && (now - Date.parse(a.last_run_at) < tier.intervalMs)) continue; // not due yet
    due.push({ agent: a, tier });
  }

  const results: Record<string, unknown>[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < due.length) {
      const { agent, tier } = due[cursor];
      cursor += 1;
      try {
        const out = await runScanCore(agent, { cronSecret: secret }, tier);
        results.push({ agentId: agent.id, newCount: out.newCount });
      } catch (e) {
        results.push({ agentId: agent.id, error: String((e as Error).message || e).slice(0, 200) });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CRON_CONCURRENCY, due.length) }, () => worker()),
  );

  return jsonResponse({
    ok: true,
    considered: due.length,
    ran: results.length,
    results,
  });
}

// ---------------------------------------------------------------------------
// Weekly report (Phase 4b): secret-authed. Emails each user a recap of every
// role their agents surfaced in the past 7 days. Gated on the user having at
// least one agent with email alerts on; respects email_suppressions + unsub.
// ---------------------------------------------------------------------------
const WEEKLY_MAX_USERS = 300;
const WEEKLY_JOBS_PER_EMAIL = 8;

async function handleWeeklyReport(dryRun: boolean) {
  if ((Deno.env.get("JOB_SCOUT_DISABLED") || "").trim() === "1") {
    return jsonResponse({ ok: true, skipped: "JOB_SCOUT_DISABLED=1" });
  }
  if (!resendConfigured()) {
    return jsonResponse({ ok: true, skipped: "Resend not configured", users: 0, sent: 0 });
  }
  const admin = getServiceClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: rows, error } = await admin
    .from("job_scout_findings")
    .select("user_id, job, found_at")
    .gte("found_at", since)
    .order("found_at", { ascending: false })
    .limit(6000);
  if (error) return errorResponse("weekly findings query failed: " + error.message, 500);

  // Aggregate per user (keep the newest N jobs + total count).
  const byUser = new Map<string, { jobs: ScoutJob[]; count: number }>();
  for (const r of (rows || []) as Record<string, unknown>[]) {
    const uid = String(r.user_id);
    const agg = byUser.get(uid) || { jobs: [], count: 0 };
    agg.count += 1;
    if (agg.jobs.length < WEEKLY_JOBS_PER_EMAIL) agg.jobs.push(compactJob((r.job || {}) as Record<string, unknown>));
    byUser.set(uid, agg);
  }

  let sent = 0;
  let eligible = 0;
  const users = Array.from(byUser.keys()).slice(0, WEEKLY_MAX_USERS);
  for (const userId of users) {
    // Only users who left email alerts on for at least one agent.
    const { data: ag } = await admin
      .from("job_scout_agents")
      .select("id")
      .eq("user_id", userId)
      .eq("notify_email", true)
      .limit(1);
    if (!ag || !ag.length) continue;

    const { data: prof } = await admin
      .from("profiles")
      .select("email, email_unsub_token")
      .eq("user_id", userId)
      .maybeSingle();
    const email = (prof as { email?: string } | null)?.email || "";
    if (!email) continue;

    const { data: supp } = await admin
      .from("email_suppressions")
      .select("email")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (supp) continue;

    eligible += 1;
    if (dryRun) continue;

    let token = (prof as { email_unsub_token?: string } | null)?.email_unsub_token || "";
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      await admin.from("profiles").update({ email_unsub_token: token }).eq("user_id", userId);
    }
    const unsubUrl = `${FN_BASE()}/email-unsubscribe?u=${encodeURIComponent(userId)}&k=${encodeURIComponent(token)}`;
    const agg = byUser.get(userId)!;
    try {
      const res = await sendEmail({
        to: email,
        subject: `Your week in jobs — ${agg.count} new ${agg.count === 1 ? "role" : "roles"}`,
        html: buildWeeklyHtml(agg.jobs, agg.count, unsubUrl),
        headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        tags: [{ name: "type", value: "job-scout-weekly" }],
      });
      if (res.ok) sent += 1;
    } catch (e) {
      console.error("[job-scout] weekly send failed:", String((e as Error).message || e));
    }
  }

  return jsonResponse({ ok: true, dryRun, usersWithFinds: byUser.size, eligible, sent });
}

function buildWeeklyHtml(jobs: ScoutJob[], total: number, unsubUrl: string): string {
  const rows = jobs.map((j) => {
    const meta = [j.company, j.location].filter(Boolean).map(escHtml).join(" · ");
    return (
      '<tr><td style="padding:12px 0;border-bottom:1px solid #1c2136;">' +
        '<a href="' + escHtml(j.url || SITE) + '" style="color:#e9ecf8;font-weight:600;font-size:15px;text-decoration:none;">' + escHtml(j.title || "New role") + "</a>" +
        (meta ? '<div style="color:#8d94ab;font-size:13px;margin-top:3px;">' + meta + "</div>" : "") +
      "</td></tr>"
    );
  }).join("");
  const dash = SITE + "/#/dashboard";
  const extra = total > jobs.length ? `<p style="color:#8d94ab;font-size:13px;margin:10px 0 0;">…and ${total - jobs.length} more in your inbox.</p>` : "";
  return (
    '<div style="background:#0a0d1a;padding:28px 0;font-family:Inter,Arial,sans-serif;">' +
      '<div style="max-width:520px;margin:0 auto;background:#0f1424;border:1px solid #1c2136;border-radius:16px;padding:26px;">' +
        '<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#22e3ff;font-weight:700;">CareerBoost · Weekly agent report</div>' +
        '<h1 style="color:#e9ecf8;font-size:21px;margin:8px 0 4px;">Your agents found ' + total + " new " + (total === 1 ? "role" : "roles") + " this week</h1>" +
        '<p style="color:#8d94ab;font-size:14px;margin:0 0 16px;">Here are the freshest matches — every one is a job you hadn’t seen before.</p>' +
        '<table style="width:100%;border-collapse:collapse;">' + rows + "</table>" +
        extra +
        '<a href="' + escHtml(dash) + '" style="display:inline-block;margin-top:20px;background:linear-gradient(135deg,#22e3ff,#b06bff);color:#0a0d18;font-weight:700;font-size:14px;text-decoration:none;padding:11px 20px;border-radius:10px;">Review in CareerBoost →</a>' +
        '<p style="color:#5a6179;font-size:12px;margin:22px 0 0;">Weekly recap from your Job Agents. Turn off email in each agent’s settings, or <a href="' + escHtml(unsubUrl) + '" style="color:#5566aa;">unsubscribe</a>.</p>' +
      "</div>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Health-notify (admin ops): secret-authed. Checks all 4 AI providers + the
// Job Agent system and, if anything is critical, emails the admin. Runs daily.
// Deduped by the daily cadence; no-op (with a note) if ADMIN_ALERT_EMAIL unset.
// ---------------------------------------------------------------------------
// Active probe: ping every configured AI provider with a 1-token call so we
// catch dead keys / quota-429 EVEN when the ai-run fallback silently recovered
// them (those never land in ai_usage as failures). ~4 tiny calls/day.
const PROBE_PROVIDERS: Array<{ id: LLMProvider; model: string; label: string; topup: string }> = [
  { id: "gemini", model: "gemini-2.0-flash", label: "Google Gemini", topup: "https://aistudio.google.com/app/apikey" },
  { id: "openai", model: "gpt-4o-mini", label: "OpenAI", topup: "https://platform.openai.com/account/billing/overview" },
  { id: "groq", model: "llama-3.3-70b-versatile", label: "Groq", topup: "https://console.groq.com/keys" },
  { id: "anthropic", model: "claude-haiku-4-5", label: "Anthropic (Claude)", topup: "https://console.anthropic.com/settings/billing" },
];
async function probeProviders(): Promise<Array<{ id: string; label: string; status: string; topup: string; error?: string }>> {
  return await Promise.all(PROBE_PROVIDERS.map(async (p) => {
    if (!providerHasKey(p.id)) return { id: p.id, label: p.label, status: "no-key", topup: p.topup };
    try {
      // "json" in the prompt keeps Groq happy (it requires it when a JSON
      // response_format is in play) without affecting the other providers.
      await callProvider(p.id, { systemStable: 'Health probe — reply with this JSON: {"ok":true}', user: "ping (respond in json)", model: p.model, maxTokens: 12, timeoutMs: 10_000 });
      return { id: p.id, label: p.label, status: "healthy", topup: p.topup };
    } catch (e) {
      const msg = String((e as Error).message || e);
      let status = "errors";
      if (/credit|billing|payment|insufficient|out of credit|quota.*(exceed|exhaust)|exceed.*quota/i.test(msg)) status = "credit";
      else if (/invalid.{0,20}api.?key|unauthorized|\b401\b|authentication|permission_denied|expired.*key/i.test(msg)) status = "key";
      else if (/rate.?limit|\b429\b|too many requests|overloaded/i.test(msg)) status = "rate";
      // A 400 that isn't auth/quota/rate means the key reached the API and got a
      // validation error → the provider is UP. Don't false-alarm on it.
      else if (/\b400\b|invalid.?request|response_format|must contain/i.test(msg)) status = "healthy";
      return { id: p.id, label: p.label, status, topup: p.topup, error: msg.slice(0, 140) };
    }
  }));
}

async function handleHealthNotify(dryRun: boolean) {
  const probes = await probeProviders();
  let scout: Awaited<ReturnType<typeof getScoutHealth>> | null = null;
  try { scout = await getScoutHealth(); } catch { /* isolate */ }

  const alerts: Array<{ severity: string; title: string }> = [];
  // AI providers: dead key / out of credit = critical; 429 rate-limit = warning.
  for (const p of probes) {
    if (p.status === "credit" || p.status === "key") {
      alerts.push({ severity: "critical", title: `${p.label}: ${p.status === "credit" ? "out of credit / quota" : "invalid or expired key"} — fix at ${p.topup}` });
    } else if (p.status === "rate") {
      alerts.push({ severity: "warning", title: `${p.label}: rate-limited (429) right now.` });
    } else if (p.status === "errors") {
      alerts.push({ severity: "warning", title: `${p.label}: probe failed — ${p.error || "unknown error"}` });
    }
  }
  if (scout && scout.status === "critical") {
    scout.issues.forEach((i) => alerts.push({ severity: "critical", title: "Job Agent: " + i }));
  } else if (scout && scout.status === "warning") {
    scout.issues.forEach((i) => alerts.push({ severity: "warning", title: "Job Agent: " + i }));
  }

  const critical = alerts.filter((a) => a.severity === "critical").length;
  const adminEmail = (Deno.env.get("ADMIN_ALERT_EMAIL") || "").trim();

  let emailed = false;
  if (!dryRun && alerts.length && adminEmail && resendConfigured()) {
    try {
      const rows = alerts.map((a) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid #1c2136;color:${a.severity === "critical" ? "#ffb9c5" : "#ffd79a"};font-size:14px;">` +
        `<strong style="text-transform:uppercase;font-size:11px;letter-spacing:.06em;">${a.severity}</strong> · ${escHtml(a.title)}</td></tr>`
      ).join("");
      const html =
        '<div style="background:#0a0d1a;padding:28px 0;font-family:Inter,Arial,sans-serif;">' +
          '<div style="max-width:560px;margin:0 auto;background:#0f1424;border:1px solid #1c2136;border-radius:16px;padding:26px;">' +
            '<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#22e3ff;font-weight:700;">CareerBoost · System health</div>' +
            `<h1 style="color:#e9ecf8;font-size:20px;margin:8px 0 4px;">${critical ? "⚠ " + critical + " critical issue" + (critical === 1 ? "" : "s") : alerts.length + " issue" + (alerts.length === 1 ? "" : "s")} need${critical === 1 || (critical === 0 && alerts.length === 1) ? "s" : ""} attention</h1>` +
            '<p style="color:#8d94ab;font-size:13px;margin:0 0 14px;">Detected by the daily automated health check.</p>' +
            '<table style="width:100%;border-collapse:collapse;">' + rows + "</table>" +
            '<a href="' + escHtml(SITE) + '/#/admin" style="display:inline-block;margin-top:18px;background:linear-gradient(135deg,#22e3ff,#b06bff);color:#0a0d18;font-weight:700;font-size:14px;text-decoration:none;padding:10px 18px;border-radius:10px;">Open the Console →</a>' +
          "</div>" +
        "</div>";
      const res = await sendEmail({ to: adminEmail, subject: `CareerBoost health: ${critical ? critical + " critical" : alerts.length + " issue(s)"}`, html, tags: [{ name: "type", value: "admin-health-alert" }] });
      emailed = res.ok;
    } catch (e) {
      console.error("[job-scout] health-notify email failed:", String((e as Error).message || e));
    }
  }

  return jsonResponse({
    ok: true,
    dryRun,
    alerts,
    critical,
    emailed,
    adminEmailConfigured: !!adminEmail,
    providers: probes.map((p) => ({ id: p.id, status: p.status })),
    scout: scout ? { status: scout.status, activeAutoAgents: scout.activeAutoAgents, cronStaleHours: scout.cronStaleHours, findings7d: scout.findings7d } : null,
  });
}

async function handleUpdateFinding(userId: string, body: Record<string, unknown>) {
  const findingId = str(body.findingId, 60);
  if (!findingId) return errorResponse("findingId is required.", 400);

  const admin = getServiceClient();
  const { data: existing, error: loadErr } = await admin
    .from("job_scout_findings")
    .select("id, user_id")
    .eq("id", findingId)
    .maybeSingle();
  if (loadErr) return errorResponse("finding lookup failed: " + loadErr.message, 500);
  if (!existing || (existing as { user_id: string }).user_id !== userId) {
    return errorResponse("Finding not found.", 404);
  }

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    const status = oneOf(body.status, ["new", "saved", "applied", "dismissed"], "");
    if (!status) return errorResponse("Invalid status.", 400);
    patch.status = status;
  }
  if (body.fit && typeof body.fit === "object") {
    const fit = body.fit as Record<string, unknown>;
    const score = Number(fit.score);
    if (Number.isFinite(score)) patch.fit_score = Math.max(0, Math.min(100, Math.round(score)));
    if (fit.summary !== undefined) patch.fit_summary = str(fit.summary, 300);
    if (Array.isArray(fit.reasons)) patch.fit_reasons = strArr(fit.reasons, 6, 160);
  }
  if (!Object.keys(patch).length) return errorResponse("Nothing to update.", 400);

  const { error } = await admin
    .from("job_scout_findings")
    .update(patch)
    .eq("id", findingId);
  if (error) return errorResponse("finding update failed: " + error.message, 500);
  return jsonResponse({ ok: true });
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const action = str(body.action, 30);

  // Cron + weekly-report authenticate with the shared secret (schedulers have
  // no user session).
  if (action === "cron" || action === "weekly-report" || action === "health-notify") {
    const secret = cronSecretFromEnv();
    const provided = (req.headers.get("X-Cron-Secret") || "").trim();
    if (!secret || provided !== secret) return errorResponse("Unauthorized", 401);
    try {
      if (action === "cron") return await handleCron();
      if (action === "weekly-report") return await handleWeeklyReport(body.dryRun === true);
      return await handleHealthNotify(body.dryRun === true);
    } catch (err) {
      return errorResponse(String((err as Error).message || "job-scout " + action + " failed"), 500);
    }
  }

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }
  try {
    if (action === "get") return await handleGet(user.id);
    if (action === "save") return await handleSave(user.id, body);
    if (action === "scan") return await handleScan(user.id, req.headers.get("Authorization") || "", body);
    if (action === "delete") return await handleDelete(user.id, body);
    if (action === "update-finding") return await handleUpdateFinding(user.id, body);
    return errorResponse(`Unknown action "${action}". Use get | save | scan | delete | update-finding.`, 400);
  } catch (err) {
    return errorResponse(String((err as Error).message || "job-scout failed"), 500);
  }
}));
