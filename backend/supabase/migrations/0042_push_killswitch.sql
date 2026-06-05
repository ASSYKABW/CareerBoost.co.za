-- 0042_push_killswitch.sql: PWA Web Push — operator kill-switch.
--
-- Mirrors brand_settings.drips_paused. When true, push-send no-ops even if the
-- VAPID secrets are configured — the everyday operator control to stop pushes.

alter table public.brand_settings add column if not exists push_paused boolean not null default false;

comment on column public.brand_settings.push_paused is 'Operator kill-switch for PWA push. When true, push-send no-ops even if VAPID keys are set.';
