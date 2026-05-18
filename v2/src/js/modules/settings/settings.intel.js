// P2: Settings → Candidate intelligence card.
//
// Extracted from settings.route.js (was renderCandidateIntelligenceSettingsSection).
// First extraction of the larger "split 3387-line settings.route.js"
// effort — proves the pattern of moving pure renderers behind
// window.CBV2.settings* namespaces, with settings.route.js calling
// `window.CBV2.settingsIntel.render()` when present and falling back
// to a no-op if not.
//
// Dependencies (all read from window.CBV2.* — no closure leak):
//   window.CBV2.candidateIntel      (the intelligence model)
//   window.CBV2.sanitizeText        (HTML escape helper, used as `st`)
//   window.CBV2.ui.candidateIntelligenceCard  (shared card component)
//
// All three are loaded BEFORE settings.route.js, so the namespace is
// guaranteed populated by the time render() runs.

(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.settingsIntel = window.CBV2.settingsIntel || {};

  function st(v) {
    return (window.CBV2.sanitizeText || String)(v);
  }

  function render() {
    const api = window.CBV2.candidateIntel;
    if (!api || typeof api.build !== "function") return "";
    const intel = api.build();
    const topSkills = (intel.skills && intel.skills.top ? intel.skills.top : []).slice(0, 8);
    const missing = (intel.skills && intel.skills.missingTarget ? intel.skills.missingTarget : []).slice(0, 5);
    const actions = (intel.nextActions || []).slice(0, 3);
    const missingHtml = missing.length
      ? missing.map(function (skill) {
          return '<span class="chip warning">' + st(api.formatSkill ? api.formatSkill(skill) : skill) + "</span>";
        }).join("")
      : '<span class="chip green">Target skills covered</span>';
    if (window.CBV2.ui && typeof window.CBV2.ui.candidateIntelligenceCard === "function") {
      return window.CBV2.ui.candidateIntelligenceCard({
        className: "candidate-intel-card--settings settings-section",
        title: "Candidate intelligence",
        badge: "Shared profile model",
        description: "This is the reusable candidate brain behind search ranking, probability scoring, resume tailoring, cover letters, and interview prep.",
        intel: intel,
        skills: topSkills,
        skillLimit: 8,
        skillsInside: false,
        emptySkillsLabel: "No skills mapped yet",
        metrics: [
          { value: String(intel.evidence.count || 0), label: "evidence items" },
          { value: String(intel.evidence.quantifiedCount || 0), label: "quantified proof" },
          { value: String(intel.resume.savedCvCount || 0), label: "saved CVs" }
        ],
        gapsHtml: '<strong>Target gaps</strong>' + missingHtml,
        actions: actions,
        actionClass: "settings-action-list"
      });
    }
    return "";
  }

  window.CBV2.settingsIntel.render = render;
})();
