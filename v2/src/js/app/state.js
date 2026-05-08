(function () {
  window.CBV2 = window.CBV2 || {};

  const state = {
    route: "dashboard",
    user: {
      name: "there",
      role: "Job Seeker"
    },
    metrics: {
      totalApplications: 42,
      responseRate: 28,
      interviews: 6,
      offers: 1
    },
    ai: {
      busy: false,
      error: "",
      result: null
    },
    digest: {
      busy: false,
      results: [],
      generatedAt: 0
    }
  };

  window.CBV2.getState = function () {
    return state;
  };

  window.CBV2.setRoute = function (nextRoute) {
    state.route = nextRoute;
  };

  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};
})();
