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
    const plan = (profile && profile.plan) ? profile.plan : "free";
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
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
              <span class="chip chip-sm violet user-menu-plan">${st(planLabel)} plan</span>
            </div>
          </div>
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
  function refreshUserChip() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions) return;
    const existing = actions.querySelector("[data-user-chip]");
    const html = renderUserChip();
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) return;
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
