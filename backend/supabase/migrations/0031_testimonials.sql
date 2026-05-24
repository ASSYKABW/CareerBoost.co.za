-- 0031_testimonials.sql: Testimonials table for social proof on the landing page.
--
-- Workflow:
--   1. User submits via public /testimonial.html form (edge fn: testimonial-submit).
--   2. Operator reviews in Admin → Testimonials, edits as needed, approves/rejects
--      (edge fn: admin-testimonials).
--   3. Landing page fetches approved rows from testimonials-public edge fn — dynamic,
--      no code deploy required to publish a new testimonial.
--
-- RLS: service role only. All client access goes through edge functions; the anon
-- key cannot read or write this table directly.

create table if not exists testimonials (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  role          text not null default '',
  company       text not null default '',
  quote         text not null,
  avatar_url    text,
  rating        smallint check (rating >= 1 and rating <= 5),
  email         text,         -- not displayed publicly; kept for consent follow-up
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  sort_order    integer not null default 0,
  admin_note    text,         -- operator notes, never shown to submitter
  submitted_at  timestamptz not null default now(),
  approved_at   timestamptz
);

comment on table testimonials is 'User-submitted social proof quotes. Approved rows appear on the landing page.';
comment on column testimonials.email is 'Optional — not displayed publicly. Used only for follow-up consent.';

alter table testimonials enable row level security;
-- No policies: zero public access. Edge functions use service_role key.

-- Index to speed up the public read (approved, sort_order ASC).
create index if not exists testimonials_public_idx
  on testimonials (status, sort_order, approved_at)
  where status = 'approved';
