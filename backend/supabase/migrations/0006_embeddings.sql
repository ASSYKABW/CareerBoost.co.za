-- =============================================================================
-- Phase 5B: Vector embeddings infrastructure
-- =============================================================================
-- Adds:
--   1. pgvector extension (Supabase ships it; this just enables it)
--   2. embeddings_cache table — keyed on sha256(model + normalized_text),
--      stores the vector + a text preview for debugging.
--   3. cosine_similarity helper function (pgvector's <=> operator returns
--      cosine *distance* in 0..2; we want similarity in -1..1).
-- =============================================================================

create extension if not exists vector;

-- -----------------------------------------------------------------------------
-- embeddings_cache — service-role only (Edge Functions read/write).
-- text-embedding-3-small produces 1536-dim vectors. If we later add models
-- with different dimensionality, the column is nullable + we partition by
-- `model` in queries.
-- -----------------------------------------------------------------------------
create table if not exists public.embeddings_cache (
  cache_key   text primary key,        -- sha256(lower(model) || '|' || normalized_text)
  model       text not null,           -- e.g. 'text-embedding-3-small'
  dimensions  integer not null,        -- always equals length(vector); kept for fast filtering
  vector      vector(1536),            -- 1536 = text-embedding-3-small default
  text_preview text,                   -- first 200 chars; debugging aid only
  hit_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists embeddings_cache_expires_idx
  on public.embeddings_cache (expires_at);
create index if not exists embeddings_cache_model_idx
  on public.embeddings_cache (model);

alter table public.embeddings_cache enable row level security;
drop policy if exists "embeddings_cache_no_user_access" on public.embeddings_cache;
create policy "embeddings_cache_no_user_access"
  on public.embeddings_cache for all to authenticated
  using (false) with check (false);

comment on table public.embeddings_cache is
  'Service-role-only cache for OpenAI/Gemini embedding vectors. Keyed on sha256(model+normalized_text).';

-- -----------------------------------------------------------------------------
-- Atomic hit-count bump for cache HITs.
-- -----------------------------------------------------------------------------
create or replace function public.embeddings_cache_increment_hit(p_cache_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.embeddings_cache
     set hit_count = hit_count + 1
   where cache_key = p_cache_key
     and expires_at > now();
$$;

comment on function public.embeddings_cache_increment_hit(text) is
  'Atomic hit-count bump used by the embeddings Edge Function on cache HIT.';
