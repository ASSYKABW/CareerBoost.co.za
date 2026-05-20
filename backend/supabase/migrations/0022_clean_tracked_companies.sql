-- Phase 2.1 follow-up: deactivate companies whose ATS tokens failed
-- the live probe (404 from Greenhouse / Lever). Keeping them in the
-- table (rather than deleting) preserves the audit trail and lets
-- the operator re-enable any that come back online via the admin UI
-- in Phase 2.5.
--
-- Verified via direct API probe May 2026 — list as of deploy.
-- Re-run probe periodically: tokens change when companies switch ATS.

-- Companies that failed the probe (404 from boards-api.greenhouse.io
-- or wrong/missing token):
update public.tracked_companies set
  active = false,
  notes = coalesce(notes, '') || E'\n[auto] Disabled May 2026: ATS endpoint returned 404. Tokens may have changed when the company migrated ATSes. Manually verify + update via admin UI.'
where ats_token in (
  -- SA companies — wrong Greenhouse slugs (these companies likely
  -- use Workable or custom careers pages, not Greenhouse).
  'yoco', 'lunolab', 'stitchpay', 'peachpayments', 'aerobotics',
  -- These migrated off Greenhouse or use a different token:
  'automattic', 'zapier', 'doist',
  'openai', 'notion', 'linear', 'hashicorp',
  'characterai', 'huggingface', 'perplexity', 'mercor'
);

-- Same for the Lever-tagged companies that didn't probe successfully:
update public.tracked_companies set
  active = false,
  notes = coalesce(notes, '') || E'\n[auto] Disabled May 2026: Lever endpoint returned 404. Update token via admin UI.'
where ats = 'lever' and ats_token in (
  'quora', 'mixpanel', 'netlify', 'eventbrite', 'khanacademy',
  'writer', 'replit', 'webflow', 'descript'
);

-- Add a few confirmed-working high-value companies the operator
-- definitely wants tracked.
insert into public.tracked_companies (slug, ats, ats_token, name, careers_url, regions, notes)
values
  ('netflix',     'lever',      'netflix',     'Netflix',     'https://jobs.netflix.com',             array['global','north_america']::text[], 'Verified May 2026.'),
  ('elastic',     'greenhouse', 'elastic',     'Elastic',     'https://www.elastic.co/about/careers', array['global']::text[], 'Search / observability. Remote-first. Verified May 2026.'),
  ('mongodb',     'greenhouse', 'mongodb',     'MongoDB',     'https://www.mongodb.com/careers',      array['global']::text[], 'Database. Verified May 2026.'),
  ('shopify',     'greenhouse', 'shopify',     'Shopify',     'https://www.shopify.com/careers',      array['global']::text[], 'E-commerce. Verified May 2026.'),
  ('twilio',      'greenhouse', 'twilio',      'Twilio',      'https://www.twilio.com/company/jobs',  array['global']::text[], 'Communications API. Verified May 2026.'),
  ('reddit',      'greenhouse', 'redditinc',   'Reddit',      'https://www.redditinc.com/careers',    array['global']::text[], 'Verified May 2026.')
on conflict (ats, ats_token) do nothing;
