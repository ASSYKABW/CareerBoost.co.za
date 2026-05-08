// Public landing page shown to signed-out visitors.
// CareerBoost v8 landing: futuristic, product-led, and trust-focused.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const MODULES = [
    {
      icon: "fa-bullseye",
      tone: "cyan",
      size: "wide",
      kicker: "Role Intelligence",
      title: "Prioritize the roles that deserve your energy.",
      body: "Compare fit, seniority, work mode, timing, and next action before you spend time tailoring.",
      metric: "Fit signals, not guesswork"
    },
    {
      icon: "fa-wand-magic-sparkles",
      tone: "violet",
      size: "tall",
      kicker: "Resume Tailoring",
      title: "Turn one resume into role-ready versions.",
      body: "Create focused drafts that keep your real experience intact while aligning with the job description.",
      metric: "Human approved"
    },
    {
      icon: "fa-table-list",
      tone: "green",
      size: "compact",
      kicker: "Pipeline",
      title: "Keep every opportunity moving.",
      body: "Track shortlist, tailor, applied, follow-up, interview, and outcome stages in one view.",
      metric: "6 stages"
    },
    {
      icon: "fa-envelope-open-text",
      tone: "amber",
      size: "compact",
      kicker: "Letters",
      title: "Draft with company context.",
      body: "Create useful first drafts you can review, edit, and send with confidence.",
      metric: "No blank page"
    },
    {
      icon: "fa-comments",
      tone: "blue",
      size: "compact",
      kicker: "Interview Prep",
      title: "Prepare stronger stories.",
      body: "Convert requirements into practice prompts, talking points, and sharper interview narratives.",
      metric: "Ready answers"
    },
    {
      icon: "fa-chart-line",
      tone: "rose",
      size: "wide",
      kicker: "Progress Review",
      title: "Know what changed this week.",
      body: "See stalled roles, pending follow-ups, prepared assets, and the highest-value next action.",
      metric: "Weekly momentum"
    }
  ];

  const TRUST = [
    {
      icon: "fa-user-check",
      title: "You stay in control",
      body: "CareerBoost helps you draft, organize, and decide. It does not submit applications for you."
    },
    {
      icon: "fa-eye",
      title: "Explainable fit",
      body: "Role recommendations surface the signals behind the score so you can judge the advice."
    },
    {
      icon: "fa-lock",
      title: "Private workspace",
      body: "Resumes, notes, roles, and drafts stay organized around your personal job-search records."
    },
    {
      icon: "fa-file-export",
      title: "Portable history",
      body: "Keep structured records you can review, reuse, and export as your search develops."
    }
  ];

  const STEPS = [
    {
      n: "01",
      title: "Define your target",
      body: "Set roles, location, work mode, preferences, and your current resume."
    },
    {
      n: "02",
      title: "Shortlist with signal",
      body: "Rank opportunities by fit and effort before tailoring anything."
    },
    {
      n: "03",
      title: "Create role assets",
      body: "Draft resumes, letters, and prep notes from the same context."
    },
    {
      n: "04",
      title: "Follow through",
      body: "Move roles forward with reminders, notes, interviews, and outcomes."
    }
  ];

  const FAQS = [
    {
      q: "Who is CareerBoost for?",
      a: "CareerBoost is for job seekers who want a more organized, professional system for applications, resumes, cover letters, follow-ups, and interviews."
    },
    {
      q: "Does CareerBoost submit applications for me?",
      a: "No. CareerBoost is human-in-control by design. It helps you prepare and organize, while you review and submit every application."
    },
    {
      q: "Can I use my existing resume?",
      a: "Yes. Start with your current resume, then create role-specific versions for the opportunities you choose."
    },
    {
      q: "Can I start without a credit card?",
      a: "Yes. You can create a free workspace and upgrade only when your search needs more power."
    }
  ];

  function renderBrand(tagline) {
    if (window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function") {
      return window.CBV2.brandKit.logo({ compact: false, tagline: !!tagline });
    }
    return "Career<span>Boost</span>";
  }

  function moduleCard(item) {
    return (
      '<article class="cb8-bento-card cb8-bento-' + item.size + ' cb8-tone-' + item.tone + '">' +
        '<div class="cb8-card-top">' +
          '<span class="cb8-icon"><i class="fa-solid ' + item.icon + '" aria-hidden="true"></i></span>' +
          '<span class="cb8-card-metric">' + item.metric + "</span>" +
        "</div>" +
        '<p class="cb8-kicker">' + item.kicker + "</p>" +
        "<h3>" + item.title + "</h3>" +
        "<p>" + item.body + "</p>" +
        moduleVisual(item.kicker) +
      "</article>"
    );
  }

  function moduleVisual(kicker) {
    if (kicker === "Role Intelligence") {
      return (
        '<div class="cb8-card-bars" aria-hidden="true">' +
          '<label><span>Signal match</span><b style="width: 92%"></b></label>' +
          '<label><span>Role effort</span><b style="width: 68%"></b></label>' +
          '<label><span>Response timing</span><b style="width: 78%"></b></label>' +
        "</div>"
      );
    }

    if (kicker === "Resume Tailoring") {
      return (
        '<div class="cb8-resume-preview" aria-hidden="true">' +
          '<span>Tailoring pass</span>' +
          '<strong>Evidence locked</strong>' +
          '<p><i class="fa-solid fa-check"></i> 8 matched skills</p>' +
          '<p><i class="fa-solid fa-check"></i> 3 proof points</p>' +
          '<p><i class="fa-solid fa-check"></i> Human review required</p>' +
        "</div>"
      );
    }

    if (kicker === "Progress Review") {
      return (
        '<div class="cb8-review-strip" aria-hidden="true">' +
          '<span><b>3</b> follow-ups</span>' +
          '<span><b>2</b> interviews</span>' +
          '<span><b>5</b> next actions</span>' +
        "</div>"
      );
    }

    return "";
  }

  function trustCard(item) {
    return (
      '<article class="cb8-trust-card">' +
        '<span class="cb8-icon cb8-icon-small"><i class="fa-solid ' + item.icon + '" aria-hidden="true"></i></span>' +
        '<div><h3>' + item.title + "</h3><p>" + item.body + "</p></div>" +
      "</article>"
    );
  }

  function stepCard(item) {
    return (
      '<article class="cb8-step-card">' +
        '<span>' + item.n + "</span>" +
        "<h3>" + item.title + "</h3>" +
        "<p>" + item.body + "</p>" +
      "</article>"
    );
  }

  function faqItem(item) {
    return (
      '<details class="cb8-faq-item">' +
        "<summary>" + item.q + "</summary>" +
        "<p>" + item.a + "</p>" +
      "</details>"
    );
  }

  function renderCockpit() {
    return (
      '<div class="cb8-cockpit" aria-hidden="true">' +
        '<div class="cb8-cockpit-glow"></div>' +
        '<div class="cb8-cockpit-bar">' +
          '<span></span><span></span><span></span>' +
          '<strong>careerboost.app / command-center</strong>' +
          '<em>LIVE WORKSPACE</em>' +
        "</div>" +
        '<div class="cb8-cockpit-body">' +
          '<aside class="cb8-cockpit-rail">' +
            '<b>Workspace</b>' +
            '<span class="is-active"><i class="fa-solid fa-table-columns"></i> Pipeline</span>' +
            '<span><i class="fa-solid fa-file-lines"></i> Resume Lab</span>' +
            '<span><i class="fa-solid fa-envelope"></i> Letters</span>' +
            '<span><i class="fa-solid fa-comments"></i> Interview</span>' +
          "</aside>" +
          '<section class="cb8-cockpit-main">' +
            '<div class="cb8-cockpit-head">' +
              '<div><span>Weekly command</span><strong>Move 5 high-fit roles forward</strong></div>' +
              '<b>94% ready</b>' +
            "</div>" +
            '<div class="cb8-stage-map">' +
              '<span class="done">Shortlist</span>' +
              '<span class="active">Tailor</span>' +
              '<span>Apply</span>' +
              '<span>Follow up</span>' +
              '<span>Interview</span>' +
            "</div>" +
            '<div class="cb8-command-grid">' +
              '<article class="cb8-score-panel">' +
                '<span>Top role fit</span>' +
                '<strong>94%</strong>' +
                '<p>Product Engineer &middot; Remote</p>' +
              "</article>" +
              '<article class="cb8-action-panel">' +
                '<span>Next best action</span>' +
                '<strong>Tailor resume before Friday</strong>' +
                '<p>Use matched skills, project evidence, and role keywords.</p>' +
              "</article>" +
              '<article class="cb8-mini-panel cb8-mini-violet"><span>Resume</span><strong>Draft ready</strong></article>' +
              '<article class="cb8-mini-panel cb8-mini-green"><span>Follow-up</span><strong>3 due soon</strong></article>' +
            "</div>" +
            '<div class="cb8-role-feed">' +
              '<div><b>89%</b><span>Frontend Engineer &middot; Hybrid</span><em>Follow up</em></div>' +
              '<div><b>84%</b><span>Growth Analyst &middot; Remote</span><em>Prep stories</em></div>' +
              '<div><b>78%</b><span>Operations Associate &middot; On-site</span><em>Review fit</em></div>' +
            "</div>" +
          "</section>" +
        "</div>" +
      "</div>"
    );
  }

  function bindLandingTracking() {
    const root = document.querySelector(".cb8-page");
    if (!root) return;

    try {
      const telemetry = window.CBAI && window.CBAI.telemetry;
      if (telemetry && typeof telemetry.track === "function") {
        telemetry.track({ type: "landing", event: "landing_view", route: "welcome", status: "success" });
      }
    } catch (error) {
      // Do not block landing UX on telemetry.
    }
  }

  function renderView() {
    const modules = MODULES.map(moduleCard).join("");
    const trust = TRUST.map(trustCard).join("");
    const steps = STEPS.map(stepCard).join("");
    const faqs = FAQS.map(faqItem).join("");

    return (
      '<main class="welcome-page cb8-page">' +
        '<div class="cb8-ambient cb8-ambient-one"></div>' +
        '<div class="cb8-ambient cb8-ambient-two"></div>' +
        '<header class="cb8-nav">' +
          '<a class="auth-brand cb8-brand" href="#/welcome" aria-label="CareerBoost home">' + renderBrand(false) + "</a>" +
          '<nav class="cb8-nav-links" aria-label="Landing navigation">' +
            '<a href="#platform">Platform</a>' +
            '<a href="#trust">Trust</a>' +
            '<a href="#workflow">Workflow</a>' +
            '<a href="#pricing">Pricing</a>' +
            '<a href="#faq">FAQ</a>' +
          "</nav>" +
          '<div class="cb8-nav-actions">' +
            '<a class="cb8-link" href="#/auth">Sign in</a>' +
            '<a class="cb8-btn cb8-btn-primary" href="#/auth?mode=signup">Start free</a>' +
          "</div>" +
        "</header>" +

        '<section class="cb8-hero" id="hero">' +
          '<div class="cb8-hero-copy">' +
            '<p class="cb8-eyebrow"><i class="fa-solid fa-shield-halved"></i> Private AI career operating system</p>' +
            '<h1>Your job search, engineered like a command center.</h1>' +
            '<p class="cb8-hero-subline">Find better-fit roles, tailor every application, track follow-ups, and prepare interviews from one trusted workspace.</p>' +
            '<div class="cb8-hero-actions">' +
              '<a class="cb8-btn cb8-btn-primary cb8-btn-large" href="#/auth?mode=signup"><i class="fa-solid fa-rocket"></i> Start free</a>' +
              '<a class="cb8-btn cb8-btn-secondary cb8-btn-large" href="#platform"><i class="fa-solid fa-layer-group"></i> Explore platform</a>' +
            "</div>" +
            '<div class="cb8-hero-proof">' +
              '<span><strong>No auto-apply</strong> You review every move.</span>' +
              '<span><strong>Role-fit signals</strong> Know why a role matters.</span>' +
              '<span><strong>Private records</strong> Own your search history.</span>' +
            "</div>" +
          "</div>" +
          '<div class="cb8-hero-visual">' + renderCockpit() + "</div>" +
        "</section>" +

        '<section class="cb8-signal-bar" aria-label="CareerBoost trust signals">' +
          '<article><i class="fa-solid fa-credit-card"></i><strong>$0 to start</strong><span>No credit card required</span></article>' +
          '<article><i class="fa-solid fa-user-check"></i><strong>Human approval</strong><span>Every draft stays yours</span></article>' +
          '<article><i class="fa-solid fa-eye"></i><strong>Visible logic</strong><span>Inspectable role signals</span></article>' +
          '<article><i class="fa-solid fa-file-export"></i><strong>Portable records</strong><span>Organized and reusable</span></article>' +
        "</section>" +

        '<section class="cb8-section cb8-platform" id="platform">' +
          '<div class="cb8-section-head">' +
            '<p class="cb8-eyebrow">Platform</p>' +
            '<h2>Everything your search needs, arranged around action.</h2>' +
            '<p>CareerBoost turns scattered tabs, resumes, notes, and reminders into a calm operating system for serious job seekers.</p>' +
          "</div>" +
          '<div class="cb8-bento-grid">' + modules + "</div>" +
        "</section>" +

        '<section class="cb8-section cb8-trust" id="trust">' +
          '<div class="cb8-trust-copy">' +
            '<p class="cb8-eyebrow">Trust and control</p>' +
            '<h2>Professional does not mean black-box automation.</h2>' +
            '<p>CareerBoost gives you AI leverage without taking away judgment. Recommendations are built to be reviewed, edited, and owned by you.</p>' +
            '<div class="cb8-security-panel">' +
              '<span><i class="fa-solid fa-shield-halved"></i> Review required</span>' +
              '<span><i class="fa-solid fa-lock"></i> Private by default</span>' +
              '<span><i class="fa-solid fa-file-export"></i> Export-ready data</span>' +
            "</div>" +
          "</div>" +
          '<div class="cb8-trust-grid">' + trust + "</div>" +
        "</section>" +

        '<section class="cb8-section cb8-workflow" id="workflow">' +
          '<div class="cb8-section-head cb8-section-head-wide">' +
            '<p class="cb8-eyebrow">Method</p>' +
            '<h2>A weekly execution rhythm for the whole search.</h2>' +
          "</div>" +
          '<div class="cb8-step-grid">' + steps + "</div>" +
        "</section>" +

        '<section class="cb8-section cb8-momentum">' +
          '<div class="cb8-momentum-copy">' +
            '<p class="cb8-eyebrow">Measurable progress</p>' +
            '<h2>Turn effort into visible momentum.</h2>' +
            '<ul>' +
              '<li><i class="fa-solid fa-check"></i> Know what deserves attention today.</li>' +
              '<li><i class="fa-solid fa-check"></i> Keep follow-ups, notes, and interviews visible.</li>' +
              '<li><i class="fa-solid fa-check"></i> Review your search like a professional pipeline.</li>' +
            "</ul>" +
          "</div>" +
          '<div class="cb8-progress-console" aria-hidden="true">' +
            '<div class="cb8-progress-head"><div><span>Weekly execution plan</span><strong>5 roles moving forward</strong></div><i class="fa-solid fa-arrow-trend-up"></i></div>' +
            '<label><span>Shortlist quality</span><b style="width: 86%"></b></label>' +
            '<label><span>Tailored applications</span><b style="width: 72%"></b></label>' +
            '<label><span>Follow-up coverage</span><b style="width: 64%"></b></label>' +
            '<article><span>Next best action</span><strong>Prepare interview stories for the role with the strongest response signal.</strong></article>' +
          "</div>" +
        "</section>" +

        '<section class="cb8-metrics" aria-label="CareerBoost product proof">' +
          '<article><strong>6</strong><span>Pipeline stages</span></article>' +
          '<article><strong>Fit</strong><span>Role scoring</span></article>' +
          '<article><strong>AI</strong><span>Tailored drafts</span></article>' +
          '<article><strong>100%</strong><span>Reviewed by you</span></article>' +
        "</section>" +

        '<section class="cb8-section cb8-pricing" id="pricing">' +
          '<div class="cb8-section-head">' +
            '<p class="cb8-eyebrow">Pricing</p>' +
            '<h2>Start free. Upgrade when your search needs more power.</h2>' +
            '<p>No pressure at the start. Build your workspace first, then scale when you are applying weekly.</p>' +
          "</div>" +
          '<div class="cb8-pricing-grid">' +
            '<article class="cb8-price-card">' +
              '<h3>Free</h3>' +
              '<p class="cb8-plan-fit">For getting organized and building your first pipeline.</p>' +
              '<p class="cb8-price">$0<span>/month</span></p>' +
              '<ul><li>Application pipeline</li><li>Resume and cover letter basics</li><li>Interview prep workspace</li></ul>' +
              '<a class="cb8-btn cb8-btn-secondary" href="#/auth?mode=signup">Start free</a>' +
            "</article>" +
            '<article class="cb8-price-card cb8-price-featured">' +
              '<p class="cb8-badge">Most useful</p>' +
              '<h3>Pro</h3>' +
              '<p class="cb8-plan-fit">For active job seekers tailoring and tracking every week.</p>' +
              '<p class="cb8-price">$19<span>/month</span></p>' +
              '<ul><li>Higher AI usage limits</li><li>Advanced role-fit insights</li><li>More saved roles and exports</li></ul>' +
              '<a class="cb8-btn cb8-btn-primary" href="#/auth?mode=signup">Start free</a>' +
            "</article>" +
          "</div>" +
        "</section>" +

        '<section class="cb8-section cb8-faq" id="faq">' +
          '<div class="cb8-section-head">' +
            '<p class="cb8-eyebrow">FAQ</p>' +
            '<h2>Questions before you start.</h2>' +
          "</div>" +
          '<div class="cb8-faq-list">' + faqs + "</div>" +
        "</section>" +

        '<section class="cb8-final-cta">' +
          '<div>' +
            '<p class="cb8-eyebrow">Start with structure</p>' +
            '<h2>Create your CareerBoost workspace today.</h2>' +
            '<p>Organize your search, improve every application, and walk into interviews better prepared.</p>' +
          "</div>" +
          '<a class="cb8-btn cb8-btn-primary cb8-btn-large" href="#/auth?mode=signup">Start free</a>' +
        "</section>" +

        '<footer class="cb8-footer">' +
          '<div class="auth-brand">' + renderBrand(true) + "</div>" +
          '<p>&copy; ' + new Date().getFullYear() + " CareerBoost. Built for ambitious job seekers.</p>" +
        "</footer>" +
      "</main>"
    );
  }

  window.CBV2.routes.welcome = renderView;
  window.CBV2.afterRender.welcome = bindLandingTracking;
})();
