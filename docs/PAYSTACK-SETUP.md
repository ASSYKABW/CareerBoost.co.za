# PayStack — operator setup checklist

Backend code is shipped (migration 0027 + three edge functions). This is
the **manual setup** you do in the PayStack dashboard before users can
actually pay. ~30 minutes total. Test mode first.

> Why these steps aren't automated: PayStack Plans are billable
> products in their system. Creating them via API is possible but
> means the API key needs Plan-create permissions, which is more
> attack surface than is worth it for an 8-row one-off setup.

---

## Step 1 — Apply the migration

```bash
cd backend
npm run db:push
```

This adds `paystack_*` columns to `subscriptions` + `plan_catalog`, plus
sets the ZAR prices (R179 / R349 / R699 per month, etc.). Verify with:

```sql
select plan_id, price_zar_monthly, price_zar_annual,
       monthly_price_usd, annual_price_usd
from plan_catalog order by sort_order;
```

You should see ZAR prices populated for plus/pro/career (free stays NULL).

---

## Step 2 — Deploy the edge functions

```bash
npm run fn:deploy:paystack
```

That runs all 3 deploys (`paystack-checkout`, `paystack-webhook`,
`paystack-portal`). Each takes ~10s.

After deploy, note the webhook URL:
```
https://kddffkhwpbngiupfmcse.functions.supabase.co/paystack-webhook
```

You'll register it in Step 4.

---

## Step 3 — Create the 8 Plans in the PayStack dashboard

PayStack dashboard → **Plans** → **Create Plan** (one Plan per row).

> **Important:** Make sure the currency dropdown at the top of the
> dashboard is set to **Test mode** for now. Each Plan must be created
> separately for ZAR and USD — PayStack doesn't multi-currency a single
> Plan.

| Plan name (PayStack) | Currency | Interval | Amount (in cents) | What to type |
|---|---|---|---|---|
| Plus Monthly (ZAR) | ZAR | monthly | 17900 | R179.00 |
| Plus Annual (ZAR) | ZAR | annually | 179000 | R1,790.00 |
| Pro Monthly (ZAR) | ZAR | monthly | 34900 | R349.00 |
| Pro Annual (ZAR) | ZAR | annually | 349000 | R3,490.00 |
| Career Monthly (ZAR) | ZAR | monthly | 69900 | R699.00 |
| Career Annual (ZAR) | ZAR | annually | 699000 | R6,990.00 |
| Plus Monthly (USD) | USD | monthly | 999 | $9.99 |
| Plus Annual (USD) | USD | annually | 8900 | $89.00 |
| Pro Monthly (USD) | USD | monthly | 1999 | $19.99 |
| Pro Annual (USD) | USD | annually | 17900 | $179.00 |
| Career Monthly (USD) | USD | monthly | 3999 | $39.99 |
| Career Annual (USD) | USD | annually | 34900 | $349.00 |

(That's 12 Plans total. If you don't want USD billing yet, skip rows
7–12 — you can add them later without code changes.)

After creating each Plan, PayStack shows you a **Plan code** like
`PLN_xxxxxxxx`. **Copy it.** You'll paste them into the DB in Step 5.

---

## Step 4 — Register the webhook

PayStack dashboard → **Settings → API Keys & Webhooks** → **Test webhook
URL** field:

```
https://kddffkhwpbngiupfmcse.functions.supabase.co/paystack-webhook
```

Click **Save**. PayStack will fire a test ping to verify it's
reachable — should respond 200 within 5s.

PayStack signs webhooks with your **Test Secret Key** (the same
`sk_test_*` already in your `.env`). No separate webhook secret to
configure — the `paystack-webhook` function uses `PAYSTACK_SECRET_KEY`
for HMAC verification.

---

## Step 5 — Paste the Plan codes into the database

Open Supabase SQL Editor. Run these (replace `PLN_xxx` with the actual
codes from Step 3):

```sql
update plan_catalog set
  paystack_plan_code_zar_monthly = 'PLN_xxxxxxxx',  -- Plus Monthly (ZAR)
  paystack_plan_code_zar_annual  = 'PLN_xxxxxxxx',  -- Plus Annual (ZAR)
  paystack_plan_code_usd_monthly = 'PLN_xxxxxxxx',  -- Plus Monthly (USD)
  paystack_plan_code_usd_annual  = 'PLN_xxxxxxxx'   -- Plus Annual (USD)
where plan_id = 'plus';

update plan_catalog set
  paystack_plan_code_zar_monthly = 'PLN_xxxxxxxx',
  paystack_plan_code_zar_annual  = 'PLN_xxxxxxxx',
  paystack_plan_code_usd_monthly = 'PLN_xxxxxxxx',
  paystack_plan_code_usd_annual  = 'PLN_xxxxxxxx'
where plan_id = 'pro';

update plan_catalog set
  paystack_plan_code_zar_monthly = 'PLN_xxxxxxxx',
  paystack_plan_code_zar_annual  = 'PLN_xxxxxxxx',
  paystack_plan_code_usd_monthly = 'PLN_xxxxxxxx',
  paystack_plan_code_usd_annual  = 'PLN_xxxxxxxx'
where plan_id = 'career';
```

Verify:

```sql
select plan_id, paystack_plan_code_zar_monthly, paystack_plan_code_zar_annual,
       paystack_plan_code_usd_monthly, paystack_plan_code_usd_annual
from plan_catalog order by sort_order;
```

All 12 codes should be populated.

---

## Step 6 — Test the full flow

1. Sign up as a fresh test user (or use an existing one set to Free).
2. From the app, trigger upgrade: pricing page → **Upgrade to Plus**.
3. You should be redirected to PayStack's hosted checkout.
4. Use a PayStack **test card**:
   - Success: `4084 0840 8408 4081` (any CVV, any future expiry, PIN `0000`, OTP `123456`)
   - Decline: `4084 0840 8408 4099`
   - Insufficient funds: `5060 6666 6666 6666 666`
5. Pay → PayStack redirects you to `careerboost.co.za/#/settings?tab=account&billing=success`
6. Within ~5 seconds the webhook fires → check the user's subscription
   in DB:

```sql
select user_id, plan_id, status, payment_processor,
       paystack_customer_code, paystack_subscription_code
from subscriptions
where user_id = '<test-user-id>';
```

`plan_id` should be `'plus'`, `payment_processor = 'paystack'`,
`paystack_customer_code` and `paystack_subscription_code` populated.

If the webhook didn't fire, check the Supabase Edge Function logs:
```
https://supabase.com/dashboard/project/kddffkhwpbngiupfmcse/functions/paystack-webhook/logs
```

---

## Step 7 — Switch to Live mode (when ready)

1. Verify your PayStack business (ID + bank account) if you haven't
2. Toggle dashboard to **Live mode**
3. Re-do Steps 3–5 in Live mode (Plans created in test don't carry over)
4. Update `.env`:
   ```
   PAYSTACK_SECRET_KEY=sk_live_xxxxx
   PAYSTACK_PUBLIC_KEY=pk_live_xxxxx
   ```
5. `cd backend && npm run secrets:push`
6. Register the same webhook URL in Live mode webhooks section
7. Update plan_catalog with the Live mode plan codes
8. Run through Step 6 with a real card (use a low-value plan first)

---

## Troubleshooting

**`paystack-checkout` returns 503 "Plan code missing"**
→ Step 5 incomplete — `paystack_plan_code_*` not populated for that
plan/currency/interval combo.

**Webhook test ping from PayStack returns 401 "Invalid signature"**
→ The webhook code expects the request body to be HMAC-SHA512-signed
with your `PAYSTACK_SECRET_KEY`. If you rotated keys after registering
the webhook, the secrets are out of sync — re-push via
`npm run secrets:push`.

**Charge succeeds but user not upgraded**
→ The `charge.success` event handler needs `metadata.user_id` to know
who paid. The checkout function sets this automatically. If you're
seeing this, check the event payload in PayStack dashboard → Events log
and the corresponding line in Edge Function logs.

**"Your subscription is billed by stripe, not PayStack"** when clicking
Manage subscription
→ The user upgraded via Stripe historically. Use the Stripe portal
button instead. After PayStack proves stable + Stripe is retired
(~2-3 months out), this branch goes away.
