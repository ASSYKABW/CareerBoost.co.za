// Settings → Invite friends (referral) card.
//
// Follows the settings sub-module pattern (window.CBV2.settingsReferral.render()
// returns HTML that settings.route.js inlines). To avoid any hydration race
// with the heavy settings re-render, the card renders a button and fetches the
// referral link on click, via a single document-level delegated listener wired
// once at load. Everything degrades to a no-op if auth/config isn't ready.
//
// Backend: POST /functions/v1/referral { action: "my-code" } → { code, url, stats }.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsReferral = window.CBV2.settingsReferral || {};

  function st(v) { return (window.CBV2.sanitizeText || String)(v == null ? "" : v); }

  function render() {
    return '' +
      '<section class="card settings-section" id="cb-referral-card">' +
        '<div class="panel-head">' +
          '<h2>Invite friends</h2>' +
          '<span class="chip cyan">Referral</span>' +
        '</div>' +
        '<p class="page-subtitle">Know someone job hunting? Share your personal link — ' +
          "we'll credit you for every friend who signs up with it.</p>" +
        '<div data-cb-ref-out>' +
          '<button class="btn-primary" type="button" data-cb-ref-get>' +
            '<i class="fa-solid fa-gift"></i> Get my invite link</button>' +
        '</div>' +
      '</section>';
  }

  async function callReferral(action) {
    const auth = window.CBV2.auth;
    const config = window.CBV2.config;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) throw new Error("Please sign in first.");
    // Prefer the supabase client's functions.invoke (handles auth headers).
    const client = auth.getClient && auth.getClient();
    if (client && client.functions && typeof client.functions.invoke === "function") {
      const invoked = await client.functions.invoke("referral", { body: { action: action } });
      if (invoked.error) throw new Error(invoked.error.message || "Request failed");
      return invoked.data;
    }
    if (!config || !config.getFunctionsUrl) throw new Error("Backend not configured.");
    const token = await auth.getAccessToken();
    const resp = await fetch(config.getFunctionsUrl() + "/referral", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: config.getSupabaseAnon ? config.getSupabaseAnon() : "",
      },
      body: JSON.stringify({ action: action }),
    });
    const data = await resp.json();
    if (!resp.ok || !data || data.ok === false) throw new Error((data && data.error) || "Request failed");
    return data;
  }

  function renderResult(out, data) {
    const url = String(data.url || "");
    const n = (data.stats && data.stats.referrals) || 0;
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    out.innerHTML = '' +
      '<div class="referral-link-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
        '<input type="text" readonly data-cb-ref-link value="' + st(url) + '" ' +
          'style="flex:1;min-width:220px;padding:9px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,0.15));background:rgba(255,255,255,0.04);color:inherit;font-size:13px;" />' +
        '<button class="btn-ghost" type="button" data-cb-ref-copy><i class="fa-solid fa-copy"></i> Copy</button>' +
        (canShare ? '<button class="btn-ghost" type="button" data-cb-ref-share><i class="fa-solid fa-share-nodes"></i> Share</button>' : '') +
      '</div>' +
      '<p class="ai-meta" data-cb-ref-stats>You\'ve referred <strong>' + st(String(n)) +
        '</strong> friend' + (n === 1 ? '' : 's') + ' so far.</p>';
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (label != null) btn.innerHTML = label;
  }

  async function copyLink(input, btn) {
    const text = input ? input.value : "";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (input) {
        input.focus(); input.select(); document.execCommand("copy");
      }
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
      setTimeout(function () { btn.innerHTML = orig; }, 1600);
    } catch (e) { /* ignore */ }
  }

  // One delegated listener for the whole card lifecycle.
  document.addEventListener("click", function (e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;

    const getBtn = t.closest("[data-cb-ref-get]");
    if (getBtn) {
      e.preventDefault();
      const card = getBtn.closest("#cb-referral-card");
      const out = card && card.querySelector("[data-cb-ref-out]");
      setBusy(getBtn, true, '<i class="fa-solid fa-spinner fa-spin"></i> Loading…');
      callReferral("my-code")
        .then(function (data) { if (out) renderResult(out, data); })
        .catch(function (err) {
          setBusy(getBtn, false, '<i class="fa-solid fa-gift"></i> Get my invite link');
          if (out) {
            const msg = document.createElement("p");
            msg.className = "ai-meta";
            msg.style.color = "var(--danger,#ff8080)";
            msg.textContent = (err && err.message) || "Couldn't load your link. Please try again.";
            out.appendChild(msg);
          }
        });
      return;
    }

    const copyBtn = t.closest("[data-cb-ref-copy]");
    if (copyBtn) {
      e.preventDefault();
      const row = copyBtn.closest(".referral-link-row");
      copyLink(row && row.querySelector("[data-cb-ref-link]"), copyBtn);
      return;
    }

    const shareBtn = t.closest("[data-cb-ref-share]");
    if (shareBtn) {
      e.preventDefault();
      const row = shareBtn.closest(".referral-link-row");
      const input = row && row.querySelector("[data-cb-ref-link]");
      const url = input ? input.value : "";
      if (navigator.share && url) {
        navigator.share({
          title: "CareerBoost",
          text: "I'm using CareerBoost for my job search — join me:",
          url: url,
        }).catch(function () { /* user cancelled */ });
      }
    }
  });

  window.CBV2.settingsReferral.render = render;
})();
