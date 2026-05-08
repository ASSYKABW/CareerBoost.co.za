# Tier C Job Import

This document describes CareerBoost's user-initiated job capture path. A trusted
browser extension, or another explicit user action, POSTs a normalized job
payload to Supabase Edge Function `job-import`.

This is intentionally **not** server-side scraping of third-party HTML. The user,
or extension acting on explicit user action, supplies the fields.

## Endpoint

`POST /functions/v1/job-import`

Headers:

- `Authorization: Bearer <supabase_user_access_token>`
- `Content-Type: application/json`
- `apikey: <supabase_anon_key>`

## Request Body

```json
{
  "vendor": "linkedin",
  "captureMethod": "extension",
  "target": "pipeline",
  "pageUrl": "https://www.linkedin.com/jobs/view/1234567890/",
  "job": {
    "title": "Software Engineer",
    "company": "Acme",
    "location": "Remote - US",
    "url": "https://www.linkedin.com/jobs/view/1234567890/",
    "remote": true,
    "postedAt": null,
    "tags": ["linkedin", "react"],
    "descriptionText": "Job description snapshot...",
    "salary": null,
    "logo": null
  }
}
```

## Field Rules

- `vendor`: lowercase identifier such as `linkedin`, `greenhouse`, or `lever`
- `target`: `saved_jobs`, `pipeline`, or `both`; omitted defaults to `saved_jobs`
- `job.url`: must normalize to an `http(s)` URL
- `job.title`: required
- `descriptionText`: optional and truncated server-side

## Dedupe

For `saved_jobs`, `external_id` is deterministic:

`capture:<vendor>:<canonical_url_without_fragment>`

For `pipeline`, the function checks the user's existing `applications.source_url`
and updates that row if the same listing was already imported.

## Response

```json
{
  "ok": true,
  "target": "pipeline",
  "savedJob": null,
  "application": {
    "id": "...",
    "company": "Acme",
    "role": "Software Engineer",
    "stage": "saved",
    "source_url": "https://www.linkedin.com/jobs/view/1234567890/"
  }
}
```

## Extension MVP

- Chrome extension MVP lives in `extension/`.
- LinkedIn content script injects **Save to CareerBoost** on job pages.
- User reviews a preview modal before saving.
- The extension signs in with CareerBoost/Supabase Auth.
- LinkedIn credentials are never stored.

## Next Steps

- Map imported `saved_jobs` rows into V2 client job cards when `target` is not
  `pipeline`.
- Add adapters for Indeed, Greenhouse, Lever, and company ATS pages.
