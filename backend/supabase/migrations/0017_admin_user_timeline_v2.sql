-- Admin User Timeline v2 — richer per-user payload for the admin user
-- detail drawer (A1 from the admin audit).
--
-- The v1 RPC (migration 0014) returned profile, counts, applications,
-- outcomes, and recent_sessions. Operationally that's "who they are
-- and what they applied to" — it doesn't help an operator answer the
-- two most common support questions:
--
--   1. "How much is this user costing me on AI?"
--   2. "What were they doing in the app right before the bug happened?"
--
-- v2 adds three new top-level fields without removing or renaming any
-- existing ones (drop-in backward compatible):
--
--   ai_spend:        { "30d": numeric, "lifetime": numeric }
--   ai_usage_30d:    { skill: { count, cost_usd, failed } }  per-skill breakdown
--   recent_ai_calls: last 10 ai_usage rows (skill, status, cost, latency, when, error)
--
-- The recent_ai_calls list includes the `error` column so an operator
-- can paste a failure message straight into a support ticket without
-- needing SQL access.

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
  -- Caller must have an admin role on app_metadata. Same check as v1.
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
        'onboarding_completed', p.onboarding_completed,
        -- v2: account age in days (precomputed so the UI doesn't have to)
        'account_age_days', floor(extract(epoch from (now() - u.created_at)) / 86400)::int,
        'days_since_signin', case
          when u.last_sign_in_at is null then null
          else floor(extract(epoch from (now() - u.last_sign_in_at)) / 86400)::int
        end
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
    -- v2: lifetime + 30d AI spend (USD). null-safe — returns 0 when no rows.
    'ai_spend', (
      select jsonb_build_object(
        '30d',      coalesce((select sum(cost_usd) from public.ai_usage where user_id = target_user_id and created_at > now() - interval '30 days'), 0),
        'lifetime', coalesce((select sum(cost_usd) from public.ai_usage where user_id = target_user_id), 0)
      )
    ),
    -- v2: per-skill rollup for last 30 days. The UI lists this as a
    -- compact table so operators can spot "user X is burning all their
    -- credits on resume-tailor" at a glance.
    'ai_usage_30d', (
      select coalesce(jsonb_object_agg(skill, jsonb_build_object(
        'count',     cnt,
        'cost_usd',  total_cost,
        'failed',    failed
      )), '{}'::jsonb)
      from (
        select
          skill,
          count(*)::int                                    as cnt,
          coalesce(sum(cost_usd), 0)                       as total_cost,
          coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)::int as failed
        from public.ai_usage
        where user_id = target_user_id and created_at > now() - interval '30 days'
        group by skill
      ) s
    ),
    -- v2: last 10 AI calls verbatim, including the error column so an
    -- operator can copy a failure straight into a support reply.
    'recent_ai_calls', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'skill',      r.skill,
        'provider',   r.provider,
        'status',     r.status,
        'cost_usd',   r.cost_usd,
        'latency_ms', r.latency_ms,
        'cache_hit',  r.cache_hit,
        'error',      r.error,
        'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from (
        select *
        from public.ai_usage
        where user_id = target_user_id
        order by created_at desc
        limit 10
      ) r
    ),
    -- Last 10 applications, newest first. (unchanged from v1)
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

comment on function public.admin_user_timeline is
  'Phase E3 + Admin A1: SECURITY DEFINER RPC returning a per-user journey JSON object. Admin-role-gated. v2 adds ai_spend / ai_usage_30d / recent_ai_calls and account age fields for the richer admin user detail drawer.';
