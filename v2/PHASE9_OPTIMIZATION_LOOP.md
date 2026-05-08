# CareerBoost Landing - Phase 9 Optimization Loop

Phase 9 turns launch data into a repeatable weekly improvement cycle.

Use with:

- `v2/PHASE8_LAUNCH_CHECKLIST.md`
- Landing events implemented in `src/js/marketing/welcome.route.js`

## 1) Core KPIs

Track these every week:

- `landing_views`: count of `landing_view`
- `nav_cta_clicks`: count of `landing_nav_cta_click`
- `hero_primary_clicks`: count of `landing_hero_primary_click`
- `hero_secondary_clicks`: count of `landing_hero_secondary_click`
- `pricing_clicks`: count of `landing_pricing_click`
- `final_cta_clicks`: count of `landing_footer_cta_click`
- `signup_start`: count of auth flow starts
- `signup_complete`: successful account creation

Derived metrics:

- Hero CTR = `hero_primary_clicks / landing_views`
- Nav CTR = `nav_cta_clicks / landing_views`
- Pricing CTR = `pricing_clicks / landing_views`
- Final CTA CTR = `final_cta_clicks / landing_views`
- Signup start rate = `signup_start / landing_views`
- Signup completion rate = `signup_complete / signup_start`
- Landing-to-signup rate = `signup_complete / landing_views`

## 2) Section Drop-Off Diagnostics

Use `landing_section_view` to identify where attention falls off.

Workflow:

1. Rank sections by view count.
2. Compare each section to previous section (`section_n / section_n-1`).
3. Prioritize the largest drop.

Rule:

- If drop from one section to the next is greater than 25%, that section becomes the primary optimization target for the next sprint.

## 3) Weekly Cadence (Repeat)

### Monday - Read Results

- Pull last 7 days of KPI metrics
- Identify weakest metric and biggest section drop
- Select one primary hypothesis

### Tuesday - Design Experiment

- Define one change only (copy or layout, not both)
- Define success metric and minimum detectable lift
- Define run window (usually 7 days)

### Wednesday/Thursday - Ship Variant

- Implement variant safely
- Keep all other sections unchanged
- Verify events still fire correctly

### Friday - Evaluate + Decide

- Compare control vs variant
- Keep winner if improvement is meaningful and stable
- Log learning regardless of outcome

## 4) Experiment Backlog (Start Here)

Prioritize from highest expected impact to lowest effort.

1. Hero headline variant test (outcome wording vs workflow wording)
2. Hero primary CTA text test (`Start free` vs `Create free account`)
3. Secondary CTA text test (`See how it works` vs `View workflow demo`)
4. Pricing section heading test (value-first vs risk-reversal framing)
5. Final CTA band copy test (clarity/momentum vs confidence framing)
6. FAQ ordering test (credit card/privacy/export first)

## 5) Experiment Card Template

Copy this block for each test:

```
Experiment ID:
Date range:
Hypothesis:
Change:
Primary metric:
Guardrail metric:
Result:
Decision:
Notes:
```

## 6) Guardrails (Do Not Break)

- Do not run more than one major landing experiment at a time.
- Do not change event names mid-test.
- Do not evaluate before minimum sample threshold is met.
- Do not keep variants that increase click-through but reduce signup completion rate.

## 7) Exit Criteria for Successful Phase 9

Phase 9 is operating correctly when:

- Weekly KPI review happens consistently
- At least one experiment runs each week
- Decisions are logged with evidence
- Landing-to-signup rate trends upward over time
