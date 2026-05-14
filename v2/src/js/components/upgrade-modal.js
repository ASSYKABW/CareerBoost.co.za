// Phase Billing: Upgrade modal.
//
// Surfaces a contextual upgrade prompt when a user hits a quota or
// tries to use a gated feature. Renders three plan options side-by-
// side, highlights the SMALLEST plan that unlocks the requested
// feature/quota, and routes the click straight to Stripe Checkout via
// the stripe-checkout Edge Function.
//
// API:
//   await window.CBV2.upgradeModal.show({
//     reason: "quota_exhausted" | "feature_locked",
//     feature?: "voice_mode" | ...
//     quota?: "ai_resumes" | ...
//     title?: string,     // override headline
//     body?: string,      // override body
//   })
//
// Returns the user's choice: { selectedPlan, interval } if they hit
// Upgrade, null if they cancelled. The promise doesn't wait for the
// actual Stripe redirect — once the URL is returned we navigate the
// browser immediately.

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.upgradeModal && window.CBV2.upgradeModal._installed) return;

  const PLAN_DEFS = [
    {
      id: "plus",
      label: "Plus",
      price: 9.99,
      annual: 89,
      tagline: "For active job seekers",
      perks: [
        "10 resume tailorings / month",
        "15 cover letters / month",
        "3 mock interviews / month",
        "100 saved jobs",
        "All 4 interviewer personas (text mode)"
      ]
    },
    {
      id: "pro",
      label: "Pro",
      price: 19.99,
      annual: 179,
      featured: true,
      tagline: "Most popular",
      perks: [
        "Unlimited resume tailorings",
        "Unlimited cover letters",
        "10 voice mock interviews / month",
        "Unlimited saved jobs",
        "Voice mode + all personas",
        "Personal analytics"
      ]
    },
    {
      id: "career",
      label: "Career",
      price: 39.99,
      annual: 349,
      tagline: "For executives + career changers",
      perks: [
        "Everything unlimited",
        "Unlimited voice mock interviews",
        "Priority AI (faster + better)",
        "Personal analytics",
        "Priority support (<24h)"
      ]
    },
  ];

  // Default copy keyed off the reason + which feature/quota triggered it.
  function buildCopy(spec) {
    const reason = spec.reason || "feature_locked";
    if (reason === "quota_exhausted") {
      const q = spec.quota || "this";
      const quotaLabel = (
        q === "ai_resumes" ? "AI resume tailoring" :
        q === "ai_covers" ? "AI cover letters" :
        q === "ai_mocks" ? "AI mock interviews" :
        q === "ai_research" ? "AI company research" :
        q === "ai_question_banks" ? "AI question banks" :
        "this feature"
      );
      return {
        title: spec.title || ("You've used all your " + quotaLabel + " this month."),
        body: spec.body || "Upgrade to keep going. Your usage resets on the 1st of next month — or unlock more right now."
      };
    }
    if (reason === "cap_exceeded") {
      const c = spec.cap || "items";
      const capLabel = c === "saved_jobs" ? "saved jobs" : c;
      return {
        title: spec.title || ("You've reached the " + capLabel + " limit on the free plan."),
        body: spec.body || "Upgrade to a paid plan to add more."
      };
    }
    // feature_locked
    const f = spec.feature || "this feature";
    const featureLabel = (
      f === "voice_mode" ? "Voice mode mock interviews" :
      f === "priority_ai" ? "Priority AI (faster + smarter)" :
      f === "personal_analytics" ? "Personal analytics" :
      "This feature"
    );
    return {
      title: spec.title || (featureLabel + " is on the Pro and Career plans."),
      body: spec.body || "Upgrade to unlock it instantly."
    };
  }

  // Which plan should we highlight? Smallest plan that unlocks the
  // requested feature/quota.
  function pickRecommended(spec) {
    const ent = window.CBV2 && window.CBV2.entitlements;
    if (ent && typeof ent.upgradeNeededFor === "function") {
      return ent.upgradeNeededFor({ feature: spec.feature, quota: spec.quota });
    }
    return "pro";
  }

  function ensureStyles() {
    if (document.getElementById("cb-upgrade-modal-styles")) return;
    const style = document.createElement("style");
    style.id = "cb-upgrade-modal-styles";
    style.textContent = (
      ".cb-upgrade-backdrop{position:fixed;inset:0;z-index:2147483647;" +
        "background:rgba(2,6,18,0.82);backdrop-filter:blur(8px);" +
        "display:flex;align-items:center;justify-content:center;padding:24px;" +
        "animation:cb-modal-fade 140ms ease;}" +
      ".cb-upgrade-card{background:linear-gradient(180deg,#101728 0%,#0a0f1d 100%);" +
        "border:1px solid rgba(94,234,212,0.22);border-radius:18px;padding:28px;" +
        "max-width:980px;width:100%;max-height:92vh;overflow:auto;color:#f8fbff;" +
        "box-shadow:0 28px 90px rgba(0,0,0,0.55);" +
        "animation:cb-modal-pop 200ms cubic-bezier(0.16,1,0.3,1);}" +
      ".cb-upgrade-head{display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:18px;}" +
      ".cb-upgrade-head h2{margin:0 0 6px;font-size:22px;color:#f8fbff;}" +
      ".cb-upgrade-head p{margin:0;font-size:13px;color:rgba(248,251,255,0.7);line-height:1.5;}" +
      ".cb-upgrade-close{background:transparent;border:none;color:rgba(248,251,255,0.5);" +
        "font-size:20px;cursor:pointer;padding:4px 8px;border-radius:6px;}" +
      ".cb-upgrade-close:hover{color:#f8fbff;background:rgba(255,255,255,0.06);}" +
      ".cb-upgrade-interval{display:inline-flex;gap:4px;background:rgba(15,23,42,0.6);" +
        "border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:3px;margin-bottom:18px;}" +
      ".cb-upgrade-interval button{background:transparent;border:none;padding:7px 14px;" +
        "font-size:12px;font-weight:600;color:rgba(248,251,255,0.65);" +
        "border-radius:8px;cursor:pointer;font-family:inherit;}" +
      ".cb-upgrade-interval button.is-active{background:rgba(94,234,212,0.16);color:#5eead4;}" +
      ".cb-upgrade-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}" +
      ".cb-upgrade-plan{background:rgba(15,23,42,0.55);border:1px solid rgba(255,255,255,0.08);" +
        "border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:12px;}" +
      ".cb-upgrade-plan.is-recommended{border-color:rgba(94,234,212,0.55);" +
        "box-shadow:0 0 0 1px rgba(94,234,212,0.18) inset, 0 12px 32px rgba(94,234,212,0.08);}" +
      ".cb-upgrade-plan.is-featured::before{content:'Most popular';position:absolute;top:-10px;" +
        "left:50%;transform:translateX(-50%);background:#5eead4;color:#062018;font-size:10px;" +
        "padding:4px 10px;border-radius:999px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;}" +
      ".cb-upgrade-plan{position:relative;}" +
      ".cb-upgrade-plan h3{margin:0;font-size:18px;color:#f8fbff;}" +
      ".cb-upgrade-tagline{margin:0;font-size:12px;color:rgba(94,234,212,0.85);}" +
      ".cb-upgrade-price{display:flex;align-items:baseline;gap:4px;margin:4px 0 8px;}" +
      ".cb-upgrade-price strong{font-size:32px;color:#f8fbff;font-weight:700;}" +
      ".cb-upgrade-price small{font-size:12px;color:rgba(248,251,255,0.55);}" +
      ".cb-upgrade-perks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}" +
      ".cb-upgrade-perks li{font-size:12px;color:rgba(248,251,255,0.78);line-height:1.45;" +
        "padding-left:18px;position:relative;}" +
      ".cb-upgrade-perks li::before{content:'✓';position:absolute;left:0;top:0;color:#5eead4;font-weight:700;}" +
      ".cb-upgrade-cta{margin-top:auto;padding:10px;border-radius:10px;border:none;" +
        "background:rgba(94,234,212,0.12);color:#5eead4;font-weight:600;cursor:pointer;" +
        "font-family:inherit;font-size:13px;transition:background 120ms ease;}" +
      ".cb-upgrade-cta:hover{background:rgba(94,234,212,0.22);}" +
      ".cb-upgrade-cta.is-primary{background:#5eead4;color:#062018;}" +
      ".cb-upgrade-cta.is-primary:hover{background:#7ff0dd;}" +
      ".cb-upgrade-cta:disabled{opacity:0.55;cursor:wait;}" +
      ".cb-upgrade-foot{margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);" +
        "font-size:11px;color:rgba(248,251,255,0.5);text-align:center;}" +
      ".cb-upgrade-error{margin:10px 0 0;font-size:12px;color:#fda4af;}" +
      "@media (max-width:768px){.cb-upgrade-grid{grid-template-columns:1fr;}}"
    );
    document.head.appendChild(style);
  }

  function show(spec) {
    spec = spec || {};
    ensureStyles();
    const copy = buildCopy(spec);
    const recommendedId = pickRecommended(spec);
    let interval = "monthly"; // toggleable

    return new Promise(function (resolve) {
      const backdrop = document.createElement("div");
      backdrop.className = "cb-upgrade-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");

      function render() {
        const plansHtml = PLAN_DEFS.map(function (p) {
          const isRec = p.id === recommendedId;
          const isFeat = !!p.featured;
          const price = interval === "annual"
            ? (p.annual / 12).toFixed(2)
            : p.price.toFixed(2);
          const periodNote = interval === "annual"
            ? "/ mo, billed $" + p.annual + "/yr"
            : "/ mo";
          return (
            '<article class="cb-upgrade-plan' +
              (isRec ? " is-recommended" : "") +
              (isFeat ? " is-featured" : "") + '">' +
              '<h3>' + p.label + '</h3>' +
              '<p class="cb-upgrade-tagline">' + p.tagline + '</p>' +
              '<div class="cb-upgrade-price">' +
                '<strong>$' + price + '</strong>' +
                '<small>' + periodNote + '</small>' +
              '</div>' +
              '<ul class="cb-upgrade-perks">' +
                p.perks.map(function (perk) { return '<li>' + perk + '</li>'; }).join("") +
              '</ul>' +
              '<button type="button" class="cb-upgrade-cta' + (isRec ? " is-primary" : "") + '"' +
                ' data-cb-upgrade-pick="' + p.id + '">' +
                (isRec ? "Upgrade to " + p.label : "Choose " + p.label) +
              '</button>' +
            '</article>'
          );
        }).join("");
        backdrop.innerHTML = (
          '<div class="cb-upgrade-card">' +
            '<div class="cb-upgrade-head">' +
              '<div>' +
                '<h2>' + copy.title + '</h2>' +
                '<p>' + copy.body + '</p>' +
              '</div>' +
              '<button type="button" class="cb-upgrade-close" data-cb-upgrade-close="1" title="Close">×</button>' +
            '</div>' +
            '<div class="cb-upgrade-interval" role="tablist">' +
              '<button type="button" data-cb-upgrade-interval="monthly" class="' + (interval === "monthly" ? "is-active" : "") + '">Monthly</button>' +
              '<button type="button" data-cb-upgrade-interval="annual" class="' + (interval === "annual" ? "is-active" : "") + '">Annual (save ~17%)</button>' +
            '</div>' +
            '<div class="cb-upgrade-grid">' + plansHtml + '</div>' +
            '<p class="cb-upgrade-error" hidden></p>' +
            '<p class="cb-upgrade-foot">Secure payment via Stripe. Cancel anytime in Billing settings. Pricing in USD.</p>' +
          '</div>'
        );
      }
      render();

      function showError(msg) {
        const node = backdrop.querySelector(".cb-upgrade-error");
        if (!node) return;
        if (!msg) { node.hidden = true; node.textContent = ""; return; }
        node.hidden = false;
        node.textContent = msg;
      }

      async function pick(planId) {
        const buttons = backdrop.querySelectorAll(".cb-upgrade-cta");
        buttons.forEach(function (b) { b.disabled = true; });
        showError("");
        const choice = { selectedPlan: planId, interval: interval };
        try {
          const url = await startCheckout(planId, interval);
          // Don't resolve until we're navigating — give the browser a
          // chance to start loading Stripe's page.
          window.location.href = url;
          finish(choice);
        } catch (err) {
          showError(err && err.message ? err.message : "Checkout failed. Try again or contact support.");
          buttons.forEach(function (b) { b.disabled = false; });
        }
      }

      function finish(result) {
        document.removeEventListener("keydown", onKey, true);
        try { backdrop.remove(); } catch (e) { /* ignore */ }
        resolve(result || null);
      }

      function onKey(event) {
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(null);
        }
      }

      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) finish(null);
        const close = event.target && event.target.getAttribute && event.target.getAttribute("data-cb-upgrade-close");
        if (close) finish(null);
        const intervalChoice = event.target && event.target.getAttribute && event.target.getAttribute("data-cb-upgrade-interval");
        if (intervalChoice) {
          interval = intervalChoice;
          render();
        }
        const planChoice = event.target && event.target.getAttribute && event.target.getAttribute("data-cb-upgrade-pick");
        if (planChoice) pick(planChoice);
      });
      document.addEventListener("keydown", onKey, true);

      document.body.appendChild(backdrop);
    });
  }

  // Call stripe-checkout with the chosen plan/interval. Returns the
  // Stripe Checkout URL on success; throws with a friendly message on
  // failure.
  async function startCheckout(planId, interval) {
    const auth = window.CBV2 && window.CBV2.auth;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) {
      throw new Error("Sign in to upgrade your plan.");
    }
    const c = window.CBV2 && window.CBV2.config;
    if (!c || !c.isBackendEnabled || !c.isBackendEnabled()) {
      throw new Error("Backend not configured.");
    }
    const client = auth.getClient && auth.getClient();
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const invoked = await client.functions.invoke("stripe-checkout", {
        body: { planId: planId, interval: interval }
      });
      if (invoked.error) {
        const msg = invoked.error.message || "Checkout failed.";
        throw new Error(msg);
      }
      if (!invoked.data || !invoked.data.url) {
        throw new Error("Stripe didn't return a checkout URL.");
      }
      return invoked.data.url;
    }
    // Fallback raw fetch.
    const token = await auth.getAccessToken();
    const resp = await fetch(c.getFunctionsUrl() + "/stripe-checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: c.getSupabaseAnon(),
      },
      body: JSON.stringify({ planId: planId, interval: interval })
    });
    const json = await resp.json();
    if (!resp.ok || !json.url) throw new Error(json.error || "Checkout failed.");
    return json.url;
  }

  // Public API.
  window.CBV2.upgradeModal = {
    show: show,
    startCheckout: startCheckout,
    _installed: true,
  };
})();
