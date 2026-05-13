-- =============================================================================
-- Phase 2: Usage session tracking
-- =============================================================================
-- Adds durable session rollups for Usage & Engagement metrics. Session rows hold
-- operational metadata only: device class, browser, routes/modules visited, and
-- timing counters. Candidate document bodies and secrets are not stored here.
-- =============================================================================

create table if not exists public.usage_sessions (
  session_id          text primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  anonymous_id        text,
  source              text not null default 'web',
  started_at          timestamptz not null,
  last_activity_at    timestamptz not null,
  ended_at            timestamptz,
  duration_seconds    integer not null default 0,
  route_count         integer not null default 0,
  event_count         integer not null default 0,
  entry_route         text,
  exit_route          text,
  routes              text[] not null default '{}'::text[],
  modules             text[] not null default '{}'::text[],
  device_type         text,
  browser             text,
  os                  text,
  viewport_width      integer,
  viewport_height     integer,
  locale              text,
  timezone            text,
  signed_in           boolean not null default true,
  started_in_preview  boolean not null default false,
  preview_mode        text not null default 'signed_in',
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint usage_sessions_session_len check (char_length(session_id) between 8 and 120),
  constraint usage_sessions_duration_nonnegative check (duration_seconds >= 0),
  constraint usage_sessions_route_count_nonnegative check (route_count >= 0),
  constraint usage_sessions_event_count_nonnegative check (event_count >= 0)
);

create index if not exists usage_sessions_user_last_activity_idx
  on public.usage_sessions (user_id, last_activity_at desc);
create index if not exists usage_sessions_started_idx
  on public.usage_sessions (started_at desc);
create index if not exists usage_sessions_preview_mode_idx
  on public.usage_sessions (preview_mode, last_activity_at desc);
create index if not exists usage_sessions_device_type_idx
  on public.usage_sessions (device_type, last_activity_at desc);

alter table public.usage_sessions enable row level security;

drop policy if exists "owner_select" on public.usage_sessions;
drop policy if exists "owner_insert" on public.usage_sessions;
drop policy if exists "owner_update" on public.usage_sessions;
drop policy if exists "owner_delete" on public.usage_sessions;

create policy "owner_select" on public.usage_sessions
  for select to authenticated using (user_id = auth.uid());

create policy "owner_insert" on public.usage_sessions
  for insert to authenticated with check (user_id = auth.uid());

create policy "owner_update" on public.usage_sessions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Sessions are append/update-only from the client. Admin cleanup should happen
-- through service-role maintenance jobs after protected admin verification.
create policy "owner_delete" on public.usage_sessions
  for delete to authenticated using (false);

comment on table public.usage_sessions is
  'Privacy-safe session rollups for admin DAU/WAU/MAU, session length, depth, and device reporting.';
comment on column public.usage_sessions.metadata is
  'Small non-sensitive session metadata only. Do not store document bodies, descriptions, API keys, tokens, or passwords.';
