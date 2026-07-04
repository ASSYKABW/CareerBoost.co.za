// POST /functions/v1/console-users
// Body: { action?: "list" | "detail", q?, page?, perPage?, userId?, mock? }
// Auth: admin role + AAL2/MFA (getAuthedAdmin).
//
// Powers the Console "Users" section (Phase 2).
//   • list   → paginated accounts + search (email / name substring), joined
//              with per-user stats (mv_admin_per_user_stats) and live plan
//              (subscriptions). Mirrors admin-users' in-memory approach.
//   • detail → one user: identity, subscription, this-month quota usage
//              (ai_usage counts vs plan_catalog limits), and a recent
//              activity timeline (usage_events).
//
// Read-only. Mutations (adjust quota / grant promo / promote / suspend) stay in
// the existing proven endpoints (admin-user-adjust, admin-promo, admin-promote-
// user) — the Console FE calls those directly. Every block is isolated in
// try/catch; {mock:true} returns fixtures.
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";

const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 25;

// Skill → quota key (mirrors ai-run's SKILL_TO_QUOTA) and human labels.
const SKILL_TO_QKEY: Record<string, string> = {
  "resume-tailor": "ai_resumes", "cover-letter-generate": "ai_covers",
  "interview-session-step": "ai_mocks", "interview-intel-pack": "ai_research",
  "interview-coach": "ai_question_banks", "bullet-strengthen": "ai_bullets",
};
const QUOTA_LABELS: Record<string, string> = {
  ai_resumes: "AI resume tailors", ai_covers: "Cover letters", ai_mocks: "Mock interviews",
  ai_research: "Company research", ai_question_banks: "Question banks", ai_bullets: "Bullet strengthens",
};
function planTone(plan: string): string { return plan === "free" ? "dim" : plan === "career" ? "violet" : "cyan"; }
function titleCase(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

const MOCK = {
  users: [
    { id: "u1", name: "Lerato Mokoena", email: "lerato@example.com", plan: "pro", planTone: "cyan", joined: "2026-03-02", lastActive: "2026-06-29", aiCalls: 142, pipeline: 12, status: "active" },
    { id: "u2", name: "Sipho Khumalo", email: "sipho@example.com", plan: "career", planTone: "violet", joined: "2026-02-14", lastActive: "2026-06-30", aiCalls: 98, pipeline: 8, status: "active" },
    { id: "u3", name: "Naledi Pillay", email: "naledi@example.com", plan: "plus", planTone: "cyan", joined: "2026-05-20", lastActive: "2026-06-28", aiCalls: 54, pipeline: 5, status: "active" },
    { id: "u4", name: "Thabo Nkosi", email: "thabo@example.com", plan: "free", planTone: "dim", joined: "2026-06-25", lastActive: "2026-06-27", aiCalls: 3, pipeline: 1, status: "active" },
  ],
  total: 4,
};
function mockDetail(userId: string) {
  const u = MOCK.users.find((x) => x.id === userId) || MOCK.users[0];
  return {
    id: u.id, name: u.name, email: u.email, joined: u.joined, roles: [], mfa: true,
    plan: u.plan, planStatus: "active",
    quota: [
      { label: "AI resume tailors", used: 8, limit: 10 },
      { label: "Mock interviews", used: 3, limit: 3 },
      { label: "Cover letters", used: 6, limit: 15 },
    ],
    timeline: [
      { event: "resume tailored", when: "2026-06-29", module: "resume" },
      { event: "mock interview", when: "2026-06-28", module: "interview" },
      { event: "job saved", when: "2026-06-27", module: "job-search" },
    ],
    stats: { pipeline: u.pipeline, savedJobs: 14, aiCalls: u.aiCalls, sessions: 21 },
  };
}

Deno.serve(withCors(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const action = String(body.action || "list");
  const svc = getServiceClient();

  if (body.mock === true) {
    return action === "detail"
      ? jsonResponse({ ok: true, detail: { _mock: true, ...mockDetail(String(body.userId || "u1")) } })
      : jsonResponse({ ok: true, _mock: true, ...MOCK, page: 1, perPage: DEFAULT_PER_PAGE });
  }

  // ── DETAIL ────────────────────────────────────────────────────────
  if (action === "detail") {
    const userId = String(body.userId || "").trim();
    if (!userId) return errorResponse("userId required", 400);

    let email = "", joined = "", roles: string[] = [], name = "", mfa = false;
    try {
      const { data } = await svc.auth.admin.getUserById(userId);
      const u = data?.user as unknown as Record<string, unknown> | undefined;
      if (u) {
        email = String(u.email || "");
        joined = String(u.created_at || "").slice(0, 10);
        const app = (u.app_metadata || {}) as Record<string, unknown>;
        roles = ([] as unknown[]).concat(app.role as never).concat(app.roles as never).map((r) => String(r || "").toLowerCase().trim()).filter(Boolean);
        name = String(((u.user_metadata || {}) as Record<string, unknown>).full_name || "");
        mfa = Array.isArray((u as { factors?: unknown[] }).factors) && ((u as { factors?: unknown[] }).factors as unknown[]).length > 0;
      }
    } catch (_e) { /* keep blanks */ }

    let plan = "free", planStatus = "";
    try {
      const { data } = await svc.from("subscriptions").select("plan_id,status").eq("user_id", userId).maybeSingle();
      if (data) { plan = String(data.plan_id || "free"); planStatus = String(data.status || ""); }
    } catch (_e) { /* ignore */ }

    if (!name) { try { const { data } = await svc.from("profiles").select("full_name").eq("user_id", userId).maybeSingle(); if (data?.full_name) name = String(data.full_name); } catch (_e) { /* ignore */ } }

    // Quota: this-month ai_usage counts by skill → key, vs plan_catalog limits.
    const quota: Array<Record<string, unknown>> = [];
    try {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const { data: usage } = await svc.from("ai_usage").select("skill").eq("user_id", userId).gte("created_at", monthStart.toISOString()).limit(10000);
      const used: Record<string, number> = {};
      for (const r of (usage || []) as Array<Record<string, unknown>>) {
        const qk = SKILL_TO_QKEY[String(r.skill)]; if (qk) used[qk] = (used[qk] || 0) + 1;
      }
      let limits: Record<string, unknown> = {};
      try {
        const { data: cat } = await svc.from("plan_catalog").select("limits").eq("plan_id", plan).maybeSingle();
        const lj = (cat?.limits || {}) as Record<string, unknown>;
        limits = (lj.monthly || {}) as Record<string, unknown>;
      } catch (_e) { /* unlimited */ }
      for (const qk of Object.keys(QUOTA_LABELS)) {
        const u = used[qk] || 0;
        const lim = limits[qk];
        if (u === 0 && (lim === undefined || lim === null)) continue; // hide untouched/irrelevant rows
        quota.push({ label: QUOTA_LABELS[qk], used: u, limit: lim === null || lim === undefined ? null : Number(lim) });
      }
    } catch (_e) { /* ignore */ }

    const timeline: Array<Record<string, unknown>> = [];
    try {
      const { data } = await svc.from("usage_events").select("event_name,occurred_at,module").eq("user_id", userId).order("occurred_at", { ascending: false }).limit(15);
      for (const e of (data || []) as Array<Record<string, unknown>>) {
        timeline.push({ event: String(e.event_name || "event").replace(/_/g, " "), when: String(e.occurred_at || "").slice(0, 10), module: String(e.module || "") });
      }
    } catch (_e) { /* ignore */ }

    let stats = { pipeline: 0, savedJobs: 0, aiCalls: 0, sessions: 0 };
    try {
      const { data } = await svc.from("mv_admin_per_user_stats").select("pipeline_count,saved_job_count,ai_request_count,session_count").eq("user_id", userId).maybeSingle();
      if (data) stats = { pipeline: Number(data.pipeline_count) || 0, savedJobs: Number(data.saved_job_count) || 0, aiCalls: Number(data.ai_request_count) || 0, sessions: Number(data.session_count) || 0 };
    } catch (_e) { /* ignore */ }

    return jsonResponse({ ok: true, detail: { id: userId, name: name || email.split("@")[0], email, joined, roles, mfa, plan: titleCase(plan), planStatus, quota, timeline, stats } });
  }

  // ── LIST (+ search) ───────────────────────────────────────────────
  const page = Math.max(1, Number(body.page) || 1);
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, Number(body.perPage) || DEFAULT_PER_PAGE));
  const q = String(body.q || "").toLowerCase().trim().slice(0, 200);

  // auth.users (paged, capped at 5000 like admin-users)
  const users: Array<Record<string, unknown>> = [];
  try {
    let p = 1;
    for (;;) {
      const { data, error } = await svc.auth.admin.listUsers({ page: p, perPage: 1000 });
      if (error) throw error;
      const batch = (data?.users || []) as unknown as Array<Record<string, unknown>>;
      users.push(...batch);
      if (batch.length < 1000 || users.length >= 5000) break;
      p += 1;
    }
  } catch (err) {
    return errorResponse("Unable to list users: " + ((err as Error).message || "unknown"), 502);
  }

  const nameById = new Map<string, string>();
  try {
    const { data } = await svc.from("profiles").select("user_id,full_name");
    for (const r of (data || []) as Array<Record<string, unknown>>) if (r.user_id) nameById.set(String(r.user_id), String(r.full_name || ""));
  } catch (_e) { /* ignore */ }

  const planById = new Map<string, string>();
  try {
    const { data } = await svc.from("subscriptions").select("user_id,plan_id,status");
    for (const r of (data || []) as Array<Record<string, unknown>>) {
      if (r.user_id && r.plan_id && (r.status === "active" || r.status === "trialing" || r.status === "past_due")) planById.set(String(r.user_id), String(r.plan_id));
    }
  } catch (_e) { /* ignore */ }

  const statsById = new Map<string, Record<string, unknown>>();
  try {
    const { data } = await svc.from("mv_admin_per_user_stats").select("user_id,pipeline_count,ai_request_count,last_activity_at");
    for (const r of (data || []) as Array<Record<string, unknown>>) if (r.user_id) statsById.set(String(r.user_id), r);
  } catch (_e) { /* ignore */ }

  let rows = users.map((u) => {
    const id = String(u.id || "");
    const email = String(u.email || "");
    const name = nameById.get(id) || email.split("@")[0];
    const plan = planById.get(id) || "free";
    const st = statsById.get(id) || {};
    return {
      id, email, name, plan: titleCase(plan), planTone: planTone(plan),
      joined: String(u.created_at || "").slice(0, 10),
      lastActive: String(st.last_activity_at || "").slice(0, 10),
      aiCalls: Number(st.ai_request_count) || 0,
      pipeline: Number(st.pipeline_count) || 0,
      status: "active",
    };
  });

  if (q) rows = rows.filter((r) => r.email.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  rows.sort((a, b) => (b.lastActive || "").localeCompare(a.lastActive || ""));

  const total = rows.length;
  const start = (page - 1) * perPage;
  return jsonResponse({ ok: true, users: rows.slice(start, start + perPage), total, page, perPage });
}));
