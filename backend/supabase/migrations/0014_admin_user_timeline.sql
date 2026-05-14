-- Phase E3: Per-user timeline RPC + user segments view.
--
-- The admin Users board needs to drill into a single user's journey:
-- profile attribution, applications history, outcomes, AI usage, last
-- activity. Rather than five round-trips from the Edge Function, we
-- expose a single SECURITY DEFINER function that an admin can call to
-- get the entire timeline as JSON.
--
-- The function checks that the caller has an admin role on app_metadata
-- before returning anything. Direct candidate-side calls are rejected
-- by the role check.

-- View: user segments — power users, at-risk, churned, new.
-- Computed against current state so segment counts move with the data.
-- An admin Users board reads this for the segment chips at the top.
create or replace view public.v_admin_user_segments as
with
  per_user as (
    select
      u.id   as user_id,
      u.email,
      u.created_at,
      u.last_sign_in_at,
      p.country_code,
      p.utm_source,
      p.plan,
      coalesce((select count(*) from public.applications a where a.user_id = u.id), 0)::int    as application_count,
      coalesce((select count(*) from public.saved_jobs sj where sj.user_id = u.id), 0)::int   as saved_job_count,
      coalesce((select count(*) from public.interview_outcomes io where io.user_id = u.id and io.outcome_type in ('interview','offer')), 0)::int as placement_count,
      coalesce((select max(last_activity_at) from public.usage_sessions us where us.user_id = u.id), u.last_sign_in_at, u.created_at) as last_activity_at
    from auth.users u
    left join public.profiles p on p.user_id = u.id
  )
select
  user_id,
  email,
  created_at,
  last_sign_in_at,
  country_code,
  utm_source,
  plan,
  application_count,
  saved_job_count,
  placement_count,
  last_activity_at,
  -- Segment classification. Mutually exclusive in priority order:
  -- power (most positive signal) > new (recent signup) > at_risk
  -- (low engagement) > churned (long-inactive) > active (default).
  case
    when placement_count > 0 or (application_count >= 3 and saved_job_count >= 5) then 'power'
    when created_at > now() - interval '7 days' then 'new'
    when application_count = 0 and saved_job_count <= 1 and created_at < now() - interval '7 days' then 'at_risk'
    when last_activity_at < now() - interval '30 days' then 'churned'
    else 'active'
  end as segment
from per_user;

grant select on public.v_admin_user_segments to service_role;

-- RPC: admin_user_timeline(target_user_id uuid) → jsonb.
-- Returns the user's complete journey for the per-user drill-down panel
-- in the admin Users board. SECURITY DEFINER + explicit role check so
-- the function can read auth.users + profiles + applications without
-- exposing them to the candidate-side RLS layer.
create or replace function public.admin_user_timeline(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller_roles text[];
  result jsonb;
begin
  -- Caller must have an admin role on app_metadata.
  select coalesce(
    nullif(array(select jsonb_array_elements_text(coalesce((auth.jwt() -> 'app_metadata' -> 'roles'), '[]'::jsonb))), '{}'),
    case
      when auth.jwt() -> 'app_metadata' ->> 'role' is not null
      then array[auth.jwt() -> 'app_metadata' ->> 'role']
      else '{}'::text[]
    end
  )
  into caller_roles;

  if not (caller_roles && array['admin', 'owner', 'developer']) then
    raise exception 'admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'ok', true,
    'profile', (
      select jsonb_build_object(
        'user_id', u.id,
        'email', u.email,
        'created_at', u.created_at,
        'last_sign_in_at', u.last_sign_in_at,
        'full_name', p.full_name,
        'plan', p.plan,
        'country_code', p.country_code,
        'utm_source', p.utm_source,
        'utm_medium', p.utm_medium,
        'utm_campaign', p.utm_campaign,
        'referrer_host', p.referrer_host,
        'landing_path', p.landing_path,
        'signup_at', p.signup_at,
        'onboarding_completed', p.onboarding_completed
      )
      from auth.users u
      left join public.profiles p on p.user_id = u.id
      where u.id = target_user_id
    ),
    'counts', (
      select jsonb_build_object(
        'applications', coalesce((select count(*) from public.applications where user_id = target_user_id), 0),
        'saved_jobs',   coalesce((select count(*) from public.saved_jobs where user_id = target_user_id), 0),
        'placements',   coalesce((select count(*) from public.interview_outcomes where user_id = target_user_id and outcome_type in ('interview','offer')), 0),
        'ai_calls_30d', coalesce((select count(*) from public.ai_usage where user_id = target_user_id and created_at > now() - interval '30 days'), 0),
        'sessions_30d', coalesce((select count(*) from public.usage_sessions where user_id = target_user_id and last_activity_at > now() - interval '30 days'), 0)
      )
    ),
    -- Last 10 applications, newest first.
    'applications', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id,
        'company', a.company,
        'role', a.role,
        'stage', a.stage,
        'source_url', a.source_url,
        'applied_at', a.applied_at,
        'updated_at', a.updated_at
      ) order by a.updated_at desc), '[]'::jsonb)
      from (
        select * from public.applications
          where user_id = target_user_id
          order by updated_at desc nulls last
          limit 10
      ) a
    ),
    'outcomes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id,
        'application_id', o.application_id,
        'outcome_type', o.outcome_type,
        'occurred_at', o.occurred_at,
        'company', o.company,
        'role', o.role,
        'source_channel', o.source_channel
      ) order by o.occurred_at desc), '[]'::jsonb)
      from public.interview_outcomes o
      where o.user_id = target_user_id
    ),
    -- Last 5 sessions for a "what did they do recently" feel.
    'recent_sessions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'started_at', s.started_at,
        'last_activity_at', s.last_activity_at,
        'duration_seconds', s.duration_seconds,
        'route_count', s.route_count,
        'modules', s.modules,
        'device_type', s.device_type
      ) order by s.last_activity_at desc), '[]'::jsonb)
      from (
        select * from public.usage_sessions
          where user_id = target_user_id
          order by last_activity_at desc
          limit 5
      ) s
    )
  ) into result;

  return result;
end$$;

revoke all on function public.admin_user_timeline(uuid) from public, anon;
grant execute on function public.admin_user_timeline(uuid) to authenticated, service_role;

comment on view public.v_admin_user_segments is
  'Phase E3: per-user segment classification (power / new / at_risk / churned / active) for the admin Users board.';
comment on function public.admin_user_timeline is
  'Phase E3: SECURITY DEFINER RPC returning a per-user journey JSON object. Admin-role-gated. Used by the admin Users board drill-down panel.';
