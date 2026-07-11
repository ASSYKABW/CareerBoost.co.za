-- 0051: Job Scout Agent — Phase 4b, allow multiple agents per user.
--
-- Drop the one-agent-per-user unique index so a user can run several agents
-- (e.g. "Fire Engineer · Cape Town" and "Remote React Developer"). The
-- per-user count cap is enforced in the job-scout function (free 1 / paid 5),
-- and the save path switches from upsert-on-user_id to explicit
-- create (insert) / update (by id).

drop index if exists public.job_scout_agents_user_uniq;

-- Keep a plain index for the common "all of this user's agents" lookup.
create index if not exists job_scout_agents_user_idx
  on public.job_scout_agents (user_id, created_at);
