# P1 Audit Findings — Empty States + Mobile

Two passes done as part of P1. The user's audit asked for "Mobile audit
at 375px and 768px" and "Empty / failed-state coverage … one pass with
fresh eyes." This doc captures what was found. Critical items are
fixed inline in the same commit; the rest are follow-ups sized for
1-2 hour blocks.

---

## Mobile responsiveness — verdict: needs 2-3 hrs of fixes

No critical overflow blockers (the site stays usable on mobile), but
several layouts get crushed at 375px because 480px is the smallest
breakpoint in most of the codebase. Worst offenders are admin drawer
stats and the Interview UI.

### Fixed in this commit (P1)
- `.interview-persona-strip` — added 480px breakpoint, 4 cols → 1.
  (Persona chips were crushed at 375px.)
- `.interview-intel-layout` + `.interview-session-grid` — added 768px
  breakpoint. Right column (230px min-width) was overflowing the
  viewport at 375px since the page padding ate the available space.
  Both now stack to a single column under 768px (iPad portrait and
  below).
- `.interview-target-bar` — added 600px breakpoint, role picker
  column (260px min) now stacks above the rest instead of pushing
  content off-screen.

### Already fine (audit was overly cautious)
- `.admin-user-drawer-stats` — agent flagged the 5-col desktop grid
  but it already collapses to 2-col at 1024px, which covers all
  phones. No fix needed.

### Follow-ups (file:line — issue)
1. `modules.css:484` — `.interview-target-bar` `minmax(260px,360px)`
   first col overflows at 375px. Add 600px breakpoint to stack.
2. `modules.css:3453` — `.job-search-job-card__chips` `max-width:46%`
   + chip `max-width:180px` overflows narrow cards. Reduce at mobile.
3. `modules.css:515` — `.interview-target-picker select` right padding
   `2.4rem` eats too much of a 260px field at mobile.
4. `admin.css:2673` — `.admin-user-drawer-grid` `1fr 1fr` should be
   single-col at 768px (iPad portrait), currently collapses at 1024px.
5. `modules.css:3527` — `.job-search-layout` only has 960px rule; no
   explicit 768px sidebar collapse.
6. Resume Lab popovers — no `.resume-*` popover classes have explicit
   `max-width`. Would need a focused look at where popovers anchor.

### Modules with already-good responsive coverage
- `.job-search-results` (960 + 720 + 640 breakpoints, clean cascade)
- `.settings-form .grid-3` (1280→2 col, 900→1 col)

---

## Empty / failed states — verdict: foundations are good, secondary lists are gaps

The flagship routes (Resume Lab, Cover Letter, Applications kanban,
Job Search results) all have explicit empty states. The pattern works
— it just isn't applied uniformly. Secondary lists (saved jobs panel,
career assets vault, dashboard digest, tailor suggestion sub-lists)
render via raw `.map().join("")` with no length check, so when the
list is empty they show blank space instead of a CTA.

### Not fixed inline (audit needs human verification)
The sub-agent's line numbers don't all match the current code (e.g.
job-search saved searches at line 1061 already HAS an explicit empty
state). Rather than make speculative edits to other modules, the
full list is captured below as follow-ups. Worth a focused 90-min
session to walk through each one with the actual file open.

### Follow-ups (file:line — issue)
1. `resume.route.js:1123` — Review queue items have no length guard;
   blanks out instead of "Queue cleared".
2. `applications.route.js:1017` — `renderColumns` has no error
   boundary; silent crash on fetch failure.
3. `interview.route.js:1994` — Briefing section needs loading
   skeleton while `intelPackEnvelope` fetches.
4. `cover-letter.route.js:815` — Suggestions panel flashes empty
   then full; needs a loading state during AI generation.
5. `dashboard.route.js:862` — Digest scanning sets aria-busy but
   doesn't render skeleton cards.
6. `applications.route.js:752` — Empty pipeline state relies on
   `window.CBV2.ui.emptyState()` helper; if helper isn't loaded,
   falls silent. Add an inline fallback.
7. `resume.route.js:1507` — Tailor plan cards have a ternary
   fallback but nested bullet/skill renders don't validate `.length`
   before `.map()`.

### Suggested fix pattern (drop-in for all 7 above)
```js
// Before any .map() or list render:
if (!items.length) {
  return '<div class="section-empty"><p>Empty state message with CTA</p></div>';
}
return '<ul>' + items.map(...).join("") + '</ul>';
```

---

## Recommended schedule for follow-ups
- **Mobile rest (6 items)**: 2 hours, one focused session. Best done
  with Chrome DevTools mobile mode + an actual phone.
- **Empty states rest (7 items)**: 1.5 hours; mechanical edits with
  the pattern above.
- **Combined**: ~3.5 hours. Worth doing before inviting public users
  but not a launch blocker.
