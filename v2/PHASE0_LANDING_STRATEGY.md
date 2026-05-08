# CareerBoost Landing Page - Phase 0 Strategy

This document locks the pre-design decisions for the landing page so all next phases build toward a single conversion goal.

## 1) Primary Goal

Convert first-time visitors into account signups for the free plan.

- Primary conversion: click `Start Free` and complete signup
- Secondary conversion: click `Sign in` (returning users)
- Success principle: every section must reduce friction to signup

## 2) Ideal Customer Profile (ICP)

Primary user segment for v1 landing:

- Individual job seekers (0-8 years experience)
- Applying to knowledge-work roles (software, product, design, operations, marketing, analytics)
- Overwhelmed by resume tailoring, scattered job tracking, and interview preparation
- Motivated by speed, structure, and confidence

Out of scope for v1 landing messaging:

- Team recruiting workflows
- Agency/reseller use cases
- Enterprise procurement messaging

## 3) Positioning

Category:

- AI-powered job-search command center

Core promise:

- Land better roles faster with a structured, reliable pipeline from discovery to outcome.

Differentiators to repeat across page:

- Workflow system, not a one-off AI tool
- Human-in-control decisions at every step
- Explainable recommendations (not black-box automation)
- Data ownership and privacy controls

## 4) Messaging Stack

Hero message:

- Headline: `Your AI command center for a smarter job search.`
- Subheadline: `Tailor resumes, generate stronger cover letters, track applications, and prep interviews in one focused workflow.`

Primary CTA:

- Label: `Start Free`
- Destination: `#/auth?mode=signup`

Secondary CTA:

- Label: `Sign In`
- Destination: `#/auth`

Proof statements allowed:

- Workflow reliability and stage visibility
- Privacy and user control language already reflected by the product

Proof statements blocked until measured:

- Hard percentage claims (for example, "10x faster") unless backed by production analytics

## 5) Information Architecture (Section Order)

Locked section order for implementation:

1. Sticky navigation
2. Hero
3. Trust strip
4. Problem -> solution
5. Feature grid
6. How it works (3 steps)
7. Product showcase
8. Testimonials
9. Pricing teaser
10. FAQ
11. Final CTA
12. Footer

Rule:

- No extra sections unless they clearly increase conversion confidence.

## 6) Analytics Event Taxonomy (Landing)

Track these events from first release:

- `landing_view` - fired once when welcome route renders
- `landing_nav_cta_click` - top nav primary CTA
- `landing_hero_primary_click` - hero `Start Free`
- `landing_hero_secondary_click` - hero secondary action
- `landing_section_view` - each major section entering viewport (one event per section)
- `landing_pricing_click` - click on pricing CTA
- `landing_footer_cta_click` - final CTA click
- `signup_start` - user enters signup mode
- `signup_complete` - successful account creation

Required event properties:

- `route` (for example `welcome`)
- `section` (when relevant)
- `cta_label`
- `placement` (nav, hero, pricing, footer)
- `timestamp` (ISO string)

## 7) Visual Quality Guardrails

- Premium dark theme with clear contrast and enterprise trust feel
- Clean spacing rhythm; avoid dense text blocks
- One dominant accent for all primary CTAs
- Product UI visuals over generic stock imagery
- Mobile-first readability and tap targets

## 8) Exit Criteria (Phase 0 Done)

Phase 0 is complete when:

- ICP is fixed (single primary segment)
- Positioning and hero message are approved
- Primary and secondary CTAs are fixed
- Section order is locked
- Analytics event list is defined
- Team agrees that future design/development should not change strategy without explicit review

## 9) Handoff to Phase 1

Phase 1 (Wireframe + IA) uses this document as source of truth.

During wireframing:

- Map one conversion purpose to each section
- Keep copy concise and scanable
- Preserve CTA consistency (`Start Free` as primary action)
