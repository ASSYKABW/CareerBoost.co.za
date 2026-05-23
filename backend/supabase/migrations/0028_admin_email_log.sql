-- Week 2 #1 — admin_email_log: per-message tracking for transactional
-- sends triggered from the admin console (replaces the old mailto:
-- intent-only model).
--
-- Why: the previous flow opened a mailto: link in the operator's mail
-- client + wrote a "subject + bodyLength + intent=true" row to
-- admin_audit_log. Two problems:
--   1. No proof the email was actually sent / delivered.
--   2. Mail client must be configured (broken on most modern OSes
--      where users don't have a desktop mail app).
--
-- New flow: admin-send-email Edge Function hits Resend's REST API,
-- gets back a message id, persists a row here. A Resend webhook
-- updates the status as the email moves through their pipeline
-- (sent → delivered / bounced / complained / opened).
--
-- Privacy: we DO NOT store the email body. Subject is stored because
-- operators need to look up "did we send the password-reset reminder
-- yet?". Bodies stay in Resend's logs only — accessible via their
-- dashboard if needed for support.

create table if not exists public.admin_email_log (
  id                     uuid primary key default gen_random_uuid(),
  -- Who sent it.
  operator_id            uuid not null references auth.users(id) on delete restrict,
  operator_email         text not null,
  -- Recipient — user_id is set when the email targets a known account.
  -- For one-off sends to free-form addresses (e.g. partner outreach)
  -- it can be NULL.
  recipient_user_id      uuid references auth.users(id) on delete set null,
  recipient_email        text not null,
  -- What was sent (subject only — body content is in Resend's logs).
  subject                text not null,
  body_chars             int not null,
  -- Resend's id for this message. NULL while the send is in flight or
  -- if the API call failed before returning an id.
  resend_message_id      text,
  -- Lifecycle: queued → sent → delivered (final) | bounced (final)
  --                                                | complained | opened
  --                                                | failed (final)
  -- 'failed' means our API call to Resend errored OR Resend reported
  -- a hard bounce. Both end the lifecycle from our perspective.
  status                 text not null default 'queued'
    check (status in ('queued','sent','delivered','bounced','complained','opened','failed')),
  -- Free-text error from Resend or our network layer if status='failed'.
  error_message          text,
  -- Batch id ties together rows from the same bulk-send invocation
  -- (e.g. one operator emails 25 users in one click → 25 rows, same
  -- batch_id). Helps the admin UI show "this batch: 23 delivered, 2 bounced".
  bulk_batch_id          uuid,
  -- Timestamps for each lifecycle transition.
  created_at             timestamptz not null default now(),
  sent_at                timestamptz,
  delivered_at           timestamptz,
  bounced_at             timestamptz,
  complained_at          timestamptz,
  opened_at              timestamptz,
  failed_at              timestamptz,
  updated_at             timestamptz not null default now()
);

create index if not exists admin_email_log_operator_idx
  on public.admin_email_log (operator_id, created_at desc);
create index if not exists admin_email_log_recipient_idx
  on public.admin_email_log (recipient_user_id, created_at desc)
  where recipient_user_id is not null;
create index if not exists admin_email_log_batch_idx
  on public.admin_email_log (bulk_batch_id)
  where bulk_batch_id is not null;
-- Webhook lookups: Resend sends events keyed on message id; we look
-- up the row by that id and update status.
create index if not exists admin_email_log_resend_id_idx
  on public.admin_email_log (resend_message_id)
  where resend_message_id is not null;
-- For the admin UI "recent emails" view sorted by latest first.
create index if not exists admin_email_log_created_at_idx
  on public.admin_email_log (created_at desc);

comment on table public.admin_email_log is
  'Per-message log for transactional emails sent from the admin console via Resend. Status updated by admin-resend-webhook as events arrive. Body content is NOT stored — only subject + char count. See docs/RESEND-SETUP.md for the operator setup.';

-- RLS: only service_role can read/write. Operators see the data via
-- the admin console (which queries through service-role functions).
alter table public.admin_email_log enable row level security;
alter table public.admin_email_log force row level security;
revoke all on public.admin_email_log from public, anon, authenticated;
grant all on public.admin_email_log to service_role;

-- updated_at auto-bump trigger.
create or replace function public.tg_admin_email_log_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists admin_email_log_set_updated_at on public.admin_email_log;
create trigger admin_email_log_set_updated_at
  before update on public.admin_email_log
  for each row execute function public.tg_admin_email_log_set_updated_at();
