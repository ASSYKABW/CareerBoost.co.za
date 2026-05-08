# CareerBoost Backend (Supabase)

Full-stack backend for the Job Seeker Dashboard V2:

- **Postgres** database with Row-Level Security on every table
- **Auth** (email + password, Google OAuth, LinkedIn OAuth)
- **Edge Functions**: `ai-run` (LLM proxy) and `jobs-search` (job-board fan-out)
- **Storage** (ready for future resume uploads / avatars)

Hosted in **Supabase → Frankfurt (`eu-central-1`)** — the lowest-latency region
from South Africa.

---

## 1. Prerequisites

- Node 18+
- Supabase CLI (`npm i -g supabase` or use the `devDependency` in `package.json`)
- A free Supabase account — https://supabase.com

---

## 2. Create the cloud project

1. Go to https://supabase.com/dashboard and click **New project**.
2. Organization: pick (or create) one.
3. Name: `careerboost` (or anything you like).
4. Database password: generate a strong one and save it.
5. **Region: `Europe (Frankfurt) — eu-central-1`**.
6. Plan: **Free** is fine to start (up to 50 000 monthly active users, 500 MB
   storage, 2 GB egress). Upgrade to Pro (~$25/mo) when you need PITR backups,
   daily backups past 7 days, or the removal of the 1-week idle-pause.
7. After the project spins up, copy these values from **Project Settings →
   API**:
   - `Project URL` (e.g. `https://xxxx.supabase.co`)
   - `anon public` key
   - `service_role` key (⚠ keep secret — NEVER ship to browser)

---

## 3. Link the local CLI to the cloud project

```powershell
cd backend
npm install
# One-time:
npx supabase login
npx supabase link --project-ref <YOUR_PROJECT_REF>
```

> `<YOUR_PROJECT_REF>` is the random string in your Supabase URL, e.g.
> `https://xxxx.supabase.co` → `xxxx`.

---

## 4. Push the schema

```powershell
npx supabase db push
```

This applies `supabase/migrations/0001_init.sql`:

- Creates tables: `profiles`, `applications`, `events`, `resumes`,
  `cover_letters`, `interview_sets`, `saved_jobs`, `saved_searches`,
  `api_keys`, `ai_usage`
- Enables Row-Level Security on all of them with owner-only policies
- Creates a trigger so that on signup a profile + empty resume + api_keys row
  are auto-created

Verify in Supabase Studio → Table Editor.

---

## 5. Configure secrets (LLM + job board fallbacks)

```powershell
# 1) copy the template
cp .env.example .env      # on PowerShell: copy .env.example .env
# 2) fill in at least one LLM API key (see .env.example)
# 3) push secrets up to Supabase:
npx supabase secrets set --env-file ./.env
```

**AI routing (`ai-run`):** With multiple keys set, requests try **Gemini → OpenAI
→ Groq → Anthropic** until one succeeds. Set `GEMINI_API_KEY` from
[Google AI Studio](https://aistudio.google.com/apikey). Optional `GEMINI_MODEL`
defaults to `gemini-2.0-flash`.

Set `LLM_PROVIDER` only when you want to **force a single provider** with no
fallback (for example `LLM_PROVIDER=openai`). Remove that secret to restore the
multi-provider chain.

> Per-skill front of chain: `AI_ROUTING_RESUME_CRITIQUE=openai` (then remaining
> providers in priority order).

---

## 6. Deploy the Edge Functions

```powershell
npm run fn:deploy
```

This deploys:

- `POST /functions/v1/ai-run`
- `POST /functions/v1/jobs-search`
- `POST /functions/v1/job-import` (Tier C capture → `saved_jobs`; validates user JWT in-function — see `config.toml`)

All three use `verify_jwt = false` at the platform layer because the functions validate the caller JWT via `getAuthedUser()` (required for newer asymmetric JWT signing keys).

**Job search policy:** `jobs-search` is **Tier A** (server-side aggregation of allowed public APIs only). Product-wide tiers and client behaviour are documented in [`docs/JOB_SEARCH_ARCHITECTURE.md`](../docs/JOB_SEARCH_ARCHITECTURE.md) at the repo root.

---

## 7. Configure OAuth providers

In Supabase Studio → **Authentication → Providers**:

### Google

1. Enable **Google**.
2. In a new tab, go to
   https://console.cloud.google.com/apis/credentials → *Create OAuth client ID*
   → *Web application*.
3. Authorized redirect URI: copy the one Supabase shows you (looks like
   `https://xxxx.supabase.co/auth/v1/callback`). Paste it in Google.
4. Paste `Client ID` + `Client secret` back into Supabase. Save.

### LinkedIn (OIDC)

1. Enable **LinkedIn (OIDC)**.
2. Go to https://www.linkedin.com/developers/ → create an app.
3. Under **Auth**, add the Supabase callback URL as an authorized redirect.
4. Request products: **Sign In with LinkedIn using OpenID Connect**.
5. Paste `Client ID` + `Client secret` into Supabase. Save.

### Email + password

Enabled by default. For now confirmation emails are disabled (`enable_confirmations = false`
in `config.toml`) so sign-up is instant during development. Turn it on
(Dashboard → Authentication → Providers → Email) before going to production.

---

## 8. Point the client at your project

Open `v2/src/js/config.js` and set:

```js
window.CB_CONFIG = {
  supabaseUrl:  "https://xxxx.supabase.co",
  supabaseAnon: "ey...your-anon-key...",
  functionsUrl: "https://xxxx.functions.supabase.co", // optional, auto-derived
};
```

Reload `v2/index.html`. You'll be redirected to `#/auth` on first load. After
sign-in, the dashboard loads from Postgres instead of `localStorage`.

---

## 9. Local development (optional)

```powershell
# Start Postgres + GoTrue + Studio + Inbucket locally
npx supabase start

# Serve Edge Functions with live reload (uses .env)
npm run fn:serve
```

Local URLs:

- API: http://localhost:54321
- Studio: http://localhost:54323
- Inbucket (local email inbox): http://localhost:54324

---

## 10. Cost path (indicative)

| Users    | Supabase | LLM (GPT-4o-mini, heavy use) | Total/mo  |
| -------- | -------- | ---------------------------- | --------- |
| 0 – 500  | Free     | ~$5                          | **~$5**   |
| 500 – 5k | Pro $25  | ~$40                         | **~$65**  |
| 5k – 25k | Pro $25 + compute $10 | ~$200              | **~$235** |
| 25k+     | Team $599 (SLA) or self-host | ~$800+       | $1.4k+    |

Switching to Groq or Anthropic Haiku can cut LLM cost ~80%.

---

## 11. Mobile app later

Two supported paths — the client is already written as a vanilla SPA so both
work without a rewrite:

- **PWA** (install from Safari / Chrome) — zero extra code.
- **Capacitor** wrap → iOS + Android with native auth pickers (uses the same
  Supabase endpoints).
