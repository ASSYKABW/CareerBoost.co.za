// Day 3.2 — MFA elevation gate for the admin route.
//
// When an operator with a verified TOTP factor lands on /admin and
// their session is still aal1 (single factor — password only), this
// module renders an inline 6-digit-code challenge between them and
// the admin console. Submitting the code calls mfa.challenge +
// mfa.verify; on success the session is elevated to aal2 and the
// admin route re-renders normally.
//
// Why this is "admin route only" rather than baked into sign-in:
//   - Regular users never see a prompt — only operators do.
//   - No risk to the existing sign-in flow, which has zero MFA code
//     and would need a bigger refactor to support full challenge UI.
//   - Day 3.2's server-side aal2 enforcement (getAuthedAdmin) lives
//     paired with this exact UI, so the two surfaces stay in sync.
//
// Non-admins are stopped earlier by adminAccessState's role check —
// they never trigger this module. Admins WITHOUT a verified factor
// see a friendly nudge pointing them at /mfa-setup.html.
//
// Snapshot lifecycle:
//   - getSnapshot() — sync, returns cached state for adminAccessState
//     (which has to answer synchronously inside renderView)
//   - refreshSnapshot() — async, hits mfa.getAuthenticatorAssuranceLevel
//     + mfa.listFactors. Called on cold mount + after every verify.
//   - The snapshot is read-only state used by adminAccessState; the
//     actual challenge UI is rendered by renderChallengeScreen.

(function () {
  window.CBV2 = window.CBV2 || {};

  // Cached MFA state. Reads MUST be synchronous because adminAccessState
  // is called inside renderView and the route renderer doesn't await.
  // Until the first refresh completes the snapshot is "unknown" and
  // adminAccessState falls back to a loading placeholder.
  const snapshot = {
    loaded: false,
    loading: false,
    error: null,
    currentLevel: null,     // "aal1" | "aal2" | null
    nextLevel: null,         // "aal1" | "aal2" | null
    verifiedFactors: [],     // [{ id, friendly_name }]
    lastRefreshAt: 0,
  };

  // Submission state for the challenge form. Lives at module scope so
  // a re-render between submit and result preserves "Verifying…" + the
  // last error.
  let submitting = false;
  let submitError = "";

  function getClient() {
    const auth = window.CBV2.auth;
    return auth && auth.getClient ? auth.getClient() : null;
  }

  function getSnapshot() {
    return snapshot;
  }

  // Async refresh of the cached snapshot. Hits two endpoints:
  //   - getAuthenticatorAssuranceLevel — current/next AAL from JWT
  //   - listFactors — gives us factor IDs for the challenge call
  // Both errors fail soft (snapshot.error is set) so adminAccessState
  // can fall back to the enroll nudge rather than locking the user
  // out entirely on a transient SDK glitch.
  async function refreshSnapshot() {
    if (snapshot.loading) return snapshot;
    snapshot.loading = true;
    snapshot.error = null;
    const client = getClient();
    if (!client) {
      snapshot.loading = false;
      return snapshot;
    }
    try {
      const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal.error) throw aal.error;
      const factors = await client.auth.mfa.listFactors();
      if (factors.error) throw factors.error;
      snapshot.currentLevel = aal.data && aal.data.currentLevel ? aal.data.currentLevel : null;
      snapshot.nextLevel = aal.data && aal.data.nextLevel ? aal.data.nextLevel : null;
      const totp = (factors.data && (factors.data.totp || [])) || [];
      snapshot.verifiedFactors = totp
        .filter(function (f) { return f.status === "verified"; })
        .map(function (f) { return { id: f.id, friendly_name: f.friendly_name || "" }; });
      snapshot.loaded = true;
      snapshot.lastRefreshAt = Date.now();
    } catch (err) {
      snapshot.error = (err && err.message) || String(err);
      snapshot.loaded = true; // Even on error, mark as loaded so we stop showing the spinner forever.
      console.warn("[admin.mfa] refresh failed:", snapshot.error);
    } finally {
      snapshot.loading = false;
    }
    return snapshot;
  }

  function rerender() {
    if (typeof window.CBV2.renderCurrentRoute === "function") {
      window.CBV2.renderCurrentRoute();
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];
    });
  }

  // ---- Renderers -----------------------------------------------------------

  // Loading placeholder while refreshSnapshot is in flight on cold mount.
  function renderLoadingScreen() {
    return (
      '<section class="admin-auth-screen">' +
        '<article class="admin-auth-card">' +
          '<span class="admin-kicker"><i class="fa-solid fa-shield-halved"></i> Checking MFA</span>' +
          '<h1>Verifying your operator session…</h1>' +
          '<p>Looking up your enrolled factors and current assurance level. This usually takes under a second.</p>' +
        '</article>' +
      '</section>'
    );
  }

  // Shown when the operator passed the role check but has not enrolled
  // a TOTP factor yet. Points them at the standalone setup page.
  function renderEnrollNudge() {
    return (
      '<section class="admin-auth-screen">' +
        '<article class="admin-auth-card">' +
          '<span class="admin-kicker"><i class="fa-solid fa-shield-halved"></i> MFA required</span>' +
          '<h1>Set up two-factor authentication.</h1>' +
          '<p>Your operator account does not have a verified TOTP factor yet. Enroll one via the setup helper, then come back here and you\'ll be prompted for a 6-digit code on each admin session.</p>' +
          '<div class="admin-auth-actions">' +
            '<a class="btn-primary" href="/mfa-setup.html" target="_blank" rel="noopener"><i class="fa-solid fa-key"></i> Open MFA setup</a>' +
            '<a class="btn-ghost" href="#/dashboard"><i class="fa-solid fa-arrow-left"></i> Back to app</a>' +
          '</div>' +
        '</article>' +
      '</section>'
    );
  }

  // The actual 6-digit-code form. Single autofocused input + submit.
  // Re-renders on every keystroke would lose focus, so the input is
  // uncontrolled — we only read its value at submit time.
  function renderChallengeScreen() {
    const factor = snapshot.verifiedFactors[0];
    const label = factor && factor.friendly_name ? factor.friendly_name : "your authenticator";
    const errHtml = submitError
      ? '<div class="admin-mfa-error" role="alert"><i class="fa-solid fa-circle-exclamation"></i> ' + escapeHtml(submitError) + '</div>'
      : "";
    return (
      '<section class="admin-auth-screen">' +
        '<article class="admin-auth-card admin-mfa-card">' +
          '<span class="admin-kicker"><i class="fa-solid fa-shield-halved"></i> Two-factor verification</span>' +
          '<h1>Enter the 6-digit code.</h1>' +
          '<p>Open <strong>' + escapeHtml(label) + '</strong> and type the current code. Codes rotate every 30 seconds.</p>' +
          '<form id="admin-mfa-form" class="admin-mfa-form" autocomplete="off" novalidate>' +
            '<input type="text" id="admin-mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="000000" ' +
              (submitting ? "disabled " : "") + 'aria-label="6-digit code" required>' +
            '<div class="admin-auth-actions">' +
              '<button class="btn-primary" type="submit"' + (submitting ? " disabled" : "") + '>' +
                '<i class="fa-solid fa-' + (submitting ? "spinner fa-spin-pulse" : "check") + '"></i> ' +
                (submitting ? "Verifying…" : "Verify &amp; enter") +
              '</button>' +
              '<a class="btn-ghost" href="#/dashboard"><i class="fa-solid fa-arrow-left"></i> Cancel</a>' +
            '</div>' +
            errHtml +
          '</form>' +
        '</article>' +
      '</section>'
    );
  }

  // ---- Form binding --------------------------------------------------------

  // Called from admin.route.js afterRender hook. Idempotent: the
  // dataset.bound guard means we only attach the submit listener once
  // even when the route re-renders mid-typing.
  function bindChallengeForm() {
    const form = document.getElementById("admin-mfa-form");
    if (!form || form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    // Auto-focus the input. autofocus attribute doesn't fire reliably
    // after a hash-route re-render, so do it explicitly.
    const input = document.getElementById("admin-mfa-code");
    if (input) {
      try { input.focus(); } catch (_e) {}
    }

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (submitting) return;
      const codeInput = document.getElementById("admin-mfa-code");
      const code = (codeInput && codeInput.value || "").trim().replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) {
        submitError = "Enter the 6-digit code from your authenticator.";
        rerender();
        return;
      }
      const factor = snapshot.verifiedFactors[0];
      if (!factor) {
        submitError = "No verified TOTP factor found. Enroll one via the setup page first.";
        rerender();
        return;
      }
      submitting = true;
      submitError = "";
      rerender();
      try {
        const client = getClient();
        if (!client) throw new Error("Supabase client unavailable.");
        const ch = await client.auth.mfa.challenge({ factorId: factor.id });
        if (ch.error) throw ch.error;
        const challengeId = ch.data && ch.data.id;
        const ver = await client.auth.mfa.verify({ factorId: factor.id, challengeId: challengeId, code: code });
        if (ver.error) throw ver.error;
        // Success — session is now aal2. Refresh the snapshot so the
        // next adminAccessState call returns ok=true, then re-render.
        submitting = false;
        await refreshSnapshot();
        rerender();
      } catch (err) {
        submitError = (err && err.message) || "Verification failed.";
        submitting = false;
        rerender();
      }
    });
  }

  // ---- Public API ----------------------------------------------------------

  window.CBV2.adminMfa = {
    getSnapshot: getSnapshot,
    refreshSnapshot: refreshSnapshot,
    renderLoadingScreen: renderLoadingScreen,
    renderChallengeScreen: renderChallengeScreen,
    renderEnrollNudge: renderEnrollNudge,
    bindChallengeForm: bindChallengeForm,
  };

  // ---- Auth-state subscription --------------------------------------------
  //
  // The AAL can change in several places: SIGNED_IN (back to aal1
  // because password sign-in resets), TOKEN_REFRESHED (rare but possible
  // if server-side claims changed), SIGNED_OUT (snapshot becomes stale).
  // Mark the snapshot stale on each so the next adminAccessState call
  // triggers a refresh. We do NOT re-render here — admin.route.js owns
  // the render lifecycle and re-rendering from inside an auth event can
  // cause loops (see lessons from mfa-setup.html).
  function maybeSubscribe() {
    const client = getClient();
    if (!client) {
      setTimeout(maybeSubscribe, 200);
      return;
    }
    client.auth.onAuthStateChange(function (event) {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "TOKEN_REFRESHED") {
        snapshot.loaded = false;
      }
    });
  }
  maybeSubscribe();
})();
