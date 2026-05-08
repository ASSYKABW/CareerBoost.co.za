# CareerBoost Landing - Phase 8 Launch Checklist

Use this checklist before a public launch.

## 1) Metadata + Preview

- [ ] Verify page `<title>` and meta description are final
- [ ] Validate Open Graph title/description in a link preview tool
- [ ] Validate Twitter card preview
- [ ] Confirm brand name consistency (`CareerBoost`) across hero/meta/footer

## 2) Conversion Tracking

- [ ] Confirm `landing_view` fires on welcome route render
- [ ] Confirm nav CTA click events fire (`landing_nav_cta_click`)
- [ ] Confirm hero CTA events fire (`landing_hero_primary_click`, `landing_hero_secondary_click`)
- [ ] Confirm pricing CTA events fire (`landing_pricing_click`)
- [ ] Confirm final CTA event fires (`landing_footer_cta_click`)
- [ ] Confirm section view events fire once per section (`landing_section_view`)

## 3) Routing + CTA Behavior

- [ ] All `Start free` CTAs route to `#/auth?mode=signup`
- [ ] `Sign in` routes to `#/auth`
- [ ] Section anchors scroll correctly with sticky nav offset
- [ ] Mobile nav still exposes primary conversion path

## 4) Trust + Compliance Surface

- [ ] Pricing, FAQ, and privacy statements use accurate claims
- [ ] No unsupported numeric performance claims in hero/features
- [ ] Footer includes current year and clear brand identity

## 5) Final Smoke Test

- [ ] Desktop: check primary breakpoints (1280, 1024)
- [ ] Mobile: check primary breakpoints (375, 320)
- [ ] Keyboard navigation reaches nav CTAs, FAQ toggles, and final CTA
- [ ] Reduced-motion mode keeps page usable without animated cues

## 6) Post-Launch (First 48 Hours)

- [ ] Monitor CTA click-through rates by placement (nav, hero, pricing, final)
- [ ] Monitor signup starts vs completions
- [ ] Review section drop-off using section view events
- [ ] Prioritize first copy or layout iteration based on weakest conversion step
- [ ] Start weekly optimization cadence from `v2/PHASE9_OPTIMIZATION_LOOP.md`
