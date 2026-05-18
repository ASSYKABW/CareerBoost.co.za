# settings.route.js Split Plan

## Why this doc exists

P2 audit said: *"Split settings.route.js (1200 lines) into smaller
modules — you've started (settings.meta.js, settings.billing.js);
finish"*. The actual file is **3387 lines**, not 1200, so "finish"
means more work than a single P2 chunk can absorb safely.

This doc captures:
- What was done in P2 (the proof-of-pattern extraction)
- The dependency footprint of each remaining section
- A safe, repeatable extraction recipe
- A prioritized order for the rest

## What's done (after P2)

| Module | Lines | Renderers | Status |
|---|---|---|---|
| `settings.meta.js` | 105 | tab metadata, normalize, summary | shipped pre-P2 |
| `settings.billing.js` | 224 | `render()` + `bind()` for billing tab | shipped pre-P2 |
| `settings.intel.js` | 65 | `render()` for candidate intelligence card | **NEW (P2)** |
| `settings.route.js` | ~3350 | everything else | the big one |

The intel extraction proves the pattern works end-to-end: pure renderer
into a namespace, original function replaced with a 4-line delegating
shim, callsites unchanged.

## Extraction recipe (per renderer)

For each `render*Section()` function in settings.route.js:

1. **Read the function.** Identify every reference that's NOT
   `window.CBV2.*`. Those are closure dependencies.
2. **Categorize the closure deps:**
   - **Pure helpers** (`st`, `getMetricNumber`): re-implement inside
     the new module (5 lines). Avoid importing — keeps the module
     self-contained.
   - **Mutable state** (`viewState`, `pendingChanges`): expose as a
     getter on `window.CBV2.settingsCtx` exported from settings.route.js.
     The extracted module reads from the getter.
   - **Event helpers** (`scheduleRender`, `setStatus`): same pattern
     as mutable state — expose via `window.CBV2.settingsCtx`.
3. **Create `settings.<name>.js`** with:
   ```js
   (function () {
     window.CBV2 = window.CBV2 || {};
     window.CBV2.settings<Name> = window.CBV2.settings<Name> || {};
     function st(v) { return (window.CBV2.sanitizeText || String)(v); }
     function render(/* args */) { /* original body */ }
     window.CBV2.settings<Name>.render = render;
   })();
   ```
4. **Replace original** in settings.route.js with a delegating shim
   (4 lines, see `renderCandidateIntelligenceSettingsSection` for the
   template).
5. **Wire into index.html** BEFORE settings.route.js with cache-bust
   `?v=<date>-<phase>`.
6. **Run** `node --check settings.<name>.js && node --check settings.route.js`.
7. **Smoke test** the Settings tab in browser — render must look
   identical.

## Prioritized extraction queue

Ordered by **risk-adjusted impact** (low risk first; biggest wins
near top among low-risk).

### Tier 1 — safe, mechanical (~3 hrs total)
| Renderer (line) | Lines | Closure deps | Notes |
|---|---|---|---|
| `renderAiUsageStats` (1480) | 40 | `st`, `getMetricNumber` | Pure function with `telemetry` param — clean cut. |
| `renderSettingsStatusCard` + `renderSetupAction` (1146) | 35 | `st` | Tiny shared helpers; combine into `settings.overview-cards.js`. |
| `renderSettingsOverviewSection` (1180) | 65 | + above two | Bundle with the helpers above. |
| `renderSyncStatusSection` (1676) | 140 | `st`, sync state | Read sync state from `window.CBV2.store.*` — already mostly there. |
| `renderJobPreferencesSection` (1369) | 110 | `st`, profile state | Profile already on `window.CBV2.profile`. |

**Result**: ~390 lines extracted. settings.route.js → ~2960 lines.

### Tier 2 — medium risk (~3 hrs total)
| Renderer (line) | Lines | Closure deps | Risk source |
|---|---|---|---|
| `renderApplyAssistSection` (391) | 360 | `viewState.formStatus`, save handlers | Many form-status reads + dirty/saving lifecycle. **But** feature is dormant — if it breaks, no user impact. **Do this one first in Tier 2.** |
| `renderExtensionInstallSection` (754) | 90 | `viewState`, hosting URL | Static-ish content; mostly safe. |
| `renderAiPersonalizationSection` (1520) | 155 | profile prefs, save handlers | Live feature; needs careful test pass. |
| `renderAppearanceSection` (1281) | 88 | theme state, save handler | Live feature; small enough to be low-effort. |
| `renderSavedCvSection` + `renderCareerAssetsSection` (910) | 190 | document state, delete handlers | Live feature; touches storage. |

**Result**: ~880 lines extracted. settings.route.js → ~2080 lines.

### Tier 3 — high risk, defer until ctx pattern exists (~4-6 hrs total)
- `renderProfileSection` (209), `renderAccountSection` (313),
  `renderLegacyAccountSection` (317), `renderAccountIdentitySection` (842),
  `renderPersonalHero` (1095). These read/write deep into `viewState`
  and the save-and-render lifecycle. Best done AFTER establishing
  `window.CBV2.settingsCtx` as a stable interface.
- The big monolithic `renderView` (1870 onwards, ~1486 lines).
  Most of this is inline HTML composition that calls all the
  sub-renderers. Should shrink dramatically as Tier 1+2 land.
  Final cleanup: extract the dispatcher per-tab into a small
  `settings.dispatch.js`.

**Result**: file ends ~700-900 lines, all per-section logic in its
own module.

## Risk controls

1. **Cache-bust on EVERY extraction commit.** A stale browser
   loading the new settings.route.js without the new module gets a
   half-broken settings page. The version suffix (e.g. `?v=20260518-p2`)
   forces re-fetch.
2. **Smoke test the live Settings page after each commit.** Five
   tabs (Overview / Profile / AI / Billing / Advanced). Visual
   diff: nothing should look different.
3. **Keep delegating shims around** until ALL callsites in
   settings.route.js are gone. The shim is one-time tech debt;
   removing it requires touching renderView which is what we want
   to defer until last.
4. **Don't extract two sections in one commit.** If anything
   breaks, you want to bisect to a single small change.

## Definition of done

settings.route.js is below 1500 lines AND none of the renderer
functions inside it exceeds 50 lines. At that point the file is the
dispatcher + lifecycle only; all section logic lives in `settings.*.js`
modules.

Total estimated work to reach DoD: **6-8 focused hours** across
8-10 commits. Best done one Tier at a time, smoke-tested in
between, NOT in a single weekend marathon.
