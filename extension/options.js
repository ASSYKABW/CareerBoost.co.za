function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response from extension." });
    });
  });
}

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, tone) {
  const el = $("status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone || "";
}

async function refresh() {
  const status = await sendMessage({ type: "CB_GET_STATUS" });
  if (!status.ok) {
    setStatus(status.error || "Could not load extension status.", "error");
    return;
  }
  $("supabase-url").value = status.supabaseUrl || "";
  $("functions-url").value = status.functionsUrl || "";
  $("target").value = status.target || "pipeline";
  if (status.email) $("email").value = status.email;
  setStatus(
    status.connected
      ? `Connected${status.email ? " as " + status.email : ""}. LinkedIn saves will go to ${status.target}.`
      : "Not connected yet. Sign in before saving LinkedIn jobs.",
    status.connected ? "success" : ""
  );
}

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.sync.get({ supabaseAnon: "" });
  $("supabase-anon").value = stored.supabaseAnon || "";
  await refresh();

  $("config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await sendMessage({
      type: "CB_SAVE_CONFIG",
      config: {
        supabaseUrl: $("supabase-url").value,
        supabaseAnon: $("supabase-anon").value,
        functionsUrl: $("functions-url").value,
        target: $("target").value
      }
    });
    if (!response.ok) {
      setStatus(response.error || "Could not save configuration.", "error");
      return;
    }
    setStatus("Configuration saved.", "success");
    await refresh();
  });

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("Signing in...", "");
    const response = await sendMessage({
      type: "CB_SIGN_IN",
      email: $("email").value,
      password: $("password").value
    });
    $("password").value = "";
    if (!response.ok) {
      setStatus(response.error || "Sign in failed.", "error");
      return;
    }
    setStatus("Signed in. You can now save jobs.", "success");
    await refresh();
  });

  // Phase 6.5: Google OAuth via chrome.identity.launchWebAuthFlow.
  // Opens a Chrome-managed popup, lets the user sign in with Google,
  // then captures the redirect tokens. No password storage.
  const googleBtn = $("oauth-google");
  if (googleBtn) {
    googleBtn.addEventListener("click", async () => {
      setStatus("Opening Google sign-in...", "");
      googleBtn.disabled = true;
      try {
        const response = await sendMessage({
          type: "CB_SIGN_IN_OAUTH",
          provider: "google"
        });
        if (!response.ok) {
          setStatus(response.error || "Google sign-in failed.", "error");
          return;
        }
        setStatus("Signed in with Google. You can now save jobs.", "success");
        await refresh();
      } finally {
        googleBtn.disabled = false;
      }
    });
  }

  $("sign-out").addEventListener("click", async () => {
    const response = await sendMessage({ type: "CB_SIGN_OUT" });
    if (!response.ok) {
      setStatus(response.error || "Could not sign out.", "error");
      return;
    }
    setStatus("Signed out.", "");
    await refresh();
  });
});
