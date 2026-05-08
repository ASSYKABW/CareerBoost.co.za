(function () {
  window.CBV2 = window.CBV2 || {};

  window.CBV2.renderPlaceholderPage = function (title, subtitle) {
    return `
      <section class="page-container">
        <h1 class="page-title">${title}</h1>
        <p class="page-subtitle">${subtitle}</p>
        <div class="card-grid">
          <article class="card">
            <div class="label">Module</div>
            <div class="value">Shell ready — connect data & AI next</div>
          </article>
        </div>
      </section>
    `;
  };
})();
