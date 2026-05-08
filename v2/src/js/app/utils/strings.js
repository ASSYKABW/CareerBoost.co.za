(function () {
  window.CBV2 = window.CBV2 || {};

  window.CBV2.sanitizeText = function (input) {
    return String(input || "").replace(/[<>]/g, "");
  };
})();
