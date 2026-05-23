// Public landing page shown to signed-out visitors.
//
// Redesigned for a clean, modern, presentable layout:
//   1. Slim sticky nav — logo + 4 anchor links + 2 CTAs
//   2. Hero — eyebrow + bold H1 + subtitle + dual CTA + product mock
//   3. Trust strip — 4 stat chips (no credit card, etc.)
//   4. Features — 3-up large cards, clean icons, no decorative chrome
//   5. How it works — 4 numbered steps in a row
//   6. Pricing — 4-card grid (Free / Plus / Pro / Career)
//   7. FAQ — collapsible details
//   8. Final CTA — gradient panel, single bold button
//   9. Footer — minimal
//
// Class prefix changed cb8- → lp- (landing page) so the new styles
// don't conflict with the legacy cb8-* CSS still living in
// styles/phase1.css. Once the new design is verified the cb8-* rules
// can be deleted in a cleanup pass.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  // ─── Content data ──────────────────────────────────────────────────
  // Kept separate from rendering so copy is easy to update.

  // Each feature carries a tone key — the CSS maps tones to distinct
  // accent colors so the feature grid isn't all one teal shade.
  const FEATURES = [
    {
      icon: "fa-bullseye",
      title: "Role intelligence",
      tone: "cyan",
      body: "See fit score, seniority, work mode, and timing for every role you save. Spend your energy on the roles that deserve it."
    },
    {
      icon: "fa-wand-magic-sparkles",
      title: "AI tailoring",
      tone: "violet",
      body: "Turn one resume into role-ready versions. Real experience stays intact — keywords + bullets adapt to the job description."
    },
    {
      icon: "fa-comments",
      title: "Voice mock interviews",
      tone: "rose",
      body: "Practice with four distinct AI interviewers. Speak your answer, hear the next question, get a structured debrief."
    },
    {
      icon: "fa-table-list",
      title: "Pipeline tracking",
      tone: "green",
      body: "Saved · Applied · Interview · Offer. Every role flows through six stages with notes, reminders, and outcomes attached."
    },
    {
      icon: "fa-magnifying-glass-chart",
      title: "Company research",
      tone: "amber",
      body: "Source-backed briefings: process signals, likely questions, prep checklist, and reading list — generated for the exact role."
    },
    {
      icon: "fa-calendar-check",
      title: "Calendar + reminders",
      tone: "blue",
      body: "Export every event to Google or Apple Calendar. Browser reminders fire before the call — even with the tab in the background."
    }
  ];

  // Footer sitemap. Real SaaS-style footer with 3 link columns + a
  // brand column. Anchor links point to in-page sections; full pages
  // can be added later by routing the href targets.
  const FOOTER_COLS = [
    {
      heading: "Product",
      links: [
        { label: "Features",       href: "#features" },
        { label: "How it works",   href: "#how" },
        { label: "Pricing",        href: "#pricing" },
        { label: "Chrome extension", href: "#/settings?tab=extension" },
        { label: "Voice interviews", href: "#features" },
      ]
    },
    {
      heading: "Resources",
      links: [
        { label: "FAQ",            href: "#faq" },
        { label: "Help center",    href: "#faq" },
        { label: "What's new",     href: "#features" },
        // Week 2 #6: Status page lives on Better Stack's default URL
        // (their free careerboost.betteruptime.com subdomain).
        // We attempted a custom status.careerboost.co.za subdomain
        // but the DNS CNAME wiring on the operator's domain provider
        // ran into UI friction. Better Stack default URL is functional
        // + has SSL out of the box; the custom subdomain is a vanity
        // upgrade we can revisit later. To swap back to the custom
        // domain: change href to "https://status.careerboost.co.za"
        // and ensure the CNAME `status` -> `statuspage.betteruptime.com`
        // exists at the DNS provider.
        { label: "Status",         href: "https://careerboost.betteruptime.com", external: true },
      ]
    },
    {
      heading: "Company",
      links: [
        { label: "About",          href: "#" },
        { label: "Contact",        href: "mailto:hello@careerboost.app" },
        { label: "Privacy",        href: "#/privacy" },
        { label: "Terms",          href: "#/terms" },
      ]
    }
  ];

  // P1: social profiles aren't live yet. Rather than ship dead "#" links
  // that confuse visitors, mark unbuilt socials as disabled with a
  // "Coming soon" tooltip. The Email tile stays live since it's a real
  // mailto: link. When you create the LinkedIn/X/GitHub accounts, just
  // swap href + drop the `pending: true` flag.
  const SOCIAL_LINKS = [
    { label: "LinkedIn",    icon: "fa-linkedin-in", href: "#", brand: true,  pending: true },
    { label: "Twitter / X", icon: "fa-x-twitter",   href: "#", brand: true,  pending: true },
    { label: "GitHub",      icon: "fa-github",      href: "#", brand: true,  pending: true },
    { label: "Email",       icon: "fa-envelope",    href: "mailto:hello@careerboost.app", brand: false, pending: false },
  ];

  const STEPS = [
    { n: "1", title: "Sign up free", body: "30 seconds. No card required. Set your role target and import your resume." },
    { n: "2", title: "Research the role", body: "Build a source-backed brief: process, likely questions, what to prep." },
    { n: "3", title: "Tailor + practice", body: "Generate role-ready resumes and cover letters. Rehearse with the AI interviewer." },
    { n: "4", title: "Track every move", body: "Pipeline + reminders keep follow-ups visible. Mark interviews + offers as they happen." }
  ];

  const TRUST_STRIP = [
    { icon: "fa-credit-card", title: "$0 to start", sub: "No card required" },
    { icon: "fa-user-check",  title: "Human-in-control", sub: "You approve every move" },
    { icon: "fa-shield-halved", title: "Private by default", sub: "Your data, your records" },
    { icon: "fa-file-export", title: "Export anytime", sub: "Portable + structured" }
  ];

  const FAQS = [
    {
      q: "Who is CareerBoost for?",
      a: "Active job seekers who want one organized system for research, tailoring, applications, follow-ups, and interview prep — without auto-apply spam."
    },
    {
      q: "Does it submit applications for me?",
      a: "No. CareerBoost is human-in-control by design. We help you research, tailor, and rehearse — you review and submit every application yourself."
    },
    {
      q: "Can I use my existing resume?",
      a: "Yes. Upload your current resume or paste it as text. Every tailored variant starts from your real experience — we don't invent things."
    },
    {
      q: "What's included in the free plan?",
      a: "Full pipeline tracking, the Chrome extension, calendar reminders, plus monthly AI quotas: 1 resume tailor, 2 cover letters, 1 mock interview, 1 research brief, 5 saved jobs."
    },
    {
      q: "Can I cancel anytime?",
      a: "Yes. Cancel from Billing Settings — you keep access until the end of your billing period. Refunds within 14 days, no questions."
    },
    {
      q: "Do you have voice mock interviews?",
      a: "Yes — on the Pro and Career plans. Pick a persona (friendly recruiter, technical lead, executive panel, or hostile skeptic), then speak your answers and hear the AI respond in real time."
    }
  ];

  // ─── Brand lockup (used in nav + footer) ───────────────────────────
  // The CareerBoost logo file is a FULL LOCKUP — it already contains
  // the diamond icon, the "CareerBoost" wordmark, AND the "BUILT FOR
  // AMBITION" tagline. So we render the image alone; no separate
  // text labels are added next to it (that would duplicate what's in
  // the image).
  //
  // Replace strategy: drop a different `logo.svg` (or .png) into
  // `v2/src/assets/` to change the lockup. If the user provides
  // an icon-only mark (1:1 aspect ratio), drop it as `logo-mark.svg`
  // — the nav at very narrow viewports prefers the mark.
  function renderBrand() {
    return (
      '<span class="lp-brand lp-brand--lockup">' +
        '<img class="lp-brand-img" src="./src/assets/logo.svg" alt="CareerBoost"' +
        ' onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src=\'./src/assets/logo-default.svg\';}" />' +
      '</span>'
    );
  }

  // Footer-only larger brand block: logo + tagline + social row.
  function renderFooterBrand() {
    const socials = SOCIAL_LINKS.map(function (s) {
      const cls = s.brand ? "fa-brands" : "fa-solid";
      const isPending = !!s.pending;
      // P1: render pending socials as <span> (not clickable) with a
      // "Coming soon" tooltip + disabled styling. aria-disabled tells
      // screen readers they're inactive. Live ones stay as <a>.
      if (isPending) {
        return (
          '<span class="lp-social lp-social--pending" aria-label="' + s.label + ' — coming soon" aria-disabled="true" title="' + s.label + ' — coming soon">' +
            '<i class="' + cls + ' ' + s.icon + '" aria-hidden="true"></i>' +
          '</span>'
        );
      }
      return (
        '<a href="' + s.href + '" class="lp-social" aria-label="' + s.label + '" title="' + s.label + '">' +
          '<i class="' + cls + ' ' + s.icon + '" aria-hidden="true"></i>' +
        '</a>'
      );
    }).join("");
    return (
      '<div class="lp-footer-brand-col">' +
        renderBrand() +
        '<p class="lp-footer-tagline">A calm, AI-powered workspace for ambitious job seekers. Research roles, tailor every application, rehearse interviews, track every move.</p>' +
        '<div class="lp-social-row">' + socials + '</div>' +
      '</div>'
    );
  }

  // ─── Hero visual: clean dashboard preview, no busy chrome ─────────
  function renderHeroMock() {
    return (
      '<div class="lp-hero-mock" aria-hidden="true">' +
        '<div class="lp-mock-window">' +
          '<div class="lp-mock-bar">' +
            '<span></span><span></span><span></span>' +
            '<em>careerboost.app</em>' +
          '</div>' +
          '<div class="lp-mock-body">' +
            '<div class="lp-mock-rail">' +
              '<b class="is-active"><i class="fa-solid fa-table-columns"></i> Pipeline</b>' +
              '<b><i class="fa-solid fa-file-lines"></i> Resume</b>' +
              '<b><i class="fa-solid fa-comments"></i> Interview</b>' +
              '<b><i class="fa-solid fa-calendar"></i> Calendar</b>' +
            '</div>' +
            '<div class="lp-mock-main">' +
              '<div class="lp-mock-head">' +
                '<div>' +
                  '<span>This week</span>' +
                  '<strong>Move 5 high-fit roles forward</strong>' +
                '</div>' +
                '<span class="lp-mock-pill">94% ready</span>' +
              '</div>' +
              '<div class="lp-mock-stages">' +
                '<span class="is-done">Saved</span>' +
                '<span class="is-done">Tailor</span>' +
                '<span class="is-active">Apply</span>' +
                '<span>Interview</span>' +
                '<span>Offer</span>' +
              '</div>' +
              '<div class="lp-mock-cards">' +
                '<article class="lp-mock-card lp-mock-card--score">' +
                  '<span>Top role fit</span>' +
                  '<strong>94%</strong>' +
                  '<small>Product Engineer · Remote</small>' +
                '</article>' +
                '<article class="lp-mock-card lp-mock-card--action">' +
                  '<span>Next best action</span>' +
                  '<strong>Tailor resume before Friday</strong>' +
                  '<small>3 matched skills, 1 proof point</small>' +
                '</article>' +
              '</div>' +
              '<ul class="lp-mock-roles">' +
                '<li><b>89%</b> Frontend Engineer · Hybrid <em>Follow up</em></li>' +
                '<li><b>84%</b> Growth Analyst · Remote <em>Prep stories</em></li>' +
                '<li><b>78%</b> Operations Associate · On-site <em>Review fit</em></li>' +
              '</ul>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // ─── Render helpers ────────────────────────────────────────────────

  function renderFeature(f) {
    const tone = f.tone || "cyan";
    return (
      '<article class="lp-feature lp-feature--' + tone + '">' +
        '<span class="lp-feature-icon"><i class="fa-solid ' + f.icon + '" aria-hidden="true"></i></span>' +
        '<h3>' + f.title + '</h3>' +
        '<p>' + f.body + '</p>' +
      '</article>'
    );
  }

  function renderStep(s, index) {
    return (
      '<article class="lp-step">' +
        '<span class="lp-step-num">' + s.n + '</span>' +
        '<h3>' + s.title + '</h3>' +
        '<p>' + s.body + '</p>' +
      '</article>'
    );
  }

  function renderTrustChip(t) {
    return (
      '<article class="lp-trust-chip">' +
        '<i class="fa-solid ' + t.icon + '" aria-hidden="true"></i>' +
        '<div><strong>' + t.title + '</strong><span>' + t.sub + '</span></div>' +
      '</article>'
    );
  }

  function renderFaq(f) {
    return (
      '<details class="lp-faq">' +
        '<summary>' + f.q + '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>' +
        '<p>' + f.a + '</p>' +
      '</details>'
    );
  }

  // ─── Page render ───────────────────────────────────────────────────

  function renderView() {
    const features = FEATURES.map(renderFeature).join("");
    const steps = STEPS.map(renderStep).join("");
    const trustChips = TRUST_STRIP.map(renderTrustChip).join("");
    const faqs = FAQS.map(renderFaq).join("");

    return (
      '<main class="lp-page">' +

        // ── Sticky nav ─────────────────────────────────────────────
        '<header class="lp-nav">' +
          '<div class="lp-nav-inner">' +
            '<a class="lp-nav-brand" href="#/welcome" aria-label="CareerBoost home">' + renderBrand() + '</a>' +
            '<nav class="lp-nav-links" aria-label="Landing navigation">' +
              '<a href="#features">Features</a>' +
              '<a href="#how">How it works</a>' +
              '<a href="#pricing">Pricing</a>' +
              '<a href="#faq">FAQ</a>' +
            '</nav>' +
            '<div class="lp-nav-actions">' +
              '<a class="lp-nav-link" href="#/auth">Sign in</a>' +
              '<a class="lp-btn lp-btn--primary lp-btn--sm" href="#/auth?mode=signup">Start free</a>' +
            '</div>' +
          '</div>' +
        '</header>' +

        // ── Hero ───────────────────────────────────────────────────
        '<section class="lp-hero" id="hero">' +
          '<div class="lp-hero-inner">' +
            '<div class="lp-hero-copy">' +
              '<span class="lp-eyebrow"><i class="fa-solid fa-shield-halved"></i> Private AI career operating system</span>' +
              '<h1>Your job search,<br/>engineered like a command center.</h1>' +
              '<p class="lp-hero-sub">Research the role. Tailor the resume. Rehearse the interview. Track every move. One calm workspace — designed for serious job seekers, not auto-apply spam.</p>' +
              '<div class="lp-hero-actions">' +
                '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/auth?mode=signup"><i class="fa-solid fa-rocket"></i> Start free</a>' +
                '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#features">See how it works <i class="fa-solid fa-arrow-down"></i></a>' +
              '</div>' +
              '<p class="lp-hero-meta">No credit card required · Cancel anytime · USD pricing</p>' +
            '</div>' +
            '<div class="lp-hero-visual">' + renderHeroMock() + '</div>' +
          '</div>' +
        '</section>' +

        // ── Trust strip ────────────────────────────────────────────
        '<section class="lp-trust-strip" aria-label="Trust signals">' +
          '<div class="lp-container">' +
            '<div class="lp-trust-grid">' + trustChips + '</div>' +
          '</div>' +
        '</section>' +

        // ── Features ───────────────────────────────────────────────
        '<section class="lp-section" id="features">' +
          '<div class="lp-container">' +
            '<header class="lp-section-head">' +
              '<span class="lp-eyebrow">Features</span>' +
              '<h2>Everything your job search needs, in one place.</h2>' +
              '<p>Stop juggling tabs, spreadsheets, and AI prompts. CareerBoost is the workspace where research, tailoring, practice, and tracking actually connect.</p>' +
            '</header>' +
            '<div class="lp-feature-grid">' + features + '</div>' +
          '</div>' +
        '</section>' +

        // ── How it works ───────────────────────────────────────────
        '<section class="lp-section lp-section--alt" id="how">' +
          '<div class="lp-container">' +
            '<header class="lp-section-head">' +
              '<span class="lp-eyebrow">How it works</span>' +
              '<h2>Four steps from signup to offer.</h2>' +
              '<p>A weekly rhythm built around action — not data entry.</p>' +
            '</header>' +
            '<div class="lp-step-grid">' + steps + '</div>' +
          '</div>' +
        '</section>' +

        // ── Pricing ────────────────────────────────────────────────
        '<section class="lp-section" id="pricing">' +
          '<div class="lp-container">' +
            '<header class="lp-section-head">' +
              '<span class="lp-eyebrow">Pricing</span>' +
              '<h2>Start free. Upgrade when your search needs more power.</h2>' +
              '<p>Cancel anytime. Annual billing saves ~17%. All paid plans unlock more AI tailoring and voice mock interviews.</p>' +
            '</header>' +
            '<div class="lp-pricing-grid">' +
              // Free
              '<article class="lp-price-card">' +
                '<h3>Free</h3>' +
                '<p class="lp-price-fit">Try the workflow.</p>' +
                '<div class="lp-price-amount"><strong>$0</strong><span>/month</span></div>' +
                '<ul class="lp-price-list">' +
                  '<li>1 AI resume tailor / mo</li>' +
                  '<li>2 cover letters / mo</li>' +
                  '<li>1 mock interview / mo (text)</li>' +
                  '<li>1 company research / mo</li>' +
                  '<li>5 saved jobs</li>' +
                  '<li>Full pipeline + extension</li>' +
                '</ul>' +
                '<a class="lp-btn lp-btn--ghost lp-btn--block" href="#/auth?mode=signup" data-plan-cta="free">Start free</a>' +
              '</article>' +
              // Plus
              '<article class="lp-price-card">' +
                '<h3>Plus</h3>' +
                '<p class="lp-price-fit">For active job seekers.</p>' +
                '<div class="lp-price-amount"><strong>$9.99</strong><span>/month</span></div>' +
                '<ul class="lp-price-list">' +
                  '<li>10 resume tailorings / mo</li>' +
                  '<li>15 cover letters / mo</li>' +
                  '<li>3 mock interviews / mo</li>' +
                  '<li>5 company research / mo</li>' +
                  '<li>100 saved jobs</li>' +
                  '<li>All 4 personas (text)</li>' +
                '</ul>' +
                '<a class="lp-btn lp-btn--ghost lp-btn--block" href="#/auth?mode=signup&plan=plus" data-plan-cta="plus">Get Plus</a>' +
              '</article>' +
              // Pro (featured)
              '<article class="lp-price-card lp-price-card--featured">' +
                '<span class="lp-price-badge">Most popular</span>' +
                '<h3>Pro</h3>' +
                '<p class="lp-price-fit">Daily applications + voice mock.</p>' +
                '<div class="lp-price-amount"><strong>$19.99</strong><span>/month</span></div>' +
                '<ul class="lp-price-list">' +
                  '<li><b>Unlimited</b> resumes + covers</li>' +
                  '<li>10 voice mock interviews / mo</li>' +
                  '<li><b>Unlimited</b> research</li>' +
                  '<li><b>Unlimited</b> saved jobs</li>' +
                  '<li>Voice mode + all personas</li>' +
                  '<li>Personal analytics</li>' +
                '</ul>' +
                '<a class="lp-btn lp-btn--primary lp-btn--block" href="#/auth?mode=signup&plan=pro" data-plan-cta="pro">Get Pro</a>' +
              '</article>' +
              // Career
              '<article class="lp-price-card">' +
                '<h3>Career</h3>' +
                '<p class="lp-price-fit">Executives + career changers.</p>' +
                '<div class="lp-price-amount"><strong>$39.99</strong><span>/month</span></div>' +
                '<ul class="lp-price-list">' +
                  '<li>Everything unlimited</li>' +
                  '<li>Unlimited voice mocks</li>' +
                  '<li>Priority AI (faster + smarter)</li>' +
                  '<li>Personal analytics</li>' +
                  '<li>Priority support (&lt;24h)</li>' +
                '</ul>' +
                '<a class="lp-btn lp-btn--ghost lp-btn--block" href="#/auth?mode=signup&plan=career" data-plan-cta="career">Get Career</a>' +
              '</article>' +
            '</div>' +
            '<p class="lp-pricing-foot">Secure payment via Stripe. USD pricing. Cancel anytime from Billing settings.</p>' +
          '</div>' +
        '</section>' +

        // ── FAQ ────────────────────────────────────────────────────
        '<section class="lp-section lp-section--alt" id="faq">' +
          '<div class="lp-container lp-container--narrow">' +
            '<header class="lp-section-head lp-section-head--left">' +
              '<span class="lp-eyebrow">FAQ</span>' +
              '<h2>Questions before you start.</h2>' +
            '</header>' +
            '<div class="lp-faq-list">' + faqs + '</div>' +
          '</div>' +
        '</section>' +

        // ── Final CTA — richer panel with stats + dual buttons ────
        '<section class="lp-final">' +
          '<div class="lp-container">' +
            '<div class="lp-final-card">' +
              '<div class="lp-final-glow lp-final-glow-a" aria-hidden="true"></div>' +
              '<div class="lp-final-glow lp-final-glow-b" aria-hidden="true"></div>' +
              '<div class="lp-final-copy">' +
                '<span class="lp-eyebrow">Ready when you are</span>' +
                '<h2>Run your job search<br/>like a professional.</h2>' +
                '<p>One calm workspace for research, tailoring, mock interviews, and follow-ups. Free to start, no credit card required.</p>' +
                '<div class="lp-final-actions">' +
                  '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/auth?mode=signup"><i class="fa-solid fa-rocket"></i> Start free</a>' +
                  '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#pricing">See pricing</a>' +
                '</div>' +
              '</div>' +
              '<div class="lp-final-stats" aria-hidden="true">' +
                '<article><strong>4</strong><span>AI personas to practice against</span></article>' +
                '<article><strong>6</strong><span>pipeline stages, fully tracked</span></article>' +
                '<article><strong>$0</strong><span>to start — no card needed</span></article>' +
                '<article><strong>∞</strong><span>on Pro: resumes + covers + research</span></article>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +

        // ── Real footer — 4-column SaaS layout + bottom bar ───────
        '<footer class="lp-footer">' +
          '<div class="lp-container">' +
            '<div class="lp-footer-grid">' +
              renderFooterBrand() +
              FOOTER_COLS.map(function (col) {
                return (
                  '<div class="lp-footer-col">' +
                    '<h4>' + col.heading + '</h4>' +
                    '<ul>' +
                      col.links.map(function (l) {
                        // External links (Status page on a different
                        // subdomain etc.) open in a new tab and use
                        // rel=noopener to drop window.opener access.
                        const attrs = l.external
                          ? ' target="_blank" rel="noopener noreferrer"'
                          : '';
                        return '<li><a href="' + l.href + '"' + attrs + '>' + l.label + '</a></li>';
                      }).join("") +
                    '</ul>' +
                  '</div>'
                );
              }).join("") +
            '</div>' +
            '<div class="lp-footer-bar">' +
              '<p>&copy; ' + new Date().getFullYear() + ' CareerBoost. All rights reserved.</p>' +
              '<div class="lp-footer-legal">' +
                '<a href="#/privacy">Privacy</a>' +
                '<a href="#/terms">Terms</a>' +
                '<a href="#/privacy">Cookies</a>' +
                '<a href="#faq">FAQ</a>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</footer>' +
      '</main>'
    );
  }

  // ─── Tracking + pricing CTA wiring (preserved from prior pass) ────
  function bindLandingTracking() {
    const root = document.querySelector(".lp-page");
    if (!root) return;

    try {
      const telemetry = window.CBAI && window.CBAI.telemetry;
      if (telemetry && typeof telemetry.track === "function") {
        telemetry.track({ type: "landing", event: "landing_view", route: "welcome", status: "success" });
      }
    } catch (error) { /* never block landing on telemetry */ }

    // Pricing CTA: if signed in + paid plan clicked, route straight to
    // Stripe Checkout. Otherwise fall through to the signup link.
    document.querySelectorAll("[data-plan-cta]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        const planId = link.getAttribute("data-plan-cta") || "";
        try {
          const telemetry = window.CBAI && window.CBAI.telemetry;
          if (telemetry && typeof telemetry.track === "function") {
            telemetry.track({ type: "landing", event: "pricing_cta_click", planId: planId, status: "success" });
          }
        } catch (e) { /* ignore */ }
        if (planId === "free") return;
        const auth = window.CBV2 && window.CBV2.auth;
        const modal = window.CBV2 && window.CBV2.upgradeModal;
        if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) return;
        if (!modal || !modal.startCheckout) return;
        event.preventDefault();
        modal.startCheckout(planId, "monthly").then(function (url) {
          window.location.href = url;
        }).catch(function (err) {
          if (window.CBV2.toast) {
            window.CBV2.toast.error(err && err.message ? err.message : "Checkout failed. Try again.");
          }
        });
      });
    });
  }

  window.CBV2.routes.welcome = renderView;
  window.CBV2.afterRender.welcome = bindLandingTracking;
})();
