-- =============================================================================
-- Console Phase B: social_drafts — the Marketing Copilot approval queue.
-- =============================================================================
-- The marketing agent (agent-run, agent='marketing') writes platform-native
-- content proposals here with status='draft'. NOTHING publishes itself:
-- the operator reviews in the Console Growth section, then approves, copies
-- the text (copy-paste v1 publishing) and marks it posted. Every draft
-- carries a UTM-tagged link so posted content attributes back through
-- signup-attribution → the Growth channels rollup (the learning loop).
--
-- Service-role only (RLS on, no policies) — same pattern as marketing tables.
-- =============================================================================

create table if not exists public.social_drafts (
  id           uuid primary key default gen_random_uuid(),
  platform     text not null check (platform in ('linkedin', 'facebook', 'tiktok', 'x', 'instagram')),
  status       text not null default 'draft'
               check (status in ('draft', 'approved', 'posted', 'rejected')),
  hook         text,                                   -- headline / first line / TikTok hook
  body         text not null,                          -- full post text or video script
  hashtags     text,                                   -- space-separated, e.g. '#JobSearchZA #CV'
  link         text,                                   -- UTM-tagged URL for attribution
  rationale    text,                                   -- agent's data-grounded "why this post"
  agent_run_id uuid references public.agent_runs (id) on delete set null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  posted_at    timestamptz
);

comment on table public.social_drafts is
  'Marketing Copilot content proposals. draft → approved → posted (operator copy-pastes to the platform; UTM link closes the attribution loop) or rejected.';

create index if not exists social_drafts_status_created_idx
  on public.social_drafts (status, created_at desc);

alter table public.social_drafts enable row level security;
-- No policies: service-role only.
