# Admin Redesign Brief — "Aurora Console"

> Status: **PLANNING** (no build yet). Direction approved: Aurora Console.
> This brief is the portable plan — a fresh session can start building from here.

---

## 1. The problem (diagnosis)

The admin is a **separate visual language** from the rest of CareerBoost. The app
has a polished "aurora" design system in `v2/src/styles/tokens.css` (cyan
`#22e3ff`, violet `#b06bff`, amber `#ff9d4a`, deep-space backgrounds, glass
surfaces, aurora gradients, Inter + JetBrains Mono). The admin barely uses it:

- **`v2/src/styles/admin.css` is ~4,100 lines** with its **own** palette. Its
  signature colour is **green** (`#10b981` / `#5eead4` for active nav + badges)
  — a generic SaaS-dashboard green that is **nowhere in the brand**.
- **Slate surfaces** (`#0c1118`, `rgba(25,31,42,…)`) instead of deep-space +
  glass + aurora glow.
- **No brand presence**: no proper wordmark, no aurora gradients, no personality.
- **Scattered styling**: admin.css PLUS hardcoded inline colours
  (`#7cf0ff`, `--col-muted`, `--accent`) baked into ~24 section JS files —
  three slightly different palettes competing.

Net: it reads like a Tailwind admin template, not CareerBoost.

## 2. The vision — "Aurora Console"

The admin should feel like **mission control for CareerBoost**: a premium
extension of the product. Deep-space canvas with subtle aurora gradients, glass
panels, a **cyan→violet** accent for active/primary, **amber** reserved for
"needs you" (review queues, alerts, incidents), and **JetBrains Mono** for every
number so data has a confident "instrument readout" voice.

Principles:
1. **One design system.** The admin consumes the same `--color-*` aurora tokens
   as the app. No parallel palette.
2. **Brand the chrome, calm the data.** Sidebar/headers/KPIs are rich (glow,
   glass, gradient); tables/forms stay high-contrast and legible.
3. **Amber means attention.** Green stops being the default; it's only "healthy/
   success". Amber = action needed. Cyan = primary. Violet = AI/intelligence.
4. **Mono numbers.** Every metric/count uses `--font-family-mono`.

## 3. The key leverage point (why this is tractable)

Every section already renders through shared classes — `.admin-panel`,
`.admin-nav-link`, `.admin-stat-grid`, `.chip`, `.btn`, `.admin-panel-head`.
**Re-skin those primitives + the shell once → all ~24 sections transform at
once.** Section logic is untouched. Then polish section-by-section to retire the
inline-style sprawl. ~80% of the new feel for ~20% of the effort, low risk.

## 4. Design language spec (token mapping)

Introduce a thin layer of **admin semantic tokens** that reference the aurora
primitives, then retarget admin.css + inline styles to them.

| Surface / role        | Today (admin.css)                    | Aurora Console target |
|-----------------------|--------------------------------------|-----------------------|
| App background        | slate `#0c1118`                      | `--color-bg` + aurora-1..4 radial gradients behind content |
| Panel / card          | slate gradient `rgba(25,31,42,…)`    | `--color-glass` + `1px var(--color-border)`, soft inner highlight; cyan glow on hover |
| Nav active            | **green** gradient + `#5eead4` icon  | `linear-gradient(90deg, rgba(34,227,255,.16), rgba(176,107,255,.10))` + left bar cyan→violet, icon `--color-primary` |
| Primary button        | mixed                                | cyan→violet gradient, dark text |
| KPI accent bar        | `#22e3ff` only                       | semantic: cyan (default), violet (AI), amber (attention), green (health) |
| Chips/badges          | green-leaning                        | semantic set: cyan / violet / amber / green / red, all as tinted glass |
| Numbers / metrics     | Inter                                | `--font-family-mono` (JetBrains Mono) |
| Text                  | ad-hoc `--col-muted`                 | `--color-text` / `--color-text-muted` / `--color-text-dim` |
| Danger / incidents    | red slate                            | `--color-danger` + amber escalation states |

Proposed admin semantic tokens (define once, in admin.css `:root` scope):
```
--admin-bg, --admin-panel, --admin-panel-hover, --admin-border,
--admin-text, --admin-text-muted, --admin-accent (cyan), --admin-accent-2 (violet),
--admin-attention (amber), --admin-ok (green), --admin-danger (red),
--admin-grad-primary: linear-gradient(135deg, #22e3ff, #b06bff);
--admin-glow: 0 0 0 1px rgba(34,227,255,.18), 0 8px 40px rgba(34,227,255,.06);
```

## 5. The "Admin Kit" (canonical components)

Build/refresh these as the single source of truth (classes, not inline styles):

- **Shell**: branded sidebar (wordmark from `brand_settings`, aurora bg, grouped
  nav, cyan/violet active), top bar (page title, env chip, admin identity + MFA
  status, quick actions), content area with aurora backdrop.
- **Panel** (`.admin-panel`) + **panel head** (title, eyebrow, actions).
- **Stat / KPI card** (mono number, sparkline slot, semantic accent, delta).
- **Chip / badge** (cyan / violet / amber / green / red).
- **Button** variants (primary gradient, ghost, danger, sm).
- **Table** (sticky header, zebra-free calm rows, numeric right-align, mono).
- **Form field** (label, input, select, textarea, help text, error).
- **Toolbar** (the row of buttons many sections render).
- **Tabs / segmented control**.
- **Empty state** (icon, message, CTA).
- **Loading skeleton** + **toast** + **modal** (align to brand).

## 6. Phased plan (FE / BE split)

- **Phase 0 — Foundation** *(FE only)*: define the `--admin-*` semantic token
  layer mapped to aurora tokens, build the Admin Kit components, and produce a
  standalone **reference screen** (`v2/admin-redesign-preview.html`, mock data,
  zero risk to the live admin) to approve the look before rolling out.
- **Phase 1 — Re-skin shell + primitives** *(FE only)*: sidebar, top bar, and the
  shared `admin-helpers.js` render helpers (`renderStat`, `renderAlerts`,
  `renderSparkBars`, …) + `.admin-*` / `.chip` / `.btn` classes. **Instant
  transformation across every section. No backend.** Ship it.
- **Phase 2 — Section polish + first backend touch-points** *(FE + light BE)*:
  migrate inline styles → kit classes, densest/most-used first:
  1. Overview, 2. Command Center, 3. Users, 4. Content Studio (+ the new
  marketing panels: Referrals, A/B, Lifecycle email, Push), 5. Growth /
  Funnel / Product Intelligence, 6. Risk Center / Health / Logs / Operations,
  7. the rest.
  Fold in **BE-1 (KPI deltas/sparklines)** and **BE-2 (sidebar attention
  badges)** as the cards that need them land (see §8).
- **Phase 3 — Consolidate + delight** *(BE + FE)*: **BE-3 `marketing-overview`
  aggregator** (one-call Marketing area), **BE-4 realtime** affordances, then
  empty states, loading skeletons, micro-interactions, responsive/mobile, and the
  final a11y sweep (contrast, focus rings).

## 7. Technical approach & risk

- **admin.css is bundled** via `v2/build.mjs` `SHEETS` (cascade order matters —
  it loads after tokens/base/layout/modules, so it can reference `--color-*`).
- **Re-skin behind existing class names** so no section markup changes in Phase 1
  → nothing breaks; verify by eyeballing each section after the re-skin.
- **Inline-style sprawl**: ~24 section JS files hardcode colours. Strategy: add
  kit classes + a few utilities, then migrate section-by-section in Phase 2.
  Don't try to do all inline styles at once.
- **Brand-settings integration**: pull the **wordmark** (and optionally the
  accent colours) live from `brand_settings` so the admin tracks the Brand Kit —
  reuses the existing `content-public?resource=brand` / admin-brand plumbing.
- **Phases 0–1 are frontend-only** — purely `v2/src/styles/admin.css` + the admin
  shell (`admin.route.js`) + the shared helpers (`admin-helpers.js`). The backend
  work is **additive** and lives in Phases 2–3 (§8) — never a rewrite of the
  working `admin-overview`. Ships via the normal feature→develop→main + Vercel.

## 8. Backend integration plan

### 8a. How the admin talks to the backend today
- **The shell** (`admin.route.js`) makes **one big fetch to `admin-overview`** and
  hands that payload to the active section. Sections register as
  `CBAdmin.sections[id] = { render(data) }` and render off it.
- **`admin-overview`** = the mega-aggregator (~2,819 lines, **9 materialized-view
  reads**) returning `northStar, aarrr, cohorts, funnel, growth, retention,
  revenue, aiCost, alerts, incidents, apps…`. mv-backed → fast.
- **~14 `admin-*` functions** handle detail + mutations (users, user-timeline,
  user-adjust, promote-user, content, brand, credentials, tracked-companies,
  testimonials, send-email, list-audit, list-operators, incident-update).
- **Marketing trio** (this work): `admin-content` (scorecard / experiments /
  email-overview), `referral` (leaderboard), `push-send` (stats / send / pause).
- **Security envelope on every call**: `getAuthedAdmin` (role + AAL2/MFA) +
  `admin-csrf` (X-CB-Admin-Nonce) + `admin-rate-limit` + `admin-audit`.
- Shared render toolkit lives in `admin-helpers.js` (`renderStat`, `renderAlerts`,
  `renderCohortBars`, `renderSparkBars`, formatters, tone helpers) — re-skinning
  these updates visuals everywhere (the Phase 1 leverage).

### 8b. Backend touch-points the redesign needs (all additive)

| ID | Touch-point | Why | Phase |
|----|-------------|-----|-------|
| **BE-1** | KPI **deltas + sparklines** | New KPI cards show "↑12% vs last week" + a sparkline. Add previous-period values + short time-series to the relevant metrics in `admin-overview`. | 2 |
| **BE-2** | Sidebar **attention badges** | Amber counts on nav (e.g. "Content: 3 to review", "Risk: 1 incident", "Suppressions: 2"). Surface small counts in `admin-overview` (or a tiny `admin-badges` call). | 2 |
| **BE-3** | **`marketing-overview` aggregator** | Marketing area today fires 4–5 separate calls (scorecard, experiments, email-overview, referral leaderboard, push stats) with inconsistent loading. One aggregator → one call, one loading state, consistent UI. | 3 |
| **BE-4** | **Realtime** affordances | `admin-realtime.js` exists; wire live ticks / "new review item" badges into the new components. | 3 |
| **BE-5** | **Migration backlog 0036–0042** | The new admin panels (Referrals / A-B / Lifecycle / Push) **error until those migrations apply**. Confirm applied (db-migrate CI / `db push`) or keep graceful guards so the UI never breaks on missing tables. | pre-2 |

### 8c. Backend-adjacent notes
- **Brand-live wiring**: pull the admin wordmark (+ optional accent) from
  `brand_settings` via existing `admin-brand` / `content-public?resource=brand`.
- **Performance guardrail**: `admin-overview` is already heavy (9 mv reads). Keep
  BE-1/BE-2 lean; if it grows, split heavy sections into lazy per-section loads so
  first paint stays fast.

## 9. Decisions (LOCKED 2026-06-05)

1. **KPI richness** — ✅ **Deltas + sparklines on most cards** (drives BE-1).
2. **Marketing aggregator** — ✅ **Build `marketing-overview`** (BE-3) for a
   one-call Marketing area.
3. **Sidebar attention badges** — ✅ **Yes** (drives BE-2).
4. **Defaults kept** — ✅ wordmark **live from `brand_settings`** (static
   fallback), **dark-only**, **comfortable** density, **collapsible / icon-rail**
   sidebar on narrow screens.
5. **Glass intensity** — calibrate on the Phase 0 reference screen.

## 10. Success criteria

- A first-time look at any admin screen reads unmistakably "CareerBoost".
- Zero green-as-primary; amber == attention everywhere.
- All numbers in mono; all surfaces glass/aurora; one token system.
- No section logic regressions (every section still works post-reskin).

---

### Suggested first build session kickoff
> "Aurora Console admin redesign, Phase 0 + 1. Read docs/ADMIN_REDESIGN_BRIEF.md.
> Start by defining the admin semantic token layer in v2/src/styles/admin.css
> mapped to the aurora tokens, re-skin the shell (sidebar + top bar) and the
> shared .admin-panel/.chip/.btn primitives, and produce the Overview reference
> screen for approval before rolling out."
