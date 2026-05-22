-- Phase Billing v2 — PayStack alongside Stripe.
--
-- Why PayStack? CareerBoost's primary market is South Africa. PayStack
-- has materially lower fees on ZAR card transactions (1.5% vs Stripe's
-- ~3.4%), native support for SA EFT/bank-transfer rails, and a customer
-- portal UX tuned for the African market. Stripe still works fine for
-- USD-paying customers globally; this migration adds PayStack columns
-- ALONGSIDE the existing Stripe ones so we can roll over progressively
-- and roll back instantly if PayStack hits an issue.
--
-- What lands here:
--   1. ZAR price columns on plan_catalog (USD prices stay)
--   2. PayStack plan-code columns per (interval, currency) pair so the
--      checkout function can map "Plus monthly ZAR" → the right PayStack
--      Plan object created in the dashboard
--   3. PayStack customer + subscription identifiers on subscriptions
--   4. Index on paystack_subscription_code for webhook lookups
--
-- What does NOT land:
--   - Removal of Stripe columns. We keep them. Stripe code keeps
--     working until we explicitly retire it (~2-3 months out, after
--     PayStack proves stable for SA + USD customers).
--   - PayStack Plan creation. That happens via the PayStack dashboard
--     (or a one-shot seed script — see docs/PAYSTACK-SETUP.md). The
--     plan_code values get pasted back into this table by hand or
--     via the admin UI.
--
-- After this migration the operator needs to:
--   1. Create 8 Plans in PayStack dashboard (Plus/Pro/Career ×
--      monthly/annual × ZAR/USD — but you can skip the Career-USD
--      tier if your global pricing fits Stripe better)
--   2. UPDATE plan_catalog SET paystack_plan_code_zar_monthly = '...'
--      WHERE plan_id = 'plus'  (etc.)

-- =============================================================================
-- 1. plan_catalog — ZAR pricing + PayStack plan codes per (interval × currency)
-- =============================================================================

alter table public.plan_catalog
  add column if not exists price_zar_monthly numeric(10, 2),
  add column if not exists price_zar_annual  numeric(10, 2),
  add column if not exists paystack_plan_code_zar_monthly text,
  add column if not exists paystack_plan_code_zar_annual  text,
  add column if not exists paystack_plan_code_usd_monthly text,
  add column if not exists paystack_plan_code_usd_annual  text;

comment on column public.plan_catalog.price_zar_monthly is
  'ZAR monthly price for South African customers. Frontend picks ZAR when locale matches; USD otherwise. NULL = free tier (or USD-only plan).';

comment on column public.plan_catalog.paystack_plan_code_zar_monthly is
  'PayStack Plan code for ZAR monthly billing. Set by operator after creating Plan in PayStack dashboard. paystack-checkout reads this when initializing a transaction for a ZAR-currency user.';

-- Seed the ZAR prices.
update public.plan_catalog set price_zar_monthly =  179.00, price_zar_annual = 1790.00 where plan_id = 'plus';
update public.plan_catalog set price_zar_monthly =  349.00, price_zar_annual = 3490.00 where plan_id = 'pro';
update public.plan_catalog set price_zar_monthly =  699.00, price_zar_annual = 6990.00 where plan_id = 'career';
-- Free plan stays NULL (no charge).

-- =============================================================================
-- 2. subscriptions — PayStack customer + subscription identifiers
--
-- These sit alongside the existing stripe_customer_id / stripe_subscription_id.
-- A user can ONLY have one active processor at a time — the checkout flow sets
-- whichever pair matches the processor they chose. We don't enforce that as a
-- constraint (would break the "switch processors" migration) but the webhook
-- + portal code treats them as mutually exclusive.
-- =============================================================================

alter table public.subscriptions
  add column if not exists paystack_customer_code     text,
  add column if not exists paystack_subscription_code text,
  -- Which processor charged this subscription. Lets the customer portal
  -- decide whether to send the user to Stripe's billing portal or
  -- PayStack's customer-portal URL. NULL until first paid transaction.
  add column if not exists payment_processor          text check (payment_processor in ('stripe', 'paystack'));

comment on column public.subscriptions.paystack_customer_code is
  'PayStack customer code (CUS_xxxxx). Set after the first successful charge via paystack-webhook. Read by paystack-portal to generate the customer''s billing-management link.';

comment on column public.subscriptions.paystack_subscription_code is
  'PayStack subscription code (SUB_xxxxx). Used to disable/cancel via PayStack API and to dedupe webhook events.';

comment on column public.subscriptions.payment_processor is
  'Which processor is billing this subscription right now. Set on first successful charge. Used by the customer portal to route management actions to the correct provider.';

create index if not exists subscriptions_paystack_customer_idx
  on public.subscriptions (paystack_customer_code)
  where paystack_customer_code is not null;

create index if not exists subscriptions_paystack_subscription_idx
  on public.subscriptions (paystack_subscription_code)
  where paystack_subscription_code is not null;

-- =============================================================================
-- 3. get_user_entitlements — also return ZAR prices so the pricing page
--    can render currency-aware copy without a separate plan_catalog read
-- =============================================================================
-- We don't recreate the function here — it returns plan_row.limits which
-- is jsonb and includes the prices via the existing schema. The frontend
-- can also hit plan_catalog directly (it's public-readable) to fetch the
-- new ZAR columns. Belt-and-braces.

-- Nothing else changes — see docs/PAYSTACK-SETUP.md for the operator
-- steps after this migration applies.
