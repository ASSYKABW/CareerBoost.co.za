// PWA Web Push — client subscription manager (window.CBPush).
//
// Handles the browser side of push: feature detection, permission, subscribing
// via the configured VAPID public key, and syncing the subscription to the
// backend (push-subscribe). Dormant until window.CB_CONFIG.vapidPublicKey is
// set — until then isConfigured() is false and the Settings card stays hidden.
//
// subscribe() MUST be called from a user gesture (a button click) — browsers
// reject permission prompts that aren't user-initiated.
(function () {
  window.CBV2 = window.CBV2 || {};

  function vapidKey() {
    return (window.CB_CONFIG && window.CB_CONFIG.vapidPublicKey || "").trim();
  }

  function isSupported() {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  function isConfigured() {
    return isSupported() && !!vapidKey();
  }

  function permissionState() {
    try { return Notification.permission; } catch (e) { return "default"; }
  }

  function urlB64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function callBackend(action, payload) {
    var auth = window.CBV2.auth;
    var config = window.CBV2.config;
    if (!auth || !auth.isAuthenticated || !auth.isAuthenticated()) throw new Error("Please sign in first.");
    var body = Object.assign({ action: action }, payload || {});
    var client = auth.getClient && auth.getClient();
    if (client && client.functions && typeof client.functions.invoke === "function") {
      var invoked = await client.functions.invoke("push-subscribe", { body: body });
      if (invoked.error) throw new Error(invoked.error.message || "Request failed");
      return invoked.data;
    }
    if (!config || !config.getFunctionsUrl) throw new Error("Backend not configured.");
    var token = await auth.getAccessToken();
    var resp = await fetch(config.getFunctionsUrl() + "/push-subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: config.getSupabaseAnon ? config.getSupabaseAnon() : "",
      },
      body: JSON.stringify(body),
    });
    var data = await resp.json();
    if (!resp.ok || !data || data.ok === false) throw new Error((data && data.error) || "Request failed");
    return data;
  }

  async function getRegistration() {
    if (!("serviceWorker" in navigator)) throw new Error("Service worker unavailable.");
    return await navigator.serviceWorker.ready;
  }

  async function currentSubscription() {
    try {
      var reg = await getRegistration();
      return await reg.pushManager.getSubscription();
    } catch (e) { return null; }
  }

  async function subscribe() {
    if (!isSupported()) throw new Error("Push isn't supported in this browser.");
    if (!vapidKey()) throw new Error("Push isn't configured yet.");

    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications were not allowed.");

    var reg = await getRegistration();
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(vapidKey()),
      });
    }
    await callBackend("subscribe", { subscription: sub.toJSON() });
    return true;
  }

  async function unsubscribe() {
    var sub = await currentSubscription();
    if (sub) {
      try { await callBackend("unsubscribe", { endpoint: sub.endpoint }); } catch (e) { /* best effort */ }
      try { await sub.unsubscribe(); } catch (e) { /* best effort */ }
    }
    return true;
  }

  async function status() {
    var sub = isSupported() ? await currentSubscription() : null;
    return {
      supported: isSupported(),
      configured: isConfigured(),
      permission: permissionState(),
      subscribed: !!sub,
    };
  }

  window.CBPush = {
    isSupported: isSupported,
    isConfigured: isConfigured,
    permissionState: permissionState,
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    status: status,
  };
})();
