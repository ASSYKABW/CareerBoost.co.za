-- Console Phase B+: content calendar support.
-- scheduled_for = the day the operator plans to post a draft. Drives the
-- Copilot calendar view (drafts grouped by week); NULL = unplanned.
alter table public.social_drafts
  add column if not exists scheduled_for date;

create index if not exists social_drafts_scheduled_idx
  on public.social_drafts (scheduled_for)
  where scheduled_for is not null;
