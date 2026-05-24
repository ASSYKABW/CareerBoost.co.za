-- 0030_reprice_plans.sql
--
-- Pricing update + Career tier retirement.
--
-- Changes:
--   1. Plus:   USD $9.99/$89.00  → $11.99/$119.00
--              ZAR R179/R1790    → R210/R2100
--   2. Pro:    USD $19.99/$179.00 → $21.99/$219.00
--              ZAR R349/R3490    → R380/R3800
--              limits.ai_mocks  → null  (unlimited voice mocks, absorbing Career)
--              limits.priority_ai → true (absorbing Career)
--   3. Career: marked is_purchasable = false — existing subscribers keep
--              their entitlements, checkout blocks new Career purchases.
--
-- Annual prices preserve the ~17% discount over monthly × 12.
-- Career plan rows and existing subscriptions are NOT deleted — we only
-- prevent new signups from selecting it.

-- =============================================================================
-- 1. Add is_purchasable flag (default true — existing plans unaffected)
-- =============================================================================
alter table public.plan_catalog
  add column if not exists is_purchasable boolean not null default true;

comment on column public.plan_catalog.is_purchasable is
  'When false, the plan cannot be selected at checkout. Existing subscribers
   on this plan keep their entitlements; only new purchases are blocked.
   Used to soft-retire plans without breaking active subscriptions.';

-- =============================================================================
-- 2. Update Plus pricing
-- =============================================================================
update public.plan_catalog
set
  monthly_price_usd = 11.99,
  annual_price_usd  = 119.00,
  price_zar_monthly = 210.00,
  price_zar_annual  = 2100.00
where plan_id = 'plus';

-- =============================================================================
-- 3. Update Pro pricing + absorb Career features into limits
-- =============================================================================
update public.plan_catalog
set
  monthly_price_usd = 21.99,
  annual_price_usd  = 219.00,
  price_zar_monthly = 380.00,
  price_zar_annual  = 3800.00,
  description       = 'Unlimited everything + priority AI and support.',
  limits = jsonb_set(
    jsonb_set(
      jsonb_set(
        limits,
        '{monthly,ai_mocks}', 'null'::jsonb
      ),
      '{features,priority_ai}', 'true'::jsonb
    ),
    '{features,priority_support}', 'true'::jsonb
  )
where plan_id = 'pro';

-- =============================================================================
-- 4. Retire Career tier — block new purchases, keep existing entitlements
-- =============================================================================
update public.plan_catalog
set
  is_purchasable = false,
  description    = 'Legacy plan. No longer available for new subscriptions.'
where plan_id = 'career';
