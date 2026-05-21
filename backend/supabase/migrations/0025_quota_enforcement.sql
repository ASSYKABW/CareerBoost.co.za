-- Day 4.0 — Close the billing leak by enforcing monthly quotas in the
-- Edge Function layer instead of trusting the client.
--
-- Background: migration 0016 shipped `consume_quota` as the row-locked
-- authoritative RPC for quota check + atomic decrement. The intent was
-- that every metered AI call would invoke it server-side. In practice
-- NO Edge Function ever called it — the only enforcement was the
-- client-side advisory `entitlements.canConsume()` check, which a user
-- with DevTools can bypass in one line. This migration + the ai-run
-- change land together so the gate becomes real:
--
--   1. Add `ai_bullets` quota key (previously unmetered — the worst
--      offender, since the wand-icon Strengthen action fires a Sonnet
--      call per click with no check at all).
--   2. Extend `consume_quota` and `get_user_entitlements` to handle
--      the new key.
--   3. Update plan_catalog limits per the Day 2 incident
--      recommendation: free 10, plus 50, pro 250, career unlimited.
--   4. Resolve the open admin_incident.
--
-- The actual enforcement (calling consume_quota from ai-run before
-- every LLM call) ships in the same commit as this migration. After
-- both land, a user who edits canConsume in DevTools will see their
-- click hit the server, get a clean 402, and trigger the upgrade
-- modal — same UX as the client-side gate, but actually enforceable.

-- =============================================================================
-- 1. usage_counters: add ai_bullets column + relax non-negative check
-- =============================================================================

alter table public.usage_counters
  add column if not exists ai_bullets int not null default 0;

-- Drop and re-add the non-negative constraint so it covers the new column.
alter table public.usage_counters
  drop constraint if exists usage_counters_non_negative;

alter table public.usage_counters
  add constraint usage_counters_non_negative check (
    ai_resumes >= 0 and ai_covers >= 0 and ai_mocks >= 0 and
    ai_research >= 0 and ai_question_banks >= 0 and
    ai_bullets >= 0
  );

-- =============================================================================
-- 2. plan_catalog: add ai_bullets limits per plan
--
-- The Day 2 incident recommended free:10 / plus:50 / pro:250 / career:null.
-- We keep that as the canonical scale. Limits are stored under
-- limits.monthly.ai_bullets per existing schema.
-- =============================================================================

update public.plan_catalog
set limits = jsonb_set(
  limits,
  '{monthly,ai_bullets}',
  to_jsonb(10::int),
  true
)
where plan_id = 'free';

update public.plan_catalog
set limits = jsonb_set(
  limits,
  '{monthly,ai_bullets}',
  to_jsonb(50::int),
  true
)
where plan_id = 'plus';

update public.plan_catalog
set limits = jsonb_set(
  limits,
  '{monthly,ai_bullets}',
  to_jsonb(250::int),
  true
)
where plan_id = 'pro';

update public.plan_catalog
set limits = jsonb_set(
  limits,
  '{monthly,ai_bullets}',
  'null'::jsonb,
  true
)
where plan_id = 'career';

-- =============================================================================
-- 3. consume_quota: extend to handle ai_bullets
--
-- Replace the function in place. Same signature, same return shape,
-- just adds the new key everywhere.
-- =============================================================================

create or replace function public.consume_quota(quota_key text, amount int default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  sub_row public.subscriptions%rowtype;
  uc_row  public.usage_counters%rowtype;
  plan_row public.plan_catalog%rowtype;
  current_count int;
  monthly_limit int;
  current_month date := date_trunc('month', now() at time zone 'utc')::date;
  allowed_keys text[] := array[
    'ai_resumes','ai_covers','ai_mocks','ai_research',
    'ai_question_banks','ai_bullets'
  ];
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not (quota_key = any(allowed_keys)) then
    raise exception 'invalid quota_key %', quota_key using errcode = '22023';
  end if;
  if amount is null or amount < 1 then
    amount := 1;
  end if;

  -- Ensure subscription + usage rows exist; reset usage if month rolled.
  perform public.get_user_entitlements(caller);

  -- Lock the usage row for the duration of the transaction.
  select * into uc_row from public.usage_counters where user_id = caller for update;
  select * into sub_row from public.subscriptions where user_id = caller;
  select * into plan_row from public.plan_catalog where plan_id = sub_row.plan_id;

  -- Read the per-key current count + monthly limit.
  current_count := case quota_key
    when 'ai_resumes'        then uc_row.ai_resumes
    when 'ai_covers'         then uc_row.ai_covers
    when 'ai_mocks'          then uc_row.ai_mocks
    when 'ai_research'       then uc_row.ai_research
    when 'ai_question_banks' then uc_row.ai_question_banks
    when 'ai_bullets'        then uc_row.ai_bullets
  end;

  -- NULL or missing limit == unlimited.
  monthly_limit := nullif((plan_row.limits -> 'monthly' ->> quota_key), '')::int;

  if monthly_limit is not null and current_count + amount > monthly_limit then
    return jsonb_build_object(
      'allowed', false,
      'quota_key', quota_key,
      'plan_id', sub_row.plan_id,
      'used', current_count,
      'limit', monthly_limit,
      'remaining', greatest(0, monthly_limit - current_count),
      'requested', amount,
      'reason', 'quota_exhausted'
    );
  end if;

  -- Within budget — increment.
  update public.usage_counters set
    ai_resumes        = case when quota_key = 'ai_resumes'        then ai_resumes        + amount else ai_resumes        end,
    ai_covers         = case when quota_key = 'ai_covers'         then ai_covers         + amount else ai_covers         end,
    ai_mocks          = case when quota_key = 'ai_mocks'          then ai_mocks          + amount else ai_mocks          end,
    ai_research       = case when quota_key = 'ai_research'       then ai_research       + amount else ai_research       end,
    ai_question_banks = case when quota_key = 'ai_question_banks' then ai_question_banks + amount else ai_question_banks end,
    ai_bullets        = case when quota_key = 'ai_bullets'        then ai_bullets        + amount else ai_bullets        end,
    updated_at = now()
  where user_id = caller;

  return jsonb_build_object(
    'allowed', true,
    'quota_key', quota_key,
    'plan_id', sub_row.plan_id,
    'used', current_count + amount,
    'limit', monthly_limit,
    'remaining', case when monthly_limit is null then null else greatest(0, monthly_limit - (current_count + amount)) end,
    'requested', amount
  );
end;
$$;

-- =============================================================================
-- 4. get_user_entitlements: include ai_bullets in usage object + rollover
-- =============================================================================

create or replace function public.get_user_entitlements(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  sub_row public.subscriptions%rowtype;
  uc_row  public.usage_counters%rowtype;
  plan_row public.plan_catalog%rowtype;
  result jsonb;
  current_month date := date_trunc('month', now() at time zone 'utc')::date;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if caller <> target_user_id then
    if not (
      (auth.jwt() -> 'app_metadata' ->> 'role') = any(array['admin','owner','developer'])
      or exists (
        select 1 from jsonb_array_elements_text(coalesce(auth.jwt() -> 'app_metadata' -> 'roles', '[]'::jsonb)) as r
        where r = any(array['admin','owner','developer'])
      )
    ) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  insert into public.subscriptions (user_id, plan_id, status)
  values (target_user_id, 'free', 'active')
  on conflict (user_id) do nothing;

  -- Lazy provision + month rollover. Adds ai_bullets to the reset list
  -- so a new month zeroes it like all the other counters.
  insert into public.usage_counters (user_id, period_start)
  values (target_user_id, current_month)
  on conflict (user_id) do update
    set period_start = current_month,
        ai_resumes = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_resumes end,
        ai_covers  = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_covers end,
        ai_mocks   = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_mocks end,
        ai_research= case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_research end,
        ai_question_banks = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_question_banks end,
        ai_bullets = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_bullets end,
        updated_at = now();

  select * into sub_row from public.subscriptions where user_id = target_user_id;
  select * into uc_row from public.usage_counters where user_id = target_user_id;
  select * into plan_row from public.plan_catalog where plan_id = sub_row.plan_id;

  result := jsonb_build_object(
    'plan_id', sub_row.plan_id,
    'plan_label', plan_row.label,
    'plan_description', plan_row.description,
    'status', sub_row.status,
    'current_period_end', sub_row.current_period_end,
    'cancel_at_period_end', sub_row.cancel_at_period_end,
    'period_start', uc_row.period_start,
    'limits', plan_row.limits,
    'usage', jsonb_build_object(
      'ai_resumes', uc_row.ai_resumes,
      'ai_covers', uc_row.ai_covers,
      'ai_mocks', uc_row.ai_mocks,
      'ai_research', uc_row.ai_research,
      'ai_question_banks', uc_row.ai_question_banks,
      'ai_bullets', uc_row.ai_bullets
    ),
    'has_active_subscription', sub_row.plan_id <> 'free' and sub_row.status = 'active'
  );

  return result;
end;
$$;

-- =============================================================================
-- 5. Resolve the open billing-leak incident
--
-- The original Day 2 finding `billing:strengthen-bullet-unmetered` is
-- now fixed (along with the broader leak it surfaced). Mark it resolved
-- so the Health board reflects current state.
-- =============================================================================

update public.admin_incidents
set status = 'resolved',
    resolved_at = now(),
    notes = coalesce(notes, '') ||
      E'\n[' || to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') ||
      'Z] Auto-resolved by migration 0025_quota_enforcement: ai_bullets ' ||
      'quota added (free:10/plus:50/pro:250/career:unlimited) and ' ||
      'consume_quota now called server-side by ai-run for ALL metered ' ||
      'skills (not just bullets). The systemic gap this incident ' ||
      'surfaced is also closed.'
where dedup_key = 'billing:strengthen-bullet-unmetered'
  and status <> 'resolved';
