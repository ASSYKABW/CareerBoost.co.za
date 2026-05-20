-- Log known operational issues to admin_incidents so the operator can
-- see them on the Health board + Command Center alongside live incidents.
--
-- These are NOT crash/error events — they're known gaps in our
-- infrastructure that need an operational decision (rotate key, build
-- feature, upgrade plan, etc.). Logging them centrally means:
--   1. They surface in the admin UI alongside real incidents.
--   2. They get a real `id` + audit trail when resolved.
--   3. The operator can snooze them without forgetting they exist.
--   4. The audit log captures who marked them resolved + when.
--
-- All inserts use `on conflict (dedup_key) do nothing` so re-running
-- this migration (in a worktree, after restore, etc.) won't duplicate.
-- To "re-open" any of them later, delete the row in the dashboard or
-- bump `last_seen_at` via the existing incident-update RPC.

-- =============================================================================
-- 1. RapidAPI jsearch quota exhausted (free BASIC plan)
-- =============================================================================
insert into public.admin_incidents (
  dedup_key, kind, severity, status,
  title, body, section,
  payload
)
values (
  'ops:rapidapi-quota-exhausted',
  'integration-quota',
  'warning',
  'open',
  'RapidAPI jsearch monthly quota exhausted',
  'Confirmed via direct API probe: ' ||
  '"You have exceeded the MONTHLY quota for Requests on your current plan, BASIC". ' ||
  'JSearch free tier = 150 requests/month. ' ||
  'Impact: LinkedIn-via-RapidAPI lane returns 0 results in job search. ' ||
  'LinkedIn-via-Google-CSE still works as fallback. ' ||
  'Options: (1) sign up new RapidAPI account on a different email to get a fresh 150/mo, ' ||
  '(2) upgrade jsearch to paid (~$10/mo for 10k requests), ' ||
  '(3) remove the RapidAPI provider entirely since Google CSE covers LinkedIn.',
  'operations',
  jsonb_build_object(
    'integration', 'rapidapi-jsearch',
    'detectedAt', now()::text,
    'recommendedAction', 'rotate-or-remove',
    'docsUrl', 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch'
  )
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- 2. Adzuna rate-limit (mitigated but ongoing risk)
-- =============================================================================
insert into public.admin_incidents (
  dedup_key, kind, severity, status,
  title, body, section,
  payload
)
values (
  'ops:adzuna-rate-limit-risk',
  'integration-quota',
  'info',
  'open',
  'Adzuna free tier (25 calls/min) — fan-out reduced but still at risk',
  'Adzuna free tier limit is 25 requests per minute, shared across all ' ||
  'app_id+app_key pairs. Phase 1.7 reduced default fan-out from 10 to 3 ' ||
  'countries per search, which keeps us under the limit for typical solo ' ||
  'usage. ' || E'\n\n' ||
  'Risk: with 10+ concurrent users searching, we will exhaust the bucket ' ||
  'and Adzuna calls will 429 until the minute rolls over. The function ' ||
  'returns whatever non-Adzuna providers found, so this degrades gracefully. ' || E'\n\n' ||
  'Options: (1) upgrade Adzuna to paid tier ($-varies-/mo for higher limits), ' ||
  '(2) build admin API key panel so user keys can be plugged in (the ' ||
  'Phase 2 operator-request), (3) cache aggregator results longer (15min ' ||
  'TTL today).',
  'operations',
  jsonb_build_object(
    'integration', 'adzuna',
    'detectedAt', now()::text,
    'mitigation', 'Fan-out reduced 10 -> 3 countries (commit 8c94c72)',
    'recommendedAction', 'monitor-then-upgrade-when-traffic-grows'
  )
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- 3. Indeed via Google CSE returns hub URLs, not individual jobs
-- =============================================================================
insert into public.admin_incidents (
  dedup_key, kind, severity, status,
  title, body, section,
  payload
)
values (
  'ops:indeed-cse-coverage-thin',
  'integration-coverage',
  'info',
  'open',
  'Indeed via Google CSE returns 0 useful results',
  'Google Custom Search returns ~61,000 indeed.com hits for a typical SE ' ||
  'query, but they are all "jobs hub" pages (e.g. ' ||
  'https://za.indeed.com/q-software-engineer-l-cape-town-jobs.html), not ' ||
  'individual job postings (viewjob?jk=...). The external-search edge ' ||
  'function correctly filters to only individual postings, so the ' ||
  'effective Indeed coverage is ~0. ' || E'\n\n' ||
  'Indeed deliberately makes individual jobs hard to discover via crawlers ' ||
  '(their business model relies on direct traffic). Not fixable from our ' ||
  'side without paying for Indeed Publisher API access. ' || E'\n\n' ||
  'Workaround: Phase 2 (Greenhouse + Lever) gives direct-from-company ' ||
  'access that exceeds typical Indeed coverage for tech roles.',
  'operations',
  jsonb_build_object(
    'integration', 'indeed-google-cse',
    'detectedAt', now()::text,
    'recommendedAction', 'defer-to-phase-2-coverage',
    'docsUrl', 'https://ads.indeed.com/jobroll/xmlfeed'
  )
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- 4. Admin API key management feature requested (operator UX gap)
-- =============================================================================
insert into public.admin_incidents (
  dedup_key, kind, severity, status,
  title, body, section,
  payload
)
values (
  'ops:admin-api-key-panel-needed',
  'feature-request',
  'info',
  'open',
  'Admin needs UI to manage external API keys (Adzuna, RapidAPI, Google CSE, etc.)',
  'Today, rotating an API key requires editing backend/.env locally then ' ||
  'running `npm run secrets:push`. Operator wants a dashboard UI to: ' || E'\n\n' ||
  '  - Update Adzuna app_id / app_key ' || E'\n' ||
  '  - Update RapidAPI key ' || E'\n' ||
  '  - Update Google CSE key + cx ' || E'\n' ||
  '  - Update LLM provider keys (OpenAI, Anthropic, Gemini, Groq) ' || E'\n' ||
  '  - Toggle which providers are active ' || E'\n' ||
  '  - See last-rotated timestamp + audit log ' || E'\n\n' ||
  'Stored in a new `admin_config` table with audit on every change. ' ||
  'Edge functions read from this table at request time (with a brief cache) ' ||
  'instead of env vars exclusively, so changes propagate without redeploy.',
  'operations',
  jsonb_build_object(
    'requestedBy', 'operator',
    'detectedAt', now()::text,
    'recommendedAction', 'schedule-as-next-feature',
    'estimatedEffort', '3-4 hours'
  )
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- 5. ai-run / jobs-rerank edge functions returning 502 intermittently
-- =============================================================================
insert into public.admin_incidents (
  dedup_key, kind, severity, status,
  title, body, section,
  payload
)
values (
  'ops:ai-run-jobs-rerank-502',
  'function-failure',
  'warning',
  'open',
  'ai-run and jobs-rerank functions returning 502 (likely upstream AI quota)',
  'Console logs show 5+ 502 errors per page load from /functions/v1/ai-run ' ||
  'and /functions/v1/jobs-rerank. Pattern matches "upstream provider failed" ' ||
  'rather than our auth.uid() bug (already fixed in get-entitlements). ' || E'\n\n' ||
  'Most likely cause: one of the AI provider keys (OpenAI, Anthropic, ' ||
  'Gemini, Groq) is rate-limited or has insufficient credit. The function ' ||
  'tries them in fallback order and returns 502 only when ALL fail. ' || E'\n\n' ||
  'Impact: AI scoring on job results shows "AI 0" badge instead of actual ' ||
  'match scores. Strengthen-bullet and other AI skills may also fail. ' || E'\n\n' ||
  'Next step: open the function logs in Supabase dashboard ' ||
  '(Edge Functions -> ai-run -> Logs) and check the actual error messages ' ||
  'to identify which provider key needs attention.',
  'health',
  jsonb_build_object(
    'functions', jsonb_build_array('ai-run', 'jobs-rerank'),
    'detectedAt', now()::text,
    'recommendedAction', 'check-function-logs-rotate-provider-key',
    'dashboardUrl', 'https://supabase.com/dashboard/project/kddffkhwpbngiupfmcse/functions'
  )
) on conflict (dedup_key) do nothing;

comment on table public.admin_incidents is 'Operational incidents + known issues surfaced in the admin UI. Seeded with Phase-1 ops gaps in migration 0020.';
