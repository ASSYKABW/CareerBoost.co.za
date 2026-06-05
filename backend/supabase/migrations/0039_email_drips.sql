-- 0039_email_drips.sql: Lifecycle email — per-user drip sequence progress.
--
-- email_drip_state tracks where each user is in each sequence so every step is
-- sent exactly once and we know when the next step is due. The sender
-- (email-drip fn) reads/advances this; it only ever sends to users who are
-- currently consented (profiles.marketing_consent) AND not suppressed.
--
--   step_index  — next step to send (0-based). Advances on each successful send.
--   anchor_at   — the timing origin for day-offsets: signup_at for onboarding/
--                 education sequences, or detection time for re-engagement.
--   status      — enrolled (in progress) | completed | stopped.
--
-- RLS on, no policies (edge-function/service_role only).

create table if not exists public.email_drip_state (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  sequence_key  text not null,
  step_index    int not null default 0,
  anchor_at     timestamptz not null,
  status        text not null default 'enrolled' check (status in ('enrolled', 'completed', 'stopped')),
  last_sent_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, sequence_key)
);

comment on table public.email_drip_state is 'Per-user lifecycle-email sequence progress. Sender advances step_index on each send; only sends to consented + non-suppressed users.';

create index if not exists email_drip_state_seq_status_idx on public.email_drip_state (sequence_key, status);

alter table public.email_drip_state enable row level security;
-- No policies: edge-function-only access.

-- ── let the automated sender log into admin_email_log ────────────────────
-- The drip/newsletter sender has no human operator. Relax operator_id and add
-- a few columns so automated sends are logged in the SAME place as operator
-- sends — which means the Resend webhook (keyed on resend_message_id) tracks
-- delivery/bounce/open for drips too, and bounces/complaints auto-suppress.
alter table public.admin_email_log alter column operator_id drop not null;
alter table public.admin_email_log add column if not exists send_type text not null default 'operator';
  -- 'operator' | 'drip' | 'newsletter'
alter table public.admin_email_log add column if not exists sequence_key text;
alter table public.admin_email_log add column if not exists campaign text;

comment on column public.admin_email_log.send_type is 'operator (manual admin send) | drip (lifecycle sequence) | newsletter (broadcast).';

create index if not exists admin_email_log_sendtype_idx on public.admin_email_log (send_type, created_at desc);
create index if not exists admin_email_log_batch_idx on public.admin_email_log (bulk_batch_id);
