// Terms of Service — public route (no auth required).
//
// Companion to privacy.route.js. Linked from the landing footer + the
// auth signup legal copy. Registered as a PUBLIC_ROUTE in bootstrap.js.
//
// IMPORTANT: plain-language honest terms, not a substitute for legal
// review. Before launches with regulatory exposure (esp. paid plans,
// EU users, or AI-content liability), have a lawyer review.

(function () {
  window.CBV2 = window.CBV2 || {};

  const LAST_UPDATED = "May 17, 2026";

  function renderView() {
    return `
      <section class="page-container legal-page">
        <header class="legal-page-head">
          <p class="eyebrow">Legal</p>
          <h1 class="page-title">Terms of Service</h1>
          <p class="page-subtitle">The rules of using CareerBoost, in plain language.</p>
          <p class="legal-meta">Last updated: ${LAST_UPDATED}</p>
        </header>

        <article class="card panel-lg legal-body">
          <p>
            By creating an account or using CareerBoost, you agree to
            these terms. They're written to be readable, not to hide
            anything. If something doesn't sit right, contact us at the
            address at the bottom before signing up.
          </p>

          <h2>1. What CareerBoost is</h2>
          <p>
            CareerBoost is a software workspace for job seekers: pipeline
            tracking, resume editing, AI-assisted tailoring and cover
            letters, mock interviews, calendar reminders, and a browser
            extension that captures jobs from supported boards. We don't
            apply to jobs on your behalf — every submission is a human
            click by you.
          </p>

          <h2>2. Your account</h2>
          <ul>
            <li>You must be at least 16 years old to create an account.</li>
            <li>You're responsible for keeping your password (or OAuth
              login) secure. Tell us immediately if you suspect unauthorised
              access.</li>
            <li>One account per person. Sharing accounts violates these
              terms and risks suspension.</li>
            <li>You can close your account at any time from Settings →
              Data &amp; Privacy. See the Privacy Policy for what happens
              to your data after deletion.</li>
          </ul>

          <h2>3. Acceptable use</h2>
          <p>You agree NOT to:</p>
          <ul>
            <li>Submit content that is illegal, fraudulent, defamatory,
              harassing, or that misrepresents your identity, experience,
              credentials, or work authorization on resumes / applications.</li>
            <li>Use the AI features to generate spam, mass-apply to
              unrelated roles, or fabricate work history.</li>
            <li>Reverse-engineer, scrape, or abuse our APIs beyond their
              published rate limits. We enforce per-user daily caps on AI
              calls and reserve the right to throttle or suspend abusive
              accounts.</li>
            <li>Use the browser extension to circumvent any job board's
              own terms of service. The extension fills forms; you submit
              them. You are responsible for following each board's rules.</li>
            <li>Resell, sublicense, or expose the service to other users
              outside your own account.</li>
          </ul>

          <h2>4. AI-generated content</h2>
          <p>
            AI features (resume tailor, cover letter, mock interview,
            chat guidance, bullet strengthen) are powered by third-party
            language models. AI output is a suggestion, not professional
            advice. We do not guarantee accuracy, suitability for any
            particular job, or that it won't include unintended phrasing.
          </p>
          <p>
            <strong>You are responsible for everything you submit on a job
            application.</strong> Always review AI-generated content before
            sending it to an employer. If the AI produces a metric, a
            credential, or a claim that isn't true of your actual
            experience, remove it before submission. Misrepresentation
            on a job application can have consequences — legal, professional,
            and reputational — that fall on you, not us.
          </p>
          <p>
            We use AI providers' standard API tiers, which do not train on
            your data by default. See the Privacy Policy for the list of
            providers and what we share with them.
          </p>

          <h2>5. Subscriptions and billing</h2>
          <ul>
            <li>Some features have monthly usage quotas. Free plans get a
              modest allowance; paid plans get more. The current quotas
              are visible in Settings → Billing &amp; Plan and on the
              landing-page pricing section.</li>
            <li>Paid subscriptions renew monthly until cancelled. Cancel
              anytime from Settings → Billing → "Manage in Stripe portal".
              You keep paid features until the end of the current period.</li>
            <li>Refunds: we refund unused paid time within 14 days of the
              most recent charge, no questions asked. After 14 days,
              refunds are case-by-case.</li>
            <li>We may change pricing with 30 days' notice. Existing
              subscriptions keep their current price for at least the next
              renewal cycle after a change announcement.</li>
          </ul>

          <h2>6. Your content stays yours</h2>
          <p>
            You own everything you upload, paste, or generate inside
            CareerBoost: your resume, cover letters, application notes,
            saved searches, custom prompts. We hold a non-exclusive,
            revocable licence to store, process, and display that content
            to you, and to send the necessary pieces to AI providers when
            you trigger an AI feature. We don't claim ownership and we
            don't reuse your content to train models.
          </p>

          <h2>7. Our content</h2>
          <p>
            The CareerBoost software, brand, design, copy, and prompts
            belong to us. You may use them solely for personal job-search
            purposes inside the product. Do not redistribute, repackage,
            or build a competing product on top of our prompts or
            outputs.
          </p>

          <h2>8. Termination</h2>
          <p>
            You can stop using CareerBoost at any time. We can suspend or
            terminate an account for repeated violation of these terms
            (especially §3 abusive use, §4 misrepresentation, or §5
            non-payment). For suspensions other than fraud, we'll give a
            warning first when reasonably possible.
          </p>

          <h2>9. Disclaimers</h2>
          <p>
            CareerBoost is provided "AS IS" and "AS AVAILABLE". We don't
            guarantee that:
          </p>
          <ul>
            <li>The service will be uninterrupted or error-free.</li>
            <li>AI output will help you get hired, get interviews, or land
              any specific job.</li>
            <li>Job board APIs will always return up-to-date or correct
              listings.</li>
            <li>The browser extension will work on every variant of every
              ATS form forever (selectors shift; we update when we can).</li>
          </ul>

          <h2>10. Limitation of liability</h2>
          <p>
            To the maximum extent allowed by law, our total liability for
            any claim related to CareerBoost is limited to the amount you
            paid us in the twelve months before the claim arose. We are
            not liable for indirect, incidental, or consequential damages
            (including lost income, missed opportunities, or reputational
            harm).
          </p>

          <h2>11. Changes to these terms</h2>
          <p>
            We may update these terms. If we make material changes we'll
            notify signed-in users in-app and by email at least 30 days
            before the change takes effect. Continued use after that
            counts as acceptance. The "Last updated" date at the top of
            this page always reflects the current version.
          </p>

          <h2>12. Governing law</h2>
          <p>
            These terms are governed by the law of the jurisdiction in
            which CareerBoost is operated. If a dispute arises and can't
            be resolved informally, we agree to attempt mediation before
            litigation.
          </p>

          <h2>13. Contact</h2>
          <p>
            Questions about these terms, billing disputes, or anything
            else: <a href="mailto:hello@careerboost.app">hello@careerboost.app</a>.
          </p>

          <p class="legal-foot">
            <a href="#/welcome">← Back to home</a> &nbsp;·&nbsp;
            <a href="#/privacy">Privacy Policy →</a>
          </p>
        </article>
      </section>
    `;
  }

  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.routes.terms = renderView;
})();
