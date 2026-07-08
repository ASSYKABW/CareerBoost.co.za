# Job Search architecture (Phase 1)

This document defines how CareerBoost integrates job listings in a **professional, legal, and consistent** way. Engineering and product changes should align with these tiers.

## Integration tiers

| Tier | Name | Behaviour | Examples |
|------|------|-----------|----------|
| **A - Ingest** | In-app listings | Data shown inside CareerBoost comes only from **documented** APIs, partner feeds, or your own backend aggregating allowed sources. API keys are optional credentials for those providers (e.g. Adzuna), stored as backend secrets or per-user keys - **never** passwords for third-party job sites. | `jobs-search` Edge Function (Remotive, Arbeitnow, Jobicy, optional Adzuna via `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`). Client-side providers for **guest / local-only** mode. |
| **B - Handoff** | Open on provider | User leaves CareerBoost to the provider's site (new tab). Their session and terms apply. | **Shipped:** Job Search -> Big Board Workflow buttons for LinkedIn and Indeed. URLs are built from the search form only - no automation or stored passwords. |
| **C - Capture** | User-initiated import | User explicitly brings a job in (paste URL, share, or browser extension). | **Shipped:** Job Search -> Import listing URL (paste `http(s)` listing link -> pipeline card with `jobUrl` / DB `source_url`; optional company & role; dedupe by URL). **MVP:** Chrome extension injects "Save to CareerBoost" on LinkedIn job pages and saves to Pipeline through `job-import`. |

We **do not** automate login to LinkedIn or other sites, and we **do not** store those passwords.

## Primary search path (client)

| Mode | Job listing source |
|------|-------------------|
| **Cloud primary** | Supabase Edge Function `jobs-search` only (`CareerBoost Cloud` provider). No parallel client calls to the same boards in the browser. Mock sample jobs are **not** used when this path is active (avoids masking real outages with fake listings). |
| **Guest / local** | Registered client providers (public APIs) + mock fallback when every live provider fails. |

Override for rare diagnostics: `CBJobs.search({ ..., forceClientProviders: true })` forces the guest-style provider set even when signed in.

## Backend

`jobs-search` must only implement **Tier A** sources allowed under each vendor's terms. See function header in `backend/supabase/functions/jobs-search/index.ts`.

Current backend sources:

- Remotive public remote jobs API
- Arbeitnow public job board API
- Jobicy public remote jobs API
- **The Muse** public API — keyless (optional `THE_MUSE_API_KEY` raises the rate limit)
- **RemoteOK** public JSON API — keyless (ToS requires linking back to the RemoteOK job URL, which we do)
- Adzuna API when `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` are configured
- **Jooble** aggregator when `JOOBLE_API_KEY` is configured (strong local/on-site coverage)
- **USAJobs** (US government) when `USAJOBS_API_KEY` + `USAJOBS_EMAIL` are configured
- **Reed** (UK) when `REED_API_KEY` is configured
- **Findwork.dev** (tech) when `FINDWORK_API_KEY` is configured

Key-gated sources return `[]` silently until their secret is set (`supabase secrets set <NAME>=...`), so adding a key activates the feed with no code change. The keyless feeds (The Muse, RemoteOK) are always on. Every source flows through the same `runSource` → `applyFilters` (quality gates + query/location narrowing) → dedupe → composite rank pipeline.

**API-key secrets (set via `supabase secrets set`):**

| Secret(s) | Feed | Get a key |
|---|---|---|
| `THE_MUSE_API_KEY` (optional) | The Muse | themuse.com/developers/api/v2 |
| `JOOBLE_API_KEY` | Jooble | jooble.org/api/about |
| `USAJOBS_API_KEY` + `USAJOBS_EMAIL` | USAJobs | developer.usajobs.gov |
| `REED_API_KEY` | Reed | reed.co.uk/developers |
| `FINDWORK_API_KEY` | Findwork | findwork.dev/developers |

**LinkedIn / Indeed / Glassdoor have no legal open job-search API** (LinkedIn is Talent-Solutions partner-only; Indeed retired its Publisher API ~2020; Glassdoor is partner-only). They stay **Tier B handoff** + **Tier C import**. For true LinkedIn/Indeed-style rows, a commercial Google-for-Jobs reseller (e.g. JSearch/SerpApi on RapidAPI) is the only pragmatic path — under *their* data license, not ours — and is not wired in by default.

Company-specific ATS boards (Greenhouse `boards.greenhouse.io/{company}`, Lever `api.lever.co/v0/postings/{company}`) are a documented, high-quality Tier-A option for pulling a target employer's jobs directly — a good fast-follow for company-targeted search.

## Phase 2 (shipped)

- **Relevance:** `filters.sort: "relevance"` ranks merged jobs by keyword overlap (title → tags → company → location → description), with a small recency tie-break. Same logic runs in `jobs-search` and in the client (`job.search.js`) for guest mode and for resorting when the user changes sort without re-fetching.
- **NLQ → backend:** When “AI parse my query” succeeds, structured `nlq` (keywords, optional location, etc.) is POSTed with `jobs-search` so APIs get a better `buildSearchQuery` string and Arbeitnow/Muse filters use token OR-matching. Jobicy `tag` uses the first NLQ keyword when present.
- **Load more:** The Job Search UI reveals results in pages (default 20) from the full in-memory list returned by search (no second HTTP round-trip until the user runs a new search).

## Phase 3 (shipped)

- **“Search the web”** on the Job Search page: grouped **Tier B** buttons (Global, Africa & South Africa, MENA) that `window.open` the vendor’s own job search with `noopener,noreferrer`.
- **Query source:** Uses the live `#job-query` field if the user typed there, otherwise the last saved filter query — so links stay in sync without another deploy when URL patterns shift (update `handoffUrlFor` in `job-search.route.js`).

## Phase 4 (shipped)

- **Responsive Job Search:** narrow viewports stack the search row (full-width field + actions), wrap job card actions, tighten page padding, and show filters inside a **`<details>`** disclosure (summary hidden from **768px** up so desktop stays unchanged).
- **Loading:** While searching, a live region announces **“Searching CareerBoost Cloud…”** vs **“Searching job feeds…”** plus skeleton cards.
- **Cache:** In-browser job search cache TTL reduced to **4 minutes**; **Refresh** (after a result set) calls `CBJobs.search` with **`bypassCache: true`** once for a forced refetch.
- **Sheets:** Job preview drawer becomes a **bottom sheet** on small screens (`92dvh`, top radius, safe-area padding). Apply Kit modal goes **full-viewport** under **640px**.
- **A11y:** Apply links and Tier B handoff controls expose **new-tab** intent (`aria-label` / `.visually-hidden`).

## Phase 5 (shipped)

- **Tier C — Add from URL:** Form on Job Search creates an application with stored listing URL (no server-side fetch of third-party HTML). Shared URL normalization / dedupe helpers live on `window.CBV2.jobListingUrlHelpers` (from `store.js`); cloud mode maps `jobUrl` ↔ `applications.source_url` in `store.remote.js`.
- **Pipeline drawer:** When `jobUrl` is set, the application drawer shows **Job posting** with an external link (`noopener`, `noreferrer`).
- **Saved searches:** Each saved row includes compact **Tier B** buttons (same `handoffUrlFor` ids as the main panel) using that row’s saved query. **Run** / digest paths call `markSavedSearchRun` with `lastNewCount` (delta vs previous top-20 ids) for UI copy; cloud DB does not persist `lastNewCount` yet (in-session only after hydration).

## Roadmap reference

Shipped (Tier C foundation): Edge Function `job-import` upserts user-captured listings into `public.saved_jobs` (see `docs/JOB_IMPORT_EXTENSION.md`).

Later: additional extension adapters for Indeed, Greenhouse, Lever, and company ATS pages; optional persistence of digest deltas for saved searches in cloud; deeper Tier A API pagination where vendors allow it.
