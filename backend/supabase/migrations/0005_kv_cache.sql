-- =============================================================================
-- Phase 3: Generic key-value cache for paid third-party API responses
-- =============================================================================
-- Used by:
--   - company-intel-search → caches Google CSE result sets per (company, role)
--   - jobs-search          → caches Adzuna multi-country fan-out per (query, filters)
--
-- Why a separate table from ai_response_cache (0004):
--   - Different consumers, different TTL distributions (24h vs 30d typical)
--   - Separate hit-count rollups for cost analytics per integration
--   - Avoids a noisy_neighbor between AI cache misses and CSE rate budget
--
-- Schema:
--   namespace : "cse" | "adzuna" | "muse" — lets us partition by integration
--   cache_key : sha256 hex digest of canonicalized request key
--   payload   : the upstream response body (jsonb)
--   expires_at: TTL upper bound (rows past this are dead)
--   hit_count : how many cache hits this row has served (observability)
-- =============================================================================

create table if not exists public.kv_cache (
  namespace   text not null,
  cache_key   text not null,
  payload     jsonb not null,
  hit_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (namespace, cache_key)
);

create index if not exists kv_cache_expires_idx
  on public.kv_cache (expires_at);
create index if not exists kv_cache_ns_created_idx
  on public.kv_cache (namespace, created_at desc);

alter table public.kv_cache enable row level security;
-- Service-role only — Edge Functions write/read via service client; users
-- never touch this directly.
drop policy if exists "kv_cache_no_user_access" on public.kv_cache;
create policy "kv_cache_no_user_access"
  on public.kv_cache for all to authenticated
  using (false) with check (false);

comment on table public.kv_cache is
  'Service-role-only cache for paid third-party API responses (Google CSE, Adzuna, etc.).';

-- Atomic increment-on-read for cache hits. Avoids a read+write roundtrip and
-- keeps hit_count cheap to maintain.
create or replace function public.kv_cache_increment_hit(
  p_namespace text,
  p_cache_key text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.kv_cache
     set hit_count = hit_count + 1
   where namespace = p_namespace
     and cache_key = p_cache_key
     and expires_at > now();
$$;

comment on function public.kv_cache_increment_hit(text, text) is
  'Atomic hit-count bump used by Edge Functions on cache HIT.';
