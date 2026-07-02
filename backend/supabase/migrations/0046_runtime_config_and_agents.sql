-- =============================================================================
-- Console Phase A: runtime_config (live operator settings) + agent_runs
-- =============================================================================
-- runtime_config: small key→jsonb table for settings the Console changes LIVE
-- (no redeploy). First consumer: key 'ai_routing' — per-skill provider/model
-- overrides read by ai-run via _shared/runtime-config.ts (45s in-isolate
-- cache, so changes propagate in under a minute). Shape:
--   { "resume-tailor": { "provider": "anthropic", "model": "claude-sonnet-5" },
--     "_global":       { "provider": "anthropic" } }
-- Precedence in ai-run: runtime_config (admin live) → env overrides → smart
-- defaults. Every write goes through console-config which audit-logs the
-- change (admin_audit_log) — this table stores only current state.
--
-- agent_runs: one row per Console agent execution (marketing copilot, ops
-- resolver, …). The full step-by-step transcript is appended into steps so
-- every agent action is reviewable after the fact. Budget/cost columns let
-- the runtime hard-stop a run that exceeds its per-run USD cap.
--
-- Both tables are service-role only (RLS on, no policies) — same pattern as
-- the marketing tables: edge functions read/write via service client;
-- anon/authenticated see nothing.
-- =============================================================================

create table if not exists public.runtime_config (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

comment on table public.runtime_config is
  'Live operator settings read by edge functions (45s cache). ai_routing = per-skill LLM overrides set from the Console Model Control panel. Writes are audit-logged by console-config.';

alter table public.runtime_config enable row level security;
-- No policies: service-role only.

create table if not exists public.agent_runs (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,                          -- 'marketing' | 'resolver' | ...
  status      text not null default 'running'
              check (status in ('running', 'done', 'failed', 'cancelled', 'over_budget')),
  autonomy    text not null default 'suggest'
              check (autonomy in ('suggest', 'approve', 'auto')),
  prompt      text,                                    -- operator's instruction
  steps       jsonb not null default '[]'::jsonb,      -- [{at, type, tool?, input?, output?, text?}]
  result      text,                                    -- final agent answer/summary
  error       text,
  turns       int not null default 0,
  budget_usd  numeric(8,4) not null default 0.50,      -- hard per-run cap
  cost_usd    numeric(8,4) not null default 0,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

comment on table public.agent_runs is
  'Console agent executions with full step transcript, per-run budget cap, and outcome. Written by the agent runtime (_shared/agent.ts); read by the Console.';

create index if not exists agent_runs_agent_created_idx
  on public.agent_runs (agent, created_at desc);

alter table public.agent_runs enable row level security;
-- No policies: service-role only.
