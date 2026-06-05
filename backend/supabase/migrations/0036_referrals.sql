-- 0036_referrals.sql: Marketing engine — referral tracking.
--
-- Two tables:
--   referral_codes — one shareable code per user (the referrer). Created
--     on demand by the `referral` edge fn (get-or-create).
--   referrals      — one row per referred signup. Written by
--     signup-attribution when a new user signs up carrying a ?ref=<code>
--     that resolves to a referrer (and isn't a self-referral).
--
-- Reward is intentionally NOT auto-granted: status starts at 'confirmed'
-- (the referred user signed up) and an operator/future reward flow flips it
-- to 'rewarded' and stamps reward_meta. This keeps a human in the loop until
-- the reward model is decided (and avoids any POPIA/consent surprises).
--
-- RLS on, no policies — all access is via edge functions (service_role for
-- writes; the leaderboard RPC is security-definer + admin-gated at the edge).

create table if not exists referral_codes (
  code        text primary key,
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table referral_codes is 'One shareable referral code per user (referrer). Get-or-created by the referral edge fn.';

alter table referral_codes enable row level security;
-- No policies: edge fns use service_role.

create table if not exists referrals (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  referrer_id  uuid not null references auth.users (id) on delete cascade,
  referred_id  uuid not null unique references auth.users (id) on delete cascade,
  status       text not null default 'confirmed'
               check (status in ('pending', 'confirmed', 'rewarded', 'void')),
  reward_meta  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  rewarded_at  timestamptz
);

comment on table referrals is 'One row per referred signup. referred_id is unique (a user can only be referred once). Reward is granted manually — status flips to rewarded + reward_meta is stamped by an operator/future flow.';

create index if not exists referrals_referrer_idx on referrals (referrer_id, created_at desc);

alter table referrals enable row level security;
-- No policies: written by signup-attribution (service_role), read via RPC.

-- Admin leaderboard: who has referred the most signups. security definer so
-- it can read across users; admin-gated at the edge (admin-content).
create or replace function marketing_referral_leaderboard()
returns table (
  referrer_id uuid,
  full_name   text,
  referrals   bigint,
  rewarded    bigint,
  last_at     timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    r.referrer_id,
    p.full_name,
    count(*)                                         as referrals,
    count(*) filter (where r.status = 'rewarded')    as rewarded,
    max(r.created_at)                                as last_at
  from referrals r
  left join profiles p on p.user_id = r.referrer_id
  group by r.referrer_id, p.full_name
  order by count(*) desc, max(r.created_at) desc
  limit 100;
$$;

comment on function marketing_referral_leaderboard() is 'Top referrers by confirmed referral count. Called by admin-content (service_role).';
