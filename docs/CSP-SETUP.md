# Content Security Policy — rollout + monitoring

Week 2 #3 of the production hardening list. CSP is a browser security
header that whitelists where each kind of resource (scripts, styles,
images, API endpoints, etc.) can come from. Done right it neutralizes
most XSS attacks. Done wrong it breaks the entire app.

We're currently in **REPORT-ONLY MODE** — browsers tell us about
violations but do NOT block them. After ~1 week of monitoring with
no real-world violations, flip to enforcing mode.

---

## Current state (what's deployed)

- Header `Content-Security-Policy-Report-Only` set in `v2/vercel.json`
- Edge function `csp-report` at
  `https://kddffkhwpbngiupfmcse.functions.supabase.co/csp-report`
  receives violation reports and logs them to Supabase Edge Function logs
- Browsers automatically POST violation reports to that URL

## What each CSP directive does

```
default-src 'self';
```
The baseline. Anything not explicitly overridden below falls back to
"only allow same-origin resources".

```
script-src 'self' 'unsafe-inline'
  https://cdn.jsdelivr.net   # Supabase JS SDK
  https://plausible.io        # Analytics
  https://unpkg.com;          # docx library (resume export)
```
JavaScript sources. `'unsafe-inline'` is needed for now because we
have inline `<script>` blocks in `index.html` (the Plausible bootstrap
and some initial setup). Future hardening: refactor to nonces or
external files, then remove `'unsafe-inline'`.

```
style-src 'self' 'unsafe-inline'
  https://fonts.googleapis.com  # Google Fonts CSS
  https://cdnjs.cloudflare.com; # Font Awesome CSS
```
Stylesheet sources. `'unsafe-inline'` needed because lots of JS code
sets `element.style.x = value` directly + Font Awesome injects inline
styles for icon glyphs. Could be eliminated with major refactor; not
worth it for the risk reduction.

```
font-src 'self' data:
  https://fonts.gstatic.com   # Google Fonts files
  https://cdnjs.cloudflare.com; # Font Awesome fonts
```
Font files. `data:` allows base64-inlined fonts.

```
img-src 'self' data: blob: https:;
```
Images. Wide-open `https:` because we display arbitrary images from
user uploads (avatars), Google OAuth profile photos
(`lh3.googleusercontent.com`), company logos in job listings
(thousands of distinct hosts), and DuckDuckGo favicon service. The
risk of img-src is low (images can't execute code).

```
connect-src 'self'
  https://kddffkhwpbngiupfmcse.supabase.co        # Supabase REST + Auth
  wss://kddffkhwpbngiupfmcse.supabase.co          # Supabase Realtime
  https://kddffkhwpbngiupfmcse.functions.supabase.co  # Edge Functions
  https://plausible.io                             # Analytics events
  https://api.adzuna.com                           # Job search API
  https://www.themuse.com                          # Job search API
  https://boards.greenhouse.io                     # ATS feeds
  https://api.lever.co                             # ATS feeds
  https://icons.duckduckgo.com;                    # Favicon proxy
```
fetch/XHR/WebSocket destinations. This is the most XSS-relevant
directive because exfiltration attacks need to POST stolen data
somewhere. We've enumerated every external API we hit — anything
else (Pastebin, attacker server, etc.) gets blocked.

```
frame-src 'none';
frame-ancestors 'none';
```
We embed no iframes, and no one can embed us. `frame-ancestors`
duplicates `X-Frame-Options: DENY` for defense-in-depth.

```
form-action 'self';
base-uri 'self';
object-src 'none';
```
Forms can only submit back to us. `<base>` can only point to us
(blocks `<base href=evil.com>` attacks). `<object>` / `<embed>`
completely disallowed (Flash, Java applets, etc.).

```
report-uri https://kddffkhwpbngiupfmcse.functions.supabase.co/csp-report
```
Tells the browser where to POST violation reports.

---

## Monitoring during the report-only window

### Check Edge Function logs

Open:
```
https://supabase.com/dashboard/project/kddffkhwpbngiupfmcse/functions/csp-report/logs
```

Each violation appears as a `[csp-report]` log line with the
violated directive, blocked URI, document URI, and user agent.

### What violations to expect (false positives — IGNORE these)

| Pattern | Why it shows up | Action |
|---|---|---|
| `chrome-extension://...` blocked_uri | Browser extensions injecting code | Ignore. We can't whitelist extensions, and the policy correctly blocks them. |
| `inline` from a `script-src` directive | One of our inline scripts that 'unsafe-inline' should have allowed | Look at the violated_directive — if it's `script-src-elem` you may need to add it explicitly. |
| `safari-extension://...`, `moz-extension://...` | Same as Chrome — extensions | Ignore |

### What violations to ACT ON

| Pattern | What it means | Action |
|---|---|---|
| `blocked_uri: https://NEW_HOST` from `connect-src` | New API endpoint we hit but didn't whitelist | Add the host to `connect-src` in `vercel.json` and redeploy |
| `blocked_uri: https://NEW_CDN` from `script-src` | New script CDN we started loading | Add to `script-src` and redeploy |
| `blocked_uri: data:` from `script-src` | We have `eval()` or `new Function()` somewhere | Refactor — `data:` in script-src is unsafe |
| Repeated violations across many users | Something genuinely broken | Investigate before flipping to enforce |

---

## Flipping to enforcing mode

After ~1 week of report-only monitoring with no actionable violations,
swap the header KEY in `vercel.json`:

### Find this line:
```json
"key": "Content-Security-Policy-Report-Only",
```

### Change to:
```json
"key": "Content-Security-Policy",
```

Commit + push. Vercel deploys + the policy now BLOCKS violations
instead of just reporting. Browsers refuse to load disallowed scripts,
fail disallowed fetches, etc.

### What to do if enforcing breaks something

1. **Open browser DevTools console** — CSP violations log there with
   the exact directive + blocked URI
2. **Identify the missing source** — add it to the appropriate directive
3. Redeploy

If the breakage is widespread, you can revert to report-only
instantly:

```json
"key": "Content-Security-Policy-Report-Only",
```

…and re-deploy. The browser stops blocking. Use this if you ever
need to ship a fix urgently and don't have time to debug CSP.

---

## When to revisit / tighten

Future tightening targets when you have time:

1. **Remove `'unsafe-inline'` from script-src** — biggest XSS-protection
   win. Refactor inline `<script>` blocks to use nonces (Vercel can
   inject) or move them to external `.js` files.
2. **Remove `'unsafe-inline'` from style-src** — second biggest. Requires
   refactoring `element.style.x = ...` patterns to use class toggles.
3. **Narrow img-src from `https:` to specific CDNs** — if we ever stop
   accepting arbitrary user-uploaded image URLs.
4. **Add `require-trusted-types-for 'script'`** — newer browsers; forces
   all DOM-sink writes to go through a Trusted Types policy. Very
   strict but very effective against DOM XSS. Big refactor.

None of these are urgent. The current policy already blocks the
common XSS exfiltration paths (connect-src tight, form-action 'self',
frame-ancestors 'none').

---

## Quick reference — common CSP directives explained

- `default-src` — fallback for any directive not explicitly set
- `script-src` — `<script>`, `eval()`, inline event handlers (`onclick=`)
- `style-src` — `<style>`, `<link rel=stylesheet>`, inline `style=`
- `img-src` — `<img>`, `srcset`, CSS `background-image`
- `font-src` — `@font-face`
- `connect-src` — `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`
- `frame-src` — what URLs can be loaded in `<iframe>`
- `frame-ancestors` — what URLs can embed THIS page in an iframe
- `form-action` — what URLs `<form>` can POST to
- `object-src` — `<object>`, `<embed>`, `<applet>` (legacy plugins)
- `base-uri` — `<base href>` allowed values
- `report-uri` (legacy) / `report-to` (newer) — where to send violation reports
