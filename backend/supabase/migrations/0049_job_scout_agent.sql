-- 0049: Job Scout Agent (Phase 1 — manual scans)
--
-- A per-user background "scout" that runs the existing job-search pipeline
-- (jobs-search + external-search + companies-search) on demand, delta-detects
-- genuinely NEW postings via a seen-fingerprint ledger, and delivers them to a
-- dashboard inbox for review → save → Apply-with-AI.
--
-- Phase 1 scope: one agent per user, manual "Scan now" trigger from the
-- dashboard. The cadence column is stored now so Phase 2 (cron scheduling)
-- is a data change, not a schema change.
--
-- SECURITY MODEL: RLS is ENABLED on all three tables with NO user policies —
-- deny-by-default. ALL access goes through the `job-scout` edge function,
-- which authenticates the caller (getAuthedUser) and enforces ownership
-- before using the service-role client. This matches the codebase pattern
-- (no client-side PostgREST table access anywhere in v2).

create table if not exists public.job_scout_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Job Agent',
  target_titles text[] not null default '{}',
  must_have_skills text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  seniority text not null default 'any',
  location text not null default '',
  location_strictness text not null default 'balanced',
  work_mode text not null default 'any',            -- any | remote | onsite
  active boolean not null default true,
  cadence text not null default 'manual',           -- Phase 1: manual. Phase 2: daily | hourly
  max_per_scan int not null default 30,
  last_run_at timestamptz,
  last_run_stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Phase 1: exactly one agent per user (multi-agent is Phase 4).
create unique index if not exists job_scout_agents_user_uniq
  on public.job_scout_agents (user_id);

-- Delta ledger: which job fingerprints has this agent already surfaced?
-- Fingerprint = normalized listing URL (fallback company|title|location).
create table if not exists public.job_scout_seen (
  agent_id uuid not null references public.job_scout_agents(id) on delete cascade,
  fingerprint text not null,
  first_seen_at timestamptz not null default now(),
  primary key (agent_id, fingerprint)
);

-- The user's inbox: NEW jobs the agent delivered, with review status and
-- (client-computed in Phase 1) resume-fit annotations.
create table if not exists public.job_scout_findings (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.job_scout_agents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null,
  job jsonb not null,                               -- compact canonical job (title/company/url/...)
  fit_score int,
  fit_summary text,
  fit_reasons jsonb,
  status text not null default 'new',               -- new | saved | applied | dismissed
  found_at timestamptz not null default now(),
  unique (agent_id, fingerprint)
);

create index if not exists job_scout_findings_user_idx
  on public.job_scout_findings (user_id, status, found_at desc);

alter table public.job_scout_agents enable row level security;
alter table public.job_scout_seen enable row level security;
alter table public.job_scout_findings enable row level security;
-- Intentionally no policies: service-role-only via the job-scout function.
