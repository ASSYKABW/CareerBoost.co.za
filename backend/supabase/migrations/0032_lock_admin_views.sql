-- 0032: Lock down admin views + plan_catalog flagged by the Supabase linter.
--
-- THREE CRITICAL FINDINGS FROM THE DATABASE LINTER:
--   1. "Exposed Auth Users"    → public.v_admin_user_segments selects auth.users.email
--   2. "Security Definer View" → the v_admin_* views run with the view OWNER's
--                                rights (the Postgres default), bypassing RLS
--   3. "RLS Disabled in Public"→ public.plan_catalog has no row-level security
--
-- ROOT CAUSE for (1) + (2):
--   Supabase's default privileges auto-GRANT SELECT to `anon` + `authenticated`
--   on anything created in the public schema. Migration 0010 correctly REVOKEd
--   that for the admin *materialized* views, but the plain views added later
--   (0012 / 0013 / 0014 / 0015) only ran `grant select ... to service_role` and
--   never revoked the inherited anon/authenticated grant. A GRANT is additive —
--   it does not remove the default. So PostgREST has been auto-publishing these
--   views: anyone holding the public anon key could read them directly, and
--   v_admin_user_segments leaks user email addresses. This migration closes that.
--
-- THE FIX:
--   • REVOKE all on every v_admin_* view from anon, authenticated, and PUBLIC.
--     service_role keeps its grant — it is the only sanctioned reader. The admin
--     Edge Functions read these views with the service-role key AFTER verifying
--     the caller's admin role (see admin-overview/index.ts: getAuthedAdmin gate,
--     then getServiceClient for the actual reads).
--   • Flip the views that read ONLY public-schema tables to security_invoker=on.
--     This clears the "Security Definer View" lint and makes them honour RLS.
--   • v_admin_user_segments stays definer-style ON PURPOSE: it reads auth.users,
--     and service_role has no privileges on the auth schema, so an invoker-rights
--     view would FAIL when the admin board reads it. The REVOKE above fully closes
--     the real exposure; the residual "Security Definer View" lint on this one
--     view is expected and harmless (only service_role can ever invoke it).
--   • Enable RLS on plan_catalog with a permissive public-read policy. Pricing is
--     meant to be public (the landing page renders it without auth), so we keep
--     SELECT for anon/authenticated; RLS-on just makes the posture explicit, blocks
--     any accidental write path, and clears the lint.
--
-- WHY NOTHING BREAKS:
--   - Admin dashboard reads every view via service_role (bypasses RLS, keeps grant).
--   - Landing pricing reads plan_catalog as anon (SELECT grant + using(true) kept).
--   - get_user_entitlements / consume_quota are SECURITY DEFINER (bypass RLS).
--   - This migration is idempotent and safe to re-run.

-- ─── 1. Revoke public-API access from every admin view ──────────────────
revoke all on public.v_admin_user_segments       from anon, authenticated;
revoke all on public.v_admin_outcome_rollup       from anon, authenticated;
revoke all on public.v_admin_outcome_by_channel   from anon, authenticated;
revoke all on public.v_admin_acquisition_channels from anon, authenticated;
revoke all on public.v_admin_acquisition_geo      from anon, authenticated;
revoke all on public.v_admin_acquisition_landing  from anon, authenticated;
revoke all on public.v_admin_acquisition_referrers from anon, authenticated;
revoke all on public.v_admin_client_errors_24h    from anon, authenticated;

-- Belt-and-suspenders: ensure the PUBLIC pseudo-role can't reach them either.
revoke all on public.v_admin_user_segments        from public;
revoke all on public.v_admin_outcome_rollup        from public;
revoke all on public.v_admin_outcome_by_channel    from public;
revoke all on public.v_admin_acquisition_channels  from public;
revoke all on public.v_admin_acquisition_geo       from public;
revoke all on public.v_admin_acquisition_landing   from public;
revoke all on public.v_admin_acquisition_referrers from public;
revoke all on public.v_admin_client_errors_24h     from public;

-- Re-assert the only sanctioned reader (idempotent; no-op if already granted).
grant select on public.v_admin_user_segments        to service_role;
grant select on public.v_admin_outcome_rollup        to service_role;
grant select on public.v_admin_outcome_by_channel    to service_role;
grant select on public.v_admin_acquisition_channels  to service_role;
grant select on public.v_admin_acquisition_geo       to service_role;
grant select on public.v_admin_acquisition_landing   to service_role;
grant select on public.v_admin_acquisition_referrers to service_role;
grant select on public.v_admin_client_errors_24h     to service_role;

-- ─── 2. Make the public-schema-only views run with INVOKER rights ───────
-- Clears the "Security Definer View" lint. Safe: service_role (the sole reader
-- after the revoke) can read these public tables and carries BYPASSRLS, so the
-- aggregates still return all rows exactly as before.
alter view public.v_admin_outcome_rollup        set (security_invoker = on);
alter view public.v_admin_outcome_by_channel     set (security_invoker = on);
alter view public.v_admin_acquisition_channels   set (security_invoker = on);
alter view public.v_admin_acquisition_geo        set (security_invoker = on);
alter view public.v_admin_acquisition_landing    set (security_invoker = on);
alter view public.v_admin_acquisition_referrers  set (security_invoker = on);
alter view public.v_admin_client_errors_24h      set (security_invoker = on);

-- v_admin_user_segments is intentionally NOT flipped — see header. It reads
-- auth.users, which service_role cannot read under invoker rights.

-- ─── 3. Enable RLS on the public pricing table ──────────────────────────
alter table public.plan_catalog enable row level security;

drop policy if exists "plan_catalog_public_read" on public.plan_catalog;
create policy "plan_catalog_public_read"
  on public.plan_catalog
  for select
  to anon, authenticated
  using (true);

-- Writes stay blocked: no insert/update/delete grant exists for anon/authenticated,
-- and RLS has no write policy. Seeding/repricing runs via migrations (postgres) and
-- the billing RPCs / webhooks use service_role, both of which bypass RLS.

-- ─── Documentation ──────────────────────────────────────────────────────
comment on view public.v_admin_user_segments is
  '0032: SELECT revoked from anon/authenticated — service_role only. Deliberately kept SECURITY DEFINER because it reads auth.users and service_role lacks auth-schema rights; the residual "Security Definer View" linter warning on this view is expected and safe.';
