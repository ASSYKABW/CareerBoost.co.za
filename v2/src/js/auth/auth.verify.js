// P3 signup-security: dedicated #/auth/verify route.
//
// Flow:
//   1. User signs up at #/auth?mode=signup.
//   2. auth.route.js calls signUpWithPassword(), then redirects to
//      #/auth/verify?email=<their_email> (the email goes through the
//      URL — convenient, low-risk; Supabase already knows who they
//      are based on the OTP code itself).
//   3. THIS route renders a 6-digit code input. User types the code
//      from their email and submits.
//   4. We call window.CBV2.auth.verifyEmailOtp(email, code). On
//      success the SDK stores the session and onChange listeners
//      (including the router) navigate to dashboard/onboarding.
//   5. If the user clicks the link in the email instead of typing the
//      code, they land on #/auth/confirmed (existing route) — that
//      still works. Both paths converge.
//
// Security additions vs. link-only flow:
//   - No phishable URL involved in the primary path.
//   - Per-attempt local rate-limit: 5 wrong codes locks the form for
//     60s. Supabase has its own rate limit on the server side; this
//     is just to nudge bots toward different behavior.
//   - Resend is throttled to 60s in the UI (matches Supabase default).
//   - Code input is auto-trimmed + non-numeric stripped + 6-char cap
//     so users can paste "123 456" or "Code: 123456" cleanly.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const state = {
    email: "",        // user being verified (read from ?email=... or sessionStorage)
    code: "",
    busy: false,
    error: "",
    info: "",
    attempts: 0,
    lockedUntil: 0,   // epoch ms; while > now, form is disabled
    resendCooldownUntil: 0, // epoch ms
    resendBusy: false
  };

  const MAX_ATTEMPTS = 5;
  const LOCK_MS = 60 * 1000;
  const RESEND_COOLDOWN_MS = 60 * 1000;
  const STORAGE_KEY = "cb_signup_pending_email";

  function st(value) {
    return (window.CBV2.sanitizeText || String)(value);
  }
  function renderBrand() {
    if (window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function") {
      return window.CBV2.brandKit.logo({ compact: false, tagline: true });
    }
    return "Career<span>Boost</span>";
  }

  // Read email from URL ?email=... or sessionStorage (set by the
  // signup flow). Falling back to an empty string just shows a
  // "type your email" input.
  function loadEmail() {
    try {
      const params = window.CBV2.getRouteParams ? window.CBV2.getRouteParams() : {};
      const fromParams = params && params.email ? String(params.email).trim().toLowerCase() : "";
      if (fromParams) {
        state.email = fromParams;
        try { sessionStorage.setItem(STORAGE_KEY, fromParams); } catch (_e) {}
        return;
      }
      const stored = sessionStorage.getItem(STORAGE_KEY) || "";
      if (stored) state.email = String(stored).trim().toLowerCase();
    } catch (_e) { /* private mode — leave empty */ }
  }

  function lockedRemaining() {
    return Math.max(0, state.lockedUntil - Date.now());
  }
  function resendRemaining() {
    return Math.max(0, state.resendCooldownUntil - Date.now());
  }
  function isLocked() {
    return lockedRemaining() > 0;
  }

  function renderView() {
    const formDisabled = state.busy || isLocked();
    const codeBoxes = renderCodeInput(state.code, formDisabled);
    const lockSecs = Math.ceil(lockedRemaining() / 1000);
    const resendSecs = Math.ceil(resendRemaining() / 1000);

    const lockBanner = isLocked()
      ? '<div class="ai-notice rose"><i class="fa-solid fa-lock"></i>' +
        '<div>Too many attempts. Try again in <strong>' + lockSecs + 's</strong>.</div></div>'
      : "";

    const errorBanner = (!isLocked() && state.error)
      ? '<div class="ai-notice rose"><i class="fa-solid fa-circle-xmark"></i><div>' + st(state.error) + '</div></div>'
      : "";

    const infoBanner = state.info
      ? '<div class="ai-notice"><i class="fa-solid fa-circle-check"></i><div>' + st(state.info) + '</div></div>'
      : "";

    const resendBtn = resendSecs > 0
      ? '<button type="button" class="btn-ghost" id="auth-verify-resend" disabled>' +
          'Resend in ' + resendSecs + 's' +
        '</button>'
      : '<button type="button" class="btn-ghost" id="auth-verify-resend"' +
          (state.resendBusy ? ' disabled' : '') + '>' +
          (state.resendBusy
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Sending…'
            : '<i class="fa-solid fa-paper-plane"></i> Resend code') +
        '</button>';

    const emailRow = state.email
      ? '<p class="auth-verify-target">Sent to <strong>' + st(state.email) + '</strong>. <a href="#/auth?mode=signup">Wrong email?</a></p>'
      : '<label>Email<input id="auth-verify-email" type="email" autocomplete="email" required placeholder="you@example.com" /></label>';

    return (
      '<section class="auth-container">' +
        '<div class="auth-card auth-verify-card">' +
          '<a class="auth-back" href="#/auth"><i class="fa-solid fa-arrow-left"></i> Back to sign in</a>' +
          '<div class="auth-brand">' + renderBrand() + "</div>" +
          '<h1 class="auth-title">Check your email</h1>' +
          '<p class="auth-subtitle">We sent a 6-digit code to confirm your address. Enter it below — or click the link in the email if you prefer.</p>' +
          emailRow +
          '<form class="auth-form auth-verify-form" id="auth-verify-form" autocomplete="off">' +
            '<label class="auth-verify-label">Verification code</label>' +
            codeBoxes +
            errorBanner +
            lockBanner +
            infoBanner +
            '<div class="auth-submit-row">' +
              '<button class="btn-primary" type="submit"' + (formDisabled ? ' disabled' : '') + '>' +
                (state.busy
                  ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Verifying…'
                  : '<i class="fa-solid fa-shield-check"></i> Verify email') +
              '</button>' +
              resendBtn +
            '</div>' +
            '<p class="auth-verify-hint">Code expires after 1 hour. Codes are 6 digits, like <code>123456</code>.</p>' +
          '</form>' +
          '<p class="auth-legal">Didn\'t get an email? Check your spam folder or use the resend button above. Codes from previous emails stop working once a new one is sent.</p>' +
        "</div>" +
      "</section>"
    );
  }

  // Six discrete input boxes so the code looks like a real OTP input.
  // We bind one input listener per box that auto-advances + handles
  // paste (a 6-digit paste in any box fills them all).
  function renderCodeInput(code, disabled) {
    const cleaned = String(code || "").replace(/\D/g, "").slice(0, 6);
    let html = '<div class="auth-otp-row">';
    for (let i = 0; i < 6; i += 1) {
      const ch = cleaned[i] || "";
      html += '<input type="text" inputmode="numeric" pattern="\\d*" maxlength="1" ' +
              'class="auth-otp-box" data-otp-index="' + i + '" ' +
              'autocomplete="one-time-code" ' +
              (i === 0 ? 'autofocus ' : '') +
              (disabled ? 'disabled ' : '') +
              'value="' + st(ch) + '" />';
    }
    html += '</div>';
    return html;
  }

  function rerender() {
    const outlet = document.getElementById("route-view");
    if (outlet) outlet.innerHTML = renderView();
    bindHandlers();
    focusFirstEmptyBox();
  }

  function focusFirstEmptyBox() {
    const boxes = document.querySelectorAll(".auth-otp-box");
    for (let i = 0; i < boxes.length; i += 1) {
      if (!boxes[i].value && !boxes[i].disabled) {
        try { boxes[i].focus(); } catch (_e) {}
        return;
      }
    }
  }

  function readCodeFromBoxes() {
    const boxes = document.querySelectorAll(".auth-otp-box");
    let out = "";
    boxes.forEach(function (b) { out += String(b.value || "").replace(/\D/g, ""); });
    return out.slice(0, 6);
  }

  async function submit(ev) {
    if (ev) ev.preventDefault();
    if (state.busy || isLocked()) return;

    // Allow user to type/correct their email if it wasn't passed in.
    if (!state.email) {
      const emailField = document.getElementById("auth-verify-email");
      const typedEmail = emailField ? String(emailField.value || "").trim().toLowerCase() : "";
      if (!typedEmail) {
        state.error = "Enter the email you signed up with.";
        rerender();
        return;
      }
      state.email = typedEmail;
      try { sessionStorage.setItem(STORAGE_KEY, typedEmail); } catch (_e) {}
    }

    state.code = readCodeFromBoxes();
    if (state.code.length !== 6) {
      state.error = "Enter all 6 digits of the code.";
      rerender();
      return;
    }
    state.busy = true;
    state.error = "";
    state.info = "";
    rerender();

    try {
      await window.CBV2.auth.verifyEmailOtp(state.email, state.code);
      // Success — session is established. Clear the pending email
      // marker + route to onboarding. The router's auth listener will
      // also fire; this hash change just speeds up the transition.
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (_e) {}
      state.info = "Email verified! Redirecting…";
      rerender();
      setTimeout(function () {
        window.location.hash = "#/onboarding";
      }, 600);
    } catch (err) {
      state.attempts += 1;
      const msg = (err && err.message) || "That code didn't work.";
      // Friendlier copy for the common Supabase errors.
      if (/expired/i.test(msg)) {
        state.error = "Code expired. Use the resend button to get a fresh one.";
      } else if (/invalid|incorrect|otp/i.test(msg)) {
        state.error = "Wrong code. Double-check the latest email and try again.";
      } else {
        state.error = msg;
      }
      if (state.attempts >= MAX_ATTEMPTS) {
        state.lockedUntil = Date.now() + LOCK_MS;
        state.attempts = 0;
      }
      // Clear the code so the user has to retype (a small but
      // meaningful friction against automated brute-force).
      state.code = "";
      state.busy = false;
      rerender();
      // Tick once a second to update the lockout countdown.
      if (isLocked()) startLockoutTimer();
    }
  }

  async function resend() {
    if (state.resendBusy || resendRemaining() > 0) return;
    if (!state.email) {
      const emailField = document.getElementById("auth-verify-email");
      const typedEmail = emailField ? String(emailField.value || "").trim().toLowerCase() : "";
      if (!typedEmail) {
        state.error = "Type the email you signed up with first.";
        rerender();
        return;
      }
      state.email = typedEmail;
    }
    state.resendBusy = true;
    state.error = "";
    rerender();
    try {
      await window.CBV2.auth.resendSignupOtp(state.email);
      state.info = "New code sent. Check your inbox.";
      state.resendCooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
      startResendCooldownTimer();
    } catch (err) {
      const msg = (err && err.message) || "Couldn't resend the code.";
      // Supabase returns "For security purposes, you can only request this after X seconds"
      // when called too soon — turn that into a clear cooldown message.
      const match = msg.match(/after\s+(\d+)\s+seconds?/i);
      if (match) {
        const secs = Number(match[1]);
        state.resendCooldownUntil = Date.now() + secs * 1000;
        state.error = "Wait " + secs + "s before requesting another code.";
        startResendCooldownTimer();
      } else {
        state.error = msg;
      }
    } finally {
      state.resendBusy = false;
      rerender();
    }
  }

  let lockoutTickerId = null;
  function startLockoutTimer() {
    if (lockoutTickerId) return;
    lockoutTickerId = setInterval(function () {
      if (!isLocked()) {
        clearInterval(lockoutTickerId);
        lockoutTickerId = null;
      }
      rerender();
    }, 1000);
  }

  let resendTickerId = null;
  function startResendCooldownTimer() {
    if (resendTickerId) return;
    resendTickerId = setInterval(function () {
      if (resendRemaining() <= 0) {
        clearInterval(resendTickerId);
        resendTickerId = null;
      }
      rerender();
    }, 1000);
  }

  function bindHandlers() {
    const form = document.getElementById("auth-verify-form");
    if (form) form.addEventListener("submit", submit);

    const resendBtn = document.getElementById("auth-verify-resend");
    if (resendBtn) resendBtn.addEventListener("click", resend);

    // OTP box wiring — auto-advance + handle paste.
    const boxes = document.querySelectorAll(".auth-otp-box");
    boxes.forEach(function (box, idx) {
      box.addEventListener("input", function () {
        const v = String(box.value || "").replace(/\D/g, "").slice(-1);
        box.value = v;
        if (v && idx < boxes.length - 1) {
          boxes[idx + 1].focus();
        }
        // Auto-submit when all 6 boxes are filled.
        if (idx === boxes.length - 1 && readCodeFromBoxes().length === 6) {
          submit();
        }
      });
      box.addEventListener("keydown", function (e) {
        if (e.key === "Backspace" && !box.value && idx > 0) {
          boxes[idx - 1].focus();
        }
      });
      box.addEventListener("paste", function (e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text") || "";
        const cleaned = String(text).replace(/\D/g, "").slice(0, 6);
        for (let i = 0; i < boxes.length; i += 1) {
          boxes[i].value = cleaned[i] || "";
        }
        if (cleaned.length === 6) submit();
        else if (cleaned.length > 0) boxes[Math.min(cleaned.length, boxes.length - 1)].focus();
      });
    });
  }

  function afterRender() {
    loadEmail();
    // Re-render once on enter so the email row, lock state, and any
    // resend timer state from a recent submission show correctly.
    rerender();
    focusFirstEmptyBox();
  }

  window.CBV2.routes["auth/verify"] = renderView;
  window.CBV2.afterRender["auth/verify"] = afterRender;
})();
