-- =============================================================================
-- Admin Phase C: audit log + incident persistence + operator promote RPC
-- =============================================================================
-- Three additions to support operational maturity:
--   1. admin_audit_log — every admin mutation gets a row. Service-role only.
--   2. admin_incidents — persisted incidents with dedup hash + ack/resolve.
--   3. admin_promote_user(target_id, roles, note) RPC — sets app_metadata.role
--      for a target user from inside Postgres, returning the audit log id.
--
-- All three are SECURITY DEFINER, RLS-locked, and audit-logged. No path here
-- lets an authenticated user become admin themselves: callers must already
-- be admin (the Edge Function gates that) and we record who did what.
--
-- Privacy: payload columns enforce the same key-blocklist as usage_events
-- so leaked tokens, passwords, resume body, etc. cannot enter the audit log.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- admin_audit_log
-- -----------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id               uuid primary key default gen_random_uuid(),
  admin_user_id    uuid not null references auth.users(id) on delete restrict,
  admin_email      text,                                  -- snapshot at log time
  action           text not null,                         -- e.g. "promote_user", "demote_user", "resolve_incident"
  target_user_id   uuid references auth.users(id) on delete set null,
  target_email     text,                                  -- snapshot at log time
  payload          jsonb not null default '{}'::jsonb,    -- action-specific args
  result_status    text not null default 'success' check (result_status in ('success', 'failed')),
  error_message    text,
  ip_address       inet,
  user_agent       text,
  occurred_at      timestamptz not null default now(),
  constraint admin_audit_log_action_len check (char_length(action) between 2 and 80),
  constraint admin_audit_log_payload_size check (octet_length(payload::text) <= 4096),
  constraint admin_audit_log_payload_privacy check (
    not (payload ?| array[
      'apiKey', 'api_key', 'accessToken', 'access_token', 'refreshToken',
      'refresh_token', 'password', 'secret', 'resume', 'cv', 'coverLetter',
      'cover_letter', 'jobDescription', 'job_description', 'rawText',
      'raw_text', 'html'
    ])
  )
);
create index if not exists admin_audit_log_admin_occurred_idx
  on public.admin_audit_log (admin_user_id, occurred_at desc);
create index if not exists admin_audit_log_target_occurred_idx
  on public.admin_audit_log (target_user_id, occurred_at desc);
create index if not exists admin_audit_log_action_occurred_idx
  on public.admin_audit_log (action, occurred_at desc);
create index if not exists admin_audit_log_occurred_idx
  on public.admin_audit_log (occurred_at desc);

alter table public.admin_audit_log enable row level security;
alter table public.admin_audit_log force row level security;
drop policy if exists "admin_audit_log_no_user_access" on public.admin_audit_log;
create policy "admin_audit_log_no_user_access"
  on public.admin_audit_log for all to authenticated
  using (false) with check (false);
revoke all on public.admin_audit_log from anon, authenticated;

comment on table public.admin_audit_log is
  'Append-only log of every admin mutation. Service-role only; RLS deny for users.';

-- -----------------------------------------------------------------------------
-- admin_incidents — open/acknowledged/resolved with dedup hash
-- -----------------------------------------------------------------------------
create table if not exists public.admin_incidents (
  id                uuid primary key default gen_random_uuid(),
  dedup_key         text not null unique,                 -- sha256(kind || ':' || key)
  kind              text not null,                        -- e.g. "ai-failure-rate", "stale-source"
  severity          text not null default 'warning' check (severity in ('critical', 'warning', 'info')),
  status            text not null default 'open' check (status in ('open', 'acknowledged', 'snoozed', 'resolved')),
  title             text not null,
  body              text,
  section           text,                                 -- admin section the incident belongs to
  payload           jsonb not null default '{}'::jsonb,
  opened_at         timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  acknowledged_at   timestamptz,
  acknowledged_by   uuid references auth.users(id) on delete set null,
  snoozed_until     timestamptz,
  resolved_at       timestamptz,
  resolved_by       uuid references auth.users(id) on delete set null,
  occurrence_count  integer not null default 1,
  notes             text,
  constraint admin_incidents_payload_size check (octet_length(payload::text) <= 4096),
  constraint admin_incidents_payload_privacy check (
    not (payload ?| array[
      'apiKey', 'api_key', 'accessToken', 'access_token', 'refreshToken',
      'refresh_token', 'password', 'secret', 'resume', 'cv', 'coverLetter',
      'cover_letter', 'jobDescription', 'job_description', 'rawText',
      'raw_text', 'html'
    ])
  )
);
create index if not exists admin_incidents_status_severity_idx
  on public.admin_incidents (status, severity, last_seen_at desc);
create index if not exists admin_incidents_kind_idx
  on public.admin_incidents (kind, status);
create index if not exists admin_incidents_section_idx
  on public.admin_incidents (section, status);
create index if not exists admin_incidents_last_seen_idx
  on public.admin_incidents (last_seen_at desc);

alter table public.admin_incidents enable row level security;
alter table public.admin_incidents force row level security;
drop policy if exists "admin_incidents_no_user_access" on public.admin_incidents;
create policy "admin_incidents_no_user_access"
  on public.admin_incidents for all to authenticated
  using (false) with check (false);
revoke all on public.admin_incidents from anon, authenticated;

comment on table public.admin_incidents is
  'Persisted operational incidents with dedup hash + ack/resolve lifecycle.';

-- -----------------------------------------------------------------------------
-- upsert_admin_incident(...) — service-role-only. Used by admin-overview to
-- persist its computed in-memory incidents. Dedups by (kind, key); on repeat
-- it bumps last_seen_at + occurrence_count + the body/payload, but keeps the
-- existing status (so an acknowledged incident stays acknowledged even if
-- the underlying condition flares again).
-- -----------------------------------------------------------------------------
create or replace function public.upsert_admin_incident(
  p_kind     text,
  p_key      text,
  p_severity text,
  p_title    text,
  p_body     text,
  p_section  text,
  p_payload  jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dedup text := encode(digest(p_kind || ':' || coalesce(p_key, ''), 'sha256'), 'hex');
  v_id    uuid;
begin
  insert into public.admin_incidents (
    dedup_key, kind, severity, status, title, body, section, payload,
    opened_at, last_seen_at, occurrence_count
  )
  values (
    v_dedup, p_kind, coalesce(p_severity, 'warning'), 'open',
    p_title, p_body, p_section, coalesce(p_payload, '{}'::jsonb),
    now(), now(), 1
  )
  on conflict (dedup_key) do update
    set last_seen_at      = excluded.last_seen_at,
        title             = excluded.title,
        body              = excluded.body,
        severity          = excluded.severity,
        payload           = excluded.payload,
        occurrence_count  = admin_incidents.occurrence_count + 1,
        -- Re-open a previously resolved incident only if it's a new flare,
        -- not on every refresh. Keep acknowledged/snoozed where they are.
        status            = case
          when admin_incidents.status = 'resolved'
            and admin_incidents.resolved_at < now() - interval '15 minutes'
            then 'open'
          else admin_incidents.status
        end
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.upsert_admin_incident(text,text,text,text,text,text,jsonb) is
  'Service-role-only: idempotent incident upsert with dedup hash. Re-opens stale resolved incidents only after 15 min cooldown.';

-- -----------------------------------------------------------------------------
-- admin_promote_user — service-role-only. Sets app_metadata.role for the
-- target user via auth.users.raw_app_meta_data update. Records the change
-- in admin_audit_log. Returns the audit log id.
--
-- IMPORTANT: this is called BY the Edge Function which has already gated
-- the caller via getAuthedAdmin. The function trusts its caller because
-- only service role can invoke it.
-- -----------------------------------------------------------------------------
create or replace function public.admin_promote_user(
  p_admin_user_id  uuid,
  p_admin_email    text,
  p_target_user_id uuid,
  p_target_email   text,
  p_roles          text[],
  p_note           text default null,
  p_ip             inet default null,
  p_user_agent     text default null
) returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_audit_id   uuid;
  v_action     text := case
    when p_roles is null or array_length(p_roles, 1) is null then 'demote_user'
    else 'promote_user'
  end;
  v_prev_meta  jsonb;
  v_next_meta  jsonb;
begin
  if p_target_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  -- Read previous metadata so the audit log captures the before/after.
  select raw_app_meta_data into v_prev_meta from auth.users where id = p_target_user_id;
  if v_prev_meta is null then v_prev_meta := '{}'::jsonb; end if;

  -- Build the new metadata. We set both `role` (legacy) and `roles` (canonical
  -- array) to be tolerant of both shapes used elsewhere in the codebase.
  if p_roles is null or array_length(p_roles, 1) is null then
    v_next_meta := v_prev_meta
      - 'role'
      - 'roles';
  else
    v_next_meta := jsonb_set(
      jsonb_set(v_prev_meta, '{roles}', to_jsonb(p_roles), true),
      '{role}', to_jsonb(p_roles[1]), true
    );
  end if;

  update auth.users
     set raw_app_meta_data = v_next_meta
   where id = p_target_user_id;

  insert into public.admin_audit_log (
    admin_user_id, admin_email, action,
    target_user_id, target_email, payload,
    result_status, ip_address, user_agent
  ) values (
    p_admin_user_id, p_admin_email, v_action,
    p_target_user_id, p_target_email,
    jsonb_build_object(
      'previousRoles', v_prev_meta -> 'roles',
      'previousRole',  v_prev_meta -> 'role',
      'nextRoles',     coalesce(to_jsonb(p_roles), 'null'::jsonb),
      'note',          coalesce(p_note, '')
    ),
    'success', p_ip, p_user_agent
  ) returning id into v_audit_id;
  return v_audit_id;
end;
$$;

comment on function public.admin_promote_user(uuid,text,uuid,text,text[],text,inet,text) is
  'Service-role-only: set app_metadata.role/roles on a target user and audit-log the change. Pass empty roles array (or null) to demote.';

-- -----------------------------------------------------------------------------
-- admin_log_action — generic audit log writer for non-promote actions
-- (resolve_incident, ack_incident, refresh_mvs, etc.). Same privacy guard
-- applies via the table-level check constraint.
-- -----------------------------------------------------------------------------
create or replace function public.admin_log_action(
  p_admin_user_id  uuid,
  p_admin_email    text,
  p_action         text,
  p_target_user_id uuid default null,
  p_target_email   text default null,
  p_payload        jsonb default '{}'::jsonb,
  p_result_status  text default 'success',
  p_error_message  text default null,
  p_ip             inet default null,
  p_user_agent     text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.admin_audit_log (
    admin_user_id, admin_email, action,
    target_user_id, target_email, payload,
    result_status, error_message, ip_address, user_agent
  ) values (
    p_admin_user_id, p_admin_email, p_action,
    p_target_user_id, p_target_email, coalesce(p_payload, '{}'::jsonb),
    coalesce(p_result_status, 'success'), p_error_message, p_ip, p_user_agent
  ) returning id into v_id;
  return v_id;
end;
$$;

comment on function public.admin_log_action(uuid,text,text,uuid,text,jsonb,text,text,inet,text) is
  'Generic admin audit log writer. Service-role-only.';
