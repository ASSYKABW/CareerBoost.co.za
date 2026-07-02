// POST /functions/v1/agent-run
// Body: { agent?: "console" | "marketing", prompt: string, budgetUsd?: number }
// Auth: admin role + AAL2/MFA (getAuthedAdmin) + CSRF nonce (spends API money)
//       + per-operator rate limit.
//
// One endpoint, an allowlisted registry of agents on the shared runtime
// (_shared/agent.ts — budget-capped, bounded, fully ledgered to agent_runs):
//
//   console   — read-only operations analyst. Answers operator questions
//               over the same tables the Console reads. Cannot mutate.
//   marketing — the Marketing Copilot (Phase B). Reads growth + content
//               performance, then WRITES PROPOSALS ONLY: platform-native
//               drafts into social_drafts (status='draft'). Nothing
//               publishes itself — the operator approves + copy-pastes from
//               the Growth section. Every draft carries a UTM link so posted
//               content attributes back into the Growth channel data.
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin, getServiceClient } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { runAgent, type AgentTool } from "../_shared/agent.ts";
import { getRuntimeConfig, type AiRouteOverride } from "../_shared/runtime-config.ts";
import { SKILL_ROUTING } from "../_shared/routing.ts";

const DAY_MS = 86_400_000;
function isoAgo(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }

// ---------------------------------------------------------------------------
// Shared tools
// ---------------------------------------------------------------------------
function growthTool(): AgentTool {
  const svc = getServiceClient();
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Console analyst — read-only ops toolbox
// ---------------------------------------------------------------------------
const SYSTEM_CONSOLE = `You are the CareerBoost Console Assistant — an operations analyst for CareerBoost,
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

function buildConsoleTools(): AgentTool[] {
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
    growthTool(),
    {
      name: "find_user",
      description: "Find users by email substring. Returns id, email, plan, and 90d activity stats.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "email substring" } }, required: ["query"] },
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
          try { const { data } = await svc.from("subscriptions").select("plan_id,status").eq("user_id", id).maybeSingle(); row.plan = data?.plan_id || "free"; } catch { /* skip */ }
          try {
            const { data } = await svc.from("mv_admin_per_user_stats").select("pipeline_count,ai_request_count,last_activity_at").eq("user_id", id).maybeSingle();
            if (data) { row.pipeline = data.pipeline_count; row.aiCalls90d = data.ai_request_count; row.lastActive = String(data.last_activity_at || "").slice(0, 10); }
          } catch { /* skip */ }
          out.push(row);
        }
        return { matches: out };
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

// ---------------------------------------------------------------------------
// Marketing Copilot — product brain + draft-writing toolbox
// ---------------------------------------------------------------------------
const SYSTEM_MARKETING = `You are the CareerBoost Marketing Copilot — a senior growth marketer working
inside the admin console of CareerBoost (careerboost.co.za).

PRODUCT BRAIN
- CareerBoost is an AI job-search command center for South African job seekers: AI resume
  tailoring, cover letters, voice mock interviews (4 AI personas), source-backed company
  research, pipeline tracking (Saved→Applied→Interview→Offer), calendar + follow-up reminders,
  and a Chrome extension. Human-in-control: it never auto-applies for the user.
- Plans (ZAR, Paystack): Free (try the workflow) · Plus R210/mo · Pro R380/mo (voice mock
  interviews — most popular) · Career R699/mo (everything unlimited, priority AI).
- Audience: active SA job seekers — graduates, career changers, professionals tired of
  spray-and-pray applications. Pain: no replies, generic CVs, interview nerves.
- Brand voice: calm, confident, professional, warm. "Your job search, in one calm place."
  Never hypey, never fake-urgency, no invented testimonials or fabricated stats.

YOUR JOB
1. FIRST call get_growth, get_content_performance and get_recent_drafts — ground every
   proposal in what's actually working and avoid repeating recent drafts.
2. Propose 2–4 pieces of content and SAVE EACH ONE with save_draft. Platform-native:
   - linkedin: strong first line (the hook), short paragraphs with line breaks, one clear
     insight or story, soft CTA, 3–5 hashtags (e.g. #JobSearchZA #CVTips #CareerBoost).
   - facebook: conversational, community tone, a question to spark comments.
   - tiktok: a 30–45s video SCRIPT — HOOK (first 3 seconds), 3–4 beats with on-screen text
     cues, closing CTA.
   - x: a punchy thread (3–6 numbered tweets, each <280 chars, first tweet is the hook,
     last tweet is the CTA with the link).
   - instagram: a caption — strong first line (shows before the fold), short story or
     tip list, CTA "link in bio", 5–8 hashtags; add a one-line visual suggestion in
     rationale.
3. Every draft's link MUST be a UTM-tagged URL:
   https://www.careerboost.co.za/?utm_source=<platform>&utm_medium=social&utm_campaign=<short-kebab-slug>
4. In rationale, say WHY this piece, grounded in the data you read.
5. Finish with a 2–3 sentence summary of what you created and the data signal behind it.
Drafts are proposals only — the operator reviews, approves and posts them manually.`;

function buildMarketingTools(adminId: string): AgentTool[] {
  const svc = getServiceClient();
  return [
    growthTool(),
    {
      name: "get_content_performance",
      description: "Published content scorecard: views, clicks, attributed signups per piece.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        try {
          const { data } = await svc.rpc("marketing_content_scorecard");
          return ((data || []) as Array<Record<string, unknown>>).slice(0, 10)
            .map((c) => ({ slug: c.slug, title: c.title, views: c.views, clicks: c.clicks, signups: c.signups }));
        } catch (e) {
          return { note: "scorecard unavailable: " + (e as Error).message };
        }
      },
    },
    {
      name: "get_recent_drafts",
      description: "The 15 most recent social drafts (any status) with attributed SIGNUPS for posted ones — use this to avoid repeats AND to double down on what converted.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        try {
          const { data } = await svc.from("social_drafts")
            .select("platform,status,hook,link,created_at").order("created_at", { ascending: false }).limit(15);
          const drafts = (data || []) as Array<Record<string, unknown>>;
          // Learning loop (#3): signups per posted draft via its utm_campaign.
          const campaignOf = (link: string): string => {
            const m = /[?&]utm_campaign=([^&#]+)/.exec(link || "");
            return m ? decodeURIComponent(m[1]).toLowerCase() : "";
          };
          const slugs = Array.from(new Set(
            drafts.filter((d) => d.status === "posted").map((d) => campaignOf(String(d.link || ""))).filter(Boolean),
          ));
          const counts: Record<string, number> = {};
          if (slugs.length) {
            const { data: profs } = await svc.from("profiles").select("utm_campaign").in("utm_campaign", slugs).limit(20000);
            for (const p of (profs || []) as Array<Record<string, unknown>>) {
              const c = String(p.utm_campaign || "").toLowerCase();
              if (c) counts[c] = (counts[c] || 0) + 1;
            }
          }
          return drafts.map((d) => ({
            platform: d.platform, status: d.status, hook: d.hook,
            created_at: String(d.created_at || "").slice(0, 10),
            signups: d.status === "posted" ? (counts[campaignOf(String(d.link || ""))] || 0) : undefined,
          }));
        } catch {
          return { note: "no drafts table yet (migration 0047 pending) — proceed fresh" };
        }
      },
    },
    {
      name: "save_draft",
      description: "Save ONE content proposal to the operator's approval queue (status=draft; never publishes).",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["linkedin", "facebook", "tiktok", "x", "instagram"] },
          hook: { type: "string", description: "headline / first line / TikTok hook (<=200 chars)" },
          body: { type: "string", description: "full post text or video script (<=3000 chars)" },
          hashtags: { type: "string", description: "space-separated hashtags" },
          link: { type: "string", description: "UTM-tagged careerboost.co.za URL" },
          rationale: { type: "string", description: "data-grounded reason for this piece (<=400 chars)" },
        },
        required: ["platform", "body"],
      },
      run: async (input) => {
        const platform = String(input.platform || "").toLowerCase();
        if (!["linkedin", "facebook", "tiktok", "x", "instagram"].includes(platform)) return { error: "invalid platform" };
        const body = String(input.body || "").slice(0, 3000);
        if (body.length < 40) return { error: "body too short" };
        const link = String(input.link || "").slice(0, 300);
        if (link && !/^https:\/\/(www\.)?careerboost\.co\.za\//.test(link)) {
          return { error: "link must point at careerboost.co.za" };
        }
        const { data, error } = await svc.from("social_drafts").insert({
          platform, body,
          hook: String(input.hook || "").slice(0, 200) || null,
          hashtags: String(input.hashtags || "").slice(0, 200) || null,
          link: link || null,
          rationale: String(input.rationale || "").slice(0, 400) || null,
          created_by: adminId || null, // null on autopilot (cron) runs
        }).select("id").single();
        if (error) return { error: "save failed: " + error.message + " (is migration 0047 applied?)" };
        return { ok: true, id: data?.id, platform };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Registry + handler
// ---------------------------------------------------------------------------
interface AgentDef {
  system: string;
  buildTools: (adminId: string) => AgentTool[];
  defaultBudget: number;
  maxBudget: number;
  maxTurns: number;
}
const AGENTS: Record<string, AgentDef> = {
  console: { system: SYSTEM_CONSOLE, buildTools: () => buildConsoleTools(), defaultBudget: 0.25, maxBudget: 1, maxTurns: 6 },
  marketing: { system: SYSTEM_MARKETING, buildTools: (id) => buildMarketingTools(id), defaultBudget: 0.4, maxBudget: 1.5, maxTurns: 8 },
};

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  // #5 Weekly autopilot: the scheduler authenticates with X-Cron-Secret
  // (same pattern as promo-cron/marketing-cron). Cron runs are restricted to
  // the MARKETING agent (proposal-writing only — never the ops toolbox),
  // skip CSRF/rate-limit (no browser, no operator), and ledger with
  // created_by = null so autopilot runs are distinguishable in agent_runs.
  const cronSecret = (Deno.env.get("CRON_SECRET") || "").trim();
  const providedSecret = (req.headers.get("X-Cron-Secret") || "").trim();
  const isCron = Boolean(cronSecret && providedSecret === cronSecret);

  let adminId: string | null = null;
  if (!isCron) {
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
    adminId = admin.id;
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON body.", 400); }
  const agentName = String(body.agent || "console");
  if (isCron && agentName !== "marketing") {
    return errorResponse("Cron runs are limited to the marketing agent.", 403);
  }
  const def = AGENTS[agentName];
  if (!def) return errorResponse("Unknown agent: " + agentName, 400);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return errorResponse("prompt is required.", 400);
  if (prompt.length > 2000) return errorResponse("prompt too long (max 2000 chars).", 400);

  const result = await runAgent({
    agent: agentName,
    system: def.system,
    prompt,
    tools: def.buildTools(adminId || ""),
    createdBy: adminId,
    budgetUsd: Math.min(def.maxBudget, Math.max(0.05, Number(body.budgetUsd) || def.defaultBudget)),
    maxTurns: def.maxTurns,
    maxTokens: agentName === "marketing" ? 2400 : 1200,
  });

  if (result.status === "failed" && !result.result) {
    return errorResponse(result.error || "Agent run failed.", 502, { runId: result.runId });
  }
  return jsonResponse({ ok: true, ...result });
}));
