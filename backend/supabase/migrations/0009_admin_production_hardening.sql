-- =============================================================================
-- Phase 7: Admin production hardening
-- =============================================================================
-- Tightens privacy controls and query performance for admin analytics.
-- Analytics tables must stay operational only: no resume bodies, cover-letter
-- text, job descriptions, auth tokens, API keys, or raw document content.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'usage_events_metadata_privacy_guard'
      and conrelid = 'public.usage_events'::regclass
  ) then
    alter table public.usage_events
      add constraint usage_events_metadata_privacy_guard
      check (
        octet_length(metadata::text) <= 4096
        and not (metadata ?| array[
          'apiKey',
          'api_key',
          'accessToken',
          'access_token',
          'refreshToken',
          'refresh_token',
          'password',
          'secret',
          'resume',
          'cv',
          'coverLetter',
          'cover_letter',
          'jobDescription',
          'job_description',
          'description',
          'document',
          'rawText',
          'raw_text',
          'html'
        ])
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'usage_sessions_metadata_privacy_guard'
      and conrelid = 'public.usage_sessions'::regclass
  ) then
    alter table public.usage_sessions
      add constraint usage_sessions_metadata_privacy_guard
      check (
        octet_length(metadata::text) <= 4096
        and not (metadata ?| array[
          'apiKey',
          'api_key',
          'accessToken',
          'access_token',
          'refreshToken',
          'refresh_token',
          'password',
          'secret',
          'resume',
          'cv',
          'coverLetter',
          'cover_letter',
          'jobDescription',
          'job_description',
          'description',
          'document',
          'rawText',
          'raw_text',
          'html'
        ])
      );
  end if;
end $$;

alter table public.usage_events force row level security;
alter table public.usage_sessions force row level security;

revoke all on public.usage_events from anon;
revoke all on public.usage_sessions from anon;
grant select, insert on public.usage_events to authenticated;
grant select, insert, update on public.usage_sessions to authenticated;

create index if not exists usage_events_occurred_idx
  on public.usage_events (occurred_at desc);
create index if not exists usage_events_category_module_occurred_idx
  on public.usage_events (event_category, module, occurred_at desc);
create index if not exists usage_events_user_session_idx
  on public.usage_events (user_id, session_id);

create index if not exists usage_sessions_last_activity_idx
  on public.usage_sessions (last_activity_at desc);
create index if not exists usage_sessions_user_started_idx
  on public.usage_sessions (user_id, started_at desc);
create index if not exists usage_sessions_modules_gin_idx
  on public.usage_sessions using gin (modules);
create index if not exists usage_sessions_routes_gin_idx
  on public.usage_sessions using gin (routes);

create index if not exists saved_jobs_source_saved_idx
  on public.saved_jobs (source, saved_at desc);
create index if not exists saved_jobs_url_idx
  on public.saved_jobs (url);
create index if not exists saved_searches_user_last_run_idx
  on public.saved_searches (user_id, last_run_at desc);
create index if not exists applications_stage_updated_idx
  on public.applications (stage, updated_at desc);
create index if not exists ai_usage_status_created_idx
  on public.ai_usage (status, created_at desc);
create index if not exists profiles_onboarding_updated_idx
  on public.profiles (onboarding_completed, updated_at desc);

comment on constraint usage_events_metadata_privacy_guard on public.usage_events is
  'Prevents sensitive keys and oversized payloads from entering admin usage-event metadata.';
comment on constraint usage_sessions_metadata_privacy_guard on public.usage_sessions is
  'Prevents sensitive keys and oversized payloads from entering admin usage-session metadata.';
