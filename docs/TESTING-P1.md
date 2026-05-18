# P1 Validation Test Plan

The audit flagged several recent features as never having been validated
against real data — only built. This is the checklist to run BEFORE
inviting external users to test. Each section lists the feature, what
to test, what "passing" looks like, and the failure modes to watch for.

Go through it once in production (https://www.careerboost.co.za) using
**two real test accounts**: one fresh (to exercise empty states) and one
populated with real applications/resumes (to exercise the AI flows).

If anything below fails, log the bug in GitHub Issues with the section
heading and a screenshot — that gives Claude context to fix it later
without re-explaining the scenario.

---

## 1. Resume Lab R3 — inline anchor chips on bullets

**Where**: Resume Lab → open any resume with at least 3 bullets per role.

**What to test**:
1. Each bullet should show a small chip (📎 anchor) at the end when an
   AI critique is attached to it.
2. Hover/click the chip — a popover appears with the critique text and
   "Accept" / "Dismiss" actions.
3. Accept applies the suggested rewrite inline; the chip disappears.
4. Dismiss closes the popover; the chip stays.
5. Generate a new round of critiques — chips re-attach to the right
   bullets (not stuck on positions from the prior pass).

**Pass**: chips align to the right bullet, popover stays in viewport
on narrow screens, accept actually rewrites the visible bullet text.

**Common failure modes**:
- Popover renders off-screen on mobile (overflow-x).
- Chip count drifts after edits (stale offsets).
- Accept inserts the suggestion but doesn't remove the original wording.

---

## 2. Resume Lab R4 — track-changes preview

**Where**: Resume Lab → run AI Review Queue with ≥3 critiques pending.

**What to test**:
1. Open the preview panel — proposed changes show as inline diffs:
   deletions struck-through in red, additions underlined in green.
2. Toggle individual changes on/off — preview updates live.
3. Commit applies only the toggled-on changes.
4. Cancel reverts everything (the resume body is unchanged).

**Pass**: diff alignment is correct (no offset drift across multiple
changes in the same paragraph), commit only writes the on-toggled
subset, undo via browser back is still safe.

**Common failure modes**:
- Two overlapping changes corrupt the diff (additions inside deletions).
- "Apply all" misses the last change because of an off-by-one in the
  toggle accumulator.
- Mobile: the diff layout horizontal-scrolls past the viewport.

---

## 3. Resume Lab R5 — unified AI Review Queue + walkthrough

**Where**: Resume Lab → click "AI Review" (or whatever entry point R5
added). First-time user should see the walkthrough overlay.

**What to test**:
1. **Walkthrough**: appears on first visit (use the fresh account), has
   3-5 steps, can be dismissed mid-way without breaking the queue.
2. **Queue**: lists all pending critiques across all sections (summary,
   bullets, skills) in priority order.
3. **Per-item actions**: Accept / Dismiss / Snooze. Each updates the
   queue badge count.
4. Empty queue shows a "All caught up" state (this was specifically
   called out as added in R5 — verify it's still present).
5. **Walkthrough**: visiting again with the populated account should
   NOT re-trigger the overlay (one-shot).

**Pass**: queue order matches priority (critical first), walkthrough
dismisses correctly, empty state appears at zero items.

**Common failure modes**:
- Walkthrough fires on every visit (localStorage flag not written).
- Queue badge count desyncs from actual items after Accept.
- Snooze items reappear immediately (TTL not honored).

---

## 4. Strengthen-bullet (real AI, post-rewrite)

**Where**: Resume Lab → any bullet → "Strengthen" action.

**What to test**:
1. Click Strengthen on a generic-sounding bullet (e.g. "Worked on
   team projects"). Expect a real Claude/Sonnet call — should take
   1-3 seconds with a spinner.
2. The suggestion should be SPECIFIC (mention metrics, scope, impact)
   — not a string template like "Strengthened: Worked on team projects".
3. Try 3-4 different bullets — outputs should vary, not all be the same
   shape.
4. If you have AI quota at 0, the action should show an upgrade prompt
   (not silently fail).

**Pass**: each strengthen returns a context-aware rewrite that changes
the verb, adds detail, and reads like a human edit — not a wrapper.

**Common failure modes** (especially watch for the regression that
prompted this fix):
- Output is the SAME template across all bullets ("Achieved
  measurable results by [original text]") → AI call is broken,
  falling back to template.
- Suggestion never appears, no spinner, no error → fetch failed
  silently (check network tab for 4xx/5xx).
- Latency >10s → Anthropic API rate limit, consider caching.

---

## 5. Apply Assist Phase 1-2c (DORMANT — verify hidden)

**Where**: any page where the floating "Apply with one click" button
might appear.

**What to test**:
- The button should NOT appear anywhere.
- `window.CB_CONFIG.featureFlags.applyAssist` should be `false`.
- Visiting a Greenhouse application form should NOT show any
  CareerBoost overlay or auto-fill prompt.

**Pass**: zero traces of Apply Assist in the UI. Admin can still see
the Roadmap entry noting it's deferred.

**Why we're testing dormant code**: the flag could accidentally
re-enable in a future config push. This is a sanity check.

---

## 6. Chat Assist panel

**Where**: bottom-right floating help drawer on any authed page.

**What to test**:
1. Click the chat icon — drawer slides up from bottom-right.
2. Type a question ("how do I import my LinkedIn?") and submit.
3. Response should arrive in 2-5 seconds (real AI call to `chat-assist`
   skill).
4. The response should be **specific to CareerBoost** (cite features,
   not generic web advice). If the chat says "I'm a general AI
   assistant…" that's a regression.
5. Close the drawer mid-conversation — re-open it, the history should
   persist (within the session at minimum).
6. Try on mobile — drawer should not overflow viewport.

**Pass**: drawer animates smoothly, responses are CareerBoost-aware,
history persists across open/close.

**Common failure modes**:
- Drawer overlaps the toast notification stack.
- AI response uses generic prompts ("I don't have access to
  CareerBoost data") — system prompt isn't being applied.
- Mobile: keyboard pushes the input off-screen.

---

## 7. Cookie banner (NEW — P1)

**Where**: any page, fresh browser (incognito/private window) or after
`window.CBCookies.reset()`.

**What to test**:
1. First visit: banner appears at the bottom after ~600ms.
2. Click "Got it" → banner slides out, doesn't reappear on refresh.
3. Reset with `CBCookies.reset()` in DevTools console → click "Not now"
   → banner closes. Refresh within 24h → no banner. Refresh after 24h
   → banner returns.
4. Privacy Policy link → navigates to `#/privacy` and the policy renders.
5. Mobile (375px): banner is full-width with small margin, icon hidden,
   actions stack neatly.

**Pass**: dismissal sticks, mobile layout is readable, /privacy renders.

---

## 8. Smoke tests (run for every release)

These are quick wins to catch regressions before they hit real users:

| Flow | Expected | Time |
|---|---|---|
| Sign up new account | Welcome → onboarding → dashboard | 90s |
| Sign in existing | Land on last route used | 15s |
| Generate resume | Spinner → result in 5-15s | 30s |
| Save job from search | Appears in pipeline immediately | 20s |
| Open settings | Profile loads, no console errors | 10s |
| Cookie banner | Appears in incognito, dismissable | 15s |
| Mobile resume view | No horizontal scroll | 30s |
| Sign out + back in | Session persists correctly | 30s |

**Total**: ~5 minutes per release. Worth doing.

---

## How to log failures

For each failed test, capture:
1. **What you did** (one sentence)
2. **What you expected** (one sentence)
3. **What actually happened** (screenshot + console errors)
4. **Browser + device** (e.g. "Chrome 124, iPhone 15 Pro Max simulator")
5. File as a GitHub issue with title `[P1-test] <section> — <symptom>`.

Done well, this gives Claude enough context to fix without you having
to re-explain the scenario.
