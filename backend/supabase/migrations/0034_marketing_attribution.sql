-- 0034_marketing_attribution.sql: Marketing engine — Phase 4 attribution loop.
--
-- content_events logs views/clicks/shares per content piece (written by the
-- public content-track edge fn). The scorecard RPC joins those events with
-- signup attribution (profiles.utm_campaign = blog slug) so each post shows
-- views -> clicks -> attributed signups. RLS on, no policies (edge fns use
-- service_role); the RPC is security definer + admin-gated at the edge.

create table if not exists content_events (
  id          uuid primary key default gen_random_uuid(),
  slug        text,
  content_id  uuid references content_pieces (id) on delete set null,
  event       text not null check (event in ('view', 'click', 'share')),
  anon_id     text,        -- client-generated, for rough de-dup (not identity)
  referrer    text,
  at          timestamptz not null default now()
);

comment on table content_events is 'View/click/share events per content piece, written by content-track. Aggregated by the scorecard RPC.';

alter table content_events enable row level security;
-- No policies: written via content-track (service_role), read via the RPC.

create index if not exists content_events_slug_idx
  on content_events (slug, event, at desc);

-- Per-post scorecard: views, clicks, and attributed signups (profiles whose
-- first-touch utm_campaign equals the post slug — set by signup-attribution).
create or replace function marketing_content_scorecard()
returns table (
  slug         text,
  title        text,
  published_at timestamptz,
  views        bigint,
  clicks       bigint,
  signups      bigint
)
language sql
security definer
set search_path = public
as $$
  select
    cp.slug,
    cp.title,
    cp.published_at,
    coalesce(ev.views, 0)   as views,
    coalesce(ev.clicks, 0)  as clicks,
    coalesce(sg.signups, 0) as signups
  from content_pieces cp
  left join (
    select slug,
           count(*) filter (where event = 'view')  as views,
           count(*) filter (where event = 'click') as clicks
    from content_events
    group by slug
  ) ev on ev.slug = cp.slug
  left join (
    select utm_campaign, count(*) as signups
    from profiles
    where utm_campaign is not null and utm_campaign <> ''
    group by utm_campaign
  ) sg on sg.utm_campaign = cp.slug
  where cp.type = 'blog' and cp.slug is not null
  order by cp.published_at desc nulls last
  limit 60;
$$;

comment on function marketing_content_scorecard() is 'Per-blog-post views/clicks (content_events) + attributed signups (profiles.utm_campaign = slug). Called by admin-content (service_role).';
