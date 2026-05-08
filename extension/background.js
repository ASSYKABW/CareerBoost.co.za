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
  return { ok: true };
}

async function clearSession() {
  await chrome.storage.sync.set({
    accessToken: "",
    refreshToken: "",
    expiresAt: 0
  });
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
    const msg = (err && err.message) || "";
    if (/refresh token|invalid.*token|token.*not found|jwt/i.test(msg)) {
      await clearSession();
      throw new Error("CareerBoost needs to reconnect. Open extension options and sign in again.");
    }
    throw err;
  }
  await persistSession(cfg, data, cfg.email);
  cfg = await getConfig();
  if (!cfg.accessToken) throw new Error("Could not refresh CareerBoost session.");
  return cfg.accessToken;
}

async function postJobImport(job, pageUrl) {
  const cfg = await getConfig();
  const token = await ensureAccessToken();
  const body = {
    vendor: "linkedin",
    captureMethod: "extension",
    target: cfg.target || "pipeline",
    pageUrl,
    job
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
      const data = await postJobImport(message.job || {}, message.pageUrl || "");
      return { ok: true, data };
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
