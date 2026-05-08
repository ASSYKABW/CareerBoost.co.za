-- =============================================================================
-- Phase 1: AI cost tracking + response cache + per-user rate limits
-- =============================================================================
-- Adds:
--   1. cost columns + cache token tracking on ai_usage
--   2. ai_response_cache table (hash-keyed dedup of identical AI requests)
--   3. ai_rate_limits table (per-user-per-day-per-skill counter + cost cap)
-- All idempotent. No data loss on rerun.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Cost & cache tracking on ai_usage
-- -----------------------------------------------------------------------------
alter table public.ai_usage
  add column if not exists cost_usd                numeric(12,6),
  add column if not exists input_tokens_cached     integer,
  add column if not exists cache_creation_tokens   integer,
  add column if not exists cache_hit               boolean
    generated always as (coalesce(input_tokens_cached, 0) > 0) stored;

-- Skill-level rollups for the upcoming admin dashboard.
create index if not exists ai_usage_skill_created_idx
  on public.ai_usage (skill, created_at desc);
create index if not exists ai_usage_user_skill_created_idx
  on public.ai_usage (user_id, skill, created_at desc);

comment on column public.ai_usage.cost_usd is
  'Cost of this single LLM call in USD, computed at insert time from per-model pricing.';
comment on column public.ai_usage.cache_creation_tokens is
  'Tokens written to the prompt cache on this call (one-time upfront cost on first hit).';
comment on column public.ai_usage.input_tokens_cached is
  'Tokens served from the prompt cache (90% discount on Anthropic, paid separately).';

-- -----------------------------------------------------------------------------
-- 2. ai_response_cache — dedup of identical AI requests
-- -----------------------------------------------------------------------------
-- Keyed by sha256(skill + canonicalized_input_json). Stores the full envelope
-- so a cache hit can return without ever calling the LLM. RLS is intentionally
-- closed — the table is service-role only; the Edge Function reads/writes via
-- the service client.
create table if not exists public.ai_response_cache (
  cache_key       text primary key,
  skill           text not null,
  envelope        jsonb not null,
  prompt_version  text,
  hit_count       integer not null default 0,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);
create index if not exists ai_response_cache_expires_idx
  on public.ai_response_cache (expires_at);
create index if not exists ai_response_cache_skill_idx
  on public.ai_response_cache (skill, created_at desc);

alter table public.ai_response_cache enable row level security;
-- Drop+recreate is idempotent; this is service-role only by design.
drop policy if exists "ai_response_cache_no_user_access" on public.ai_response_cache;
create policy "ai_response_cache_no_user_access"
  on public.ai_response_cache for all to authenticated
  using (false) with check (false);

comment on table public.ai_response_cache is
  'Service-role-only response cache for idempotent AI skill calls. Keyed on sha256(skill+canonical_input).';

-- -----------------------------------------------------------------------------
-- 3. ai_rate_limits — per-user daily counter + spend cap
-- -----------------------------------------------------------------------------
-- One row per (user, day, skill). Edge Function increments via
-- increment_ai_rate_limit() RPC; checks before each LLM call.
create table if not exists public.ai_rate_limits (
  user_id     uuid not null references auth.users(id) on delete cascade,
  bucket      date not null,
  skill       text not null,
  count       integer not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  primary key (user_id, bucket, skill)
);
create index if not exists ai_rate_limits_bucket_idx
  on public.ai_rate_limits (bucket);

alter table public.ai_rate_limits enable row level security;
drop policy if exists "ai_rate_limits_owner_select" on public.ai_rate_limits;
create policy "ai_rate_limits_owner_select"
  on public.ai_rate_limits for select to authenticated
  using (user_id = auth.uid());
-- Writes go through service role only (server-side increment).
drop policy if exists "ai_rate_limits_no_user_writes" on public.ai_rate_limits;
create policy "ai_rate_limits_no_user_writes"
  on public.ai_rate_limits for insert to authenticated with check (false);

-- RPC: atomic upsert+increment used after each successful LLM call.
create or replace function public.increment_ai_rate_limit(
  p_user uuid,
  p_skill text,
  p_cost numeric default 0
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_rate_limits (user_id, bucket, skill, count, cost_usd)
  values (p_user, current_date, p_skill, 1, coalesce(p_cost, 0))
  on conflict (user_id, bucket, skill) do update
    set count    = public.ai_rate_limits.count    + 1,
        cost_usd = public.ai_rate_limits.cost_usd + coalesce(excluded.cost_usd, 0);
$$;

comment on table public.ai_rate_limits is
  'Per-user-per-day-per-skill counter for rate-limit + cost-cap enforcement.';
comment on function public.increment_ai_rate_limit(uuid, text, numeric) is
  'Atomic counter increment after a successful AI call. Service-role only path.';
