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
    // status='canceled' means the sub is fully dead on PayStack —
    // show the same amber "Cancelled" treatment as cancel_at_period_end
    // so the user clearly knows there's no auto-renew coming.
    if (cancelAtPeriodEnd || status === "canceled") {
      return '<span class="chip amber">Cancelled</span>';
    }
    if (status === "active") return '<span class="chip green">Active</span>';
    if (status === "trialing") return '<span class="chip blue">Trial</span>';
    if (status === "past_due") return '<span class="chip rose">Payment failed</span>';
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
    // Cancelled-but-still-active: user clicked Cancel on PayStack; we
    // kept them on their paid plan until period_end but the sub will
    // not renew. From here the "Manage subscription" portal call will
    // fail (PayStack rejects manage on disabled subs), so we swap the
    // UI to a "Switch to Free now" CTA instead.
    const isCancelling = isPaid && (ent.cancel_at_period_end === true || ent.status === "canceled");

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
      ? (isCancelling
          ? "Subscription cancelled — access until " + formatDate(ent.current_period_end)
          : "Renews on " + formatDate(ent.current_period_end))
      : isCancelling
        ? "Subscription cancelled"
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
              (isCancelling
                ? '<button type="button" class="btn-primary" id="billing-downgrade-now"><i class="fa-solid fa-arrow-down"></i> Switch to Free now</button>'
                : isPaid
                  ? '<button type="button" class="btn-secondary" id="billing-portal"><i class="fa-solid fa-credit-card"></i> Manage subscription</button>'
                  : '<button type="button" class="btn-primary" id="billing-upgrade">Upgrade plan</button>') +
            '</div>' +
          '</div>' +
          // Cancel/downgrade explainer. Three states:
          //   - paid + cancelling → explain they'll keep features until
          //     period_end and the button drops them immediately if they
          //     prefer.
          //   - paid + active → standard "Cancel your subscription" link
          //     that routes through PayStack/Stripe portal.
          //   - free → nothing.
          (isCancelling
            ? '<p class="ai-meta billing-cancel-note">' +
                'You\'ll keep ' + st(planLabel) + ' features until your period ends. ' +
                'Click <strong>Switch to Free now</strong> if you\'d rather drop immediately.' +
              '</p>'
            : isPaid
              ? '<p class="ai-meta billing-cancel-note">' +
                  'Want to cancel? ' +
                  '<a href="#" id="billing-cancel-link">Cancel your subscription</a>' +
                  ' — keeps you on your plan until the end of your billing period.' +
                '</p>'
              : '') +

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
    const cancelLink = document.getElementById("billing-cancel-link");
    const downgradeNow = document.getElementById("billing-downgrade-now");
    const open = function () {
      const modal = window.CBV2 && window.CBV2.upgradeModal;
      if (modal && modal.show) modal.show({ reason: "feature_locked" });
    };
    if (upgrade) upgrade.addEventListener("click", open);
    if (upgradeBottom) upgradeBottom.addEventListener("click", open);
    if (portal) portal.addEventListener("click", openPortal);
    // Cancel link goes directly through downgrade-to-free (not through
    // PayStack's portal). The portal route was unreliable: PayStack's
    // /manage page often opens with no cancel button at all (test mode,
    // already-disabled subs, or just PayStack UI quirks), leaving users
    // stuck. downgrade-to-free best-effort tells PayStack to disable,
    // then forces the DB to free regardless — Cancel always works.
    if (cancelLink) cancelLink.addEventListener("click", async function (e) {
      e.preventDefault();
      const modal = window.CBV2 && window.CBV2.modal;
      const proceed = modal && modal.confirm
        ? await modal.confirm({
            title: "Cancel your subscription?",
            body:
              "Your subscription will be cancelled immediately and you'll be moved to the Free plan. " +
              "All your data stays — only the plan changes. You can upgrade again any time.",
            confirmLabel: "Cancel & switch to Free",
            cancelLabel: "Keep my subscription",
            tone: "danger",
          })
        : window.confirm("Cancel your subscription and switch to Free now?");
      if (proceed) await directDowngradeToFree();
    });
    // "Switch to Free now" shortcut for cancelled subs. Confirms first
    // because it's an irreversible-this-cycle action (they'll need to
    // re-subscribe + re-pay if they want their plan back).
    if (downgradeNow) downgradeNow.addEventListener("click", async function () {
      const modal = window.CBV2 && window.CBV2.modal;
      const proceed = modal && modal.confirm
        ? await modal.confirm({
            title: "Switch to Free now?",
            body:
              "Your subscription is already cancelled — you'd normally keep your current plan until period end. " +
              "Switching now drops you to Free immediately. Your data stays, only the plan changes. " +
              "You can upgrade again any time.",
            confirmLabel: "Switch to Free now",
            cancelLabel: "Keep until period ends",
            tone: "danger",
          })
        : window.confirm("Switch to Free now? You'll lose paid features immediately.");
      if (proceed) await directDowngradeToFree();
    });
  }

  // Routes to the right billing portal based on which processor billed
  // this subscription. We look up payment_processor by querying the
  // subscriptions table directly (entitlements doesn't currently expose
  // this field; rather than another migration we just hit the row —
  // RLS lets the user read their own).
  async function openPortal() {
    const portalBtn = document.getElementById("billing-portal");
    if (portalBtn) portalBtn.disabled = true;
    try {
      const auth = window.CBV2 && window.CBV2.auth;
      const c = window.CBV2 && window.CBV2.config;
      if (!auth || !c) throw new Error("Not configured.");
      const client = auth.getClient && auth.getClient();
      const user = auth.getUser && auth.getUser();
      if (!user || !user.id) throw new Error("Not signed in.");

      // Detect the processor that billed this user. Default to paystack
      // (the current processor for new signups).
      let processor = "paystack";
      try {
        if (client && client.from) {
          const { data: subRow } = await client
            .from("subscriptions")
            .select("payment_processor")
            .eq("user_id", user.id)
            .maybeSingle();
          if (subRow && subRow.payment_processor) processor = subRow.payment_processor;
        }
      } catch (_e) { /* fall back to paystack default */ }

      const fnName = processor === "stripe" ? "stripe-portal" : "paystack-portal";
      let url;
      if (client && client.functions && typeof client.functions.invoke === "function") {
        const invoked = await client.functions.invoke(fnName, { body: {} });
        if (invoked.error) {
          // Try to surface structured error message
          let msg = invoked.error.message || "Portal failed.";
          try {
            if (invoked.error.context && typeof invoked.error.context.text === "function") {
              const t = await invoked.error.context.text();
              try { const j = JSON.parse(t); msg = j.error || j.message || msg; }
              catch (_e) { if (t) msg = t.slice(0, 240); }
            }
          } catch (_e) {}
          throw new Error(msg);
        }
        url = invoked.data && invoked.data.url;
      } else {
        const token = await auth.getAccessToken();
        const resp = await fetch(c.getFunctionsUrl() + "/" + fnName, {
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
      const portalBtn2 = document.getElementById("billing-portal");
      const msg = (err && err.message) || "Could not open portal.";
      // Fallback path: when PayStack has no subscription_code for the
      // user (test-mode quirk where charge.success fired without
      // subscription.create), the sub is already cancelled / complete
      // on PayStack's side (so /manage/link is rejected), or any other
      // portal-blocked state — offer a direct "Switch to Free plan"
      // downgrade so the user isn't trapped on a plan they can't manage.
      const noSub =
        /no active.*subscription/i.test(msg) ||
        /not yet available/i.test(msg) ||
        /already.*cancel/i.test(msg) ||
        /subscription.*not.*active/i.test(msg) ||
        /subscription.*complete/i.test(msg) ||
        /subscription.*disabled/i.test(msg);
      if (noSub) {
        const modal = window.CBV2 && window.CBV2.modal;
        const proceed = modal && modal.confirm
          ? await modal.confirm({
              title: "Switch back to the Free plan?",
              body:
                "Your subscription isn't manageable through the PayStack portal right now " +
                "(this can happen on test transactions or partial signups). " +
                "We can immediately switch you to the Free plan instead. " +
                "Your data stays — only the plan changes.",
              confirmLabel: "Switch to Free",
              cancelLabel: "Keep my plan",
              tone: "danger",
            })
          : window.confirm("Switch back to the Free plan?");
        if (proceed) {
          await directDowngradeToFree();
          if (portalBtn2) portalBtn2.disabled = false;
          return;
        }
      }
      if (window.CBV2.toast) window.CBV2.toast.error(msg);
      if (portalBtn2) portalBtn2.disabled = false;
    }
  }

  // Direct downgrade — bypasses the billing portal. Calls the
  // downgrade-to-free edge function which best-effort disables the
  // PayStack subscription (if any) and updates the local subscriptions
  // row to plan_id='free'. Used as the fallback path from openPortal()
  // when the portal can't be opened.
  async function directDowngradeToFree() {
    const auth = window.CBV2 && window.CBV2.auth;
    const c = window.CBV2 && window.CBV2.config;
    if (!auth || !c) return;
    try {
      const client = auth.getClient && auth.getClient();
      let response;
      if (client && client.functions && typeof client.functions.invoke === "function") {
        const invoked = await client.functions.invoke("downgrade-to-free", { body: {} });
        if (invoked.error) throw new Error(invoked.error.message || "Downgrade failed.");
        response = invoked.data;
      } else {
        const token = await auth.getAccessToken();
        const resp = await fetch(c.getFunctionsUrl() + "/downgrade-to-free", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            apikey: c.getSupabaseAnon(),
          },
          body: "{}",
        });
        response = await resp.json();
        if (!resp.ok || !response.ok) throw new Error((response && response.error) || ("HTTP " + resp.status));
      }
      // Refresh entitlements so the UI reflects the new free plan.
      const ent = window.CBV2 && window.CBV2.entitlements;
      if (ent && typeof ent.load === "function") {
        try { await ent.load(true); } catch (_e) {}
      }
      if (window.CBV2.toast) {
        window.CBV2.toast.success("Switched to Free plan. All quotas reset to free-tier limits.");
      }
    } catch (err) {
      if (window.CBV2.toast) {
        window.CBV2.toast.error("Couldn't switch to Free: " + ((err && err.message) || "unknown error"));
      }
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
