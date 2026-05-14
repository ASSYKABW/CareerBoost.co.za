// POST /functions/v1/admin-overview
// Admin-only operational overview for the CareerBoost console.
// Auth: Supabase user JWT, then protected app_metadata role verification.
// Reads with service role after the caller is verified as admin.
import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

type Stage = "saved" | "applied" | "interview" | "offer" | "rejected" | "withdrawn";
type AlertSeverity = "critical" | "warning" | "info";

interface AdminAlert {
  severity: AlertSeverity;
  title: string;
  body: string;
  action: string;
  section: string;
}

const STAGES: Stage[] = ["saved", "applied", "interview", "offer", "rejected", "withdrawn"];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MODULE_CATALOG: Array<{ id: string; label: string; recommendation: string }> = [
  { id: "job-search", label: "Job Search", recommendation: "Keep source trust, targeting constraints, and save-to-pipeline flow under close review." },
  { id: "pipeline", label: "Pipeline", recommendation: "Make next actions, stage movement, and job detail quality obvious for every saved role." },
  { id: "resume", label: "Resume Lab", recommendation: "Push users toward a ready base resume before they tailor applications." },
  { id: "cover-letter", label: "Cover Letters", recommendation: "Connect cover letters to saved roles and show quality/version progress." },
  { id: "interview", label: "Interview Prep", recommendation: "Surface interview prep after a role moves to applied or interview." },
  { id: "analytics", label: "Analytics", recommendation: "Turn scores into explainable next actions so users return to inspect progress." },
  { id: "settings", label: "Settings", recommendation: "Keep candidate settings simple and hide developer/provider configuration." },
];
const ADMIN_PRIVACY_CONTROLS = {
  exportScope: "Aggregated operational metrics only",
  excludedContent: ["resume bodies", "cover-letter text", "job descriptions", "raw documents", "API keys", "auth tokens"],
  allowedTelemetry: ["module", "route", "event name", "session timing", "device class", "provider/source labels", "workflow counts"],
  metadataMaxBytes: 4096,
  disallowedMetadataKeys: [
    "apiKey",
    "api_key",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "password",
    "secret",
    "resume",
    "cv",
    "coverLetter",
    "cover_letter",
    "jobDescription",
    "job_description",
    "description",
    "document",
    "rawText",
    "raw_text",
    "html",
  ],
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function n(value: unknown): number {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function hostFromUrl(url: string | null | undefined): string {
  try {
    return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sourceKey(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sourceLooksLikeHost(source: unknown, host: string): boolean {
  const key = sourceKey(source);
  const h = sourceKey(host);
  if (!key || !h) return true;
  const aliases: Record<string, string[]> = {
    adzuna: ["adzuna"],
    linkedin: ["linkedin"],
    indeed: ["indeed"],
    remotive: ["remotive"],
    reed: ["reed"],
    bebee: ["bebee"],
    jobmail: ["jobmail"],
    executiveplacements: ["executiveplacements"],
    builtin: ["builtin", "builtincom"],
    greenhouse: ["greenhouse"],
    lever: ["lever"],
  };
  const candidates = aliases[key] || [key];
  return candidates.some((candidate) => h.includes(candidate) || candidate.includes(h));
}

function latestDate(values: Array<unknown>): string | null {
  const dates = values
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  return dates.length ? new Date(dates[0]).toISOString() : null;
}

function daysSince(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / DAY_MS));
}

function addAlert(alerts: AdminAlert[], severity: AlertSeverity, title: string, body: string, action: string, section: string) {
  alerts.push({ severity, title, body, action, section });
}

function addFreshnessSignal(
  signals: Array<Record<string, unknown>>,
  area: string,
  status: string,
  latestAt: string | null,
  ageDays: number | null,
  action: string,
) {
  signals.push({ area, status, latestAt, ageDays, action });
}

function userIdSet(rows: Array<Record<string, unknown>>, predicate?: (row: Record<string, unknown>) => boolean): Set<string> {
  return new Set(rows
    .filter((row) => !predicate || predicate(row))
    .map((row) => String(row.user_id || ""))
    .filter(Boolean));
}

function unionSize(...sets: Array<Set<string>>): number {
  const out = new Set<string>();
  sets.forEach((set) => set.forEach((value) => out.add(value)));
  return out.size;
}

function inRange(value: unknown, start: number, end: number): boolean {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed >= start && parsed < end;
}

function weekStartMs(offsetWeeks: number): number {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(start).getUTCDay();
  const mondayDelta = (day + 6) % 7;
  return start - mondayDelta * DAY_MS - offsetWeeks * WEEK_MS;
}

function shortWeekLabel(ms: number): string {
  return new Date(ms).toISOString().slice(5, 10);
}

function isoDateKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysIso(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function roleListFromAppMetadata(meta: unknown): string[] {
  const appMeta = meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
  return []
    .concat(appMeta.role as never)
    .concat(appMeta.roles as never)
    .map((role) => String(role || "").toLowerCase().trim())
    .filter(Boolean);
}

async function safeCount(
  label: string,
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  warnings: string[],
): Promise<number> {
  const { count, error } = await query;
  if (error) {
    warnings.push(`${label}: ${error.message}`);
    return 0;
  }
  return typeof count === "number" ? count : 0;
}

/**
 * Phase B: read a pre-aggregated row set from a materialized view. Returns
 * the rows on success, or `null` on any error or empty result so the caller
 * can fall back to live aggregation. Adds a warning so we can see in the
 * diagnostics panel whether the MV path or the live-aggregation path
 * served this request.
 */
async function readMv<T extends Record<string, unknown>>(
  // deno-lint-ignore no-explicit-any
  svc: any,
  view: string,
  warnings: string[],
  options?: { order?: string; ascending?: boolean; limit?: number },
): Promise<T[] | null> {
  try {
    let query = svc.from(view).select("*");
    if (options?.order) {
      query = query.order(options.order, { ascending: options.ascending ?? true });
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }
    const { data, error } = await query;
    if (error) {
      warnings.push(`${view}: ${error.message} (falling back to live aggregation)`);
      return null;
    }
    if (!Array.isArray(data) || data.length === 0) {
      // Empty MV = pre-refresh state. Don't warn (this is fine on first deploy).
      return null;
    }
    return data as T[];
  } catch (err) {
    warnings.push(`${view}: ${(err as Error).message} (falling back to live aggregation)`);
    return null;
  }
}

function groupCount<T extends Record<string, unknown>>(rows: T[], key: keyof T): Record<string, number> {
  return rows.reduce<Record<string, number>>((out, row) => {
    const label = String(row[key] || "Unknown").trim() || "Unknown";
    out[label] = (out[label] || 0) + 1;
    return out;
  }, {});
}

function toRows(map: Record<string, number>): Array<{ label: string; count: number }> {
  return Object.keys(map)
    .map((label) => ({ label, count: map[label] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function avg(values: number[]): number {
  const nums = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function canonicalModule(value: unknown): string {
  const key = String(value || "")
    .toLowerCase()
    .replace(/^#\/?/, "")
    .replace(/^\//, "")
    .trim();
  if (!key) return "";
  if (key.includes("job-search") || key === "jobs" || key === "search" || key.includes("job search")) return "job-search";
  if (key.includes("pipeline") || key.includes("application")) return "pipeline";
  if (key.includes("resume")) return "resume";
  if (key.includes("cover")) return "cover-letter";
  if (key.includes("interview")) return "interview";
  if (key.includes("analytics")) return "analytics";
  if (key.includes("settings") || key.includes("setting")) return "settings";
  return key;
}

function moduleLabel(id: string): string {
  return MODULE_CATALOG.find((item) => item.id === id)?.label || id || "Unknown";
}

function intersectSet(base: Set<string>, next: Set<string>): Set<string> {
  const out = new Set<string>();
  base.forEach((value) => {
    if (next.has(value)) out.add(value);
  });
  return out;
}

function setUnion(...sets: Array<Set<string>>): Set<string> {
  const out = new Set<string>();
  sets.forEach((set) => set.forEach((value) => out.add(value)));
  return out;
}

function hasMeaningfulJson(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== "object") return Boolean(String(value || "").trim());
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).some((key) => {
    const item = obj[key];
    if (item == null) return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === "object") return Object.keys(item as Record<string, unknown>).length > 0;
    return Boolean(String(item || "").trim());
  });
}

function hasTailoredResumeAsset(row: Record<string, unknown>): boolean {
  const tailored = row.tailored;
  if (!tailored || typeof tailored !== "object") return false;
  const data = tailored as Record<string, unknown>;
  if (hasMeaningfulJson(data.result)) return true;
  if (Array.isArray(data.savedCVs) && data.savedCVs.length > 0) return true;
  if (Array.isArray(data.careerAssets) && data.careerAssets.length > 0) return true;
  return false;
}

function hasCoverLetterAsset(row: Record<string, unknown>): boolean {
  const result = row.last_result;
  if (!result || typeof result !== "object") return false;
  const data = result as Record<string, unknown>;
  if (hasMeaningfulJson(data.lastResult)) return true;
  if (Array.isArray(data.variants) && data.variants.length > 0) return true;
  if (Array.isArray(data.rolePacks) && data.rolePacks.length > 0) return true;
  return hasMeaningfulJson(result);
}

function buildFunnelStep(id: string, label: string, users: Set<string>, previous: Set<string> | null, total: number, action: string) {
  const count = users.size;
  const previousCount = previous ? previous.size : count;
  const dropOff = previous ? Math.max(0, previousCount - count) : 0;
  return {
    id,
    label,
    users: count,
    conversion: pct(count, Math.max(1, total)),
    stepConversion: previous ? pct(count, Math.max(1, previousCount)) : 100,
    dropOff,
    dropOffRate: previous ? pct(dropOff, Math.max(1, previousCount)) : 0,
    action,
  };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  const svc = getServiceClient();
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];
  const since30 = isoDaysAgo(30);
  const since120 = isoDaysAgo(120);
  const since7 = isoDaysAgo(7);

  const users: Array<Record<string, unknown>> = [];
  try {
    let page = 1;
    const perPage = 1000;
    for (;;) {
      const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const batch = (data?.users || []) as unknown as Array<Record<string, unknown>>;
      users.push(...batch);
      if (batch.length < perPage || users.length >= 5000) break;
      page += 1;
    }
  } catch (err) {
    warnings.push("auth.users: " + ((err as Error).message || "unable to list users"));
  }

  const [
    profileCount,
    applicationCount,
    savedJobCount,
    savedSearchCount,
    eventCount,
    upcomingEventCount,
    resumeCount,
    coverLetterCount,
    interviewSetCount,
    usageEventCount,
    usageSessionCount,
  ] = await Promise.all([
    safeCount("profiles", svc.from("profiles").select("user_id", { count: "exact", head: true }), warnings),
    safeCount("applications", svc.from("applications").select("id", { count: "exact", head: true }), warnings),
    safeCount("saved_jobs", svc.from("saved_jobs").select("id", { count: "exact", head: true }), warnings),
    safeCount("saved_searches", svc.from("saved_searches").select("id", { count: "exact", head: true }), warnings),
    safeCount("events", svc.from("events").select("id", { count: "exact", head: true }), warnings),
    safeCount("upcoming events", svc.from("events").select("id", { count: "exact", head: true }).gte("event_date", todayIsoDate()), warnings),
    safeCount("resumes", svc.from("resumes").select("user_id", { count: "exact", head: true }).neq("base_text", ""), warnings),
    safeCount("cover_letters", svc.from("cover_letters").select("user_id", { count: "exact", head: true }).not("last_result", "is", null), warnings),
    safeCount("interview_sets", svc.from("interview_sets").select("user_id", { count: "exact", head: true }).not("last_set", "is", null), warnings),
    safeCount("usage_events", svc.from("usage_events").select("id", { count: "exact", head: true }).gte("occurred_at", since30), warnings),
    safeCount("usage_sessions", svc.from("usage_sessions").select("session_id", { count: "exact", head: true }).gte("last_activity_at", since30), warnings),
  ]);

  const stageCounts: Record<Stage, number> = {
    saved: 0,
    applied: 0,
    interview: 0,
    offer: 0,
    rejected: 0,
    withdrawn: 0,
  };
  await Promise.all(STAGES.map(async (stage) => {
    stageCounts[stage] = await safeCount(
      `applications.${stage}`,
      svc.from("applications").select("id", { count: "exact", head: true }).eq("stage", stage),
      warnings,
    );
  }));

  const { data: appRows, error: appRowsError } = await svc
    .from("applications")
    .select("user_id, company, role, stage, source_url, updated_at, created_at, applied_at")
    .order("updated_at", { ascending: false })
    .limit(120);
  if (appRowsError) warnings.push("recent applications: " + appRowsError.message);

  const { data: savedRows, error: savedRowsError } = await svc
    .from("saved_jobs")
    .select("user_id, source, title, company, location, url, saved_at, payload")
    .order("saved_at", { ascending: false })
    .limit(1000);
  if (savedRowsError) warnings.push("saved job sources: " + savedRowsError.message);

  const { data: aiRows, error: aiRowsError } = await svc
    .from("ai_usage")
    .select("user_id, skill, provider, model, status, latency_ms, cost_usd, error, created_at")
    .gte("created_at", since30)
    .order("created_at", { ascending: false })
    .limit(1500);
  if (aiRowsError) warnings.push("ai_usage: " + aiRowsError.message);

  const { data: profileRows, error: profileRowsError } = await svc
    .from("profiles")
    .select("user_id, onboarding_completed, plan, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (profileRowsError) warnings.push("profiles.detail: " + profileRowsError.message);

  const { data: resumeRows, error: resumeRowsError } = await svc
    .from("resumes")
    .select("user_id, base_text, tailored, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (resumeRowsError) warnings.push("resumes.detail: " + resumeRowsError.message);

  const { data: coverRows, error: coverRowsError } = await svc
    .from("cover_letters")
    .select("user_id, last_result, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (coverRowsError) warnings.push("cover_letters.detail: " + coverRowsError.message);

  const { data: interviewRows, error: interviewRowsError } = await svc
    .from("interview_sets")
    .select("user_id, last_set, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (interviewRowsError) warnings.push("interview_sets.detail: " + interviewRowsError.message);

  const { data: savedSearchRows, error: savedSearchRowsError } = await svc
    .from("saved_searches")
    .select("user_id, name, query, last_run_at, last_count, created_at")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (savedSearchRowsError) warnings.push("saved_searches.detail: " + savedSearchRowsError.message);

  const { data: eventRows, error: eventRowsError } = await svc
    .from("events")
    .select("user_id, type, event_date, completed, created_at")
    .order("event_date", { ascending: false })
    .limit(1000);
  if (eventRowsError) warnings.push("events.detail: " + eventRowsError.message);

  const { data: usageRows, error: usageRowsError } = await svc
    .from("usage_events")
    .select("user_id, anonymous_id, event_name, event_category, module, route, session_id, source, occurred_at")
    .gte("occurred_at", since30)
    .order("occurred_at", { ascending: false })
    .limit(3000);
  if (usageRowsError) warnings.push("usage_events.detail: " + usageRowsError.message);

  const { data: usageSessionRows, error: usageSessionRowsError } = await svc
    .from("usage_sessions")
    .select("session_id, user_id, anonymous_id, source, started_at, last_activity_at, duration_seconds, route_count, event_count, entry_route, exit_route, routes, modules, device_type, browser, os, signed_in, started_in_preview, preview_mode")
    .gte("last_activity_at", since30)
    .order("last_activity_at", { ascending: false })
    .limit(3000);
  if (usageSessionRowsError) warnings.push("usage_sessions.detail: " + usageSessionRowsError.message);

  const { data: cohortSessionRows, error: cohortSessionRowsError } = await svc
    .from("usage_sessions")
    .select("session_id, user_id, started_at, last_activity_at, duration_seconds, route_count, event_count")
    .gte("last_activity_at", since120)
    .order("last_activity_at", { ascending: false })
    .limit(10000);
  if (cohortSessionRowsError) warnings.push("usage_sessions.cohorts: " + cohortSessionRowsError.message);

  // Phase B: pre-aggregated reads. Each MV is refreshed nightly by pg_cron
  // (see migration 0010); on cache miss we fall back to the live aggregation
  // below, so the dashboard never breaks.
  const [
    mvDailyActive,
    mvCohorts,
    mvSourceRollups,
    mvTopRoutes,
    mvTopModules,
  ] = await Promise.all([
    readMv<Record<string, unknown>>(svc, "mv_admin_daily_active",   warnings, { order: "day", ascending: true }),
    readMv<Record<string, unknown>>(svc, "mv_admin_weekly_cohorts", warnings, { order: "week_offset", ascending: true }),
    readMv<Record<string, unknown>>(svc, "mv_admin_source_rollups", warnings, { order: "count", ascending: false, limit: 25 }),
    readMv<Record<string, unknown>>(svc, "mv_admin_top_routes",     warnings, { order: "views", ascending: false, limit: 25 }),
    readMv<Record<string, unknown>>(svc, "mv_admin_top_modules",    warnings, { order: "events", ascending: false, limit: 25 }),
  ]);

  const recentApps = ((appRows || []) as Array<Record<string, unknown>>).slice(0, 8);
  const jobs = (savedRows || []) as Array<Record<string, unknown>>;
  const ai = (aiRows || []) as Array<Record<string, unknown>>;
  const profiles = (profileRows || []) as Array<Record<string, unknown>>;
  const resumes = (resumeRows || []) as Array<Record<string, unknown>>;
  const coverLetters = (coverRows || []) as Array<Record<string, unknown>>;
  const interviews = (interviewRows || []) as Array<Record<string, unknown>>;
  const savedSearches = (savedSearchRows || []) as Array<Record<string, unknown>>;
  const events = (eventRows || []) as Array<Record<string, unknown>>;
  const usageEvents = (usageRows || []) as Array<Record<string, unknown>>;
  const usageSessions = (usageSessionRows || []) as Array<Record<string, unknown>>;
  const cohortSessions = ((cohortSessionRows || usageSessionRows || []) as Array<Record<string, unknown>>)
    .filter((row) => String(row.user_id || "").trim());
  const usageActivityRows = usageSessions.length ? usageSessions : usageEvents;
  const usageTime = (row: Record<string, unknown>) => Date.parse(String(row.last_activity_at || row.occurred_at || row.started_at || ""));
  const usageActive1Users = userIdSet(usageActivityRows, (row) => {
    const at = usageTime(row);
    return Number.isFinite(at) && Date.now() - at <= DAY_MS;
  });
  const usageActive7Users = userIdSet(usageActivityRows, (row) => {
    const at = usageTime(row);
    return Number.isFinite(at) && Date.now() - at <= SEVEN_DAYS_MS;
  });
  const usageActive30Users = userIdSet(usageActivityRows, (row) => {
    const at = usageTime(row);
    return Number.isFinite(at) && Date.now() - at <= THIRTY_DAYS_MS;
  });
  const dailyActiveUsers = new Map<string, Set<string>>();
  const dailySessions = new Map<string, Set<string>>();
  usageActivityRows.forEach((row) => {
    const at = usageTime(row);
    if (!Number.isFinite(at) || Date.now() - at > THIRTY_DAYS_MS) return;
    const key = isoDateKeyFromMs(at);
    const actor = String(row.user_id || row.anonymous_id || row.session_id || "").trim();
    const session = String(row.session_id || actor).trim();
    if (actor) {
      if (!dailyActiveUsers.has(key)) dailyActiveUsers.set(key, new Set<string>());
      dailyActiveUsers.get(key)?.add(actor);
    }
    if (session) {
      if (!dailySessions.has(key)) dailySessions.set(key, new Set<string>());
      dailySessions.get(key)?.add(session);
    }
  });
  // Phase B: prefer the materialized view; fall back to in-memory aggregation.
  let dailyActive: Array<{ date: string; label: string; activeUsers: number; sessions: number; avg7: number }>;
  if (mvDailyActive && mvDailyActive.length) {
    dailyActive = mvDailyActive.map((row) => ({
      date:        String(row.day || "").slice(0, 10),
      label:       String(row.label || ""),
      activeUsers: Number(row.active_users || 0),
      sessions:    Number(row.sessions || 0),
      avg7:        0,
    }));
  } else {
    dailyActive = Array.from({ length: 30 }).map((_, index) => {
      const dayMs = Date.now() - (29 - index) * DAY_MS;
      const date = isoDateKeyFromMs(dayMs);
      return {
        date,
        label: date.slice(5),
        activeUsers: dailyActiveUsers.get(date)?.size || 0,
        sessions: dailySessions.get(date)?.size || 0,
        avg7: 0,
      };
    });
  }
  // 7-day rolling average is computed the same way whether the rows came
  // from the MV or the live aggregation.
  dailyActive.forEach((row, index) => {
    const window = dailyActive.slice(Math.max(0, index - 6), index + 1);
    row.avg7 = Number(avg(window.map((item) => item.activeUsers)).toFixed(1));
  });
  const usageEventSessionIds = new Set(usageEvents.map((row) => String(row.session_id || "")).filter(Boolean));
  const usageSessionIds = new Set(usageSessions.map((row) => String(row.session_id || "")).filter(Boolean));
  const activeSessionCount = usageSessionIds.size || usageEventSessionIds.size;
  const sessionDurations = usageSessions.map((row) => n(row.duration_seconds)).filter((value) => value > 0);
  const sessionRouteDepths = usageSessions.map((row) => Math.max(n(row.route_count), textArray(row.routes).length)).filter((value) => value > 0);
  const sessionEventDepths = usageSessions.map((row) => n(row.event_count)).filter((value) => value > 0);
  const avgSessionSeconds = Math.round(avg(sessionDurations));
  const avgRoutesPerSession = Number(avg(sessionRouteDepths).toFixed(1));
  const avgEventsPerSession = Number(avg(sessionEventDepths).toFixed(1));
  const routeMap: Record<string, number> = {};
  const moduleMap: Record<string, number> = {};
  usageSessions.forEach((row) => {
    textArray(row.routes).forEach((route) => { routeMap[route] = (routeMap[route] || 0) + 1; });
    textArray(row.modules).forEach((module) => {
      const label = moduleLabel(canonicalModule(module));
      moduleMap[label] = (moduleMap[label] || 0) + 1;
    });
  });
  usageEvents.forEach((row) => {
    if (row.event_name === "view_route" && row.route) routeMap[String(row.route)] = (routeMap[String(row.route)] || 0) + 1;
    if (row.module) {
      const label = moduleLabel(canonicalModule(row.module));
      moduleMap[label] = (moduleMap[label] || 0) + 1;
    }
  });
  // Phase B: prefer MV-precomputed top routes/modules; fall back to live agg.
  const topRoutes = (mvTopRoutes && mvTopRoutes.length)
    ? mvTopRoutes.slice(0, 8).map((row) => ({
        label: String(row.route || "Unknown"),
        count: Number(row.views || 0),
      }))
    : toRows(routeMap).slice(0, 8);
  const topModules = (mvTopModules && mvTopModules.length)
    ? mvTopModules.slice(0, 8).map((row) => ({
        label: moduleLabel(canonicalModule(String(row.module || ""))),
        count: Number(row.events || 0) + Number(row.sessions_touched || 0),
      }))
    : toRows(moduleMap).slice(0, 8);
  const sessionsByDevice = toRows(groupCount(usageSessions, "device_type")).filter((row) => row.label !== "Unknown").slice(0, 6);
  const sessionsByBrowser = toRows(groupCount(usageSessions, "browser")).filter((row) => row.label !== "Unknown").slice(0, 6);
  const sessionsByPreviewMode = toRows(groupCount(usageSessions, "preview_mode")).slice(0, 6);

  const signInActiveLast1 = users.filter((user) => {
    const last = Date.parse(String(user.last_sign_in_at || user.created_at || ""));
    return Number.isFinite(last) && Date.now() - last <= DAY_MS;
  }).length;
  const activeToday = Math.max(signInActiveLast1, usageActive1Users.size);
  const signInActiveLast7 = users.filter((user) => {
    const last = Date.parse(String(user.last_sign_in_at || user.created_at || ""));
    return Number.isFinite(last) && Date.now() - last <= SEVEN_DAYS_MS;
  }).length;
  const activeLast7 = Math.max(signInActiveLast7, usageActive7Users.size);
  const newUsers30 = users.filter((user) => {
    const created = Date.parse(String(user.created_at || ""));
    return Number.isFinite(created) && Date.now() - created <= THIRTY_DAYS_MS;
  }).length;
  const adminUsers = users.filter((user) => {
    const roles = roleListFromAppMetadata(user.app_metadata);
    return roles.some((role) => ["admin", "owner", "developer"].includes(role));
  }).length;

  const aiSuccess = ai.filter((row) => row.status === "success").length;
  const aiFailed = ai.filter((row) => row.status === "failed").length;
  const failureRate = pct(aiFailed, Math.max(1, ai.length));
  const aiCost = ai.reduce((sum, row) => sum + n(row.cost_usd), 0);
  const latencyRows = ai.filter((row) => n(row.latency_ms) > 0);
  const avgLatency = latencyRows.length
    ? Math.round(latencyRows.reduce((sum, row) => sum + n(row.latency_ms), 0) / latencyRows.length)
    : 0;
  const aiBySkill = toRows(groupCount(ai, "skill")).slice(0, 8).map((row) => {
    const skillRows = ai.filter((item) => String(item.skill || "Unknown") === row.label);
    const failed = skillRows.filter((item) => item.status === "failed").length;
    const costUsd = skillRows.reduce((sum, item) => sum + n(item.cost_usd), 0);
    return { ...row, failed, costUsd: Number(costUsd.toFixed(4)) };
  });

  // Phase B: prefer the materialized source-rollup view. Falls back to
  // in-memory aggregation from the 1000-row jobs slice when the MV is empty.
  const sourceRows = (mvSourceRollups && mvSourceRollups.length)
    ? mvSourceRollups.slice(0, 12).map((row) => ({
        label:       String(row.source || "Unknown"),
        count:       Number(row.count || 0),
        host:        hostFromUrl(String(row.latest_url || "")),
        lastSavedAt: row.last_saved_at || null,
      }))
    : toRows(groupCount(jobs, "source")).slice(0, 12).map((row) => {
        const latest = jobs.find((job) => String(job.source || "Unknown") === row.label);
        const url = latest ? String(latest.url || "") : "";
        return {
          ...row,
          host: hostFromUrl(url),
          lastSavedAt: latest ? latest.saved_at || null : null,
        };
      });

  const sourceIssues = jobs
    .map((job) => {
      const host = hostFromUrl(String(job.url || ""));
      const source = String(job.source || "Unknown").trim() || "Unknown";
      const payload = job.payload && typeof job.payload === "object" ? job.payload as Record<string, unknown> : {};
      return {
        source,
        host,
        title: job.title || payload.title || "Untitled job",
        company: job.company || payload.company || "",
        url: job.url || "",
        savedAt: job.saved_at || null,
        issue: host && !sourceLooksLikeHost(source, host) ? "Provider label does not match listing host" : "",
      };
    })
    .filter((row) => row.issue)
    .slice(0, 12);

  const sourceRowsWithDiagnostics = sourceRows.map((row) => {
    const issueCount = sourceIssues.filter((issue) => String(issue.source || "Unknown") === row.label).length;
    const age = daysSince(row.lastSavedAt);
    return {
      ...row,
      issueCount,
      issueRate: pct(issueCount, Math.max(1, row.count)),
      status: issueCount ? "review" : (age !== null && age > 7 ? "stale" : "healthy"),
    };
  });

  const recentApplications = recentApps.map((app) => ({
    company: app.company || "Company",
    role: app.role || "Role",
    stage: app.stage || "saved",
    sourceHost: hostFromUrl(String(app.source_url || "")),
    sourceUrl: app.source_url || "",
    updatedAt: app.updated_at || app.created_at || null,
  }));

  const recentFailures = ai
    .filter((row) => row.status === "failed")
    .slice(0, 8)
    .map((row) => ({
      skill: row.skill || "AI",
      provider: row.provider || "Unknown",
      model: row.model || "",
      error: row.error || "No error message recorded",
      at: row.created_at || null,
    }));

  const staleSavedRows = ((appRows || []) as Array<Record<string, unknown>>)
    .filter((row) => String(row.stage || "") === "saved" && (daysSince(row.updated_at || row.created_at) || 0) > 14)
    .slice(0, 8)
    .map((row) => ({
      company: row.company || "Company",
      role: row.role || "Role",
      updatedAt: row.updated_at || row.created_at || null,
      ageDays: daysSince(row.updated_at || row.created_at),
    }));

  const userWork = users
    .slice()
    .sort((a, b) => Date.parse(String(b.created_at || "")) - Date.parse(String(a.created_at || "")))
    .slice(0, 10)
    .map((user) => {
      const uid = String(user.id || "");
      const userApps = ((appRows || []) as Array<Record<string, unknown>>).filter((row) => String(row.user_id || "") === uid);
      const userJobs = jobs.filter((row) => String(row.user_id || "") === uid);
      const userAi = ai.filter((row) => String(row.user_id || "") === uid);
      const userUsage = usageEvents.filter((row) => String(row.user_id || "") === uid);
      const userSessions = usageSessions.filter((row) => String(row.user_id || "") === uid);
      const lastActivityAt = latestDate([
        user.last_sign_in_at,
        ...userApps.map((row) => row.updated_at || row.created_at),
        ...userJobs.map((row) => row.saved_at),
        ...userAi.map((row) => row.created_at),
        ...userUsage.map((row) => row.occurred_at),
        ...userSessions.map((row) => row.last_activity_at || row.started_at),
      ]);
      return {
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at,
        roles: roleListFromAppMetadata(user.app_metadata),
        pipelineCount: userApps.length,
        savedJobCount: userJobs.length,
        aiRequests: userAi.length,
        usageEvents: userUsage.length,
        sessions: userSessions.length,
        lastActivityAt,
      };
    });

  const allUserIds = new Set(users.map((user) => String(user.id || "")).filter(Boolean));
  const totalUserBase = Math.max(1, allUserIds.size || users.length);
  const onboardingUsers = userIdSet(profiles, (row) => Boolean(row.onboarding_completed));
  const completedProfileUsers = onboardingUsers;
  const resumeUsers = userIdSet(resumes, (row) => String(row.base_text || "").trim().length > 80 || hasMeaningfulJson(row.tailored));
  const coverLetterUsers = userIdSet(coverLetters, (row) => row.last_result != null);
  const tailoredResumeUsers = userIdSet(resumes, hasTailoredResumeAsset);
  const tailoredCoverLetterUsers = userIdSet(coverLetters, hasCoverLetterAsset);
  const tailoredAssetUsers = setUnion(tailoredResumeUsers, tailoredCoverLetterUsers);
  const interviewUsers = userIdSet(interviews, (row) => row.last_set != null);
  const savedSearchUsers = userIdSet(savedSearches, (row) => Boolean(row.last_run_at || row.query));
  const savedJobUsers = userIdSet(jobs);
  const pipelineUsers = userIdSet((appRows || []) as Array<Record<string, unknown>>);
  const appliedUsers = userIdSet((appRows || []) as Array<Record<string, unknown>>, (row) => String(row.stage || "") !== "saved");
  const signInActiveLast30 = users.filter((user) => {
    const last = Date.parse(String(user.last_sign_in_at || user.created_at || ""));
    return Number.isFinite(last) && Date.now() - last <= THIRTY_DAYS_MS;
  }).length;
  const activeLast30 = Math.max(signInActiveLast30, usageActive30Users.size);

  const supportAccounts = users.map((user) => {
    const uid = String(user.id || "");
    const userApps = ((appRows || []) as Array<Record<string, unknown>>).filter((row) => String(row.user_id || "") === uid);
    const userJobs = jobs.filter((row) => String(row.user_id || "") === uid);
    const userAiRows = ai.filter((row) => String(row.user_id || "") === uid);
    const userUsageRows = usageEvents.filter((row) => String(row.user_id || "") === uid);
    const userSessionRows = usageSessions.filter((row) => String(row.user_id || "") === uid);
    const userAiFailures = userAiRows.filter((row) => row.status === "failed").length;
    const userProfile = profiles.find((row) => String(row.user_id || "") === uid) || {};
    const hasResume = resumeUsers.has(uid);
    const hasCoverLetter = coverLetterUsers.has(uid);
    const hasInterview = interviewUsers.has(uid);
    const hasSavedSearch = savedSearchUsers.has(uid);
    const hasPipeline = userApps.length > 0;
    const hasApplied = userApps.some((row) => String(row.stage || "") !== "saved");
    const lastActivityAt = latestDate([
      user.last_sign_in_at,
      user.created_at,
      userProfile.updated_at,
      ...userApps.map((row) => row.updated_at || row.created_at),
      ...userJobs.map((row) => row.saved_at),
      ...userAiRows.map((row) => row.created_at),
      ...userUsageRows.map((row) => row.occurred_at),
      ...userSessionRows.map((row) => row.last_activity_at || row.started_at),
    ]);
    const inactiveDays = daysSince(lastActivityAt);
    const blockers: string[] = [];
    if (!Boolean(userProfile.onboarding_completed)) blockers.push("Onboarding not complete");
    if (!hasResume) blockers.push("Resume not ready");
    if (!hasSavedSearch && !userJobs.length && !hasPipeline) blockers.push("No job captured");
    if (hasPipeline && !hasApplied) blockers.push("Saved roles not moved forward");
    if (inactiveDays !== null && inactiveDays > 14) blockers.push("Inactive for 14+ days");
    if (userAiFailures) blockers.push("AI failures encountered");
    let health = 100;
    if (!Boolean(userProfile.onboarding_completed)) health -= 15;
    if (!hasResume) health -= 22;
    if (!hasSavedSearch && !userJobs.length && !hasPipeline) health -= 20;
    if (hasPipeline && !hasApplied) health -= 10;
    if (inactiveDays !== null && inactiveDays > 14) health -= 18;
    if (userAiFailures) health -= 10;
    health = Math.max(0, Math.min(100, health));
    const stage = !Boolean(userProfile.onboarding_completed)
      ? "onboarding"
      : !hasResume
        ? "resume-needed"
        : (!userJobs.length && !hasPipeline)
          ? "job-capture-needed"
          : hasPipeline && !hasApplied
            ? "saved-only"
            : hasInterview
              ? "interview-prep"
              : "progressing";
    const recommendedAction = blockers[0]
      ? `Help user resolve: ${blockers[0]}.`
      : "Keep monitoring; user is moving through the workflow.";
    return {
      id: uid,
      email: user.email || "No email",
      plan: userProfile.plan || "free",
      health,
      stage,
      blockers,
      recommendedAction,
      onboardingComplete: Boolean(userProfile.onboarding_completed),
      resumeReady: hasResume,
      coverLetterReady: hasCoverLetter,
      interviewReady: hasInterview,
      savedSearches: savedSearches.filter((row) => String(row.user_id || "") === uid).length,
      savedJobs: userJobs.length,
      pipeline: userApps.length,
      applied: userApps.filter((row) => String(row.stage || "") !== "saved").length,
      aiRequests: userAiRows.length,
      usageEvents: userUsageRows.length,
      sessions: userSessionRows.length,
      aiFailures: userAiFailures,
      inactiveDays,
      lastActivityAt,
    };
  }).sort((a, b) => a.health - b.health || (b.inactiveDays || 0) - (a.inactiveDays || 0)).slice(0, 25);

  const supportQueues = {
    atRisk: supportAccounts.filter((row) => row.health < 60).length,
    resumeNeeded: supportAccounts.filter((row) => !row.resumeReady).length,
    jobCaptureNeeded: supportAccounts.filter((row) => row.stage === "job-capture-needed").length,
    savedOnly: supportAccounts.filter((row) => row.stage === "saved-only").length,
    inactive: supportAccounts.filter((row) => (row.inactiveDays || 0) > 14).length,
    aiIssue: supportAccounts.filter((row) => row.aiFailures > 0).length,
  };
  const supportHealthAverage = supportAccounts.length
    ? Math.round(supportAccounts.reduce((sum, row) => sum + row.health, 0) / supportAccounts.length)
    : 0;
  const support = {
    summary: {
      monitoredAccounts: supportAccounts.length,
      averageHealth: supportHealthAverage,
      atRisk: supportQueues.atRisk,
      healthy: supportAccounts.filter((row) => row.health >= 75).length,
    },
    queues: supportQueues,
    accounts: supportAccounts,
    playbooks: [
      { id: "resume-needed", title: "Resume readiness follow-up", action: "Guide the user to Resume Lab and make the first export-ready resume the next action." },
      { id: "job-capture-needed", title: "First job capture follow-up", action: "Ask the user to run a focused search or install/use the extension capture flow." },
      { id: "saved-only", title: "Saved role conversion follow-up", action: "Prompt the user to tailor resume, create cover letter, and move one saved role to applied." },
      { id: "inactive", title: "Reactivation follow-up", action: "Send a short reactivation nudge with the user's most valuable next action." },
      { id: "ai-issue", title: "AI support follow-up", action: "Check failed AI calls and advise the user to retry after provider health is confirmed." },
    ],
    privacy: "Support health excludes resume, cover-letter, and interview document body text. It uses only workflow metadata and readiness flags.",
  };

  const firstJobUserSet = setUnion(savedJobUsers, pipelineUsers);
  const movedForwardUsers = appliedUsers;
  const activationSignedUp = allUserIds;
  const activationProfile = intersectSet(activationSignedUp, completedProfileUsers);
  const activationResume = intersectSet(activationProfile, resumeUsers);
  const activationFirstJob = intersectSet(activationResume, firstJobUserSet);
  const activationTailoredAsset = intersectSet(activationFirstJob, tailoredAssetUsers);
  const activationMovedForward = intersectSet(activationTailoredAsset, movedForwardUsers);
  const firstJobUsers = firstJobUserSet.size;
  const onboardingRate = pct(completedProfileUsers.size, totalUserBase);
  const resumeReadyRate = pct(resumeUsers.size, totalUserBase);
  const firstJobRate = pct(firstJobUserSet.size, totalUserBase);
  const tailoredAssetRate = pct(tailoredAssetUsers.size, totalUserBase);
  const appliedUserRate = pct(movedForwardUsers.size, totalUserBase);
  const activationScore = pct(activationMovedForward.size, totalUserBase);
  const activationFunnel = [
    buildFunnelStep("signed-up", "Signed up", activationSignedUp, null, totalUserBase, "Bring candidates into the workspace through signup."),
    buildFunnelStep("completed-profile", "Completed profile", activationProfile, activationSignedUp, totalUserBase, "Tighten onboarding so every candidate completes role, location, and preference data."),
    buildFunnelStep("resume-ready", "Resume ready", activationResume, activationProfile, totalUserBase, "Push users into Resume Lab until they have a usable base resume."),
    buildFunnelStep("first-job-saved", "First job saved", activationFirstJob, activationResume, totalUserBase, "Make job search, extension capture, and saved-role flow obvious after resume readiness."),
    buildFunnelStep("first-tailored-asset", "First tailored asset", activationTailoredAsset, activationFirstJob, totalUserBase, "Prompt users to tailor a resume or create a cover letter for the saved role."),
    buildFunnelStep("job-moved-forward", "Job moved forward", activationMovedForward, activationTailoredAsset, totalUserBase, "Move candidates from saved to applied/interview/offer after assets are ready."),
  ];
  const largestDropOff = activationFunnel
    .slice(1)
    .sort((a, b) => b.dropOffRate - a.dropOffRate || b.dropOff - a.dropOff)[0] || null;
  const activationBottlenecks = activationFunnel
    .slice(1)
    .filter((step) => step.dropOff > 0)
    .sort((a, b) => b.dropOffRate - a.dropOffRate || b.dropOff - a.dropOff)
    .slice(0, 4)
    .map((step) => ({
      label: `${step.label} drop-off`,
      value: step.stepConversion,
      dropOff: step.dropOff,
      dropOffRate: step.dropOffRate,
      action: step.action,
    }));

  const moduleRecordMetrics: Record<string, { users: number; records: number; adoption: number }> = {
    "job-search": {
      users: unionSize(savedSearchUsers, savedJobUsers),
      records: savedJobCount + savedSearchCount,
      adoption: pct(unionSize(savedSearchUsers, savedJobUsers), totalUserBase),
    },
    pipeline: {
      users: pipelineUsers.size,
      records: applicationCount,
      adoption: pct(pipelineUsers.size, totalUserBase),
    },
    resume: {
      users: resumeUsers.size,
      records: resumeCount,
      adoption: resumeReadyRate,
    },
    "cover-letter": {
      users: coverLetterUsers.size,
      records: coverLetterCount,
      adoption: pct(coverLetterUsers.size, totalUserBase),
    },
    interview: {
      users: interviewUsers.size,
      records: interviewSetCount,
      adoption: pct(interviewUsers.size, totalUserBase),
    },
    analytics: {
      users: 0,
      records: 0,
      adoption: 0,
    },
    settings: {
      users: 0,
      records: 0,
      adoption: 0,
    },
  };
  const hasUsageTelemetry = Boolean(usageEvents.length || usageSessions.length);
  const moduleEngagement = MODULE_CATALOG.map((module) => {
    const moduleEvents = usageEvents.filter((row) => canonicalModule(row.module || row.route || row.event_category) === module.id);
    const moduleViewEvents = moduleEvents.filter((row) => row.event_name === "view_route");
    const moduleSessions = usageSessions.filter((row) => {
      const sessionItems = [
        ...textArray(row.modules),
        ...textArray(row.routes),
        String(row.entry_route || ""),
        String(row.exit_route || ""),
      ];
      const sessionModules = new Set(sessionItems.map((item) => canonicalModule(item)).filter(Boolean));
      return sessionModules.has(module.id);
    });
    const activeUserSet = setUnion(userIdSet(moduleEvents), userIdSet(moduleSessions));
    const sessionIds = new Set(moduleSessions.map((row) => String(row.session_id || "")).filter(Boolean));
    moduleEvents
      .map((row) => String(row.session_id || ""))
      .filter(Boolean)
      .forEach((sessionId) => sessionIds.add(sessionId));
    const sessions = sessionIds.size;
    const avgModuleEventsPerSession = Number((moduleEvents.length / Math.max(1, sessions)).toFixed(1));
    const avgModuleDurationSeconds = Math.round(avg(moduleSessions.map((row) => n(row.duration_seconds))));
    const recordMetrics = moduleRecordMetrics[module.id] || { users: 0, records: 0, adoption: 0 };
    const adoption = pct(activeUserSet.size, totalUserBase);
    let status = "healthy";
    if (!hasUsageTelemetry) status = "waiting for telemetry";
    else if (!activeUserSet.size) status = "needs attention";
    else if (adoption < 20) status = "underused";
    else if (avgModuleEventsPerSession > 0 && avgModuleEventsPerSession < 2) status = "shallow usage";
    return {
      id: module.id,
      label: module.label,
      users: activeUserSet.size,
      activeUsers: activeUserSet.size,
      recordUsers: recordMetrics.users,
      records: recordMetrics.records,
      adoption,
      recordAdoption: recordMetrics.adoption,
      sessions,
      sessionShare: pct(sessions, Math.max(1, activeSessionCount)),
      views: moduleViewEvents.length,
      events: moduleEvents.length,
      avgEventsPerSession: avgModuleEventsPerSession,
      avgDurationSeconds: avgModuleDurationSeconds,
      lastActivityAt: latestDate(
        moduleEvents.map((row) => row.occurred_at)
          .concat(moduleSessions.map((row) => row.last_activity_at || row.started_at)),
      ),
      status,
      recommendation: status === "healthy"
        ? "Usage is visible. Keep watching depth, repeat sessions, and downstream conversion."
        : module.recommendation,
    };
  }).sort((a, b) => b.activeUsers - a.activeUsers || b.sessions - a.sessions || b.records - a.records);
  const modules = moduleEngagement;

  const cohorts = Array.from({ length: 6 }).map((_, index) => {
    const offset = 5 - index;
    const start = weekStartMs(offset);
    const end = start + WEEK_MS;
    const signups = users.filter((user) => inRange(user.created_at, start, end)).length;
    const cohortSessions = usageSessions.filter((session) => inRange(session.last_activity_at || session.started_at, start, end));
    const active = cohortSessions.length
      ? userIdSet(cohortSessions).size
      : users.filter((user) => inRange(user.last_sign_in_at || user.created_at, start, end)).length;
    const jobSaves = jobs.filter((job) => inRange(job.saved_at, start, end)).length;
    const aiCalls = ai.filter((row) => inRange(row.created_at, start, end)).length;
    return {
      week: shortWeekLabel(start),
      signups,
      active,
      sessions: cohortSessions.length,
      jobSaves,
      aiCalls,
      avgSessionMinutes: Number((avg(cohortSessions.map((session) => n(session.duration_seconds))) / 60).toFixed(1)),
      returnRate: pct(active, Math.max(1, signups)),
    };
  });
  const cohortReturnWeeks = [0, 1, 2, 3];
  // Phase B: MV-first cohort retention. The materialized view pre-computes
  // signup cohorts + W0..W3 active counts; here we just shape it into the
  // response format the frontend already consumes.
  function buildWeekRow(weekOffset: number, cohortStartMs: number, active: number, users: number) {
    const weekStart = cohortStartMs + weekOffset * WEEK_MS;
    const weekEnd = weekStart + WEEK_MS;
    const pending = weekStart > Date.now();
    const complete = weekEnd <= Date.now();
    const partial = weekStart <= Date.now() && weekEnd > Date.now();
    return {
      week: `W${weekOffset}`,
      weekOffset,
      start: new Date(weekStart).toISOString(),
      end: new Date(weekEnd).toISOString(),
      activeUsers: pending ? 0 : active,
      sessions: pending ? 0 : active, // best-effort from MV; live path computes real session count
      rate: pending || !users ? null : pct(active, users),
      complete,
      partial,
      pending,
    };
  }

  interface CohortWeek {
    week: string;
    weekOffset: number;
    start: string;
    end: string;
    activeUsers: number;
    sessions: number;
    rate: number | null;
    complete: boolean;
    partial: boolean;
    pending: boolean;
  }
  interface CohortRow {
    week: string;
    start: string;
    end: string;
    users: number;
    weeks: CohortWeek[];
    week0Retention: number | null | undefined;
    week1Retention: number | null | undefined;
    week2Retention: number | null | undefined;
    week3Retention: number | null | undefined;
  }
  let cohortRetention: CohortRow[];
  if (mvCohorts && mvCohorts.length) {
    cohortRetention = mvCohorts.map((row) => {
      const cohortStartMs = Date.parse(String(row.cohort_start || "")) || Date.now();
      const cohortEndMs = Date.parse(String(row.cohort_end || "")) || cohortStartMs + WEEK_MS;
      const usersCount = Number(row.users || 0);
      const weeks = [
        buildWeekRow(0, cohortStartMs, Number(row.w0_active || 0), usersCount),
        buildWeekRow(1, cohortStartMs, Number(row.w1_active || 0), usersCount),
        buildWeekRow(2, cohortStartMs, Number(row.w2_active || 0), usersCount),
        buildWeekRow(3, cohortStartMs, Number(row.w3_active || 0), usersCount),
      ];
      return {
        week: String(row.cohort_label || shortWeekLabel(cohortStartMs)),
        start: new Date(cohortStartMs).toISOString(),
        end: new Date(cohortEndMs).toISOString(),
        users: usersCount,
        weeks,
        week0Retention: weeks[0]?.rate,
        week1Retention: weeks[1]?.rate,
        week2Retention: weeks[2]?.rate,
        week3Retention: weeks[3]?.rate,
      };
    });
  } else {
    cohortRetention = Array.from({ length: 8 }).map((_, index) => {
      const offset = 7 - index;
      const start = weekStartMs(offset);
      const end = start + WEEK_MS;
      const cohortUsers = users.filter((user) => inRange(user.created_at, start, end));
      const cohortUserIds = new Set(cohortUsers.map((user) => String(user.id || "")).filter(Boolean));
      const weeks = cohortReturnWeeks.map((weekOffset) => {
        const weekStart = start + weekOffset * WEEK_MS;
        const weekEnd = weekStart + WEEK_MS;
        const pending = weekStart > Date.now();
        const complete = weekEnd <= Date.now();
        const partial = weekStart <= Date.now() && weekEnd > Date.now();
        const sessions = pending
          ? []
          : cohortSessions.filter((session) => {
            const uid = String(session.user_id || "");
            return cohortUserIds.has(uid) && inRange(session.last_activity_at || session.started_at, weekStart, weekEnd);
          });
        const activeUsers = pending ? 0 : userIdSet(sessions).size;
        return {
          week: `W${weekOffset}`,
          weekOffset,
          start: new Date(weekStart).toISOString(),
          end: new Date(weekEnd).toISOString(),
          activeUsers,
          sessions: sessions.length,
          rate: pending || !cohortUsers.length ? null : pct(activeUsers, cohortUsers.length),
          complete,
          partial,
          pending,
        };
      });
      return {
        week: shortWeekLabel(start),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        users: cohortUsers.length,
        weeks,
        week0Retention: weeks[0]?.rate,
        week1Retention: weeks[1]?.rate,
        week2Retention: weeks[2]?.rate,
        week3Retention: weeks[3]?.rate,
      };
    });
  }
  const maturedCohorts = cohortRetention.filter((row) => row.users > 0);
  const maturedWeek1 = maturedCohorts.filter((row) => row.weeks[1] && !row.weeks[1].pending && row.weeks[1].complete);
  const maturedWeek2 = maturedCohorts.filter((row) => row.weeks[2] && !row.weeks[2].pending && row.weeks[2].complete);
  const maturedWeek3 = maturedCohorts.filter((row) => row.weeks[3] && !row.weeks[3].pending && row.weeks[3].complete);
  const avgWeek1Retention = Math.round(avg(maturedWeek1.map((row) => Number(row.week1Retention || 0))));
  const avgWeek2Retention = Math.round(avg(maturedWeek2.map((row) => Number(row.week2Retention || 0))));
  const avgWeek3Retention = Math.round(avg(maturedWeek3.map((row) => Number(row.week3Retention || 0))));
  const bestCohort = maturedWeek1
    .slice()
    .sort((a, b) => Number(b.week1Retention || 0) - Number(a.week1Retention || 0) || b.users - a.users)[0] || null;
  const weakestCohort = maturedWeek1
    .slice()
    .sort((a, b) => Number(a.week1Retention || 0) - Number(b.week1Retention || 0) || b.users - a.users)[0] || null;
  const cohortSummary = {
    windowWeeks: 8,
    returnWeeks: cohortReturnWeeks.length,
    trackedSessions: cohortSessions.length,
    avgWeek1Retention,
    avgWeek2Retention,
    avgWeek3Retention,
    bestCohort: bestCohort ? { week: bestCohort.week, users: bestCohort.users, week1Retention: bestCohort.week1Retention } : null,
    weakestCohort: weakestCohort ? { week: weakestCohort.week, users: weakestCohort.users, week1Retention: weakestCohort.week1Retention } : null,
    habitSignal: avgWeek1Retention >= 45 ? "strong" : avgWeek1Retention >= 25 ? "developing" : "weak",
    note: "Signup cohorts are based on Supabase Auth created_at and returns are based on tracked usage sessions.",
  };

  const aiByProvider = toRows(groupCount(ai, "provider")).slice(0, 8).map((row) => {
    const providerRows = ai.filter((item) => String(item.provider || "Unknown") === row.label);
    const failed = providerRows.filter((item) => item.status === "failed").length;
    const latency = providerRows.filter((item) => n(item.latency_ms) > 0);
    const avgProviderLatency = latency.length
      ? Math.round(latency.reduce((sum, item) => sum + n(item.latency_ms), 0) / latency.length)
      : 0;
    const costUsd = providerRows.reduce((sum, item) => sum + n(item.cost_usd), 0);
    return {
      ...row,
      failed,
      failureRate: pct(failed, Math.max(1, row.count)),
      avgLatencyMs: avgProviderLatency,
      costUsd: Number(costUsd.toFixed(4)),
      status: failed ? "watch" : "healthy",
    };
  });

  const planRows = toRows(groupCount(profiles, "plan"));
  const qualityIssueRate = pct(sourceIssues.length, Math.max(1, jobs.length));
  const weakestModule = moduleEngagement.find((module) => !["healthy", "waiting for telemetry"].includes(module.status));
  const latestUsageEventAt = latestDate(usageEvents.map((row) => row.occurred_at));
  const latestUsageSessionAt = latestDate(usageSessions.map((row) => row.last_activity_at || row.started_at));
  const latestCohortSessionAt = latestDate(cohortSessions.map((row) => row.last_activity_at || row.started_at));
  const latestAiAt = latestDate(ai.map((row) => row.created_at));
  const latestProfileAt = latestDate(profiles.map((row) => row.updated_at || row.created_at));
  const latestSavedAt = latestDate(jobs.map((row) => row.saved_at));
  const usageEventAgeDays = daysSince(latestUsageEventAt);
  const usageSessionAgeDays = daysSince(latestUsageSessionAt);
  const cohortSessionAgeDays = daysSince(latestCohortSessionAt);
  const aiAgeDays = daysSince(latestAiAt);
  const profileAgeDays = daysSince(latestProfileAt);
  const latestSavedAge = daysSince(latestSavedAt);
  const freshnessSignals: Array<Record<string, unknown>> = [];
  if (!usageEvents.length && users.length) {
    addFreshnessSignal(freshnessSignals, "usage-events", "missing", null, null, "Confirm the usage tracker is deployed and authenticated users can insert events.");
  } else if (usageEventAgeDays !== null && usageEventAgeDays > 2) {
    addFreshnessSignal(freshnessSignals, "usage-events", "stale", latestUsageEventAt, usageEventAgeDays, "Check frontend tracking, RLS insert permissions, and network failures.");
  }
  if (!usageSessions.length && users.length) {
    addFreshnessSignal(freshnessSignals, "usage-sessions", "missing", null, null, "Confirm session upserts are reaching Supabase.");
  } else if (usageSessionAgeDays !== null && usageSessionAgeDays > 2) {
    addFreshnessSignal(freshnessSignals, "usage-sessions", "stale", latestUsageSessionAt, usageSessionAgeDays, "Verify session heartbeat/upsert calls and session RLS update permissions.");
  }
  if (!cohortSessions.length && users.length) {
    addFreshnessSignal(freshnessSignals, "retention-cohorts", "missing", null, null, "Retention cohorts need tracked sessions over time before they become reliable.");
  } else if (cohortSessionAgeDays !== null && cohortSessionAgeDays > 7) {
    addFreshnessSignal(freshnessSignals, "retention-cohorts", "stale", latestCohortSessionAt, cohortSessionAgeDays, "Review whether users are returning or whether telemetry stopped recording sessions.");
  }
  if (ai.length && aiAgeDays !== null && aiAgeDays > 7) {
    addFreshnessSignal(freshnessSignals, "ai-usage", "stale", latestAiAt, aiAgeDays, "Review AI call logging and provider health.");
  }
  if (profiles.length && profileAgeDays !== null && profileAgeDays > 30) {
    addFreshnessSignal(freshnessSignals, "profiles", "stale", latestProfileAt, profileAgeDays, "Prompt users to refresh profile goals and job-search preferences.");
  }
  const dataFreshness = {
    generatedAt,
    thresholds: {
      usageTelemetryDays: 2,
      jobFeedDays: 7,
      retentionCohortDays: 7,
      aiUsageDays: 7,
      profileDays: 30,
    },
    latestUsageEventAt,
    latestUsageSessionAt,
    latestCohortSessionAt,
    latestAiAt,
    latestProfileAt,
    latestSavedAt,
    usageEventAgeDays,
    usageSessionAgeDays,
    cohortSessionAgeDays,
    aiAgeDays,
    profileAgeDays,
    latestSavedAgeDays: latestSavedAge,
    staleSignals: freshnessSignals,
  };
  const insights = [
    activationScore < 55 ? { severity: "warning", title: "Activation is below target", body: `Activation score is ${activationScore}%. Resume readiness and first-job capture are the most important levers.`, section: "usage" } : null,
    maturedWeek1.length && avgWeek1Retention < 30 ? { severity: "warning", title: "Week 1 retention is weak", body: `Average week 1 retention is ${avgWeek1Retention}%. Improve onboarding, next-best-action prompts, and email/extension reminders so new candidates return.`, section: "usage" } : null,
    resumeReadyRate < firstJobRate ? { severity: "info", title: "Users are saving jobs before resumes are ready", body: `${firstJobRate}% have captured a job, but ${resumeReadyRate}% have a usable resume base.`, section: "funnel" } : null,
    coverLetterUsers.size < appliedUsers.size ? { severity: "info", title: "Cover letter adoption lags applications", body: `${appliedUsers.size} users have moved beyond saved, while ${coverLetterUsers.size} have generated cover letters.`, section: "funnel" } : null,
    weakestModule ? { severity: "info", title: `${weakestModule.label} needs engagement work`, body: `${weakestModule.activeUsers} active users, ${weakestModule.sessions} sessions, and ${weakestModule.events} tracked events in the current window. ${weakestModule.recommendation}`, section: "usage" } : null,
    qualityIssueRate > 5 ? { severity: "warning", title: "Provider quality needs attention", body: `${qualityIssueRate}% of sampled saved jobs have source/host mismatch issues.`, section: "job-feed" } : null,
    failureRate > 10 ? { severity: "warning", title: "AI reliability is affecting product trust", body: `${failureRate}% AI failure rate in the latest 30-day sample.`, section: "ai-cost" } : null,
  ].filter(Boolean);

  const alerts: AdminAlert[] = [];
  if (warnings.length) {
    addAlert(
      alerts,
      "warning",
      "Partial backend read",
      `${warnings.length} admin data read${warnings.length === 1 ? "" : "s"} returned a warning.`,
      "Open Sync health and check table permissions or missing columns.",
      "sync",
    );
  }
  if (ai.length >= 5 && failureRate > 10) {
    addAlert(
      alerts,
      failureRate > 25 ? "critical" : "warning",
      "AI failure rate is elevated",
      `${failureRate}% of AI calls failed in the last 30 days.`,
      "Review failed calls, model/provider status, and rate-limit errors.",
      "ai-cost",
    );
  }
  if (!jobs.length) {
    addAlert(alerts, "warning", "No job feed imports yet", "No saved job rows are available for source-health monitoring.", "Run a job search or extension capture.", "job-feed");
  } else if (latestSavedAge !== null && latestSavedAge > 7) {
    addAlert(alerts, "warning", "Job feed is stale", `Latest saved job is ${latestSavedAge} days old.`, "Refresh providers or test the extension capture flow.", "job-feed");
  }
  if (sourceIssues.length) {
    addAlert(
      alerts,
      "critical",
      "Source truth needs review",
      `${sourceIssues.length} saved job record${sourceIssues.length === 1 ? "" : "s"} have a provider label that does not match the listing host.`,
      "Review provider normalization before users trust the search results.",
      "job-feed",
    );
  }
  if (users.length && activeLast7 === 0) {
    addAlert(alerts, "warning", "No active users this week", "There are users in Auth, but none signed in during the last 7 days.", "Check onboarding, auth emails, and activation paths.", "users");
  }
  if (staleSavedRows.length) {
    addAlert(alerts, "info", "Saved roles may be idle", `${staleSavedRows.length} saved pipeline record${staleSavedRows.length === 1 ? "" : "s"} are older than 14 days.`, "Prompt users to apply, reject, or archive stale roles.", "funnel");
  }
  freshnessSignals.slice(0, 4).forEach((signal) => {
    addAlert(
      alerts,
      signal.status === "missing" ? "warning" : "info",
      `${String(signal.area || "Data")} telemetry is ${signal.status}`,
      signal.ageDays == null ? "No recent rows are available for this signal." : `Latest row is ${signal.ageDays} day${signal.ageDays === 1 ? "" : "s"} old.`,
      String(signal.action || "Review data freshness."),
      "sync",
    );
  });
  if (users.length >= 3 && activationScore < 55) {
    addAlert(alerts, "warning", "Activation needs attention", `Product activation score is ${activationScore}%.`, "Review onboarding, resume readiness, and first-job capture.", "usage");
  }
  if (!alerts.length) {
    addAlert(alerts, "info", "No critical admin alerts", "Core admin telemetry is reporting cleanly for this period.", "Continue monitoring usage, sources, and AI costs.", "overview");
  }

  const healthScore = Math.max(0, Math.min(100, Math.round(
    activationScore * 0.35 +
    (100 - qualityIssueRate) * 0.25 +
    (100 - failureRate) * 0.25 +
    (warnings.length ? 60 : 100) * 0.15
  )));

  const actionQueue = [
    ...alerts
      .filter((alert) => alert.title !== "No critical admin alerts")
      .map((alert) => ({
        priority: alert.severity,
        ownerArea: alert.section,
        title: alert.title,
        action: alert.action,
      })),
    ...(insights as Array<Record<string, unknown>>).map((insight) => ({
      priority: insight.severity || "info",
      ownerArea: insight.section || "usage",
      title: insight.title || "Product insight",
      action: insight.body || "Review this product signal.",
    })),
    ...(activationBottlenecks as Array<Record<string, unknown>>).map((item) => ({
      priority: "warning",
      ownerArea: "usage",
      title: item.label,
      action: item.action,
    })),
  ].slice(0, 10);

  const executiveSummary = [
    { label: "System health", value: `${healthScore}%`, detail: `${alerts.length} operator signal${alerts.length === 1 ? "" : "s"} in this snapshot.` },
    { label: "Users", value: users.length, detail: `${activeLast7} active in the last 7 days, ${newUsers30} new in 30 days.` },
    { label: "Activation", value: `${activationScore}%`, detail: `${firstJobUsers} users captured a job; ${resumeUsers.size} have resume evidence.` },
    { label: "Pipeline", value: applicationCount, detail: `${stageCounts.saved} saved, ${stageCounts.applied} applied, ${stageCounts.interview} interviewing.` },
    { label: "AI operations", value: ai.length, detail: `${failureRate}% failure rate, $${aiCost.toFixed(4)} estimated spend.` },
    { label: "Job feed trust", value: `${qualityIssueRate}%`, detail: `${sourceIssues.length} source truth issue${sourceIssues.length === 1 ? "" : "s"} in the sample.` },
    { label: "User support", value: supportQueues.atRisk, detail: `${supportHealthAverage}% average account health across monitored users.` },
  ];

  const csvReports = {
    overview: executiveSummary,
    risks: alerts.map((alert) => ({
      severity: alert.severity,
      title: alert.title,
      section: alert.section,
      action: alert.action,
    })),
    modules,
    cohortRetention: cohortRetention.map((row) => ({
      cohort: row.week,
      signups: row.users,
      week0: row.week0Retention,
      week1: row.week1Retention,
      week2: row.week2Retention,
      week3: row.week3Retention,
    })),
    sources: sourceRowsWithDiagnostics,
    providers: aiByProvider,
    actionQueue,
    dataFreshness: freshnessSignals,
    accountHealth: supportAccounts.map((row) => ({
      email: row.email,
      plan: row.plan,
      health: row.health,
      stage: row.stage,
      blockers: row.blockers.join("; "),
      recommendedAction: row.recommendedAction,
      inactiveDays: row.inactiveDays,
      lastActivityAt: row.lastActivityAt,
    })),
  };
  const exportManifest = Object.keys(csvReports).map((key) => {
    const rows = (csvReports as Record<string, Array<Record<string, unknown>>>)[key] || [];
    return {
      key,
      filename: `careerboost-admin-${key}.csv`,
      format: "csv",
      rows: rows.length,
      privacy: "operational metadata only",
    };
  }).concat([{
    key: "snapshot-json",
    filename: "careerboost-admin-snapshot.json",
    format: "json",
    rows: 1,
    privacy: "admin aggregate object; no document bodies",
  }]);

  const reports = {
    healthScore,
    executiveSummary,
    actionQueue,
    dataFreshness,
    privacyControls: ADMIN_PRIVACY_CONTROLS,
    exportManifest,
    audit: {
      generatedAt,
      generatedBy: admin.email,
      roles: admin.roles,
      dataWindow: "last_30_days",
      accessModel: "Supabase app_metadata roles with service-role reads after verification",
      backendWarnings: warnings.length,
      sampledRecords: {
        users: users.length,
        applications: recentApps.length,
        savedJobs: jobs.length,
        aiUsage: ai.length,
        usageEvents: usageEvents.length,
        usageSessions: usageSessions.length,
        cohortSessions: cohortSessions.length,
        sourceIssues: sourceIssues.length,
        supportAccounts: supportAccounts.length,
      },
      privacy: "Exports contain operational metadata only. Candidate resume bodies, cover-letter text, job descriptions, raw documents, API keys, and auth tokens are excluded.",
    },
    governance: {
      destructiveActionsDisabled: true,
      exportScope: "Aggregated metrics, source diagnostics, provider health, and operator action summaries",
      secretModel: "AI and job-board provider secrets stay in backend environment variables",
      retentionPolicy: "Use exports for short operational reviews; keep candidate documents in the protected app database.",
      privacyPolicy: "Admin reports use counts, timestamps, source labels, and workflow state only.",
      recommendedNextReviewAt: addDaysIso(7),
    },
    csv: csvReports,
  };

  const runbooks = [
    {
      id: "source-truth",
      title: "Fix source truth mismatch",
      ownerArea: "job-feed",
      steps: [
        "Open Job feed health and identify the reported source and actual listing host.",
        "Confirm whether the provider API returned an aggregator URL or a direct employer URL.",
        "Update provider normalization so the candidate sees the verified host and source.",
        "Run a targeted search and save one result to confirm pipeline notes preserve the same source.",
      ],
    },
    {
      id: "ai-reliability",
      title: "Investigate AI reliability",
      ownerArea: "ai-cost",
      steps: [
        "Review recent failed AI requests by skill, provider, model, and error text.",
        "Check provider limits, backend secrets, and latency spikes.",
        "Run a small resume, cover letter, and interview-prep smoke test.",
        "If failures continue, switch provider/model routing before candidates retry.",
      ],
    },
    {
      id: "feed-stale",
      title: "Refresh stale job feed",
      ownerArea: "job-feed",
      steps: [
        "Run one search for each active provider with strict location constraints.",
        "Check whether the provider returned zero results or the backend rejected them.",
        "Verify extension capture still writes to saved jobs and pipeline without refresh.",
        "Record provider-specific outages in the admin action queue.",
      ],
    },
    {
      id: "backend-warning",
      title: "Resolve backend read warnings",
      ownerArea: "sync",
      steps: [
        "Open Sync health and copy the warning label.",
        "Check Supabase table existence, column names, and RLS/service-role access.",
        "Deploy the affected function after the schema mismatch is fixed.",
        "Refresh the admin console and confirm warnings return to zero.",
      ],
    },
    {
      id: "activation",
      title: "Recover product activation",
      ownerArea: "usage",
      steps: [
        "Check whether onboarding, resume readiness, or first-job capture is the bottleneck.",
        "Review the module adoption table to see where users stop.",
        "Improve the next-best-action prompt in the highest-dropoff module.",
        "Recheck activation after the next weekly cohort.",
      ],
    },
  ];

  function runbookFor(section: string): string {
    if (section === "job-feed") return latestSavedAge !== null && latestSavedAge > 7 ? "feed-stale" : "source-truth";
    if (section === "ai-cost") return "ai-reliability";
    if (section === "sync") return "backend-warning";
    if (section === "usage" || section === "funnel") return "activation";
    return "activation";
  }

  // Phase C.2: persist computed alerts to admin_incidents via the dedup'ed
  // upsert RPC. Re-reads the live rows so the response shows the real
  // lifecycle state (open / acknowledged / snoozed / resolved) — which
  // means an operator who clicked "Acknowledge" earlier won't see the
  // same alert flap back to "open" every minute.
  //
  // Falls back to the in-memory shape if the RPC errors or the table
  // is missing (early-deploy state).
  function alertKind(alert: AdminAlert): string {
    const titleSlug = String(alert.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "unknown";
    return (alert.section || "overview") + ":" + titleSlug;
  }
  const persistableAlerts = alerts.filter((alert) => alert.title !== "No critical admin alerts");
  // Upsert each in parallel; ignore individual failures (we still get the
  // in-memory shape below as a fallback).
  const upsertResults = await Promise.all(persistableAlerts.map(async (alert) => {
    try {
      const kind = alertKind(alert);
      const { data, error } = await svc.rpc("upsert_admin_incident", {
        p_kind: kind,
        p_key: "",
        p_severity: alert.severity,
        p_title: alert.title,
        p_body: alert.body,
        p_section: alert.section,
        p_payload: { action: alert.action },
      });
      if (error) {
        warnings.push(`upsert_admin_incident(${kind}): ${error.message}`);
        return null;
      }
      return { kind, id: data as string | null };
    } catch (err) {
      warnings.push(`upsert_admin_incident: ${(err as Error).message}`);
      return null;
    }
  }));
  // Re-fetch the persisted rows by id to get current statuses.
  const persistedIds = upsertResults
    .map((r) => r && r.id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  let persistedRows: Array<Record<string, unknown>> = [];
  if (persistedIds.length) {
    try {
      const { data, error } = await svc
        .from("admin_incidents")
        .select("id, dedup_key, kind, severity, status, title, body, section, payload, opened_at, last_seen_at, acknowledged_at, snoozed_until, resolved_at, occurrence_count")
        .in("id", persistedIds);
      if (error) warnings.push("admin_incidents.read: " + error.message);
      else if (Array.isArray(data)) persistedRows = data as Array<Record<string, unknown>>;
    } catch (err) {
      warnings.push("admin_incidents.read: " + ((err as Error).message || "failed"));
    }
  }
  const incidents = persistedRows.length
    ? persistedRows.map((row) => {
        const ackOrResolved = row.status === "acknowledged" || row.status === "resolved" || row.status === "snoozed";
        return {
          id:           String(row.id || ""),
          dedupKey:     String(row.dedup_key || ""),
          status:       String(row.status || "open"),
          severity:     String(row.severity || "warning"),
          title:        String(row.title || ""),
          body:         String(row.body || ""),
          affectedArea: String(row.section || "overview"),
          section:      String(row.section || "overview"),
          detectedAt:   String(row.opened_at || ""),
          lastSeenAt:   String(row.last_seen_at || ""),
          acknowledgedAt: row.acknowledged_at || null,
          snoozedUntil: row.snoozed_until || null,
          resolvedAt:   row.resolved_at || null,
          occurrenceCount: Number(row.occurrence_count || 1),
          action:       (row.payload && typeof row.payload === "object")
                          ? String((row.payload as Record<string, unknown>).action || "")
                          : "",
          runbookId:    runbookFor(String(row.section || "overview")),
          // UI hint: whether to show the ack/resolve buttons.
          canAct:       !ackOrResolved || row.status === "snoozed",
        };
      })
    : persistableAlerts.map((alert, index) => ({
        id:           `ops-${index + 1}`,
        dedupKey:     "",
        status:       "open",
        severity:     alert.severity,
        title:        alert.title,
        body:         alert.body,
        affectedArea: alert.section,
        section:      alert.section,
        detectedAt:   new Date().toISOString(),
        lastSeenAt:   new Date().toISOString(),
        acknowledgedAt: null,
        snoozedUntil: null,
        resolvedAt:   null,
        occurrenceCount: 1,
        action:       alert.action,
        runbookId:    runbookFor(alert.section),
        canAct:       false,                 // can't act on synthetic IDs
      }));

  const serviceLevels = [
    {
      id: "admin-access",
      label: "Admin access",
      target: "Only app_metadata roles can open admin",
      current: `${adminUsers} admin account${adminUsers === 1 ? "" : "s"}`,
      status: adminUsers ? "healthy" : "watch",
      section: "settings",
    },
    {
      id: "backend-read",
      label: "Backend read health",
      target: "0 warnings",
      current: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
      status: warnings.length ? "watch" : "healthy",
      section: "sync",
    },
    {
      id: "feed-freshness",
      label: "Job feed freshness",
      target: "Latest save within 7 days",
      current: latestSavedAge === null ? "No imports" : `${latestSavedAge} day${latestSavedAge === 1 ? "" : "s"} old`,
      status: latestSavedAge === null || latestSavedAge > 7 ? "watch" : "healthy",
      section: "job-feed",
    },
    {
      id: "source-truth",
      label: "Source truth",
      target: "<= 5% source/host mismatch",
      current: `${qualityIssueRate}% mismatch`,
      status: qualityIssueRate > 10 ? "incident" : (qualityIssueRate > 5 ? "watch" : "healthy"),
      section: "job-feed",
    },
    {
      id: "ai-reliability",
      label: "AI reliability",
      target: "<= 10% failure rate",
      current: `${failureRate}% failure`,
      status: failureRate > 25 ? "incident" : (failureRate > 10 ? "watch" : "healthy"),
      section: "ai-cost",
    },
    {
      id: "activation",
      label: "Activation",
      target: ">= 55% activation score",
      current: `${activationScore}% activation`,
      status: activationScore < 40 ? "incident" : (activationScore < 55 ? "watch" : "healthy"),
      section: "usage",
    },
  ];

  const releaseChecks = [
    { label: "Admin access is protected", pass: true, detail: "Access is verified through Supabase app_metadata roles." },
    { label: "Privacy controls are active", pass: true, detail: `${ADMIN_PRIVACY_CONTROLS.disallowedMetadataKeys.length} sensitive metadata keys blocked by policy.` },
    { label: "Backend reads are clean", pass: warnings.length === 0, detail: `${warnings.length} backend warning${warnings.length === 1 ? "" : "s"}.` },
    { label: "Telemetry is fresh", pass: freshnessSignals.length === 0, detail: `${freshnessSignals.length} stale or missing telemetry signal${freshnessSignals.length === 1 ? "" : "s"}.` },
    { label: "Job source truth is within tolerance", pass: qualityIssueRate <= 5, detail: `${qualityIssueRate}% provider mismatch rate.` },
    { label: "AI failure rate is within tolerance", pass: failureRate <= 10, detail: `${failureRate}% AI failure rate.` },
    { label: "Job feed is fresh", pass: latestSavedAge !== null && latestSavedAge <= 7, detail: latestSavedAge === null ? "No imports yet." : `Latest import ${latestSavedAge} day${latestSavedAge === 1 ? "" : "s"} old.` },
    { label: "Activation is above floor", pass: activationScore >= 55, detail: `${activationScore}% activation score.` },
  ];
  const releaseScore = pct(releaseChecks.filter((check) => check.pass).length, releaseChecks.length);
  const controlCenter = {
    incidents,
    serviceLevels,
    runbooks,
    releaseReadiness: {
      score: releaseScore,
      status: releaseScore >= 85 ? "ready" : (releaseScore >= 65 ? "watch" : "blocked"),
      checks: releaseChecks,
    },
    escalation: {
      policy: "Review critical incidents before releasing changes that affect job search, AI generation, sync, or candidate document exports.",
      cadence: "Daily while incidents are open; weekly when all service levels are healthy.",
    },
  };
  (reports.csv as Record<string, unknown>).incidents = incidents;
  (reports.csv as Record<string, unknown>).serviceLevels = serviceLevels;
  (reports.exportManifest as Array<Record<string, unknown>>).push(
    { key: "incidents", filename: "careerboost-admin-incidents.csv", format: "csv", rows: incidents.length, privacy: "operational metadata only" },
    { key: "serviceLevels", filename: "careerboost-admin-serviceLevels.csv", format: "csv", rows: serviceLevels.length, privacy: "operational metadata only" },
  );

  const activity = [
    ...recentApps.slice(0, 5).map((app) => ({
      type: "pipeline",
      title: "Pipeline updated",
      body: `${app.company || "Company"} - ${app.role || "Role"} moved in ${app.stage || "pipeline"}`,
      at: app.updated_at || app.created_at || null,
    })),
    ...ai.slice(0, 5).map((row) => ({
      type: row.status === "failed" ? "ai-failed" : "ai",
      title: row.status === "failed" ? "AI request failed" : "AI request completed",
      body: `${row.skill || "AI"}${row.provider ? " via " + row.provider : ""}`,
      at: row.created_at || null,
    })),
  ].sort((a, b) => Date.parse(String(b.at || "")) - Date.parse(String(a.at || ""))).slice(0, 10);

  // ──────────────────────────────────────────────────────────────────────
  // Phase E1: Command Center blocks — North Star, AARRR, priorities,
  //           outcomes attribution, weekly changes.
  //
  // We read the v_admin_outcome_rollup view first (single round-trip,
  // window'd in SQL). When the new table is empty (new install / outcomes
  // not yet self-reported), we fall back to computing placements from the
  // existing applications.stage snapshot so the metric never shows 0
  // when there's clearly pipeline activity.
  // ──────────────────────────────────────────────────────────────────────
  const { data: outcomeRollupRows, error: outcomeRollupError } = await svc
    .from("v_admin_outcome_rollup")
    .select("window_name, outcome_type, event_count, distinct_users, distinct_companies, attributed_count");
  if (outcomeRollupError) warnings.push("outcome_rollup: " + outcomeRollupError.message);

  const { data: outcomeChannelRows, error: outcomeChannelError } = await svc
    .from("v_admin_outcome_by_channel")
    .select("channel, interviews_30d, offers_30d, placements_30d, distinct_users_30d");
  if (outcomeChannelError) warnings.push("outcome_channel: " + outcomeChannelError.message);

  // Roll up the view rows into a window-keyed map for quick lookup.
  const outcomeByWindow: Record<string, { interviews: number; offers: number; placements: number; distinctUsers: number; attributed: number }> = {
    last_30d:  { interviews: 0, offers: 0, placements: 0, distinctUsers: 0, attributed: 0 },
    prior_30d: { interviews: 0, offers: 0, placements: 0, distinctUsers: 0, attributed: 0 },
    last_90d:  { interviews: 0, offers: 0, placements: 0, distinctUsers: 0, attributed: 0 },
  };
  ((outcomeRollupRows || []) as Array<Record<string, unknown>>).forEach((row) => {
    const win = String(row.window_name || "");
    const type = String(row.outcome_type || "");
    const ev = n(row.event_count);
    const users = n(row.distinct_users);
    const attributed = n(row.attributed_count);
    if (!outcomeByWindow[win]) return;
    if (type === "interview") outcomeByWindow[win].interviews += ev;
    if (type === "offer") outcomeByWindow[win].offers += ev;
    if (type === "interview" || type === "offer") {
      outcomeByWindow[win].placements += ev;
      outcomeByWindow[win].distinctUsers += users;
      outcomeByWindow[win].attributed += attributed;
    }
  });

  // Fallback: if outcomes table is empty, derive placements from the
  // applications.stage snapshot. We count users with at least one app in
  // "interview" or "offer" stage whose updated_at is in the last 30 days.
  const placements30dFromApps = (() => {
    if (outcomeByWindow.last_30d.placements > 0) return 0; // outcomes are the source of truth
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const placedUsers = new Set<string>();
    ((appRows || []) as Array<Record<string, unknown>>).forEach((app) => {
      const stage = String(app.stage || "");
      if (stage !== "interview" && stage !== "offer") return;
      const updated = Date.parse(String(app.updated_at || app.applied_at || app.created_at || ""));
      if (!Number.isFinite(updated) || updated < cutoff) return;
      const uid = String(app.user_id || "");
      if (uid) placedUsers.add(uid);
    });
    return placedUsers.size;
  })();
  const placements30d = outcomeByWindow.last_30d.placements || placements30dFromApps;
  const placementsPrior30d = outcomeByWindow.prior_30d.placements;
  const placementDelta = placements30d - placementsPrior30d;
  const placementDeltaPct = placementsPrior30d > 0 ? Math.round((placementDelta / placementsPrior30d) * 100) : (placements30d > 0 ? 100 : 0);

  // Target floor: at minimum 1 placement per 20 active users in 30d.
  // (A reasonable early-stage hiring-marketplace benchmark; the operator
  // can tighten this once historical data accumulates.)
  const placementTarget = Math.max(5, Math.ceil(activeLast30 / 20));
  const placementProgress = placementTarget > 0 ? Math.min(100, Math.round((placements30d / placementTarget) * 100)) : 0;

  const northStar = {
    label: "Active placements",
    sublabel: "Candidates with interview or offer in last 30 days",
    value: placements30d,
    prior: placementsPrior30d,
    delta: placementDelta,
    deltaPct: placementDeltaPct,
    direction: placementDelta > 0 ? "up" : (placementDelta < 0 ? "down" : "flat"),
    target: placementTarget,
    progress: placementProgress,
    progressTone: placementProgress >= 100 ? "green" : (placementProgress >= 60 ? "blue" : (placementProgress >= 30 ? "amber" : "red")),
    healthSignal: placements30d === 0 ? "no-placements" : (placementDelta < 0 ? "declining" : (placementProgress >= 100 ? "exceeding" : "tracking")),
    note: outcomeByWindow.last_30d.placements === 0 && placements30dFromApps > 0
      ? "Computed from pipeline stage transitions until candidates self-report outcomes."
      : "Self-reported interview/offer milestones.",
  };

  // ─── AARRR (pirate metrics) — five stages of the growth engine ────────
  // Each stage has: value, label, status (good|watch|bad), why, action,
  // section (deep-link), action_id (so the UI can render one-click buttons
  // in later phases). All numbers come from existing aggregates above.
  const activationRate = activationScore;          // already computed earlier
  const week1Retention = cohortSummary.avgWeek1Retention || 0;
  const monthlyActive = activeLast30;
  // Acquisition: new users in last 30 days, with delta vs prior 30
  // (computed from auth.users.created_at — same source `newUsers30` uses).
  const newUsersPrior30 = (() => {
    const cutoffStart = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const cutoffEnd = since30; // 30 days ago boundary
    return ((users || []) as Array<Record<string, unknown>>).filter((u) => {
      const created = String(u.created_at || "");
      return created >= cutoffStart && created < cutoffEnd;
    }).length;
  })();
  const acquisitionDelta = newUsers30 - newUsersPrior30;
  const acquisitionDeltaPct = newUsersPrior30 > 0 ? Math.round((acquisitionDelta / newUsersPrior30) * 100) : (newUsers30 > 0 ? 100 : 0);

  // Revenue: CareerBoost is not currently monetized. The Command Center
  // displays "Pre-revenue" so the operator sees the gap and the cost-per-
  // user economics from AI spend instead. Wired up to real billing data
  // when monetization launches.
  const aiCostPerActiveUser = activeLast30 > 0 ? Number((aiCost / activeLast30).toFixed(2)) : 0;

  // Referral: we don't have referral instrumentation yet (Phase E2). Show
  // organic invite signal = users with > 1 saved search OR > 5 saved jobs
  // (power-user proxy — proxy users tend to recommend the product).
  const powerUserProxy = ((users || []) as Array<Record<string, unknown>>).filter((u) => {
    const uid = String(u.id || "");
    const savedJobsForUser = ((savedRows || []) as Array<Record<string, unknown>>).filter((j) => String(j.user_id || "") === uid).length;
    return savedJobsForUser >= 5;
  }).length;

  const aarrr = [
    {
      stage: "acquisition",
      label: "Acquisition",
      icon: "fa-bullhorn",
      value: newUsers30,
      delta: acquisitionDelta,
      deltaPct: acquisitionDeltaPct,
      sub: `${newUsersPrior30} prior 30d`,
      status: newUsers30 === 0 ? "bad" : (acquisitionDelta < 0 ? "watch" : "good"),
      why: newUsers30 === 0
        ? "No signups in the last 30 days. The growth engine is not turning."
        : (acquisitionDelta < 0
          ? "Signups are slowing month-over-month. Investigate channel performance."
          : "Signup volume is trending up."),
      action: newUsers30 === 0
        ? "Launch a landing-page test, share-on-social campaign, or paid acquisition pilot."
        : (acquisitionDelta < 0
          ? "Open Growth board to see which acquisition channel weakened."
          : "Keep current acquisition mix; explore one new channel."),
      section: "growth",
    },
    {
      stage: "activation",
      label: "Activation",
      icon: "fa-bolt",
      value: activationRate,
      unit: "%",
      sub: `${activationMovedForward.size} of ${users.length} users reached value`,
      status: activationRate >= 55 ? "good" : (activationRate >= 35 ? "watch" : "bad"),
      why: activationRate < 35
        ? "Most new signups never reach the value moment (resume ready + first job + tailored asset)."
        : (activationRate < 55
          ? "Activation is below the 55% floor that compounds organic growth."
          : "Activation is healthy — new users are reaching value."),
      action: activationRate < 35
        ? "Add an onboarding nudge after signup → drive users to Resume Lab + Job Search in their first session."
        : (activationRate < 55
          ? "Examine the largest funnel drop-off in the Growth board and fix that one step."
          : "Audit the funnel quarterly; activation tends to drift without attention."),
      section: "growth",
    },
    {
      stage: "retention",
      label: "Retention",
      icon: "fa-arrows-rotate",
      value: week1Retention,
      unit: "%",
      sub: `${monthlyActive} monthly active users`,
      status: week1Retention >= 35 ? "good" : (week1Retention >= 20 ? "watch" : "bad"),
      why: week1Retention < 20
        ? "Most new users don't return in week 1. The product isn't sticky enough yet."
        : (week1Retention < 35
          ? "Week 1 return rate is below the 35% threshold for habitual products."
          : "Retention is solid — users are forming a return habit."),
      action: week1Retention < 20
        ? "Add a high-value email or in-app notification 24-48h after signup. Pin a 'next action' card to the dashboard."
        : (week1Retention < 35
          ? "Identify which feature predicts return (Product Intelligence) and surface it earlier."
          : "Document what's driving retention; protect those features when refactoring."),
      section: "users",
    },
    {
      stage: "revenue",
      label: "Revenue",
      icon: "fa-coins",
      value: 0,
      preFormatted: "Pre-revenue",
      sub: `AI cost $${aiCostPerActiveUser.toFixed(2)} / monthly active user`,
      status: aiCostPerActiveUser > 5 ? "watch" : "good",
      why: aiCostPerActiveUser > 5
        ? "AI cost per active user is above $5/month. Unit economics will be tight at scale."
        : "Unit economics are healthy. AI spend is a small fraction of expected ARPU at any plausible price.",
      action: "Launch monetization: a Pro tier (priority AI, unlimited cover letters, mock interviews). Set price at $9.99 - $19/mo.",
      section: "ai-cost",
    },
    {
      stage: "referral",
      label: "Referral",
      icon: "fa-share-nodes",
      value: powerUserProxy,
      sub: "users with 5+ saved jobs (advocate proxy)",
      status: powerUserProxy >= 3 ? "good" : (powerUserProxy >= 1 ? "watch" : "bad"),
      why: powerUserProxy === 0
        ? "No power users yet. The product isn't being adopted deeply enough to drive word-of-mouth."
        : (powerUserProxy < 3
          ? "A small number of power users exist but no referral loop is in place to convert them into advocates."
          : "Power-user base is forming — referral mechanics will compound from here."),
      action: powerUserProxy === 0
        ? "Focus on activation + retention first; referrals only work after users see value."
        : "Ship a referral loop: 'Invite a friend, both get Pro free for a month' or 'Share your win' template.",
      section: "users",
    },
  ];

  // ─── Today's 3 priorities — algorithmic top-3 selection ───────────────
  // We score every candidate issue across the dashboard by impact (how much
  // revenue/growth/users it gates) × urgency (how recent/active) and return
  // the top 3 with an explicit action + deep-link. The operator should be
  // able to clear today's work in three clicks.
  type PriorityCandidate = {
    id: string;
    title: string;
    why: string;             // why it matters (business consequence)
    rootCause: string;       // why it's happening
    action: string;          // what to do (specific, time-boxed)
    impact: number;          // 1..10 (revenue/growth gating)
    urgency: number;         // 1..10 (decay over time)
    section: string;
    actionType: string;      // "navigate" | "campaign" | "resolve-incident" | "broadcast"
    icon: string;
  };
  const priorityCandidates: PriorityCandidate[] = [];

  // ① North Star gap
  if (placements30d < placementTarget) {
    const gap = placementTarget - placements30d;
    priorityCandidates.push({
      id: "north-star-gap",
      title: `${gap} placements short of target`,
      why: `North Star floor is ${placementTarget} placements per 30 days. Currently at ${placements30d}.`,
      rootCause: placements30d === 0
        ? "No candidates have reached interview/offer yet. The full funnel from signup to interview is underperforming."
        : "Pipeline conversion from applied → interview is below floor.",
      action: placements30d === 0
        ? "Audit the entire funnel — start with activation (Growth board)."
        : "Open Product Intelligence to see which module candidates use before interviews, then double down on it.",
      impact: 10,
      urgency: 8,
      section: "growth",
      actionType: "navigate",
      icon: "fa-bullseye",
    });
  }

  // ② Critical incidents (already ranked)
  incidents.filter((i) => (i as Record<string, unknown>).status === "open" && (i as Record<string, unknown>).severity === "critical").slice(0, 2).forEach((inc) => {
    const incRecord = inc as Record<string, unknown>;
    priorityCandidates.push({
      id: "incident-" + String(incRecord.id || ""),
      title: String(incRecord.title || "Critical incident open"),
      why: String(incRecord.body || "A critical service-level incident is open and unresolved."),
      rootCause: String(incRecord.affectedArea || "system") + " is degraded.",
      action: String(incRecord.action || "Open Risk Center to acknowledge or resolve."),
      impact: 9,
      urgency: 10,
      section: "risk-center",
      actionType: "resolve-incident",
      icon: "fa-triangle-exclamation",
    });
  });

  // ③ Activation below floor
  if (activationRate < 55) {
    priorityCandidates.push({
      id: "activation-low",
      title: `Activation at ${activationRate}% (floor: 55%)`,
      why: "Below 55% activation, signups don't compound into a growing user base — the product becomes a leaky bucket.",
      rootCause: largestDropOff && (largestDropOff as Record<string, unknown>).label
        ? `Biggest drop-off: ${String((largestDropOff as Record<string, unknown>).label)}.`
        : "Multiple funnel steps are underperforming.",
      action: largestDropOff && (largestDropOff as Record<string, unknown>).action
        ? String((largestDropOff as Record<string, unknown>).action)
        : "Open Growth board to see the funnel drop-off chart and fix the biggest leak.",
      impact: 9,
      urgency: 7,
      section: "growth",
      actionType: "navigate",
      icon: "fa-bolt",
    });
  }

  // ④ Week-1 retention below floor
  if (week1Retention > 0 && week1Retention < 20) {
    priorityCandidates.push({
      id: "retention-low",
      title: `Week-1 retention at ${week1Retention}%`,
      why: "Below 20% week-1 retention, organic growth via word-of-mouth is impossible. Every signup leaks away.",
      rootCause: "New users aren't returning in their first week — likely no compelling reason to come back yet.",
      action: "Ship a 24-hour and 7-day nudge sequence (in-app + email). Pin a 'next action' card to the dashboard.",
      impact: 9,
      urgency: 7,
      section: "users",
      actionType: "campaign",
      icon: "fa-arrows-rotate",
    });
  }

  // ⑤ Stuck users (proxy: at-risk accounts)
  const supportSummary = (support as Record<string, unknown>).summary as Record<string, unknown> | undefined;
  const atRiskCount = n(supportSummary?.atRisk);
  if (atRiskCount >= 3) {
    priorityCandidates.push({
      id: "stuck-users",
      title: `${atRiskCount} users stuck below 55% health`,
      why: "Stuck users are the highest churn risk. Each one represents a CAC investment that may not return.",
      rootCause: "Users with low health typically can't get past Resume Lab or Job Search without help.",
      action: "Open User Support, filter to at-risk, and send a guided re-engagement message to the top 5.",
      impact: 7,
      urgency: 7,
      section: "user-support",
      actionType: "campaign",
      icon: "fa-user-clock",
    });
  }

  // ⑥ AI failure rate above tolerance
  if (failureRate > 10) {
    priorityCandidates.push({
      id: "ai-failures",
      title: `AI failure rate at ${failureRate}%`,
      why: "Every AI failure is a candidate who tried something and got nothing. Trust erodes fast.",
      rootCause: "Provider-side rate limiting, model outage, or prompt regression.",
      action: "Open AI Cost monitor → check the recent failures table → switch provider if a pattern shows.",
      impact: 8,
      urgency: 8,
      section: "ai-cost",
      actionType: "navigate",
      icon: "fa-wand-magic-sparkles",
    });
  }

  // ⑦ Source-truth incidents
  if (qualityIssueRate > 10) {
    priorityCandidates.push({
      id: "source-truth",
      title: `Source mismatch at ${qualityIssueRate}%`,
      why: "Wrong source attribution breaks both candidate trust and our acquisition analytics.",
      rootCause: "Provider labels don't match the canonical job listing host (extension or import pipeline).",
      action: "Open Job Feed Health → review the mismatch list → fix the normalization rule in the import pipeline.",
      impact: 6,
      urgency: 6,
      section: "job-feed",
      actionType: "navigate",
      icon: "fa-link-slash",
    });
  }

  // Top 3 by impact × urgency.
  const priorities = priorityCandidates
    .sort((a, b) => (b.impact * b.urgency) - (a.impact * a.urgency))
    .slice(0, 3);

  if (priorities.length === 0) {
    priorities.push({
      id: "all-clear",
      title: "All systems healthy",
      why: "No priority issues detected across activation, retention, incidents, AI, or source truth.",
      rootCause: "The current cohort is performing within target ranges.",
      action: "Use this calm to ship a marketing experiment or a referral loop while incidents are quiet.",
      impact: 1,
      urgency: 1,
      section: "growth",
      actionType: "navigate",
      icon: "fa-circle-check",
    });
  }

  // ─── Weekly changes — what moved week-over-week on key metrics ────────
  // We compute "this week vs prior week" for: signups, applications,
  // saved jobs, AI requests, and placements. Each row tells the operator
  // what changed and whether it's a win, a loss, or noise.
  const oneWeekAgo = Date.now() - WEEK_MS;
  const twoWeeksAgo = Date.now() - 2 * WEEK_MS;
  function countInWindow<T extends Record<string, unknown>>(rows: T[], field: string, since: number, until: number): number {
    return rows.filter((row) => {
      const t = Date.parse(String(row[field] || ""));
      return Number.isFinite(t) && t >= since && t < until;
    }).length;
  }
  const signupsThisWeek = countInWindow(users as Array<Record<string, unknown>>, "created_at", oneWeekAgo, Date.now());
  const signupsPriorWeek = countInWindow(users as Array<Record<string, unknown>>, "created_at", twoWeeksAgo, oneWeekAgo);
  const appsThisWeek = countInWindow(appRows as Array<Record<string, unknown>> || [], "created_at", oneWeekAgo, Date.now());
  const appsPriorWeek = countInWindow(appRows as Array<Record<string, unknown>> || [], "created_at", twoWeeksAgo, oneWeekAgo);
  const savedThisWeek = countInWindow(savedRows as Array<Record<string, unknown>> || [], "saved_at", oneWeekAgo, Date.now());
  const savedPriorWeek = countInWindow(savedRows as Array<Record<string, unknown>> || [], "saved_at", twoWeeksAgo, oneWeekAgo);
  const aiThisWeek = countInWindow(ai as Array<Record<string, unknown>>, "created_at", oneWeekAgo, Date.now());
  const aiPriorWeek = countInWindow(ai as Array<Record<string, unknown>>, "created_at", twoWeeksAgo, oneWeekAgo);

  function delta(now: number, prior: number) {
    const diff = now - prior;
    const pctChange = prior > 0 ? Math.round((diff / prior) * 100) : (now > 0 ? 100 : 0);
    return {
      now,
      prior,
      diff,
      pct: pctChange,
      direction: diff > 0 ? "up" : (diff < 0 ? "down" : "flat"),
    };
  }
  const weeklyChanges = [
    { metric: "Signups", icon: "fa-user-plus", ...delta(signupsThisWeek, signupsPriorWeek), goodDirection: "up" },
    { metric: "Applications", icon: "fa-briefcase", ...delta(appsThisWeek, appsPriorWeek), goodDirection: "up" },
    { metric: "Saved jobs", icon: "fa-bookmark", ...delta(savedThisWeek, savedPriorWeek), goodDirection: "up" },
    { metric: "AI requests", icon: "fa-wand-magic-sparkles", ...delta(aiThisWeek, aiPriorWeek), goodDirection: "up" },
  ];

  // ─── Phase E2: Growth & Acquisition block ─────────────────────────────
  // Reads the four v_admin_acquisition_* views. Each returns aggregates
  // by channel / geo / landing / referrer with signup, activated, placed
  // counts. We then compute "where to invest" recommendations based on
  // the quality_score column (placed/signups).
  const [
    { data: channelRows, error: channelErr },
    { data: geoRows,     error: geoErr },
    { data: landingRows, error: landingErr },
    { data: referrerRows, error: referrerErr },
  ] = await Promise.all([
    svc.from("v_admin_acquisition_channels")
      .select("channel, medium, signups, signups_30d, activated, placed, quality_score")
      .limit(50),
    svc.from("v_admin_acquisition_geo")
      .select("country_code, signups, signups_30d, activated, placed")
      .limit(50),
    svc.from("v_admin_acquisition_landing")
      .select("landing_path, signups, signups_30d, activated"),
    svc.from("v_admin_acquisition_referrers")
      .select("referrer_host, signups, signups_30d, activated"),
  ]);
  if (channelErr)  warnings.push("acquisition_channels: "  + channelErr.message);
  if (geoErr)      warnings.push("acquisition_geo: "       + geoErr.message);
  if (landingErr)  warnings.push("acquisition_landing: "   + landingErr.message);
  if (referrerErr) warnings.push("acquisition_referrers: " + referrerErr.message);

  const channels  = (channelRows  || []) as Array<Record<string, unknown>>;
  const geo       = (geoRows      || []) as Array<Record<string, unknown>>;
  const landing   = (landingRows  || []) as Array<Record<string, unknown>>;
  const referrers = (referrerRows || []) as Array<Record<string, unknown>>;

  // Conversion totals — the operator's headline numbers.
  const totalSignups        = channels.reduce((sum, row) => sum + n(row.signups), 0);
  const totalActivated      = channels.reduce((sum, row) => sum + n(row.activated), 0);
  const totalPlaced         = channels.reduce((sum, row) => sum + n(row.placed), 0);
  const totalSignups30d     = channels.reduce((sum, row) => sum + n(row.signups_30d), 0);
  const overallActivation   = pct(totalActivated, Math.max(1, totalSignups));
  const overallPlacement    = pct(totalPlaced, Math.max(1, totalSignups));
  const attributedSignups   = channels
    .filter((row) => String(row.channel || "") !== "direct" && String(row.channel || "") !== "unknown")
    .reduce((sum, row) => sum + n(row.signups), 0);
  const attributionCoverage = pct(attributedSignups, Math.max(1, totalSignups));

  // "Where to invest" — top 3 channels by quality_score with minimum
  // sample size, and bottom 3 (where signups are flowing but quality is
  // low — investigate or cut).
  const minSampleSize = 3;
  const qualifiedChannels = channels.filter((row) =>
    n(row.signups) >= minSampleSize && String(row.channel || "") !== "direct" && String(row.channel || "") !== "unknown"
  );
  const topChannels = qualifiedChannels
    .slice()
    .sort((a, b) => n(b.quality_score) - n(a.quality_score))
    .slice(0, 3);
  const leakingChannels = qualifiedChannels
    .filter((row) => n(row.quality_score) < 5 && n(row.signups) >= 5)
    .slice()
    .sort((a, b) => n(b.signups) - n(a.signups))
    .slice(0, 3);

  const growthRecommendations: Array<Record<string, unknown>> = [];
  if (totalSignups === 0) {
    growthRecommendations.push({
      severity: "critical",
      title: "No signups recorded",
      body: "No signups have come through any channel yet. Acquisition needs to be the #1 focus.",
      action: "Pick one channel (organic social, paid search, content partnership) and run a 7-day push experiment.",
    });
  } else if (attributionCoverage < 30 && totalSignups >= 10) {
    growthRecommendations.push({
      severity: "warning",
      title: `Only ${attributionCoverage}% of signups are attributed`,
      body: "Most signups come through direct/organic with no campaign tag. Marketing decisions will fly blind.",
      action: "Add utm_source/utm_medium to every campaign link, social post, and email template.",
    });
  }
  topChannels.forEach((c) => {
    growthRecommendations.push({
      severity: "info",
      title: `Invest more in ${c.channel}`,
      body: `${c.quality_score}% of ${c.channel} signups have moved to interview/offer (${c.placed} placed of ${c.signups} signups).`,
      action: `Double down: increase budget/effort on ${c.channel} (medium: ${c.medium || "any"}).`,
    });
  });
  leakingChannels.forEach((c) => {
    growthRecommendations.push({
      severity: "warning",
      title: `${c.channel} signups don't convert`,
      body: `${c.signups} signups, ${c.activated} activated, ${c.placed} placed. Channel quality is below 5%.`,
      action: `Audit the landing experience for ${c.channel}: wrong audience, weak copy, or misaligned promise.`,
    });
  });
  if (geo.length > 0) {
    const topCountry = geo.slice().sort((a, b) => n(b.signups_30d) - n(a.signups_30d))[0];
    if (topCountry && String(topCountry.country_code) !== "unknown" && n(topCountry.signups_30d) >= 3) {
      growthRecommendations.push({
        severity: "info",
        title: `${topCountry.country_code} is your biggest geo`,
        body: `${topCountry.signups_30d} signups in the last 30 days from ${topCountry.country_code}.`,
        action: `Localize: payment methods, time-of-day messaging, and currency formatting for ${topCountry.country_code}.`,
      });
    }
  }

  // Acquisition funnel: signups → activated → placed.
  const acquisitionFunnel = [
    { id: "signups",    label: "Signups",                   count: totalSignups,   share: 100 },
    { id: "activated",  label: "Activated (created an application)", count: totalActivated, share: overallActivation },
    { id: "placed",     label: "Placed (interview / offer)", count: totalPlaced,   share: overallPlacement },
  ];

  const growthBlock = {
    summary: {
      totalSignups,
      totalSignups30d,
      totalActivated,
      totalPlaced,
      overallActivation,
      overallPlacement,
      attributionCoverage,
    },
    funnel: acquisitionFunnel,
    channels,
    geo,
    landing,
    referrers,
    topChannels,
    leakingChannels,
    recommendations: growthRecommendations,
  };

  // ─── Outcomes block (for the Command Center + Growth board) ───────────
  const outcomesBlock = {
    placements30d,
    placementsPrior30d,
    placementDelta,
    placementDeltaPct,
    interviews30d: outcomeByWindow.last_30d.interviews,
    offers30d: outcomeByWindow.last_30d.offers,
    distinctPlacedUsers30d: outcomeByWindow.last_30d.distinctUsers || placements30dFromApps,
    attributedShare: outcomeByWindow.last_30d.placements > 0
      ? Math.round((outcomeByWindow.last_30d.attributed / outcomeByWindow.last_30d.placements) * 100)
      : 0,
    byChannel: (outcomeChannelRows || []) as Array<Record<string, unknown>>,
    target: placementTarget,
    progressPct: placementProgress,
    sourceNote: outcomeByWindow.last_30d.placements > 0
      ? "From self-reported interview/offer milestones"
      : "Estimated from pipeline stage transitions (interview_outcomes is empty)",
  };

  return jsonResponse({
    ok: true,
    generatedAt,
    access: {
      adminEmail: admin.email,
      roles: admin.roles,
      // Phase A: surface the backend's ADMIN_ROLES env to the client so
      // there's a single source of truth for who can see the admin menu.
      // The hardcoded fallback in admin.route.js only applies until the
      // first successful response, then we mirror this list.
      allowedRoles: admin.allowedRoles,
    },
    totals: {
      users: users.length,
      profiles: profileCount,
      applications: applicationCount,
      savedJobs: savedJobCount,
      savedSearches: savedSearchCount,
      events: eventCount,
      upcomingEvents: upcomingEventCount,
      resumes: resumeCount,
      coverLetters: coverLetterCount,
      interviewSets: interviewSetCount,
      aiRequests: ai.length,
      aiFailed,
      aiCostUsd: Number(aiCost.toFixed(4)),
      usageEvents: usageEventCount,
      usageSessions: usageSessionCount,
    },
    users: {
      total: users.length,
      activeToday,
      activeLast7,
      activeLast30,
      newLast30: newUsers30,
      admins: adminUsers,
      latest: users
        ? userWork
        : [],
    },
    support,
    product: {
      activation: {
        score: activationScore,
        signedUp: users.length,
        completedProfileUsers: completedProfileUsers.size,
        onboarded: completedProfileUsers.size,
        onboardingRate,
        resumeReadyUsers: resumeUsers.size,
        resumeReadyRate,
        firstJobUsers,
        firstJobRate,
        tailoredAssetUsers: tailoredAssetUsers.size,
        tailoredAssetRate,
        appliedUsers: appliedUsers.size,
        appliedUserRate,
        activatedUsers: activationMovedForward.size,
        activatedRate: activationScore,
        largestDropOff,
        funnel: activationFunnel,
        bottlenecks: activationBottlenecks,
      },
      modules,
      moduleEngagement,
      plans: planRows,
      insights,
    },
    retention: {
      activeToday,
      activeLast7,
      activeLast30,
      stickiness: pct(activeLast7, Math.max(1, activeLast30)),
      avgPipelinePerActiveUser: Number((applicationCount / Math.max(1, activeLast7)).toFixed(1)),
      avgAiCallsPerActiveUser: Number((ai.length / Math.max(1, activeLast7)).toFixed(1)),
      usageEvents: usageEvents.length,
      usageSessions: usageSessions.length,
      activeSessions: activeSessionCount,
      avgSessionSeconds,
      avgSessionMinutes: Number((avgSessionSeconds / 60).toFixed(1)),
      avgRoutesPerSession,
      avgEventsPerSession,
      avgSessionDepth: avgRoutesPerSession,
      sessionsByDevice,
      sessionsByBrowser,
      sessionsByPreviewMode,
      topRoutes,
      topModules,
      dailyActive,
      cohorts,
      cohortRetention,
      cohortSummary,
    },
    funnel: {
      stages: stageCounts,
      savedToAppliedRate: pct(stageCounts.applied + stageCounts.interview + stageCounts.offer, Math.max(1, applicationCount)),
      interviewRate: pct(stageCounts.interview + stageCounts.offer, Math.max(1, applicationCount)),
      offerRate: pct(stageCounts.offer, Math.max(1, applicationCount)),
      recentApplications,
      staleSaved: staleSavedRows,
    },
    ai: {
      requests: ai.length,
      success: aiSuccess,
      failed: aiFailed,
      failureRate: pct(aiFailed, Math.max(1, ai.length)),
      avgLatencyMs: avgLatency,
      costUsd: Number(aiCost.toFixed(4)),
      bySkill: aiBySkill,
      byProvider: aiByProvider,
      budget: {
        monthlyRunRateUsd: Number(aiCost.toFixed(4)),
        costPerRequestUsd: ai.length ? Number((aiCost / ai.length).toFixed(5)) : 0,
        status: aiCost > 25 ? "watch" : "normal",
      },
      recentFailures,
    },
    jobFeed: {
      savedJobs: savedJobCount,
      sources: sourceRowsWithDiagnostics,
      latestSavedAt: jobs[0]?.saved_at || null,
      sourceIssues,
      quality: {
        issueRate: qualityIssueRate,
        healthySources: sourceRowsWithDiagnostics.filter((row) => row.status === "healthy").length,
        staleSources: sourceRowsWithDiagnostics.filter((row) => row.status === "stale").length,
        reviewSources: sourceRowsWithDiagnostics.filter((row) => row.status === "review").length,
      },
    },
    activity,
    alerts,
    // Phase E1: Command Center top-level blocks. The new Command Center
    // section reads these directly; older sections continue to read their
    // own per-section fields untouched.
    northStar,
    aarrr,
    priorities,
    weeklyChanges,
    outcomes: outcomesBlock,
    // Phase E2: Growth & Acquisition board reads this.
    growth: growthBlock,
    operations: {
      staleSaved: staleSavedRows.length,
      sourceIssueCount: sourceIssues.length,
      latestSavedAgeDays: latestSavedAge,
      aiFailureRate: failureRate,
      staleDataSignals: freshnessSignals.length,
    },
    diagnostics: {
      warnings,
      dataFreshness,
      privacyControls: ADMIN_PRIVACY_CONTROLS,
      exportManifest,
    },
    reports,
    controlCenter,
  });
});
