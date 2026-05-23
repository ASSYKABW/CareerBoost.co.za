(function () {
  window.CBV2 = window.CBV2 || {};

  const navConfig = [
    {
      group: "Track",
      items: [
        { id: "dashboard", icon: "fa-house", label: "Dashboard" },
        { id: "applications", icon: "fa-list-check", label: "Pipeline" },
        { id: "calendar", icon: "fa-calendar-days", label: "Calendar" }
      ]
    },
    {
      group: "Create",
      items: [
        { id: "resume", icon: "fa-file-lines", label: "Resume Lab" },
        { id: "cover-letter", icon: "fa-envelope-open-text", label: "Cover Letters" }
      ]
    },
    {
      group: "Discover",
      items: [
        { id: "job-search", icon: "fa-magnifying-glass", label: "Job Search" }
      ]
    },
    {
      group: "Prepare",
      items: [{ id: "interview", icon: "fa-comments", label: "Interview Prep" }]
    },
    {
      group: "Intelligence",
      items: [{ id: "analytics", icon: "fa-chart-line", label: "Analytics" }]
    },
    {
      group: "System",
      items: [{ id: "settings", icon: "fa-gear", label: "Settings" }]
    }
  ];

  function renderGroup(group, activeRoute) {
    const links = group.items
      .map(function (item) {
        const activeClass = item.id === activeRoute ? "is-active" : "";
        return `
          <a class="nav-link ${activeClass}" href="#/${item.id}" data-route="${item.id}">
            <i class="fa-solid ${item.icon}" aria-hidden="true"></i>
            <span>${item.label}</span>
          </a>
        `;
      })
      .join("");

    return `
      <section class="nav-group">
        <p class="nav-group-title">${group.group}</p>
        ${links}
      </section>
    `;
  }

  // Produce initials for the fallback avatar badge. We prefer the profile's
  // full_name ("Jonathan Doe" → "JD") and fall back to the email's local-part
  // first letter.
  function computeInitials(profile, email) {
    const name = (profile && profile.full_name) ? String(profile.full_name).trim() : "";
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      }
      if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
      }
    }
    const e = String(email || "").trim();
    if (!e) return "?";
    return e.charAt(0).toUpperCase();
  }

  function renderAvatarBadge(profile, email, options) {
    const opts = options || {};
    const size = opts.size || "md"; // "sm" | "md" | "lg"
    const avatarUrl = profile && profile.avatar_url ? profile.avatar_url : "";
    const initials = computeInitials(profile, email);
    const st = window.CBV2.sanitizeText || function (x) { return String(x || ""); };
    if (avatarUrl) {
      return (
        '<span class="avatar avatar--img avatar--' + size + '" aria-hidden="true">' +
          '<img src="' + st(avatarUrl) + '" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.classList.remove(\'avatar--img\');this.parentNode.textContent=\'' + st(initials) + '\'" />' +
        '</span>'
      );
    }
    return '<span class="avatar avatar--' + size + '" aria-hidden="true">' + st(initials) + '</span>';
  }

  function renderUserChip() {
    const auth = window.CBV2.auth;
    const backendOn = window.CBV2.config && window.CBV2.config.isBackendEnabled();
    if (!backendOn) {
      return '<span class="chip warning" title="Data is local-only until the backend is configured">Local mode</span>';
    }
    if (!auth || !auth.isAuthenticated()) {
      return '<a class="btn-ghost" href="#/auth"><i class="fa-solid fa-right-to-bracket"></i> Sign in</a>';
    }
    const user = auth.getUser() || {};
    const profile = (window.CBV2.profile && window.CBV2.profile.get()) || null;
    const email = user.email || "Signed in";
    const displayName = (profile && profile.full_name) ? profile.full_name : email.split("@")[0];
    // Plan label: prefer entitlements (authoritative — set by the
    // webhook on successful charge) over profile.plan (legacy field
    // that often goes stale because nothing syncs it after upgrade).
    // Falls back to profile.plan or "Free" if entitlements hasn't loaded.
    const ent = window.CBV2 && window.CBV2.entitlements;
    const entData = ent && typeof ent.get === "function" ? ent.get() : null;
    const planFromEnt = entData && entData.plan_label;
    const planFromProfile = profile && profile.plan
      ? profile.plan.charAt(0).toUpperCase() + profile.plan.slice(1)
      : "";
    const planLabel = planFromEnt || planFromProfile || "Free";
    // If the sub is cancelled but the user still has access until the
    // period end, append a small marker so the chip doesn't look like
    // an indefinitely-active paid plan.
    const planCancelled = !!(entData && (entData.cancel_at_period_end || entData.status === "canceled")) && (entData.plan_id && entData.plan_id !== "free");
    const planChipText = planCancelled ? planLabel + " plan · cancelled" : planLabel + " plan";
    const st = window.CBV2.sanitizeText || function (x) { return String(x || ""); };
    const canAdmin = window.CBV2.adminAccess && typeof window.CBV2.adminAccess.canAccess === "function"
      ? window.CBV2.adminAccess.canAccess()
      : false;
    const adminLink = canAdmin
      ? '<a class="user-menu-item" role="menuitem" href="#/admin"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Admin console</a>'
      : "";

    return `
      <div class="user-chip" data-user-chip>
        <button class="user-chip-btn user-chip-btn--avatar-only" type="button"
                data-user-toggle aria-haspopup="menu" aria-expanded="false"
                aria-label="Account menu for ${st(email)}">
          ${renderAvatarBadge(profile, email, { size: "md" })}
        </button>
        <div class="user-menu user-menu--rich" data-user-menu role="menu" hidden>
          <div class="user-menu-header">
            ${renderAvatarBadge(profile, email, { size: "lg" })}
            <div class="user-menu-identity">
              <strong class="user-menu-name">${st(displayName)}</strong>
              <span class="user-menu-email">${st(email)}</span>
              <span class="chip chip-sm ${planCancelled ? "amber" : "violet"} user-menu-plan">${st(planChipText)}</span>
            </div>
          </div>
          ${renderUserMenuQuotas()}
          <div class="user-menu-divider" role="separator"></div>
          <a class="user-menu-item" role="menuitem" href="#/settings?tab=profile">
            <i class="fa-solid fa-user" aria-hidden="true"></i> Profile &amp; avatar
          </a>
          <a class="user-menu-item" role="menuitem" href="#/settings">
            <i class="fa-solid fa-gear" aria-hidden="true"></i> Settings
          </a>
          ${adminLink}
          <div class="user-menu-divider" role="separator"></div>
          <button class="user-menu-item user-menu-item--danger" type="button" role="menuitem" data-signout>
            <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i> Sign out
          </button>
        </div>
      </div>
    `;
  }

  // Day 4.5 — Always-visible quota meter inside the user menu.
  //
  // Reads from the same entitlements cache the upgrade modal uses.
  // Shows every metered quota that has a finite monthly cap; skips
  // unlimited ones to avoid noise. Auto-updates because entitlements
  // .onChange triggers refreshUserChip below.
  //
  // If every quota is unlimited (Career plan), the entire section is
  // omitted — no value in showing 6 empty bars.
  //
  // If entitlements haven't loaded yet (cold start), shows a placeholder
  // so the menu doesn't jump in height when they arrive.
  function renderUserMenuQuotas() {
    const ent = window.CBV2 && window.CBV2.entitlements;
    if (!ent || typeof ent.get !== "function") return "";
    const data = ent.get();
    if (!data) {
      // Best-effort: kick a load so the placeholder gets replaced as
      // soon as entitlements arrives. Fire-and-forget — the
      // entitlements.onChange subscription wired above repaints the
      // chip when load() resolves.
      if (typeof ent.load === "function") {
        try { ent.load(false).catch(function () {}); } catch (_e) {}
      }
      // Placeholder so the menu height is predictable on cold open.
      return (
        '<div class="user-menu-quotas">' +
          '<div class="user-menu-quotas-head"><span>This month\'s usage</span><span class="user-menu-quotas-link"><a href="#/settings?tab=account">Manage</a></span></div>' +
          '<p class="user-menu-quotas-empty">Loading usage…</p>' +
        '</div>'
      );
    }
    const monthly = (data.limits && data.limits.monthly) || {};
    const usage = data.usage || {};
    // Display order — most common features first.
    const QUOTAS = [
      { key: "ai_resumes",        label: "Resume tailors" },
      { key: "ai_covers",         label: "Cover letters" },
      { key: "ai_bullets",        label: "Bullet rewrites" },
      { key: "ai_mocks",          label: "Mock interviews" },
      { key: "ai_research",       label: "Company research" },
      { key: "ai_question_banks", label: "Question banks" },
    ];
    const visible = QUOTAS.filter(function (q) {
      const lim = monthly[q.key];
      // Skip unlimited (null / missing). Free-tier limits of 1 still
      // render so the user sees how close they are.
      return typeof lim === "number" && lim > 0;
    });
    if (!visible.length) {
      // Every quota is unlimited (Career plan). Show a quiet badge
      // instead of an empty bar list.
      return (
        '<div class="user-menu-quotas user-menu-quotas--unlimited">' +
          '<i class="fa-solid fa-infinity" aria-hidden="true"></i>' +
          '<span>All AI features unlimited on your plan.</span>' +
        '</div>'
      );
    }
    const st = window.CBV2.sanitizeText || function (x) { return String(x || ""); };
    const rows = visible.map(function (q) {
      const used = Number(usage[q.key] || 0);
      const lim = Number(monthly[q.key]);
      const pct = Math.max(0, Math.min(100, Math.round((used / lim) * 100)));
      const tone = pct >= 90 ? "rose" : (pct >= 60 ? "amber" : "ok");
      return (
        '<div class="user-menu-quota-row">' +
          '<div class="user-menu-quota-line">' +
            '<span class="user-menu-quota-label">' + st(q.label) + '</span>' +
            '<span class="user-menu-quota-numbers">' + used + ' <span>/ ' + lim + '</span></span>' +
          '</div>' +
          '<div class="user-menu-quota-bar"><span class="user-menu-quota-bar-fill user-menu-quota-bar-fill--' + tone + '" style="width:' + pct + '%"></span></div>' +
        '</div>'
      );
    }).join("");
    return (
      '<div class="user-menu-quotas">' +
        '<div class="user-menu-quotas-head">' +
          '<span>This month\'s usage</span>' +
          '<a href="#/settings?tab=account" class="user-menu-quotas-link">Manage</a>' +
        '</div>' +
        rows +
      '</div>'
    );
  }

  function renderStatusPillSlot() {
    const host = '<span data-status-pill-slot class="status-pill-slot"></span>';
    return host;
  }

  function renderBrand(compact) {
    if (window.CBV2.brandKit && typeof window.CBV2.brandKit.logo === "function") {
      return window.CBV2.brandKit.logo({ compact: !!compact, tagline: false });
    }
    return '<span class="cb-logo-wordmark">Career<span>Boost</span></span>';
  }

  function activeRoleProfileBanner() {
    const store = window.CBV2 && window.CBV2.store;
    if (!store || typeof store.getJobSearchState !== "function") return "";
    const js = store.getJobSearchState() || {};
    const rp = js.roleProfile || {};
    const titles = Array.isArray(rp.targetTitles) ? rp.targetTitles : [];
    const skills = Array.isArray(rp.mustHaveSkills) ? rp.mustHaveSkills : [];
    const active = titles.length || skills.length || rp.seniority && rp.seniority !== "any";
    if (!active) return "";
    const mode = rp.strictMode ? "Strict" : "Broad";
    const titleText = titles.length ? titles.slice(0, 2).join(", ") : "role focus";
    return (
      '<div class="topbar-role-profile chip cyan" title="Role targeting hints are saved for the next Job Search build">' +
      '<i class="fa-solid fa-crosshairs"></i> Role profile active · ' + titleText + ' · ' + mode +
      '</div>'
    );
  }

  window.CBV2.createAppShell = function (activeRoute) {
    const groups = navConfig.map(function (group) {
      return renderGroup(group, activeRoute);
    }).join("");

    return `
      <div class="app-shell">
        <aside class="sidebar">
          <a class="brand" href="#/dashboard" aria-label="CareerBoost — go to dashboard">
            ${renderBrand(true)}
          </a>
          ${groups}
          <div class="sidebar-footer">
            <button class="nav-link sidebar-help" type="button" data-shortcuts-open aria-label="Keyboard shortcuts (press ?)">
              <i class="fa-solid fa-keyboard" aria-hidden="true"></i>
              <span>Shortcuts</span>
              <kbd class="kbd-inline">?</kbd>
            </button>
          </div>
        </aside>
        <button class="nav-overlay" type="button" data-nav-close aria-label="Close navigation menu"></button>
        <div class="main-column">
          <header class="topbar">
            <button class="btn-ghost topbar-menu-btn" type="button" data-nav-toggle aria-label="Open navigation menu" aria-expanded="false">
              <i class="fa-solid fa-bars" aria-hidden="true"></i>
            </button>
            <button class="topbar-search-wrap topbar-search-button" type="button" data-open-palette aria-label="Open command palette">
              <i class="fa-solid fa-magnifying-glass topbar-search-icon" aria-hidden="true"></i>
              <span class="topbar-search topbar-search-display">Search or jump to <span class="topbar-search-hint">— applications, events, pages, actions</span></span>
              <kbd class="topbar-search-kbd"><span class="kbd-cmd">⌘</span>K</kbd>
            </button>
            <div class="topbar-actions">
              ${activeRoleProfileBanner()}
              ${renderStatusPillSlot()}
              <a class="btn-primary" href="#/applications?add=1"><i class="fa-solid fa-plus"></i> Quick Add</a>
              ${renderUserChip()}
            </div>
          </header>
          <main id="route-view"></main>
        </div>
      </div>
    `;
  };

  window.CBV2.bindNavShell = function () {
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    const toggleBtn = shell.querySelector("[data-nav-toggle]");
    const closeBtn = shell.querySelector("[data-nav-close]");

    function setOpen(isOpen) {
      shell.classList.toggle("is-nav-open", isOpen);
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      }
      document.body.classList.toggle("nav-open", isOpen);
    }

    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        setOpen(!shell.classList.contains("is-nav-open"));
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        setOpen(false);
      });
    }

    shell.querySelectorAll(".sidebar .nav-link, .sidebar .brand").forEach(function (el) {
      el.addEventListener("click", function () {
        setOpen(false);
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && shell.classList.contains("is-nav-open")) {
        setOpen(false);
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 1024 && shell.classList.contains("is-nav-open")) {
        setOpen(false);
      }
    });
  };

  window.CBV2.bindShortcutsButton = function () {
    const btn = document.querySelector("[data-shortcuts-open]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (window.CBV2.shortcuts && window.CBV2.shortcuts.openCheatsheet) {
        window.CBV2.shortcuts.openCheatsheet();
      }
    });
  };

  // Repaints the topbar user-chip (avatar + dropdown) without re-rendering
  // the entire app shell. Used by the Profile settings page after avatar
  // upload / name change so the change is visible instantly.
  //
  // Day 4.5 — preserve the open/closed state of the dropdown across
  // the swap. Previously, entitlements-driven repaints would
  // collapse the user's open menu mid-click because the fresh chip
  // started with menu.hidden=true. We carry the state forward.
  function refreshUserChip() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions) return;
    const existing = actions.querySelector("[data-user-chip]");
    // Capture open/closed state before swap so live repaints don't
    // close the dropdown the user is actively looking at.
    const wasOpen = existing
      ? !!(existing.querySelector("[data-user-menu]") && !existing.querySelector("[data-user-menu]").hidden)
      : false;
    const html = renderUserChip();
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) return;
    // Restore open state on the fresh element before swap so there's
    // no visual flicker.
    if (wasOpen) {
      const freshMenu = fresh.querySelector("[data-user-menu]");
      const freshBtn = fresh.querySelector("[data-user-toggle]");
      if (freshMenu) freshMenu.hidden = false;
      if (freshBtn) freshBtn.setAttribute("aria-expanded", "true");
      fresh.classList.add("is-open");
    }
    if (existing) {
      existing.replaceWith(fresh);
    } else {
      actions.appendChild(fresh);
    }
    window.CBV2.bindUserMenu();
  }
  window.CBV2.refreshUserChip = refreshUserChip;

  // Subscribe once to profile changes so any repaint is automatic.
  if (window.CBV2.profile && !window.CBV2.__userChipSubscribed) {
    window.CBV2.profile.on("change", function () {
      if (document.querySelector("[data-user-chip]")) refreshUserChip();
    });
    window.CBV2.__userChipSubscribed = true;
  }

  // Day 4.5 — subscribe to entitlements changes so the quota meter
  // inside the user menu updates live whenever a quota is consumed or
  // the plan changes. entitlements.recordConsumption + load both
  // notify subscribers; this hook turns those notifications into a
  // user-chip repaint.
  //
  // IMPORTANT: app-shell.js loads BEFORE entitlements.js in
  // index.html — so window.CBV2.entitlements is undefined when this
  // IIFE first runs. The previous version's `if (entitlements && ...)`
  // check fell through silently. Replaced with a polling pattern that
  // waits up to ~6s for entitlements to register, then both subscribes
  // AND fires an initial refreshUserChip so any "Loading usage…"
  // placeholder gets replaced by the real meter.
  (function wireEntitlementsSubscription(attempts) {
    attempts = attempts || 0;
    if (window.CBV2.__userChipEntSubscribed) return;
    const ent = window.CBV2 && window.CBV2.entitlements;
    if (ent && typeof ent.onChange === "function") {
      ent.onChange(function () {
        if (document.querySelector("[data-user-chip]")) refreshUserChip();
      });
      window.CBV2.__userChipEntSubscribed = true;
      // Race-safe initial refresh: if entitlements already had data
      // when we subscribed (i.e. load() resolved before we got here),
      // we missed the notify(). Repaint now so the menu reflects it.
      if (typeof ent.get === "function" && ent.get()) {
        if (document.querySelector("[data-user-chip]")) refreshUserChip();
      } else if (typeof ent.load === "function") {
        // No data yet — kick off a load. The subscription above will
        // catch the resulting notify().
        ent.load(false).catch(function () { /* ignore */ });
      }
      return;
    }
    if (attempts < 30) {
      setTimeout(function () { wireEntitlementsSubscription(attempts + 1); }, 200);
    }
  })();

  window.CBV2.bindUserMenu = function () {
    const wrap = document.querySelector("[data-user-chip]");
    if (!wrap) return;
    const btn = wrap.querySelector("[data-user-toggle]");
    const menu = wrap.querySelector("[data-user-menu]");
    const out = wrap.querySelector("[data-signout]");

    function setOpen(isOpen) {
      if (!menu || !btn) return;
      menu.hidden = !isOpen;
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      wrap.classList.toggle("is-open", isOpen);
      // Day 4.5 — when opening the menu, force-refresh the quota meter
      // if it's still showing the placeholder. Covers the edge case
      // where the entitlements subscription didn't fire (e.g. first
      // open before load() resolved).
      if (isOpen) {
        const ent = window.CBV2 && window.CBV2.entitlements;
        if (ent && typeof ent.load === "function" && typeof ent.get === "function") {
          if (!ent.get()) {
            // Cold state — kick a load. Once it resolves, the
            // entitlements.onChange subscription repaints the chip.
            ent.load(false).catch(function () {});
          }
        }
      }
    }

    if (btn && menu) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        setOpen(menu.hidden);
      });
      document.addEventListener("click", function (e) {
        if (!wrap.contains(e.target)) setOpen(false);
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !menu.hidden) setOpen(false);
      });
    }
    if (out) {
      out.addEventListener("click", async function () {
        setOpen(false);
        // Day 4.3 — confirm before signing out. One-tap mistakes cost a
        // re-login (typing password again on mobile is genuinely
        // annoying) and any unsaved draft state in the resume / cover
        // editors stays on this device but won't be visible after a
        // re-auth if the device differs.
        //
        // Uses the shared modal-service (cbv2.modal.confirm). If the
        // service hasn't loaded yet for some reason — load order quirk
        // or asset failure — we fall through to the original immediate
        // sign-out so the action still works.
        const modal = window.CBV2 && window.CBV2.modal;
        if (modal && typeof modal.confirm === "function") {
          const ok = await modal.confirm({
            title: "Sign out?",
            body: "You'll need to sign in again next time you visit. Any unsaved drafts in the resume or cover-letter editor stay saved on this device.",
            confirmLabel: "Sign out",
            cancelLabel: "Stay signed in",
            tone: "danger"
          });
          if (!ok) return;
        }
        try { await window.CBV2.auth.signOut(); } catch (e) { /* ignore */ }
        window.location.hash = "#/welcome";
      });
    }
  };
})();
