-- Intro discount campaign — "30% off your first subscription".
--
-- Mechanics live in the edge functions (Paystack has no native coupon
-- engine for subscriptions):
--   1. paystack-checkout: for an eligible FIRST-TIME subscriber on a
--      MONTHLY plan, inside the campaign window, it charges a one-time
--      DISCOUNTED amount (no plan attached) instead of the usual
--      plan-based full-price subscription transaction.
--   2. paystack-webhook: on that discounted charge succeeding, it creates
--      the real recurring subscription with start_date one interval in the
--      future (full price), and stamps intro_discount_redeemed_at below.
--
-- This column is the one-per-user guard: checkout refuses the discount if
-- it is already set, and it doubles as an audit of who used the promo.
-- Campaign on/off + window + percentage are env-driven on the function
-- (INTRO_DISCOUNT_ENABLED / INTRO_DISCOUNT_END / INTRO_DISCOUNT_PCT), so
-- no migration is needed to start/stop it.

alter table public.subscriptions
  add column if not exists intro_discount_redeemed_at timestamptz;

comment on column public.subscriptions.intro_discount_redeemed_at is
  'When the user redeemed the first-subscription intro discount (Paystack discounted one-time charge + deferred full-price subscription). NULL = not redeemed. Written by paystack-webhook; read by paystack-checkout to enforce one-per-user.';
