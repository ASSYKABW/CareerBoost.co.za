(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.ui && window.CBV2.ui.version >= 1) return;

  function st(value) {
    const fn = window.CBV2.sanitizeText;
    return fn ? fn(value) : String(value == null ? "" : value);
  }

  function attrs(map) {
    return Object.keys(map || {}).map(function (key) {
      const value = map[key];
      if (value === false || value == null) return "";
      if (value === true) return " " + key;
      return " " + key + '="' + st(value) + '"';
    }).join("");
  }

  function chip(label, tone, icon, extraClass) {
    return (
      '<span class="chip ' + st(tone || "subtle") + (extraClass ? " " + st(extraClass) : "") + '">' +
        (icon ? '<i class="fa-solid ' + st(icon) + '" aria-hidden="true"></i> ' : '') +
        st(label) +
      '</span>'
    );
  }

  function panelHead(title, badge, badgeTone, icon) {
    return (
      '<div class="panel-head">' +
        '<h2>' + (icon ? '<i class="fa-solid ' + st(icon) + '" aria-hidden="true"></i> ' : '') + st(title) + '</h2>' +
        (badge ? chip(badge, badgeTone || "cyan") : '') +
      '</div>'
    );
  }

  function emptyState(options) {
    const o = options || {};
    const actions = (o.actions || []).map(function (action) {
      const tag = action.href ? "a" : "button";
      const attr = action.href
        ? attrs({ class: action.className || "btn-secondary", href: action.href })
        : attrs({ class: action.className || "btn-secondary", type: "button", id: action.id });
      return (
        '<' + tag + attr + '>' +
          (action.icon ? '<i class="fa-solid ' + st(action.icon) + '" aria-hidden="true"></i> ' : '') +
          st(action.label) +
        '</' + tag + '>'
      );
    }).join("");
    return (
      '<div class="empty-state ' + st(o.className || "") + '">' +
        '<div class="empty-state-icon"><i class="fa-solid ' + st(o.icon || "fa-circle-info") + '" aria-hidden="true"></i></div>' +
        '<h3>' + st(o.title || "Nothing here yet") + '</h3>' +
        (o.body ? '<p>' + st(o.body) + '</p>' : '') +
        (actions ? '<div class="empty-state-actions">' + actions + '</div>' : '') +
      '</div>'
    );
  }

  function metricPills(items) {
    return (items || []).map(function (item) {
      return (
        '<span><strong>' + st(item.value) + '</strong><small>' + st(item.label) + '</small></span>'
      );
    }).join("");
  }

  function skillChips(skills, formatter, emptyLabel) {
    const list = (skills || []).filter(Boolean);
    if (!list.length) return chip(emptyLabel || "No skills mapped yet", "warning");
    return list.map(function (skill) {
      return chip(formatter ? formatter(skill) : skill, "subtle");
    }).join("");
  }

  function actionRows(actions, detail) {
    return (actions || []).map(function (action) {
      return (
        '<a class="settings-action-row" href="' + st(action.href || "#/settings") + '">' +
          '<span class="settings-action-check"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>' +
          '<span class="settings-action-copy"><strong>' + st(action.label || "Improve profile") + '</strong>' +
          '<small>' + st(action.detail || detail || "Improves matching, resume tailoring, and interview preparation.") + '</small></span>' +
          '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>' +
        '</a>'
      );
    }).join("");
  }

  function candidateIntelligenceCard(options) {
    const o = options || {};
    const api = window.CBV2.candidateIntel;
    if (!api || typeof api.build !== "function") return "";
    const intel = o.intel || api.build();
    const score = intel.scores && typeof intel.scores.readiness === "number" ? intel.scores.readiness : 0;
    const topSkills = o.skills || (intel.skills && intel.skills.top ? intel.skills.top : []);
    const formatter = api.formatSkill ? api.formatSkill : null;
    const metrics = o.metrics || [
      { value: String(intel.evidence && intel.evidence.count || 0), label: "proof points" },
      { value: String((intel.roleProfile && intel.roleProfile.targetTitles || []).length), label: "target roles" },
      { value: String((intel.skills && intel.skills.matchedTarget || []).length), label: "matched skills" }
    ];
    const gaps = typeof o.gapsHtml === "string"
      ? o.gapsHtml
      : (intel.gaps || []).slice(0, 3).map(function (gap) {
          return '<span><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>' + st(gap.label) + '</span>';
        }).join("") || '<span><i class="fa-solid fa-check" aria-hidden="true"></i>Candidate intelligence is ready to guide matching.</span>';
    const actionHtml = actionRows(o.actions || (intel.nextActions || []).slice(0, 3), o.actionDetail);

    return (
      '<article class="card panel-lg candidate-intel-card ' + st(o.className || "") + '">' +
        panelHead(o.title || "Candidate intelligence", o.badge || "Shared profile model", o.badgeTone || "cyan") +
        '<div class="candidate-intel-body">' +
          '<div class="candidate-intel-score" style="--score:' + st(String(score)) + '">' +
            '<strong>' + st(String(score)) + '</strong><span>/ 100 ready</span>' +
          '</div>' +
          '<div class="candidate-intel-copy">' +
            '<p class="page-subtitle">' + st(o.description || "CareerBoost builds one reusable profile from your resume, target roles, saved evidence, and pipeline outcomes.") + '</p>' +
            '<div class="candidate-intel-metrics">' + metricPills(metrics) + '</div>' +
            (o.skillsInside === false ? '' : '<div class="candidate-intel-skills">' + skillChips(topSkills.slice(0, o.skillLimit || 6), formatter, o.emptySkillsLabel) + '</div>') +
          '</div>' +
        '</div>' +
        (o.skillsInside === false ? '<div class="candidate-intel-skills">' + skillChips(topSkills.slice(0, o.skillLimit || 8), formatter, o.emptySkillsLabel) + '</div>' : '') +
        '<div class="candidate-intel-gaps">' + gaps + '</div>' +
        (actionHtml ? '<div class="' + st(o.actionClass || "candidate-intel-actions") + '">' + actionHtml + '</div>' : '') +
      '</article>'
    );
  }

  window.CBV2.ui = {
    version: 1,
    attrs: attrs,
    chip: chip,
    panelHead: panelHead,
    emptyState: emptyState,
    metricPills: metricPills,
    skillChips: skillChips,
    actionRows: actionRows,
    candidateIntelligenceCard: candidateIntelligenceCard
  };
})();
