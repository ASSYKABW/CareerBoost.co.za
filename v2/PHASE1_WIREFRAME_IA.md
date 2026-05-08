# CareerBoost Landing Page - Phase 1 Wireframe + IA

This Phase 1 document translates the Phase 0 strategy into a concrete page structure before visual styling (Phase 2).

Reference: `v2/PHASE0_LANDING_STRATEGY.md`

## 1) Wireframe Objective

Create a low-fidelity page structure where each section has one clear conversion job:

- Build trust
- Explain value
- Reduce risk
- Drive `Start Free`

## 2) Page Blueprint (Desktop First)

Use this section order without reordering.

### A. Sticky Navigation

Purpose:

- Orientation + fast path to conversion

Structure:

- Left: brand mark + `CareerBoost`
- Right links: `Features`, `How it works`, `Pricing`, `FAQ`
- Utility action: `Sign In`
- Primary CTA: `Start Free`

Wireframe notes:

- Sticky on scroll
- Keep height compact
- CTA always visible

---

### B. Hero (Above the Fold)

Purpose:

- State promise in 3-5 seconds and trigger primary CTA

Structure:

- Left column:
  - Eyebrow label (`AI-powered job command center`)
  - H1 headline
  - 1-2 line subheadline
  - CTA row: `Start Free` + secondary (`Watch Demo` or `Sign In`)
  - Trust bullets (3 short points)
- Right column:
  - Product mock frame (dashboard-style)
  - 2-3 floating proof chips (match score, applications, interview prep)

Wireframe notes:

- Keep copy concise; avoid paragraph blocks
- Ensure primary CTA appears without scrolling

---

### C. Trust Strip

Purpose:

- Early credibility signal

Structure:

- Optional heading: `Trusted by job seekers targeting top teams`
- Logo row or placeholder badges
- Optional mini stats (max 3)

Wireframe notes:

- Lightweight section height
- No heavy copy

---

### D. Problem -> Solution Band

Purpose:

- Show user pain and direct resolution by product

Structure:

- Left: 3 problem bullets (current chaos)
- Right: matching 3 solution bullets (CareerBoost workflow)

Wireframe notes:

- One problem mapped to one solution
- Keep symmetrical visual rhythm

---

### E. Core Features Grid

Purpose:

- Explain breadth without overwhelming

Structure:

- Section title + supporting sentence
- 6 feature cards (3x2 desktop):
  - AI Resume Lab
  - Smart Job Search
  - Cover Letter Studio
  - Interview Coach
  - Application Pipeline
  - Privacy & Control

Per-card format:

- Icon
- Feature name
- One-line benefit
- Optional proof micro-line

---

### F. How It Works (3 Steps)

Purpose:

- Reduce perceived effort

Structure:

- Step 1: Create account
- Step 2: Add resume + role target
- Step 3: Execute guided pipeline

Wireframe notes:

- Visual step progression
- Single CTA below steps: `Create Your Free Account`

---

### G. Product Showcase

Purpose:

- Make product feel real and polished

Structure:

- Large screenshot/demo frame
- 3 callouts anchored to key UI zones:
  - Match scoring
  - Resume tailoring action
  - Pipeline stage visibility

Wireframe notes:

- Keep one hero visual; avoid gallery overload

---

### H. Testimonials

Purpose:

- Social proof and emotional confidence

Structure:

- 3 testimonial cards
- Each: short quote, name, role, optional result

Wireframe notes:

- Realistic tone, not hype language

---

### I. Pricing Teaser

Purpose:

- Remove pricing uncertainty

Structure:

- Two plans max:
  - Free
  - Pro
- Short value bullets under each
- CTA: `Start Free`

Wireframe notes:

- Keep comparison simple; avoid enterprise complexity

---

### J. FAQ

Purpose:

- Remove objections before final CTA

Structure:

- 5-7 accordion items
- Recommended topics:
  - Is there a free plan?
  - Is my data private?
  - Can I export my data?
  - Do you support ATS-friendly resumes?
  - Can I cancel anytime?

---

### K. Final CTA Band

Purpose:

- Last conversion push after objections resolved

Structure:

- Short headline
- One-line reassurance
- Primary button `Start Free`

---

### L. Footer

Purpose:

- Utility + legitimacy

Structure:

- Brand + short descriptor
- Links: Features, Pricing, Privacy, Terms, Contact
- Copyright line

## 3) Mobile Wireframe Rules

Critical responsive behavior:

- Collapse nav links into menu; keep `Start Free` visible
- Hero converts from 2 columns to single stack (copy then visual)
- Feature grid becomes 1 column
- Steps become vertical timeline
- Pricing cards stack vertically
- Reduce decorative elements; preserve readable spacing

Minimum mobile goals:

- Primary CTA visible within first viewport
- No horizontal scrolling
- Tap targets remain comfortable

## 4) Content Constraints (Phase 1)

- One clear message per section
- No section intro paragraph over 2 lines
- Avoid unsupported performance claims
- Use plain language over buzzwords
- Keep CTA labels consistent across page

## 5) Routing + Build Mapping (Current Codebase)

Current landing route:

- `v2/src/js/marketing/welcome.route.js`

Likely style surfaces:

- `v2/src/styles/layout.css`
- `v2/src/styles/modules.css`
- `v2/src/styles/phase1.css`

Implementation note:

- Build sections in `welcome.route.js` first (content structure), then style progressively in CSS files.

## 6) Phase 1 Acceptance Checklist

Phase 1 is complete when:

- [ ] All 12 sections exist in correct order
- [ ] Each section has a documented conversion purpose
- [ ] Desktop and mobile wireframe behavior is defined
- [ ] CTA placements are fixed (nav, hero, mid-page, final)
- [ ] Objection-handling sections (pricing + FAQ) are included
- [ ] No visual polish work has started yet (reserved for Phase 2)

## 7) Ready for Phase 2 Inputs

Before Phase 2 begins, approve:

- Hero headline/subheadline draft
- Section headings
- CTA microcopy (`Start Free` phrasing final)
- Initial testimonial placeholders
