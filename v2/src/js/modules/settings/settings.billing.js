// Phase Billing: Settings → Billing & Plan tab.
//
// Three responsibilities:
//   1. Show the user's current plan + status (active / past_due /
//      canceled / etc.) with the renewal date.
//   2. Show this month's usage with progress meters per quota.
//   3. Surface the Stripe Customer Portal link (manage card / change
//      plan / cancel / view invoices) — and an "Upgrade" CTA that
//      opens the same upgrade modal used by the in-line gates.
//
// All data comes from window.CBV2.entitlements which is loaded on
// auth state change + refreshed after focus. We expose ONE render
// function called by settings.route.js when the active tab is
// "billing", plus a bind() function for the click handlers.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsBilling = window.CBV2.settingsBilling || {};

  function st(v) {
    return (window.CBV2.sanitizeText || String)(v);
  }

  // Format the per-quota row. Unlimited shows "Unlimited" instead of
  // a numeric meter.
  function renderQuotaRow(label, key, ent) {
    const used = (ent.usage && ent.usage[key]) || 0;
    const limit = (ent.limits && ent.limits.monthly && ent.limits.monthly[key]);
    if (limit === null || limit === undefined) {
      return (
        '<div class="billing-quota-row billing-quota-row--unlimited">' +
          '<div><strong>' + st(label) + '</strong><span>Unlimited on your plan</span></div>' +
          '<div class="billing-quota-value">' + st(used) + '<small> used</small></div>' +
        '</div>'
      );
    }
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const tone = pct >= 100 ? "rose" : pct >= 75 ? "amber" : "green";
    return (
      '<div class="billing-quota-row">' +
        '<div><strong>' + st(label) + '</strong><span>' + st(used) + ' of ' + st(limit) + ' used</span></div>' +
        '<div class="billing-quota-meter"><i style="--bar:' + pct + '%" class="billing-quota-meter-fill--' + tone + '"></i></div>' +
        '<div class="billing-quota-value">' + st(Math.max(0, limit - used)) + '<small> left</small></div>' +
      '</div>'
    );
  }

  function statusBadge(status, cancelAtPeriodEnd) {
    if (cancelAtPeriodEnd) {
      return '<span class="chip amber">Ending after this period</span>';
    }
    if (status === "active") return '<span class="chip green">Active</span>';
    if (status === "trialing") return '<span class="chip blue">Trial</span>';
    if (status === "past_due") return '<span class="chip rose">Payment failed</span>';
    if (status === "canceled") return '<span class="chip subtle">Canceled</span>';
    if (status === "paused") return '<span class="chip amber">Paused</span>';
    return '<span class="chip subtle">' + st(status) + '</span>';
  }

  function formatDate(value) {
    if (!value) return "—";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    } catch (e) { return "—"; }
  }

  function renderBillingSection() {
    const ent = window.CBV2 && window.CBV2.entitlements && window.CBV2.entitlements.get();
    if (!ent) {
      return (
        '<section class="card panel-lg settings-section" id="billing-section">' +
          '<header class="settings-section-head"><h2>Billing &amp; Plan</h2></header>' +
          '<p class="ai-meta">Loading your plan + usage…</p>' +
        '</section>'
      );
    }
    const planLabel = ent.plan_label || "Free";
    const planId = ent.plan_id || "free";
    const isPaid = planId !== "free";

    const quotas = renderQuotaRow("Resume tailorings", "ai_resumes", ent) +
      renderQuotaRow("Cover letters", "ai_covers", ent) +
      renderQuotaRow("Mock interviews", "ai_mocks", ent) +
      renderQuotaRow("Company research", "ai_research", ent) +
      renderQuotaRow("Question banks", "ai_question_banks", ent);

    const features = (ent.limits && ent.limits.features) || {};
    const featureRows = [
      { key: "voice_mode", label: "Voice mode mock interviews" },
      { key: "personal_analytics", label: "Personal analytics" },
      { key: "priority_ai", label: "Priority AI (faster + smarter)" },
    ].map(function (f) {
      const has = !!features[f.key];
      return (
        '<li class="billing-feature-row billing-feature-row--' + (has ? "on" : "off") + '">' +
          '<i class="fa-solid ' + (has ? "fa-check-circle" : "fa-circle-xmark") + '"></i>' +
          '<span>' + st(f.label) + '</span>' +
        '</li>'
      );
    }).join("");

    const renewalLine = ent.current_period_end
      ? ent.cancel_at_period_end
        ? "Cancels on " + formatDate(ent.current_period_end)
        : "Renews on " + formatDate(ent.current_period_end)
      : "No active subscription";
    const periodStart = ent.period_start ? formatDate(ent.period_start) : "this month";

    return (
      '<section class="card panel-lg settings-section" id="billing-section">' +
        '<header class="settings-section-head"><h2>Billing &amp; Plan</h2></header>' +

        '<div class="billing-plan-card">' +
          '<div class="billing-plan-head">' +
            '<div>' +
              '<p class="eyebrow">Current plan</p>' +
              '<h3>' + st(planLabel) + ' <small class="billing-plan-id">(' + st(planId) + ')</small></h3>' +
              '<p class="ai-meta">' + st(renewalLine) + '</p>' +
            '</div>' +
            '<div class="billing-plan-actions">' +
              statusBadge(ent.status, ent.cancel_at_period_end) +
              (isPaid
                ? '<button type="button" class="btn-secondary" id="billing-portal">Manage subscription</button>'
                : '<button type="button" class="btn-primary" id="billing-upgrade">Upgrade plan</button>') +
            '</div>' +
          '</div>' +

          '<div class="billing-features">' +
            '<p class="eyebrow">Features on your plan</p>' +
            '<ul>' + featureRows + '</ul>' +
          '</div>' +
        '</div>' +

        '<div class="billing-usage-card">' +
          '<div class="billing-usage-head">' +
            '<div><p class="eyebrow">Usage this month</p><h3>Since ' + st(periodStart) + '</h3></div>' +
            '<p class="ai-meta">Usage resets on the 1st of every month.</p>' +
          '</div>' +
          '<div class="billing-quota-list">' + quotas + '</div>' +
        '</div>' +

        (!isPaid
          ? (
            '<div class="billing-upgrade-cta">' +
              '<div><h3>Need more AI power?</h3><p class="ai-meta">Plus gets you 10x the AI quota. Pro unlocks unlimited tailoring + voice interview mode.</p></div>' +
              '<button type="button" class="btn-primary" id="billing-upgrade-bottom">See plans</button>' +
            '</div>'
          )
          : '') +

      '</section>'
    );
  }

  // Bind click handlers. Idempotent — safe to call on every render.
  function bindBillingSection() {
    const upgrade = document.getElementById("billing-upgrade");
    const upgradeBottom = document.getElementById("billing-upgrade-bottom");
    const portal = document.getElementById("billing-portal");
    const open = function () {
      const modal = window.CBV2 && window.CBV2.upgradeModal;
      if (modal && modal.show) modal.show({ reason: "feature_locked" });
    };
    if (upgrade) upgrade.addEventListener("click", open);
    if (upgradeBottom) upgradeBottom.addEventListener("click", open);
    if (portal) {
      portal.addEventListener("click", async function () {
        portal.disabled = true;
        try {
          const auth = window.CBV2 && window.CBV2.auth;
          const c = window.CBV2 && window.CBV2.config;
          if (!auth || !c) throw new Error("Not configured.");
          const client = auth.getClient && auth.getClient();
          let url;
          if (client && client.functions && typeof client.functions.invoke === "function") {
            const invoked = await client.functions.invoke("stripe-portal", { body: {} });
            if (invoked.error) throw new Error(invoked.error.message || "Portal failed.");
            url = invoked.data && invoked.data.url;
          } else {
            const token = await auth.getAccessToken();
            const resp = await fetch(c.getFunctionsUrl() + "/stripe-portal", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token,
                apikey: c.getSupabaseAnon(),
              },
              body: "{}"
            });
            const j = await resp.json();
            if (!resp.ok || !j.url) throw new Error(j.error || "Portal failed.");
            url = j.url;
          }
          if (url) window.location.href = url;
        } catch (err) {
          if (window.CBV2.toast) window.CBV2.toast.error(err && err.message ? err.message : "Could not open portal.");
          portal.disabled = false;
        }
      });
    }
  }

  // If entitlements arrive AFTER the page render, refresh just this
  // section so the user doesn't see "Loading…" forever.
  if (window.CBV2 && window.CBV2.entitlements && typeof window.CBV2.entitlements.onChange === "function") {
    window.CBV2.entitlements.onChange(function () {
      const node = document.getElementById("billing-section");
      if (!node) return;
      // Replace in place; preserves the surrounding settings layout.
      const wrap = document.createElement("div");
      wrap.innerHTML = renderBillingSection();
      const fresh = wrap.firstElementChild;
      if (fresh) {
        node.replaceWith(fresh);
        bindBillingSection();
      }
    });
  }

  window.CBV2.settingsBilling.render = renderBillingSection;
  window.CBV2.settingsBilling.bind = bindBillingSection;
})();
