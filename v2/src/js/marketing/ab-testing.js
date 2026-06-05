// Lightweight client-side A/B testing for the marketing engine.
//
// Fetches running experiments (content-public?resource=experiments-active),
// sticky-assigns each visitor a variant by weight (localStorage), and:
//   • no-code copy test: if the experiment has a `target` CSS selector and the
//     chosen variant has `text`, swaps that element's textContent.
//   • declarative slots: elements <... data-ab="<key>"> with children
//     <... data-ab-variant="<id>"> — only the chosen variant's child is shown.
// Exposure is tracked once per session as content_events 'view'; conversions
// fire on clicks of [data-ab-convert="<key>"] (or via window.CBAB.convert).
// Slug scheme: exp:<key>:<variantId>. Fully defensive — failures degrade to
// the page as authored (no hiding on fetch failure).
//
// Public API: window.CBAB.assign(key) → variantId | null; CBAB.convert(key);
//             CBAB.assignments (map of key → variantId).
(function () {
  "use strict";

  var ASSIGN_PREFIX = "cb_ab_";
  var EXPOSED_PREFIX = "cb_abx_";
  var ANON_KEY = "cb_anon";

  var experiments = {};   // key → { key, target, variants:[{id,label,weight,text}] }
  var assignments = {};   // key → variantId

  function fnBase() {
    try {
      if (window.CBV2 && window.CBV2.config && window.CBV2.config.getFunctionsUrl) {
        var u = window.CBV2.config.getFunctionsUrl();
        if (u) return u.replace(/\/+$/, "");
      }
    } catch (e) { /* fall through */ }
    return "https://kddffkhwpbngiupfmcse.functions.supabase.co";
  }

  function anonId() {
    try {
      var k = localStorage.getItem(ANON_KEY);
      if (!k) {
        k = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
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
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([payload], { type: "application/json" })); return; }
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function readLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // Weighted random pick over [{id, weight}].
  function pickVariant(variants) {
    var total = 0, i;
    for (i = 0; i < variants.length; i++) total += Math.max(0, Number(variants[i].weight) || 0);
    if (total <= 0) return variants[0] || null;
    var r = Math.random() * total;
    for (i = 0; i < variants.length; i++) {
      r -= Math.max(0, Number(variants[i].weight) || 0);
      if (r < 0) return variants[i];
    }
    return variants[variants.length - 1] || null;
  }

  function variantById(exp, id) {
    for (var i = 0; i < exp.variants.length; i++) if (exp.variants[i].id === id) return exp.variants[i];
    return null;
  }

  // Get-or-assign sticky variant for an experiment.
  function assign(key) {
    if (assignments[key]) return assignments[key];
    var exp = experiments[key];
    if (!exp || !exp.variants || !exp.variants.length) return null;
    var stored = readLocal(ASSIGN_PREFIX + key);
    if (stored && variantById(exp, stored)) { assignments[key] = stored; return stored; }
    var chosen = pickVariant(exp.variants);
    if (!chosen) return null;
    writeLocal(ASSIGN_PREFIX + key, chosen.id);
    assignments[key] = chosen.id;
    return chosen.id;
  }

  function markExposed(key) {
    var k = EXPOSED_PREFIX + key;
    try {
      if (sessionStorage.getItem(k)) return false;
      sessionStorage.setItem(k, "1");
      return true;
    } catch (e) { return true; }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, "\\$&");
  }

  function applyExperiment(exp) {
    var vid = assign(exp.key);
    if (!vid) return;
    var vdef = variantById(exp, vid);

    // No-code copy swap.
    if (exp.target && vdef && vdef.text) {
      try {
        var el = document.querySelector(exp.target);
        if (el) el.textContent = vdef.text;
      } catch (e) { /* bad selector — ignore */ }
    }

    // Declarative variant slots: show chosen, hide the rest.
    try {
      var groups = document.querySelectorAll('[data-ab="' + cssEscape(exp.key) + '"]');
      for (var g = 0; g < groups.length; g++) {
        var slots = groups[g].querySelectorAll("[data-ab-variant]");
        for (var s = 0; s < slots.length; s++) {
          slots[s].style.display = (slots[s].getAttribute("data-ab-variant") === vid) ? "" : "none";
        }
      }
    } catch (e) { /* ignore */ }

    // Exposure — once per session.
    if (markExposed(exp.key)) track("exp:" + exp.key + ":" + vid, "view");
  }

  function convert(key) {
    var vid = assign(key);
    if (vid) track("exp:" + key + ":" + vid, "click", true);
  }

  function applyAll() {
    Object.keys(experiments).forEach(function (key) { applyExperiment(experiments[key]); });
  }

  function load() {
    try {
      fetch(fnBase() + "/content-public?resource=experiments-active", { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var list = (d && d.experiments) || [];
          list.forEach(function (e) {
            if (e && e.key && Array.isArray(e.variants) && e.variants.length) experiments[e.key] = e;
          });
          applyAll();
        })
        .catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  // Delegated conversion clicks.
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-ab-convert]") : null;
    if (t) convert(t.getAttribute("data-ab-convert"));
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();

  window.CBAB = { assign: assign, convert: convert, assignments: assignments, _experiments: experiments };
})();
