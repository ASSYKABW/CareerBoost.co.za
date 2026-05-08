-- =============================================================================
-- CareerBoost — initial schema
-- =============================================================================
-- Strategy:
--   * Every user-owned row carries `user_id uuid not null` referencing auth.users.
--   * Row-Level Security is ON for every table, default deny.
--   * Policies allow a user to CRUD only their own rows (user_id = auth.uid()).
--   * A `profiles` row is auto-created by trigger on signup.
-- =============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- profiles — extended user info + preferences
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  full_name      text,
  headline       text,
  avatar_url     text,
  locale         text default 'en',
  onboarding_completed boolean not null default false,
  preferences    jsonb not null default '{}'::jsonb,
  plan           text not null default 'free' check (plan in ('free','pro','team')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.profiles is 'Extended profile information per user.';

-- -----------------------------------------------------------------------------
-- applications — pipeline rows
-- -----------------------------------------------------------------------------
create table if not exists public.applications (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  company        text not null,
  role           text not null,
  stage          text not null default 'saved' check (stage in ('saved','applied','interview','offer','rejected','withdrawn')),
  priority       text not null default 'medium' check (priority in ('low','medium','high')),
  applied_at     date,
  next_action    text,
  notes          text,
  source_url     text,
  location       text,
  salary         text,
  remote         boolean not null default false,
  tags           text[] not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists applications_user_stage_idx on public.applications(user_id, stage);
create index if not exists applications_user_updated_idx on public.applications(user_id, updated_at desc);

-- -----------------------------------------------------------------------------
-- events — calendar / follow-ups / deadlines
-- -----------------------------------------------------------------------------
create table if not exists public.events (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  event_date     date not null,
  title          text not null,
  type           text not null default 'followup' check (type in ('interview','followup','deadline','reminder','other')),
  notes          text,
  completed      boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists events_user_date_idx on public.events(user_id, event_date);

-- -----------------------------------------------------------------------------
-- resumes — one base resume + arbitrary tailored variants (stored in jsonb)
-- -----------------------------------------------------------------------------
create table if not exists public.resumes (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  base_text      text not null default '',
  tailored       jsonb,
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- cover_letters — latest generated result per user
-- -----------------------------------------------------------------------------
create table if not exists public.cover_letters (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  last_result    jsonb,
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- interview_sets — latest coaching set per user
-- -----------------------------------------------------------------------------
create table if not exists public.interview_sets (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  last_set       jsonb,
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- saved_jobs — bookmarks from job search
-- -----------------------------------------------------------------------------
create table if not exists public.saved_jobs (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  external_id    text not null,
  source         text not null,
  title          text not null,
  company        text,
  location       text,
  url            text not null,
  remote         boolean not null default false,
  posted_at      timestamptz,
  payload        jsonb not null default '{}'::jsonb,
  saved_at       timestamptz not null default now(),
  unique (user_id, external_id)
);
create index if not exists saved_jobs_user_saved_idx on public.saved_jobs(user_id, saved_at desc);

-- -----------------------------------------------------------------------------
-- saved_searches — persisted job search queries
-- -----------------------------------------------------------------------------
create table if not exists public.saved_searches (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  query          text not null default '',
  filters        jsonb not null default '{}'::jsonb,
  last_run_at    timestamptz,
  last_count     integer,
  last_top_ids   text[] not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists saved_searches_user_idx on public.saved_searches(user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- api_keys — per-user job-board integration keys (encrypted at rest by Supabase)
-- -----------------------------------------------------------------------------
create table if not exists public.api_keys (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  adzuna_app_id  text,
  adzuna_app_key text,
  adzuna_country text default 'gb',
  muse_key       text,
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- ai_usage — AI telemetry, one row per request (for quota + observability)
-- -----------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  request_id     text not null,
  skill          text not null,
  provider       text,
  model          text,
  prompt_version text,
  status         text not null check (status in ('success','failed')),
  latency_ms     integer,
  input_tokens   integer,
  output_tokens  integer,
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists ai_usage_user_created_idx on public.ai_usage(user_id, created_at desc);

-- =============================================================================
-- Generic updated_at trigger
-- =============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','applications','resumes','cover_letters',
    'interview_sets','api_keys'
  ]
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- =============================================================================
-- Auto-create profile on signup
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (user_id) do nothing;

  insert into public.resumes (user_id) values (new.id) on conflict do nothing;
  insert into public.cover_letters (user_id) values (new.id) on conflict do nothing;
  insert into public.interview_sets (user_id) values (new.id) on conflict do nothing;
  insert into public.api_keys (user_id) values (new.id) on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- Row-Level Security
-- =============================================================================
alter table public.profiles        enable row level security;
alter table public.applications    enable row level security;
alter table public.events          enable row level security;
alter table public.resumes         enable row level security;
alter table public.cover_letters   enable row level security;
alter table public.interview_sets  enable row level security;
alter table public.saved_jobs      enable row level security;
alter table public.saved_searches  enable row level security;
alter table public.api_keys        enable row level security;
alter table public.ai_usage        enable row level security;

-- Owner-only policies (SELECT / INSERT / UPDATE / DELETE) for every table
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','applications','events','resumes','cover_letters',
    'interview_sets','saved_jobs','saved_searches','api_keys','ai_usage'
  ]
  loop
    execute format('drop policy if exists "owner_select" on public.%I', t);
    execute format('drop policy if exists "owner_insert" on public.%I', t);
    execute format('drop policy if exists "owner_update" on public.%I', t);
    execute format('drop policy if exists "owner_delete" on public.%I', t);

    execute format(
      'create policy "owner_select" on public.%I
       for select using (user_id = auth.uid())', t);
    execute format(
      'create policy "owner_insert" on public.%I
       for insert with check (user_id = auth.uid())', t);
    execute format(
      'create policy "owner_update" on public.%I
       for update using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format(
      'create policy "owner_delete" on public.%I
       for delete using (user_id = auth.uid())', t);
  end loop;
end $$;
