-- Phase E1: Interview/offer outcome tracking.
--
-- For the admin Command Center's North Star metric ("Active placements in
-- last 30 days") we need explicit outcome events that survive even after a
-- candidate moves the application back to "applied" or deletes the row.
-- The existing applications.stage gives us a current-state snapshot;
-- interview_outcomes gives us an immutable audit of milestones.
--
-- Candidates self-report outcomes from the pipeline detail view. The admin
-- console aggregates over this table to compute placement counts, time-to-
-- interview, and source-channel attribution (which job board → which
-- interview → which offer).

create extension if not exists "pgcrypto";

create table if not exists public.interview_outcomes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Application this outcome is tied to. nullable so users can report
  -- ad-hoc outcomes from applications they never tracked in CareerBoost.
  application_id uuid references public.applications(id) on delete set null,
  -- "interview" | "offer" | "rejected_after_interview" | "withdrew_after_offer".
  -- Rejected/withdrawn are tracked separately so placements only counts
  -- positive outcomes. Validation enforced via check constraint.
  outcome_type text not null,
  -- When the outcome actually happened (candidate-reported). Defaults to
  -- now() for convenience; UI exposes a date picker for backfilling.
  occurred_at  timestamptz not null default now(),
  company      text,
  role         text,
  -- Where the original job listing came from. Used by the admin Growth
  -- board to attribute placements to acquisition channels (LinkedIn,
  -- Adzuna, extension import, etc).
  source_channel text,
  -- Free-text candidate note. NOT exported by admin — privacy guard.
  notes        text,
  created_at   timestamptz not null default now(),

  constraint interview_outcomes_outcome_type_chk check (
    outcome_type in ('interview', 'offer', 'rejected_after_interview', 'withdrew_after_offer')
  ),
  -- Same privacy ceiling we apply to usage telemetry: candidate notes
  -- can't exceed 4 KB so we never end up with resume/cover-letter dumps
  -- in the outcome table.
  constraint interview_outcomes_notes_size_chk check (
    notes is null or octet_length(notes) <= 4096
  )
);

create index if not exists interview_outcomes_user_occurred_idx
  on public.interview_outcomes (user_id, occurred_at desc);

create index if not exists interview_outcomes_occurred_idx
  on public.interview_outcomes (occurred_at desc);

create index if not exists interview_outcomes_type_occurred_idx
  on public.interview_outcomes (outcome_type, occurred_at desc);

create index if not exists interview_outcomes_application_idx
  on public.interview_outcomes (application_id)
  where application_id is not null;

create index if not exists interview_outcomes_source_idx
  on public.interview_outcomes (source_channel)
  where source_channel is not null;

-- RLS: candidates own their rows, service role + admins read all.
alter table public.interview_outcomes enable row level security;
alter table public.interview_outcomes force row level security;

drop policy if exists "interview_outcomes_owner_select" on public.interview_outcomes;
create policy "interview_outcomes_owner_select"
  on public.interview_outcomes
  for select
  using (auth.uid() = user_id);

drop policy if exists "interview_outcomes_owner_insert" on public.interview_outcomes;
create policy "interview_outcomes_owner_insert"
  on public.interview_outcomes
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "interview_outcomes_owner_update" on public.interview_outcomes;
create policy "interview_outcomes_owner_update"
  on public.interview_outcomes
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "interview_outcomes_owner_delete" on public.interview_outcomes;
create policy "interview_outcomes_owner_delete"
  on public.interview_outcomes
  for delete
  using (auth.uid() = user_id);

-- Anonymous users can't see anything.
revoke all on public.interview_outcomes from anon;
-- Service role bypasses RLS — the admin function uses this for aggregates.
grant select on public.interview_outcomes to service_role;
grant insert, update, delete on public.interview_outcomes to authenticated;
grant select on public.interview_outcomes to authenticated;

-- View: rolled-up placements for the last 30 / prior 30 / 90-day windows.
-- The admin-overview function reads this view in a single query instead of
-- re-aggregating in JS. Returns one row per outcome_type per window.
--
-- "placements" = interview OR offer (positive outcomes). Rejected/withdrawn
-- exist for context but don't count toward the North Star.
create or replace view public.v_admin_outcome_rollup as
with windows as (
  select 'last_30d'  as window_name, now() - interval '30 days'  as window_start, now() as window_end
  union all
  select 'prior_30d'                  , now() - interval '60 days', now() - interval '30 days'
  union all
  select 'last_90d'                  , now() - interval '90 days', now()
)
select
  w.window_name,
  o.outcome_type,
  count(*)::int                              as event_count,
  count(distinct o.user_id)::int             as distinct_users,
  count(distinct o.company)::int             as distinct_companies,
  count(*) filter (where o.source_channel is not null)::int as attributed_count
from windows w
left join public.interview_outcomes o
  on o.occurred_at >= w.window_start and o.occurred_at < w.window_end
group by w.window_name, o.outcome_type;

grant select on public.v_admin_outcome_rollup to service_role;

-- View: placements grouped by source channel. Powers the Growth board's
-- "which channel actually leads to interviews/offers" panel in Phase E2,
-- and the Command Center's "Top performing channel" priority card.
create or replace view public.v_admin_outcome_by_channel as
select
  coalesce(source_channel, 'unattributed') as channel,
  count(*) filter (where outcome_type = 'interview' and occurred_at >= now() - interval '30 days')::int as interviews_30d,
  count(*) filter (where outcome_type = 'offer'     and occurred_at >= now() - interval '30 days')::int as offers_30d,
  count(*) filter (where outcome_type in ('interview','offer') and occurred_at >= now() - interval '30 days')::int as placements_30d,
  count(distinct user_id) filter (where occurred_at >= now() - interval '30 days')::int as distinct_users_30d
from public.interview_outcomes
group by coalesce(source_channel, 'unattributed')
order by placements_30d desc;

grant select on public.v_admin_outcome_by_channel to service_role;

comment on table public.interview_outcomes is
  'Candidate-reported interview / offer milestones. Source for the admin Command Center North Star metric (active placements). RLS: owners read/write, service role + admins read all. Notes capped at 4KB.';

comment on view public.v_admin_outcome_rollup is
  'Phase E1: rolled-up placement counts for the admin Command Center. Returns event counts for last_30d / prior_30d / last_90d windows by outcome_type.';

comment on view public.v_admin_outcome_by_channel is
  'Phase E1: placements grouped by source_channel. Powers acquisition-attribution panels in the admin console.';
