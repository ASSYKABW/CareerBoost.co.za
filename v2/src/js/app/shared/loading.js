(function () {
  window.CBV2 = window.CBV2 || {};

  window.CBV2.renderLoadingSkeleton = function () {
    return `
      <section class="page-container">
        <section class="skeleton-row">
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-subtitle"></div>
        </section>
        <section class="card-grid">
          <article class="card skeleton-card"><div class="skeleton skeleton-block"></div></article>
          <article class="card skeleton-card"><div class="skeleton skeleton-block"></div></article>
          <article class="card skeleton-card"><div class="skeleton skeleton-block"></div></article>
          <article class="card skeleton-card"><div class="skeleton skeleton-block"></div></article>
        </section>
      </section>
    `;
  };
})();
