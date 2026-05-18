# Supabase Email Template — Include OTP Code

The frontend now ships a 6-digit code entry route (`#/auth/verify`) for
new signups (P3). For the code to actually arrive in users' inboxes,
the **Supabase email template needs ONE change** that you make in the
dashboard. This doc walks through it.

---

## Why this is needed

Supabase's default "Confirm signup" email contains only the magic
link (`{{ .ConfirmationURL }}`). Our app now expects either:
- The user clicks the link → lands on `#/auth/confirmed` (existing
  success flow — already works), OR
- The user types the 6-digit code into `#/auth/verify` (new primary
  flow — more secure, no phishable URL).

For the code path to work, the email template must include
`{{ .Token }}` (the OTP). The template change is purely additive — it
keeps the link AND adds the code.

---

## Step-by-step

### 1. Open the email template editor

In the Supabase dashboard, navigate to **Authentication → Emails →
Templates** tab. (Sidebar wording may vary; on the current dashboard
it's under the **NOTIFICATIONS** group, "Email" item.) You should see
five templates listed:
- Confirm sign up ← **update this one for OTP**
- Invite user
- Magic link
- Change email address
- Reset password ← **update this one too for branded reset email**

Click "Confirm sign up" first.

### 2. Replace the body with this template

Copy/paste the entire HTML below into the editor:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #f6f8fc; padding: 24px; color: #0f172a; }
    .card { max-width: 480px; margin: 0 auto; background: #fff;
            border-radius: 16px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.02em;
            background: linear-gradient(135deg, #5eead4, #a78bfa);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; }
    h1 { font-size: 22px; margin: 16px 0 8px; }
    p { font-size: 14px; line-height: 1.55; color: #475569; }
    .code { display: inline-block; font-size: 32px; letter-spacing: 8px;
            font-weight: 700; padding: 14px 22px; margin: 18px 0;
            background: #f1f5f9; border-radius: 12px; color: #0f172a;
            font-family: "SF Mono", Menlo, monospace; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 10px;
           background: linear-gradient(135deg, #5eead4, #a78bfa);
           color: #0f172a !important; text-decoration: none; font-weight: 600;
           margin-top: 12px; }
    .meta { margin-top: 28px; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">CareerBoost</div>
    <h1>Confirm your email</h1>
    <p>Enter this 6-digit code in the CareerBoost confirmation page:</p>
    <div class="code">{{ .Token }}</div>
    <p>Or click the button below to confirm directly:</p>
    <p><a class="btn" href="{{ .ConfirmationURL }}">Confirm my email</a></p>
    <p class="meta">
      This code and link expire in 1 hour. If you didn't sign up for
      CareerBoost, just ignore this email — your address won't be added
      to any account.
    </p>
  </div>
</body>
</html>
```

### 3. Update the subject line (optional)

Above the body editor, change subject from `Confirm your signup` to:
```
Your CareerBoost confirmation code
```

### 4. Save

Click "Save changes" at the bottom. The new template is live
immediately — next signup will receive it.

---

## Bonus: branded "Reset password" template

While you're in the editor, click **"Reset password"** and paste this
in. Matches the same branded card style.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #f6f8fc; padding: 24px; color: #0f172a; }
    .card { max-width: 480px; margin: 0 auto; background: #fff;
            border-radius: 16px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.02em;
            background: linear-gradient(135deg, #5eead4, #a78bfa);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; }
    h1 { font-size: 22px; margin: 16px 0 8px; }
    p { font-size: 14px; line-height: 1.55; color: #475569; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 10px;
           background: linear-gradient(135deg, #5eead4, #a78bfa);
           color: #0f172a !important; text-decoration: none; font-weight: 600;
           margin-top: 12px; }
    .meta { margin-top: 28px; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">CareerBoost</div>
    <h1>Reset your password</h1>
    <p>We received a request to reset the password on your CareerBoost account. Click the button below to choose a new password:</p>
    <p><a class="btn" href="{{ .ConfirmationURL }}">Reset my password</a></p>
    <p class="meta">
      This link expires in 1 hour. If you didn't request a password
      reset, you can safely ignore this email — your password won't
      change.
    </p>
  </div>
</body>
</html>
```

Subject line:
```
Reset your CareerBoost password
```

Click "Save changes" again.

---

## How to verify it worked

### Option A: real signup
1. Go to https://www.careerboost.co.za/#/auth?mode=signup
2. Use a test email (e.g. yours +test). Submit the form.
3. Open the email — you should see a big 6-digit code AND a button.
4. Type the code into the verify page → instant signin.
5. Or click the button → lands on the "You're in!" success page.

### Option B: dashboard preview
- In the same template editor, click "Send test email" to send the
  template to yourself without going through the signup form.

---

## Security knobs worth knowing

### OTP expiry (default: 1 hour)
- Dashboard → Settings → Auth → "Email OTP expiration"
- Recommend tightening to **15 minutes** for tighter risk.
- Trade-off: users who get distracted have to request a resend.

### Rate limiting (built into Supabase)
- 1 resend per 60 seconds per email (Supabase enforced server-side).
- Our `auth.verify.js` matches that with a 60s cooldown timer in the
  UI so users never see "wait 47 seconds" errors.
- 5 wrong code attempts per minute (rough; Supabase tunes this).
  Our UI adds a 5-attempt local lockout for 60s as a UX guide.

### Email + password rules
- Frontend now enforces password ≥ 10 chars + letter + number + not on
  a common-password blocklist. See `auth.route.js` `PASSWORD_RULES`.
- Backend (Supabase) only enforces a minimum length. To raise it
  server-side too: Dashboard → Settings → Auth → "Minimum password
  length" → set to 10.

### Optional: enforce email confirmation
- Dashboard → Settings → Auth → "Confirm email" toggle.
- **Should be ON** (default). With it off, users can sign in before
  confirming, which defeats the entire OTP flow.

---

## Rollback (just in case)

If the OTP flow ever causes a real-world issue and you need to revert:
1. Restore the original "Confirm signup" template (Dashboard editor has
   a "Reset to default" button).
2. Set `window.CB_CONFIG.featureFlags.otpVerify = false` (or just
   remove the redirect from `auth.route.js` signup branch).
3. Users will go back to the link-only flow, which still works
   end-to-end via `auth.confirmed.js`.

Both paths converge on the same successful session, so the rollback
has no downstream impact.
