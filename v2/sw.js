/**
 * sw.js — minimal service worker for CareerBoost.
 *
 * WHY THIS EXISTS:
 *   Chrome only fires the `beforeinstallprompt` event (and shows the
 *   address-bar install icon) when a site registers a service worker that
 *   has a `fetch` handler. The Web Share Target feature only works for
 *   INSTALLED PWAs, and our install nudge (src/js/components/install-banner.js)
 *   listens for `beforeinstallprompt`. Without a service worker, that event
 *   never fires, so the nudge never shows and Android users can only install
 *   by manually digging through the browser menu.
 *
 * WHAT THIS IS NOT:
 *   This is deliberately NOT an offline/caching service worker. It is a pure
 *   network passthrough — every request goes to the network exactly as it
 *   would without a service worker. Adding real offline support is a separate,
 *   deliberate change (see project memory: "Service Worker for actual offline
 *   support" is tracked as future work).
 *
 * Served at /sw.js (root scope "/") so it controls the whole app.
 */

// Bump this string whenever the SW logic changes, so the browser detects an
// update and re-installs. (Not used for caching today — purely a change marker.)
const SW_VERSION = "cb-sw-v2";

self.addEventListener("install", () => {
  // Activate this worker as soon as it finishes installing, instead of waiting
  // for all tabs using the old worker to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of any already-open pages immediately on first activation.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Intentional no-op passthrough. We do NOT call event.respondWith(), so the
  // browser handles every request over the network exactly as normal. The sole
  // purpose of this listener is to satisfy Chrome's install-promotion heuristic
  // (it requires the presence of a fetch handler). No caching, no offline
  // behavior, no interception. Do not add respondWith() here without a
  // deliberate caching strategy — naive passthrough can break range/streaming
  // requests.
  return;
});

// ── Web Push ────────────────────────────────────────────────────────────────
// The sender (push-send) delivers an encrypted JSON payload:
//   { title, body, url?, tag?, icon? }
// We display it as a notification; clicking focuses an existing tab (navigating
// it to url) or opens a new one.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) { data = {}; }
  const title = data.title || "CareerBoost";
  const options = {
    body: data.body || "",
    icon: data.icon || "/favicon-192.png",
    badge: "/favicon-48.png",
    tag: data.tag || undefined,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  const absolute = new URL(target, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing CareerBoost tab and navigate it, if one is open.
      for (const client of clients) {
        if (client.url.indexOf(self.location.origin) === 0 && "focus" in client) {
          client.navigate(absolute).catch(() => {});
          return client.focus();
        }
      }
      // Otherwise open a fresh window.
      if (self.clients.openWindow) return self.clients.openWindow(absolute);
    }),
  );
});
