-- Operator backlog: every deferred feature, validation gap, tech debt,
-- and known issue captured as admin_incidents so they show up in the
-- Health board / Command Center. This is the operator's "do not
-- forget" list — items can be snoozed or resolved as they're handled.
--
-- Categorized by `kind`:
--   feature-deferred  — built or scoped but deliberately not yet shipped
--   validation-pending — code shipped but never validated end-to-end
--   tech-debt         — known refactor/cleanup work
--   ops-polish        — UX/operational improvements (mobile, empty states, etc.)
--   coverage-gap      — known data/source coverage limitations
--
-- Severity:
--   critical — blocks public launch
--   warning  — should fix in first 2 weeks
--   info     — nice to have

-- =============================================================================
-- VALIDATION GAPS (docs/TESTING-P1.md — features never tested end-to-end)
-- =============================================================================

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'val:resume-lab-r3-chips',
  'validation-pending', 'warning', 'open',
  'Resume Lab R3 — inline anchor chips never validated against real data',
  'The R3 redesign added inline chip anchors on resume bullets that ' ||
  'open AI critique popovers. Code shipped weeks ago but never walked ' ||
  'through end-to-end with a real resume. Walk this test per ' ||
  'docs/TESTING-P1.md section 1.',
  'health',
  jsonb_build_object('testDoc', 'docs/TESTING-P1.md#1', 'recommendedAction', 'manual-test-with-real-resume')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'val:resume-lab-r4-preview',
  'validation-pending', 'warning', 'open',
  'Resume Lab R4 — track-changes preview never validated',
  'R4 added a diff-style preview before committing AI rewrites. Most ' ||
  'likely failure modes: diff alignment drift across multiple overlapping ' ||
  'changes, mobile horizontal-scroll. Walk test per docs/TESTING-P1.md ' ||
  'section 2.',
  'health',
  jsonb_build_object('testDoc', 'docs/TESTING-P1.md#2')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'val:resume-lab-r5-queue',
  'validation-pending', 'warning', 'open',
  'Resume Lab R5 — AI Review Queue + walkthrough never validated',
  'R5 added a unified queue for all critiques + a first-time walkthrough. ' ||
  'Most likely failure modes: walkthrough fires on every visit (localStorage ' ||
  'flag), queue badge desyncs after Accept, snooze TTL not honored. Walk ' ||
  'test per docs/TESTING-P1.md section 3.',
  'health',
  jsonb_build_object('testDoc', 'docs/TESTING-P1.md#3')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'val:strengthen-bullet',
  'validation-pending', 'warning', 'open',
  'Strengthen-bullet AI skill — was reported "fake", fix shipped but never re-validated',
  'Operator originally reported strengthen-bullet was using a string ' ||
  'template instead of a real AI call. Replaced with bullet-strengthen ' ||
  'skill using Sonnet, but never re-tested. Walk test per ' ||
  'docs/TESTING-P1.md section 4 — confirm each Strengthen returns a ' ||
  'context-aware rewrite, not a wrapper around the original.',
  'health',
  jsonb_build_object('testDoc', 'docs/TESTING-P1.md#4')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'val:chat-assist',
  'validation-pending', 'warning', 'open',
  'Chat Assist floating panel — built but never validated end-to-end',
  'The bottom-right help drawer using chat-assist AI skill was shipped ' ||
  'in V1 but never tested against real questions. Most likely failure: ' ||
  'system prompt not applied → generic AI responses instead of ' ||
  'CareerBoost-aware ones. Walk test per docs/TESTING-P1.md section 6.',
  'health',
  jsonb_build_object('testDoc', 'docs/TESTING-P1.md#6')
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- FEATURE DEFERRED — built but hidden, or scoped but not built
-- =============================================================================

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'feat:apply-assist-dormant',
  'feature-deferred', 'info', 'open',
  'Apply Assist V1 — fully built but hidden behind feature flag',
  'Apply Assist Phase 1-2c shipped (Chrome extension auto-fills ' ||
  'Greenhouse forms; user always submits) but hidden because Greenhouse-' ||
  'only is too narrow. To enable: flip CB_CONFIG.featureFlags.applyAssist ' ||
  'to true. Re-enable criteria: add Lever support OR accept Greenhouse-' ||
  'only with clear copy.',
  'operations',
  jsonb_build_object('flag', 'CB_CONFIG.featureFlags.applyAssist', 'currentValue', false)
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'feat:welcome-tour',
  'feature-deferred', 'info', 'open',
  'No welcome tour for first-time signed-in users',
  'New users land on the dashboard with 9 top-level nav items and no ' ||
  'guidance on where to start. Add a 3-5 step tour highlighting ' ||
  'Job Search → Resume Lab → Pipeline → Interview Prep. Improves ' ||
  'activation rate. Estimated effort: 2-3 hours.',
  'health',
  jsonb_build_object('estimatedEffort', '2-3 hours', 'recommendedAction', 'add-after-launch')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'feat:quota-meter',
  'feature-deferred', 'warning', 'open',
  'User-side quota meter missing (users hit limits unexpectedly)',
  'No always-visible "AI resumes 2/5 used" indicator. Users hit quota ' ||
  'mid-flow and see a generic "quota exhausted" error. Add a small ' ||
  'meter in the profile menu showing X/Y for each quota type. Pulls ' ||
  'from get-entitlements (now fixed). Estimated effort: 45 min.',
  'health',
  jsonb_build_object('estimatedEffort', '45 minutes')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'feat:signout-confirm',
  'feature-deferred', 'info', 'open',
  'No sign-out / account-delete confirmation modals',
  'One-tap mistakes on mobile cost a re-login or worse. Add explicit ' ||
  'confirm modals to: (1) Sign out button, (2) Delete account flow ' ||
  '(typed-confirm + 7-day soft-delete grace period). Estimated effort: ' ||
  '1.5 hours total.',
  'health',
  jsonb_build_object('estimatedEffort', '1.5 hours')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'feat:transactional-email-bulk',
  'feature-deferred', 'info', 'open',
  'Admin bulk email uses mailto: (works for solo, breaks at scale)',
  'When operator sends a "support reply" or bulk email from admin, it ' ||
  'opens mailto: which depends on operator''s mail client. Works for 1 ' ||
  'admin but not for true transactional sends. Resend SMTP is now wired ' ||
  'for AUTH emails — extend to a generic /admin-send-email function ' ||
  'with delivery + bounce tracking. Estimated effort: 3 hours.',
  'operations',
  jsonb_build_object('estimatedEffort', '3 hours')
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- OPS POLISH (from docs/AUDITS-P1.md — known mobile + empty state gaps)
-- =============================================================================

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'polish:mobile-audit-pending',
  'ops-polish', 'warning', 'open',
  '6 mobile responsiveness fixes pending (docs/AUDITS-P1.md)',
  '375px breakpoints missing on key surfaces. Top items: interview-' ||
  'target-bar overflows; .job-search-job-card__chips max-width too ' ||
  'aggressive; admin-user-drawer-grid stacks at wrong breakpoint; ' ||
  'job-search-layout sidebar not collapsing at 768px; resume popover ' ||
  'positioning unverified at 375px. See docs/AUDITS-P1.md for full ' ||
  'punch list. Estimated effort: 2 hours focused session.',
  'health',
  jsonb_build_object('docRef', 'docs/AUDITS-P1.md', 'estimatedEffort', '2 hours')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'polish:empty-states-pending',
  'ops-polish', 'info', 'open',
  '7 empty-state coverage gaps (secondary lists show blank instead of CTA)',
  'Saved jobs list, review queue, applications kanban error path, ' ||
  'interview briefing loader, cover-letter suggestions, dashboard ' ||
  'digest skeleton, tailor plan nested bullets — all render empty ' ||
  'space instead of a useful CTA when their data is empty. See ' ||
  'docs/AUDITS-P1.md follow-ups. Estimated effort: 1.5 hours mechanical.',
  'health',
  jsonb_build_object('docRef', 'docs/AUDITS-P1.md', 'estimatedEffort', '1.5 hours')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'polish:status-page',
  'ops-polish', 'info', 'open',
  'No public status page (footer link was removed)',
  'When something goes down, users have no public-facing way to see ' ||
  'whether it''s a known issue. Set up a free Better Stack status page ' ||
  'at status.careerboost.co.za. Link from welcome footer. UptimeRobot ' ||
  'monitors already feed the right signals. Estimated effort: 30 min.',
  'operations',
  jsonb_build_object('estimatedEffort', '30 minutes', 'recommendedProvider', 'Better Stack')
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- TECH DEBT
-- =============================================================================

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'debt:settings-route-3387-lines',
  'tech-debt', 'info', 'open',
  'settings.route.js is 3387 lines — split started but incomplete',
  'Originally a 1200-line file (per audit), grew to 3387. settings.meta.js ' ||
  'and settings.billing.js and settings.intel.js have been extracted but ' ||
  '6 more sections still inline. Full plan in docs/SETTINGS-SPLIT-PLAN.md ' ||
  '— follow the 3-tier extraction recipe. Estimated effort: 6-8 hours ' ||
  'across multiple commits.',
  'operations',
  jsonb_build_object('docRef', 'docs/SETTINGS-SPLIT-PLAN.md', 'estimatedEffort', '6-8 hours')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'debt:no-e2e-tests',
  'tech-debt', 'warning', 'open',
  'No E2E test in CI — regressions only caught manually',
  'Zero browser-driven tests run on Vercel deploys. Add one Playwright ' ||
  'happy-path test (signup → verify OTP → create resume → save job → ' ||
  'see in pipeline) so the most catastrophic regressions get caught ' ||
  'before users do. Recent infinite-recursion + entitlements 502 bugs ' ||
  'would have been caught by a 30-second test. Estimated effort: 3 hrs.',
  'operations',
  jsonb_build_object('estimatedEffort', '3 hours', 'tool', 'Playwright')
) on conflict (dedup_key) do nothing;

-- =============================================================================
-- COVERAGE GAPS (job search expansion — pick selectively, not all needed)
-- =============================================================================

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'cov:tracked-companies-thin',
  'coverage-gap', 'info', 'open',
  'tracked_companies registry has only 22 active — could be 200+',
  'Phase 2 seeded 33 companies, 17 deactivated after probe failed. ' ||
  'Adding 30-50 more verified Greenhouse/Lever tokens (companies admin ' ||
  'cares about hiring users into) is a 1-hour data entry task using ' ||
  'the new admin UI (Phase 2.5). Highest-ROI expansion of job coverage. ' ||
  'Tokens are at the end of each company''s boards URL ' ||
  '(boards.greenhouse.io/{TOKEN}).',
  'operations',
  jsonb_build_object('currentCount', 22, 'estimatedTarget', 200, 'estimatedEffort', '1 hour via admin UI')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'cov:workable-ats-missing',
  'coverage-gap', 'info', 'open',
  'Workable ATS not yet supported (30k+ companies globally)',
  'Workable is the dominant ATS for SMB/mid-market globally including ' ||
  'many in EU, MENA, Africa. Adding support to companies-search function ' ||
  'is ~2 hours: new fetchWorkable() in admin-tracked-companies and ' ||
  'companies-search functions, then operator adds tokens via admin UI. ' ||
  'Workable API: workable.com/api/v1/widget/accounts/{token}',
  'operations',
  jsonb_build_object('atsName', 'Workable', 'companiesUsing', '30000+', 'estimatedEffort', '2 hours')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'cov:jooble-api',
  'coverage-gap', 'info', 'open',
  'Jooble API integration would add 70+ country aggregator coverage',
  'Jooble (jooble.org) aggregates job listings from 70+ countries, ' ||
  'free tier ~500 calls/day. Complements Adzuna by covering Eastern ' ||
  'Europe, Latin America, and emerging markets where Adzuna is thin. ' ||
  'Server-side integration like Adzuna. Estimated effort: 2 hours.',
  'operations',
  jsonb_build_object('apiUrl', 'jooble.org/api', 'estimatedEffort', '2 hours')
) on conflict (dedup_key) do nothing;

insert into public.admin_incidents (dedup_key, kind, severity, status, title, body, section, payload)
values (
  'cov:ats-smartrecruiters-ashby',
  'coverage-gap', 'info', 'open',
  'SmartRecruiters + Ashby ATS support (smaller but valuable additions)',
  'SmartRecruiters has 4k+ enterprise customers (big in EU). Ashby is ' ||
  'newer and popular with AI startups (OpenAI competitors, etc.). Both ' ||
  'are similar to Greenhouse/Lever integration pattern. Combined effort: ' ||
  '~4 hours. Lower priority than Workable.',
  'operations',
  jsonb_build_object('estimatedEffort', '4 hours combined')
) on conflict (dedup_key) do nothing;

comment on table public.admin_incidents is 'Operational + product backlog visible in admin UI. Seeded with launch-readiness checklist in migration 0023.';
