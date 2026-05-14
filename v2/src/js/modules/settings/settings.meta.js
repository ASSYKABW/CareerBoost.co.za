// Settings shared tab metadata.
(function () {
  window.CBV2 = window.CBV2 || {};

  // Phase Billing: "billing" is a new sibling tab between Account and
  // Advanced. Houses current plan + usage meters + Stripe portal link.
  const TABS = ["overview", "me", "job-preferences", "ai", "documents", "data-privacy", "appearance", "account", "billing", "advanced"];
  const ADMIN_ROLES = ["admin", "owner", "developer"];
  const LEGACY_ALIASES = {
    home: "overview",
    profile: "me",
    integrations: "advanced",
    diagnostics: "advanced",
    data: "data-privacy",
    docs: "documents",
    privacy: "data-privacy",
    preferences: "job-preferences",
    "job-search": "job-preferences",
    "job-search-profile": "job-preferences",
    theme: "appearance",
    colors: "appearance"
  };
  const TAB_ITEMS = [
    { id: "overview", icon: "fa-gauge-high", label: "Overview" },
    { id: "me", icon: "fa-user-pen", label: "Profile" },
    { id: "job-preferences", icon: "fa-bullseye", label: "Job Search Profile" },
    { id: "ai", icon: "fa-wand-magic-sparkles", label: "AI Personalization" },
    { id: "documents", icon: "fa-folder-open", label: "Documents" },
    { id: "data-privacy", icon: "fa-shield-halved", label: "Data & Privacy" },
    { id: "appearance", icon: "fa-palette", label: "Appearance" },
    { id: "account", icon: "fa-id-badge", label: "Account" },
    // Phase Billing.
    { id: "billing", icon: "fa-credit-card", label: "Billing & Plan" },
    { id: "advanced", icon: "fa-screwdriver-wrench", label: "Advanced" }
  ];
  const TAB_SUMMARY = {
    overview: "A candidate-friendly command center for setup, sync, and service readiness.",
    me: "Update your profile identity, avatar, and headline.",
    "job-preferences": "Define the role targets and constraints that shape search quality.",
    appearance: "Choose your app theme colors and keep your workspace personal.",
    documents: "Manage your reusable CV versions and career assets.",
    ai: "Control AI personalization behavior and usage consent.",
    "data-privacy": "Control cloud sync, exports, and data safety actions.",
    account: "Review sign-in identity and account-level sync context.",
    billing: "Your current plan, this month's usage, and the Stripe billing portal.",
    advanced: "Technical controls for app operators only."
  };

  function normalizeTab(raw) {
    const tab = String(raw || "").toLowerCase().trim();
    const mapped = LEGACY_ALIASES[tab] || tab;
    return TABS.indexOf(mapped) >= 0 ? mapped : "overview";
  }

  function roleListFromUser(user) {
    if (!user) return [];
    const appMeta = user.app_metadata || {};
    const userMeta = user.user_metadata || {};
    return []
      .concat(appMeta.role || [])
      .concat(appMeta.roles || [])
      .concat(userMeta.role || [])
      .concat(userMeta.roles || [])
      .map(function (x) { return String(x || "").toLowerCase(); });
  }

  function canAccessAdvanced(user) {
    return roleListFromUser(user).some(function (r) { return ADMIN_ROLES.indexOf(r) >= 0; });
  }

  function visibleTabs(canAccessAdvancedTab) {
    return TAB_ITEMS.filter(function (item) {
      return canAccessAdvancedTab || item.id !== "advanced";
    });
  }

  function summary(tab) {
    return TAB_SUMMARY[tab] || TAB_SUMMARY.overview;
  }

  window.CBV2.settingsMeta = {
    TABS: TABS,
    ADMIN_ROLES: ADMIN_ROLES,
    LEGACY_ALIASES: LEGACY_ALIASES,
    TAB_ITEMS: TAB_ITEMS,
    TAB_SUMMARY: TAB_SUMMARY,
    normalizeTab: normalizeTab,
    roleListFromUser: roleListFromUser,
    canAccessAdvanced: canAccessAdvanced,
    visibleTabs: visibleTabs,
    summary: summary
  };
})();
