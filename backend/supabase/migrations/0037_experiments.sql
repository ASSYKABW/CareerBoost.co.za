-- 0037_experiments.sql: Marketing engine — lightweight A/B testing.
--
-- marketing_experiments holds copy/CTA experiments. Each has an ordered set
-- of variants (jsonb): [{ id, label, weight, text? }]. The client (ab-testing.js)
-- fetches running experiments, sticky-assigns each visitor a variant by weight,
-- optionally swaps copy into a target element, and tracks exposure + conversion
-- through the existing content-track endpoint using a namespaced slug:
--   exp:<key>:<variantId>  with event 'view' (exposure) or 'click' (conversion).
--
-- Results reuse content_events (no new events table). An operator reviews the
-- per-variant view/click split in the admin and declares a winner.
--
-- RLS on, no policies — writes via admin-content (service_role), the active
-- list via content-public (service_role), results via a security-definer RPC.

create table if not exists marketing_experiments (
  key         text primary key,                       -- stable slug, e.g. 'hero-cta'
  name        text not null,
  hypothesis  text,
  status      text not null default 'draft' check (status in ('draft', 'running', 'done')),
  target      text,                                    -- optional CSS selector for no-code copy swaps
  variants    jsonb not null default '[]'::jsonb,      -- [{ id, label, weight, text }]
  winner      text,                                    -- variant id, set when status='done'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table marketing_experiments is 'A/B experiments (copy/CTA). Variants in jsonb; exposure/conversion tracked via content_events slug exp:<key>:<variantId>.';

alter table marketing_experiments enable row level security;
-- No policies: edge fns use service_role.

-- Per-variant results: views (exposures) + clicks (conversions) from
-- content_events, where slug = 'exp:<key>:<variantId>'.
create or replace function marketing_experiment_results(p_key text)
returns table (
  variant text,
  views   bigint,
  clicks  bigint
)
language sql
security definer
set search_path = public
as $$
  select
    split_part(slug, ':', 3)                  as variant,
    count(*) filter (where event = 'view')    as views,
    count(*) filter (where event = 'click')   as clicks
  from content_events
  where slug like 'exp:' || p_key || ':%'
  group by split_part(slug, ':', 3)
  order by split_part(slug, ':', 3);
$$;

comment on function marketing_experiment_results(text) is 'Per-variant exposures/conversions for an experiment, from content_events (slug exp:<key>:<variantId>). Called by admin-content.';
