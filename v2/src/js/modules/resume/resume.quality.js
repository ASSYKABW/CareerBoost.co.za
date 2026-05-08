// Resume Lab shared quality helpers.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  function clampScore(n) {
    return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  }

  function scoreTone(score) {
    const s = clampScore(score);
    if (s >= 86) return "green";
    if (s >= 70) return "warning";
    return "rose";
  }

  function readinessLabel(score) {
    const s = clampScore(score);
    if (s >= 86) return "Ready to submit";
    if (s >= 70) return "Needs light polish";
    if (s >= 50) return "Needs stronger evidence";
    return "Needs rebuilding";
  }

  function evidenceBand(score) {
    const s = clampScore(score);
    if (s >= 75) return { tone: "green", label: "Strong evidence" };
    if (s >= 45) return { tone: "warning", label: "Some evidence" };
    return { tone: "rose", label: "Thin evidence" };
  }

  window.CBV2.resume.quality = {
    clampScore: clampScore,
    scoreTone: scoreTone,
    readinessLabel: readinessLabel,
    evidenceBand: evidenceBand
  };
})();
