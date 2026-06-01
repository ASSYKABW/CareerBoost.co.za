# CareerBoost — Marketing & Brand Engine Roadmap

> Status: **planning reference** (no code yet). This is the document we build against.
> Owner: Jonathan. Last updated: 2026-06-01.

## 1. Vision

A **closed-loop, self-improving marketing engine** built into the Admin console that
produces on-brand content on a regular cadence (≥3×/week), distributes it across
channels, tracks it all the way to signups → activation → placements, and feeds
those results back into what it generates next.

```
   ① GENERATE  →  ② APPROVE  →  ③ DISTRIBUTE  →  ④ TRACK  →  ⑤ LEARN ↺
   (AI + our       (1-click       (email, blog,    (UTM +     (which content/
    own data)       admin queue)   social, push)    funnel)    channel drives
                                                                signups→placements)
```

It is **not** "a blog + a social scheduler." The engine is step ⑤ feeding step ①.

### The unfair advantage — first-party data moat
The engine writes from data only CareerBoost has, so the content is non-generic and
defensible:
- **Live SA job-market data** (ingested jobs) → trend reports, in-demand skills by city.
- **Aggregate, anonymized outcomes** → interviews/offers/placements as social proof.
- **Role/resume intelligence** → role-specific guides.
- **Attribution feedback** → we know which content actually converts.

## 2. What already exists (reuse, don't rebuild)

| Capability | Existing asset | Reuse for |
|---|---|---|
| AI generation | `ai-run` Edge Function + `ai.orchestrator` + `prompts.ts` (provider routing, retries, prompt versions) | Content drafting |
| Email delivery | `admin-send-email` + `admin-resend-webhook` (Resend) | Newsletters, drips |
| Attribution | `signup-attribution` (utm_*, referrer_host, landing_path, country_code, signup_at on `profiles`) | Link/campaign tracking |
| Growth analytics | `admin-overview` growth block (channels, geo, landing, referrers, topChannels, leakingChannels, attributionCoverage) + AARRR | Content/campaign ROI |
| Scheduling | `pg_cron` (already used for materialized-view refresh, AI-failure detection) | The 3×/week cadence + drip sends |
| Branding | `components/brand-kit.js` (logo/wordmark/tagline — currently hardcoded) | Make data-driven |
| Testimonials | `admin-testimonials` (moderation) | Move into the Marketing group |
| Admin framework | `callAdminEndpoint`, section pattern, nonce/CSRF, MFA gate | New sections |
| Push | PWA service worker + Web Share Target | Announcement push |

**Green field (must build):** the marketing DB tables, the content/brand/cron functions,
the public content delivery + blog pages, and the admin sections.

## 3. Target architecture

### 3.1 Data model (new tables)
- **`brand_settings`** — singleton-style row(s): logo variants, color palette, fonts,
  tagline, and a **`voice_tone` JSON** (tone, allowed/banned phrases, reading level).
  Public-read (cached) for the site; admin-write. Drives both the site and AI generation.
- **`content_pieces`** — `id, type (blog|social_linkedin|social_x|social_ig|newsletter|
  announcement|push|landing_variant), title, slug, body, excerpt, status (draft|
  needs_review|approved|scheduled|published|archived), channel, scheduled_at,
  published_at, og_image_url, source_data (JSON injected), prompt_version,
  created_by (ai|operator), reviewed_by, seo (meta), parent_id (repurpose lineage),
  metrics (denormalized rollup), timestamps`. RLS: service-role write; published rows
  public-read via a view.
- **`campaigns`** — `id, name, type (broadcast|drip), audience_segment, status,
  steps (drip: [{delayHours, content_id}]), schedule, metrics, timestamps`.
- **`marketing_experiments`** — `id, name, type (landing_copy|email_subject), variants
  (JSON), allocation, status, winner, per-variant metrics`.
- **`content_events`** — `id, content_id, event (view|click|share), anon/session id,
  utm, referrer, at`. Feeds attribution (mirrors the `client-telemetry` ingestion pattern).
- **`newsletter_subscribers`** (optional, if audience extends beyond signed-up users) —
  `email, status, source, subscribed_at, unsub_token`. POPIA-compliant consent + unsub.

### 3.2 Edge Functions (new)
- **`admin-content`** — admin-auth + nonce. CRUD on content/campaigns/experiments;
  actions: `generate` (→ `ai-run` content skills + brand voice + injected data),
  `approve`, `schedule`, `publish`, `archive`, `regenerate`, `repurpose`.
- **`admin-brand`** — read/write `brand_settings`.
- **`marketing-cron`** — service-role, `pg_cron`-triggered. Tasks: draft the week's
  pieces (3×/week), publish scheduled pieces, send scheduled drips/newsletter, roll up
  metrics, run the "learn" step (rank topics by attributed signups/placements).
- **`content-public`** — **public** (CORS-open, no auth): serves published blog posts /
  announcements + sitemap data + cached `brand_settings` for the site.
- **`content-track`** — **public**: logs `content_events` (views/clicks/shares) → attribution.

> All new functions use the **`withCors` wrapper** + a `verify_jwt` entry in `config.toml`
> (consistent with the existing 39). Public ones still validate input + rate-limit.

### 3.3 New AI skills (added to `ai-run` / `prompts.ts`)
`content-blog`, `content-social`, `content-newsletter`, `content-announcement`,
`content-repurpose`, `content-seo-meta`. Every skill is fed the **brand voice profile**
+ **injected first-party data** so output is on-brand and specific.

### 3.4 Public site (v2) changes
- New `/blog` + `/blog/:slug` routes reading `content-public`.
- Make `components/brand-kit.js` read `brand_settings` (cached) instead of hardcoding.
- Auto **UTM-tagged** links on all distributed content.
- **Sitemap** generation including blog; OG image rendering per piece.

### 3.5 Scheduling (`pg_cron`)
- Mon/Wed/Fri 06:00 SAST → `marketing-cron(draft)` (the ≥3×/week cadence).
- Daily → `marketing-cron(publish + drips + metric rollup)`.
- Weekly → "SA Job Market Pulse" newsletter assembly + send.

### 3.6 Admin "Marketing & Brand" nav group (5th group)
`Content Studio` · `Campaigns` · `Brand Kit` · `Growth & Attribution` ·
`SEO & Social` · `Testimonials` (moved here) · `Experiments`.

## 4. Phases

Each phase is independently shippable through `feature/* → develop → main`.

### Phase 0 — Foundations: brand + content data layer
- **Build:** `brand_settings` + `content_pieces` tables (+ migration, RLS, public view);
  `admin-brand` + `admin-content` (CRUD only, no AI yet); **Brand Kit** admin section;
  make the public site's `brand-kit.js` data-driven (cached read).
- **Reuse:** admin framework, CORS wrapper.
- **Done when:** an operator can edit the brand and manually create/save a content piece;
  the live site reflects brand edits.
- **Effort:** Medium. **Risk:** Low. **Dependencies:** none.

### Phase 1 — Content Studio: AI generation + review queue
- **Build:** content AI skills in `ai-run` (+ brand-voice + data injection);
  `admin-content.generate/regenerate`; **Content Studio** section (7-day calendar, the
  review queue, inline editor, generate/approve/edit/schedule); OG-image template.
- **Reuse:** `ai-run`, orchestrator, prompt versioning.
- **Done when:** operator clicks "Generate" → reviews/edits → approves a piece (human-in-loop).
- **Effort:** Medium-High. **Risk:** Medium (brand voice quality). **Depends on:** Phase 0.

### Phase 2 — Cadence + Newsletter (the "3×/week" engine goes live)
- **Build:** `marketing-cron` + `pg_cron` triggers (auto-draft 3×/week into the queue);
  weekly **"SA Job Market Pulse"** newsletter via Resend; `content-track` for opens/clicks.
- **Reuse:** `pg_cron`, `admin-send-email`/Resend, `signup-attribution`.
- **Done when:** drafts auto-appear ≥3×/week; the newsletter ships weekly.
- **Effort:** Medium. **Risk:** Medium (cost/quality at cadence). **Depends on:** Phase 1.

### Phase 3 — Publish & Distribute: blog/SEO + push + in-app
- **Build:** `content-public` + public `/blog` pages + sitemap + OG; PWA push
  announcements; in-app announcement banner.
- **Reuse:** service worker/push, sitemap.
- **Done when:** approved blog posts are live + indexable; push + in-app work.
- **Effort:** Medium-High. **Risk:** Medium (SEO is a slow burn). **Depends on:** Phase 1.

### Phase 4 — Close the attribution loop (growth tracking + ROI)
- **Build:** `content_events` → extend the growth board with per-content/campaign funnel
  (views→clicks→signups→activation→**placements**); content scorecard; the engine "learn"
  step (bias next drafts toward winning topics/channels).
- **Reuse:** growth board, AARRR, attribution.
- **Done when:** each piece shows attributed signups/placements; cron prioritizes winners.
- **Effort:** Medium. **Risk:** Low-Medium. **Depends on:** Phases 2 + 3.

### Phase 5 — Growth automation (the "does everything" tier)
- **Build:** drip campaigns by **existing user segments** (power/new/at-risk/churned);
  referral loop (codes + attribution); A/B testing (landing headline + email subject,
  auto winner); **programmatic SEO** ("{role} jobs in {SA city}", "Resume tips for {role}"
  from job+role data); social autopilot (Phase 5a: generate→Buffer/Zapier; Phase 5b:
  native LinkedIn/X/Meta OAuth posting).
- **Done when:** lifecycle + referral + A/B + programmatic SEO + social are live.
- **Effort:** High (esp. social OAuth + programmatic SEO volume). **Risk:** Medium-High.
- **Depends on:** Phase 4.

## 5. Cross-cutting concerns
- **Human-in-the-loop first.** AI drafts; operators approve. Auto-publish only after the
  voice is trusted. Outcome claims use **anonymized aggregates only** (factual guardrail).
- **POPIA (SA privacy law).** Consent + unsubscribe for any non-user email list; no PII in
  generated content; honor data-subject rights.
- **Brand safety.** Banned-phrase list in `voice_tone`; review gate; no fabricated stats.
- **Cost control.** 3×/week drafting is cheap; programmatic SEO at scale needs a budget cap
  + the existing AI cost/quota tracking.
- **Social APIs are the hard part.** LinkedIn/X/Meta need OAuth apps + platform review →
  start with generate-and-schedule (Buffer/Zapier), go native later.
- **SEO is a slow burn.** Weeks to compound; highest long-term leverage for a job product.

## 6. Suggested sequence & rough effort
0 → 1 → 2 (this trio delivers the core "regular on-brand content" promise) →
3 (acquisition surface) → 4 (the learning loop) → 5 (automation breadth).

Phases 0–2 are the MVP of a "strong engine." Phases 3–5 make it "very strong."

## 7. Success metrics
- **Cadence adherence:** ≥3 approved pieces/week.
- **Organic acquisition:** % of signups from owned content/SEO (via attribution).
- **Full-funnel ROI:** content-attributed signups → activation → placements.
- **Newsletter:** open & click rates; list growth.
- **SEO:** indexed pages + organic sessions trend.
- **Channel ROI:** cost/signup and cost/placement per channel.

## 8. Open decisions (need Jonathan's input before/while building)
1. Newsletter audience: signed-up users only, or a separate subscriber list (POPIA + double opt-in)?
2. Auto-publish threshold: stay human-in-loop indefinitely, or auto-publish certain types once trusted?
3. Social: Buffer/Zapier first, or invest in native OAuth posting early?
4. Programmatic SEO scope: how many auto-pages, and quality bar to avoid thin content?
5. Brand voice: who signs off on the `voice_tone` profile the engine writes from?
