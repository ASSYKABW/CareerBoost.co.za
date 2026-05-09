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
    const supabaseUrl = String(cfg.supabaseUrl || DEFAULT_CONFIG.supabaseUrl).replace(/\/+$/, "");
    return Object.assign({}, cfg, {
      supabaseUrl,
      functionsUrl: String(cfg.functionsUrl || deriveFunctionsUrl(supabaseUrl)).replace(/\/+$/, ""),
      target: cfg.target || "pipeline"
    });
  });
}

function saveConfig(patch) {
  const clean = {};
  ["supabaseUrl", "supabaseAnon", "functionsUrl", "target"].forEach((key) => {
    if (patch[key] != null) clean[key] = String(patch[key]).trim();
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
    throw new Error(json.error_description || json.msg || json.error || `Auth failed (${res.status})`);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = message && message.type;
    if (type === "CB_GET_STATUS") return getStatus();
    if (type === "CB_SAVE_CONFIG") {
      await saveConfig(message.config || {});
      return getStatus();
    }
    if (type === "CB_SIGN_IN") return signIn(message.email || "", message.password || "");
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
    return { ok: false, error: "Unknown CareerBoost extension action." };
  })()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message || "CareerBoost extension failed." }));
  return true;
});
