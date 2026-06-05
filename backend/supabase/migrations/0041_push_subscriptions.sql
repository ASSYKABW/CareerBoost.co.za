-- 0041_push_subscriptions.sql: PWA Web Push — subscription storage.
--
-- One row per browser/device subscription. The browser-level notification
-- permission grant IS the consent (explicit, user-initiated). A user can hold
-- several subscriptions (phone, laptop). The sender (push-send) reads these,
-- pushes via the Web Push protocol, and prunes rows that return 404/410 (the
-- subscription expired / was revoked).
--
--   endpoint     — the push service URL (unique; identifies the subscription).
--   p256dh, auth — the subscription's encryption keys (needed to encrypt the
--                  payload per RFC 8291).
--
-- RLS on, no policies (edge-function/service_role only). Reuses the kill-switch
-- pattern: push sends also honor brand_settings.push_paused (added later).

create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  failure_count   int not null default 0,
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now()
);

comment on table public.push_subscriptions is 'PWA Web Push subscriptions (one per device). Browser permission grant = consent. Sender prunes on 404/410.';

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
-- No policies: edge-function-only access.
