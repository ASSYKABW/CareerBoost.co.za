-- Phase Billing: subscriptions + plan catalog + usage counters +
-- atomic entitlement RPCs. Three paid plans + Free (tightened):
--
--   Free    $0           1 resume / 2 covers / 1 mock (text) / 5 saved
--                        1 research / 1 question bank / text-only mock
--   Plus    $9.99/mo     10 res / 15 cov / 3 mocks / 100 saved
--                        5 research / unlimited question bank / voice OFF
--   Pro     $19.99/mo    unlimited res/cov/research/q-bank
--                        10 mocks, unlimited voice + saved jobs
--   Career  $39.99/mo    everything unlimited, priority AI flag
--
-- Quota types:
--   monthly_quota — numeric, resets on each new calendar month
--   feature_flag  — boolean, e.g. voice_mode_enabled, priority_ai
--   item_cap      — max items allowed (saved_jobs)
--
-- Entitlement RPC returns plan + limits + usage + remaining in ONE
-- round-trip so frontend doesn't poll multiple endpoints.
--
-- Quota consumption is ATOMIC via row-level lock — two parallel AI
-- requests can't both decrement past zero.

create extension if not exists "pgcrypto";

-- ─── Plan catalog ────────────────────────────────────────────────────
-- One row per plan. Limits stored as JSONB so we can add new quota
-- keys without a migration. NULL inside a quota = unlimited.
create table if not exists public.plan_catalog (
  plan_id           text primary key,            -- 'free' | 'plus' | 'pro' | 'career'
  label             text not null,
  description       text not null,
  monthly_price_usd numeric(8,2) not null default 0,
  annual_price_usd  numeric(8,2) not null default 0,
  stripe_price_id_monthly text,                   -- Set by operator after creating in Stripe
  stripe_price_id_annual  text,
  -- Quota limits (NULL or jsonb null == unlimited).
  -- {
  --   "monthly": {
  --     "ai_resumes": 10, "ai_covers": 15, "ai_mocks": 3,
  --     "ai_research": 5, "ai_question_banks": null
  --   },
  --   "caps":    { "saved_jobs": 100 },
  --   "features":{ "voice_mode": false, "priority_ai": false,
  --                "personal_analytics": true }
  -- }
  limits            jsonb not null default '{}'::jsonb,
  is_public         boolean not null default true,
  sort_order        int not null default 0,
  created_at        timestamptz not null default now()
);

-- Seed (idempotent — upsert pattern).
insert into public.plan_catalog (plan_id, label, description, monthly_price_usd, annual_price_usd, limits, sort_order)
values
  ('free', 'Free', 'Try CareerBoost. Limited monthly quotas.', 0, 0,
    '{
      "monthly": {
        "ai_resumes": 1,
        "ai_covers": 2,
        "ai_mocks": 1,
        "ai_research": 1,
        "ai_question_banks": 1
      },
      "caps":    { "saved_jobs": 5 },
      "features":{ "voice_mode": false, "priority_ai": false, "personal_analytics": false }
    }'::jsonb,
    0),
  ('plus', 'Plus', 'For active job seekers. More AI, more saves.', 9.99, 89.00,
    '{
      "monthly": {
        "ai_resumes": 10,
        "ai_covers": 15,
        "ai_mocks": 3,
        "ai_research": 5,
        "ai_question_banks": null
      },
      "caps":    { "saved_jobs": 100 },
      "features":{ "voice_mode": false, "priority_ai": false, "personal_analytics": true }
    }'::jsonb,
    1),
  ('pro', 'Pro', 'Unlimited AI tailoring + voice mock interviews.', 19.99, 179.00,
    '{
      "monthly": {
        "ai_resumes": null,
        "ai_covers": null,
        "ai_mocks": 10,
        "ai_research": null,
        "ai_question_banks": null
      },
      "caps":    { "saved_jobs": null },
      "features":{ "voice_mode": true, "priority_ai": false, "personal_analytics": true }
    }'::jsonb,
    2),
  ('career', 'Career', 'Everything unlimited. Priority AI. For executives + career changers.', 39.99, 349.00,
    '{
      "monthly": {
        "ai_resumes": null,
        "ai_covers": null,
        "ai_mocks": null,
        "ai_research": null,
        "ai_question_banks": null
      },
      "caps":    { "saved_jobs": null },
      "features":{ "voice_mode": true, "priority_ai": true, "personal_analytics": true }
    }'::jsonb,
    3)
on conflict (plan_id) do update set
  label = excluded.label,
  description = excluded.description,
  monthly_price_usd = excluded.monthly_price_usd,
  annual_price_usd = excluded.annual_price_usd,
  limits = excluded.limits,
  sort_order = excluded.sort_order;

-- Public read so the landing page pricing section can read plans
-- without a service-role roundtrip. Plans are not secrets.
grant select on public.plan_catalog to anon, authenticated;

-- ─── Subscriptions ───────────────────────────────────────────────────
-- One row per user. Always exists for any signed-in user (auto-created
-- as plan_id='free' on first entitlement read). Stripe fields populated
-- by the stripe-webhook function on checkout.session.completed.
create table if not exists public.subscriptions (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  plan_id                 text not null references public.plan_catalog(plan_id) default 'free',
  status                  text not null default 'active'
    check (status in ('active','past_due','canceled','incomplete','trialing','unpaid','paused')),
  -- Stripe identifiers (null until they pay).
  stripe_customer_id      text,
  stripe_subscription_id  text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  canceled_at             timestamptz,
  -- Audit metadata.
  last_event_id           text,                    -- last Stripe webhook event_id processed
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

create index if not exists subscriptions_status_idx on public.subscriptions (status);
create index if not exists subscriptions_plan_idx   on public.subscriptions (plan_id);
create index if not exists subscriptions_stripe_customer_idx on public.subscriptions (stripe_customer_id) where stripe_customer_id is not null;
create index if not exists subscriptions_stripe_subscription_idx on public.subscriptions (stripe_subscription_id) where stripe_subscription_id is not null;

alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;

drop policy if exists "subscriptions_owner_select" on public.subscriptions;
create policy "subscriptions_owner_select"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Owner can NOT insert/update directly — only service_role (via webhook)
-- can mutate subscriptions. This prevents a malicious client from
-- self-upgrading by setting plan_id=career.
revoke insert, update, delete on public.subscriptions from authenticated, anon;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

-- ─── Usage counters ──────────────────────────────────────────────────
-- One row per user. period_start tracks "current calendar month at UTC"
-- so we can detect a new month and reset on the fly (no cron needed).
-- All counters monotonically increase within a period; reset == new row
-- period_start to first-of-current-month + zero all counters.
create table if not exists public.usage_counters (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  period_start       date not null default date_trunc('month', now() at time zone 'utc')::date,
  ai_resumes         int not null default 0,
  ai_covers          int not null default 0,
  ai_mocks           int not null default 0,
  ai_research        int not null default 0,
  ai_question_banks  int not null default 0,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  constraint usage_counters_non_negative check (
    ai_resumes >= 0 and ai_covers >= 0 and ai_mocks >= 0 and
    ai_research >= 0 and ai_question_banks >= 0
  )
);

alter table public.usage_counters enable row level security;
alter table public.usage_counters force row level security;

drop policy if exists "usage_counters_owner_select" on public.usage_counters;
create policy "usage_counters_owner_select"
  on public.usage_counters for select
  using (auth.uid() = user_id);

revoke insert, update, delete on public.usage_counters from authenticated, anon;
grant select on public.usage_counters to authenticated;
grant all on public.usage_counters to service_role;

-- ─── RPC: get_user_entitlements(target_user_id) ──────────────────────
-- Returns plan + limits + usage + remaining for a user in one round-
-- trip. Lazily provisions free-tier rows for users on first call.
-- SECURITY DEFINER so authenticated users can call it for themselves
-- without write privileges on subscriptions / usage_counters.
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
  -- Only the user themselves OR an admin can read entitlements.
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if caller <> target_user_id then
    -- Allow admins (app_metadata role in ADMIN_ROLES).
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

  -- Lazy provision: free-tier subscription row.
  insert into public.subscriptions (user_id, plan_id, status)
  values (target_user_id, 'free', 'active')
  on conflict (user_id) do nothing;

  -- Lazy provision: usage row; reset if month rolled over.
  insert into public.usage_counters (user_id, period_start)
  values (target_user_id, current_month)
  on conflict (user_id) do update
    set period_start = current_month,
        ai_resumes = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_resumes end,
        ai_covers  = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_covers end,
        ai_mocks   = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_mocks end,
        ai_research= case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_research end,
        ai_question_banks = case when public.usage_counters.period_start < current_month then 0 else public.usage_counters.ai_question_banks end,
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
      'ai_question_banks', uc_row.ai_question_banks
    ),
    'has_active_subscription', sub_row.plan_id <> 'free' and sub_row.status = 'active'
  );

  return result;
end;
$$;

revoke all on function public.get_user_entitlements(uuid) from public, anon;
grant execute on function public.get_user_entitlements(uuid) to authenticated, service_role;

-- ─── RPC: consume_quota(quota_key, amount) ───────────────────────────
-- ATOMIC quota check + decrement. Returns true if the user had enough
-- quota (and the counter was incremented) or false if the cap was hit.
-- Uses row-level lock to prevent two parallel AI requests from both
-- consuming the last unit.
--
-- quota_key in: 'ai_resumes' | 'ai_covers' | 'ai_mocks' |
--               'ai_research' | 'ai_question_banks'
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
  allowed_keys text[] := array['ai_resumes','ai_covers','ai_mocks','ai_research','ai_question_banks'];
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

revoke all on function public.consume_quota(text, int) from public, anon;
grant execute on function public.consume_quota(text, int) to authenticated, service_role;

comment on table public.plan_catalog is
  'Phase Billing: pricing tier definitions. Limits stored as JSONB so quota keys can be added without migrations. Public-readable so the landing page pricing section can render without auth.';
comment on table public.subscriptions is
  'Phase Billing: one row per user. Always present (auto-created as free on first entitlement read). Stripe fields populated by stripe-webhook. Owner read-only; service_role write-only.';
comment on table public.usage_counters is
  'Phase Billing: per-user monthly counter. period_start resets on first call in a new calendar month. RPC consume_quota() is the only sanctioned mutation path.';
comment on function public.get_user_entitlements is
  'Phase Billing: returns merged plan + usage + remaining for the caller (or admin lookup of any user). Lazy-provisions free-tier rows + resets usage on new month.';
comment on function public.consume_quota is
  'Phase Billing: atomic check + decrement for a single quota key. Returns {allowed, used, limit, remaining}. Row-locked to prevent parallel race.';
