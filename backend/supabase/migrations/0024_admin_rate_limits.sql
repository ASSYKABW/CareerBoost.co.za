-- Day 3.4: per-operator admin mutation rate limit.
--
-- A compromised operator session (XSS exfil of bearer token, or
-- malicious browser extension) shouldn't be able to fire thousands
-- of admin mutations before we notice. Cap at 30 mutations per 5-min
-- window per operator. This is generous for legitimate use (manual
-- operator work is rarely above 5-10 mutations/min) but tight enough
-- that an attacker can't drain the user table in seconds.
--
-- Implementation: small table keyed on (admin_user_id, bucket_start_5min).
-- Bucket rolls over every 5 minutes (UTC, aligned). One round-trip
-- check-and-increment via SECURITY DEFINER RPC, similar to the
-- consume_quota pattern.

create table if not exists public.admin_rate_limits (
  admin_user_id  uuid not null references auth.users(id) on delete cascade,
  -- Bucket start is the floor of (now / 5 minutes) — so all calls in
  -- the same 5-min window share a row. Stored as timestamptz for
  -- easy human reading in the dashboard.
  bucket_start   timestamptz not null,
  -- Number of admin mutations in this bucket.
  count          int not null default 0,
  -- Last admin action that incremented this bucket (for forensics).
  last_action    text,
  updated_at     timestamptz not null default now(),
  primary key (admin_user_id, bucket_start)
);

create index if not exists admin_rate_limits_recent_idx
  on public.admin_rate_limits (admin_user_id, bucket_start desc);

-- =============================================================================
-- check_and_increment_admin_rate(p_admin_user_id, p_action)
-- returns jsonb { allowed: bool, count: int, limit: int, reason?: text }
-- =============================================================================
-- Caller pattern (from Edge Function):
--   const { data, error } = await svc.rpc('check_and_increment_admin_rate', {
--     p_admin_user_id: admin.id, p_action: 'admin-user-adjust.grant_quota'
--   });
--   if (!data.allowed) return errorResponse(data.reason, 429);
--
-- Atomic: row is locked for the duration of the function so concurrent
-- mutations can't both squeak past at limit-1.

create or replace function public.check_and_increment_admin_rate(
  p_admin_user_id uuid,
  p_action        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket   timestamptz;
  v_limit    int := 30;
  v_count    int;
  v_window_s int := 300;  -- 5 min in seconds
begin
  -- Floor now to a 5-minute boundary (UTC). All calls within the same
  -- 5-min window land on the same bucket_start.
  v_bucket := to_timestamp(floor(extract(epoch from now() at time zone 'utc') / v_window_s) * v_window_s) at time zone 'utc';

  -- Upsert + atomic increment. Row-level lock during the update
  -- prevents two concurrent calls from both reading count<limit and
  -- both incrementing.
  insert into public.admin_rate_limits (admin_user_id, bucket_start, count, last_action, updated_at)
  values (p_admin_user_id, v_bucket, 1, p_action, now())
  on conflict (admin_user_id, bucket_start) do update
    set count = public.admin_rate_limits.count + 1,
        last_action = excluded.last_action,
        updated_at = now()
  returning count into v_count;

  if v_count > v_limit then
    return jsonb_build_object(
      'allowed',   false,
      'count',     v_count,
      'limit',     v_limit,
      'window_s',  v_window_s,
      'reason',    format(
        'Admin rate limit exceeded: %s mutations in last %s minutes (cap %s). Wait until the bucket rolls over.',
        v_count, v_window_s / 60, v_limit
      )
    );
  end if;

  return jsonb_build_object(
    'allowed',   true,
    'count',     v_count,
    'limit',     v_limit,
    'window_s',  v_window_s
  );
end$$;

revoke all on function public.check_and_increment_admin_rate(uuid, text) from public, anon, authenticated;
grant execute on function public.check_and_increment_admin_rate(uuid, text) to service_role;

comment on function public.check_and_increment_admin_rate is
  'Day 3.4: atomic per-operator admin mutation rate limit. 30 calls / 5 min default. Edge Functions call this BEFORE doing the mutation; reject with 429 if not allowed.';

-- Auto-clean old buckets to keep the table small. Runs as part of any
-- INSERT/UPDATE; cheap because the index makes deletes targeted.
create or replace function public.admin_rate_limits_cleanup()
returns trigger language plpgsql as $$
begin
  -- Drop buckets older than 1 hour (we only care about the last 5 min
  -- for enforcement; 1h gives a forensic tail without bloating).
  delete from public.admin_rate_limits
    where bucket_start < (now() at time zone 'utc') - interval '1 hour';
  return null;
end$$;

drop trigger if exists admin_rate_limits_cleanup_trigger on public.admin_rate_limits;
create trigger admin_rate_limits_cleanup_trigger
  after insert on public.admin_rate_limits
  for each statement execute function public.admin_rate_limits_cleanup();

alter table public.admin_rate_limits enable row level security;
-- RLS: nobody reads/writes this directly. Only the SECURITY DEFINER RPC
-- (which runs as the function definer) touches it.
create policy "admin_rate_limits_no_direct_access"
  on public.admin_rate_limits
  for all
  using (false)
  with check (false);

comment on table public.admin_rate_limits is
  'Day 3.4: per-operator admin mutation rate buckets. Only check_and_increment_admin_rate() touches this.';
