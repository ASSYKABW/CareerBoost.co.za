// Privacy Policy — public route (no auth required).
//
// Companion to terms.route.js. Linked from the landing footer + the
// auth signup legal copy. Registered as a PUBLIC_ROUTE in bootstrap.js
// so signed-out visitors can read it before signing up.
//
// IMPORTANT: this is plain-language honest disclosure, not a substitute
// for legal review. Before any launch where regulatory exposure matters
// (especially GDPR / CCPA / sensitive employment data), have a lawyer
// review this text and the data practices it describes.

(function () {
  window.CBV2 = window.CBV2 || {};

  // Update this string + the section content together whenever the data
  // practices change. The visible date helps users (and auditors) see
  // when terms last shifted.
  const LAST_UPDATED = "May 17, 2026";

  function renderView() {
    return `
      <section class="page-container legal-page">
        <header class="legal-page-head">
          <p class="eyebrow">Legal</p>
          <h1 class="page-title">Privacy Policy</h1>
          <p class="page-subtitle">How CareerBoost handles your data, in plain language.</p>
          <p class="legal-meta">Last updated: ${LAST_UPDATED}</p>
        </header>

        <article class="card panel-lg legal-body">
          <p>
            CareerBoost helps you find, track, and apply to jobs. To do that we
            store the data <em>you</em> give us (your profile, resume, saved
            jobs, application notes) and a small amount of operational
            telemetry. This page explains exactly what we collect, why, and
            what your rights are. If anything here is unclear, contact us at
            the address at the bottom.
          </p>

          <h2>1. What we collect</h2>
          <ul>
            <li><strong>Account info:</strong> your name, email, and
              authentication identifiers (Supabase auth ID, optionally a
              Google ID when you sign in with Google). Email is used to
              identify your account, send confirmations / password resets,
              and reach you if there's a security issue.</li>
            <li><strong>Profile data you enter:</strong> headline, role
              targets, work-search preferences, the contents of your
              uploaded or pasted resume, cover letters, interview-prep
              transcripts, calendar events, application notes.</li>
            <li><strong>Application activity:</strong> the jobs you save,
              the pipeline stages you assign them to, the dates you applied,
              and any notes you attach. We treat this as your personal
              workspace.</li>
            <li><strong>AI conversation context:</strong> when you use AI
              features (resume tailor, cover letter, mock interview, chat
              guidance), the prompts and the AI responses are processed by
              third-party AI providers (see §3) and a per-call audit row is
              stored in our database for billing, abuse detection, and
              service-quality monitoring.</li>
            <li><strong>Operational telemetry:</strong> error reports,
              page-load timings, AI request latency, feature usage events.
              We strip personally identifying values from telemetry
              client-side before transmission (see <code>BLOCKED_METADATA_KEYS</code>
              in our observability module).</li>
            <li><strong>Billing data:</strong> if you subscribe to a paid
              plan, Stripe handles payment processing. We never see or store
              your card details — Stripe sends us a customer ID and
              subscription status, nothing more.</li>
          </ul>

          <h2>2. What we don't collect</h2>
          <ul>
            <li>We don't run advertising trackers. No Google Ads, no
              Facebook Pixel, no behavioral profiling beyond what's needed
              to run your account.</li>
            <li>We don't sell your data. We don't share data with anyone
              except the service providers listed below, and only what's
              needed to deliver the service.</li>
            <li>We don't scrape your inbox, LinkedIn messages, or any other
              system you didn't explicitly connect.</li>
          </ul>

          <h2>3. Who we share it with</h2>
          <p>
            We share the minimum data needed with these service providers.
            Each is bound by their own privacy terms; we don't grant them
            broader access than the feature requires.
          </p>
          <ul>
            <li><strong>Supabase</strong> (hosting + auth + database) —
              stores your account, profile, and application data. Hosted
              in the AWS region you can see in our <code>SUPABASE_URL</code>
              configuration.</li>
            <li><strong>AI providers</strong> — Anthropic (Claude), OpenAI,
              Google (Gemini), and Groq are called for AI features. Only the
              specific prompt for that feature (e.g. your resume text + the
              job description for a tailor) is sent. We do not allow these
              providers to train on your data; we use their API tiers that
              disable training by default.</li>
            <li><strong>Stripe</strong> — handles billing when you subscribe.
              Email + customer ID only.</li>
            <li><strong>Job board APIs</strong> — when you search jobs we
              query public APIs (Remotive, Arbeitnow, Jobicy, Adzuna, Google
              Programmable Search). Your search keywords are sent to them; no
              account or resume data leaves us.</li>
          </ul>

          <h2>4. How long we keep it</h2>
          <p>
            We keep your data for as long as your account exists. You can
            delete your account at any time from <a href="#/settings?tab=data-privacy">Settings
            → Data &amp; Privacy</a>. When you do, we purge your profile,
            applications, resumes, AI history, and telemetry within a few
            seconds. We retain a small audit row (the deletion event itself)
            for compliance with anti-fraud and tax obligations, but it
            contains no personal data beyond a hash of your former user ID.
          </p>
          <p>
            Inactive accounts (no sign-in for 24 months) get an email
            warning, then are scheduled for the same deletion process if
            they remain inactive after the warning.
          </p>

          <h2>5. Your rights</h2>
          <ul>
            <li><strong>Access:</strong> view everything in your account at
              any time inside the app.</li>
            <li><strong>Export:</strong> Settings → Data &amp; Privacy →
              "Export data (JSON)" gives you a downloadable bundle of every
              piece of personal data we hold.</li>
            <li><strong>Correct:</strong> edit anything from inside the
              Settings or feature views.</li>
            <li><strong>Delete:</strong> the Delete Account button in
              Settings → Data &amp; Privacy removes everything (see §4).</li>
            <li><strong>Withdraw consent:</strong> you can disable AI
              personalization from Settings → AI Personalization. You can
              opt out of operational telemetry from the same tab.</li>
            <li>If you're in the EU/UK/Switzerland (GDPR) or California
              (CCPA), you have the additional right to lodge a complaint
              with your local data-protection authority and to ask us not
              to sell your data — which we already don't.</li>
          </ul>

          <h2>6. Cookies &amp; local storage</h2>
          <p>
            We use a small amount of browser storage for essential
            functions: keeping you signed in, remembering your theme
            preference, caching parts of the app so it loads fast on
            return visits, and storing the AI Chat panel's quota count.
            We do not use third-party advertising cookies.
          </p>

          <h2>7. Children</h2>
          <p>
            CareerBoost is not directed at children under 16 and we do not
            knowingly collect their data. If you believe a minor has signed
            up, contact us and we'll delete the account.
          </p>

          <h2>8. International transfers</h2>
          <p>
            Our database lives in the AWS region configured in our Supabase
            project. If you're in a country with stricter data-export rules
            than the region of our database, please be aware your data may
            move across borders when you use the service. The legal basis
            for transfer is the standard contractual clauses incorporated
            by reference in our service providers' agreements.
          </p>

          <h2>9. Security</h2>
          <p>
            All traffic is TLS-encrypted. Database access is row-level
            secured: every query is scoped to your own user ID via
            Postgres RLS policies, so a vulnerability in one tenant's data
            cannot expose another's. AI API keys, Stripe keys, and other
            secrets live in Supabase Edge Function environment variables
            and never appear in client-side code. We don't store any AI
            provider keys, OAuth tokens, or payment credentials in our
            database.
          </p>

          <h2>10. Changes to this policy</h2>
          <p>
            If we make material changes, we'll notify signed-in users via
            an in-app banner and email at least 30 days before the change
            takes effect. The "Last updated" date at the top of this page
            always reflects the current version.
          </p>

          <h2>11. Contact</h2>
          <p>
            Questions, complaints, data-subject requests, or anything else
            about this policy: <a href="mailto:privacy@careerboost.co.za">privacy@careerboost.co.za</a>.
          </p>

          <p class="legal-foot">
            <a href="#/welcome">← Back to home</a> &nbsp;·&nbsp;
            <a href="#/terms">Terms of Service →</a>
          </p>
        </article>
      </section>
    `;
  }

  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.routes.privacy = renderView;
})();
