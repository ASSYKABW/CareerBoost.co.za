-- Phase E2: Acquisition attribution + geography.
--
-- The admin Growth & Acquisition board needs to answer:
--   "Which channels drive QUALITY signups (signups that activate and
--    then place)?" and "Where geographically do users come from?"
--
-- The candidate-side capture is dead-simple: on landing-page load, the
-- frontend stores utm_* + document.referrer + window.location.pathname in
-- localStorage. On first successful sign-in we POST that bundle to the
-- new signup-attribution Edge Function, which:
--   1. Reads cf-ipcountry header (Supabase Edge Functions sit behind
--      Cloudflare, so this is reliable when present).
--   2. Upserts the columns added below onto the user's profile.
--
-- Privacy:
--   - We store country code only (e.g. "ZA", "US"), never IP or city.
--   - Referrer is normalized to host only ("linkedin.com", not the full
--     URL with path/query) to avoid leaking sensitive search queries.
--   - Landing path is the candidate-side path only (e.g. "/landing",
--     "/?ref=foo"), never an external URL.
--   - All values can be NULL — direct visits with no UTM are fine.

alter table public.profiles
  add column if not exists utm_source     text,
  add column if not exists utm_medium     text,
  add column if not exists utm_campaign   text,
  add column if not exists utm_content    text,
  add column if not exists utm_term       text,
  add column if not exists referrer_host  text,
  add column if not exists landing_path   text,
  add column if not exists country_code   text,
  add column if not exists signup_at      timestamptz;

-- Backfill signup_at = created_at for existing profiles so the Growth
-- board has a sensible "when did they sign up" anchor immediately.
update public.profiles
  set signup_at = coalesce(signup_at, created_at, now())
  where signup_at is null;

-- Privacy guard: cap text columns so a hostile or buggy client can't
-- write arbitrary blobs into the profile. Realistic UTM/referrer values
-- are well under 256 bytes. Postgres has no "ADD CONSTRAINT IF NOT EXISTS",
-- so we wrap each ADD in a DO block that checks pg_constraint first.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_utm_source_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_utm_source_size_chk check (utm_source is null or octet_length(utm_source) <= 256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_utm_medium_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_utm_medium_size_chk check (utm_medium is null or octet_length(utm_medium) <= 256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_utm_campaign_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_utm_campaign_size_chk check (utm_campaign is null or octet_length(utm_campaign) <= 256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_utm_content_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_utm_content_size_chk check (utm_content is null or octet_length(utm_content) <= 256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_utm_term_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_utm_term_size_chk check (utm_term is null or octet_length(utm_term) <= 256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_referrer_host_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_referrer_host_size_chk check (referrer_host is null or octet_length(referrer_host) <= 256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_landing_path_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_landing_path_size_chk check (landing_path is null or octet_length(landing_path) <= 512);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_country_code_size_chk' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_country_code_size_chk check (country_code is null or octet_length(country_code) <= 8);
  end if;
end $$;

create index if not exists profiles_utm_source_idx     on public.profiles (utm_source)     where utm_source     is not null;
create index if not exists profiles_utm_medium_idx     on public.profiles (utm_medium)     where utm_medium     is not null;
create index if not exists profiles_utm_campaign_idx   on public.profiles (utm_campaign)   where utm_campaign   is not null;
create index if not exists profiles_referrer_host_idx  on public.profiles (referrer_host)  where referrer_host  is not null;
create index if not exists profiles_country_code_idx   on public.profiles (country_code)   where country_code   is not null;
create index if not exists profiles_signup_at_idx      on public.profiles (signup_at desc) where signup_at      is not null;

-- ─────────────────────────────────────────────────────────────────────
-- View: acquisition funnel by channel (utm_source).
-- Joins profiles → applications → interview_outcomes so we can see, per
-- channel, how many signed up vs. activated (any application) vs. placed
-- (interview/offer). This is the *quality* score the operator needs — a
-- channel with 1000 signups and 0 placements is a leak, not a win.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.v_admin_acquisition_channels as
with
  signups as (
    select coalesce(utm_source, 'direct') as channel,
           coalesce(utm_medium, 'unknown') as medium,
           user_id,
           signup_at
    from public.profiles
    where signup_at is not null
  ),
  -- "Activated" = users who created at least one application.
  activated_users as (
    select distinct user_id from public.applications
  ),
  -- "Placed" = users with at least one interview or offer outcome,
  -- OR with an application currently in interview/offer stage. The
  -- OR-clause matters when interview_outcomes is empty on a fresh install.
  placed_users as (
    select distinct user_id from public.interview_outcomes
      where outcome_type in ('interview', 'offer')
    union
    select distinct user_id from public.applications
      where stage in ('interview', 'offer')
  )
select
  s.channel,
  s.medium,
  count(distinct s.user_id)::int                                                          as signups,
  count(distinct s.user_id) filter (where s.signup_at >= now() - interval '30 days')::int as signups_30d,
  count(distinct s.user_id) filter (where au.user_id is not null)::int                    as activated,
  count(distinct s.user_id) filter (where pu.user_id is not null)::int                    as placed,
  -- Quality score: weighted placements / signups. Capped at 100.
  case
    when count(distinct s.user_id) = 0 then 0
    else least(100, round(100.0 * count(distinct s.user_id) filter (where pu.user_id is not null) / count(distinct s.user_id)))::int
  end as quality_score
from signups s
left join activated_users au on au.user_id = s.user_id
left join placed_users    pu on pu.user_id = s.user_id
group by s.channel, s.medium
order by signups desc;

grant select on public.v_admin_acquisition_channels to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- View: signups by country.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.v_admin_acquisition_geo as
select
  coalesce(country_code, 'unknown') as country_code,
  count(*)::int                                                                                                                  as signups,
  count(*) filter (where signup_at >= now() - interval '30 days')::int                                                           as signups_30d,
  count(distinct user_id) filter (where user_id in (select distinct user_id from public.applications))::int                       as activated,
  count(distinct user_id) filter (where user_id in (
    select distinct user_id from public.interview_outcomes where outcome_type in ('interview','offer')
    union
    select distinct user_id from public.applications where stage in ('interview','offer')
  ))::int as placed
from public.profiles
where signup_at is not null
group by coalesce(country_code, 'unknown')
order by signups desc;

grant select on public.v_admin_acquisition_geo to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- View: top landing pages.
-- Aggregates by landing_path so the operator sees which entry points
-- convert. "unknown" = direct visits without a captured path.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.v_admin_acquisition_landing as
select
  coalesce(landing_path, 'unknown') as landing_path,
  count(*)::int                                                                                                       as signups,
  count(*) filter (where signup_at >= now() - interval '30 days')::int                                                as signups_30d,
  count(distinct user_id) filter (where user_id in (select distinct user_id from public.applications))::int            as activated
from public.profiles
where signup_at is not null
group by coalesce(landing_path, 'unknown')
order by signups desc
limit 20;

grant select on public.v_admin_acquisition_landing to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- View: top referrer hosts (organic discovery sources).
-- Separate from utm_source because organic discovery (someone tweeted a
-- link, search engine click) often has no UTM but does have a referrer.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.v_admin_acquisition_referrers as
select
  coalesce(referrer_host, 'direct') as referrer_host,
  count(*)::int                                                                                                       as signups,
  count(*) filter (where signup_at >= now() - interval '30 days')::int                                                as signups_30d,
  count(distinct user_id) filter (where user_id in (select distinct user_id from public.applications))::int            as activated
from public.profiles
where signup_at is not null
group by coalesce(referrer_host, 'direct')
order by signups desc
limit 20;

grant select on public.v_admin_acquisition_referrers to service_role;

comment on column public.profiles.utm_source     is 'Phase E2: acquisition attribution. Channel name from landing URL ?utm_source=. Capped 256 bytes.';
comment on column public.profiles.utm_medium     is 'Phase E2: acquisition attribution. Medium from ?utm_medium=.';
comment on column public.profiles.utm_campaign   is 'Phase E2: acquisition attribution. Campaign name from ?utm_campaign=.';
comment on column public.profiles.utm_content    is 'Phase E2: acquisition attribution. Creative/variant from ?utm_content=.';
comment on column public.profiles.utm_term       is 'Phase E2: acquisition attribution. Keyword from ?utm_term=.';
comment on column public.profiles.referrer_host  is 'Phase E2: host of document.referrer at landing time. Host only, never full URL. e.g. "linkedin.com".';
comment on column public.profiles.landing_path   is 'Phase E2: candidate-side path at landing time. e.g. "/landing", "/?ref=foo".';
comment on column public.profiles.country_code   is 'Phase E2: ISO 3166-1 alpha-2 country code resolved from cf-ipcountry header at signup-attribution time.';
comment on column public.profiles.signup_at      is 'Phase E2: when the candidate signed up. Defaults to created_at on backfill.';
