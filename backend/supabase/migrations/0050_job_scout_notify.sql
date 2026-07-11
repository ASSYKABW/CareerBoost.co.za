-- 0050: Job Scout Agent — Phase 3 notification preferences.
--
-- When a SCHEDULED (cron) scan delivers brand-new roles, the agent can reach
-- the user via PWA push and/or an email digest. Both default ON so a freshly
-- created agent notifies out of the box; the wizard exposes per-channel toggles.
-- (Manual "Scan now" never notifies — the user is already looking at the app.)

alter table public.job_scout_agents
  add column if not exists notify_push boolean not null default true;

alter table public.job_scout_agents
  add column if not exists notify_email boolean not null default true;

-- Timestamp of the last delivered-notification, for observability + a future
-- "don't re-notify within N minutes" guard (cadence already paces frequency).
alter table public.job_scout_agents
  add column if not exists last_notified_at timestamptz;
