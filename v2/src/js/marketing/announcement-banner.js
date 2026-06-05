// In-app announcement banner.
//
// Surfaces the latest active announcement published from the marketing engine
// (Content Studio → type "announcement", status "published") as a dismissible
// banner pinned to the top of the page. Operators control it entirely from the
// admin side; this module just renders whatever is live.
//
// Design constraints:
//   - Self-contained + defensive: any failure is swallowed, the app never breaks.
//   - Dismissal is per-announcement (localStorage), so a new announcement shows
//     again even if a prior one was dismissed.
//   - Views/clicks are tracked via content-track (keyed on the announcement
//     slug, when present) so announcements show up in the attribution scorecard
//     alongside blog + landing pages.
//   - Body supports lightweight inline markdown: **bold** and [text](https://url).
(function () {
  "use strict";

  var DISMISS_PREFIX = "cb_ann_dismissed_";
  var ANON_KEY = "cb_anon";

  function fnBase() {
    try {
      if (window.CBV2 && window.CBV2.config && window.CBV2.config.getFunctionsUrl) {
        var u = window.CBV2.config.getFunctionsUrl();
        if (u) return u.replace(/\/+$/, "");
      }
    } catch (e) { /* fall through */ }
    return "https://kddffkhwpbngiupfmcse.functions.supabase.co";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Inline markdown: **bold** and [text](https://url). Links open safely.
  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" rel="noopener" target="_blank" data-cb-ann-link="1">$1</a>');
  }

  function isDismissed(id) {
    try { return localStorage.getItem(DISMISS_PREFIX + id) === "1"; } catch (e) { return false; }
  }
  function setDismissed(id) {
    try { localStorage.setItem(DISMISS_PREFIX + id, "1"); } catch (e) { /* ignore */ }
  }

  function anonId() {
    try {
      var k = localStorage.getItem(ANON_KEY);
      if (!k) {
        k = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(36).slice(2);
        localStorage.setItem(ANON_KEY, k);
      }
      return k;
    } catch (e) { return ""; }
  }

  function track(slug, event, beacon) {
    if (!slug) return;
    try {
      var url = fnBase() + "/content-track";
      var payload = JSON.stringify({ slug: slug, event: event, anon_id: anonId(), referrer: document.referrer || "" });
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
        return;
      }
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function ensureStyles() {
    if (document.getElementById("cb-ann-style")) return;
    var css =
      "#cb-ann-banner{position:relative;z-index:60;display:flex;align-items:center;justify-content:center;gap:8px;" +
      "padding:10px 46px 10px 16px;font-size:13.5px;line-height:1.4;text-align:center;color:#eaf6ff;" +
      "background:linear-gradient(135deg,rgba(124,240,255,0.16),rgba(168,136,255,0.14));" +
      "border-bottom:1px solid rgba(124,240,255,0.28);}" +
      "#cb-ann-banner a{color:#7cf0ff;font-weight:600;text-decoration:underline;}" +
      "#cb-ann-banner .cb-ann-x{position:absolute;right:10px;top:50%;transform:translateY(-50%);" +
      "background:none;border:0;color:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.7;padding:2px 6px;}" +
      "#cb-ann-banner .cb-ann-x:hover{opacity:1;}";
    var el = document.createElement("style");
    el.id = "cb-ann-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  function render(a) {
    if (!a || !a.id || isDismissed(a.id)) return;
    if (document.getElementById("cb-ann-banner")) return; // already showing one
    ensureStyles();

    var bar = document.createElement("div");
    bar.id = "cb-ann-banner";
    bar.setAttribute("role", "status");
    var html = "<span>";
    if (a.title) html += "<strong>" + esc(a.title) + "</strong>";
    if (a.title && a.body) html += " — ";
    if (a.body) html += inline(a.body);
    html += "</span>";
    html += '<button type="button" class="cb-ann-x" aria-label="Dismiss announcement">&times;</button>';
    bar.innerHTML = html;

    document.body.insertBefore(bar, document.body.firstChild);

    bar.querySelector(".cb-ann-x").addEventListener("click", function () {
      setDismissed(a.id);
      bar.remove();
    });
    // Track clicks on any CTA link inside the banner.
    if (a.slug) {
      bar.addEventListener("click", function (e) {
        var link = e.target && e.target.closest ? e.target.closest("[data-cb-ann-link]") : null;
        if (link) track(a.slug, "click", true);
      });
      track(a.slug, "view");
    }
  }

  function load() {
    try {
      fetch(fnBase() + "/content-public?resource=announcements", { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var list = (d && d.announcements) || [];
          for (var i = 0; i < list.length; i++) {
            if (!isDismissed(list[i].id)) { render(list[i]); break; }
          }
        })
        .catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
