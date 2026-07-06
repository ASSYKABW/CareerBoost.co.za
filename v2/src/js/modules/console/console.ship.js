// CareerBoost Console — Ship section (Phase D part 2).
//
// Registers window.CBConsole.sections.ship = { load(bodyEl) }. Lists each
// agent-fix PR (open, targeting main) with its Vercel PREVIEW link, a diff
// link, and a Deploy button. "Deploy" squash-merges the PR into main → Vercel
// ships it live. One fix at a time; the operator is the gate.
(function () {
  window.CBConsole = window.CBConsole || {};
  window.CBConsole.sections = window.CBConsole.sections || {};
  var U = function () { return window.CBConsole.util; };
  var D = function () { return window.CBConsole.data; };
  function esc(s) { return U().escapeHtml(s); }

  // GitHub mergeable_state → chip + whether Deploy is allowed.
  function stat(mergeableState, mergeable) {
    if (mergeableState === "dirty" || mergeable === false) return { tone: "red", label: "conflicts", ok: false };
    if (mergeableState === "blocked") return { tone: "amber", label: "checks pending", ok: true };
    if (mergeableState === "behind") return { tone: "amber", label: "behind main", ok: true };
    if (mergeableState === "unstable") return { tone: "amber", label: "checks running", ok: true };
    if (mergeableState === "clean") return { tone: "green", label: "ready", ok: true };
    return { tone: "dim", label: mergeableState || "checking…", ok: true };
  }

  function prCard(p) {
    var s = stat(p.mergeableState, p.mergeable);
    var preview = p.previewUrl
      ? '<a class="cbc-btn cbc-sm cbc-primary" href="' + esc(p.previewUrl) + '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-eye"></i> Preview site</a>'
      : '<span class="cbc-btn cbc-sm" style="opacity:.6;cursor:default" title="Vercel is still building the preview — hit Refresh in a moment"><i class="fa-solid fa-spinner fa-spin"></i> Preview building…</span>';
    var deploy = s.ok
      ? '<button class="cbc-btn cbc-sm cbc-primary" data-ship-deploy="' + p.number + '" data-ship-title="' + esc(p.title) + '"><i class="fa-solid fa-rocket"></i> Deploy</button>'
      : '<button class="cbc-btn cbc-sm" disabled title="Merge conflicts — needs a manual look"><i class="fa-solid fa-triangle-exclamation"></i> Can\'t deploy</button>';
    return '<div class="cbc-card cbc-panel" style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">' +
        '<div><div style="font-weight:650;font-size:14.5px">' + esc(p.title) + '</div>' +
          '<div style="font-size:12px;color:var(--c-muted);margin-top:3px">' +
            (p.issue ? "Fixes #" + esc(p.issue) + " · " : "") +
            '<span style="font-family:var(--c-mono)">' + esc(p.branch) + "</span> · " +
            '<span class="cbc-chip green">+' + Number(p.additions || 0) + "</span> " +
            '<span class="cbc-chip red">&minus;' + Number(p.deletions || 0) + "</span> " +
            Number(p.changedFiles || 0) + " file" + (Number(p.changedFiles) === 1 ? "" : "s") + "</div></div>" +
        '<span class="cbc-chip ' + s.tone + '">' + esc(s.label) + "</span></div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
        preview +
        '<a class="cbc-btn cbc-sm" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-code-compare"></i> What changed</a>' +
        deploy +
        '<button class="cbc-btn cbc-sm" data-ship-reject="' + p.number + '"><i class="fa-solid fa-xmark"></i> Reject</button>' +
      "</div></div>";
  }

  async function load(bodyEl) {
    bodyEl.innerHTML = '<section class="cbc-card cbc-panel" style="color:var(--c-muted)">Loading agent fixes…</section>';
    var data;
    try {
      data = await D().loadShip();
    } catch (e) {
      bodyEl.innerHTML = '<section class="cbc-card cbc-panel" style="color:#ff9aa2">Could not load fixes: ' + esc((e && e.message) || "error") + "</section>";
      return;
    }
    var prs = (data && data.prs) || [];
    var head = '<section class="cbc-card cbc-panel" style="margin-bottom:12px">' +
      '<div class="cbc-ph"><div><div class="cbc-eb">Ship</div><h2>Agent fixes waiting</h2></div>' +
      '<button class="cbc-btn cbc-sm" data-ship-refresh="1"><i class="fa-solid fa-rotate"></i> Refresh</button></div>' +
      '<div style="font-size:12px;color:var(--c-muted)">Each fix is a PR against <b>' + esc(data.prodBranch || "main") +
      "</b>. Open the preview to see it live-but-not-real; happy? Deploy ships it straight to production.</div>" +
      U().sampleBadge(data && data._mock, "console-ship", "agent PRs") + "</section>";
    var list = '<div id="cbc-ship-list">' + (prs.length
      ? prs.map(prCard).join("")
      : '<div class="cbc-card cbc-panel" style="color:var(--c-muted);font-size:13px"><i class="fa-solid fa-circle-check" style="color:var(--c-ok)"></i> No fixes waiting. When the code agent opens a PR, it lands here to preview + deploy.</div>') + "</div>";
    bodyEl.innerHTML = head + list;
    bindShip(bodyEl);
  }

  // One delegated listener on bodyEl (survives innerHTML re-renders on refresh).
  function bindShip(bodyEl) {
    if (bodyEl.__shipBound) return;
    bodyEl.__shipBound = true;
    bodyEl.addEventListener("click", async function (e) {
      var t = e.target.closest ? e.target.closest("[data-ship-deploy],[data-ship-reject],[data-ship-refresh]") : null;
      if (!t) return;
      var toast = (window.CBConsole.ui && window.CBConsole.ui.toast) || function (m) { console.log(m); };
      if (t.hasAttribute("data-ship-refresh")) { load(bodyEl); return; }
      var num = Number(t.getAttribute("data-ship-deploy") || t.getAttribute("data-ship-reject"));
      if (t.hasAttribute("data-ship-deploy")) {
        var title = t.getAttribute("data-ship-title") || ("#" + num);
        if (!window.confirm('Deploy "' + title + '" to production now?\nIt will be live on careerboost.co.za within ~a minute.')) return;
        t.disabled = true; t.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deploying…';
        try { await D().deployShip(num); toast("Deployed — live within ~1 minute 🚀"); load(bodyEl); }
        catch (err) { t.disabled = false; toast((err && err.message) ? err.message : "Deploy failed."); }
        return;
      }
      if (t.hasAttribute("data-ship-reject")) {
        var reason = window.prompt("Reject this fix and close the PR?\nOptional note (sent to the PR):", "");
        if (reason === null) return; // cancelled
        t.disabled = true;
        try { await D().rejectShip(num, reason); toast("Rejected — PR closed."); load(bodyEl); }
        catch (err) { t.disabled = false; toast((err && err.message) ? err.message : "Could not reject."); }
      }
    });
  }

  window.CBConsole.sections.ship = { load: load };
})();
