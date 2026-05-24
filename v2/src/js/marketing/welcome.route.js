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
        { label: "Voice interviews", href: "#features" },
      ]
    },
    {
      heading: "Resources",
      links: [
        { label: "FAQ",            href: "#faq" },
        // Week 2 #6: Status page lives on Better Stack's default URL
        // (their free careerboost.betteruptime.com subdomain).
        // To swap to a custom status.careerboost.co.za later: change
        // href + add CNAME `status` -> `statuspage.betteruptime.com`.
        { label: "Status",         href: "https://careerboost.betteruptime.com", external: true },
      ]
    },
    {
      heading: "Company",
      links: [
        { label: "Contact support", href: "mailto:support@careerboost.co.za" },
        { label: "Privacy",        href: "#/privacy" },
        { label: "Terms",          href: "#/terms" },
      ]
    }
  ];

  // Only ship live social channels. When you create X / GitHub accounts,
  // push them into this array with their real hrefs.
  const SOCIAL_LINKS = [
    { label: "LinkedIn", icon: "fa-linkedin-in", href: "https://www.linkedin.com/company/120914243/", brand: true, external: true },
    { label: "Email",    icon: "fa-envelope",    href: "mailto:support@careerboost.co.za",            brand: false },
  ];

  const STEPS = [
    { n: "1", title: "Sign up free", body: "30 seconds. No card required. Set your role target and import your resume." },
    { n: "2", title: "Research the role", body: "Build a source-backed brief: process, likely questions, what to prep." },
    { n: "3", title: "Tailor + practice", body: "Generate role-ready resumes and cover letters. Rehearse with the AI interviewer." },
    { n: "4", title: "Track every move", body: "Pipeline + reminders keep follow-ups visible. Mark interviews + offers as they happen." }
  ];

  const TRUST_STRIP = [
    { icon: "fa-credit-card", title: "Free forever", sub: "No card to start" },
    { icon: "fa-user-check",  title: "You stay in control", sub: "You submit every application" },
    { icon: "fa-shield-halved", title: "Encrypted at rest", sub: "Per-user row-level security" },
    { icon: "fa-file-export", title: "Your data, exportable", sub: "One-click JSON download" }
  ];

  // Single source of truth for the pricing-card values. Numbers match
  // the plan_catalog (0027_paystack_billing.sql) so what the visitor
  // sees on the landing equals what PayStack / Stripe charges at
  // checkout. If you update plan_catalog, update here too — there's
  // no live fetch (would cost a roundtrip on landing render).
  const PRICING_TIERS = [
    {
      id: "free",
      name: "Free",
      fit: "Try the workflow.",
      zar: { monthly: 0, label: "R0" },
      usd: { monthly: 0, label: "$0" },
      features: [
        "1 AI resume tailor / mo",
        "2 cover letters / mo",
        "1 mock interview / mo (text)",
        "1 company research / mo",
        "5 saved jobs",
        "Full pipeline + extension",
      ],
      cta: "Start free",
      featured: false,
    },
    {
      id: "plus",
      name: "Plus",
      fit: "For active job seekers.",
      zar: { monthly: 179, label: "R179" },
      usd: { monthly: 9.99, label: "$9.99" },
      features: [
        "10 resume tailorings / mo",
        "15 cover letters / mo",
        "3 mock interviews / mo",
        "5 company research / mo",
        "100 saved jobs",
        "All 4 personas (text)",
      ],
      cta: "Get Plus",
      featured: false,
    },
    {
      id: "pro",
      name: "Pro",
      fit: "Daily applications + voice mock.",
      zar: { monthly: 349, label: "R349" },
      usd: { monthly: 19.99, label: "$19.99" },
      features: [
        "<b>Unlimited</b> resumes + covers",
        "10 voice mock interviews / mo",
        "<b>Unlimited</b> research",
        "<b>Unlimited</b> saved jobs",
        "Voice mode + all personas",
        "Personal analytics",
      ],
      cta: "Get Pro",
      featured: true,
      badge: "Most popular",
    },
    {
      id: "career",
      name: "Career",
      fit: "Executives + career changers.",
      zar: { monthly: 699, label: "R699" },
      usd: { monthly: 39.99, label: "$39.99" },
      features: [
        "Everything unlimited",
        "Unlimited voice mocks",
        "Priority AI (faster + smarter)",
        "Personal analytics",
        "Priority support (&lt;24h)",
      ],
      cta: "Get Career",
      featured: false,
    },
  ];

  // Detect a sensible default currency. South African visitors see ZAR
  // (matches PayStack billing); everyone else sees USD. The user can
  // override with the toggle. Reads from:
  //   1. localStorage saved preference (if user toggled before)
  //   2. navigator.language ("en-ZA" → ZAR)
  //   3. Intl resolved locale region (fallback for browsers without -ZA)
  //   4. Default USD
  function detectDefaultCurrency() {
    try {
      const saved = localStorage.getItem("cb_pricing_ccy");
      if (saved === "zar" || saved === "usd") return saved;
    } catch (e) { /* private mode */ }
    try {
      const lang = (navigator.language || "").toLowerCase();
      if (lang.indexOf("-za") >= 0 || lang === "af" || lang === "zu" || lang === "xh") return "zar";
      const region = (new Intl.Locale(navigator.language).region || "").toUpperCase();
      if (region === "ZA") return "zar";
    } catch (e) { /* old browser */ }
    return "usd";
  }

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

  // Footer-only larger brand block: logo + tagline + ZA origin + socials.
  function renderFooterBrand() {
    const socials = SOCIAL_LINKS.map(function (s) {
      const cls = s.brand ? "fa-brands" : "fa-solid";
      const ext = s.external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return (
        '<a href="' + s.href + '" class="lp-social" aria-label="' + s.label + '" title="' + s.label + '"' + ext + '>' +
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
            '<em>careerboost.co.za</em>' +
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

  // Render a single pricing card. Pulls amount + label from the
  // currency-specific block (zar / usd) on the tier.
  function renderPricingCard(tier, currency) {
    const price = tier[currency] || tier.usd;
    const featured = tier.featured ? " lp-price-card--featured" : "";
    const badge = tier.featured && tier.badge
      ? '<span class="lp-price-badge">' + tier.badge + '</span>'
      : '';
    const ctaCls = tier.featured ? "lp-btn--primary" : "lp-btn--ghost";
    const href = tier.id === "free"
      ? "#/auth?mode=signup"
      : "#/auth?mode=signup&plan=" + tier.id;
    const features = tier.features.map(function (line) {
      return '<li>' + line + '</li>';
    }).join("");
    return (
      '<article class="lp-price-card' + featured + '" data-tier="' + tier.id + '">' +
        badge +
        '<h3>' + tier.name + '</h3>' +
        '<p class="lp-price-fit">' + tier.fit + '</p>' +
        '<div class="lp-price-amount" data-price-amount="' + tier.id + '">' +
          '<strong>' + price.label + '</strong>' +
          '<span>/month</span>' +
        '</div>' +
        '<ul class="lp-price-list">' + features + '</ul>' +
        '<a class="lp-btn ' + ctaCls + ' lp-btn--block" href="' + href + '" data-plan-cta="' + tier.id + '">' + tier.cta + '</a>' +
      '</article>'
    );
  }

  // ─── Testimonials ──────────────────────────────────────────────────
  // Drop real quotes in here when you collect them. The section render
  // is gated by `TESTIMONIALS.length > 0` below — leave the array empty
  // and the section won't render. Don't ship fake ones; visitors can
  // smell fabricated social proof a mile away and it kills credibility.
  //
  // Shape:
  //   { quote: "...", name: "...", role: "...", company?: "..." }
  //
  // To add a quote:
  //   1. Get explicit permission from the person to publish their name.
  //   2. Push the object onto TESTIMONIALS below.
  //   3. (Optional) drop a 64x64 headshot into v2/src/assets/people/
  //      and add `avatar: "filename.jpg"` to the object.
  const TESTIMONIALS = [
    // Example shape — uncomment and replace once you have real ones:
    // {
    //   quote: "Cut my application time in half. The voice mock interview is the best practice tool I've used.",
    //   name: "Thandi Mokoena",
    //   role: "Product Designer",
    //   company: "Cape Town",
    //   avatar: "thandi.jpg",
    // },
  ];

  function renderTestimonial(t) {
    const avatar = t.avatar
      ? '<img class="lp-testimonial-avatar" src="./src/assets/people/' + t.avatar + '" alt="" loading="lazy" />'
      : '<span class="lp-testimonial-avatar lp-testimonial-avatar--initials" aria-hidden="true">' + (t.name || "?").charAt(0) + '</span>';
    const company = t.company ? ' &middot; ' + t.company : '';
    return (
      '<figure class="lp-testimonial">' +
        '<blockquote>' +
          '<i class="fa-solid fa-quote-left lp-testimonial-mark" aria-hidden="true"></i>' +
          '<p>' + t.quote + '</p>' +
        '</blockquote>' +
        '<figcaption class="lp-testimonial-cap">' +
          avatar +
          '<div><strong>' + t.name + '</strong><span>' + (t.role || "") + company + '</span></div>' +
        '</figcaption>' +
      '</figure>'
    );
  }

  // Side-by-side comparison matrix. Rows are the most upgrade-driving
  // line items. Values use ✓ / ✗ / numbers — short enough that all
  // four columns stay readable at narrow widths.
  const COMPARE_ROWS = [
    { label: "AI resume tailorings / mo", values: ["1", "10", "Unlimited", "Unlimited"] },
    { label: "Cover letters / mo",        values: ["2", "15", "Unlimited", "Unlimited"] },
    { label: "Mock interviews / mo",      values: ["1 (text)", "3", "10 voice", "Unlimited voice"] },
    { label: "Company research / mo",     values: ["1", "5", "Unlimited", "Unlimited"] },
    { label: "Saved jobs",                values: ["5", "100", "Unlimited", "Unlimited"] },
    { label: "Voice mock interviews",     values: ["—", "—", "✓", "✓"] },
    { label: "All 4 interviewer personas",values: ["—", "✓ (text)", "✓ (voice)", "✓ (voice)"] },
    { label: "Personal analytics",        values: ["—", "—", "✓", "✓"] },
    { label: "Priority AI (faster)",      values: ["—", "—", "—", "✓"] },
    { label: "Priority support (<24h)",   values: ["—", "—", "—", "✓"] },
    { label: "Pipeline + extension",      values: ["✓", "✓", "✓", "✓"] },
  ];

  function renderComparisonTable() {
    const head = '<thead><tr><th scope="col">Feature</th>' +
      PRICING_TIERS.map(function (t) {
        return '<th scope="col"' + (t.featured ? ' class="lp-compare-featured"' : '') + '>' + t.name + '</th>';
      }).join("") +
      '</tr></thead>';
    const body = '<tbody>' + COMPARE_ROWS.map(function (row) {
      return (
        '<tr>' +
          '<th scope="row">' + row.label + '</th>' +
          row.values.map(function (v, i) {
            const featured = PRICING_TIERS[i] && PRICING_TIERS[i].featured ? ' class="lp-compare-featured"' : '';
            const isCheck = v === "✓";
            const isDash = v === "—";
            const cls = isCheck ? "lp-compare-yes" : isDash ? "lp-compare-no" : "";
            return '<td' + featured + '><span class="' + cls + '">' + v + '</span></td>';
          }).join("") +
        '</tr>'
      );
    }).join("") + '</tbody>';
    return (
      '<div class="lp-compare-wrap">' +
        '<h3 class="lp-compare-title">Compare all plans</h3>' +
        '<div class="lp-compare-scroll">' +
          '<table class="lp-compare">' + head + body + '</table>' +
        '</div>' +
      '</div>'
    );
  }

  function renderCurrencyToggle(active) {
    return (
      '<div class="lp-ccy-toggle" role="tablist" aria-label="Pricing currency">' +
        '<button type="button" class="lp-ccy-btn' + (active === "zar" ? " is-active" : "") + '" data-ccy="zar" role="tab" aria-selected="' + (active === "zar") + '">ZAR (R)</button>' +
        '<button type="button" class="lp-ccy-btn' + (active === "usd" ? " is-active" : "") + '" data-ccy="usd" role="tab" aria-selected="' + (active === "usd") + '">USD ($)</button>' +
      '</div>'
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
              '<span class="lp-eyebrow"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Private by design &nbsp;·&nbsp; <i class="fa-solid fa-user-check" aria-hidden="true"></i> Human in control</span>' +
              '<h1>Your job search, in one calm place.</h1>' +
              '<p class="lp-hero-sub">Stop juggling 12 tabs across job boards, ATS forms, and AI prompts. Research roles, tailor every resume, rehearse interviews out loud, and track every follow-up — all in one workspace. For serious job seekers, not auto-apply spam.</p>' +
              '<div class="lp-hero-actions">' +
                '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/auth?mode=signup"><i class="fa-solid fa-rocket"></i> Start free</a>' +
                '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#how">See how it works <i class="fa-solid fa-arrow-down"></i></a>' +
              '</div>' +
              '<p class="lp-hero-meta">Free forever plan &nbsp;·&nbsp; No card needed &nbsp;·&nbsp; ZAR + USD pricing</p>' +
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

        // ── Testimonials (only renders when TESTIMONIALS has content) ─
        (TESTIMONIALS.length
          ? (
            '<section class="lp-section lp-section--alt" id="testimonials">' +
              '<div class="lp-container">' +
                '<header class="lp-section-head">' +
                  '<span class="lp-eyebrow">What people say</span>' +
                  '<h2>Real job seekers, real outcomes.</h2>' +
                '</header>' +
                '<div class="lp-testimonials-grid">' +
                  TESTIMONIALS.map(renderTestimonial).join("") +
                '</div>' +
              '</div>' +
            '</section>'
          )
          : '') +

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
        // Cards + amounts come from PRICING_TIERS so the displayed
        // numbers stay in sync with plan_catalog. Currency defaults to
        // ZAR for SA visitors, USD otherwise — toggle lets either side
        // switch on demand.
        (function () {
          const activeCcy = detectDefaultCurrency();
          const cards = PRICING_TIERS.map(function (t) { return renderPricingCard(t, activeCcy); }).join("");
          return (
            '<section class="lp-section" id="pricing">' +
              '<div class="lp-container">' +
                '<header class="lp-section-head">' +
                  '<span class="lp-eyebrow">Pricing</span>' +
                  '<h2>Start free. Upgrade when your search needs more power.</h2>' +
                  '<p>All paid plans unlock more AI tailoring and voice mock interviews.</p>' +
                  renderCurrencyToggle(activeCcy) +
                '</header>' +
                '<div class="lp-pricing-grid">' + cards + '</div>' +
                renderComparisonTable() +
                '<p class="lp-pricing-foot">Secure checkout. Cancel anytime from Billing.</p>' +
              '</div>' +
            '</section>'
          );
        })() +

        // ── FAQ ────────────────────────────────────────────────────
        '<section class="lp-section lp-section--alt" id="faq">' +
          '<div class="lp-container lp-container--narrow">' +
            '<header class="lp-section-head lp-section-head--left">' +
              '<span class="lp-eyebrow">FAQ</span>' +
              '<h2>Questions before you start.</h2>' +
            '</header>' +
            '<div class="lp-faq-list">' + faqs + '</div>' +
            // Email contact prompt: anyone whose question isn't covered
            // by the FAQ above gets a clear escape hatch. mailto: opens
            // their default mail client. Goes to support@careerboost.co.za
            // which forwards to Gmail via ImprovMX.
            '<div class="lp-faq-contact">' +
              '<p>' +
                '<i class="fa-solid fa-envelope" aria-hidden="true"></i> ' +
                'Still have a question? Email us at ' +
                '<a href="mailto:support@careerboost.co.za">support@careerboost.co.za</a> ' +
                '&mdash; usually replies within one business day.' +
              '</p>' +
            '</div>' +
          '</div>' +
        '</section>' +

        // ── Final CTA — focused single-column panel ──────────────────
        // Stats column removed: "4 personas / 6 stages" read as weak
        // brag points. Re-add when there are real numbers worth showing
        // (active users, applications tracked, interview success rate).
        '<section class="lp-final">' +
          '<div class="lp-container">' +
            '<div class="lp-final-card lp-final-card--centered">' +
              '<div class="lp-final-glow lp-final-glow-a" aria-hidden="true"></div>' +
              '<div class="lp-final-glow lp-final-glow-b" aria-hidden="true"></div>' +
              '<div class="lp-final-copy">' +
                '<span class="lp-eyebrow">Ready when you are</span>' +
                '<h2>Run your job search<br/>like a professional.</h2>' +
                '<p>One calm workspace for research, tailoring, mock interviews, and follow-ups. Free to start — upgrade only when you need more.</p>' +
                '<div class="lp-final-actions">' +
                  '<a class="lp-btn lp-btn--primary lp-btn--lg" href="#/auth?mode=signup"><i class="fa-solid fa-rocket"></i> Start free</a>' +
                  '<a class="lp-btn lp-btn--ghost lp-btn--lg" href="#pricing">See pricing</a>' +
                '</div>' +
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

  // Swap each pricing card's amount in place when the user toggles
  // currency. Pure DOM patch so we don't re-render the whole page.
  function applyPricingCurrency(currency) {
    PRICING_TIERS.forEach(function (tier) {
      const node = document.querySelector('[data-price-amount="' + tier.id + '"]');
      if (!node) return;
      const price = tier[currency] || tier.usd;
      node.innerHTML = '<strong>' + price.label + '</strong><span>/month</span>';
    });
    document.querySelectorAll(".lp-ccy-btn").forEach(function (btn) {
      const isActive = btn.getAttribute("data-ccy") === currency;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    try { localStorage.setItem("cb_pricing_ccy", currency); } catch (e) { /* ignore */ }
  }

  // Animate the hero product mock so it doesn't feel static.
  //   1. Counter: tick "94% ready" pill up from 0 to 94 over ~900ms.
  //   2. Stage rotation: cycle is-active through Saved → Tailor →
  //      Apply → Interview, ~2.8s per step, looping. Pauses on hover
  //      so visitors reading the mock aren't fighting motion.
  function animateHeroMock() {
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const pill = document.querySelector(".lp-mock-pill");
    if (pill && /(\d+)/.test(pill.textContent || "")) {
      const target = parseInt(RegExp.$1, 10);
      const suffix = (pill.textContent || "").replace(/\d+/, "").trim();
      const start = performance.now();
      const dur = 900;
      function tick(now) {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        const val = Math.round(target * eased);
        pill.textContent = val + (suffix ? "% " + suffix.replace(/^%\s*/, "") : "%");
        if (t < 1) requestAnimationFrame(tick);
      }
      pill.textContent = "0%";
      requestAnimationFrame(tick);
    }

    const stages = Array.from(document.querySelectorAll(".lp-mock-stages span"));
    if (stages.length >= 3) {
      stages.forEach(function (s) { s.classList.add("is-rotating"); });
      let activeIdx = stages.findIndex(function (s) { return s.classList.contains("is-active"); });
      if (activeIdx < 0) activeIdx = 0;
      let paused = false;
      const wrap = document.querySelector(".lp-mock-stages");
      if (wrap) {
        wrap.addEventListener("mouseenter", function () { paused = true; });
        wrap.addEventListener("mouseleave", function () { paused = false; });
      }
      setInterval(function () {
        if (paused || !document.body.contains(stages[0])) return;
        stages[activeIdx].classList.remove("is-active");
        // Mark the just-passed stage as done so the timeline reads correctly.
        stages[activeIdx].classList.add("is-done");
        activeIdx = (activeIdx + 1) % stages.length;
        // When we wrap, reset everyone — fresh cycle.
        if (activeIdx === 0) {
          stages.forEach(function (s) { s.classList.remove("is-done"); });
        }
        stages[activeIdx].classList.add("is-active");
      }, 2800);
    }
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

    // Currency toggle: switch all pricing amounts + save preference.
    document.querySelectorAll(".lp-ccy-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const ccy = btn.getAttribute("data-ccy");
        if (ccy === "zar" || ccy === "usd") applyPricingCurrency(ccy);
        try {
          const tel = window.CBAI && window.CBAI.telemetry;
          if (tel && typeof tel.track === "function") {
            tel.track({ type: "landing", event: "pricing_ccy_toggle", currency: ccy, status: "success" });
          }
        } catch (e) { /* ignore */ }
      });
    });

    // Hero animations: count the "94% ready" pill up from 0, and rotate
    // the active stage chip every few seconds to suggest the workflow
    // is moving. Both honour prefers-reduced-motion (no animation runs
    // if the user has the system pref set).
    animateHeroMock();

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
