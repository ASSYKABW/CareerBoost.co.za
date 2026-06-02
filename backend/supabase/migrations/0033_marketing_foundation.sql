-- 0033_marketing_foundation.sql: Marketing & Brand Engine — Phase 0 data layer.
--
-- Two tables that everything else in the marketing engine hangs off:
--   brand_settings  — singleton brand config (logo/voice/colors) that drives both
--                     the public site and AI content generation.
--   content_pieces  — drafts → review → scheduled → published content (blog, social,
--                     newsletter, announcements, …).
--
-- RLS: enabled with NO policies (same model as `testimonials`). Zero direct anon
-- access. All reads/writes go through edge functions using the service_role key:
--   - admin-brand / admin-content : operator-only mutations (role + MFA gated).
--   - content-public              : public read of the *published* brand + content.

-- ── brand_settings ─────────────────────────────────────────────────────────
-- Singleton: exactly one row, id = 'default'. The check + seed keep it a single
-- source of truth that admin-brand updates in place.
create table if not exists brand_settings (
  id              text primary key default 'default',
  wordmark        text not null default 'CareerBoost',
  tagline         text not null default 'BUILT FOR AMBITION',
  primary_color   text not null default '#7cf0ff',
  accent_color    text not null default '#a888ff',
  logo_variant    text not null default 'full'
                  check (logo_variant in ('mark', 'wordmark', 'full')),
  -- Voice/tone profile injected into every AI content generation (Phase 1+):
  --   { "tone": string, "do": string[], "dont": string[], "readingLevel": string }
  voice_tone      jsonb not null default '{}'::jsonb,
  og_image_url    text,
  updated_by      uuid,                          -- operator user id (auth.users.id)
  updated_at      timestamptz not null default now(),
  constraint brand_settings_singleton check (id = 'default')
);

comment on table brand_settings is 'Singleton brand config (logo/voice/colors). Drives the public site + AI content generation. Edited via admin-brand; read publicly via content-public.';
comment on column brand_settings.voice_tone is 'Brand voice profile injected into AI content prompts: { tone, do[], dont[], readingLevel }.';

alter table brand_settings enable row level security;
-- No policies: zero direct client access. Edge functions use service_role.

-- Seed the singleton row so admin-brand always has a row to update and
-- content-public always has a brand to return.
insert into brand_settings (id) values ('default')
  on conflict (id) do nothing;

-- ── content_pieces ─────────────────────────────────────────────────────────
create table if not exists content_pieces (
  id              uuid primary key default gen_random_uuid(),
  type            text not null default 'blog'
                  check (type in (
                    'blog', 'social_linkedin', 'social_x', 'social_ig',
                    'newsletter', 'announcement', 'push', 'landing_variant'
                  )),
  title           text not null default '',
  slug            text unique,                   -- null until a blog post is given one
  body            text not null default '',
  excerpt         text not null default '',
  status          text not null default 'draft'
                  check (status in (
                    'draft', 'needs_review', 'approved', 'scheduled',
                    'published', 'archived'
                  )),
  channel         text,
  scheduled_at    timestamptz,
  published_at    timestamptz,
  og_image_url    text,
  source_data     jsonb not null default '{}'::jsonb,   -- first-party data injected at gen time
  prompt_version  text,                                 -- which AI prompt produced it (Phase 1+)
  created_by      text not null default 'operator'
                  check (created_by in ('operator', 'ai')),
  reviewed_by     uuid,                                 -- operator who approved (auth.users.id)
  seo             jsonb not null default '{}'::jsonb,   -- { metaTitle, metaDescription, keywords[] }
  parent_id       uuid references content_pieces (id) on delete set null,  -- repurpose lineage
  metrics         jsonb not null default '{}'::jsonb,   -- denormalized rollup (views/clicks/signups)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table content_pieces is 'Marketing content lifecycle: draft -> needs_review -> approved -> scheduled -> published. Edited via admin-content; published rows served via content-public.';

alter table content_pieces enable row level security;
-- No policies: zero direct client access. Edge functions use service_role.

-- Admin queue: list by status/type, soonest scheduled first.
create index if not exists content_pieces_status_idx
  on content_pieces (status, type, scheduled_at);

-- Public read: published items, newest first.
create index if not exists content_pieces_published_idx
  on content_pieces (published_at desc)
  where status = 'published';
