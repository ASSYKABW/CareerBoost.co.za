// In-app AI guidance panel.
//
// Floating bottom-right button that opens a chat drawer where users
// can ask anything about the app and the AI walks them to the right
// feature. Session-only history. 20 free messages/month tracked in
// localStorage (advisory; backend rate-limit is authoritative).
//
// Gated by CB_CONFIG.featureFlags.aiChatPanel — leave false to ship
// the code without exposure.

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.aiChatPanel && window.CBV2.aiChatPanel._installed) return;

  // Routes where the FAB stays hidden.
  const HIDDEN_ROUTES = [
    "#/auth",
    "#/auth/confirmed",
    "#/welcome",
    "#/onboarding"
  ];

  const QUOTA_KEY_PREFIX = "cb_chat_assist_count_";
  const FREE_MONTHLY_LIMIT = 20;
  const RATE_LIMIT_MS = 3000;

  const state = {
    open: false,
    sending: false,
    error: "",
    turns: [],        // [{ role: "user"|"assistant", text, ts }]
    lastSentAt: 0
  };

  // ---------- helpers ------------------------------------------------------

  function sanitize(s) {
    if (window.CBV2 && typeof window.CBV2.sanitizeText === "function") {
      return window.CBV2.sanitizeText(s);
    }
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Lightweight markdown: paragraphs + **bold** + *italic* + [link](#/route) + `code`.
  // Inline-only — no headers, no lists. Anchors are restricted to safe hrefs.
  function renderMarkdown(md) {
    const escaped = sanitize(String(md || ""));
    const parts = escaped.split(/\n{2,}/);
    return parts.map(function (para) {
      let p = para.replace(/\n/g, "<br>");
      // [text](url) — only allow hash routes, https, and mailto.
      p = p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_m, text, url) {
        const cleanUrl = String(url).trim();
        const safe = /^#\/[\w\-/?=&%.+]*$/.test(cleanUrl)
          || /^https?:\/\//.test(cleanUrl)
          || /^mailto:/.test(cleanUrl);
        if (!safe) return text;
        const ext = /^https?:/.test(cleanUrl) ? ' target="_blank" rel="noopener"' : "";
        return '<a href="' + cleanUrl + '"' + ext + '>' + text + "</a>";
      });
      p = p.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      p = p.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
      p = p.replace(/`([^`]+)`/g, "<code>$1</code>");
      return "<p>" + p + "</p>";
    }).join("");
  }

  function currentMonthKey() {
    const d = new Date();
    return QUOTA_KEY_PREFIX + d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  }

  function getQuotaUsed() {
    try {
      const v = localStorage.getItem(currentMonthKey());
      const n = v ? parseInt(v, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (e) { return 0; }
  }

  function incrementQuota() {
    try {
      const k = currentMonthKey();
      const next = getQuotaUsed() + 1;
      localStorage.setItem(k, String(next));
      // Prune old months (keep only current).
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.indexOf(QUOTA_KEY_PREFIX) === 0 && key !== k) {
          localStorage.removeItem(key);
        }
      }
    } catch (e) { /* ignore */ }
  }

  function quotaRemaining() {
    return Math.max(0, FREE_MONTHLY_LIMIT - getQuotaUsed());
  }

  function isFeatureEnabled() {
    const cfg = window.CB_CONFIG || {};
    const ff = cfg.featureFlags || {};
    return ff.aiChatPanel === true;
  }

  function isAuthenticated() {
    const auth = window.CBV2 && window.CBV2.auth;
    return Boolean(auth && typeof auth.isAuthenticated === "function" && auth.isAuthenticated());
  }

  function currentRouteHash() {
    try {
      const h = (window.location && window.location.hash) || "";
      return h ? h : "#/dashboard";
    } catch (e) { return ""; }
  }

  function shouldHideForRoute() {
    const h = currentRouteHash();
    return HIDDEN_ROUTES.some(function (prefix) {
      return h.indexOf(prefix) === 0;
    });
  }

  // ---------- rendering ---------------------------------------------------

  function renderFab() {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.id = "cb-ai-chat-fab";
    fab.className = "cb-ai-chat-fab";
    fab.setAttribute("aria-label", "Open CareerBoost AI guide");
    fab.setAttribute("title", "Ask CareerBoost AI");
    fab.innerHTML = '<i class="fa-solid fa-comments" aria-hidden="true"></i>';
    fab.addEventListener("click", function () { setOpen(true); });
    return fab;
  }

  function renderPanel() {
    const panel = document.createElement("aside");
    panel.id = "cb-ai-chat-panel";
    panel.className = "cb-ai-chat-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "CareerBoost AI guide");
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = (
      '<header class="cb-ai-chat-head">' +
        '<div class="cb-ai-chat-title">' +
          '<span class="cb-ai-chat-dot" aria-hidden="true"></span>' +
          '<div><strong>CareerBoost AI</strong><small>Guidance for the app</small></div>' +
        '</div>' +
        '<button type="button" class="cb-ai-chat-close" aria-label="Close">' +
          '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' +
        '</button>' +
      '</header>' +
      '<div class="cb-ai-chat-log" id="cb-ai-chat-log" tabindex="0" aria-live="polite"></div>' +
      '<form class="cb-ai-chat-form" id="cb-ai-chat-form" autocomplete="off">' +
        '<div class="cb-ai-chat-error" id="cb-ai-chat-error" hidden></div>' +
        '<div class="cb-ai-chat-quota" id="cb-ai-chat-quota"></div>' +
        '<div class="cb-ai-chat-inputrow">' +
          '<textarea id="cb-ai-chat-input" rows="1" maxlength="800" placeholder="Ask anything about CareerBoost…" aria-label="Type your question"></textarea>' +
          '<button type="submit" class="cb-ai-chat-send" id="cb-ai-chat-send" aria-label="Send">' +
            '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i>' +
          '</button>' +
        '</div>' +
      '</form>'
    );

    panel.querySelector(".cb-ai-chat-close").addEventListener("click", function () { setOpen(false); });
    panel.querySelector("#cb-ai-chat-form").addEventListener("submit", onSubmit);

    const input = panel.querySelector("#cb-ai-chat-input");
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 140) + "px";
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit(e);
      }
    });
    return panel;
  }

  function renderBackdrop() {
    const bd = document.createElement("div");
    bd.id = "cb-ai-chat-backdrop";
    bd.className = "cb-ai-chat-backdrop";
    bd.setAttribute("aria-hidden", "true");
    bd.addEventListener("click", function () { setOpen(false); });
    return bd;
  }

  function renderEmptyState() {
    const knowledge = window.CBV2.aiChatKnowledge;
    const starters = [
      { q: "How do I tailor my resume?", route: "#/resume" },
      { q: "What's the Pipeline?", route: "#/applications" },
      { q: "How do I install the Chrome extension?", route: "#/settings?tab=extension" },
      { q: "What does my plan include?", route: "#/settings?tab=billing" }
    ];
    const chips = starters.map(function (s) {
      return '<button type="button" class="cb-ai-chat-chip" data-starter="' + sanitize(s.q) + '">' + sanitize(s.q) + '</button>';
    }).join("");
    const greeting = knowledge
      ? "Hi! I can explain CareerBoost features, recommend what to use next, and point you to the right page."
      : "Ask me anything about CareerBoost.";
    return (
      '<div class="cb-ai-chat-empty">' +
        '<div class="cb-ai-chat-empty-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>' +
        '<p>' + sanitize(greeting) + '</p>' +
        '<div class="cb-ai-chat-chips">' + chips + '</div>' +
      '</div>'
    );
  }

  function renderTurn(turn) {
    const isUser = turn.role === "user";
    const body = isUser
      ? '<p>' + sanitize(turn.text).replace(/\n/g, "<br>") + '</p>'
      : renderMarkdown(turn.text);
    return (
      '<div class="cb-ai-chat-msg cb-ai-chat-msg--' + (isUser ? "user" : "ai") + '">' +
        (isUser ? "" : '<div class="cb-ai-chat-avatar" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i></div>') +
        '<div class="cb-ai-chat-bubble">' + body + '</div>' +
      '</div>'
    );
  }

  function renderTyping() {
    return (
      '<div class="cb-ai-chat-msg cb-ai-chat-msg--ai">' +
        '<div class="cb-ai-chat-avatar" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i></div>' +
        '<div class="cb-ai-chat-bubble cb-ai-chat-typing"><span></span><span></span><span></span></div>' +
      '</div>'
    );
  }

  function renderLog() {
    const log = document.getElementById("cb-ai-chat-log");
    if (!log) return;
    if (state.turns.length === 0) {
      log.innerHTML = renderEmptyState();
      log.querySelectorAll(".cb-ai-chat-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          const q = chip.getAttribute("data-starter") || "";
          sendQuestion(q);
        });
      });
      return;
    }
    let html = "";
    state.turns.forEach(function (t) { html += renderTurn(t); });
    if (state.sending) html += renderTyping();
    log.innerHTML = html;
    requestAnimationFrame(function () {
      log.scrollTop = log.scrollHeight;
    });
  }

  function renderQuotaLine() {
    const el = document.getElementById("cb-ai-chat-quota");
    if (!el) return;
    const remaining = quotaRemaining();
    if (remaining > 0) {
      el.innerHTML = '<small>' + remaining + " of " + FREE_MONTHLY_LIMIT + " messages left this month</small>";
      el.classList.remove("cb-ai-chat-quota--exhausted");
    } else {
      el.innerHTML = (
        '<small>You\'ve used all ' + FREE_MONTHLY_LIMIT + ' free messages this month. ' +
        '<a href="#/settings?tab=billing">Upgrade</a> for more.</small>'
      );
      el.classList.add("cb-ai-chat-quota--exhausted");
    }
  }

  function renderError() {
    const el = document.getElementById("cb-ai-chat-error");
    if (!el) return;
    if (state.error) {
      el.hidden = false;
      el.textContent = state.error;
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }

  function renderAll() {
    renderLog();
    renderQuotaLine();
    renderError();
    const send = document.getElementById("cb-ai-chat-send");
    if (send) send.disabled = state.sending || quotaRemaining() <= 0;
    const input = document.getElementById("cb-ai-chat-input");
    if (input) input.disabled = state.sending;
  }

  // ---------- state transitions -------------------------------------------

  function setOpen(open) {
    state.open = !!open;
    const panel = document.getElementById("cb-ai-chat-panel");
    const fab = document.getElementById("cb-ai-chat-fab");
    const bd = document.getElementById("cb-ai-chat-backdrop");
    if (!panel || !fab || !bd) return;
    if (state.open) {
      panel.classList.add("is-open");
      bd.classList.add("is-open");
      panel.setAttribute("aria-hidden", "false");
      bd.setAttribute("aria-hidden", "false");
      renderAll();
      // Focus input shortly after the open animation kicks in.
      setTimeout(function () {
        const input = document.getElementById("cb-ai-chat-input");
        if (input) input.focus();
      }, 150);
    } else {
      panel.classList.remove("is-open");
      bd.classList.remove("is-open");
      panel.setAttribute("aria-hidden", "true");
      bd.setAttribute("aria-hidden", "true");
    }
  }

  function onSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    const input = document.getElementById("cb-ai-chat-input");
    if (!input) return;
    const text = String(input.value || "").trim();
    if (!text) return;
    sendQuestion(text);
    input.value = "";
    input.style.height = "auto";
  }

  async function sendQuestion(question) {
    if (state.sending) return;
    if (!question || !question.trim()) return;

    // Rate limit: 1 message every 3s.
    const now = Date.now();
    if (now - state.lastSentAt < RATE_LIMIT_MS) {
      state.error = "Please wait a moment before sending another message.";
      renderError();
      return;
    }

    if (quotaRemaining() <= 0) {
      state.error = "You've used your free chat allowance for this month.";
      renderError();
      return;
    }

    if (!isAuthenticated()) {
      state.error = "Sign in to use the AI guide.";
      renderError();
      return;
    }

    state.error = "";
    state.lastSentAt = now;
    state.turns.push({ role: "user", text: question, ts: now });
    state.sending = true;
    renderAll();

    try {
      const knowledge = window.CBV2.aiChatKnowledge;
      if (!knowledge) throw new Error("Chat knowledge module not loaded.");

      const route = currentRouteHash();
      const composedPrompt = (
        knowledge.buildSystemPrompt() +
        "\n\n" +
        knowledge.buildUserMessage(question, {
          history: state.turns.slice(0, -1).map(function (t) {
            return { role: t.role, text: t.text };
          }),
          currentRoute: route
        })
      );

      const runSkill = window.CBAI && window.CBAI.runSkill;
      if (typeof runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }

      const envelope = await runSkill("chat-assist", {
        prompt: composedPrompt,
        question: question,
        currentRoute: route,
        history: state.turns.slice(0, -1).map(function (t) {
          return { role: t.role, text: t.text };
        })
      });

      const reply = envelope && envelope.data && envelope.data.reply
        ? String(envelope.data.reply)
        : "Sorry, I didn't catch that — could you rephrase?";

      state.turns.push({ role: "assistant", text: reply, ts: Date.now() });
      incrementQuota();

      // Client-telemetry breadcrumb (fire-and-forget).
      try {
        if (window.CBV2 && window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
          window.CBV2.usage.track("chat_assist_turn", {
            route: route,
            promptLen: question.length,
            replyLen: reply.length,
            latencyMs: envelope && envelope.latencyMs ? envelope.latencyMs : null,
            provider: envelope && envelope.provider ? envelope.provider : null,
            model: envelope && envelope.model ? envelope.model : null
          }, { module: "guide", category: "ai" });
        }
      } catch (err) { /* telemetry must not break chat */ }
    } catch (err) {
      const msg = (err && err.message) || "AI couldn't respond. Try again.";
      state.error = msg;
      try {
        if (window.CBV2 && window.CBV2.usage && typeof window.CBV2.usage.track === "function") {
          window.CBV2.usage.track("chat_assist_failed", {
            error: String(msg).slice(0, 200)
          }, { module: "guide", category: "ai" });
        }
      } catch (e) { /* ignore */ }
    } finally {
      state.sending = false;
      renderAll();
    }
  }

  function updateVisibility() {
    const fab = document.getElementById("cb-ai-chat-fab");
    if (!fab) return;
    const visible = isFeatureEnabled() && isAuthenticated() && !shouldHideForRoute();
    fab.style.display = visible ? "" : "none";
    if (!visible && state.open) setOpen(false);
  }

  function install() {
    if (document.getElementById("cb-ai-chat-fab")) return;
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", install, { once: true });
      return;
    }
    const fab = renderFab();
    const panel = renderPanel();
    const backdrop = renderBackdrop();
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    updateVisibility();

    // Re-check visibility on route + auth changes.
    window.addEventListener("hashchange", updateVisibility);
    const auth = window.CBV2 && window.CBV2.auth;
    if (auth && typeof auth.onChange === "function") {
      auth.onChange(updateVisibility);
    } else {
      // Poll briefly until auth module attaches.
      let tries = 0;
      const t = setInterval(function () {
        const a = window.CBV2 && window.CBV2.auth;
        tries += 1;
        if (a && typeof a.onChange === "function") {
          a.onChange(updateVisibility);
          updateVisibility();
          clearInterval(t);
        } else if (tries > 50) {
          clearInterval(t);
        }
      }, 200);
    }
    // ESC closes the panel.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.open) setOpen(false);
    });
  }

  install();

  window.CBV2.aiChatPanel = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    _installed: true
  };
})();
