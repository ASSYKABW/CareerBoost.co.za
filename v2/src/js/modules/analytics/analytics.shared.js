// Analytics shared constants and formatting helpers.
(function () {
  window.CBV2 = window.CBV2 || {};

  const STAGE_ORDER = ["saved", "applied", "interview", "offer", "rejected", "withdrawn"];
  const STAGE_LABEL = {
    saved: "Saved",
    applied: "Applied",
    interview: "Interview",
    offer: "Offer",
    rejected: "Rejected",
    withdrawn: "Withdrawn"
  };
  const STAGE_COLOR = {
    saved: "#22d3ee",
    applied: "#6b7dff",
    interview: "#3b82f6",
    offer: "#22c55e",
    rejected: "#f59e0b",
    withdrawn: "#f43f5e"
  };
  const DAY_MS = 86400000;

  function pct(n) {
    if (!isFinite(n)) return "0%";
    return Math.round(n) + "%";
  }

  function stageLabel(stage) {
    return STAGE_LABEL[stage] || stage || "";
  }

  window.CBV2.analyticsShared = {
    STAGE_ORDER: STAGE_ORDER,
    STAGE_LABEL: STAGE_LABEL,
    STAGE_COLOR: STAGE_COLOR,
    DAY_MS: DAY_MS,
    pct: pct,
    stageLabel: stageLabel
  };
})();
