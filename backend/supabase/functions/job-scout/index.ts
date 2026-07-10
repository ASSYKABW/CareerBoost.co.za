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

async function callSearchFn(
  name: string,
  payload: unknown,
  authHeader: string,
): Promise<{ ok: boolean; jobs: Record<string, unknown>[]; error?: string }> {
  const base = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FN_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/functions/v1/${name}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        apikey: anon,
      },
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
    updated_at: new Date().toISOString(),
  };
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("job_scout_agents")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) return errorResponse("agent save failed: " + error.message, 500);
  return jsonResponse({ ok: true, agent: toClientAgent(data as AgentRow) });
}

async function handleScan(userId: string, authHeader: string) {
  const agent = await loadAgent(userId);
  if (!agent) return errorResponse("Set up your Job Agent first.", 400);
  if (!agent.active) return errorResponse("This agent is paused — activate it to scan.", 400);

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
    callSearchFn("jobs-search", payload, authHeader),
    callSearchFn("external-search", payload, authHeader),
    callSearchFn("companies-search", payload, authHeader),
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
    if (error) return errorResponse("seen lookup failed: " + error.message, 500);
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
    if (error) return errorResponse("findings insert failed: " + error.message, 500);
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
    ranAt: new Date().toISOString(),
  };
  await admin
    .from("job_scout_agents")
    .update({ last_run_at: new Date().toISOString(), last_run_stats: stats })
    .eq("id", agent.id);

  return jsonResponse({ ok: true, newCount: delivered.length, findings: delivered, stats });
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

  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const action = str(body.action, 30);
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
