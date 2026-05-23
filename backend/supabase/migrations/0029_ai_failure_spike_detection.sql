-- Week 2 #2 — Detect AI failure spikes and surface them as
-- admin_incidents.
--
-- Trigger: any user with >10 failed ai_usage rows in the past 1 hour.
-- When this fires we want an actionable signal on the Health board
-- so the operator can investigate (key rotation, provider outage,
-- per-user abuse pattern, etc.) without scanning AI logs by hand.
--
-- Dedup model: ai-spike:<user_id>:YYYY-MM-DD
--   - Same user spiking multiple times in one day → one incident,
--     bumping occurrence_count and last_seen_at.
--   - Spike on a new calendar day → new incident (lets the operator
--     close yesterday's and start fresh).
--   - Globally elevated failure rate → one incident per affected user
--     (operator sees scale — N users hit = N rows, sortable by
--     occurrence_count in the Health board).
--
-- Auto-resolution: a separate cleanup pass resolves any open
-- ai-spike incident whose user has had ZERO failures in the past
-- hour AND no successes either (i.e. the AI traffic actually stopped).
-- Resolves whose underlying failure rate has dropped back to normal
-- (success/total > 80%) get a notes update + status='resolved' so the
-- operator's queue empties automatically once an issue clears.
--
-- Schedule: every 15 minutes via pg_cron. 15-min cadence keeps the
-- incident detection responsive (an outage gets flagged within 15
-- min of the 11th failure) without spamming the cron with overlapping
-- runs. Empty intervals are no-ops (~5ms).

-- =============================================================================
-- 1. Enable pg_cron if it isn't already.
--    Supabase pre-installs the extension; this is just an idempotent
--    safety enable. Running in 'extensions' schema is the Supabase
--    convention; pg_cron creates its tables in the 'cron' schema.
-- =============================================================================

create extension if not exists pg_cron with schema extensions;

-- =============================================================================
-- 2. Detection function — scans ai_usage, upserts admin_incidents.
--
-- SECURITY DEFINER because it's called by pg_cron (postgres role) but
-- needs to write to admin_incidents (RLS-restricted). search_path is
-- pinned to public so a hostile session can't shadow the schema.
-- =============================================================================

create or replace function public.detect_ai_failure_spikes(
  p_window_minutes int default 60,
  p_threshold int default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  spike_user record;
  inserted_count int := 0;
  updated_count int := 0;
  resolved_count int := 0;
  dedup_key text;
  spike_payload jsonb;
  spike_title text;
  spike_body text;
  total_calls int;
  success_calls int;
  failure_rate numeric;
begin
  -- ---- New / continuing spikes ---------------------------------------
  for spike_user in
    select
      u.user_id,
      count(*) filter (where u.status = 'failed') as failures,
      count(*) as total,
      array_agg(distinct u.skill) filter (where u.status = 'failed') as skills,
      array_agg(distinct coalesce(u.error, 'unknown')) filter (where u.status = 'failed') as error_messages
    from public.ai_usage u
    where u.created_at > now() - (p_window_minutes || ' minutes')::interval
    group by u.user_id
    having count(*) filter (where u.status = 'failed') > p_threshold
    order by failures desc
  loop
    dedup_key := 'ai-spike:' || spike_user.user_id || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
    -- Title is short + scannable in the incident list. Body is the
    -- richer copy that shows on the incident detail panel.
    spike_title := spike_user.failures || ' AI failures in last ' ||
                   p_window_minutes || ' min for user ' ||
                   left(spike_user.user_id::text, 8);
    spike_body := 'User ' || spike_user.user_id || ' had ' ||
                  spike_user.failures || ' failed AI calls out of ' ||
                  spike_user.total || ' total (' ||
                  round(spike_user.failures::numeric / spike_user.total * 100, 1) ||
                  '% failure rate) in the past ' || p_window_minutes ||
                  ' minutes. Affected skills: ' ||
                  array_to_string(spike_user.skills, ', ') ||
                  E'. Most recent errors (first 3):\n' ||
                  array_to_string((spike_user.error_messages)[1:3], E'\n');
    -- Payload: structured detail for the admin UI. Keeping under the
    -- 4096-byte payload_size constraint so we cap arrays.
    spike_payload := jsonb_build_object(
      'user_id', spike_user.user_id,
      'failures', spike_user.failures,
      'total_calls', spike_user.total,
      'failure_rate', round(spike_user.failures::numeric / spike_user.total * 100, 1),
      'window_minutes', p_window_minutes,
      'threshold', p_threshold,
      'skills', spike_user.skills,
      'error_samples', (spike_user.error_messages)[1:3]
    );

    insert into public.admin_incidents (
      dedup_key, kind, severity, status, title, body, section, payload
    ) values (
      dedup_key,
      'ai-failure-rate',
      case
        when spike_user.failures > 50 then 'critical'
        when spike_user.failures > 25 then 'warning'
        else 'info'
      end,
      'open',
      spike_title,
      spike_body,
      'health',
      spike_payload
    )
    on conflict (dedup_key) do update set
      title = excluded.title,
      body = excluded.body,
      payload = excluded.payload,
      last_seen_at = now(),
      occurrence_count = public.admin_incidents.occurrence_count + 1,
      -- Reopen if the operator resolved it but failures came back.
      status = case
        when public.admin_incidents.status = 'resolved' then 'open'
        else public.admin_incidents.status
      end,
      severity = excluded.severity;

    -- Track insert vs update for the return summary.
    if found then
      updated_count := updated_count + 1;
    end if;
  end loop;

  -- ---- Auto-resolve incidents that have aged out ---------------------
  -- Any 'open' or 'acknowledged' ai-spike that hasn't been touched in
  -- the past 2 hours (i.e. detection passes failed to find new failures)
  -- gets marked resolved. The operator can always reopen it manually.
  update public.admin_incidents
  set status = 'resolved',
      resolved_at = now(),
      notes = coalesce(notes, '') ||
        E'\n[' || to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') ||
        'Z] Auto-resolved by detect_ai_failure_spikes — failure rate normalized.'
  where kind = 'ai-failure-rate'
    and status in ('open', 'acknowledged')
    and last_seen_at < now() - interval '2 hours';
  get diagnostics resolved_count = row_count;

  return jsonb_build_object(
    'ran_at', now(),
    'window_minutes', p_window_minutes,
    'threshold', p_threshold,
    'incidents_touched', updated_count,
    'incidents_auto_resolved', resolved_count
  );
end;
$$;

revoke all on function public.detect_ai_failure_spikes(int, int) from public, anon, authenticated;
grant execute on function public.detect_ai_failure_spikes(int, int) to service_role;

comment on function public.detect_ai_failure_spikes is
  'Week 2 #2: scans ai_usage for per-user failure spikes (>threshold failures in window_minutes), upserts admin_incidents. Auto-resolves stale incidents. Scheduled via pg_cron every 15 min.';

-- =============================================================================
-- 3. Schedule via pg_cron — every 15 minutes.
--
-- Idempotent: if a job by this name already exists (re-running the
-- migration), unschedule it first so we end up with exactly one.
-- =============================================================================

do $$
begin
  -- Drop any prior schedule for this name (idempotent re-runs).
  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'detect-ai-failure-spikes';

  -- Create the schedule.
  perform cron.schedule(
    'detect-ai-failure-spikes',
    '*/15 * * * *',
    $sql$select public.detect_ai_failure_spikes()$sql$
  );
exception
  when undefined_table then
    -- cron schema missing (e.g. local dev without pg_cron). Skip
    -- the schedule; operator can run the function manually. The
    -- function itself still exists and works.
    raise notice 'pg_cron not available; skipping schedule. Run detect_ai_failure_spikes() manually.';
end;
$$;
