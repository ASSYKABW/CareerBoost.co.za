-- 0052: Job Scout Agent — tiered limits (Free trial + Plus/Pro/Career ladder).
--
-- Free tier is a TRIAL: one agent, 4 automatic scans ~5h apart, then it stops
-- and the user is nudged to upgrade. We track scans used and whether the
-- one-time "you're out of free scans" upsell has been sent.

alter table public.job_scout_agents
  add column if not exists scan_count int not null default 0;

alter table public.job_scout_agents
  add column if not exists upsell_sent boolean not null default false;
