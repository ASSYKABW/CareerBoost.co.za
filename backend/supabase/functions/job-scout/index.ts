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

const FINDINGS_LIMIT = 50;
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
  last_run_at: string | null;
  last_run_stats: Record<string, unknown> | null;
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

async function loadAgent(userId: string): Promise<AgentRow | null> {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_agents")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("agent load failed: " + error.message);
  return (data as AgentRow) || null;
}

async function loadFindings(userId: string) {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_findings")
    .select("id, fingerprint, job, fit_score, fit_summary, fit_reasons, status, found_at")
    .eq("user_id", userId)
    .neq("status", "dismissed")
    .order("found_at", { ascending: false })
    .limit(FINDINGS_LIMIT);
  if (error) throw new Error("findings load failed: " + error.message);
  return (data || []).map((f: Record<string, unknown>) => ({
    id: f.id,
    fingerprint: f.fingerprint,
    job: f.job,
    fitScore: f.fit_score,
    fitSummary: f.fit_summary,
    fitReasons: f.fit_reasons,
    status: f.status,
    foundAt: f.found_at,
  }));
}

async function handleGet(userId: string) {
  const agent = await loadAgent(userId);
  const findings = agent ? await loadFindings(userId) : [];
  const newCount = findings.filter((f) => f.status === "new").length;
  return jsonResponse({
    ok: true,
    agent: agent ? toClientAgent(agent) : null,
    findings,
    stats: { newCount },
  });
}

async function handleSave(userId: string, body: Record<string, unknown>) {
  const input = (body.agent && typeof body.agent === "object" ? body.agent : {}) as Record<string, unknown>;
  const targetTitles = strArr(input.targetTitles, 5);
  if (!targetTitles.length) {
    return errorResponse("Add at least one target job title.", 400);
  }
  // Cadence: hourly auto-scans are a paid perk — free plans clamp to daily.
  // Enforced again at cron run time, so a lapsed subscription downgrades
  // automatically without any webhook wiring.
  const requestedCadence = oneOf(input.cadence, ["manual", "daily", "hourly"], "manual");
  let cadence = requestedCadence;
  if (cadence === "hourly" && !(await isPaidUser(userId))) cadence = "daily";

  const row = {
    user_id: userId,
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
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_agents")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) return errorResponse("agent save failed: " + error.message, 500);
  return jsonResponse({
    ok: true,
    agent: toClientAgent(data as AgentRow),
    cadenceClamped: requestedCadence !== cadence,
  });
}

// Paid check: any active non-free subscription. Free users are clamped to the
// daily cadence; hourly auto-scans are a paid perk (agreed tiering).
async function isPaidUser(userId: string): Promise<boolean> {
  try {
    const admin = getServiceClient();
    const { data } = await admin
      .from("subscriptions")
      .select("plan_id, status")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { plan_id?: string; status?: string } | null;
    return !!row && row.status === "active" && !!row.plan_id && row.plan_id !== "free";
  } catch {
    return false; // fail closed: treat as free
  }
}

async function handleScan(userId: string, authHeader: string) {
  const agent = await loadAgent(userId);
  if (!agent) return errorResponse("Set up your Job Agent first.", 400);
  if (!agent.active) return errorResponse("This agent is paused — activate it to scan.", 400);
  const out = await runScanCore(agent, { jwt: authHeader });
  return jsonResponse({ ok: true, newCount: out.newCount, findings: out.findings, stats: out.stats });
}

// The scan pipeline shared by user-triggered scans (JWT auth) and cron scans
// (internal secret). Throws on hard failures; returns delivery stats.
async function runScanCore(agent: AgentRow, auth: ScanAuth): Promise<{
  newCount: number;
  findings: unknown[];
  stats: Record<string, unknown>;
}> {
  const userId = agent.user_id;
  // Recency window: since the last run (+1 day slack), clamped to [1, 30];
  // first scan looks back 14 days.
  const sinceDays = agent.last_run_at
    ? Math.max(1, Math.min(30, daysSince(agent.last_run_at) + 1))
    : 14;

  const primaryTitle = (agent.target_titles && agent.target_titles[0]) || "";
  const payload = {
    query: primaryTitle,
    filters: {
      location: agent.location || "",
      locationStrictness: agent.location_strictness || "balanced",
      remoteOnly: agent.work_mode === "remote",
      postedWithinDays: sinceDays,
      sort: "newest",
    },
    nlq: {
      keywords: [...(agent.target_titles || []), ...(agent.must_have_skills || [])].slice(0, 12),
      location: agent.location || null,
      remote: agent.work_mode === "remote",
    },
  };

  const [core, external, companies] = await Promise.all([
    callSearchFn("jobs-search", payload, auth),
    callSearchFn("external-search", payload, auth),
    callSearchFn("companies-search", payload, auth),
  ]);
  const laneStats = {
    core: { ok: core.ok, count: core.jobs.length, error: core.error },
    external: { ok: external.ok, count: external.jobs.length, error: external.error },
    companies: { ok: companies.ok, count: companies.jobs.length, error: companies.error },
  };

  // Merge → compact → exclusion filter → in-batch dedupe by fingerprint.
  const excludes = (agent.exclude_keywords || []).map((x) => x.toLowerCase()).filter(Boolean);
  const byFp = new Map<string, ScoutJob>();
  for (const raw of [...core.jobs, ...external.jobs, ...companies.jobs]) {
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

  const cap = Math.max(1, Math.min(MAX_PER_SCAN_CAP, agent.max_per_scan || 30));
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

  const stats = {
    fetched,
    newCount: delivered.length,
    sinceDays,
    lanes: laneStats,
    trigger: auth.cronSecret ? "cron" : "manual",
    ranAt: new Date().toISOString(),
  };
  await admin
    .from("job_scout_agents")
    .update({ last_run_at: new Date().toISOString(), last_run_stats: stats })
    .eq("id", agent.id);

  return { newCount: delivered.length, findings: delivered, stats };
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
// Slack below the nominal interval so a 30-min tick reliably catches hourly
// agents every hour and daily agents once a day.
const CADENCE_INTERVAL_MS: Record<string, number> = {
  hourly: 55 * 60 * 1000,
  daily: 23 * 60 * 60 * 1000,
};

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
    .in("cadence", ["hourly", "daily"])
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(CRON_PICK_LIMIT);
  if (error) return errorResponse("cron pick failed: " + error.message, 500);

  const now = Date.now();
  const candidates = ((data || []) as AgentRow[]).filter((a) => {
    const interval = CADENCE_INTERVAL_MS[a.cadence];
    if (!interval) return false;
    if (!a.last_run_at) return true;
    return now - Date.parse(a.last_run_at) >= interval;
  });

  const due: AgentRow[] = [];
  for (const a of candidates) {
    if (due.length >= CRON_RUN_CAP) break;
    if (a.cadence === "hourly" && !(await isPaidUser(a.user_id))) {
      // Free users run at most daily even if the row says hourly.
      const dailyDue = !a.last_run_at ||
        now - Date.parse(a.last_run_at) >= CADENCE_INTERVAL_MS.daily;
      if (!dailyDue) continue;
    }
    due.push(a);
  }

  const results: Record<string, unknown>[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < due.length) {
      const agent = due[cursor];
      cursor += 1;
      try {
        const out = await runScanCore(agent, { cronSecret: secret });
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
    considered: candidates.length,
    ran: results.length,
    results,
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

  // Cron authenticates with the shared secret (scheduler has no user session).
  if (action === "cron") {
    const secret = cronSecretFromEnv();
    const provided = (req.headers.get("X-Cron-Secret") || "").trim();
    if (!secret || provided !== secret) return errorResponse("Unauthorized", 401);
    try {
      return await handleCron();
    } catch (err) {
      return errorResponse(String((err as Error).message || "job-scout cron failed"), 500);
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
    if (action === "scan") return await handleScan(user.id, req.headers.get("Authorization") || "");
    if (action === "update-finding") return await handleUpdateFinding(user.id, body);
    return errorResponse(`Unknown action "${action}". Use get | save | scan | update-finding.`, 400);
  } catch (err) {
    return errorResponse(String((err as Error).message || "job-scout failed"), 500);
  }
}));
