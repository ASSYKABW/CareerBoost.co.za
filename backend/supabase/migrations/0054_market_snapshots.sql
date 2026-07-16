-- =============================================================================
-- 0054 — Weekly live job-market snapshots
-- =============================================================================
-- Feeds the content engine real, attributable numbers.
--
-- Context: the marketing engine was told "use ONLY the facts provided" and then
-- handed no facts, so it could only ever write generic advice. The app's own
-- pipeline is far too small to generalise from (single-digit applications), so
-- the honest source of market truth is the LIVE job market we already scan via
-- our own jobs-search — which needs zero users.
--
-- One row per (week_start, segment). `scanned` is stored alongside the facts so
-- copy can always attribute ("across the 412 postings we scanned this week")
-- and so week-over-week deltas can be refused when either week's sample is too
-- thin to mean anything.
--
-- Service-role only: written by marketing-cron, read by the content engine and
-- the Console. Never exposed to the browser.
-- =============================================================================

create table if not exists public.market_snapshots (
  id          uuid primary key default gen_random_uuid(),
  week_start  date not null,                    -- Monday of the scan week (UTC)
  segment     text not null,                    -- e.g. 'software-developer'
  label       text not null default '',         -- human label for copy
  scanned     int  not null default 0,          -- sample size — the honesty anchor
  sufficient  boolean not null default false,   -- false → no percentage claims
  facts       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint market_snapshots_week_segment_uniq unique (week_start, segment),
  constraint market_snapshots_segment_len check (char_length(segment) between 2 and 60)
);

create index if not exists market_snapshots_segment_week_idx
  on public.market_snapshots (segment, week_start desc);

alter table public.market_snapshots enable row level security;
alter table public.market_snapshots force row level security;

-- No policies: service_role bypasses RLS, everyone else gets nothing.
revoke all on public.market_snapshots from anon, authenticated;

comment on table public.market_snapshots is
  'Weekly aggregate of a live jobs-search scan per role segment. Powers factual marketing content. scanned/sufficient exist so the writer can attribute numbers and so thin samples never become fake trends.';
