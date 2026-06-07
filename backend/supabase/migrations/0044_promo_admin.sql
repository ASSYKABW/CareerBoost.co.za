-- Admin-managed promotions.
--
-- Moves the intro-discount campaign off env vars and into the DB so it can
-- be run from the admin panel with instant effect (no function redeploy),
-- and adds per-account promo grants (percentage discounts + free-month
-- comps). The paystack-checkout function reads these at runtime.
--
-- Phase 1 uses promo_settings (the global campaign).
-- Phase 2a/2b use promo_grants (targeted, per-user).

-- ─── Global campaign config (single row) ─────────────────────────────
create table if not exists public.promo_settings (
  id          smallint primary key default 1,
  enabled     boolean  not null default false,
  percent     int      not null default 30 check (percent > 0 and percent < 100),
  end_date    date,
  -- Which plans / billing intervals the global promo applies to.
  plans       text[]   not null default array['plus','pro','career'],
  intervals   text[]   not null default array['monthly'],
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  constraint promo_settings_singleton check (id = 1)
);

-- Seed with the CURRENT live campaign so the cut-over from env vars to DB
-- changes nothing for existing customers.
insert into public.promo_settings (id, enabled, percent, end_date, plans, intervals)
values (1, true, 30, '2026-10-06', array['plus','pro','career'], array['monthly'])
on conflict (id) do nothing;

-- The landing banner (anon) and in-app modal (authenticated) read the live
-- campaign state to decide whether to advertise it. Not sensitive — it's a
-- public promotion — so a direct read is fine; writes stay service-role only.
alter table public.promo_settings enable row level security;
drop policy if exists "promo_settings_public_read" on public.promo_settings;
create policy "promo_settings_public_read" on public.promo_settings for select using (true);
grant select on public.promo_settings to anon, authenticated;
grant all on public.promo_settings to service_role;

-- ─── Per-account grants ──────────────────────────────────────────────
create table if not exists public.promo_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- 'percent'      → value% off their next subscription's first charge
  -- 'free_months'  → free_months on plan_id (comp), enforced via expiry
  kind         text not null check (kind in ('percent','free_months')),
  percent      int  check (percent > 0 and percent < 100),
  free_months  int  check (free_months > 0),
  plan_id      text references public.plan_catalog(plan_id),
  interval     text check (interval in ('monthly','annual')),
  status       text not null default 'active'
               check (status in ('active','redeemed','revoked','expired')),
  note         text,
  granted_by   uuid,
  expires_at   timestamptz,
  redeemed_at  timestamptz,
  created_at   timestamptz not null default now(),
  -- Shape guard: each kind carries its own value.
  constraint promo_grants_kind_value check (
    (kind = 'percent'     and percent     is not null) or
    (kind = 'free_months' and free_months is not null and plan_id is not null)
  )
);

-- One active grant per user lookup (checkout reads this hot path).
create index if not exists promo_grants_user_active_idx
  on public.promo_grants (user_id) where status = 'active';

-- Service-role only: granted by admins via the admin-promo function,
-- read by paystack-checkout via the service client. Users never touch it.
alter table public.promo_grants enable row level security;
grant all on public.promo_grants to service_role;

comment on table public.promo_settings is
  'Global promo campaign config (single row id=1). Admin-editable via admin-promo; read by paystack-checkout, the landing banner, and the upgrade modal. Replaces the INTRO_DISCOUNT_* env vars.';
comment on table public.promo_grants is
  'Per-account promo grants. kind=percent → % off next subscription; kind=free_months → comped months on a plan (expiry-enforced). Written by admin-promo, read by paystack-checkout.';
