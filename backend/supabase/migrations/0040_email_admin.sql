-- 0040_email_admin.sql: Lifecycle email — admin dashboard + kill-switch.
--
-- Adds a DB-backed pause flag (so an operator can stop drips from the admin UI
-- without touching function env), and a single overview RPC powering the
-- "Lifecycle email" admin panel.
--
-- The sender (email-drip) requires BOTH gates to send: env EMAIL_DRIPS_ENABLED
-- = true AND brand_settings.drips_paused = false. Env is the hard master
-- switch; this flag is the everyday operator control.

alter table public.brand_settings add column if not exists drips_paused boolean not null default false;

comment on column public.brand_settings.drips_paused is 'Operator kill-switch for lifecycle drips. When true, email-drip no-ops even if EMAIL_DRIPS_ENABLED is set.';

-- Everything the admin Lifecycle panel needs, in one security-definer call.
create or replace function marketing_email_overview()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'consented',    (select count(*) from profiles where marketing_consent = true),
    'total',        (select count(*) from profiles),
    'suppressions', (select count(*) from email_suppressions),
    'paused',       coalesce((select drips_paused from brand_settings where id = 'default'), false),
    'sequences',    (select coalesce(jsonb_agg(s order by s->>'sequence_key'), '[]'::jsonb) from (
                      select jsonb_build_object('sequence_key', sequence_key, 'status', status, 'n', count(*)) as s
                      from email_drip_state group by sequence_key, status
                    ) q),
    'sends',        (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                      select jsonb_build_object('send_type', send_type, 'status', status, 'n', count(*)) as x
                      from admin_email_log group by send_type, status
                    ) q2)
  );
$$;

comment on function marketing_email_overview() is 'One-call overview for the admin Lifecycle email panel: opt-in, suppressions, per-sequence drip_state, sends by type/status, pause flag.';
