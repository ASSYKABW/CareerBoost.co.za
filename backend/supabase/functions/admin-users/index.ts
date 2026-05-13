// POST /functions/v1/admin-users
// Body: { page?: number, perPage?: number, sort?: "health"|"activity"|"created"|"pipeline", filter?: string }
// Returns paginated user accounts + support queue powered by mv_admin_per_user_stats.
//
// Phase B context:
//   The legacy admin-overview function pulled up to 5,000 users + 5,000 profiles
//   + 5,000 resumes/cover-letters/interviews on every dashboard load, processed
//   them in-memory, and shipped only the top 25 to the frontend. That's wasteful
//   at any scale beyond a few hundred users. This endpoint:
//     - Reads pre-aggregated counts from mv_admin_per_user_stats (refreshed nightly).
//     - Pages auth.users via the Supabase admin API.
//     - Joins per-user metadata via a single profile lookup for the visible page.
//     - Returns ~50 users at a time instead of 25 fixed top-of-list.
//
// Auth: same admin gate as admin-overview (getAuthedAdmin).

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 50;

interface Body {
  page?: number;
  perPage?: number;
  sort?: string;
  filter?: string;
}

function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function daysSince(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / DAY_MS));
}

function rolesFromAppMetadata(meta: unknown): string[] {
  const appMeta = meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
  return ([] as unknown[])
    .concat(appMeta.role as never)
    .concat(appMeta.roles as never)
    .map((role) => String(role || "").toLowerCase().trim())
    .filter(Boolean);
}

interface StatsRow {
  user_id: string;
  pipeline_count: number;
  applied_count: number;
  saved_job_count: number;
  ai_request_count: number;
  ai_failed_count: number;
  session_count: number;
  onboarding_completed: boolean;
  plan: string;
  last_activity_at: string;
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

  let body: Body = {};
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Body;
    } catch {
      body = {};
    }
  }

  const page = Math.max(1, Number(body.page) || 1);
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, Number(body.perPage) || DEFAULT_PER_PAGE));
  const sort = (body.sort || "health").toString();
  const filter = (body.filter || "").toString().toLowerCase().trim();

  const svc = getServiceClient();
  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();

  // ---------------------------------------------------------------------------
  // Page auth.users via the admin API. Each Supabase call returns up to 1000;
  // we walk pages until we hit ~5000 then cap (admin lists rarely exceed that).
  // ---------------------------------------------------------------------------
  const users: Array<Record<string, unknown>> = [];
  try {
    let p = 1;
    const apiPageSize = 1000;
    for (;;) {
      const { data, error } = await svc.auth.admin.listUsers({ page: p, perPage: apiPageSize });
      if (error) throw error;
      const batch = (data?.users || []) as unknown as Array<Record<string, unknown>>;
      users.push(...batch);
      if (batch.length < apiPageSize || users.length >= 5000) break;
      p += 1;
    }
  } catch (err) {
    warnings.push("auth.users: " + ((err as Error).message || "unable to list users"));
  }

  const totalUsers = users.length;

  // ---------------------------------------------------------------------------
  // Read pre-aggregated per-user stats from the MV. Index it by user_id so we
  // can join in O(1) below. If the MV is empty (initial-deploy state), we'll
  // just return zeros for those columns — better than not shipping the row.
  // ---------------------------------------------------------------------------
  const statsById = new Map<string, StatsRow>();
  try {
    const { data, error } = await svc
      .from("mv_admin_per_user_stats")
      .select("*");
    if (error) {
      warnings.push("mv_admin_per_user_stats: " + error.message);
    } else if (Array.isArray(data)) {
      data.forEach((row) => {
        const r = row as StatsRow;
        if (r.user_id) statsById.set(r.user_id, r);
      });
    }
  } catch (err) {
    warnings.push("mv_admin_per_user_stats: " + ((err as Error).message || "read failed"));
  }

  // ---------------------------------------------------------------------------
  // Compute per-user account rows. Each row blends auth.users metadata with
  // the MV stats. Sort + filter + paginate AFTER building the full list so
  // health-based ordering can use computed health scores.
  // ---------------------------------------------------------------------------
  const accounts = users.map((user) => {
    const uid = String(user.id || "");
    const stats = statsById.get(uid) || {
      user_id: uid,
      pipeline_count: 0,
      applied_count: 0,
      saved_job_count: 0,
      ai_request_count: 0,
      ai_failed_count: 0,
      session_count: 0,
      onboarding_completed: false,
      plan: "free",
      last_activity_at: String(user.last_sign_in_at || user.created_at || ""),
    } as StatsRow;

    const inactiveDays = daysSince(stats.last_activity_at);
    const hasResume = false; // resume readiness lives in the resumes table; admin-overview still computes it.
    const blockers: string[] = [];
    if (!stats.onboarding_completed) blockers.push("Onboarding not complete");
    if (!stats.saved_job_count && !stats.pipeline_count) blockers.push("No job captured");
    if (stats.pipeline_count > 0 && stats.applied_count === 0) blockers.push("Saved roles not moved forward");
    if (inactiveDays !== null && inactiveDays > 14) blockers.push("Inactive for 14+ days");
    if (stats.ai_failed_count > 0) blockers.push("AI failures encountered");

    let health = 100;
    if (!stats.onboarding_completed) health -= 15;
    if (!stats.saved_job_count && !stats.pipeline_count) health -= 20;
    if (stats.pipeline_count > 0 && stats.applied_count === 0) health -= 10;
    if (inactiveDays !== null && inactiveDays > 14) health -= 18;
    if (stats.ai_failed_count > 0) health -= 10;
    health = Math.max(0, Math.min(100, health));

    const stage = !stats.onboarding_completed
      ? "onboarding"
      : (!stats.saved_job_count && !stats.pipeline_count)
        ? "job-capture-needed"
        : (stats.pipeline_count > 0 && stats.applied_count === 0)
          ? "saved-only"
          : stats.applied_count > 0
            ? "progressing"
            : "active";

    return {
      id: uid,
      email: user.email || null,
      createdAt: user.created_at || null,
      lastSignInAt: user.last_sign_in_at || null,
      roles: rolesFromAppMetadata(user.app_metadata),
      plan: stats.plan,
      health,
      stage,
      blockers,
      onboardingComplete: stats.onboarding_completed,
      pipelineCount: stats.pipeline_count,
      appliedCount: stats.applied_count,
      savedJobCount: stats.saved_job_count,
      aiRequests: stats.ai_request_count,
      aiFailures: stats.ai_failed_count,
      sessions: stats.session_count,
      inactiveDays,
      lastActivityAt: stats.last_activity_at || null,
      recommendedAction: blockers[0]
        ? `Help user resolve: ${blockers[0]}.`
        : "Keep monitoring; user is moving through the workflow.",
    };
  });

  // ---------------------------------------------------------------------------
  // Filter (email substring or role match) + sort + paginate.
  // ---------------------------------------------------------------------------
  let filtered = accounts;
  if (filter) {
    filtered = accounts.filter((acc) => {
      if (acc.email && String(acc.email).toLowerCase().includes(filter)) return true;
      if (acc.roles.some((role) => role.includes(filter))) return true;
      if (String(acc.stage).toLowerCase().includes(filter)) return true;
      return false;
    });
  }

  // Default sort: lowest health first (= "at risk first"). Alternatives below.
  filtered.sort((a, b) => {
    if (sort === "activity") {
      const da = Date.parse(String(a.lastActivityAt || "")) || 0;
      const db = Date.parse(String(b.lastActivityAt || "")) || 0;
      return db - da;
    }
    if (sort === "created") {
      const da = Date.parse(String(a.createdAt || "")) || 0;
      const db = Date.parse(String(b.createdAt || "")) || 0;
      return db - da;
    }
    if (sort === "pipeline") {
      return b.pipelineCount - a.pipelineCount;
    }
    // health (default)
    return a.health - b.health || (b.inactiveDays || 0) - (a.inactiveDays || 0);
  });

  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / perPage));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  // ---------------------------------------------------------------------------
  // Aggregated queue counts (for the support-queue header chips).
  // ---------------------------------------------------------------------------
  const queues = {
    atRisk:           accounts.filter((acc) => acc.health < 60).length,
    jobCaptureNeeded: accounts.filter((acc) => acc.stage === "job-capture-needed").length,
    savedOnly:        accounts.filter((acc) => acc.stage === "saved-only").length,
    onboarding:       accounts.filter((acc) => acc.stage === "onboarding").length,
    inactive:         accounts.filter((acc) => (acc.inactiveDays || 0) > 14).length,
    aiIssue:          accounts.filter((acc) => acc.aiFailures > 0).length,
  };
  const summary = {
    totalUsers,
    monitored: accounts.length,
    averageHealth: accounts.length
      ? Math.round(accounts.reduce((sum, acc) => sum + acc.health, 0) / accounts.length)
      : 0,
    atRisk: queues.atRisk,
    healthy: accounts.filter((acc) => acc.health >= 75).length,
    newLast30: accounts.filter((acc) => {
      const created = Date.parse(String(acc.createdAt || ""));
      return Number.isFinite(created) && Date.now() - created <= 30 * DAY_MS;
    }).length,
  };

  return jsonResponse({
    ok: true,
    generatedAt,
    access: {
      adminEmail: admin.email,
      roles: admin.roles,
      allowedRoles: admin.allowedRoles,
    },
    page: {
      page: safePage,
      perPage,
      total: totalFiltered,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      sort,
      filter,
    },
    summary,
    queues,
    accounts: pageRows,
    warnings,
    playbooks: [
      { id: "onboarding",        title: "Onboarding follow-up",     action: "Guide the user to complete role, location, and preference setup." },
      { id: "job-capture-needed",title: "First job capture follow-up", action: "Ask the user to run a focused search or install the extension capture." },
      { id: "saved-only",        title: "Saved role conversion follow-up", action: "Prompt the user to tailor resume, create cover letter, and move one saved role to applied." },
      { id: "inactive",          title: "Reactivation follow-up",   action: "Send a short reactivation nudge with the user's most valuable next action." },
      { id: "ai-issue",          title: "AI support follow-up",     action: "Check failed AI calls and advise the user to retry after provider health is confirmed." },
    ],
    privacy: "Support health excludes resume, cover-letter, and interview document body text. It uses only workflow metadata and readiness flags.",
  });
});
