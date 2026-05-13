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
  const dailyActive = Array.from({ length: 30 }).map((_, index) => {
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
  const topRoutes = toRows(routeMap).slice(0, 8);
  const topModules = toRows(moduleMap).slice(0, 8);
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

  const sourceRows = toRows(groupCount(jobs, "source")).slice(0, 12).map((row) => {
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
  const cohortRetention = Array.from({ length: 8 }).map((_, index) => {
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

  const incidents = alerts
    .filter((alert) => alert.title !== "No critical admin alerts")
    .map((alert, index) => ({
      id: `ops-${index + 1}`,
      status: "open",
      severity: alert.severity,
      title: alert.title,
      affectedArea: alert.section,
      detectedAt: new Date().toISOString(),
      action: alert.action,
      runbookId: runbookFor(alert.section),
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
