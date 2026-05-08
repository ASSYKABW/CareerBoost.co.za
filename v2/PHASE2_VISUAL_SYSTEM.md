# CareerBoost Landing Page - Phase 2 Visual System

This phase defines the polished visual language (premium, professional, compelling) before full section build execution.

Reference inputs:

- `v2/PHASE0_LANDING_STRATEGY.md`
- `v2/PHASE1_WIREFRAME_IA.md`
- Current style foundations in `src/styles/tokens.css`, `src/styles/layout.css`, `src/styles/phase1.css`

## 1) Phase 2 Objective

Establish a consistent, high-end visual system so every landing section feels like one product, not separate blocks.

Target outcome:

- Premium dark SaaS look
- Strong readability
- Clear CTA hierarchy
- Controlled motion and depth

## 2) Design Direction (Approved)

Primary style direction:

- Enterprise-trust dark theme with restrained glow accents
- Clean spacing and typography hierarchy
- Product-first visuals over decorative effects

Tone words:

- Professional
- Modern
- Confident
- Minimal-luxury

Avoid:

- Excess neon saturation
- Too many gradients per section
- Visual noise competing with CTA

## 3) Color System (Token Mapping)

Use existing token base and enforce role discipline.

Core roles (already available):

- Page background: `--color-bg`, `--color-bg-2`
- Surfaces/cards: `--color-surface`, `--color-surface-2`, `--color-glass`
- Borders: `--color-border`, `--color-border-strong`
- Text high/medium/low: `--color-text`, `--color-text-muted`, `--color-text-dim`
- Primary accent: `--color-primary` (+ `--color-primary-2` for blend)
- Secondary accent (rare): `--color-accent`
- State colors: `--color-success`, `--color-warning`, `--color-danger`

Landing rules:

- Use one dominant action color family (cyan/blue) for primary CTAs
- Use violet only as supporting accent, not for all actions
- Keep section backgrounds close in luminance for cohesive flow
- Reserve warm amber for attention/warning moments only

## 4) Typography System

Use current font stack with strict hierarchy:

- Display/headlines: `--font-family-display` (`Space Grotesk`)
- Body/UI text: `--font-family-base` (`Inter`)
- Stats/technical values: `--font-family-mono`

Recommended landing type scale:

- H1 hero: `clamp(38px, 5vw, 60px)` (already aligned in `phase1.css`)
- H2 section: `clamp(26px, 3.2vw, 38px)`
- H3 card titles: `16-18px`
- Body: `14-17px`
- Meta/captions: `11-13px`

Typography quality rules:

- Keep line length near 50-70 characters
- Keep max two body paragraphs per section intro
- Keep consistent letter-spacing treatment across headings

## 5) Spacing + Layout Rhythm

Use existing spacing scale (`--space-*`) with section-level rhythm:

- Desktop section vertical padding: `56-96px`
- Mobile section vertical padding: `40-64px`
- Card internal padding: `16-24px`
- Grid gap:
  - 12-18px for card clusters
  - 24-56px for major two-column sections

Layout consistency:

- Max content width around 1240px for major bands
- Reuse same horizontal padding pattern across sections
- Avoid sudden jumps in density between adjacent sections

## 6) Component Visual Standards

### Buttons

- Primary CTA:
  - High-contrast gradient in primary palette
  - Subtle lift on hover
  - Visible focus style for accessibility
- Secondary CTA:
  - Border + quiet background
  - Never visually compete with primary

### Cards

- Use one card recipe family (radius, border strength, hover behavior)
- Keep hover effects subtle (`translateY(-2px/-3px)` max)
- Avoid stacking multiple heavy shadows

### Pills/Badges

- Use only for short labels, not paragraphs
- Keep badge color logic semantic and consistent

### Icons

- Use one icon weight/style across landing page
- Keep icon containers consistent in shape and size

## 7) Depth, Effects, and Motion

Effects policy:

- Prefer soft border contrast over strong blur
- Use glow as accent, not base readability layer
- Keep backgrounds mostly static for performance

Motion policy:

- Keep interactions in `160ms-260ms` range
- Use existing easings (`--ease-out`, `--ease-spring`)
- Avoid infinite animations except subtle showcase elements

Accessibility motion rule:

- Respect reduced-motion settings (already supported in tokens)

## 8) Responsive Visual Behavior

Desktop to tablet:

- Keep hero visual prominent but avoid pushing CTA below fold
- Collapse multi-column features progressively (3 -> 2 -> 1)

Mobile:

- Prioritize readability over decorative art
- Keep primary CTA visible early
- Increase vertical breathing room for taps and scanability

## 9) Section-by-Section Style Intent (Landing)

- Nav: clear, sticky, low-visual-noise utility bar
- Hero: strongest visual contrast and typography
- Trust strip: compact and calm
- Problem/Solution: structured comparison feel
- Features: balanced card grid with clean icon rhythm
- How it works: guided, low-friction progression
- Showcase: single product focal point
- Testimonials: calm proof cards, no hype styling
- Pricing: clear structure, reduced cognitive load
- FAQ: simple readable accordion
- Final CTA: second strongest visual emphasis after hero
- Footer: neutral and unobtrusive

## 10) Implementation Mapping (Your Current Files)

Phase 2 implementation should primarily touch:

- `v2/src/styles/tokens.css` (if adding/refining global tokens)
- `v2/src/styles/phase1.css` (welcome route styling refinements)
- `v2/src/styles/layout.css` (shared button/surface consistency when needed)

Support file:

- `v2/src/js/marketing/welcome.route.js` (only if class names or section wrappers need alignment)

## 11) Quality Bar Checklist (Phase 2 Done)

Phase 2 is complete when:

- [ ] Visual hierarchy clearly identifies hero + primary CTA
- [ ] Typography scale is consistent across all landing sections
- [ ] Color roles are consistent (primary vs secondary accent usage)
- [ ] Card, button, and icon systems feel unified
- [ ] Desktop/tablet/mobile visual rhythm is coherent
- [ ] Motion is polished but restrained
- [ ] Contrast and focus states remain accessible

## 12) Handoff to Phase 3

Phase 3 starts implementation with:

- Navigation + Hero built/refined first
- Visual tokens applied consistently from this spec
- No new visual patterns introduced without updating this document
