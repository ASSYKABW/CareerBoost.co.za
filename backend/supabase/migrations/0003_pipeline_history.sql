-- Phase C: pipeline intelligence
-- Adds a per-application stage transition history (jsonb) so the UI can
-- render a timeline of when the application moved between stages, and an
-- optional `application_id` on events so calendar entries can be attributed
-- to a specific opportunity.

alter table public.applications
  add column if not exists stage_history jsonb not null default '[]'::jsonb;

alter table public.events
  add column if not exists application_id uuid references public.applications(id) on delete set null;

create index if not exists events_application_id_idx on public.events (application_id);
