-- Admin A3: manual user adjustments + admin actions on the timeline.
--
-- The admin Users board now needs to let an operator self-serve the
-- common support escalations without an engineer with DB access:
--
--   grant_quota   bump usage_counters down so the user gets N more
--                 calls of one quota this period
--   reset_quota   zero out all current-period counters
--   change_plan   set subscriptions.plan_id (no Stripe call — used
--                 to comp a beta tester, NOT for production billing)
--   add_note      just log a note for other admins to read
--
-- All four go through ONE SECURITY DEFINER RPC. Every row writes to
-- admin_audit_log so the operations history is centralized + tamper-
-- evident (admin_audit_log is append-only at the schema level).
--
-- Also extends admin_user_timeline to return the last 10 admin
-- actions for the user so the drawer can surface the history inline.

-- =============================================================================
-- admin_user_adjust(p_admin_user_id, p_admin_email, p_target_user_id,
--                   p_target_email, p_action, p_payload, p_ip, p_user_agent)
-- returns jsonb { ok, action, audit_id, applied }
-- =============================================================================
create or replace function public.admin_user_adjust(
  p_admin_user_id  uuid,
  p_admin_email    text,
  p_target_user_id uuid,
  p_target_email   text,
  p_action         text,
  p_payload        jsonb,
  p_ip             inet,
  p_user_agent     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller_roles text[];
  v_payload    jsonb := coalesce(p_payload, '{}'::jsonb);
  v_applied    jsonb := '{}'::jsonb;
  v_audit_id   uuid;
  v_quota_key  text;
  v_amount     int;
  v_new_plan   text;
  v_plan_exists boolean;
  v_note       text;
  v_current    int;
  v_quota_cols constant text[] := array[
    'ai_resumes', 'ai_covers', 'ai_mocks', 'ai_research', 'ai_question_banks'
  ];
begin
  -- ----- Caller must be admin (defence in depth — Edge fn already gated) ----
  select coalesce(
    nullif(array(select jsonb_array_elements_text(coalesce((auth.jwt() -> 'app_metadata' -> 'roles'), '[]'::jsonb))), '{}'),
    case
      when auth.jwt() -> 'app_metadata' ->> 'role' is not null
      then array[auth.jwt() -> 'app_metadata' ->> 'role']
      else '{}'::text[]
    end
  ) into caller_roles;

  if not (caller_roles && array['admin', 'owner', 'developer']) then
    raise exception 'admin role required'
      using errcode = '42501';
  end if;

  -- ----- Target must exist --------------------------------------------------
  if p_target_user_id is null then
    raise exception 'target user_id is required';
  end if;
  if not exists (select 1 from auth.users where id = p_target_user_id) then
    raise exception 'target user not found';
  end if;

  -- ----- Per-action handlers ------------------------------------------------
  if p_action = 'grant_quota' then
    -- Validates quota key against the fixed allow-list. Decrement clamps
    -- at 0 so a 999-bump on a counter at 3 results in 0, not -996.
    v_quota_key := lower(coalesce(v_payload ->> 'quota', ''));
    v_amount := coalesce((v_payload ->> 'amount')::int, 0);
    if v_quota_key is null or v_quota_key = '' or not (v_quota_key = any(v_quota_cols)) then
      raise exception 'invalid quota key: %', v_quota_key;
    end if;
    if v_amount <= 0 or v_amount > 1000 then
      raise exception 'amount must be 1..1000 (got %)', v_amount;
    end if;

    -- Upsert a row if the user has never been quota-tracked. Then
    -- decrement the chosen column with a clamp at 0. Dynamic SQL is
    -- safe here because v_quota_key was validated against a literal
    -- column-name array above.
    insert into public.usage_counters (user_id)
    values (p_target_user_id)
    on conflict (user_id) do nothing;

    execute format(
      'update public.usage_counters
          set %1$I = greatest(0, %1$I - $1),
              updated_at = now()
        where user_id = $2
       returning %1$I',
      v_quota_key
    )
    using v_amount, p_target_user_id
    into v_current;

    v_applied := jsonb_build_object(
      'quota', v_quota_key,
      'requested', v_amount,
      'newCounter', v_current
    );

  elsif p_action = 'reset_quota' then
    -- Wipe all current-period counters. We don't roll period_start
    -- forward — that's owned by the monthly reset job.
    insert into public.usage_counters (user_id)
    values (p_target_user_id)
    on conflict (user_id) do nothing;

    update public.usage_counters
       set ai_resumes        = 0,
           ai_covers         = 0,
           ai_mocks          = 0,
           ai_research       = 0,
           ai_question_banks = 0,
           updated_at        = now()
     where user_id = p_target_user_id;

    v_applied := jsonb_build_object('reset', true);

  elsif p_action = 'change_plan' then
    -- Validates against plan_catalog so an operator can't typo "Pro" and
    -- end up with a plan that doesn't exist + breaks entitlements.
    v_new_plan := lower(coalesce(v_payload ->> 'planId', ''));
    if v_new_plan = '' then
      raise exception 'planId is required';
    end if;
    select exists (select 1 from public.plan_catalog where plan_id = v_new_plan) into v_plan_exists;
    if not v_plan_exists then
      raise exception 'unknown plan_id: %', v_new_plan;
    end if;

    -- Upsert the subscriptions row. We mark status=active because this
    -- is an OPERATOR override — the operator vouched for the user, so
    -- the plan is in good standing regardless of Stripe state.
    insert into public.subscriptions (user_id, plan_id, status, updated_at)
    values (p_target_user_id, v_new_plan, 'active', now())
    on conflict (user_id) do update
      set plan_id = excluded.plan_id,
          status = 'active',
          updated_at = now();

    v_applied := jsonb_build_object('planId', v_new_plan);

  elsif p_action = 'add_note' then
    -- A note is just an audit-log row with no data change. The audit
    -- log's payload-size constraint caps notes at ~3.5KB after JSON
    -- wrapping; we hard-cap at 2000 chars to leave headroom.
    v_note := substring(coalesce(v_payload ->> 'note', '') for 2000);
    if length(trim(v_note)) = 0 then
      raise exception 'note text cannot be empty';
    end if;
    v_applied := jsonb_build_object('noteLength', length(v_note));

  else
    raise exception 'unsupported action: %', p_action;
  end if;

  -- ----- Audit log (single insert covers all four verbs) --------------------
  insert into public.admin_audit_log (
    admin_user_id, admin_email, action,
    target_user_id, target_email, payload,
    result_status, ip_address, user_agent
  ) values (
    p_admin_user_id, p_admin_email, p_action,
    p_target_user_id, p_target_email,
    -- For add_note we put the note text into payload so it's visible
    -- on the timeline. The CHECK constraint on admin_audit_log forbids
    -- a list of PII-shaped keys ('resume', 'apiKey', etc.) but 'note'
    -- is fine.
    v_payload || jsonb_build_object('applied', v_applied),
    'success', p_ip, p_user_agent
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'ok', true,
    'action', p_action,
    'auditId', v_audit_id,
    'applied', v_applied
  );
end;
$$;

revoke all on function public.admin_user_adjust(uuid, text, uuid, text, text, jsonb, inet, text) from public, anon, authenticated;
grant execute on function public.admin_user_adjust(uuid, text, uuid, text, text, jsonb, inet, text) to service_role;

comment on function public.admin_user_adjust is
  'Admin A3: SECURITY DEFINER + service-role-only RPC that handles four self-serve user adjustments (grant_quota / reset_quota / change_plan / add_note). Every call is mirrored to admin_audit_log for tamper-evident history.';

-- =============================================================================
-- Extend admin_user_timeline to include the last 10 admin actions for the
-- user so the drawer can show "Recent admin actions" inline. Drop-in
-- backward compatible — same RPC name, same caller pattern, just adds
-- a top-level `admin_actions` field.
-- =============================================================================
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
    -- A3: live subscription plan (from subscriptions table, not profiles.plan
    -- which is stale). Includes status + cancel-at flag for support context.
    'subscription', (
      select jsonb_build_object(
        'plan_id',             s.plan_id,
        'status',              s.status,
        'cancel_at_period_end',s.cancel_at_period_end,
        'current_period_end',  s.current_period_end,
        'updated_at',          s.updated_at
      )
      from public.subscriptions s
      where s.user_id = target_user_id
    ),
    -- A3: live usage counters so the operator sees current quota state
    -- before granting more.
    'usage_counters', (
      select jsonb_build_object(
        'period_start',      uc.period_start,
        'ai_resumes',        uc.ai_resumes,
        'ai_covers',         uc.ai_covers,
        'ai_mocks',          uc.ai_mocks,
        'ai_research',       uc.ai_research,
        'ai_question_banks', uc.ai_question_banks,
        'updated_at',        uc.updated_at
      )
      from public.usage_counters uc
      where uc.user_id = target_user_id
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
    'ai_spend', (
      select jsonb_build_object(
        '30d',      coalesce((select sum(cost_usd) from public.ai_usage where user_id = target_user_id and created_at > now() - interval '30 days'), 0),
        'lifetime', coalesce((select sum(cost_usd) from public.ai_usage where user_id = target_user_id), 0)
      )
    ),
    'ai_usage_30d', (
      select coalesce(jsonb_object_agg(skill, jsonb_build_object(
        'count', cnt, 'cost_usd', total_cost, 'failed', failed
      )), '{}'::jsonb)
      from (
        select skill,
               count(*)::int as cnt,
               coalesce(sum(cost_usd), 0) as total_cost,
               coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)::int as failed
        from public.ai_usage
        where user_id = target_user_id and created_at > now() - interval '30 days'
        group by skill
      ) s
    ),
    'recent_ai_calls', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'skill', r.skill, 'provider', r.provider, 'status', r.status,
        'cost_usd', r.cost_usd, 'latency_ms', r.latency_ms,
        'cache_hit', r.cache_hit, 'error', r.error, 'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from (
        select * from public.ai_usage where user_id = target_user_id order by created_at desc limit 10
      ) r
    ),
    'applications', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'company', a.company, 'role', a.role, 'stage', a.stage,
        'source_url', a.source_url, 'applied_at', a.applied_at, 'updated_at', a.updated_at
      ) order by a.updated_at desc), '[]'::jsonb)
      from (
        select * from public.applications where user_id = target_user_id order by updated_at desc nulls last limit 10
      ) a
    ),
    'outcomes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'application_id', o.application_id, 'outcome_type', o.outcome_type,
        'occurred_at', o.occurred_at, 'company', o.company, 'role', o.role,
        'source_channel', o.source_channel
      ) order by o.occurred_at desc), '[]'::jsonb)
      from public.interview_outcomes o where o.user_id = target_user_id
    ),
    'recent_sessions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'started_at', s.started_at, 'last_activity_at', s.last_activity_at,
        'duration_seconds', s.duration_seconds, 'route_count', s.route_count,
        'modules', s.modules, 'device_type', s.device_type
      ) order by s.last_activity_at desc), '[]'::jsonb)
      from (select * from public.usage_sessions where user_id = target_user_id order by last_activity_at desc limit 5) s
    ),
    -- A3: last 10 admin actions targeting this user. Lets the drawer
    -- show a "Recent admin actions" stream: who did what, when, with
    -- the action payload + any notes inline.
    'admin_actions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',           al.id,
        'action',       al.action,
        'admin_email',  al.admin_email,
        'payload',      al.payload,
        'result_status',al.result_status,
        'occurred_at',  al.occurred_at
      ) order by al.occurred_at desc), '[]'::jsonb)
      from (
        select * from public.admin_audit_log
         where target_user_id = target_user_id
         order by occurred_at desc
         limit 10
      ) al
    )
  ) into result;

  return result;
end$$;

comment on function public.admin_user_timeline is
  'Phase E3 + Admin A1/A3: SECURITY DEFINER RPC returning per-user journey + AI spend + admin action history. Admin-role-gated.';
