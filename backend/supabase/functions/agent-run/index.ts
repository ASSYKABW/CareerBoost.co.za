// POST /functions/v1/agent-run
// Body: { agent?: "console", prompt: string, budgetUsd?: number }
// Auth: admin role + AAL2/MFA (getAuthedAdmin) + CSRF nonce (spends API money)
//       + per-operator rate limit.
//
// The Console Assistant (Phase A of CareerBoost Command): an agent that
// investigates operator questions ("why did AI spend jump this week?",
// "which channel converts best?", "what's lerato's quota usage?") using an
// ALLOWLISTED, READ-ONLY toolbox over the same tables the Console reads.
// It cannot mutate anything — action tools arrive with the Ops Resolver
// (Phase C) behind the autonomy dial.
//
// Every run is persisted to agent_runs (transcript, turns, cost) with a hard
// per-run budget cap enforced by the runtime (_shared/agent.ts).
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { runAgent, type AgentTool } from "../_shared/agent.ts";
import { getRuntimeConfig, type AiRouteOverride } from "../_shared/runtime-config.ts";
import { SKILL_ROUTING } from "../_shared/routing.ts";

const DAY_MS = 86_400_000;
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }

const SYSTEM = `You are the CareerBoost Console Assistant — an operations analyst for CareerBoost,
an AI job-search SaaS for South African job seekers (resume tailoring, cover letters, mock
interviews, company research; plans: Free, Plus R210/mo, Pro R380/mo, Career R699/mo; Paystack
billing in ZAR).

You answer the operator's questions by calling the read-only tools, then give a short,
concrete, numbers-first answer. Rules:
- ALWAYS ground claims in tool results; never invent numbers. If data is empty, say so.
- Be brief: a few sentences or a compact list. Lead with the answer, then the evidence.
- When you spot something actionable, end with one clear recommendation.
- You cannot change anything — if asked to act, explain what the operator should do in the
  Console (e.g. Model Control panel, Users drawer) instead.`;

function buildTools(): AgentTool[] {
  const svc = getServiceClient();
  return [
    {
      name: "get_pulse",
      description: "Topline numbers for a period: signups, active paid subs + MRR (ZAR), AI calls/failures, open incidents.",
      inputSchema: { type: "object", properties: { days: { type: "number", description: "lookback window in days (1-30, default 7)" } } },
      run: async (input) => {
        const days = Math.min(30, Math.max(1, Number(input.days) || 7));
        const since = isoAgo(days);
        const out: Record<string, unknown> = { windowDays: days };
        try { const { count } = await svc.from("profiles").select("user_id", { count: "exact", head: true }).gte("created_at", since); out.signups = count || 0; } catch { out.signups = "unavailable"; }
        try {
          const { data } = await svc.from("subscriptions").select("plan_id,status").neq("plan_id", "free").limit(20000);
          const active = (data || []).filter((s: Record<string, unknown>) => ["active", "trialing", "past_due"].includes(String(s.status)));
          const price: Record<string, number> = { plus: 210, pro: 380, career: 699 };
          out.activePaid = active.length;
          out.mrrZar = active.reduce((s: number, r: Record<string, unknown>) => s + (price[String(r.plan_id)] || 0), 0);
          out.pastDue = (data || []).filter((s: Record<string, unknown>) => s.status === "past_due").length;
        } catch { out.activePaid = "unavailable"; }
        try {
          const { data } = await svc.from("ai_usage").select("status").gte("created_at", since).limit(60000);
          out.aiCalls = (data || []).length;
          out.aiFailed = (data || []).filter((r: Record<string, unknown>) => r.status === "failed").length;
        } catch { out.aiCalls = "unavailable"; }
        try {
          const { data } = await svc.from("admin_incidents").select("title,severity").eq("status", "open").limit(10);
          out.openIncidents = (data || []).map((i: Record<string, unknown>) => i.severity + ": " + i.title);
        } catch { out.openIncidents = []; }
        return out;
      },
    },
    {
      name: "get_ai_usage_breakdown",
      description: "AI usage over a window grouped by skill AND by model: calls, failures, input/output tokens (cost proxy).",
      inputSchema: { type: "object", properties: { days: { type: "number", description: "lookback window in days (1-30, default 7)" } } },
      run: async (input) => {
        const days = Math.min(30, Math.max(1, Number(input.days) || 7));
        const { data } = await svc.from("ai_usage")
          .select("skill,model,status,input_tokens,output_tokens")
          .gte("created_at", isoAgo(days)).limit(60000);
        const rows = (data || []) as Array<Record<string, unknown>>;
        function agg(key: "skill" | "model") {
          const m: Record<string, { calls: number; failed: number; inTok: number; outTok: number }> = {};
          for (const r of rows) {
            const k = String(r[key] || "unknown");
            const a = (m[k] = m[k] || { calls: 0, failed: 0, inTok: 0, outTok: 0 });
            a.calls++; if (r.status === "failed") a.failed++;
            a.inTok += Number(r.input_tokens) || 0; a.outTok += Number(r.output_tokens) || 0;
          }
          return Object.entries(m).sort((a, b) => b[1].calls - a[1].calls).slice(0, 10)
            .map(([k, v]) => ({ [key]: k, ...v }));
        }
        return { windowDays: days, totalCalls: rows.length, bySkill: agg("skill"), byModel: agg("model") };
      },
    },
    {
      name: "get_growth",
      description: "Acquisition channels (signups + activation conv%) and the signup->onboarded->paid funnel over 30 days.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const since = isoAgo(30);
        const { data } = await svc.from("profiles")
          .select("user_id,onboarding_completed,utm_source,referrer_host")
          .gte("created_at", since).limit(20000);
        const rows = (data || []) as Array<Record<string, unknown>>;
        const chan: Record<string, { signups: number; activated: number }> = {};
        for (const p of rows) {
          const c = String(p.utm_source || p.referrer_host || "direct").toLowerCase();
          const a = (chan[c] = chan[c] || { signups: 0, activated: 0 });
          a.signups++; if (p.onboarding_completed === true) a.activated++;
        }
        let paid = 0;
        try {
          const { data: subs } = await svc.from("subscriptions").select("status,plan_id,created_at").neq("plan_id", "free").gte("created_at", since).limit(20000);
          paid = (subs || []).filter((s: Record<string, unknown>) => ["active", "trialing", "past_due"].includes(String(s.status))).length;
        } catch { /* keep 0 */ }
        return {
          windowDays: 30, signups: rows.length,
          onboarded: rows.filter((p) => p.onboarding_completed === true).length,
          newPaid: paid,
          channels: Object.entries(chan).sort((a, b) => b[1].signups - a[1].signups).slice(0, 8)
            .map(([c, v]) => ({ channel: c, ...v })),
        };
      },
    },
    {
      name: "find_user",
      description: "Find users by email or name substring. Returns id, email, plan, and 90d activity stats.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "email or name substring" } }, required: ["query"] },
      run: async (input) => {
        const q = String(input.query || "").toLowerCase().trim().slice(0, 100);
        if (!q) return { error: "query required" };
        const matches: Array<Record<string, unknown>> = [];
        let page = 1;
        for (;;) {
          const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) return { error: error.message };
          const batch = ((data?.users || []) as unknown) as Array<Record<string, unknown>>;
          for (const u of batch) {
            if (String(u.email || "").toLowerCase().includes(q)) matches.push(u);
          }
          if (batch.length < 1000 || page >= 5 || matches.length >= 5) break;
          page++;
        }
        const out: Array<Record<string, unknown>> = [];
        for (const u of matches.slice(0, 5)) {
          const id = String(u.id);
          const row: Record<string, unknown> = { id, email: u.email, joined: String(u.created_at || "").slice(0, 10) };
          try { const { data } = await svc.from("subscriptions").select("plan_id,status").eq("user_id", id).maybeSingle(); row.plan = data?.plan_id || "free"; row.planStatus = data?.status || null; } catch { /* skip */ }
          try {
            const { data } = await svc.from("mv_admin_per_user_stats").select("pipeline_count,ai_request_count,session_count,last_activity_at").eq("user_id", id).maybeSingle();
            if (data) { row.pipeline = data.pipeline_count; row.aiCalls90d = data.ai_request_count; row.sessions90d = data.session_count; row.lastActive = String(data.last_activity_at || "").slice(0, 10); }
          } catch { /* skip */ }
          out.push(row);
        }
        return { matches: out, note: matches.length > 5 ? "more matches truncated" : undefined };
      },
    },
    {
      name: "get_model_routing",
      description: "Current LLM routing: smart defaults per skill plus any live admin overrides from Model Control.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const overrides = await getRuntimeConfig<Record<string, AiRouteOverride>>("ai_routing", {});
        const defaults = Object.fromEntries(
          Object.entries(SKILL_ROUTING).map(([s, r]) => [s, r.provider + " · " + r.model]),
        );
        return { adminOverrides: overrides, defaults };
      },
    },
  ];
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const csrf = checkAdminCsrf(req);
  if (!csrf.ok) return errorResponse(csrf.error, csrf.status);

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  const rate = await enforceAdminRate(admin, "agent-run");
  if (!rate.allowed) return errorResponse(rate.reason || "Admin rate limit exceeded.", 429);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON body.", 400); }
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return errorResponse("prompt is required.", 400);
  if (prompt.length > 2000) return errorResponse("prompt too long (max 2000 chars).", 400);

  const result = await runAgent({
    agent: "console",
    system: SYSTEM,
    prompt,
    tools: buildTools(),
    createdBy: admin.id,
    budgetUsd: Math.min(1, Math.max(0.05, Number(body.budgetUsd) || 0.25)),
    maxTurns: 6,
  });

  if (result.status === "failed" && !result.result) {
    return errorResponse(result.error || "Agent run failed.", 502, { runId: result.runId });
  }
  return jsonResponse({ ok: true, ...result });
}));
