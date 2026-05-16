// CareerBoost extension background service worker.
//
// Phase 6 changes:
//   1. CB_IMPORT_JOB now accepts an optional `vendor` field (linkedin |
//      indeed | greenhouse | lever) and an optional `diagnostics` blob
//      from the content-script extractor. Both are forwarded to /job-import
//      so the backend can rollup per-vendor + detect when an adapter starts
//      returning weak data (e.g. JSON-LD broke, falling back to selectors).
//   2. Save-status badge — a subtle green dot when signed in + connected,
//      red when reconnect needed. Updated on session change + on each
//      successful/failed save.

const DEFAULT_CONFIG = {
  supabaseUrl: "https://kddffkhwpbngiupfmcse.supabase.co",
  supabaseAnon:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkZGZma2h3cGJuZ2l1cGZtY3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MjE4MDAsImV4cCI6MjA5MjE5NzgwMH0.glvjjwKq3JeOy8HF71JfwzW0m45DvwK8tSbnqxu-JY8",
  functionsUrl: "",
  target: "pipeline",
  email: "",
  accessToken: "",
  refreshToken: "",
  expiresAt: 0
};

function deriveFunctionsUrl(supabaseUrl) {
  return String(supabaseUrl || "").replace(/\/+$/, "") + "/functions/v1";
}

function getConfig() {
  return chrome.storage.sync.get(DEFAULT_CONFIG).then((cfg) => {
    // Self-heal: if any required field was overwritten with an empty
    // string (typically by clicking "Save settings" with the collapsed
    // Developer Connection panel blank), fall back to DEFAULT_CONFIG.
    // Without this, supabaseAnon = "" would make every Auth request
    // come back as "No API key found in request" — which is exactly
    // the bug we kept hitting for users who only meant to change the
    // save target.
    const supabaseUrl = String(cfg.supabaseUrl || DEFAULT_CONFIG.supabaseUrl).replace(/\/+$/, "");
    const supabaseAnon = String(cfg.supabaseAnon || DEFAULT_CONFIG.supabaseAnon);
    return Object.assign({}, cfg, {
      supabaseUrl,
      supabaseAnon,
      functionsUrl: String(cfg.functionsUrl || deriveFunctionsUrl(supabaseUrl)).replace(/\/+$/, ""),
      target: cfg.target || "pipeline"
    });
  });
}

function saveConfig(patch) {
  const clean = {};
  ["supabaseUrl", "supabaseAnon", "functionsUrl", "target"].forEach((key) => {
    if (patch[key] == null) return;
    const trimmed = String(patch[key]).trim();
    // Never persist an empty Supabase URL / anon key. Storing "" would
    // override the DEFAULT_CONFIG fallback in getConfig() and break all
    // signed-in functionality. If the user clears the field, treat that
    // as "reset to default" by skipping the write — getConfig will then
    // serve DEFAULT_CONFIG.
    if ((key === "supabaseUrl" || key === "supabaseAnon") && trimmed === "") return;
    clean[key] = trimmed;
  });
  return chrome.storage.sync.set(clean);
}

async function authRequest(cfg, grantType, body) {
  const url = `${cfg.supabaseUrl}/auth/v1/token?grant_type=${encodeURIComponent(grantType)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: cfg.supabaseAnon,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Phase 6.5: surface more diagnostic info than the bare status code.
    // Supabase Auth returns different field shapes across versions:
    //   - Newer: { code: "invalid_credentials", message: "..." }
    //   - Older: { error: "invalid_grant", error_description: "..." }
    //   - Bare:  {} on some 4xx (rate limit, captcha, etc.)
    const code = json.error_code || json.code || json.error || "";
    const desc = json.error_description || json.message || json.msg || "";
    const haystack = (code + " " + desc).toLowerCase();
    let hint = "";
    // Catch the misconfig case FIRST, regardless of grant type. If the
    // anon key was somehow blanked, Supabase responds with "No API key
    // found in request" or "Invalid API key" — the user's email and
    // password are blameless, and telling them to "check email/password"
    // sends them down a dead-end debugging path. This message lands
    // them on the fix.
    if (/no api key|invalid api key|missing api key/.test(haystack)) {
      hint = " — the extension's developer connection got cleared. Open the gear icon > Developer connection and clear/blank the Supabase fields, then click Save settings (defaults will be restored).";
    } else if (grantType === "password") {
      // Password grant returns 4xx in three common situations. Detecting the
      // "no password set" case (OAuth-only accounts) is what trips most users
      // up, so we surface a clear actionable message.
      if (/invalid.*credentials|invalid.*grant|invalid.*login/.test(haystack)) {
        hint = " — wrong email or password. If you signed up with Google, click 'Continue with Google' instead.";
      } else if (/email.*not.*confirm/.test(haystack)) {
        hint = " — please confirm your email first (check your inbox for the confirmation link).";
      } else if (res.status === 400 || res.status === 401) {
        // Bare 4xx with no description — most often this is "user has no password
        // because they signed up via OAuth" or rate limiting.
        hint = " — check email/password. If you signed up with Google, use 'Continue with Google' instead.";
      }
    }
    const detail = desc || code || `HTTP ${res.status}`;
    throw new Error(detail + hint);
  }
  return json;
}

async function persistSession(cfg, data, email) {
  const expiresIn = Number(data.expires_in || 3600);
  await chrome.storage.sync.set({
    email: email || cfg.email || "",
    accessToken: String(data.access_token || ""),
    refreshToken: String(data.refresh_token || cfg.refreshToken || ""),
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000
  });
  // Phase 6: refresh the badge whenever connection state changes.
  await refreshBadge();
}

async function signIn(email, password) {
  const cfg = await getConfig();
  if (!email || !password) throw new Error("Enter your CareerBoost email and password.");
  const data = await authRequest(cfg, "password", { email, password });
  await persistSession(cfg, data, email);
  return { ok: true, email };
}

// Phase 6.5: OAuth sign-in via chrome.identity.launchWebAuthFlow.
// Solves the "Google-only users can't use the extension" problem — Phase 4
// enabled Google OAuth on the web app, but the extension was password-only.
// OAuth-only accounts have no password hash, so password sign-in returned 401.
//
// Flow:
//   1. Build the Supabase /auth/v1/authorize URL with our extension's
//      chrome-extension://*.chromiumapp.org redirect URL.
//   2. Open it in chrome.identity.launchWebAuthFlow — Chrome handles the
//      Google sign-in popup and waits for the redirect.
//   3. Supabase redirects back with #access_token=...&refresh_token=... in
//      the URL fragment. We parse it, fetch the user's email, and persist.
//
// Setup requirement (one-time per extension ID): the user must add
// `https://<extension-id>.chromiumapp.org/*` to Supabase Dashboard →
// Authentication → URL Configuration → Redirect URLs.
const ALLOWED_OAUTH_PROVIDERS = ["google", "linkedin_oidc"];

async function signInWithOAuth(provider) {
  if (!chrome.identity || typeof chrome.identity.launchWebAuthFlow !== "function") {
    throw new Error("This Chrome build doesn't support extension OAuth.");
  }
  const p = String(provider || "").toLowerCase();
  if (ALLOWED_OAUTH_PROVIDERS.indexOf(p) < 0) {
    throw new Error("Unsupported OAuth provider: " + provider);
  }
  const cfg = await getConfig();
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl = new URL(cfg.supabaseUrl + "/auth/v1/authorize");
  authUrl.searchParams.set("provider", p);
  authUrl.searchParams.set("redirect_to", redirectUrl);

  const responseUrl = await new Promise(function (resolve, reject) {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      function (url) {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "OAuth flow cancelled";
          // The "User did not approve access" / "User cancelled" case is
          // distinct from a real failure — surface it cleanly.
          if (/cancel|user.*not.*approve/i.test(msg)) {
            reject(new Error("Sign-in cancelled."));
          } else {
            reject(new Error(msg));
          }
          return;
        }
        if (!url) {
          reject(new Error("OAuth returned no redirect URL."));
          return;
        }
        resolve(url);
      },
    );
  });

  // Supabase puts tokens in the URL fragment, not the query string.
  const fragment = (responseUrl.split("#")[1] || "");
  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  const expiresIn = Number(params.get("expires_in") || 3600);
  if (!accessToken) {
    const errDesc = params.get("error_description") || params.get("error");
    if (errDesc) throw new Error(decodeURIComponent(errDesc.replace(/\+/g, " ")));
    throw new Error("Sign-in failed — Supabase returned no access token.");
  }

  // Fetch the user's email so we can show it in the options panel + status.
  let email = "";
  try {
    const userRes = await fetch(cfg.supabaseUrl + "/auth/v1/user", {
      headers: {
        Authorization: "Bearer " + accessToken,
        apikey: cfg.supabaseAnon,
      },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      email = String(user.email || "");
    }
  } catch (_e) { /* email is optional — token still works without it */ }

  await persistSession(cfg, {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  }, email);
  return { ok: true, email: email, provider: p };
}

async function signOut() {
  await chrome.storage.sync.set({
    accessToken: "",
    refreshToken: "",
    expiresAt: 0
  });
  await refreshBadge();
  return { ok: true };
}

async function clearSession() {
  await chrome.storage.sync.set({
    accessToken: "",
    refreshToken: "",
    expiresAt: 0
  });
  await refreshBadge();
}

async function ensureAccessToken() {
  let cfg = await getConfig();
  if (cfg.accessToken && Number(cfg.expiresAt || 0) > Date.now() + 30_000) {
    return cfg.accessToken;
  }
  if (!cfg.refreshToken) {
    throw new Error("CareerBoost is not connected. Open extension options and sign in.");
  }
  let data;
  try {
    data = await authRequest(cfg, "refresh_token", { refresh_token: cfg.refreshToken });
  } catch (err) {
    // Phase 6 fix: any failure of the refresh-token grant means the saved
    // session is no longer valid. The previous regex only matched specific
    // error strings ("refresh token", "jwt", etc.) and missed Supabase's
    // bare 4xx responses (which surface as 'Auth failed (401)' from
    // authRequest()). Conservative move: treat ALL refresh-grant failures
    // as "expired session, force reconnect" — there's no other realistic
    // reason this endpoint fails in normal operation.
    await clearSession();
    const msg = (err && err.message) || "";
    const detail = /^auth failed|^http \d/i.test(msg) ? "" : (": " + msg);
    throw new Error(
      "CareerBoost session expired — open extension options to sign in again." + detail,
    );
  }
  await persistSession(cfg, data, cfg.email);
  cfg = await getConfig();
  if (!cfg.accessToken) throw new Error("Could not refresh CareerBoost session.");
  return cfg.accessToken;
}

// ---------- Phase 6: vendor allowlist + telemetry pass-through ----------
const KNOWN_VENDORS = ["linkedin", "indeed", "greenhouse", "lever"];

function sanitizeVendor(raw) {
  const v = String(raw || "").toLowerCase().trim();
  return KNOWN_VENDORS.indexOf(v) >= 0 ? v : "linkedin"; // default for legacy callers
}

function sanitizeDiagnostics(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Whitelist only the fields we expect — keep the body small and prevent
  // extension-side bugs from spamming the backend with arbitrary blobs.
  const out = {};
  ["extractor", "titleLen", "descriptionLen", "hadJsonLd", "reason"].forEach((k) => {
    if (k in raw) out[k] = raw[k];
  });
  return out;
}

async function postJobImport(job, pageUrl, vendor, diagnostics) {
  const cfg = await getConfig();
  const token = await ensureAccessToken();
  const body = {
    vendor: sanitizeVendor(vendor),
    captureMethod: "extension",
    target: cfg.target || "pipeline",
    pageUrl,
    job,
    diagnostics: sanitizeDiagnostics(diagnostics)
  };
  const res = await fetch(`${cfg.functionsUrl}/job-import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: cfg.supabaseAnon,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    if (res.status === 401) {
      await clearSession();
      throw new Error("CareerBoost needs to reconnect. Open extension options and sign in again.");
    }
    throw new Error(json.error || `Import failed (${res.status})`);
  }
  return json;
}

async function getStatus() {
  const cfg = await getConfig();
  const hasFreshAccess = !!cfg.accessToken && Number(cfg.expiresAt || 0) > Date.now() + 30_000;
  return {
    ok: true,
    connected: !!cfg.refreshToken || hasFreshAccess,
    email: cfg.email || "",
    target: cfg.target || "pipeline",
    functionsUrl: cfg.functionsUrl,
    supabaseUrl: cfg.supabaseUrl
  };
}

// ---------- Phase 6: status badge ----------
//
// Subtle dot on the extension icon that reflects connection state at a
// glance. Three states:
//   - green dot  → connected, ready to capture
//   - red dot    → needs reconnect (refresh token gone)
//   - no badge   → not signed in yet (treat as neutral, avoid alarm color)
//
// Updated on session change + on each save attempt (success/failure).
async function refreshBadge() {
  try {
    const cfg = await getConfig();
    const hasFreshAccess = !!cfg.accessToken && Number(cfg.expiresAt || 0) > Date.now() + 30_000;
    const connected = !!cfg.refreshToken || hasFreshAccess;
    if (!cfg.refreshToken && !cfg.accessToken) {
      // Not signed in — clear the badge.
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "CareerBoost — sign in to enable capture" });
      return;
    }
    if (connected) {
      await chrome.action.setBadgeBackgroundColor({ color: "#22c55e" }); // green
      await chrome.action.setBadgeText({ text: "●" });
      await chrome.action.setTitle({ title: "CareerBoost — connected as " + (cfg.email || "you") });
    } else {
      await chrome.action.setBadgeBackgroundColor({ color: "#ef4855" }); // red
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({ title: "CareerBoost — reconnect needed" });
    }
  } catch (_e) {
    // chrome.action may not exist in older contexts; safe to ignore.
  }
}

async function flashBadge(success) {
  // Brief 1.5s flash to confirm the save action was processed.
  try {
    await chrome.action.setBadgeBackgroundColor({ color: success ? "#22c55e" : "#ef4855" });
    await chrome.action.setBadgeText({ text: success ? "✓" : "x" });
    setTimeout(() => { refreshBadge(); }, 1500);
  } catch (_e) { /* ignore */ }
}

// Refresh badge once on service-worker boot.
refreshBadge();

// ---------- Apply Assist intent store (Phase 2a) -------------------------
//
// The CareerBoost web app posts an apply-intent (which job, which tailored
// resume, which apply profile snapshot) via the cb-app.bridge.js content
// script. Background stashes it in chrome.storage.local under a fresh ID,
// then the Greenhouse apply content script reads it on page load and
// deletes it after use.
//
// We store under a single key "cb_apply_intents" as a small dictionary —
// chrome.storage.local has a 5MB per-extension cap which is plenty for the
// ~5-50KB resume blobs we expect.
//
// TTL is 10 minutes — long enough for a slow tab open + form load, short
// enough that stale resume data can't leak into a future application.

const APPLY_INTENT_KEY = "cb_apply_intents";
const APPLY_INTENT_TTL_MS = 10 * 60 * 1000;

function newIntentId() {
  return "ai_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

async function readIntentMap() {
  const out = await chrome.storage.local.get([APPLY_INTENT_KEY]);
  const map = out && out[APPLY_INTENT_KEY] && typeof out[APPLY_INTENT_KEY] === "object" ? out[APPLY_INTENT_KEY] : {};
  // Always sweep expired entries on read so the dictionary doesn't grow.
  const now = Date.now();
  let mutated = false;
  Object.keys(map).forEach((id) => {
    const row = map[id];
    if (!row || typeof row !== "object" || !row.expiresAt || row.expiresAt < now) {
      delete map[id];
      mutated = true;
    }
  });
  if (mutated) {
    await chrome.storage.local.set({ [APPLY_INTENT_KEY]: map });
  }
  return map;
}

async function writeIntentMap(map) {
  await chrome.storage.local.set({ [APPLY_INTENT_KEY]: map });
}

async function storeApplyIntent(payload, origin) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Apply intent payload missing.");
  }
  if (typeof payload.applyUrl !== "string" || !/^https?:\/\//.test(payload.applyUrl)) {
    throw new Error("Apply intent applyUrl must be an absolute http(s) URL.");
  }
  const map = await readIntentMap();
  const id = newIntentId();
  map[id] = {
    id,
    payload,
    origin: origin || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPLY_INTENT_TTL_MS
  };
  await writeIntentMap(map);
  return id;
}

// Used by the Greenhouse apply content script. Pass `consume: true` to
// delete the intent atomically on read (typical post-autofill cleanup).
async function lookupApplyIntent({ applyUrl, intentId, consume }) {
  const map = await readIntentMap();
  let hit = null;
  if (intentId && map[intentId]) {
    hit = map[intentId];
  } else if (applyUrl) {
    // Match by applyUrl prefix (the web app may include hash/query params
    // we don't want to compare exactly). Newest-first.
    const wanted = String(applyUrl).split("#")[0].split("?")[0];
    const candidates = Object.values(map)
      .filter((row) => row && row.payload && row.payload.applyUrl &&
        String(row.payload.applyUrl).split("#")[0].split("?")[0].indexOf(wanted) === 0)
      .sort((a, b) => b.createdAt - a.createdAt);
    hit = candidates[0] || null;
  }
  if (hit && consume) {
    delete map[hit.id];
    await writeIntentMap(map);
  }
  return hit;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = message && message.type;
    if (type === "CB_GET_STATUS") return getStatus();
    if (type === "CB_SAVE_CONFIG") {
      await saveConfig(message.config || {});
      return getStatus();
    }
    if (type === "CB_SIGN_IN") return signIn(message.email || "", message.password || "");
    if (type === "CB_SIGN_IN_OAUTH") return signInWithOAuth(message.provider || "google");
    if (type === "CB_SIGN_OUT") return signOut();
    if (type === "CB_IMPORT_JOB") {
      try {
        const data = await postJobImport(
          message.job || {},
          message.pageUrl || "",
          message.vendor,
          message.diagnostics
        );
        flashBadge(true);
        return { ok: true, data };
      } catch (err) {
        flashBadge(false);
        throw err;
      }
    }
    if (type === "CB_OPEN_OPTIONS") {
      chrome.runtime.openOptionsPage();
      return { ok: true };
    }
    // Apply Assist intent storage (Phase 2a). Bridge content script on the
    // CareerBoost web app forwards postMessage payloads here.
    if (type === "CB_APPLY_INTENT_STORE") {
      try {
        const intentId = await storeApplyIntent(message.payload, message.origin || null);
        return { ok: true, intentId };
      } catch (err) {
        return { ok: false, error: (err && err.message) || "Could not store apply intent." };
      }
    }
    // Greenhouse apply content script asks for its intent (by applyUrl).
    // consume:true wipes the entry so it can't be reused on the next load.
    if (type === "CB_APPLY_INTENT_LOOKUP") {
      try {
        const hit = await lookupApplyIntent({
          applyUrl: message.applyUrl,
          intentId: message.intentId,
          consume: message.consume === true
        });
        return { ok: true, intent: hit };
      } catch (err) {
        return { ok: false, error: (err && err.message) || "Apply intent lookup failed." };
      }
    }
    return { ok: false, error: "Unknown CareerBoost extension action." };
  })()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message || "CareerBoost extension failed." }));
  return true;
});
