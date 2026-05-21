-- Day 4.4 — Soft-delete accounts with a 7-day grace window.
--
-- Background: the existing delete-account Edge Function hard-deletes
-- the user's data + auth.users row in one call. That's a one-way
-- destructive action with no recovery if the user changes their mind
-- (or mis-tapped). Recovery costs them the entire account history.
--
-- New flow:
--   1. User confirms deletion in Settings → marks the account with
--      pending_deletion_at = now() + 7 days. Account stays fully
--      usable during the grace window — the user can sign in, edit
--      resumes, apply to jobs as normal.
--   2. A persistent banner at the top of every page reminds them of
--      the scheduled purge date with a "Restore account" button.
--   3. After 7 days, an ops cron (or manual run) calls
--      public.purge_pending_deletions() which actually nukes the
--      data + auth.users row.
--
-- If they cancel within the window: pending_deletion_at gets cleared
-- and life continues.
--
-- The hard-delete path stays available via { mode: "immediate" } on
-- the edge function for GDPR right-to-be-forgotten requests where
-- the user explicitly wants no grace window.

-- =============================================================================
-- 1. Schema: pending_deletion_at + audit timestamps on profiles
-- =============================================================================

alter table public.profiles
  add column if not exists pending_deletion_at           timestamptz,
  add column if not exists pending_deletion_initiated_at timestamptz;

-- Partial index over only rows actually pending — keeps the index
-- tiny and the cron lookup O(active deletions) not O(all users).
create index if not exists profiles_pending_deletion_idx
  on public.profiles (pending_deletion_at)
  where pending_deletion_at is not null;

comment on column public.profiles.pending_deletion_at is
  'When set, the account is scheduled for hard-delete at this UTC time. Cleared if the user restores via cancel_account_deletion(). Set 7 days ahead by request_account_deletion().';

-- =============================================================================
-- 2. RPC: request_account_deletion(grace_days int default 7)
--
-- Authenticated users call this to schedule their own deletion. Idempotent:
-- calling twice in the grace window just resets the clock to now+grace.
-- The profile row is upserted because some users may not have triggered
-- profile creation yet at the time they delete.
-- =============================================================================

create or replace function public.request_account_deletion(grace_days int default 7)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  purge_at timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Bound the grace days so a hostile caller can't schedule deletion
  -- 99 years in the future (or in the past).
  if grace_days is null or grace_days < 1 then grace_days := 7; end if;
  if grace_days > 30 then grace_days := 30; end if;

  purge_at := (now() at time zone 'utc') + (grace_days || ' days')::interval;

  -- Upsert: lazy-create profile if missing so this works for users
  -- who never finished onboarding but want to delete the account.
  insert into public.profiles (user_id, pending_deletion_at, pending_deletion_initiated_at)
  values (caller, purge_at, now())
  on conflict (user_id) do update
    set pending_deletion_at = excluded.pending_deletion_at,
        pending_deletion_initiated_at = excluded.pending_deletion_initiated_at;

  return jsonb_build_object(
    'ok', true,
    'scheduled_for', purge_at,
    'grace_days', grace_days,
    'initiated_at', now()
  );
end;
$$;

revoke all on function public.request_account_deletion(int) from public, anon;
grant execute on function public.request_account_deletion(int) to authenticated, service_role;

-- =============================================================================
-- 3. RPC: cancel_account_deletion()
--
-- Authenticated users call this to unschedule a pending deletion.
-- Returns ok regardless of whether there was actually a pending
-- deletion — idempotent for the UI restore button.
-- =============================================================================

create or replace function public.cancel_account_deletion()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  update public.profiles
    set pending_deletion_at = null,
        pending_deletion_initiated_at = null
    where user_id = caller;

  return jsonb_build_object('ok', true, 'restored_at', now());
end;
$$;

revoke all on function public.cancel_account_deletion() from public, anon;
grant execute on function public.cancel_account_deletion() to authenticated, service_role;

-- =============================================================================
-- 4. RPC: purge_pending_deletions()
--
-- Service-role only. Run manually or via pg_cron after the grace
-- period elapses. For each profile with pending_deletion_at < now,
-- deletes the user-scoped tables then the auth.users row, mirroring
-- what the delete-account Edge Function does for immediate deletes.
--
-- Returns: { purged: N, attempted: [user_ids...] }
--
-- NOTE: we don't drop pg_cron schedule here — that's an ops setup
-- step (see docs/RUNBOOK-DELETION.md or run manually). Doing it in
-- migration would couple deployment to pg_cron availability.
-- =============================================================================

create or replace function public.purge_pending_deletions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  victim record;
  purged_count int := 0;
  attempted_ids uuid[] := '{}';
  user_tables text[] := array[
    'applications', 'events', 'resumes', 'cover_letters',
    'interview_sets', 'interview_outcomes', 'saved_jobs',
    'saved_searches', 'api_keys', 'ai_usage', 'ai_rate_limits',
    'usage_events', 'usage_sessions', 'usage_counters',
    'client_telemetry', 'subscriptions', 'profiles'
  ];
  tbl text;
  cmd text;
begin
  for victim in
    select user_id, pending_deletion_at
    from public.profiles
    where pending_deletion_at is not null
      and pending_deletion_at < now()
    order by pending_deletion_at asc
    limit 500   -- bound the batch so a runaway cron doesn't take down the DB
  loop
    attempted_ids := array_append(attempted_ids, victim.user_id);
    foreach tbl in array user_tables loop
      cmd := format('delete from public.%I where user_id = $1', tbl);
      begin
        execute cmd using victim.user_id;
      exception when others then
        -- Don't abort the batch on a single-table failure (could be
        -- a column drift in some user-scoped table). Log via raise
        -- notice so we see it in postgres logs.
        raise notice '[purge_pending_deletions] failed % for %: %',
          tbl, victim.user_id, sqlerrm;
      end;
    end loop;
    -- Auth.users delete — this is the real "account is gone" step.
    -- We delete from auth.users via the admin schema; cascade FKs
    -- will then sweep anything we missed.
    begin
      delete from auth.users where id = victim.user_id;
      purged_count := purged_count + 1;
    exception when others then
      raise notice '[purge_pending_deletions] auth.users delete failed for %: %',
        victim.user_id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object(
    'purged', purged_count,
    'attempted', attempted_ids,
    'ran_at', now()
  );
end;
$$;

revoke all on function public.purge_pending_deletions() from public, anon, authenticated;
grant execute on function public.purge_pending_deletions() to service_role;

-- =============================================================================
-- 5. Update get_user_entitlements to expose pending_deletion_at so the
--    client can show the restore banner without a separate fetch.
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
  profile_row public.profiles%rowtype;
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
  select * into profile_row from public.profiles where user_id = target_user_id;

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
    'has_active_subscription', sub_row.plan_id <> 'free' and sub_row.status = 'active',
    -- Day 4.4 — soft-delete state. Client uses this to show the
    -- "scheduled for deletion" banner + Restore button.
    'pending_deletion_at', profile_row.pending_deletion_at,
    'pending_deletion_initiated_at', profile_row.pending_deletion_initiated_at
  );

  return result;
end;
$$;
