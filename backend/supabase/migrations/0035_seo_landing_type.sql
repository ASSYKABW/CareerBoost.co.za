-- 0035_seo_landing_type.sql: Marketing engine — Phase 5 programmatic SEO.
--
-- Programmatic "{role} jobs in {city}" landing pages reuse the existing
-- content_pieces table — they're just a new content type, 'landing_seo'.
-- This keeps the whole pipeline (admin-content CRUD, scorecard, content-public,
-- AI generation) for free. We only widen the type check constraint.
--
-- The inline check from 0033 is auto-named content_pieces_type_check; drop it
-- and re-add with the extra value. Idempotent.

alter table content_pieces drop constraint if exists content_pieces_type_check;

alter table content_pieces add constraint content_pieces_type_check
  check (type in (
    'blog', 'social_linkedin', 'social_x', 'social_ig',
    'newsletter', 'announcement', 'push', 'landing_variant',
    'landing_seo'
  ));
