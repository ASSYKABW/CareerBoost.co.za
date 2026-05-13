-- =============================================================================
-- Admin Phase B: pre-aggregated materialized views
-- =============================================================================
-- The admin-overview Edge Function previously pulled up to 5,000 profile rows,
-- 5,000 resume rows, 5,000 cover-letter rows, 5,000 interview-set rows, 1,000
-- applications, 1,000 saved jobs, 1,500 AI rows, 3,000 usage events, 3,000
-- usage sessions, and 10,000 cohort sessions on EVERY dashboard load and
-- aggregated them in-memory. As the user base grows past a few thousand, the
-- per-call latency curve gets ugly.
--
-- This migration adds 6 small materialized views that pre-compute the
-- expensive aggregations:
--   1. mv_admin_daily_active   - DAU + signed-in/anon split, 30-day window
--   2. mv_admin_weekly_cohorts - Weekly signup cohorts with W0..W3 retention
--   3. mv_admin_source_rollups - Job source counts + latest saved_at + host
--   4. mv_admin_top_routes     - Most-viewed routes (last 30 days)
--   5. mv_admin_top_modules    - Most-engaged modules (last 30 days)
--   6. mv_admin_per_user_stats - Per-user roll-up powering the support queue
--
-- Plus a refresh_admin_materialized_views() function and a pg_cron job that
-- refreshes them nightly at 02:30 UTC. Manual refresh is allowed via
-- `select public.refresh_admin_materialized_views();` from service role.
--
-- All MVs are service-role only via RLS+grants pattern. The Edge Function
-- reads via the service client; ordinary users see nothing.
-- =============================================================================

create extension if not exists pg_cron;

-- -----------------------------------------------------------------------------
-- 1. mv_admin_daily_active — 30-day DAU + session count by day.
-- -----------------------------------------------------------------------------
create materialized view if not exists public.mv_admin_daily_active as
with days as (
  select generate_series(
    (current_date - interval '29 days')::date,
    current_date,
    interval '1 day'
  )::date as day
),
session_activity as (
  select
    date(last_activity_at) as day,
    user_id,
    session_id,
    signed_in
  from public.usage_sessions
  where last_activity_at >= current_date - interval '30 days'
),
agg as (
  select
    day,
    count(distinct user_id)    as active_users,
    count(distinct session_id) as sessions,
    count(distinct user_id) filter (where signed_in) as signed_in_users
  from session_activity
  group by day
)
select
  d.day,
  to_char(d.day, 'MM-DD')                              as label,
  coalesce(agg.active_users, 0)                        as active_users,
  coalesce(agg.sessions, 0)                            as sessions,
  coalesce(agg.signed_in_users, 0)                     as signed_in_users
from days d
left join agg on agg.day = d.day
order by d.day;

create unique index if not exists mv_admin_daily_active_day_uidx
  on public.mv_admin_daily_active (day);

-- -----------------------------------------------------------------------------
-- 2. mv_admin_weekly_cohorts — Last 8 weekly cohorts with W0..W3 retention.
-- -----------------------------------------------------------------------------
-- For each cohort week W:
--   - users in cohort      = users created during week W
--   - week_offset N        = sessions in week (W + N) where user_id in cohort
--   - retention_rate_N     = pct(activeUsers in W+N, users in cohort)
create materialized view if not exists public.mv_admin_weekly_cohorts as
with bounds as (
  select
    date_trunc('week', now()) - (n || ' weeks')::interval as week_start,
    date_trunc('week', now()) - ((n - 1) || ' weeks')::interval as week_end,
    n as week_offset
  from generate_series(0, 7) as n
),
cohorts as (
  select
    b.week_offset,
    b.week_start::timestamptz as cohort_start,
    b.week_end::timestamptz   as cohort_end,
    to_char(b.week_start, 'MM-DD') as cohort_label,
    array_agg(distinct u.id) filter (where u.id is not null) as user_ids
  from bounds b
  left join auth.users u
    on u.created_at >= b.week_start and u.created_at < b.week_end
  group by b.week_offset, b.week_start, b.week_end
),
retention_calc as (
  select
    c.week_offset,
    c.cohort_label,
    c.cohort_start,
    c.cohort_end,
    coalesce(array_length(c.user_ids, 1), 0) as users,
    -- W0 / W1 / W2 / W3 = sessions in the Nth week after signup
    count(distinct case
      when s.last_activity_at >= c.cohort_start
       and s.last_activity_at <  c.cohort_start + interval '7 days'
       and s.user_id = any(c.user_ids)
      then s.user_id end) as w0_active,
    count(distinct case
      when s.last_activity_at >= c.cohort_start + interval '7 days'
       and s.last_activity_at <  c.cohort_start + interval '14 days'
       and s.user_id = any(c.user_ids)
      then s.user_id end) as w1_active,
    count(distinct case
      when s.last_activity_at >= c.cohort_start + interval '14 days'
       and s.last_activity_at <  c.cohort_start + interval '21 days'
       and s.user_id = any(c.user_ids)
      then s.user_id end) as w2_active,
    count(distinct case
      when s.last_activity_at >= c.cohort_start + interval '21 days'
       and s.last_activity_at <  c.cohort_start + interval '28 days'
       and s.user_id = any(c.user_ids)
      then s.user_id end) as w3_active
  from cohorts c
  left join public.usage_sessions s
    on s.user_id = any(c.user_ids)
   and s.last_activity_at >= c.cohort_start
   and s.last_activity_at <  c.cohort_start + interval '28 days'
  group by c.week_offset, c.cohort_label, c.cohort_start, c.cohort_end, c.user_ids
)
select
  week_offset,
  cohort_label,
  cohort_start,
  cohort_end,
  users,
  w0_active,
  w1_active,
  w2_active,
  w3_active,
  case when users > 0 then round((w0_active::numeric / users) * 100)::int else 0 end as w0_rate,
  case when users > 0 then round((w1_active::numeric / users) * 100)::int else 0 end as w1_rate,
  case when users > 0 then round((w2_active::numeric / users) * 100)::int else 0 end as w2_rate,
  case when users > 0 then round((w3_active::numeric / users) * 100)::int else 0 end as w3_rate
from retention_calc
order by week_offset desc;

create unique index if not exists mv_admin_weekly_cohorts_offset_uidx
  on public.mv_admin_weekly_cohorts (week_offset);

-- -----------------------------------------------------------------------------
-- 3. mv_admin_source_rollups — Job source counts + freshness.
-- -----------------------------------------------------------------------------
create materialized view if not exists public.mv_admin_source_rollups as
select
  coalesce(nullif(trim(source), ''), 'Unknown')              as source,
  count(*)                                                    as count,
  max(saved_at)                                               as last_saved_at,
  (array_agg(url order by saved_at desc nulls last))[1]       as latest_url
from public.saved_jobs
group by 1;

create unique index if not exists mv_admin_source_rollups_source_uidx
  on public.mv_admin_source_rollups (source);

-- -----------------------------------------------------------------------------
-- 4. mv_admin_top_routes — Most-viewed routes in the last 30 days.
-- -----------------------------------------------------------------------------
create materialized view if not exists public.mv_admin_top_routes as
with from_events as (
  select route, count(*) as views
  from public.usage_events
  where occurred_at >= now() - interval '30 days'
    and event_name = 'view_route'
    and coalesce(route, '') <> ''
  group by route
),
from_sessions as (
  select unnest(routes) as route, count(*) as views
  from public.usage_sessions
  where last_activity_at >= now() - interval '30 days'
    and array_length(routes, 1) > 0
  group by 1
),
combined as (
  select route, sum(views) as views
  from (
    select route, views from from_events
    union all
    select route, views from from_sessions
  ) all_rows
  where coalesce(route, '') <> ''
  group by route
)
select
  route,
  views::int as views,
  row_number() over (order by views desc, route) as rank
from combined
order by views desc, route
limit 25;

create unique index if not exists mv_admin_top_routes_route_uidx
  on public.mv_admin_top_routes (route);

-- -----------------------------------------------------------------------------
-- 5. mv_admin_top_modules — Most-engaged product modules in the last 30 days.
-- -----------------------------------------------------------------------------
create materialized view if not exists public.mv_admin_top_modules as
with from_events as (
  select module, count(*) as events
  from public.usage_events
  where occurred_at >= now() - interval '30 days'
    and coalesce(module, '') <> ''
  group by module
),
from_sessions as (
  select unnest(modules) as module, count(*) as sessions_touched
  from public.usage_sessions
  where last_activity_at >= now() - interval '30 days'
    and array_length(modules, 1) > 0
  group by 1
)
select
  coalesce(e.module, s.module) as module,
  coalesce(e.events, 0)::int   as events,
  coalesce(s.sessions_touched, 0)::int as sessions_touched
from from_events e
full outer join from_sessions s on e.module = s.module
where coalesce(e.module, s.module) <> ''
order by coalesce(e.events, 0) + coalesce(s.sessions_touched, 0) desc
limit 25;

create unique index if not exists mv_admin_top_modules_module_uidx
  on public.mv_admin_top_modules (module);

-- -----------------------------------------------------------------------------
-- 6. mv_admin_per_user_stats — Per-user roll-up powering the support queue.
--    Includes pipeline + saved jobs + AI requests + sessions + last activity.
-- -----------------------------------------------------------------------------
create materialized view if not exists public.mv_admin_per_user_stats as
with apps as (
  select user_id,
         count(*)                                  as pipeline_count,
         count(*) filter (where stage <> 'saved')  as applied_count,
         max(updated_at)                           as last_app_at
  from public.applications
  group by user_id
),
jobs as (
  select user_id,
         count(*)             as saved_job_count,
         max(saved_at)        as last_saved_at
  from public.saved_jobs
  group by user_id
),
ai as (
  select user_id,
         count(*)                              as ai_request_count,
         count(*) filter (where status = 'failed') as ai_failed_count,
         max(created_at)                       as last_ai_at
  from public.ai_usage
  where created_at >= now() - interval '90 days'
  group by user_id
),
sessions as (
  select user_id,
         count(*)             as session_count,
         max(last_activity_at) as last_session_at
  from public.usage_sessions
  where last_activity_at >= now() - interval '90 days'
  group by user_id
),
prof as (
  select user_id,
         onboarding_completed,
         plan,
         updated_at as profile_updated_at
  from public.profiles
)
select
  coalesce(apps.user_id, jobs.user_id, ai.user_id, sessions.user_id, prof.user_id) as user_id,
  coalesce(apps.pipeline_count, 0)::int  as pipeline_count,
  coalesce(apps.applied_count, 0)::int   as applied_count,
  coalesce(jobs.saved_job_count, 0)::int as saved_job_count,
  coalesce(ai.ai_request_count, 0)::int  as ai_request_count,
  coalesce(ai.ai_failed_count, 0)::int   as ai_failed_count,
  coalesce(sessions.session_count, 0)::int as session_count,
  coalesce(prof.onboarding_completed, false) as onboarding_completed,
  coalesce(prof.plan, 'free')            as plan,
  greatest(
    coalesce(apps.last_app_at, '1970-01-01'::timestamptz),
    coalesce(jobs.last_saved_at, '1970-01-01'::timestamptz),
    coalesce(ai.last_ai_at, '1970-01-01'::timestamptz),
    coalesce(sessions.last_session_at, '1970-01-01'::timestamptz),
    coalesce(prof.profile_updated_at, '1970-01-01'::timestamptz)
  )                                       as last_activity_at
from prof
full outer join apps     on apps.user_id     = prof.user_id
full outer join jobs     on jobs.user_id     = coalesce(apps.user_id, prof.user_id)
full outer join ai       on ai.user_id       = coalesce(apps.user_id, jobs.user_id, prof.user_id)
full outer join sessions on sessions.user_id = coalesce(apps.user_id, jobs.user_id, ai.user_id, prof.user_id)
where coalesce(apps.user_id, jobs.user_id, ai.user_id, sessions.user_id, prof.user_id) is not null;

create unique index if not exists mv_admin_per_user_stats_user_uidx
  on public.mv_admin_per_user_stats (user_id);
create index if not exists mv_admin_per_user_stats_activity_idx
  on public.mv_admin_per_user_stats (last_activity_at desc);
create index if not exists mv_admin_per_user_stats_pipeline_idx
  on public.mv_admin_per_user_stats (pipeline_count desc);

-- -----------------------------------------------------------------------------
-- RLS — service-role-only. Ordinary users CANNOT read these MVs.
-- (Materialized views don't support RLS directly; we use grant revocation.)
-- -----------------------------------------------------------------------------
revoke all on public.mv_admin_daily_active   from anon, authenticated;
revoke all on public.mv_admin_weekly_cohorts from anon, authenticated;
revoke all on public.mv_admin_source_rollups from anon, authenticated;
revoke all on public.mv_admin_top_routes     from anon, authenticated;
revoke all on public.mv_admin_top_modules    from anon, authenticated;
revoke all on public.mv_admin_per_user_stats from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Refresh function. SECURITY DEFINER so the cron job can run as the owner
-- regardless of who's authenticated.
-- -----------------------------------------------------------------------------
create or replace function public.refresh_admin_materialized_views()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- CONCURRENTLY so reads aren't blocked during refresh (requires the unique
  -- index on each MV, which we have).
  refresh materialized view concurrently public.mv_admin_daily_active;
  refresh materialized view concurrently public.mv_admin_weekly_cohorts;
  refresh materialized view concurrently public.mv_admin_source_rollups;
  refresh materialized view concurrently public.mv_admin_top_routes;
  refresh materialized view concurrently public.mv_admin_top_modules;
  refresh materialized view concurrently public.mv_admin_per_user_stats;
end;
$$;

comment on function public.refresh_admin_materialized_views() is
  'Refreshes all admin materialized views concurrently. Called nightly by pg_cron and on demand from the admin Edge Function service-role context.';

-- Initial population so the views aren't empty until the first cron tick.
-- These can't be CONCURRENTLY for the FIRST refresh — the MVs are empty.
refresh materialized view public.mv_admin_daily_active;
refresh materialized view public.mv_admin_weekly_cohorts;
refresh materialized view public.mv_admin_source_rollups;
refresh materialized view public.mv_admin_top_routes;
refresh materialized view public.mv_admin_top_modules;
refresh materialized view public.mv_admin_per_user_stats;

-- -----------------------------------------------------------------------------
-- pg_cron schedule — refresh nightly at 02:30 UTC (low-traffic window).
-- Idempotent: drop+re-create so re-running this migration doesn't pile up
-- duplicate jobs.
-- -----------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('refresh-admin-mvs')
  where exists (select 1 from cron.job where jobname = 'refresh-admin-mvs');
exception when others then
  -- pg_cron may not be loaded in some environments; allow the migration to
  -- continue. Manual refresh still works via the function call.
  null;
end $$;

do $$
begin
  perform cron.schedule(
    'refresh-admin-mvs',
    '30 2 * * *',
    $cron$ select public.refresh_admin_materialized_views(); $cron$
  );
exception when others then
  -- pg_cron unavailable — operator can run the function manually if needed.
  null;
end $$;
