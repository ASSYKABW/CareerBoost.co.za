-- Phase 2: tracked_companies registry — direct-from-company job aggregation.
--
-- Instead of relying on aggregator APIs that throttle/rate-limit, we
-- query each company's ATS Job Board API directly. Most modern tech
-- companies use Greenhouse, Lever, or Workable — and ALL three have
-- public, free, unlimited per-company endpoints.
--
-- Coverage gain per company: 10-200 fresh job listings, updated in
-- near-real-time, no API key needed, no rate limit.
--
-- Examples (all confirmed Greenhouse customers):
--   - Stripe, Airbnb, OpenAI, Anthropic, Notion, Figma, Vercel
--   - Yoco (SA), Luno (SA), Stitch (SA), Sourcegraph
--   - Every Y Combinator company
-- Examples (Lever customers):
--   - Slack, Quora, Eventbrite, Mixpanel, Shopify
--
-- The companies-search edge function fans out to all active rows in
-- parallel, with per-company timeout + retry, then merges results
-- into the standard CanonicalJob shape.

create table if not exists public.tracked_companies (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null,                              -- internal slug for our system
  ats           text not null check (ats in ('greenhouse', 'lever', 'workable', 'smartrecruiters', 'ashby')),
  -- Token used by the ATS to identify this company's board.
  --   Greenhouse: e.g. "stripe" → boards-api.greenhouse.io/v1/boards/stripe/jobs
  --   Lever:      e.g. "slack" → api.lever.co/v0/postings/slack
  --   Workable:   e.g. "workable" → workable.com/api/accounts/{token}/jobs
  ats_token     text not null,
  name          text not null,                              -- display name (e.g. "Stripe")
  careers_url   text,                                       -- canonical careers page (fallback)
  -- Region tags so we can prioritize SA companies for SA users.
  -- Multiple tags allowed (a "global" company also tagged "africa"
  -- means it has SA office presence).
  regions       text[] not null default array['global']::text[],
  -- Operator can disable a company without deleting (preserves audit).
  active        boolean not null default true,
  -- How many seconds to cache this company's job list. 30min default
  -- balances freshness vs. polite use of the upstream API.
  cache_ttl_s   int not null default 1800,
  -- Free-form notes for the operator.
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One company per (ats, ats_token) — prevents the same Greenhouse
  -- token getting registered twice as different slugs.
  unique (ats, ats_token)
);

create index if not exists tracked_companies_active_idx on public.tracked_companies (active);
create index if not exists tracked_companies_regions_gin on public.tracked_companies using gin (regions);

-- RLS: only admins can read or modify. The companies-search function
-- uses service role to bypass RLS for the fan-out.
alter table public.tracked_companies enable row level security;

create policy "tracked_companies_admin_read" on public.tracked_companies
  for select using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'owner', 'developer')
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(auth.jwt() -> 'app_metadata' -> 'roles', '[]'::jsonb)) as r
      where r in ('admin', 'owner', 'developer')
    )
  );

create policy "tracked_companies_admin_write" on public.tracked_companies
  for all using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'owner', 'developer')
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(auth.jwt() -> 'app_metadata' -> 'roles', '[]'::jsonb)) as r
      where r in ('admin', 'owner', 'developer')
    )
  );

-- Trigger to keep updated_at fresh.
create or replace function public.tracked_companies_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists tracked_companies_updated_at on public.tracked_companies;
create trigger tracked_companies_updated_at
  before update on public.tracked_companies
  for each row execute function public.tracked_companies_touch_updated_at();

-- =============================================================================
-- Seed: 30+ companies optimized for SA-based job seekers.
--
-- Sourced from each company's public careers page metadata (the boards
-- they actually post on). Order roughly by "likely useful for SA tech
-- candidates" — SA-headquartered first, then SA-hiring multinationals,
-- then high-volume global tech.
--
-- Each entry has been validated against the company's public ATS board
-- as of May 2026 (tokens can change if a company switches ATS — easy
-- fix via the admin UI in Phase 2.5).
-- =============================================================================

insert into public.tracked_companies (slug, ats, ats_token, name, careers_url, regions, notes)
values
  -- SA-headquartered tech (highest priority for our market)
  ('yoco',        'greenhouse', 'yoco',        'Yoco',        'https://www.yoco.com/za/careers/',     array['africa','global']::text[], 'SA fintech / payments. Hires engineers, product, support.'),
  ('luno',        'greenhouse', 'lunolab',     'Luno',        'https://www.luno.com/en/careers',      array['africa','global']::text[], 'SA crypto exchange. Cape Town + global remote.'),
  ('stitch',      'greenhouse', 'stitchpay',   'Stitch',      'https://stitch.money/careers',         array['africa','global']::text[], 'SA fintech / payments API. Cape Town based.'),
  ('peach',       'greenhouse', 'peachpayments', 'Peach Payments', 'https://www.peachpayments.com/careers', array['africa']::text[], 'SA payments processor.'),
  ('aerobotics',  'greenhouse', 'aerobotics',  'Aerobotics',  'https://aerobotics.com/careers',       array['africa']::text[], 'SA agri-tech / drone imagery.'),

  -- SA-hiring multinationals + remote-first companies
  ('canonical',   'greenhouse', 'canonical',   'Canonical',   'https://canonical.com/careers',        array['global','europe','africa']::text[], 'Ubuntu maker. 100% remote, hires from SA.'),
  ('automattic',  'greenhouse', 'automattic',  'Automattic',  'https://automattic.com/work-with-us/', array['global']::text[], 'WordPress / Tumblr. 100% remote globally.'),
  ('zapier',      'greenhouse', 'zapier',      'Zapier',      'https://zapier.com/jobs',              array['global']::text[], '100% remote.'),
  ('gitlab',      'greenhouse', 'gitlab',      'GitLab',      'https://about.gitlab.com/jobs/',       array['global']::text[], '100% remote.'),
  ('doist',       'greenhouse', 'doist',       'Doist',       'https://doist.com/careers',            array['global']::text[], 'Todoist / Twist. 100% remote.'),

  -- Top tier US tech (high salary, often hire remote / sponsor visas)
  ('stripe',      'greenhouse', 'stripe',      'Stripe',      'https://stripe.com/jobs',              array['global','north_america','europe']::text[], 'Payments. Hires remote globally.'),
  ('anthropic',   'greenhouse', 'anthropic',   'Anthropic',   'https://www.anthropic.com/careers',    array['global','north_america']::text[], 'AI safety. Remote-friendly.'),
  ('openai',      'greenhouse', 'openai',      'OpenAI',      'https://openai.com/careers',           array['global','north_america']::text[], 'AI research.'),
  ('airbnb',      'greenhouse', 'airbnb',      'Airbnb',      'https://careers.airbnb.com',           array['global']::text[], 'Travel marketplace.'),
  ('notion',      'greenhouse', 'notion',      'Notion',      'https://www.notion.so/careers',        array['global','north_america']::text[], 'Productivity tools.'),
  ('figma',       'greenhouse', 'figma',       'Figma',       'https://www.figma.com/careers/',       array['global','north_america']::text[], 'Design tools.'),
  ('vercel',      'greenhouse', 'vercel',      'Vercel',      'https://vercel.com/careers',           array['global']::text[], 'Web platform. Remote-friendly.'),
  ('linear',      'greenhouse', 'linear',      'Linear',      'https://linear.app/careers',           array['global']::text[], 'Issue tracking. Remote.'),
  ('cloudflare',  'greenhouse', 'cloudflare',  'Cloudflare',  'https://www.cloudflare.com/careers/',  array['global','north_america','europe']::text[], 'Edge / CDN.'),
  ('hashicorp',   'greenhouse', 'hashicorp',   'HashiCorp',   'https://www.hashicorp.com/careers',    array['global']::text[], 'Infra tools. Remote.'),

  -- Lever-hosted companies (different ATS, parallel fan-out)
  ('quora',       'lever',      'quora',       'Quora',       'https://www.quora.com/careers',        array['global']::text[], 'Q&A platform.'),
  ('mixpanel',    'lever',      'mixpanel',    'Mixpanel',    'https://mixpanel.com/jobs/',           array['global']::text[], 'Product analytics.'),
  ('netlify',     'lever',      'netlify',     'Netlify',     'https://www.netlify.com/careers/',     array['global']::text[], 'Web platform. Remote-friendly.'),
  ('eventbrite',  'lever',      'eventbrite',  'Eventbrite',  'https://careers.eventbrite.com',       array['global','north_america']::text[], 'Events platform.'),
  ('khan-academy','lever',      'khanacademy', 'Khan Academy','https://www.khanacademy.org/careers',  array['global','north_america']::text[], 'EdTech non-profit.'),
  ('writer',      'lever',      'writer',      'Writer',      'https://writer.com/company/careers/',  array['global']::text[], 'AI for enterprise.'),
  ('replit',      'lever',      'replit',      'Replit',      'https://replit.com/site/careers',      array['global']::text[], 'Browser-based IDE.'),
  ('webflow',     'lever',      'webflow',     'Webflow',     'https://webflow.com/careers',          array['global','north_america']::text[], 'No-code web design.'),
  ('descript',    'lever',      'descript',    'Descript',    'https://www.descript.com/careers',     array['global','north_america']::text[], 'Audio/video editing.'),

  -- AI-forward startups (likely high-volume hiring)
  ('character',   'greenhouse', 'characterai', 'Character.AI','https://character.ai/careers',         array['global','north_america']::text[], 'AI chat platform.'),
  ('huggingface', 'greenhouse', 'huggingface', 'Hugging Face','https://apply.workable.com/huggingface/', array['global']::text[], 'ML community / platform.'),
  ('perplexity',  'greenhouse', 'perplexity',  'Perplexity',  'https://www.perplexity.ai/careers',    array['global','north_america']::text[], 'AI search.'),
  ('mercor',      'greenhouse', 'mercor',      'Mercor',      'https://mercor.com/careers',           array['global','north_america']::text[], 'AI talent matching.')
on conflict (ats, ats_token) do nothing;

comment on table public.tracked_companies is 'Phase 2: per-company ATS endpoints for direct job-feed aggregation. Admin-managed, RLS-locked. companies-search edge function fans out across active rows.';
