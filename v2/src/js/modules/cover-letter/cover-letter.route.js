(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const viewState = {
    busy: false,
    error: "",
    result: null,
    scoreDetailsOpen: false,
    selectedAssetIds: {},
    coverTemplate: "professional-clean",
    // Phase 5C: evidence ranking state.
    sortAssetsByJd: false,         // user-toggled — when true, proof bank sorts by JD relevance
    rankAssetsBusy: false,
    assetSimilarities: {},         // map: assetId → cosine similarity (0..1)
    assetRankSourceJdHash: ""      // hash of the JD used for current rankings (so re-rank fires on JD change)
  };

  const COVER_TEMPLATES = [
    { id: "professional-clean", name: "Professional Clean" },
    { id: "personal-info-right", name: "Personal Info Right" },
    { id: "profile-header", name: "Profile Header" },
    { id: "serif-editorial", name: "Serif Editorial" },
    { id: "bold-hero", name: "Bold Hero" }
  ];

  function getSt() {
    return window.CBV2.sanitizeText;
  }

  function getActiveDraft() {
    const c = getCoverLetterState();
    const saved = c.lastResult;
    const active = viewState.result || saved || null;
    const v = getActiveVariant();
    const d = active && active.data ? active.data : null;
    return {
      active: active,
      subject: String((v && v.subject) || (d && d.subject) || ""),
      body: String((v && v.body) || (d && d.body) || "")
    };
  }

  function getInputSnapshot() {
    const form = document.getElementById("cover-form");
    if (!form) return { company: "", role: "", tone: "", length: "", manager: "", mission: "", context: "", jobDescription: "", rolePackId: "" };
    const fd = new FormData(form);
    return {
      company: String(fd.get("company") || "").trim(),
      role: String(fd.get("role") || "").trim(),
      tone: String(fd.get("tone") || "").trim(),
      length: String(fd.get("length") || "").trim(),
      manager: String(fd.get("manager") || "").trim(),
      mission: String(fd.get("mission") || "").trim(),
      context: String(fd.get("context") || "").trim(),
      jobDescription: String(fd.get("jobDescription") || "").trim(),
      rolePackId: String(fd.get("rolePack") || "").trim()
    };
  }

  function getCareerAssets() {
    const store = window.CBV2.store;
    if (!store || typeof store.getCareerAssets !== "function") return [];
    return store.getCareerAssets();
  }

  function getCoverLetterState() {
    const s = window.CBV2.store;
    if (s && typeof s.getCoverLetterState === "function") return s.getCoverLetterState();
    const legacy = ((s && typeof s.getAll === "function" ? s.getAll() : {}).coverLetter || {});
    return {
      lastResult: legacy.lastResult || null,
      variants: Array.isArray(legacy.variants) ? legacy.variants : [],
      activeVariantId: typeof legacy.activeVariantId === "string" ? legacy.activeVariantId : "",
      sentLog: Array.isArray(legacy.sentLog) ? legacy.sentLog : [],
      rolePacks: Array.isArray(legacy.rolePacks) ? legacy.rolePacks : [],
      activeRolePackId: typeof legacy.activeRolePackId === "string" ? legacy.activeRolePackId : ""
    };
  }

  function getActiveVariant() {
    const c = getCoverLetterState();
    const id = c.activeVariantId || "";
    return (c.variants || []).find(function (v) { return v.id === id; }) || null;
  }

  function getRolePacks() {
    return (getCoverLetterState().rolePacks || []).slice();
  }

  function getActiveRoleContext() {
    const svc = window.CBV2.roleContext;
    if (!svc || typeof svc.get !== "function") return null;
    return svc.get();
  }

  function roleContextJobText(ctx) {
    if (!ctx) return "";
    return String(ctx.jobDescription || ctx.notes || "").trim();
  }

  function renderActiveRoleContextBanner(ctx) {
    if (!ctx) return "";
    const st = getSt();
    const hasPosting = !!roleContextJobText(ctx);
    return (
      '<div class="role-context-banner cover-context-banner">' +
        '<i class="fa-solid fa-crosshairs" aria-hidden="true"></i>' +
        '<div>' +
          '<span>Active role context</span>' +
          '<strong>' + st((ctx.company || "Company") + " - " + (ctx.role || "Role")) + '</strong>' +
          '<small>' + st(hasPosting ? "Company, role, and posting are ready for this letter." : "Company and role are ready. Add a fuller posting for stronger evidence matching.") + '</small>' +
        '</div>' +
        '<button class="btn-secondary btn-sm" type="button" id="cover-use-active-role"><i class="fa-solid fa-wand-magic-sparkles"></i> Use context</button>' +
        '<button class="btn-ghost btn-sm" type="button" id="cover-clear-active-role"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>'
    );
  }

  function uniqueList(arr, limit) {
    const out = [];
    (arr || []).forEach(function (x) {
      const v = String(x || "").trim();
      if (!v) return;
      if (out.some(function (y) { return y.toLowerCase() === v.toLowerCase(); })) return;
      out.push(v);
    });
    return typeof limit === "number" ? out.slice(0, limit) : out;
  }

  function buildInputIdeas(snapshot, style) {
    const company = snapshot.company || "this company";
    const role = snapshot.role || "this role";
    const toneStyle = String(style || "professional");
    const posting = String(snapshot.jobDescription || "").trim();
    const assets = getCareerAssets().slice(0, 20);
    const skillIdeas = uniqueList(
      assets
        .filter(function (a) { return String(a.type || "").toLowerCase() === "skill"; })
        .map(function (a) { return String(a.text || ""); })
        .concat([
          "Cross-functional collaboration",
          "Stakeholder communication",
          "Problem solving under ambiguity",
          "Execution and ownership"
        ]),
      8
    );
    const evidenceIdeas = uniqueList(
      assets
        .filter(function (a) { return String(a.type || "").toLowerCase() !== "skill"; })
        .map(function (a) { return String(a.text || ""); }),
      5
    );
    const styleLine = toneStyle === "executive"
      ? "at leadership and strategy level"
      : toneStyle === "bold"
      ? "with decisive outcomes and momentum"
      : "with practical collaboration and execution";
    return {
      strengths: [
        skillIdeas.slice(0, 4).join(", "),
        uniqueList(skillIdeas.slice(0, 2).concat(["Process improvement", "Quality focus"])).join(", "),
        uniqueList(skillIdeas.slice(1, 4).concat(["Customer impact", "Data-informed decisions"])).join(", ")
      ],
      why: [
        "I am excited about " + company + " because the mission aligns with my experience delivering measurable outcomes in " + role + " " + styleLine + ".",
        "The role at " + company + " stands out to me because I can contribute quickly while learning from a high-performing team " + styleLine + ".",
        "I am motivated by the opportunity to help " + company + " scale impact through disciplined execution and collaboration " + styleLine + "."
      ],
      mission: [
        company + " focuses on delivering meaningful value to customers through quality and innovation.",
        "The team appears to value ownership, speed, and thoughtful decision-making, which matches how I work.",
        "Recent growth and product momentum suggest a strong environment for high-impact contribution."
      ],
      context: [
        posting
          ? "Use the job posting to mirror the top requirements, then connect them to one specific result from my background."
          : "",
        "In this " + role + " role, I can improve delivery quality while reducing cycle time through clear prioritization and collaboration.",
        "I can help the team ship faster by turning ambiguous requirements into structured, actionable execution plans.",
        "I bring practical experience balancing business goals, technical constraints, and user value."
      ].filter(Boolean),
      evidence: evidenceIdeas
    };
  }

  function countWords(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length;
  }

  function lengthRange(length) {
    const l = String(length || "medium").toLowerCase();
    if (l === "short") return { min: 120, max: 190 };
    if (l === "long") return { min: 290, max: 390 };
    return { min: 200, max: 290 };
  }

  function normalizeDraftLength(subject, body, input) {
    let b = String(body || "").trim();
    if (!b) return b;
    const range = lengthRange(input && input.length);
    let words = countWords(b);
    if (words < range.min) {
      const company = (input && input.company) || "the company";
      const role = (input && input.role) || "the role";
      const strengths = Array.isArray(input && input.strengths) ? input.strengths.slice(0, 3).join(", ") : "";
      const why = String((input && input.why) || "").split("|")[0].trim();
      const pad = [];
      if (strengths) pad.push("My background in " + strengths + " allows me to contribute quickly with measurable outcomes in " + role + ".");
      if (why) pad.push(why);
      pad.push("I am confident I can support " + company + " by combining execution discipline, stakeholder communication, and continuous improvement.");
      while (words < range.min && pad.length) {
        const next = pad.shift();
        b += "\n\n" + next;
        words = countWords(b);
      }
    }
    if (words > range.max) {
      const parts = b.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
      while (countWords(parts.join("\n\n")) > range.max && parts.length > 3) parts.pop();
      b = parts.join("\n\n");
      if (countWords(b) > range.max) {
        const ws = b.split(/\s+/);
        b = ws.slice(0, range.max).join(" ").replace(/[,:;\- ]+$/g, "") + ".";
      }
    }
    return b;
  }

  function selectedAssets() {
    return getCareerAssets().filter(function (a) {
      return !!viewState.selectedAssetIds[a.id];
    });
  }

  // Phase 5C: read the JD currently typed/pasted into the form. Used both
  // by the sort-by-JD enable check (button stays disabled when JD empty)
  // and as the input to the embedding rerank call.
  function readCurrentJdText() {
    try {
      const form = document.getElementById("cover-form");
      if (!form) return "";
      const fd = new FormData(form);
      const jd = String(fd.get("jobDescription") || "").trim();
      return jd;
    } catch (e) { return ""; }
  }

  // Phase 5C: simple non-cryptographic hash for "did the JD change since
  // last rerank?" Avoids re-spending embedding budget when the user toggles
  // sort on/off without editing the JD. djb2 is fine — no security need.
  function djb2Hash(s) {
    let h = 5381;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & 0xffffffff; // keep 32-bit
    }
    return String(h);
  }

  // Phase 5C: rerank proof-bank assets by cosine similarity to the current
  // JD. Async — calls jobs-rerank → text-embedding-3-small. Cheap and
  // cached (resume vector is also cached at the embeddings layer, even
  // though here it's the JD acting as the "query").
  async function rerankAssetsByJd() {
    const jd = readCurrentJdText();
    if (!jd) {
      if (window.CBV2.toast) window.CBV2.toast.info("Paste a job description first.");
      return;
    }
    if (!window.CBJobs || typeof window.CBJobs.rankEvidence !== "function") {
      if (window.CBV2.toast) window.CBV2.toast.error("Evidence ranker not loaded.");
      return;
    }
    const assets = getCareerAssets().slice(0, 10);
    if (!assets.length) {
      if (window.CBV2.toast) window.CBV2.toast.info("No proof items to rank — save bullets in Resume Lab first.");
      return;
    }
    const jdHash = djb2Hash(jd);
    // Re-use prior result if JD hasn't changed and we already have scores.
    if (viewState.assetRankSourceJdHash === jdHash && Object.keys(viewState.assetSimilarities).length) {
      viewState.sortAssetsByJd = !viewState.sortAssetsByJd;
      window.CBV2.renderCurrentRoute();
      return;
    }
    viewState.rankAssetsBusy = true;
    window.CBV2.renderCurrentRoute();
    try {
      const result = await window.CBJobs.rankEvidence(jd, assets.map(function (a) {
        // Compose a short text per asset — name + body — for the embedding.
        return { id: a.id, text: ((a.name || "") + ": " + (a.text || "")).trim() };
      }), { topN: assets.length });
      viewState.rankAssetsBusy = false;
      if (!result || !Array.isArray(result.ranked) || !result.ranked.length) {
        viewState.sortAssetsByJd = false;
        if (window.CBV2.toast) {
          window.CBV2.toast.error((result && result.reason) || "Couldn't rank evidence — try again.");
        }
        window.CBV2.renderCurrentRoute();
        return;
      }
      const sims = {};
      result.ranked.forEach(function (r) {
        if (r && r.id != null) sims[r.id] = typeof r.similarity === "number" ? r.similarity : 0;
      });
      viewState.assetSimilarities = sims;
      viewState.assetRankSourceJdHash = jdHash;
      viewState.sortAssetsByJd = true;
      if (window.CBV2.toast) {
        window.CBV2.toast.success("Sorted " + assets.length + " proof items by JD relevance.");
      }
      window.CBV2.renderCurrentRoute();
    } catch (err) {
      viewState.rankAssetsBusy = false;
      if (window.CBV2.toast) {
        window.CBV2.toast.error(err && err.message ? err.message : "Rank failed.");
      }
      window.CBV2.renderCurrentRoute();
    }
  }

  function computeCoverScore(subject, body, ctx) {
    const breakdown = { alignment: 25, evidence: 25, structure: 25, clarity: 25 };
    const issues = [];
    const s = String(subject || "").trim();
    const b = String(body || "").trim();
    const low = b.toLowerCase();
    const paras = b ? b.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean) : [];

    if (!s) { breakdown.alignment -= 6; issues.push("Missing subject line."); }
    if (ctx.role && !low.includes(String(ctx.role).toLowerCase())) { breakdown.alignment -= 8; issues.push("Role is not clearly mentioned in the body."); }
    if (ctx.company && !low.includes(String(ctx.company).toLowerCase())) { breakdown.alignment -= 8; issues.push("Company name is not clearly referenced."); }

    const metricHits = (b.match(/\d+[%kKmM]?|\$\d+/g) || []).length;
    if (!metricHits) { breakdown.evidence -= 12; issues.push("No measurable impact in the letter."); }
    if (metricHits === 1) { breakdown.evidence -= 4; }

    if (paras.length < 3) { breakdown.structure -= 8; issues.push("Letter is too short; aim for intro + evidence + close."); }
    if (!/(dear|hello|hi)\s+/i.test(b)) { breakdown.structure -= 6; issues.push("Opening greeting is missing."); }
    if (!/(thank you|looking forward|sincerely|best regards|kind regards)/i.test(b)) { breakdown.structure -= 6; issues.push("Closing call-to-action/signoff is weak or missing."); }

    if (b.length > 2200) { breakdown.clarity -= 10; issues.push("Letter is too long and may lose recruiter attention."); }
    if (paras.some(function (p) { return p.length > 750; })) { breakdown.clarity -= 8; issues.push("One or more paragraphs are too dense."); }
    if (/\b(i am writing to apply|i believe i am a perfect fit|to whom it may concern)\b/i.test(low)) { breakdown.clarity -= 6; issues.push("Contains generic phrasing; personalize more."); }

    Object.keys(breakdown).forEach(function (k) {
      breakdown[k] = Math.max(0, Math.min(25, Math.round(breakdown[k])));
    });
    const score = breakdown.alignment + breakdown.evidence + breakdown.structure + breakdown.clarity;
    return { score: score, breakdown: breakdown, issues: issues.slice(0, 6) };
  }

  function computeCoverPreflight(subject, body) {
    const blockers = [];
    const issues = [];
    const s = String(subject || "").trim();
    const b = String(body || "").trim();
    const paras = b ? b.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean) : [];

    if (!s) blockers.push("Subject is empty.");
    if (s.length > 140) issues.push("Subject is long; keep it under 100 characters.");
    if (!b) blockers.push("Letter body is empty.");
    if (b.length < 350) issues.push("Letter is very short; add one impact paragraph.");
    if (b.length > 2400) blockers.push("Letter is too long for typical recruiter scan.");
    if (paras.some(function (p) { return p.length > 820; })) issues.push("At least one paragraph is too long.");
    if (!/(thank you|looking forward|sincerely|best regards|kind regards)/i.test(b)) issues.push("Closing signoff is missing.");

    return { ok: blockers.length === 0, blockers: blockers, issues: issues };
  }

  function getPhase4CoverIntel(subject, body, snapshot) {
    const svc = window.CBV2.productIntel;
    if (!svc || typeof svc.coverStudio !== "function") return null;
    const state = getCoverLetterState();
    return svc.coverStudio(state, {
      subject: subject,
      body: body,
      company: snapshot && snapshot.company,
      role: snapshot && snapshot.role
    });
  }

  function renderPhase4CoverBoard(subject, body, snapshot) {
    const intel = getPhase4CoverIntel(subject, body, snapshot);
    if (!intel) return "";
    const st = getSt();
    const checks = (intel.quality.checks || []).slice(0, 6).map(function (c) {
      return '<li class="' + (c.ok ? "ok" : "todo") + '"><i class="fa-solid ' + (c.ok ? "fa-check" : "fa-circle") + '"></i><span>' + st(c.label) + "</span></li>";
    }).join("");
    const variants = (intel.variants || []).slice(0, 3).map(function (v) {
      return '<li><div><strong>' + st(v.label) + '</strong><span>' + st(v.template) + '</span></div><b class="num-font">' + st(String(v.score)) + '</b></li>';
    }).join("");
    const packs = (intel.rolePacks || []).slice(0, 3).map(function (p) {
      return '<li><div><strong>' + st(p.name) + '</strong><span>' + st(p.role || p.tone) + '</span></div><b class="num-font">' + st(String(p.completeness)) + '</b></li>';
    }).join("");
    return `
      <article class="phase4-cover-board">
        <div class="phase4-cover-score">
          <div class="fit-score-ring" style="--fit:${intel.quality.score}"><strong>${intel.quality.score}</strong><small>quality</small></div>
          <div>
            <span class="chip ${intel.quality.score >= 85 ? "green" : intel.quality.score >= 70 ? "warning" : "rose"}">${st(intel.quality.band)}</span>
            <h3>Cover letter decision check</h3>
            <p>Next: ${st(intel.quality.nextAction)}.</p>
          </div>
        </div>
        <div class="phase4-cover-grid">
          <section><h4>Ready checks</h4><ul class="ready-checks phase4-ready-checks">${checks}</ul></section>
          <section><h4>Saved versions</h4>${variants ? '<ul class="phase4-version-mini">' + variants + '</ul>' : '<p class="muted">Save variants to compare stronger versions.</p>'}</section>
          <section><h4>Role packs</h4>${packs ? '<ul class="phase4-version-mini">' + packs + '</ul>' : '<p class="muted">Save a role pack for reusable tone, role, and proof.</p>'}</section>
        </div>
      </article>
    `;
  }

  function renderResult() {
    const st = getSt();
    const draft = getActiveDraft();
    const active = draft.active;
    const subject = draft.subject;
    const body = draft.body;
    const score = computeCoverScore(subject, body, getInputSnapshot());
    const snapshot = getInputSnapshot();
    const preflight = computeCoverPreflight(subject, body);
    const assets = getCareerAssets().slice(0, 6);
    const coverState = getCoverLetterState();
    const variants = (coverState.variants || []).slice(0, 12);
    const sentLog = (coverState.sentLog || []).slice(0, 8);
    const rolePacks = getRolePacks().slice(0, 12);

    if (viewState.busy) {
      return '<p class="ai-meta">Drafting your cover letter with retry + fallback...</p>';
    }
    if (viewState.error) {
      return '<p class="ai-error">' + st(viewState.error) + "</p>";
    }
    if (!active) {
      return '<p class="ai-meta">Fill in the inputs and click Generate to draft a tailored cover letter.</p>';
    }
    const bars = [
      { label: "Role & company alignment", val: score.breakdown.alignment },
      { label: "Evidence strength", val: score.breakdown.evidence },
      { label: "Structure quality", val: score.breakdown.structure },
      { label: "Clarity & readability", val: score.breakdown.clarity }
    ];
    return `
      <p class="ai-meta">Provider: ${st(active.provider)} | Confidence: ${Math.round(active.confidence * 100)}%</p>
      ${renderPhase4CoverBoard(subject, body, snapshot)}
      <article class="export-preflight">
        <div class="export-preflight-head">
          <label>Cover Letter Score</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="chip ${score.score >= 85 ? "green" : score.score >= 70 ? "warning" : "rose"}">${score.score}/100</span>
            <button class="btn-ghost btn-sm" id="cover-toggle-score" type="button">${viewState.scoreDetailsOpen ? "Hide details" : "Why this score?"}</button>
          </div>
        </div>
        ${viewState.scoreDetailsOpen
          ? '<div class="ats-breakdown">' + bars.map(function (b) {
              const pct = Math.round((b.val / 25) * 100);
              return '<div class="ats-breakdown-row"><span>' + st(b.label) + '</span><span class="num-font">' + b.val + '/25</span><div class="ats-breakdown-bar"><i style="width:' + pct + '%"></i></div></div>';
            }).join("") + "</div>"
          : ""}
        ${score.issues.length
          ? '<ul class="export-preflight-list">' + score.issues.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul>"
          : '<p class="muted">Strong letter quality baseline detected.</p>'}
        <div class="ats-quick-fix-row cover-fix-row">
          <button class="btn-ghost btn-sm" type="button" data-cover-fix="improve-opening"><i class="fa-solid fa-wand-magic-sparkles"></i> Improve opening</button>
          <button class="btn-ghost btn-sm" type="button" data-cover-fix="add-metric"><i class="fa-solid fa-hashtag"></i> Add evidence hook</button>
          <button class="btn-ghost btn-sm" type="button" data-cover-fix="tighten"><i class="fa-solid fa-scissors"></i> Tighten wording</button>
          <button class="btn-ghost btn-sm" type="button" data-cover-fix="add-cta"><i class="fa-solid fa-arrow-right"></i> Add stronger close</button>
          <button class="btn-ghost btn-sm" type="button" data-cover-fix="anti-generic"><i class="fa-solid fa-shield-halved"></i> Anti-generic polish</button>
        </div>
      </article>
      <label class="form-row-full">Subject
        <input id="cover-subject" value="${st(subject)}" />
      </label>
      <label class="form-row-full">Body
        <textarea id="cover-body" rows="12">${st(body)}</textarea>
      </label>
      <div class="export-preflight cover-ab-card">
        <div class="export-preflight-head">
          <label>Preflight QA</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="chip ${preflight.ok ? "green" : "warning"}">${preflight.ok ? "Pass" : "Needs attention"}</span>
            <button class="btn-ghost btn-sm" id="cover-autofix" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-fix</button>
          </div>
        </div>
        ${preflight.blockers.length ? '<ul class="export-preflight-list export-preflight-blockers">' + preflight.blockers.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul>" : ""}
        ${preflight.issues.length ? '<ul class="export-preflight-list">' + preflight.issues.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul>" : '<p class="muted">No major blockers before export.</p>'}
      </div>
      ${assets.length
        ? '<div class="export-preflight"><div class="export-preflight-head"><label>Use Vault Evidence in Draft</label></div><div class="ats-quick-fix-row">' +
            assets.map(function (a) {
              return '<button class="btn-ghost btn-sm" type="button" data-cover-asset-insert="' + st(a.id) + '"><i class="fa-solid fa-plus"></i> ' + st((a.name || a.type || "Asset").slice(0, 24)) + '</button>';
            }).join("") +
          '</div></div>'
        : ""}
      <div class="export-preflight">
        <div class="export-preflight-head">
          <label>A/B Variants</label>
          <span class="chip subtle">${variants.length} saved</span>
        </div>
        <div class="ats-quick-fix-row cover-ab-actions">
          <button class="btn-ghost btn-sm" type="button" id="cover-save-variant-a"><i class="fa-solid fa-flask"></i> Save as Variant A</button>
          <button class="btn-ghost btn-sm" type="button" id="cover-save-variant-b"><i class="fa-solid fa-flask"></i> Save as Variant B</button>
        </div>
        ${variants.length
          ? '<label class="form-row-full cover-ab-select">Active Variant<select id="cover-variant-select"><option value="">Live draft</option>' +
            variants.map(function (v) {
              const sel = coverState.activeVariantId === v.id ? "selected" : "";
              return '<option value="' + st(v.id) + '" ' + sel + '>' + st(v.label) + " · " + st((v.template || "template")) + "</option>";
            }).join("") +
            '</select></label><div class="export-preflight-list cover-ab-list">' +
            variants.map(function (v) {
              return '<div class="cover-ab-item"><span>' + st(v.label) + "</span><button class=\"btn-ghost btn-sm\" type=\"button\" data-cover-delete-variant=\"" + st(v.id) + "\"><i class=\"fa-solid fa-trash\"></i></button></div>";
            }).join("") +
            "</div>"
          : '<p class="muted">Save two variants, send both, and track which one converts better.</p>'}
      </div>
      <div class="export-preflight cover-sent-card">
        <div class="export-preflight-head"><label>Sent Tracking</label></div>
        <div class="ats-quick-fix-row cover-sent-actions">
          <select id="cover-sent-channel">
            <option value="portal">Portal</option>
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn</option>
            <option value="referral">Referral</option>
          </select>
          <button class="btn-ghost btn-sm" type="button" id="cover-mark-sent"><i class="fa-solid fa-paper-plane"></i> Mark sent</button>
        </div>
        ${sentLog.length
          ? '<div class="export-preflight-list cover-sent-list">' +
            sentLog.map(function (x) {
              return '<div class="cover-sent-item"><span>' + st((x.company || "Company")) + " · " + st((x.variantLabel || "Variant")) + ' <small class="muted">(' + st(x.channel || "portal") + ')</small></span><select data-cover-sent-status="' + st(x.id) + '">' +
                ["sent", "responded", "interview", "offer", "rejected"].map(function (s) {
                  const sel = x.status === s ? "selected" : "";
                  return '<option value="' + s + '" ' + sel + ">" + s + "</option>";
                }).join("") +
              "</select></div>";
            }).join("") +
            "</div>"
          : '<p class="muted">No sent records yet.</p>'}
      </div>
      <div class="export-preflight cover-rolepack-card">
        <div class="export-preflight-head"><label>Role Packs</label><span class="chip subtle">${rolePacks.length} packs</span></div>
        ${rolePacks.length
          ? '<label class="form-row-full cover-rolepack-select">Apply Role Pack<select id="cover-rolepack-select"><option value="">None</option>' +
            rolePacks.map(function (p) {
              const sel = coverState.activeRolePackId === p.id ? "selected" : "";
              return '<option value="' + st(p.id) + '" ' + sel + '>' + st(p.name) + " · " + st(p.role || "") + "</option>";
            }).join("") + '</select></label>'
          : '<p class="muted">Save your best role-specific setup and reuse it in one click.</p>'}
        <div class="ats-quick-fix-row cover-rolepack-actions">
          <button class="btn-ghost btn-sm" id="cover-save-rolepack" type="button"><i class="fa-solid fa-bookmark"></i> Save current as role pack</button>
          <button class="btn-ghost btn-sm" id="cover-delete-rolepack" type="button"><i class="fa-solid fa-trash"></i> Delete active role pack</button>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-secondary" id="copy-cover" type="button"><i class="fa-solid fa-copy"></i> Copy</button>
        <button class="btn-secondary" id="download-cover-txt" type="button"><i class="fa-solid fa-file-lines"></i> .txt</button>
        <button class="btn-secondary" id="download-cover-html" type="button"><i class="fa-solid fa-code"></i> .html</button>
        <button class="btn-secondary" id="print-cover" type="button"><i class="fa-solid fa-print"></i> Print / PDF</button>
        <button class="btn-primary" id="save-cover" type="button">Save Draft</button>
      </div>
    `;
  }

  function buildCoverHtml(subject, body, templateId) {
    const st = window.CBV2.sanitizeText;
    const resume = (((window.CBV2.store.getAll() || {}).resume || {}).structured || {});
    const header = (resume.header || {});
    const name = header.name || "First Name Last Name";
    const role = header.title || "";
    const email = header.email || "example@email.com";
    const phone = header.phone || "+1 123 456 7890";
    const location = header.location || "City, Country";
    const company = getInputSnapshot().company || "Company";
    const paragraphs = String(body || "")
      .split(/\n{2,}/)
      .map(function (p) { return p.trim(); })
      .filter(Boolean);
    const hasGreeting = paragraphs.length && /^(dear|hello|hi)\s+/i.test(paragraphs[0]);
    const greeting = hasGreeting ? paragraphs[0] : "Dear Hiring Manager,";
    const rest = hasGreeting ? paragraphs.slice(1) : paragraphs;
    const bodyHtml = (rest.length ? rest : ["I am excited to submit my application and contribute value to your team."])
      .map(function (p) { return "<p>" + st(p).replace(/\n/g, "<br/>") + "</p>"; })
      .join("");
    const dateLabel = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const shortDate = new Date().toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
    const baseCss = "body{background:#eceef2;margin:0;padding:14px;} .cl-doc{background:#fff;margin:0 auto;box-shadow:0 1px 0 rgba(0,0,0,.02);} .cl-body p{margin:0 0 10px;} @media print{body{background:#fff;padding:0;margin:0}.cl-doc{margin:0;max-width:none;box-shadow:none;}}";

    if (templateId === "personal-info-right") {
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + st(subject || "Cover Letter") + '</title><style>' + baseCss +
        ".cl-doc{max-width:815px;padding:30px 34px 28px;font:13px/1.62 Arial,sans-serif;color:#1f2937;} .top{display:grid;grid-template-columns:1fr 246px;gap:22px;margin-bottom:8px;} .nm{font-size:42px;color:#163f67;font-weight:700;line-height:1;margin:0;} .rl{margin:2px 0 0;font-size:27px;color:#4d6f8e;font-weight:300;} .info{padding-left:14px;border-left:3px solid #1f4b7a;} .info h4{margin:0 0 8px;color:#1f4b7a;font-size:26px;line-height:1.05;} .info div{font-size:11px;margin:4px 0;} .meta{margin:4px 0 10px;color:#677282;font-size:10.5px;} .g{margin:8px 0 8px;font-weight:400;} .cl-body p{margin:0 0 7px;} .cl-sign{margin-top:8px;font-weight:400;}" +
        "</style></head><body><article class=\"cl-doc\"><header class=\"top\"><div><h1 class=\"nm\">" + st(name) + "</h1><p class=\"rl\">" + st(role || "") + "</p></div><aside class=\"info\"><h4>Personal Info</h4><div><strong>Address</strong><br/>" + st(location) + "</div><div><strong>Phone</strong><br/>" + st(phone) + "</div><div><strong>E-mail</strong><br/>" + st(email) + "</div></aside></header><p class=\"meta\">" + st(location) + ", " + st(shortDate) + "</p><p class=\"g\">" + st(greeting) + "</p><div class=\"cl-body\">" + bodyHtml + "</div><p class=\"cl-sign\">" + st(name) + "</p></article></body></html>";
    }
    if (templateId === "profile-header") {
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + st(subject || "Cover Letter") + '</title><style>' + baseCss +
        ".cl-doc{max-width:860px;padding:18px 28px 24px;font:12.5px/1.58 Arial,sans-serif;color:#111827;} .hdr{display:grid;grid-template-columns:104px 1fr 220px;gap:14px;align-items:center;border-top:2px solid #8b949e;border-bottom:2px solid #8b949e;padding:10px 0;} .ph{width:88px;height:88px;background:#d9dee6;border:1px solid #adb6c6;} .nm{margin:0;font-size:44px;letter-spacing:.14em;color:#263246;line-height:.92;font-weight:700;} .rl{margin:6px 0 0;color:#5f6d80;letter-spacing:.24em;font-size:12px;text-transform:uppercase;} .rt{font-size:10.5px;line-height:1.45;color:#2f3c4f;} .ttl{margin:14px 0 6px;padding-bottom:7px;border-bottom:2px solid #8b949e;font-size:15px;letter-spacing:.2em;font-weight:700;color:#283548;} .to{display:grid;grid-template-columns:1fr auto;margin:8px 0 8px;font-size:10.5px;} .g{margin:8px 0 8px;font-weight:700;} .cl-body p{margin:0 0 7px;} .cl-sign{margin-top:14px;font-family:'Brush Script MT',cursive;font-size:36px;font-weight:400;}" +
        "</style></head><body><article class=\"cl-doc\"><header class=\"hdr\"><div class=\"ph\"></div><div><h1 class=\"nm\">" + st(name).replace(/\s+/g, "<br/>") + "</h1><p class=\"rl\">" + st(role || "SIMPLE") + "</p></div><aside class=\"rt\"><div>" + st(phone) + "</div><div>" + st(email) + "</div><div>" + st(location) + "</div></aside></header><h2 class=\"ttl\">COVER LETTER</h2><div class=\"to\"><div>TO<br/><strong>" + st(company).toUpperCase() + "</strong></div><div>" + st(dateLabel) + "</div></div><p class=\"g\">" + st(greeting) + "</p><div class=\"cl-body\">" + bodyHtml + "</div><p class=\"cl-sign\">" + st(name) + "</p></article></body></html>";
    }
    if (templateId === "serif-editorial") {
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + st(subject || "Cover Letter") + '</title><style>' + baseCss +
        ".cl-doc{max-width:780px;padding:20px 24px 22px;background:#f7f7f6;color:#262626;font:13.5px/1.55 Georgia,'Times New Roman',serif;} .top{display:grid;grid-template-columns:1fr auto;gap:18px;padding-bottom:10px;border-bottom:2px solid #ef6666;} .nm{margin:0;font-size:58px;line-height:.82;color:#e75454;font-style:italic;font-weight:500;} .rt{font-size:10.5px;line-height:1.4;color:#3d4249;text-align:right;} .main{display:grid;grid-template-columns:170px 1fr;gap:20px;padding-top:12px;} .left{font-size:10.5px;color:#23272e;} .left .d{font-weight:700;margin-bottom:12px;} .left .co{font-weight:700;margin-bottom:3px;} .g{font-weight:700;margin:0 0 7px;} .cl-body p{margin:0 0 7px;} .cl-sign{margin-top:10px;font-weight:700;}" +
        "</style></head><body><article class=\"cl-doc\"><header class=\"top\"><h1 class=\"nm\">" + st(name).replace(" ", "<br/>") + "</h1><div class=\"rt\"><div>" + st(location) + "</div><div>" + st(phone) + "</div><div>" + st(email) + "</div></div></header><section class=\"main\"><aside class=\"left\"><div class=\"d\">" + st(dateLabel) + "</div><div class=\"co\">" + st(company) + "</div><div>" + st(location) + "</div></aside><div><p class=\"g\">" + st(greeting) + "</p><div class=\"cl-body\">" + bodyHtml + "</div><p class=\"cl-sign\">" + st(name) + "</p></div></section></article></body></html>";
    }
    if (templateId === "bold-hero") {
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + st(subject || "Cover Letter") + '</title><style>' + baseCss +
        ".cl-doc{max-width:840px;padding:0 0 22px;font:13.5px/1.58 Arial,sans-serif;color:#0f172a;} .top{background:#0e4d84;color:#fff;text-align:center;padding:18px 26px 14px;} .nm{margin:0;font-size:52px;line-height:1;font-weight:800;} .meta{margin-top:7px;font-size:10.5px;font-weight:600;} .body{padding:14px 30px 0;} .date{margin:0 0 8px;} .to{margin:0 0 8px;font-size:11px;} .g{margin:0 0 8px;font-weight:700;} .cl-body p{margin:0 0 7px;} .cl-sign{margin-top:12px;font-family:'Brush Script MT',cursive;font-size:32px;color:#6c7fe0;font-weight:400;}" +
        "</style></head><body><article class=\"cl-doc\"><header class=\"top\"><h1 class=\"nm\">" + st(name) + "</h1><div class=\"meta\">" + st(email) + " | " + st(phone) + " | " + st(location) + "</div></header><section class=\"body\"><p class=\"date\">" + st(dateLabel) + "</p><p class=\"to\"><strong>" + st(company) + "</strong><br/>" + st(location) + "</p><p class=\"g\">" + st(greeting) + "</p><div class=\"cl-body\">" + bodyHtml + "</div><p class=\"cl-sign\">" + st(name) + "</p></section></article></body></html>";
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + st(subject || "Cover Letter") + '</title><style>' + baseCss +
      ".cl-doc{max-width:800px;padding:18px 24px 22px;font:13.5px/1.58 Arial,sans-serif;color:#111827;} .top{background:#60798f;color:#fff;text-align:center;padding:8px 14px;margin-bottom:12px;} .nm{margin:0;font-size:28px;font-style:italic;font-weight:700;} .meta{margin-top:4px;font-size:11px;} .g{font-weight:700;margin:6px 0 8px;} .cl-body p{margin:0 0 8px;} .cl-sign{margin-top:10px;font-weight:700;}" +
      "</style></head><body><article class=\"cl-doc\"><header class=\"top\"><h1 class=\"nm\">" + st("[first name]   [last name]") + "</h1><div class=\"meta\">" + st(email) + " | " + st(phone) + "</div></header><p class=\"g\">" + st(greeting) + "</p><div class=\"cl-body\">" + bodyHtml + "</div><p class=\"cl-sign\">" + st(name) + "</p></article></body></html>";
  }

  function renderView() {
    const st = getSt();
    let assets = getCareerAssets().slice(0, 10);
    const rolePacks = getRolePacks().slice(0, 20);
    const coverState = getCoverLetterState();
    const draft = getActiveDraft();
    const activeRole = getActiveRoleContext();
    const activePosting = roleContextJobText(activeRole);
    // Phase 5C: when sortAssetsByJd is on AND we have similarity scores,
    // reorder the visible proof-bank items (highest cosine first). The
    // selection map keys on id so reorder doesn't break checked state.
    if (viewState.sortAssetsByJd && Object.keys(viewState.assetSimilarities).length) {
      const sims = viewState.assetSimilarities;
      assets = assets.slice().sort(function (a, b) {
        const sa = typeof sims[a.id] === "number" ? sims[a.id] : -1;
        const sb = typeof sims[b.id] === "number" ? sims[b.id] : -1;
        return sb - sa;
      });
    }
    const selectedCount = assets.filter(function (a) { return viewState.selectedAssetIds[a.id]; }).length;
    const rolePackOptions = rolePacks.map(function (p) {
      const sel = coverState.activeRolePackId === p.id ? "selected" : "";
      return '<option value="' + st(p.id) + '" ' + sel + '>' + st(p.name) + "</option>";
    }).join("");
    // Phase 5C: sort-by-JD toggle button. Disabled when no JD is pasted.
    const jdNow = readCurrentJdText();
    const sortToggleLabel = viewState.rankAssetsBusy
      ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Ranking…'
      : viewState.sortAssetsByJd
      ? '<i class="fa-solid fa-wave-square"></i> Sorted by JD relevance'
      : '<i class="fa-solid fa-wave-square"></i> Sort by JD relevance';
    const sortToggleDisabled = (!jdNow || viewState.rankAssetsBusy) ? " disabled" : "";
    const sortToggleHtml = '<button type="button" class="btn-ghost btn-sm cover-proof-sort"' + sortToggleDisabled +
      ' id="cover-assets-sort-by-jd" title="' + (jdNow ? "Re-order proof items by cosine similarity to the pasted JD" : "Paste a JD first to enable") + '">' +
      sortToggleLabel + '</button>';
    const proofBank = assets.length
      ? (
        '<section class="cover-proof-bank">' +
          '<div class="cover-section-head">' +
            '<div><span class="cover-mini-label">Proof Bank</span><h3>Evidence to make the letter credible</h3></div>' +
            '<span class="chip subtle">' + selectedCount + '/' + assets.length + ' selected</span>' +
          '</div>' +
          '<p class="muted">Select achievements, skills, or bullets from your Career Asset Vault. The draft will use them as proof instead of generic claims.</p>' +
          '<div class="cover-proof-list">' +
            assets.map(function (a) {
              const checked = viewState.selectedAssetIds[a.id] ? "checked" : "";
              const sim = typeof viewState.assetSimilarities[a.id] === "number" ? viewState.assetSimilarities[a.id] : null;
              const simBadge = (viewState.sortAssetsByJd && sim != null && sim >= 0.4)
                ? ' <span class="chip cyan cover-proof-sim" title="Cosine similarity to JD">' + Math.round(sim * 100) + '%</span>'
                : "";
              return '<label class="cover-proof-card"><input type="checkbox" data-cover-asset-id="' + st(a.id || "") + '" ' + checked + ' /> <span><strong>' + st(a.name || "Asset") + simBadge + '</strong><small>' + st(a.type || "bullet") + '</small><em>' + st(String(a.text || "").slice(0, 150)) + '</em></span></label>';
            }).join("") +
          '</div>' +
          '<div class="cover-proof-actions">' +
            '<button class="btn-ghost btn-sm" id="cover-assets-apply-strengths" type="button"><i class="fa-solid fa-bolt"></i> Add selected skills</button>' +
            '<button class="btn-ghost btn-sm" id="cover-assets-clear" type="button"><i class="fa-solid fa-xmark"></i> Clear selection</button>' +
            sortToggleHtml +
          '</div>' +
        '</section>'
      )
      : '<section class="cover-proof-bank cover-proof-bank-empty"><div class="cover-section-head"><div><span class="cover-mini-label">Proof Bank</span><h3>No saved evidence yet</h3></div></div><p class="muted">Save bullets and skills in Resume Lab, then use them here to make cover letters more specific.</p></section>';
    return `
      <section class="page-container cover-studio-page">
        <section class="cover-command">
          <div class="cover-command-main">
            <p class="eyebrow">Cover Letter Studio</p>
            <h1 class="page-title">Write a letter that sounds specific, not generic.</h1>
            <p class="page-subtitle">Turn a job post, company context, and your strongest proof into a clean application letter you can review, edit, export, and track.</p>
            <div class="cover-command-actions">
              <button class="btn-secondary" id="clear-cover" type="button"><i class="fa-solid fa-rotate-left"></i> Clear</button>
              <button class="btn-primary" id="gen-cover" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate letter</button>
            </div>
          </div>
          <div class="cover-command-panel">
            <div class="cover-status-card is-accent">
              <span>01</span>
              <strong>Role context</strong>
              <small>Company, posting, and hiring signal</small>
            </div>
            <div class="cover-status-card">
              <span>02</span>
              <strong>Evidence match</strong>
              <small>${assets.length ? selectedCount + " proof items selected" : "Connect your vault"}</small>
            </div>
            <div class="cover-status-card">
              <span>03</span>
              <strong>Final review</strong>
              <small>${draft.active ? "Draft ready for polishing" : "Generate to start QA"}</small>
            </div>
          </div>
        </section>

        <section class="cover-start-grid" aria-label="Cover letter starting points">
          <button class="cover-start-card" type="button" data-cover-start="from-posting">
            <i class="fa-solid fa-file-lines"></i>
            <span>Use a job posting</span>
            <small>Paste requirements and match your proof.</small>
          </button>
          <button class="cover-start-card" type="button" data-cover-start="quick-edit">
            <i class="fa-solid fa-pen-to-square"></i>
            <span>Improve an existing letter</span>
            <small>Generate, then tighten the live draft.</small>
          </button>
          <button class="cover-start-card" type="button" data-cover-start="role-pack">
            <i class="fa-solid fa-layer-group"></i>
            <span>Reuse a role pack</span>
            <small>Apply saved tone, role, and strengths.</small>
          </button>
        </section>

        <section class="cover-workspace">
          <article class="cover-input-card">
            <div class="cover-section-head">
              <div>
                <span class="cover-mini-label">Application brief</span>
                <h2>Build the context before writing</h2>
              </div>
              <span class="chip cyan">Guided</span>
            </div>
            ${renderActiveRoleContextBanner(activeRole)}
            <form id="cover-form" class="form-grid cover-form-grid">
              <div class="cover-core-grid">
                <label>Company<input name="company" required placeholder="Orbit Works" value="${st(activeRole && activeRole.company || "")}" /></label>
                <label>Role<input name="role" required placeholder="Frontend Engineer" value="${st(activeRole && activeRole.role || "")}" /></label>
                <label class="form-row-full">Job posting or requirements
                  <textarea name="jobDescription" rows="5" placeholder="Paste the job post, responsibilities, skills, tools, and any must-have requirements...">${st(activePosting)}</textarea>
                </label>
                <label class="form-row-full">Why this company?
                  <textarea name="why" rows="3" placeholder="What excites you about the team, product, mission, or problem space?"></textarea>
                </label>
                <label class="form-row-full">Key strengths
                  <input name="strengths" placeholder="React, stakeholder communication, analytics, operations, customer impact" />
                </label>
              </div>

              <details class="cover-advanced form-row-full" open>
                <summary><span>Writing controls and personalization</span><i class="fa-solid fa-chevron-down"></i></summary>
                <div class="cover-advanced-grid">
                  <label>Tone
                    <select name="tone">
                      <option value="professional">Professional</option>
                      <option value="confident">Confident</option>
                      <option value="friendly">Friendly</option>
                      <option value="concise">Concise</option>
                    </select>
                  </label>
                  <label>Length
                    <select name="length">
                      <option value="short">Short</option>
                      <option value="medium" selected>Medium</option>
                      <option value="long">Long</option>
                    </select>
                  </label>
                  <label>Template
                    <select name="template" id="cover-template">
                      ${COVER_TEMPLATES.map(function (t) {
                        const selected = t.id === viewState.coverTemplate ? "selected" : "";
                        return '<option value="' + st(t.id) + '" ' + selected + ">" + st(t.name) + "</option>";
                      }).join("")}
                    </select>
                  </label>
                  <label>Hiring manager
                    <input name="manager" placeholder="e.g. Ms. Dlamini" />
                  </label>
                  <label class="form-row-full">Role Pack
                    <select name="rolePack" id="cover-rolepack-input">
                      <option value="">None</option>
                      ${rolePackOptions}
                    </select>
                  </label>
                  <label class="form-row-full">Company mission or recent context
                    <textarea name="mission" rows="2" placeholder="Paste mission, product context, values, team focus, or a recent update..."></textarea>
                  </label>
                  <label class="form-row-full">Role-specific value hook
                    <textarea name="context" rows="2" placeholder="What challenge can you solve for this role? What should they remember about you?"></textarea>
                  </label>
                </div>
              </details>

              <div class="form-row-full cover-input-ideas-card">
                <div class="cover-section-head">
                  <div>
                    <span class="cover-mini-label">AI Input Helper</span>
                    <h3>Need sharper wording?</h3>
                  </div>
                  <button class="btn-ghost btn-sm" id="cover-generate-input-ideas" type="button"><i class="fa-solid fa-lightbulb"></i> Suggest ideas</button>
                </div>
                <label class="form-row-full">Suggestion style
                  <select id="cover-ideas-style">
                    <option value="professional">Professional</option>
                    <option value="bold">Bold</option>
                    <option value="executive">Executive</option>
                  </select>
                </label>
                <p class="muted">Generate options for strengths, motivation, company context, and role value. Click any option to apply it.</p>
                <div id="cover-input-ideas" class="cover-input-ideas-empty">No suggestions yet.</div>
              </div>

              <div class="form-row-full">${proofBank}</div>
            </form>
          </article>

          <article class="cover-draft-card">
            <div class="cover-section-head">
              <div>
                <span class="cover-mini-label">Draft workspace</span>
                <h2>Review, improve, export, and track</h2>
              </div>
              <span class="chip ${draft.active ? "green" : "subtle"}">${draft.active ? "Draft ready" : "Waiting"}</span>
            </div>
            <div class="cover-draft-tabs" aria-label="Cover letter workflow">
              <span class="is-active"><i class="fa-solid fa-pen-nib"></i> Draft</span>
              <span><i class="fa-solid fa-list-check"></i> Review</span>
              <span><i class="fa-solid fa-flask"></i> Variants</span>
              <span><i class="fa-solid fa-paper-plane"></i> Send</span>
            </div>
            <div id="cover-output" class="form-grid cover-output-shell">${renderResult()}</div>
          </article>
        </section>
      </section>
    `;
  }

  async function generate(opts) {
    opts = opts || {};
    const form = document.getElementById("cover-form");
    if (!form) {
      return;
    }
    const fd = new FormData(form);
    const selected = selectedAssets();
    const selectedStrengths = selected
      .filter(function (a) { return String(a.type || "").toLowerCase() === "skill"; })
      .map(function (a) { return String(a.text || "").trim(); })
      .filter(Boolean);
    const selectedEvidence = selected
      .filter(function (a) { return String(a.type || "").toLowerCase() !== "skill"; })
      .map(function (a) { return String(a.text || "").trim(); })
      .filter(Boolean);
    const rolePackId = String(fd.get("rolePack") || "");
    const rolePack = getRolePacks().find(function (p) { return p.id === rolePackId; }) || null;
    const company = String(fd.get("company") || "").trim();
    const role = String(fd.get("role") || rolePack && rolePack.role || "").trim();
    const tone = String(fd.get("tone") || rolePack && rolePack.tone || "professional");
    const length = String(fd.get("length") || rolePack && rolePack.length || "medium");
    const strengthsText = String(fd.get("strengths") || rolePack && rolePack.strengths || "");
    const whyText = String(fd.get("why") || "").trim();
    const manager = String(fd.get("manager") || "").trim();
    const mission = String(fd.get("mission") || "").trim();
    const context = String(fd.get("context") || "").trim();
    const jobDescription = String(fd.get("jobDescription") || "").trim();
    const whyCombined = [
      whyText,
      manager ? ("Manager focus: " + manager) : "",
      mission ? ("Company context: " + mission) : "",
      context ? ("Role value hook: " + context) : "",
      jobDescription ? ("Job posting context: " + jobDescription.slice(0, 1800)) : ""
    ].filter(Boolean).join(" | ");
    const range = lengthRange(length);
    const currentDraft = getActiveDraft();
    const input = {
      company: company,
      role: role,
      tone: tone,
      length: length,
      template: String(fd.get("template") || viewState.coverTemplate || "professional-clean"),
      strengths: strengthsText
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean)
        .concat(selectedStrengths)
        .filter(function (v, i, arr) { return arr.indexOf(v) === i; }),
      why: whyCombined,
      jobDescription: jobDescription.slice(0, 6000),
      jobPosting: jobDescription.slice(0, 6000),
      evidenceAssets: selectedEvidence,
      candidate: ((window.CBV2.store.getAll().resume || {}).base || "").slice(0, 4000),
      desiredWordRange: range.min + "-" + range.max,
      rewriteInstruction: opts.forceRewrite
        ? "Rewrite the entire cover letter from scratch to strictly match the requested length band."
        : "Write a full cover letter aligned to requested length.",
      previousDraft: (opts.forceRewrite && currentDraft && currentDraft.body) ? String(currentDraft.body).slice(0, 3500) : ""
    };
    viewState.coverTemplate = input.template;
    if (!input.company || !input.role) {
      viewState.error = "Company and role are required.";
      document.getElementById("cover-output").innerHTML = '<p class="ai-error">' + viewState.error + "</p>";
      return;
    }

    viewState.busy = true;
    viewState.error = "";
    viewState.result = null;
    document.getElementById("cover-output").innerHTML = renderResult();

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }
      // Phase 2: chain jd-analyze → cover-letter-generate when a JD is provided.
      // The structured analysis (requiredSkills, keywords, responsibilities) gets
      // injected as `jdAnalyzed` so the cover-letter prompt can echo the JD's
      // exact priority terms instead of inferring from raw text. The
      // server-side response cache makes the jd-analyze call free on repeats.
      if (jobDescription && jobDescription.trim().length > 80) {
        try {
          const analysis = await ai.runSkill("jd-analyze", { jd: jobDescription.slice(0, 6000) });
          if (analysis && analysis.data) {
            input.jdAnalyzed = analysis.data;
          }
        } catch (e) {
          // Non-fatal — proceed without structured JD analysis.
        }
      }
      const result = await ai.runSkill("cover-letter-generate", input);
      if (result && result.data && typeof result.data.body === "string") {
        result.data.body = normalizeDraftLength(result.data.subject, result.data.body, input);
      }
      viewState.result = result;
      window.CBV2.store.setCoverLetterResult(result);
    } catch (error) {
      viewState.error = error && error.message ? error.message : "AI action failed";
    } finally {
      viewState.busy = false;
      document.getElementById("cover-output").innerHTML = renderResult();
      bindOutputControls();
    }
  }

  function bindOutputControls() {
    const copyBtn = document.getElementById("copy-cover");
    const saveBtn = document.getElementById("save-cover");
    const txtBtn = document.getElementById("download-cover-txt");
    const htmlBtn = document.getElementById("download-cover-html");
    const printBtn = document.getElementById("print-cover");
    const saveVarA = document.getElementById("cover-save-variant-a");
    const saveVarB = document.getElementById("cover-save-variant-b");
    const variantSelect = document.getElementById("cover-variant-select");
    const markSentBtn = document.getElementById("cover-mark-sent");
    const saveRolePackBtn = document.getElementById("cover-save-rolepack");
    const delRolePackBtn = document.getElementById("cover-delete-rolepack");
    const rolePackSelectOutput = document.getElementById("cover-rolepack-select");

    function readFields() {
      const d = getActiveDraft();
      const subject = document.getElementById("cover-subject");
      const body = document.getElementById("cover-body");
      return {
        subject: subject ? subject.value : d.subject,
        body: body ? body.value : d.body
      };
    }

    function persistFields(f) {
      const active = getActiveDraft().active;
      if (!active) return;
      active.data = active.data || {};
      active.data.subject = f.subject;
      active.data.body = f.body;
      viewState.result = active;
      window.CBV2.store.setCoverLetterResult(active);
      const c = getCoverLetterState();
      if (c.activeVariantId && typeof window.CBV2.store.saveCoverLetterVariant === "function") {
        const existing = (c.variants || []).find(function (v) { return v.id === c.activeVariantId; });
        if (existing) {
          window.CBV2.store.saveCoverLetterVariant({
            id: existing.id,
            label: existing.label,
            subject: f.subject,
            body: f.body,
            template: viewState.coverTemplate,
            tone: getInputSnapshot().tone || "professional",
            createdAt: existing.createdAt
          });
        }
      }
    }

    function rerenderOutput() {
      const out = document.getElementById("cover-output");
      if (!out) return;
      out.innerHTML = renderResult();
      bindOutputControls();
    }

    function bindAssetInsertActions() {
      document.querySelectorAll("[data-cover-asset-insert]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const id = btn.getAttribute("data-cover-asset-insert");
          const asset = getCareerAssets().find(function (a) { return a.id === id; });
          if (!asset) return;
          const f = readFields();
          const t = String(asset.text || "").trim();
          if (!t) return;
          if (f.body.toLowerCase().indexOf(t.toLowerCase()) !== -1) {
            toastInfo("Asset already present in draft.");
            return;
          }
          f.body = f.body.replace(/\n+$/g, "") + "\n\n- " + t;
          persistFields(f);
          rerenderOutput();
          toastInfo("Inserted asset into draft.");
        });
      });
    }

    function applyQuickFix(kind) {
      const f = readFields();
      const ctx = getInputSnapshot();
      let subject = String(f.subject || "").trim();
      let body = String(f.body || "").trim();
      if (!body) return;
      if (kind === "improve-opening") {
        const greet = /^dear\s+/i.test(body) ? "" : "Dear Hiring Team,\n\n";
        const first = "I am excited to apply for the " + (ctx.role || "role") + " position at " + (ctx.company || "your company") + ".";
        body = body.replace(/^((dear|hello|hi)[\s\S]*?\n\n)?/i, "");
        body = greet + first + "\n\n" + body;
      } else if (kind === "add-metric") {
        if (!/\d/.test(body)) {
          const hook = window.prompt("Metric placeholder to add (e.g. 22% increase, 3x faster, $40k saved):", "22% increase");
          if (hook && hook.trim()) {
            body = body.replace(/\n\n/, " I have delivered measurable outcomes such as " + hook.trim() + ".\n\n");
          }
        }
      } else if (kind === "tighten") {
        const paras = body.split(/\n{2,}/).map(function (p) { return p.replace(/\s+/g, " ").trim(); }).filter(Boolean);
        body = paras.map(function (p) { return p.length > 700 ? p.slice(0, 700).replace(/[,:;\- ]+$/g, "") + "." : p; }).join("\n\n");
      } else if (kind === "add-cta") {
        if (!/(thank you|looking forward|sincerely|best regards|kind regards)/i.test(body)) {
          body += "\n\nThank you for your consideration. I would welcome the opportunity to discuss how I can contribute to your team.\n\nBest regards,\n" + ((((window.CBV2.store.getAll().resume || {}).structured || {}).header || {}).name || "Your Name");
        }
      } else if (kind === "anti-generic") {
        const companyName = ctx.company || "your company";
        const roleName = ctx.role || "the role";
        body = body
          .replace(/\bi am writing to apply for\b/ig, "I am excited to contribute as")
          .replace(/\bi believe i am (a )?perfect fit\b/ig, "I bring practical evidence aligned to")
          .replace(/\bto whom it may concern\b/ig, "Dear Hiring Team")
          .replace(/\bteam player\b/ig, "cross-functional partner")
          .replace(/\bhardworking\b/ig, "execution-focused")
          .replace(/\bdetail-oriented\b/ig, "quality-focused");
        if (body.toLowerCase().indexOf(companyName.toLowerCase()) === -1) {
          body = body.replace(/\n\n/, " I am especially interested in the work happening at " + companyName + ".\n\n");
        }
        if (body.toLowerCase().indexOf(roleName.toLowerCase()) === -1) {
          body = "I am applying for " + roleName + " with a focus on measurable outcomes.\n\n" + body;
        }
      } else if (kind === "autofix") {
        if (!subject) subject = "Application - " + (ctx.role || "Role") + " at " + (ctx.company || "Company");
        if (!/^dear\s+/i.test(body)) body = "Dear Hiring Team,\n\n" + body;
        if (!/\d/.test(body)) body = body.replace(/\n\n/, " I have delivered measurable outcomes (e.g., 20%+ improvements) in prior roles.\n\n");
        if (!/(thank you|looking forward|sincerely|best regards|kind regards)/i.test(body)) body += "\n\nThank you for your consideration.\n\nBest regards,\n" + ((((window.CBV2.store.getAll().resume || {}).structured || {}).header || {}).name || "Your Name");
      }
      persistFields({ subject: subject, body: body });
      rerenderOutput();
    }

    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        const f = readFields();
        const text = "Subject: " + f.subject + "\n\n" + f.body;
        navigator.clipboard.writeText(text).catch(function () {});
        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
        setTimeout(function () {
          copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy';
        }, 1200);
      });
    }
    if (txtBtn) {
      txtBtn.addEventListener("click", function () {
        const f = readFields();
        window.CBV2.downloadText("cover-letter.txt", "Subject: " + f.subject + "\nTemplate: " + viewState.coverTemplate + "\n\n" + f.body);
      });
    }
    if (htmlBtn) {
      htmlBtn.addEventListener("click", function () {
        const f = readFields();
        const html = buildCoverHtml(f.subject, f.body, viewState.coverTemplate);
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "cover-letter-" + viewState.coverTemplate + ".html";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
    }
    if (printBtn) {
      printBtn.addEventListener("click", async function () {
        const f = readFields();
        const pf = computeCoverPreflight(f.subject, f.body);
        if (pf.blockers.length) {
          // Phase 4.5: in-app modal replaces native confirm. Preflight
          // blockers render as a bulleted body rather than a "\n-" hack.
          const modal = window.CBV2 && window.CBV2.modal;
          const blockerList = pf.blockers.map(function (b) { return "• " + b; }).join("\n");
          const proceed = modal && modal.confirm
            ? await modal.confirm({
                title: "Preflight warnings",
                body: blockerList + "\n\nContinue export anyway?",
                confirmLabel: "Export anyway",
                tone: "danger",
              })
            : window.confirm("Preflight warning:\n- " + pf.blockers.join("\n- ") + "\n\nContinue export anyway?");
          if (!proceed) return;
        }
        const html = buildCoverHtml(f.subject, f.body, viewState.coverTemplate).replace(
          "</body>",
          '<script>window.onload=function(){setTimeout(function(){window.print();},280);};<\/script></body>'
        );
        const win = window.open("", "_blank", "width=900,height=1120");
        if (!win) return;
        win.document.open();
        win.document.write(html);
        win.document.close();
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        const subject = document.getElementById("cover-subject");
        const body = document.getElementById("cover-body");
        if (!viewState.result || !subject || !body) return;
        viewState.result.data.subject = subject.value;
        viewState.result.data.body = body.value;
        window.CBV2.store.setCoverLetterResult(viewState.result);
        saveBtn.innerHTML = "Saved";
        setTimeout(function () {
          saveBtn.innerHTML = "Save Draft";
        }, 1200);
      });
    }
    if (saveVarA) {
      saveVarA.addEventListener("click", function () {
        const f = readFields();
        if (!f.body.trim()) return;
        if (typeof window.CBV2.store.saveCoverLetterVariant === "function") {
          const saved = window.CBV2.store.saveCoverLetterVariant({
            label: "Variant A",
            subject: f.subject,
            body: f.body,
            template: viewState.coverTemplate,
            tone: getInputSnapshot().tone || "professional"
          });
          if (saved && typeof window.CBV2.store.setActiveCoverLetterVariant === "function") {
            window.CBV2.store.setActiveCoverLetterVariant(saved.id);
          }
          rerenderOutput();
          toastInfo("Saved Variant A.");
        }
      });
    }
    if (saveVarB) {
      saveVarB.addEventListener("click", function () {
        const f = readFields();
        if (!f.body.trim()) return;
        if (typeof window.CBV2.store.saveCoverLetterVariant === "function") {
          const saved = window.CBV2.store.saveCoverLetterVariant({
            label: "Variant B",
            subject: f.subject,
            body: f.body,
            template: viewState.coverTemplate,
            tone: getInputSnapshot().tone || "professional"
          });
          if (saved && typeof window.CBV2.store.setActiveCoverLetterVariant === "function") {
            window.CBV2.store.setActiveCoverLetterVariant(saved.id);
          }
          rerenderOutput();
          toastInfo("Saved Variant B.");
        }
      });
    }
    if (variantSelect) {
      variantSelect.addEventListener("change", function () {
        const id = variantSelect.value || "";
        if (typeof window.CBV2.store.setActiveCoverLetterVariant === "function") {
          window.CBV2.store.setActiveCoverLetterVariant(id);
        }
        const v = (getCoverLetterState().variants || []).find(function (x) { return x.id === id; });
        if (v) {
          viewState.coverTemplate = v.template || viewState.coverTemplate;
          const sub = document.getElementById("cover-subject");
          const body = document.getElementById("cover-body");
          if (sub) sub.value = v.subject || "";
          if (body) body.value = v.body || "";
          persistFields({ subject: v.subject || "", body: v.body || "" });
        }
        rerenderOutput();
      });
    }
    document.querySelectorAll("[data-cover-delete-variant]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-cover-delete-variant");
        if (!id || typeof window.CBV2.store.deleteCoverLetterVariant !== "function") return;
        window.CBV2.store.deleteCoverLetterVariant(id);
        rerenderOutput();
      });
    });
    if (markSentBtn) {
      markSentBtn.addEventListener("click", function () {
        const f = readFields();
        if (!f.body.trim() || typeof window.CBV2.store.logCoverLetterSent !== "function") return;
        const variant = getActiveVariant();
        const snap = getInputSnapshot();
        const channelSel = document.getElementById("cover-sent-channel");
        window.CBV2.store.logCoverLetterSent({
          variantId: (variant && variant.id) || "",
          variantLabel: (variant && variant.label) || "Live draft",
          company: snap.company || "Unknown company",
          role: snap.role || "",
          channel: (channelSel && channelSel.value) || "portal",
          status: "sent"
        });
        rerenderOutput();
        toastInfo("Logged as sent.");
      });
    }
    document.querySelectorAll("[data-cover-sent-status]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        const id = sel.getAttribute("data-cover-sent-status");
        if (!id || typeof window.CBV2.store.updateCoverLetterSentStatus !== "function") return;
        window.CBV2.store.updateCoverLetterSentStatus(id, sel.value || "sent");
      });
    });
    if (saveRolePackBtn) {
      saveRolePackBtn.addEventListener("click", function () {
        if (typeof window.CBV2.store.saveCoverLetterRolePack !== "function") return;
        const snap = getInputSnapshot();
        const strengthsInput = document.querySelector('#cover-form input[name="strengths"]');
        const name = window.prompt("Role pack name:", (snap.role || "Role") + " Pack");
        if (!name) return;
        const saved = window.CBV2.store.saveCoverLetterRolePack({
          name: name,
          role: snap.role,
          tone: snap.tone || "professional",
          length: snap.length || "medium",
          strengths: strengthsInput ? strengthsInput.value : ""
        });
        if (saved && typeof window.CBV2.store.setActiveCoverLetterRolePack === "function") {
          window.CBV2.store.setActiveCoverLetterRolePack(saved.id);
        }
        rerenderOutput();
        toastInfo("Role pack saved.");
      });
    }
    if (delRolePackBtn) {
      delRolePackBtn.addEventListener("click", function () {
        const c = getCoverLetterState();
        if (!c.activeRolePackId || typeof window.CBV2.store.deleteCoverLetterRolePack !== "function") return;
        window.CBV2.store.deleteCoverLetterRolePack(c.activeRolePackId);
        rerenderOutput();
        toastInfo("Role pack deleted.");
      });
    }
    if (rolePackSelectOutput) {
      rolePackSelectOutput.addEventListener("change", function () {
        const id = rolePackSelectOutput.value || "";
        if (typeof window.CBV2.store.setActiveCoverLetterRolePack === "function") {
          window.CBV2.store.setActiveCoverLetterRolePack(id);
        }
      });
    }

    const toggleScore = document.getElementById("cover-toggle-score");
    if (toggleScore) {
      toggleScore.addEventListener("click", function () {
        viewState.scoreDetailsOpen = !viewState.scoreDetailsOpen;
        const out = document.getElementById("cover-output");
        if (out) {
          out.innerHTML = renderResult();
          bindOutputControls();
        }
      });
    }
    const autoFix = document.getElementById("cover-autofix");
    if (autoFix) autoFix.addEventListener("click", function () { applyQuickFix("autofix"); });
    document.querySelectorAll("[data-cover-fix]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        applyQuickFix(btn.getAttribute("data-cover-fix"));
      });
    });
    bindAssetInsertActions();
  }

  function toastInfo(msg) {
    const t = window.CBV2 && window.CBV2.toast;
    if (!t) return;
    if (typeof t.info === "function") t.info(msg);
    else if (typeof t.show === "function") t.show(msg, "info");
  }

  function applyActiveRoleToForm() {
    const ctx = getActiveRoleContext();
    const form = document.getElementById("cover-form");
    if (!ctx || !form) return false;
    const company = form.querySelector('input[name="company"]');
    const role = form.querySelector('input[name="role"]');
    const posting = form.querySelector('textarea[name="jobDescription"]');
    if (company) company.value = ctx.company || "";
    if (role) role.value = ctx.role || "";
    if (posting) posting.value = roleContextJobText(ctx);
    return true;
  }

  function bindRoleContextControls() {
    const use = document.getElementById("cover-use-active-role");
    if (use) {
      use.addEventListener("click", function () {
        if (applyActiveRoleToForm()) toastInfo("Loaded active role context.");
      });
    }
    const clear = document.getElementById("cover-clear-active-role");
    if (clear) {
      clear.addEventListener("click", function () {
        const svc = window.CBV2.roleContext;
        if (svc && typeof svc.clear === "function") svc.clear();
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  function bindCoverStartCards() {
    document.querySelectorAll("[data-cover-start]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const mode = btn.getAttribute("data-cover-start") || "";
        const form = document.getElementById("cover-form");
        if (!form) return;
        if (mode === "from-posting") {
          const field = form.querySelector('textarea[name="jobDescription"]');
          if (field) field.focus();
          toastInfo("Paste the job posting, then add company and role.");
          return;
        }
        if (mode === "quick-edit") {
          const body = document.getElementById("cover-body");
          if (body) body.focus();
          else {
            const why = form.querySelector('textarea[name="why"]');
            if (why) why.focus();
          }
          toastInfo("Add your current angle, generate, then use Review controls to tighten it.");
          return;
        }
        if (mode === "role-pack") {
          const pack = document.getElementById("cover-rolepack-input");
          if (pack) pack.focus();
          toastInfo("Choose a role pack or create one after generating a strong draft.");
        }
      });
    });
  }

  function bindAssetPicker() {
    document.querySelectorAll("[data-cover-asset-id]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        const id = cb.getAttribute("data-cover-asset-id");
        if (!id) return;
        viewState.selectedAssetIds[id] = !!cb.checked;
      });
    });
    const applyStrengths = document.getElementById("cover-assets-apply-strengths");
    if (applyStrengths) {
      applyStrengths.addEventListener("click", function () {
        const form = document.getElementById("cover-form");
        if (!form) return;
        const strengthsInput = form.querySelector('input[name="strengths"]');
        if (!strengthsInput) return;
        const picked = selectedAssets().filter(function (a) { return String(a.type || "").toLowerCase() === "skill"; });
        if (!picked.length) {
          toastInfo("Select at least one skill asset first.");
          return;
        }
        const existing = String(strengthsInput.value || "")
          .split(",")
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
        picked.forEach(function (a) { existing.push(String(a.text || "").trim()); });
        const unique = existing.filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
        strengthsInput.value = unique.join(", ");
        toastInfo("Added selected skill assets to Strengths.");
      });
    }
    const clearAssets = document.getElementById("cover-assets-clear");
    if (clearAssets) {
      clearAssets.addEventListener("click", function () {
        viewState.selectedAssetIds = {};
        document.querySelectorAll("[data-cover-asset-id]").forEach(function (cb) { cb.checked = false; });
      });
    }
    // Phase 5C: Sort by JD relevance.
    const sortByJdBtn = document.getElementById("cover-assets-sort-by-jd");
    if (sortByJdBtn) {
      sortByJdBtn.addEventListener("click", function () {
        rerankAssetsByJd();
      });
    }
    const templateSel = document.getElementById("cover-template");
    if (templateSel) {
      templateSel.addEventListener("change", function () {
        viewState.coverTemplate = templateSel.value || "professional-clean";
      });
    }
    const rolePackInputSel = document.getElementById("cover-rolepack-input");
    if (rolePackInputSel) {
      rolePackInputSel.addEventListener("change", function () {
        const id = rolePackInputSel.value || "";
        if (typeof window.CBV2.store.setActiveCoverLetterRolePack === "function") {
          window.CBV2.store.setActiveCoverLetterRolePack(id);
        }
        const pack = getRolePacks().find(function (p) { return p.id === id; });
        const form = document.getElementById("cover-form");
        if (!pack || !form) return;
        const role = form.querySelector('input[name="role"]');
        const tone = form.querySelector('select[name="tone"]');
        const length = form.querySelector('select[name="length"]');
        const strengths = form.querySelector('input[name="strengths"]');
        if (role && !role.value) role.value = pack.role || "";
        if (tone && !tone.value) tone.value = pack.tone || "professional";
        if (length && !length.value) length.value = pack.length || "medium";
        if (strengths && !strengths.value) strengths.value = pack.strengths || "";
      });
    }

    function renderInputIdeas(ideas) {
      const root = document.getElementById("cover-input-ideas");
      if (!root) return;
      function chips(section, targetName, mode) {
        const list = ideas[section] || [];
        if (!list.length) return "";
        return (
          '<div class="cover-idea-block">' +
            '<div class="cover-idea-title">' + section + "</div>" +
            '<div class="cover-idea-options">' +
              list.map(function (text) {
                return '<button type="button" class="btn-ghost btn-sm cover-idea-chip" data-cover-idea-target="' + targetName + '" data-cover-idea-mode="' + (mode || "replace") + '" data-cover-idea-text="' + getSt()(text) + '">' + getSt()(text) + "</button>";
              }).join("") +
            "</div>" +
          "</div>"
        );
      }
      root.innerHTML =
        chips("strengths", "strengths", "replace") +
        chips("why", "why", "replace") +
        chips("mission", "mission", "replace") +
        chips("context", "context", "replace") +
        chips("evidence", "context", "append");
      root.querySelectorAll("[data-cover-idea-target]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const target = btn.getAttribute("data-cover-idea-target");
          const mode = btn.getAttribute("data-cover-idea-mode") || "replace";
          const text = btn.getAttribute("data-cover-idea-text") || "";
          const form = document.getElementById("cover-form");
          if (!form || !target) return;
          const field = form.querySelector('[name="' + target + '"]');
          if (!field) return;
          if (mode === "append" && field.value) field.value = String(field.value).replace(/\s+$/g, "") + " " + text;
          else field.value = text;
          toastInfo("Applied suggestion.");
        });
      });
    }

    const ideaBtn = document.getElementById("cover-generate-input-ideas");
    const ideasStyle = document.getElementById("cover-ideas-style");
    if (ideaBtn) {
      ideaBtn.addEventListener("click", function () {
        const style = ideasStyle ? ideasStyle.value : "professional";
        const ideas = buildInputIdeas(getInputSnapshot(), style);
        renderInputIdeas(ideas);
      });
    }
  }

  function clearAll() {
    const form = document.getElementById("cover-form");
    if (form) form.reset();
    viewState.result = null;
    viewState.error = "";
    viewState.selectedAssetIds = {};
    viewState.coverTemplate = "professional-clean";
    window.CBV2.store.setCoverLetterResult(null);
    document.getElementById("cover-output").innerHTML = renderResult();
  }

  window.CBV2.routes["cover-letter"] = renderView;
  window.CBV2.afterRender["cover-letter"] = function () {
    const gen = document.getElementById("gen-cover");
    const clear = document.getElementById("clear-cover");
    const form = document.getElementById("cover-form");
    if (gen) {
      gen.addEventListener("click", function () {
        if (!viewState.busy) {
          generate();
        }
      });
    }
    if (clear) {
      clear.addEventListener("click", clearAll);
    }
    if (form) {
      const lenSel = form.querySelector('select[name="length"]');
      if (lenSel) {
        lenSel.addEventListener("change", function () {
          const hasDraft = !!getActiveDraft().active;
          if (!hasDraft || viewState.busy) return;
          generate({ forceRewrite: true, trigger: "length-change" });
          toastInfo("Regenerating draft for selected length...");
        });
      }
    }
    bindAssetPicker();
    bindCoverStartCards();
    bindRoleContextControls();
    bindOutputControls();
  };
})();
