# Resend transactional sends — operator setup

Backend code is shipped (migration 0028, `admin-send-email` and
`admin-resend-webhook` edge functions, frontend wiring). This is the
**manual setup** you do on the Resend side before the admin "Send
email" buttons actually deliver mail.

> Why this isn't fully automated: domain verification + webhook
> registration both require dashboard interaction in Resend. ~15
> minutes total.

---

## What's already in your stack

Day 1 wired Resend's SMTP credentials into Supabase Auth Emails
(confirmation, password reset, etc.) via the Supabase Dashboard. That
flow keeps working as-is — Supabase talks directly to Resend SMTP.

This Week 2 setup adds the **REST API** path so our own Edge Functions
can send arbitrary transactional emails (admin support replies, bulk
announcements) with delivery tracking. Same Resend account, different
auth scheme (API key vs SMTP creds).

---

## Step 1 — Get your Resend API key + sender details

1. Sign in at **https://resend.com**
2. **API Keys** → **Create API Key**
   - **Name:** `careerboost-backend`
   - **Permission:** **Sending access** (full access not required)
   - **Domain:** select your verified domain (the one Day 1 set up — likely `careerboost.co.za` or a subdomain)
3. **Copy the key** (starts with `re_...`). You only see it once.

If your domain isn't verified yet:
- **Domains** → **Add Domain** → enter `careerboost.co.za`
- Add the DNS records Resend shows (typically MX, TXT, DKIM CNAMEs) at your DNS provider (Vercel/Cloudflare/wherever)
- Wait for the green "Verified" badge (5min–24h depending on DNS propagation)

## Step 2 — Pick a sender address

Pick the From address you want appearing in user inboxes. Common choices:
- `support@careerboost.co.za` — for replies + support
- `noreply@careerboost.co.za` — for one-way notifications
- `team@careerboost.co.za` — friendlier human feel

Use whatever makes sense for your brand. The local part (before `@`)
doesn't need to be a real inbox — Resend handles routing.

## Step 3 — Set Supabase secrets

Open `backend/.env` and add these three lines:

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
RESEND_FROM_EMAIL=support@careerboost.co.za
RESEND_FROM_NAME=CareerBoost Support
```

Then push:

```bash
cd backend
npm run secrets:push
```

You should see `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`
in the output. (Plus any existing keys.)

## Step 4 — Apply the migration + deploy the edge functions

```bash
cd backend
npm run db:push                          # migration 0028
npm run fn:deploy:admin-send-email       # outbound
npm run fn:deploy:admin-resend-webhook   # inbound delivery events
```

Note the webhook URL printed by the second deploy — it'll be:

```
https://kddffkhwpbngiupfmcse.functions.supabase.co/admin-resend-webhook
```

You'll register that URL in Step 5.

## Step 5 — Register the Resend webhook

This is what gives you per-message delivery status (delivered / bounced
/ opened / etc.) showing up in `admin_email_log`.

1. Resend Dashboard → **Webhooks** → **Add Endpoint**
2. **Endpoint URL:**
   ```
   https://kddffkhwpbngiupfmcse.functions.supabase.co/admin-resend-webhook
   ```
3. **Events to listen for:** select these 5 (skip `email.clicked` and `email.delivery_delayed` — they create webhook noise without changing state we track):
   - `email.sent`
   - `email.delivered`
   - `email.bounced`
   - `email.complained`
   - `email.opened`
4. Click **Add Endpoint**
5. **Copy the signing secret** Resend shows (starts with `whsec_...`)
6. Add to `backend/.env`:
   ```
   RESEND_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
7. Push the new secret:
   ```bash
   npm run secrets:push
   ```

The webhook will start firing immediately. Test in Step 6.

## Step 6 — End-to-end test

1. Open `/admin` → **Users & outcomes** → click any user with an email
2. Click the **Email** action → fill in a test subject + body
3. Submit. You should see a green toast: *"Sent to <email>. Delivery confirmation arrives within a minute."*
4. Check the recipient inbox — email should arrive within ~10 seconds
5. Verify in Supabase SQL editor:
   ```sql
   select id, recipient_email, subject, status,
          sent_at, delivered_at, error_message
   from admin_email_log
   order by created_at desc
   limit 5;
   ```
   You should see a row with `status='sent'` then (after ~30s) `status='delivered'` with `delivered_at` filled.

If the row stays at `status='sent'` after 2 minutes:
- Webhook didn't fire — check Resend dashboard → Webhooks → the endpoint should show recent attempts + status codes
- 401 from our endpoint → signing secret mismatch, re-push `RESEND_WEBHOOK_SECRET`
- 500 from our endpoint → check Supabase Edge Function logs

---

## Bulk send test (when you're ready)

In Users & outcomes, select 2–3 test users (use checkboxes), then
**Bulk actions → Send email**. Same flow — one POST sends to all
selected, each becomes a row in `admin_email_log`.

The dry-run preview still shows the recipient list before sending. The
operator audit log gets ONE row per batch (with subject + counts), not
one per recipient — the per-recipient detail lives in `admin_email_log`.

---

## Privacy + retention

- **Body content is NEVER stored in our DB.** Only subject + char
  count + delivery metadata. The actual email body lives in Resend's
  records (accessible via their dashboard if needed for support).
- **Admin audit log** records the send action with subject + recipient
  count. No body content.
- `admin_email_log` rows are kept indefinitely for billing reconciliation
  and bounce-rate tracking. Add a retention sweep cron later if storage
  becomes a concern (unlikely — text rows are tiny).

---

## Troubleshooting

**"Resend not configured" 503 response**
→ `RESEND_API_KEY` or `RESEND_FROM_EMAIL` not in Supabase secrets.
Re-check `.env` and re-run `npm run secrets:push`.

**"Resend HTTP 422: validation_error / from_address_not_verified"**
→ The `RESEND_FROM_EMAIL` domain isn't verified in Resend. Either
verify it (Step 1) or temporarily use Resend's sandbox sender
`onboarding@resend.dev` (no domain verification needed but every
email shows a "via resend.dev" disclaimer to recipients).

**"Resend HTTP 429: rate_limit_exceeded"**
→ Free Resend tier caps at 100 emails/day, 10/sec. Bulk send of 100+
will throttle. The edge function already sends sequentially to stay
under 10/sec; for daily volume past 100, upgrade Resend or split the
batch over multiple days.

**Webhook events not arriving even though emails go out**
→ The webhook URL must be reachable from Resend's servers (public
internet). Supabase Edge Functions are publicly reachable; if you
ever move to private infra, you need a public proxy.

**Recipient marks email as spam → status=complained**
→ This is permanent for that recipient. Don't email them again from
this address. The admin UI surfaces complained status so you see it.

---

## What this DOESN'T do (deferred)

- **Email templates** — currently the operator types raw HTML/text
  per send. A template gallery (saved templates, mail-merge tags) is
  Week 3+.
- **Unsubscribe links** — for true marketing emails (not transactional
  support replies), you legally need an unsubscribe footer. Resend
  has a List-Unsubscribe header helper; wire it in if/when bulk
  marketing happens. Transactional sends (account-specific replies)
  don't require it.
- **Email previews + send-test-to-self** — operator currently has to
  trust the body they typed renders correctly. Send-to-self preview
  before bulk would catch HTML mistakes; nice-to-have.
