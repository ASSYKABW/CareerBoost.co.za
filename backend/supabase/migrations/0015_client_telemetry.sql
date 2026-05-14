-- Phase 8: Client telemetry — error capture + performance signals from
-- the browser. Powers the admin Health board's "what's breaking on
-- candidates' devices" panel, complements (does not replace) the
-- existing usage_events / usage_sessions feed.
--
-- Design:
--   - One row per captured event (error / unhandled rejection / slow op
--     / console.error). Batched on the client (up to 20 events per POST)
--     for efficiency, but stored row-per-event for queryability.
--   - Severity vocabulary kept small and explicit. "error" is the
--     default; "warning" for recoverable issues; "info" for slow ops.
--   - Privacy guard: same blocked-keys list as usage_events. The
--     ingestion function strips these before insert; the DB constraint
--     is defense-in-depth.
--   - RLS: owners can write their own rows (authenticated insert via
--     RLS-aware client); service role + admin reads. Anon insert is
--     allowed so we can capture errors on the landing page before
--     sign-in (rate-limited by IP at the function level).
--   - Indexes for the typical admin queries: by user (drill-down),
--     by occurred_at (timeline), by severity (filter to errors).

create extension if not exists "pgcrypto";

create table if not exists public.client_telemetry (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  anonymous_id  text,
  -- One of: error | warning | info. Default error since that's the
  -- common case; the client emits "warning" for non-fatal issues and
  -- "info" for performance marks.
  severity      text not null default 'error',
  -- The "kind" of event. Free-text but kept small in practice:
  -- unhandled_error / unhandled_rejection / console_error / slow_op /
  -- route_error / api_error / boot_error.
  event_kind    text not null,
  -- Human-readable message (e.g. error.message). Capped 1KB.
  message       text not null,
  -- Optional stack trace, line, column, source URL. Stack capped 8KB —
  -- enough for full traces in practice, low enough to bound payload.
  stack         text,
  source_url    text,
  line_no       int,
  col_no        int,
  -- Route the user was on when the error fired (e.g. "/calendar").
  route         text,
  -- User agent string for "is this only Safari?" type questions.
  user_agent    text,
  -- Free-form metadata bag for additional context. 4KB cap matches
  -- the existing usage_events guard.
  metadata      jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  constraint client_telemetry_severity_chk
    check (severity in ('error', 'warning', 'info')),
  constraint client_telemetry_event_kind_size_chk
    check (octet_length(event_kind) between 1 and 64),
  constraint client_telemetry_message_size_chk
    check (octet_length(message) <= 1024),
  constraint client_telemetry_stack_size_chk
    check (stack is null or octet_length(stack) <= 8192),
  constraint client_telemetry_source_url_size_chk
    check (source_url is null or octet_length(source_url) <= 512),
  constraint client_telemetry_route_size_chk
    check (route is null or octet_length(route) <= 256),
  constraint client_telemetry_user_agent_size_chk
    check (user_agent is null or octet_length(user_agent) <= 512),
  constraint client_telemetry_metadata_size_chk
    check (octet_length(metadata::text) <= 4096)
);

-- Privacy guard on metadata. Same blocked-keys vocabulary as the
-- usage_events guard from migration 0009 — defense in depth even
-- though the Edge Function strips these before insert.
create or replace function public.client_telemetry_metadata_privacy_guard()
returns trigger as $$
declare
  blocked_keys text[] := array[
    'apiKey','api_key','accessToken','access_token','refreshToken','refresh_token',
    'password','secret','resume','cv','coverLetter','cover_letter','jobDescription',
    'job_description','description','document','rawText','raw_text','html'
  ];
  k text;
begin
  if new.metadata is null then return new; end if;
  if jsonb_typeof(new.metadata) <> 'object' then
    raise exception 'client_telemetry.metadata must be a JSON object';
  end if;
  foreach k in array blocked_keys loop
    if new.metadata ? k then
      raise exception 'client_telemetry.metadata key "%" is blocked by privacy policy', k
        using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$ language plpgsql;

drop trigger if exists client_telemetry_metadata_privacy_guard on public.client_telemetry;
create trigger client_telemetry_metadata_privacy_guard
  before insert or update on public.client_telemetry
  for each row execute function public.client_telemetry_metadata_privacy_guard();

-- Indexes — admin queries go: by occurred_at desc (recent errors),
-- by severity (filter to errors), by user_id (drill-down).
create index if not exists client_telemetry_occurred_idx
  on public.client_telemetry (occurred_at desc);

create index if not exists client_telemetry_severity_occurred_idx
  on public.client_telemetry (severity, occurred_at desc);

create index if not exists client_telemetry_user_occurred_idx
  on public.client_telemetry (user_id, occurred_at desc)
  where user_id is not null;

create index if not exists client_telemetry_kind_occurred_idx
  on public.client_telemetry (event_kind, occurred_at desc);

-- RLS: candidates can only insert their own rows (via authenticated
-- client). Anon insert allowed for landing-page errors but at the
-- Edge Function level we rate-limit per IP to prevent abuse.
-- Reads are admin-only via service role.
alter table public.client_telemetry enable row level security;
alter table public.client_telemetry force row level security;

drop policy if exists "client_telemetry_owner_insert" on public.client_telemetry;
create policy "client_telemetry_owner_insert"
  on public.client_telemetry
  for insert
  with check (
    -- Owner-insert (authenticated user writing their own row)
    (auth.uid() is not null and auth.uid() = user_id)
    -- Anonymous insert (anon role, no user_id, anonymous_id set)
    or (auth.uid() is null and user_id is null and anonymous_id is not null)
  );

-- Owners can read their own rows (for debug/transparency); admins read
-- via service role which bypasses RLS.
drop policy if exists "client_telemetry_owner_select" on public.client_telemetry;
create policy "client_telemetry_owner_select"
  on public.client_telemetry
  for select
  using (auth.uid() is not null and auth.uid() = user_id);

revoke all on public.client_telemetry from anon;
-- Anon needs INSERT for landing-page error capture. NOT SELECT.
grant insert on public.client_telemetry to anon;
grant insert, select on public.client_telemetry to authenticated;
grant select on public.client_telemetry to service_role;

-- View: top errors in the last 24h for the admin Health board.
-- Groups by event_kind + first line of message so similar errors
-- cluster (e.g. "TypeError: Cannot read properties of undefined" all
-- aggregate even if the variable names differ slightly).
create or replace view public.v_admin_client_errors_24h as
select
  event_kind,
  -- Strip suffix after a colon for grouping ("TypeError: x" → "TypeError")
  split_part(message, ':', 1) as error_class,
  count(*)::int                                                       as event_count,
  count(distinct user_id) filter (where user_id is not null)::int    as distinct_users,
  count(distinct anonymous_id) filter (where anonymous_id is not null)::int as distinct_anons,
  max(occurred_at)                                                    as last_occurred_at,
  -- Sample one route for context.
  (array_agg(distinct route) filter (where route is not null))[1]    as sample_route,
  (array_agg(distinct user_agent) filter (where user_agent is not null))[1] as sample_user_agent
from public.client_telemetry
where severity = 'error'
  and occurred_at > now() - interval '24 hours'
group by event_kind, split_part(message, ':', 1)
order by event_count desc
limit 50;

grant select on public.v_admin_client_errors_24h to service_role;

comment on table public.client_telemetry is
  'Phase 8: client-side error + performance telemetry. Captured by v2/src/js/services/observability/observability.js, ingested by the client-telemetry Edge Function. RLS owner-write + admin-read.';

comment on view public.v_admin_client_errors_24h is
  'Phase 8: grouped top errors over last 24h for the admin Health board. Buckets by event_kind + leading message class.';
