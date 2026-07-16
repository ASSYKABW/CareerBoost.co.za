-- =============================================================================
-- 0053 — Anonymous website analytics
-- =============================================================================
-- Until now `usage_events.user_id` was NOT NULL, so a page view from a
-- logged-out visitor could not be stored at all. That is the real reason the
-- product only ever saw people from sign-in onward: it was a schema constraint,
-- not a missing feature.
--
-- Relax it so an event is identified by EITHER a user_id (signed in) or an
-- anonymous_id (a visitor), with a guard so a row is never fully unattributed.
--
-- `anonymous_id` already exists on this table, and the client already stamps a
-- persistent localStorage id on EVERY event (and never clears it at signup), so
-- joining a visitor's pre-signup journey to the account they later create needs
-- no extra plumbing — it falls out of a join on anonymous_id.
--
-- Anonymous rows are written ONLY by the service role via the `usage-ingest`
-- edge function (rate-limited + sanitised there). We deliberately do NOT add an
-- anon insert policy: the browser must never write to this table directly.
-- =============================================================================

alter table public.usage_events
  alter column user_id drop not null;

-- A row must carry at least one identity. Prevents fully orphaned analytics.
alter table public.usage_events
  drop constraint if exists usage_events_identity_present;
alter table public.usage_events
  add constraint usage_events_identity_present
  check (user_id is not null or anonymous_id is not null);

-- Visitor-journey lookups: every event for one anonymous visitor, newest first.
-- This is the index behind "what did this person read before they signed up?".
create index if not exists usage_events_anonymous_idx
  on public.usage_events (anonymous_id, occurred_at desc)
  where anonymous_id is not null;

-- Pre-signup traffic scan: anonymous-only rows over time (visitors, sources).
create index if not exists usage_events_anon_only_idx
  on public.usage_events (occurred_at desc)
  where user_id is null;

comment on column public.usage_events.user_id is
  'NULL for anonymous (pre-signup) visitors. Signed-in events carry both user_id and anonymous_id, which is what makes visitor→account stitching a simple join on anonymous_id.';
