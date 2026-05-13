-- =============================================================================
-- Phase 1: Usage event foundation
-- =============================================================================
-- Adds privacy-safe product analytics events for the admin Usage & Engagement
-- dashboard. Candidate document bodies, job descriptions, cover-letter text,
-- API keys, and auth tokens should never be written into metadata.
-- =============================================================================

-- Ensure uuid generators are available. 0001_init.sql installs these too, but
-- the Supabase CLI shadow database used for `db push` dry-runs may not carry
-- the extension across migrations, so we declare it defensively here.
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- Use gen_random_uuid() (pg built-in since v13) rather than the schema-scoped
-- uuid_generate_v4 — Supabase moved uuid-ossp to the `extensions` schema and
-- it isn't on the public search_path during `db push` dry-runs.
create table if not exists public.usage_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  event_name     text not null,
  event_category text not null default 'workflow',
  module         text,
  route          text,
  session_id     text not null,
  anonymous_id   text,
  source         text not null default 'web',
  metadata       jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint usage_events_event_name_len check (char_length(event_name) between 2 and 80),
  constraint usage_events_category_len check (char_length(event_category) between 2 and 80),
  constraint usage_events_session_len check (char_length(session_id) between 8 and 120)
);

create index if not exists usage_events_user_occurred_idx
  on public.usage_events (user_id, occurred_at desc);
create index if not exists usage_events_name_occurred_idx
  on public.usage_events (event_name, occurred_at desc);
create index if not exists usage_events_module_occurred_idx
  on public.usage_events (module, occurred_at desc);
create index if not exists usage_events_session_idx
  on public.usage_events (session_id, occurred_at desc);

alter table public.usage_events enable row level security;

drop policy if exists "owner_select" on public.usage_events;
drop policy if exists "owner_insert" on public.usage_events;
drop policy if exists "owner_update" on public.usage_events;
drop policy if exists "owner_delete" on public.usage_events;

create policy "owner_select" on public.usage_events
  for select to authenticated using (user_id = auth.uid());

create policy "owner_insert" on public.usage_events
  for insert to authenticated with check (user_id = auth.uid());

-- Usage events are append-only from the client. Admin rollups read through the
-- service role after protected admin-role verification.
create policy "owner_update" on public.usage_events
  for update to authenticated using (false) with check (false);

create policy "owner_delete" on public.usage_events
  for delete to authenticated using (false);

comment on table public.usage_events is
  'Privacy-safe product analytics events for admin usage and engagement reporting.';
comment on column public.usage_events.metadata is
  'Small non-sensitive workflow metadata only. Do not store document bodies, descriptions, API keys, tokens, or passwords.';
