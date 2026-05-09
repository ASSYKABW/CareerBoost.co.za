# CareerBoost Job Capture extension

Chrome extension for Tier C job capture across major job boards and ATS
platforms.

Adds a floating circular **CB** button to the top-right of supported job
pages. When the user clicks the button, the extension reads the job
details (preferring schema.org JSON-LD where available, falling back to
DOM selectors), shows a preview modal, and sends the job to:

`POST /functions/v1/job-import`

The default target is `pipeline`, so the backend creates or updates a
CareerBoost Pipeline application.

## Supported sites

| Vendor | URL pattern | Extraction |
|--------|------------|------------|
| LinkedIn | `linkedin.com/jobs/view/*`, `currentJobId=*` | JSON-LD → CSS selectors |
| Indeed | `indeed.com/viewjob?jk=*`, `?vjk=*` | JSON-LD → CSS selectors |
| Greenhouse | `boards.greenhouse.io/*`, `*.greenhouse.io/jobs/*` | JSON-LD → CSS selectors |
| Lever | `jobs.lever.co/{company}/{id}` | JSON-LD → `data-qa` selectors |

The extension's icon shows a small badge: green dot when connected, red
when reconnect is needed, and a brief ✓/x flash on each save attempt.

## Files

- `manifest.json` — Chrome extension manifest v3
- `background.js` — auth/session, job-import calls, vendor allowlist, badge
- `shared/json-ld-job.js` — JSON-LD JobPosting parser shared by all vendors
- `shared/capture-base.js` — button injection + preview modal + telemetry
- `linkedin.content.js` — LinkedIn page adapter
- `indeed.content.js` — Indeed page adapter
- `greenhouse.content.js` — Greenhouse page adapter
- `lever.content.js` — Lever page adapter
- `capture.css` — shared injected UI styling (vendor-neutral)
- `options.html/js/css` — connect the extension to CareerBoost
- `popup.html/js/css` — quick connection status

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` folder.
5. Open the extension options page.
6. Sign in with your CareerBoost account.
7. Optional for developers only: open **Developer connection** if you need to point the extension at a different Supabase project or Functions URL.
8. Open a LinkedIn job page and click **Save to CareerBoost**.

## How capture works

1. User explicitly clicks **Save to CareerBoost**.
2. The LinkedIn content script extracts title, company, location, URL, remote
   hints, and a description snapshot when available.
3. A preview modal lets the user review or edit the fields.
4. The background worker sends the payload with the user's Supabase access token.
5. `job-import` validates the session and writes to the Pipeline.

## Security notes

- No LinkedIn passwords are stored.
- No automated LinkedIn crawling.
- No service-role key ships in the extension.
- The extension stores CareerBoost access/refresh tokens in Chrome extension
  storage after the user signs in.

## Current limitations

- LinkedIn changes its DOM often. The adapter uses multiple selectors and a
  floating fallback button, but selectors may need maintenance.
- The extension currently targets LinkedIn. Add more adapters later for Indeed,
  Greenhouse, Lever, and other boards.
- If your Edge Functions are restricted by a single `SITE_URL` CORS value, make
  sure extension-origin requests are allowed or rely on Chrome extension host
  permissions during local testing.
