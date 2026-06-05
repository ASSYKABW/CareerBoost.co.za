-- 0038_email_consent.sql: Lifecycle email — POPIA consent + suppression.
--
-- The marketing engine may only send lifecycle drips to users who have given
-- explicit, informed, voluntary opt-in (POPIA direct-marketing rules). This
-- migration adds:
--   • profiles consent columns  — current state, for fast sender filtering.
--   • email_consent_events       — append-only audit trail (the PROOF of
--                                  consent: who, when, action, source, version).
--   • email_suppressions         — the hard "never send" list (unsubscribe,
--                                  bounce, complaint). The sender excludes these.
--
-- Unsubscribe uses a per-user random token (profiles.email_unsub_token) carried
-- in the link — no shared signing secret to manage. Transactional mail (auth,
-- receipts) is exempt from all of this; only marketing drips consult consent.
--
-- All writes go through edge functions (service_role); the client never writes
-- consent directly. RLS stays as-is on profiles; the new tables get RLS on with
-- no policies (edge-function-only access).

-- ── profiles: current consent state ──────────────────────────────────────
alter table public.profiles add column if not exists marketing_consent boolean not null default false;
alter table public.profiles add column if not exists marketing_consent_at timestamptz;
alter table public.profiles add column if not exists marketing_consent_source text;   -- 'signup' | 'settings' | 'import'
alter table public.profiles add column if not exists marketing_consent_version text;   -- privacy-policy version they agreed to
alter table public.profiles add column if not exists email_unsub_token text;           -- random token for one-click unsubscribe links

comment on column public.profiles.marketing_consent is 'Current marketing-email opt-in state. Sender requires true AND no suppression.';
comment on column public.profiles.email_unsub_token is 'Random per-user token embedded in unsubscribe links (no shared signing secret).';

-- Fast lookup for the sender: who is currently consented.
create index if not exists profiles_marketing_consent_idx
  on public.profiles (marketing_consent) where marketing_consent = true;

-- ── append-only consent audit trail (POPIA proof) ────────────────────────
create table if not exists public.email_consent_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  action      text not null check (action in ('opt_in', 'opt_out')),
  source      text,            -- 'signup' | 'settings' | 'unsubscribe_link' | 'bounce' | 'complaint' | 'admin'
  policy_version text,
  ip          text,
  user_agent  text,
  at          timestamptz not null default now()
);

comment on table public.email_consent_events is 'Append-only audit of every marketing-consent change. The legal proof of consent/withdrawal under POPIA.';

create index if not exists email_consent_events_user_idx on public.email_consent_events (user_id, at desc);

alter table public.email_consent_events enable row level security;
-- No policies: written by edge functions (service_role) only.

-- ── suppression list (hard never-send) ───────────────────────────────────
create table if not exists public.email_suppressions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete cascade,
  email       text not null,
  reason      text not null check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual')),
  detail      text,
  at          timestamptz not null default now(),
  unique (email)
);

comment on table public.email_suppressions is 'Addresses that must never receive marketing email (unsubscribe/bounce/complaint). Sender LEFT JOINs and excludes.';

create index if not exists email_suppressions_user_idx on public.email_suppressions (user_id);

alter table public.email_suppressions enable row level security;
-- No policies: edge-function-only.
