// Apply Assist — careerboost.app ↔ extension bridge (Phase 2a).
//
// Runs on the CareerBoost web app (careerboost.app + localhost + 127.0.0.1)
// at document_start so the page can postMessage *before* its own scripts
// finish loading and we never miss an intent.
//
// Flow:
//   1. Web app builds an apply-intent payload (jobId, applyUrl, tailored
//      resume blob + filename, apply profile snapshot).
//   2. Web app calls window.postMessage({ type: "CB_APPLY_INTENT", ... }, "*")
//   3. This bridge picks it up, validates the origin + shape, forwards to
//      background.js via chrome.runtime.sendMessage.
//   4. Background stores it in chrome.storage.local with a 10-min TTL,
//      keyed by intent id.
//   5. Web app opens the apply URL in a new tab.
//   6. Greenhouse content script reads the intent on load.
//
// Why postMessage instead of externally_connectable: postMessage works in
// every browser identically and doesn't require shipping the extension ID
// to the web app. The web app only needs to know the message format.

(function () {
  // Only respond to messages from the same window (web app code) — never
  // from iframes or other origins. The page wrote the payload, the page
  // gets to send it. We *still* sanity-check the source below.
  function isSameWindow(event) {
    return event && event.source === window;
  }

  function isPlainObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  // Tight shape validation. We never forward something we can't reason about.
  function isValidIntent(data) {
    if (!isPlainObject(data)) return false;
    if (typeof data.applyUrl !== "string" || data.applyUrl.length < 12) return false;
    if (data.jobId !== undefined && typeof data.jobId !== "string") return false;
    if (data.resume !== undefined && !isPlainObject(data.resume)) return false;
    if (data.profile !== undefined && !isPlainObject(data.profile)) return false;
    return true;
  }

  window.addEventListener("message", function (event) {
    if (!isSameWindow(event)) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "CB_APPLY_INTENT") return;

    const payload = msg.payload;
    if (!isValidIntent(payload)) {
      // Respond with a structured error so the web app can show a toast.
      window.postMessage({
        type: "CB_APPLY_INTENT_ACK",
        requestId: msg.requestId || null,
        ok: false,
        error: "Invalid Apply Assist payload."
      }, window.location.origin);
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: "CB_APPLY_INTENT_STORE",
        requestId: msg.requestId || null,
        payload: payload,
        origin: window.location.origin
      }, function (response) {
        const err = chrome.runtime.lastError;
        if (err || !response) {
          window.postMessage({
            type: "CB_APPLY_INTENT_ACK",
            requestId: msg.requestId || null,
            ok: false,
            error: (err && err.message) || "Extension did not respond. Is it installed and signed in?"
          }, window.location.origin);
          return;
        }
        window.postMessage({
          type: "CB_APPLY_INTENT_ACK",
          requestId: msg.requestId || null,
          ok: !!response.ok,
          intentId: response.intentId || null,
          error: response.error || null
        }, window.location.origin);
      });
    } catch (e) {
      window.postMessage({
        type: "CB_APPLY_INTENT_ACK",
        requestId: msg.requestId || null,
        ok: false,
        error: "Bridge threw: " + ((e && e.message) || String(e))
      }, window.location.origin);
    }
  });

  // Heartbeat: web app can detect "extension installed" by posting
  // { type: "CB_APPLY_PING" } and watching for the synchronous reply.
  window.addEventListener("message", function (event) {
    if (!isSameWindow(event)) return;
    if (!event.data || event.data.type !== "CB_APPLY_PING") return;
    window.postMessage({
      type: "CB_APPLY_PONG",
      requestId: event.data.requestId || null,
      version: "0.3.0"
    }, window.location.origin);
  });
})();
