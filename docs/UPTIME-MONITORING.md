# External Uptime Monitoring — Setup Guide

CareerBoost runs on three independent pieces of infrastructure:
- **Vercel** serves the static frontend (`www.careerboost.co.za`).
- **Supabase Postgres** stores user data + auth.
- **Supabase Edge Functions** run the AI/admin endpoints.

Any one can go down independently. This guide sets up free external
synthetic checks so you find out *before* a user emails you.

---

## Recommended: UptimeRobot (free tier)

Free tier covers 50 monitors at 5-minute intervals — way more than
we need. Sign up at https://uptimerobot.com (no card needed).

### Monitors to create

| # | Name | Type | URL | Expected | Notes |
|---|---|---|---|---|---|
| 1 | CareerBoost frontend | HTTP(s) | `https://www.careerboost.co.za` | 200 | Vercel CDN check |
| 2 | Apex → www redirect | HTTP(s) | `https://careerboost.co.za` | 308 or 200 | Verify Vercel apex redirect still fires |
| 3 | Privacy page | HTTP(s) | `https://www.careerboost.co.za/privacy` | 200 | Verifies P2.1 SPA fallback rewrite works |
| 4 | Supabase REST | HTTP(s) | `https://kddffkhwpbngiupfmcse.supabase.co/rest/v1/` | 200 (with anon header) | DB/API gateway |
| 5 | Edge: get-entitlements | HTTP(s) — keyword | `https://kddffkhwpbngiupfmcse.supabase.co/functions/v1/get-entitlements` | Body contains `"ok"` | OPTIONS preflight is enough |
| 6 | Edge: ai-run health | HTTP(s) | `https://kddffkhwpbngiupfmcse.supabase.co/functions/v1/ai-run` | 401 (missing auth) | A 401 means it's alive; 5xx or timeout = down |

For monitors 4-6, add a custom HTTP header in UptimeRobot:
```
apikey: <your supabase anon key>
```
You can find it in Supabase Dashboard → Project Settings → API.

### Alerts to set up

Under "My Settings" → "Alert Contacts":
1. **Email** to your operator address — primary channel.
2. **Slack/Discord webhook** if you have a team channel — secondary
   (optional but recommended; outage emails get lost in inbox).
3. **SMS** — pay-as-you-go on UptimeRobot, ~$1 each. Worth enabling
   for the frontend monitor only (#1) since that's the customer-
   facing SLA.

Alert rules:
- Frontend (#1): notify immediately on any 5xx or timeout.
- All others: notify after 2 consecutive failures (avoids transient
  noise from CDN edge node hiccups).

---

## Alternative: Better Stack (formerly Better Uptime)

If you want richer dashboards or a status page (e.g. status.careerboost.co.za),
Better Stack's free tier includes:
- 10 monitors, 3-min intervals
- A hosted status page (great for "the trust signal" on the marketing site)
- Incident management + on-call rotation (useful when you have a team)

Setup is similar — same 6 endpoints.

---

## What to do when an alert fires

Quick triage runbook:

1. **Frontend down (monitor #1)?**
   - Check Vercel dashboard: https://vercel.com/dashboard
   - Most likely a deploy regression — look at the latest deploy log.
   - Roll back via Vercel UI ("Promote to production" on a known-good commit).

2. **DB down (monitor #4)?**
   - Check Supabase status: https://status.supabase.com
   - If Supabase-wide: nothing to do, wait.
   - If project-specific: dashboard usually shows quota issues or
     paused project. Resume / upgrade plan.

3. **One edge function down (monitor #5 or #6)?**
   - Check the function logs in Supabase Dashboard → Edge Functions.
   - Re-deploy if it's a runtime crash: `npm run fn:deploy:<name>`.
   - Function deploys are independent; one failing doesn't affect others.

4. **All Supabase monitors down but frontend OK?**
   - DB outage. Frontend still loads but features that need data will
     be broken. Post a banner if it's >5min (use the cookie-banner
     pattern — easy to repurpose).

---

## What's NOT covered by these checks

Synthetic HTTP checks tell you "the surface is reachable." They don't
verify business logic. Real outages they'll **miss**:
- Auth working but signup broken (e.g. profile insert RLS regression)
- AI calls return 200 but with garbage content (model issue)
- Billing webhook silently dropping events
- Email delivery (no transactional email setup yet)

For those, watch the admin Health board manually weekly. When traffic
warrants it, add full e2e checks via Playwright in CI (run on schedule
against production with a service test account).

---

## Suggested check frequency

| Monitor | Interval | Why |
|---|---|---|
| Frontend (#1, #2) | 5 min | Customer-facing — fast detection |
| Privacy page (#3) | 60 min | Just verifies SPA fallback; doesn't change often |
| Supabase REST (#4) | 5 min | Core dependency for everything |
| Edge functions (#5, #6) | 15 min | Slower change cadence, lower false-positive tolerance |

Total per month: ~12,000 check requests, well under UptimeRobot's
free tier limit (~108,000/mo for 50 monitors at 5min).

---

## Done? Verify by doing this

1. Set up UptimeRobot account.
2. Add monitors 1-3 first (the frontend ones — no API key needed).
3. Add a single email alert contact.
4. Wait 10 minutes. You should see "Up" status on all three with a
   green bar in the dashboard.
5. Add monitors 4-6 with the Supabase API key header.
6. (Optional) Force-fail test: stop a Supabase function via the
   dashboard, wait 10 min — you should get an email.
7. Bookmark the dashboard URL — that's your single-pane-of-glass.

Total setup time: ~15 minutes.
