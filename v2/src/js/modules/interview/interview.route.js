(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const MOCK_MAX_INTERVIEWER_TURNS = 13;

  const viewState = {
    prepMode: "drill",
    busy: false,
    error: "",
    questions: null,
    feedback: null,
    activeIndex: 0,
    answers: {},
    score: null,
    scoring: false,
    mockTranscript: [],
    mockInterviewerTurns: 0,
    mockBusy: false,
    mockError: "",
    mockSessionClosed: false,
    mockEarlyEnd: false,
    mockMeta: {
      company: "",
      role: "",
      stage: "first",
      focus: "",
      jd: "",
      useResume: true,
      // Phase 4.5: which interviewer persona to play. Defaults to
      // technical_lead — the most generally useful for practice. The
      // selector lives in the mock setup form.
      persona: "technical_lead"
    },
    mockDebrief: null,
    mockDebriefBusy: false,
    intelBusy: false,
    intelError: "",
    intelForm: {
      company: "",
      role: "",
      stage: "first"
    },
    intelHits: [],
    intelQueries: [],
    intelWarnings: [],
    intelPackEnvelope: null,
    intelIncludeInMock: true,
    activeRoleContextKey: "",
    // Phase 4.5 voice mode:
    //   voiceMode      — user toggled "Voice" in the toolbar.
    //   voiceListening — recognition is currently active (mic open).
    //   voiceInterim   — partial transcript shown while user speaks.
    //   voiceSpeaking  — synthesis is actively reading an AI reply.
    //   voiceError     — last STT/TTS error message; cleared on next try.
    voiceMode: false,
    voiceListening: false,
    voiceInterim: "",
    voiceSpeaking: false,
    voiceError: ""
  };

  function getSt() {
    return window.CBV2.sanitizeText;
  }

  /** Restore from disk only when there is nothing in-memory (avoids clobber during async renders). */
  function hydrateMockIfEmpty() {
    if (viewState.mockTranscript.length || viewState.mockBusy || viewState.mockDebriefBusy) {
      return;
    }
    const store = window.CBV2.store;
    if (!store || typeof store.getInterviewMockSession !== "function") {
      return;
    }
    const s = store.getInterviewMockSession();
    if (!s || s.version !== 1 || !Array.isArray(s.transcript)) {
      if (s && s.version === 1 && s.debrief) {
        viewState.mockMeta = Object.assign({}, viewState.mockMeta, s.meta || {});
        viewState.mockSessionClosed = !!s.sessionClosed;
        viewState.mockDebrief = s.debrief || null;
        viewState.mockEarlyEnd = !!s.earlyEnd;
        viewState.prepMode = "mock";
      }
      return;
    }
    if (!s.transcript.length && !s.debrief) {
      return;
    }
    viewState.mockTranscript = s.transcript;
    viewState.mockInterviewerTurns = typeof s.interviewerTurns === "number" ? s.interviewerTurns : 0;
    viewState.mockMeta = Object.assign({}, viewState.mockMeta, s.meta || {});
    viewState.mockSessionClosed = !!s.sessionClosed;
    viewState.mockDebrief = s.debrief || null;
    viewState.mockEarlyEnd = !!s.earlyEnd;
    viewState.prepMode = "mock";
  }

  function persistMockSnapshot() {
    const store = window.CBV2.store;
    if (!store || typeof store.setInterviewMockSession !== "function") {
      return;
    }
    store.setInterviewMockSession({
      version: 1,
      transcript: viewState.mockTranscript,
      interviewerTurns: viewState.mockInterviewerTurns,
      meta: viewState.mockMeta,
      sessionClosed: viewState.mockSessionClosed,
      debrief: viewState.mockDebrief,
      earlyEnd: viewState.mockEarlyEnd
    });
  }

  function hydrateIntelIfEmpty() {
    if (viewState.intelBusy || viewState.intelPackEnvelope || viewState.intelHits.length) {
      return;
    }
    const store = window.CBV2.store;
    if (!store || typeof store.getInterviewIntelSession !== "function") {
      return;
    }
    const s = store.getInterviewIntelSession();
    if (!s || s.version !== 1) {
      return;
    }
    const hasHits = Array.isArray(s.hits) && s.hits.length > 0;
    const hasPack = !!(s.intelPackEnvelope && s.intelPackEnvelope.data);
    if (!hasHits && !hasPack) {
      return;
    }
    viewState.intelForm = Object.assign({}, viewState.intelForm, s.form || {});
    viewState.intelHits = Array.isArray(s.hits) ? s.hits.slice() : [];
    viewState.intelQueries = Array.isArray(s.queries) ? s.queries.slice() : [];
    viewState.intelWarnings = Array.isArray(s.warnings) ? s.warnings.slice() : [];
    viewState.intelPackEnvelope = s.intelPackEnvelope || null;
    viewState.intelIncludeInMock = s.includeInMock !== false;
  }

  function hydrateDrillIfEmpty() {
    if (viewState.questions && viewState.questions.length) {
      return;
    }
    const store = window.CBV2.store;
    if (!store || typeof store.getAll !== "function") {
      return;
    }
    let s = null;
    try {
      const all = store.getAll() || {};
      s = all.interview && all.interview.lastSet;
    } catch (_) {
      s = null;
    }
    if (!s || !s.data || !Array.isArray(s.data.questions)) {
      return;
    }
    viewState.questions = s.data.questions.slice();
    viewState.feedback = Array.isArray(s.data.feedback) ? s.data.feedback.slice() : [];
    viewState.activeIndex = 0;
  }

  function persistIntelSnapshot() {
    const store = window.CBV2.store;
    if (!store || typeof store.setInterviewIntelSession !== "function") {
      return;
    }
    const hasPack = !!(viewState.intelPackEnvelope && viewState.intelPackEnvelope.data);
    const hasHits = viewState.intelHits.length > 0;
    if (!hasHits && !hasPack) {
      return;
    }
    store.setInterviewIntelSession({
      version: 1,
      updatedAt: new Date().toISOString(),
      form: viewState.intelForm,
      hits: viewState.intelHits,
      queries: viewState.intelQueries,
      warnings: viewState.intelWarnings,
      intelPackEnvelope: viewState.intelPackEnvelope,
      includeInMock: viewState.intelIncludeInMock !== false
    });
  }

  function getIntelBriefForMock() {
    if (viewState.intelIncludeInMock === false || !viewState.intelPackEnvelope || !viewState.intelPackEnvelope.data) {
      return "";
    }
    const d = viewState.intelPackEnvelope.data;
    const lines = [];
    lines.push(String(d.processOverview || "").trim());
    if (typeof d.limitationsNote === "string" && d.limitationsNote.trim()) {
      lines.push("Limitations: " + d.limitationsNote.trim());
    }
    if (Array.isArray(d.citedInsights) && d.citedInsights.length) {
      lines.push("Cited takeaways:");
      for (let i = 0; i < Math.min(d.citedInsights.length, 12); i++) {
        const c = d.citedInsights[i];
        if (!c || !c.insight) continue;
        lines.push("- " + String(c.insight) + " | " + String(c.url || ""));
      }
    }
    if (Array.isArray(d.unverifiedThemes) && d.unverifiedThemes.length) {
      lines.push("Themes (often unverified / anecdotal):");
      d.unverifiedThemes.slice(0, 14).forEach(function (x) {
        lines.push("- " + String(x));
      });
    }
    if (Array.isArray(d.suggestedQuestionThemes) && d.suggestedQuestionThemes.length) {
      lines.push("Question angles to prioritize:");
      d.suggestedQuestionThemes.slice(0, 14).forEach(function (x) {
        lines.push("- " + String(x));
      });
    }
    return lines.join("\n").slice(0, 5200);
  }

  function intelStepPayloadBase() {
    const m = viewState.mockMeta;
    const brief = getIntelBriefForMock();
    // Phase 4.5: pass the persona id. Backend validates it against
    // INTERVIEW_PERSONAS in prompts.ts and injects the matching
    // directive into the system prompt. Unknown ids fall back to
    // technical_lead server-side.
    const persona = m.persona || "technical_lead";
    return {
      company: m.company,
      role: m.role,
      stage: m.stage,
      focus: m.focus,
      jobDescription: m.jd,
      candidateBackground: buildCandidateBackground(m.useResume !== false),
      interviewerPersona: persona,
      ...(brief ? { companyIntelBrief: brief } : {})
    };
  }

  function buildCandidateBackground(includeResume, maxChars) {
    const cap = typeof maxChars === "number" ? maxChars : 3500;
    if (!includeResume) {
      return "";
    }
    const store = window.CBV2.store;
    let text =
      store && typeof store.getEffectiveResumeBaseText === "function"
        ? String(store.getEffectiveResumeBaseText() || "").trim()
        : "";
    if (!text && store && typeof store.getResumeStructured === "function") {
      try {
        text = JSON.stringify(store.getResumeStructured() || {}).slice(0, cap + 1200);
      } catch (_) {
        text = "";
      }
    }
    return text.trim().slice(0, cap);
  }

  function formatMockParagraphs(raw, stFn) {
    const st = typeof stFn === "function" ? stFn : getSt();
    const t = String(raw || "");
    return t
      .split(/\n\n+/)
      .map(function (p) {
        return "<p>" + st(p.trim()) + "</p>";
      })
      .join("");
  }

  function renderQuestions() {
    const st = getSt();
    if (!viewState.questions || !viewState.questions.length) {
      return '<p class="ai-meta">Generate a question set to start practicing.</p>';
    }
    const items = viewState.questions
      .map(function (q, i) {
        const active = i === viewState.activeIndex ? "is-active" : "";
        return (
          '<li><button class="q-item ' +
          active +
          '" data-q-index="' +
          i +
          '" type="button">' +
          (i + 1) +
          ". " +
          st(q) +
          "</button></li>"
        );
      })
      .join("");
    return '<ol class="q-list">' + items + "</ol>";
  }

  function renderPractice() {
    const st = getSt();
    if (!viewState.questions || !viewState.questions.length) {
      return "";
    }
    const q = viewState.questions[viewState.activeIndex] || "";
    const answer = viewState.answers[viewState.activeIndex] || "";
    let scoreBlock = "";
    if (viewState.scoring) {
      scoreBlock = '<p class="ai-meta">Scoring with STAR rubric...</p>';
    } else if (viewState.score) {
      const data = viewState.score.data;
      const strengths = data.strengths
        .map(st)
        .map(function (s) { return "<li>" + s + "</li>"; })
        .join("");
      const improvements = data.improvements
        .map(st)
        .map(function (s) { return "<li>" + s + "</li>"; })
        .join("");
      // Phase 4: STAR sub-score bars. Render only when at least one sub-score
      // is present (older envelopes without STAR fields fall back to single
      // overall score, so this is non-breaking).
      const stars = ["situation", "task", "action", "result"];
      const hasStar = stars.some(function (k) { return typeof data[k] === "number"; });
      let starHtml = "";
      if (hasStar) {
        starHtml = '<div class="star-bars">' +
          stars.map(function (key) {
            const v = typeof data[key] === "number" ? Math.round(data[key]) : 0;
            const label = key.charAt(0).toUpperCase() + key.slice(1);
            const tone = v >= 75 ? "green" : v >= 50 ? "warning" : "rose";
            return (
              '<div class="star-bar star-bar--' + tone + '">' +
                '<div class="star-bar-head"><span class="star-letter">' + key.charAt(0).toUpperCase() + '</span><span class="star-name">' + label + '</span><span class="star-value">' + v + '</span></div>' +
                '<div class="star-bar-track"><i style="width:' + Math.max(2, v) + '%"></i></div>' +
              '</div>'
            );
          }).join("") +
          '</div>';
      }
      scoreBlock =
        '<div class="score-panel">' +
        '<h3 class="ai-headline">Score ' + Math.round(data.score) + "/100</h3>" +
        starHtml +
        '<p class="ai-meta">Strengths</p><ul class="task-list">' +
        strengths +
        '</ul><p class="ai-meta">Improvements</p><ul class="task-list">' +
        improvements +
        "</ul></div>";
    }
    return `
      <h3 class="ai-headline">Practice Question</h3>
      <p class="ai-body"><strong>Q${viewState.activeIndex + 1}.</strong> ${st(q)}</p>
      <label class="form-row-full">Your Answer
        <textarea id="answer-box" rows="6" placeholder="Use STAR: Situation, Task, Action, Result with numbers.">${st(answer)}</textarea>
      </label>
      <div class="form-actions">
        <button class="btn-secondary" id="save-answer" type="button">Save</button>
        <button class="btn-primary" id="score-answer" type="button">
          <i class="fa-solid fa-gauge-high"></i> Score Answer
        </button>
      </div>
      ${scoreBlock}
    `;
  }

  function renderFeedback() {
    const st = getSt();
    if (!viewState.feedback || !viewState.feedback.length) {
      return "";
    }
    const items = viewState.feedback
      .map(function (f) {
        return "<li>" + st(f) + "</li>";
      })
      .join("");
    return (
      '<div class="card panel-lg"><div class="panel-head"><h2>Coaching Tips</h2>' +
      '<span class="chip violet">AI</span></div><ul class="task-list">' +
      items +
      "</ul></div>"
    );
  }

  function renderIntelPanel() {
    const st = getSt();
    const f = viewState.intelForm;
    let hitsBlock = "";
    if (viewState.intelHits.length) {
      const rows = viewState.intelHits
        .slice(0, 10)
        .map(function (h) {
          const url = String((h && h.url) || "#");
          const title = String((h && h.title) || "Source").slice(0, 140);
          const snip = String((h && h.snippet) || "").slice(0, 180);
          return (
            '<li class="intel-hit"><a href="' +
            st(url) +
            '" target="_blank" rel="noopener noreferrer">' +
            st(title) +
            '</a><span class="ai-meta">' +
            st(snip) +
            "</span></li>"
          );
        })
        .join("");
      hitsBlock =
        '<div class="intel-hits-wrap"><p class="ai-meta">Recent web hits (automated)</p><ul class="intel-hits">' +
        rows +
        "</ul></div>";
    }
    let warns = "";
    if (viewState.intelWarnings.length) {
      warns =
        '<ul class="task-list">' +
        viewState.intelWarnings
          .map(function (w) {
            return "<li>" + st(String(w)) + "</li>";
          })
          .join("") +
        "</ul>";
    }
    let packBlock = "";
    const env = viewState.intelPackEnvelope;
    if (env && env.data) {
      const d = env.data;
      const reads = Array.isArray(d.recommendedReads)
        ? d.recommendedReads
            .map(function (r) {
              return (
                '<li><a href="' +
                st(r.url || "#") +
                '" target="_blank" rel="noopener noreferrer">' +
                st(String(r.title || "Read")) +
                '</a> — <span class="ai-body">' +
                st(String(r.reason || "")) +
                "</span></li>"
              );
            })
            .join("")
        : "";
      const checklist = Array.isArray(d.prepChecklist)
        ? d.prepChecklist
            .map(function (x) {
              return "<li>" + st(String(x)) + "</li>";
            })
            .join("")
        : "";
      packBlock =
        '<div class="intel-pack-result">' +
        '<p class="ai-headline">Briefing</p>' +
        '<p class="ai-body">' +
        st(d.processOverview || "") +
        "</p>" +
        (reads ? '<p class="ai-meta">Read next</p><ul class="task-list">' + reads + "</ul>" : "") +
        (checklist ? '<p class="ai-meta">Checklist</p><ul class="task-list">' + checklist + "</ul>" : "") +
        "</div>";
    }

    const runDisabled =
      viewState.intelBusy || viewState.mockBusy || viewState.mockDebriefBusy;
    const includeIntel = viewState.intelIncludeInMock !== false;
    return `
      <article class="card panel-lg intel-phase-a-panel">
        <div class="panel-head">
          <h2>Employer research</h2>
          <span class="chip violet">Phase A</span>
        </div>
        <p class="ai-body">
          Retrieves public snippets via Google Custom Search (same secrets as Job Search external lookup), then asks the model to summarize with strict URL citations — not HR gospel.
        </p>
        <form id="intel-research-form" class="form-grid">
          <label>Company<input name="intelCompany" required placeholder="e.g. Stripe" value="${st(
            f.company
          )}" /></label>
          <label>Role (optional)<input name="intelRole" placeholder="Senior Backend Engineer" value="${st(f.role)}" /></label>
          <label>Brief stage
            <select name="intelStage">
              <option value="screen"${f.stage === "screen" ? " selected" : ""}>Recruiter Screen</option>
              <option value="first"${f.stage === "first" ? " selected" : ""}>First Interview</option>
              <option value="final"${f.stage === "final" ? " selected" : ""}>Final Round</option>
            </select>
          </label>
          <label class="form-row-full intel-check">
            <input type="checkbox" name="intelIncludeMock" ${includeIntel ? "checked" : ""} />
            Pass Phase A briefing into the Virtual interviewer (Phase B)
          </label>
        </form>
        <div class="form-actions intel-actions">
          <button class="btn-primary" id="intel-run" type="button" ${runDisabled ? "disabled" : ""}>
            <i class="fa-solid fa-magnifying-glass"></i> Run web search + briefing
          </button>
          <button class="btn-secondary" id="intel-copy-mock" type="button">
            Copy company into Virtual interview
          </button>
          <button class="btn-ghost" id="intel-clear" type="button" ${viewState.intelBusy ? "disabled" : ""}>
            Clear research
          </button>
        </div>
        ${
          viewState.intelBusy
            ? '<p class="ai-meta">Searching the public web + synthesizing a citation-aware briefing...</p>'
            : ""
        }
        ${viewState.intelError ? '<p class="ai-error">' + st(viewState.intelError) + "</p>" : ""}
        ${warns ? '<div class="intel-warn"><p class="ai-meta">Search notes</p>' + warns + "</div>" : ""}
        ${hitsBlock}
        ${packBlock}
      </article>`;
  }

  function readIntelFormFromDom() {
    const form = document.getElementById("intel-research-form");
    if (!form) return;
    const fd = new FormData(form);
    viewState.intelForm = {
      company: String(fd.get("intelCompany") || "").trim(),
      role: String(fd.get("intelRole") || "").trim(),
      stage: String(fd.get("intelStage") || "first")
    };
    viewState.intelIncludeInMock = fd.get("intelIncludeMock") === "on";
  }

  async function runCompanyIntelResearch() {
    readIntelFormFromDom();
    if (!viewState.intelForm.company) {
      viewState.intelError = "Company is required.";
      window.CBV2.renderCurrentRoute();
      return;
    }
    // Phase Billing: entitlement gate (research).
    const gate = window.CBV2 && window.CBV2.entitlementGate;
    if (gate) {
      const ok = await gate.checkQuota("ai_research");
      if (!ok) return;
    }
    viewState.intelBusy = true;
    viewState.intelError = "";
    viewState.intelWarnings = [];
    window.CBV2.renderCurrentRoute();
    try {
      const svc = window.CBV2.companyIntel;
      if (!svc || typeof svc.search !== "function") {
        throw new Error("Company intel service not loaded.");
      }
      const searchRes = await svc.search({
        company: viewState.intelForm.company,
        role: viewState.intelForm.role
      });
      if (!searchRes.ok) {
        throw new Error(searchRes.error || "Search failed.");
      }
      viewState.intelHits = Array.isArray(searchRes.hits) ? searchRes.hits : [];
      viewState.intelQueries = Array.isArray(searchRes.queries) ? searchRes.queries : [];
      viewState.intelWarnings = Array.isArray(searchRes.warnings) ? searchRes.warnings : [];
      if (!viewState.intelHits.length) {
        viewState.intelPackEnvelope = null;
        viewState.intelError =
          "No web hits returned. Check Google CSE secrets on the company-intel-search function, or try a different company name.";
        persistIntelSnapshot();
        return;
      }
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }
      const env = await ai.runSkill("interview-intel-pack", {
        company: viewState.intelForm.company,
        role: viewState.intelForm.role || viewState.mockMeta.role,
        stage: viewState.intelForm.stage || "first",
        webFindings: JSON.stringify(viewState.intelHits)
      });
      viewState.intelPackEnvelope = env;
      // Phase Billing: optimistic decrement.
      const ent = window.CBV2 && window.CBV2.entitlements;
      if (ent && ent.recordConsumption) ent.recordConsumption("ai_research");
    } catch (err) {
      viewState.intelPackEnvelope = null;
      viewState.intelError = err && err.message ? String(err.message) : "Research failed.";
    } finally {
      viewState.intelBusy = false;
      persistIntelSnapshot();
      window.CBV2.renderCurrentRoute();
    }
  }

  function applyIntelCompanyToVirtual() {
    readIntelFormFromDom();
    if (viewState.intelForm.company) {
      viewState.mockMeta.company = viewState.intelForm.company;
    }
    if (viewState.intelForm.role && !viewState.mockMeta.role) {
      viewState.mockMeta.role = viewState.intelForm.role;
    }
    window.CBV2.renderCurrentRoute();
  }

  function clearIntelResearch() {
    if (viewState.intelBusy) return;
    viewState.intelHits = [];
    viewState.intelQueries = [];
    viewState.intelWarnings = [];
    viewState.intelPackEnvelope = null;
    viewState.intelError = "";
    window.CBV2.store.setInterviewIntelSession(null);
    window.CBV2.renderCurrentRoute();
  }

  function renderMockTranscript() {
    const st = getSt();
    const rows = viewState.mockTranscript
      .map(function (entry) {
        const who = entry.speaker === "interviewer" ? "Interviewer" : "You";
        const cls =
          entry.speaker === "interviewer" ? "mock-msg mock-msg--iv" : "mock-msg mock-msg--cd";
        const phaseChip =
          entry.phase && entry.speaker === "interviewer"
            ? '<span class="chip cyan mock-phase">' + st(entry.phase) + "</span>"
            : "";
        // Streaming bubble gets a stable selector so partial-render token
        // updates don't have to repaint the whole transcript.
        const streamingAttr = entry.streaming ? ' data-streaming-bubble="1"' : "";
        const bodyText = entry.streaming && !entry.text
          ? '<span class="mock-typing">…</span>'
          : formatMockParagraphs(entry.text, st);
        return (
          '<div class="' +
          cls +
          '"><div class="mock-msg-head">' +
          "<strong>" +
          st(who) +
          "</strong> " +
          phaseChip +
          '</div><div class="mock-msg-body"' + streamingAttr + ">" +
          bodyText +
          "</div></div>"
        );
      })
      .join("");
    if (!rows) {
      return '<p class="ai-meta mock-empty-hint">Set your target role below, then press <strong>Start session</strong> to speak with an AI interviewer in multiple rounds.</p>';
    }
    return '<div id="mock-transcript-shell" class="mock-transcript">' + rows + "</div>";
  }

  function renderMockDebriefCard() {
    const st = getSt();
    if (viewState.mockDebriefBusy) {
      return (
        '<div class="mock-debrief">' +
        '<p class="ai-meta">Generating coaching debrief from your transcript…</p>' +
        "</div>"
      );
    }
    if (!viewState.mockDebrief || !viewState.mockDebrief.data) {
      return "";
    }
    const d = viewState.mockDebrief.data;
    const gaps = Array.isArray(d.topGaps)
      ? d.topGaps
          .map(st)
          .map(function (g) {
            return "<li>" + g + "</li>";
          })
          .join("")
      : "";
    const outlines = Array.isArray(d.improvedAnswerOutlines)
      ? d.improvedAnswerOutlines
          .map(st)
          .map(function (o) {
            return "<li>" + o + "</li>";
          })
          .join("")
      : "";
    const drills = Array.isArray(d.nextPracticeFocus)
      ? d.nextPracticeFocus
          .map(st)
          .map(function (x) {
            return "<li>" + x + "</li>";
          })
          .join("")
      : "";
    return `
      <div class="mock-debrief card-inner">
        <h3 class="ai-headline">Session debrief</h3>
        <p class="ai-body"><strong>Overall:</strong> ${Math.round(Number(d.overallScore) || 0)}/100 — ${st(
      d.summary || ""
    )}</p>
        ${gaps ? '<p class="ai-meta">Gaps</p><ul class="task-list">' + gaps + "</ul>" : ""}
        ${outlines ? '<p class="ai-meta">Sharper answers (outlines)</p><ul class="task-list">' + outlines + "</ul>" : ""}
        ${drills ? '<p class="ai-meta">Next drills</p><ul class="task-list">' + drills + "</ul>" : ""}
      </div>`;
  }

  function renderMockPanel() {
    const st = getSt();
    const m = viewState.mockMeta;
    const disabledStart = viewState.mockBusy || viewState.mockDebriefBusy;
    const showReply =
      viewState.mockTranscript.length > 0 &&
      !viewState.mockSessionClosed &&
      !viewState.mockDebriefBusy;
    const replyLocked = viewState.mockBusy || !showReply;
    return `
      <article class="card panel-lg mock-panel">
        <div class="panel-head">
          <h2>Virtual interview</h2>
          <span class="chip blue">Phase B</span>
        </div>
        <p class="ai-body">
          Multi-turn mock: the AI plays interviewer through realistic stages, then produces a debrief with gap analysis and practice drills.
          This is not an official company interview — always verify process details with the employer.
        </p>
        <form id="mock-session-form" class="form-grid">
          <label>Company (optional)<input name="mockCompany" placeholder="Acme Inc." value="${st(m.company)}" /></label>
          <label>Role<input name="mockRole" placeholder="Frontend Engineer" required value="${st(m.role)}" /></label>
          <label>Stage
            <select name="mockStage">
              <option value="screen"${m.stage === "screen" ? " selected" : ""}>Recruiter Screen</option>
              <option value="first"${m.stage === "first" ? " selected" : ""}>First Interview</option>
              <option value="final"${m.stage === "final" ? " selected" : ""}>Final Round</option>
            </select>
          </label>
          <label class="form-row-full">Focus areas
            <input name="mockFocus" placeholder="Behavioral, system design, leadership..." value="${st(m.focus)}" />
          </label>
          <label class="form-row-full">Job description (optional — paste for tighter questions)
            <textarea name="mockJd" rows="4" placeholder="Paste JD excerpt or key requirements.">${st(m.jd)}</textarea>
          </label>
          <label class="form-row-full mock-check">
            <input type="checkbox" name="mockUseResume" ${m.useResume !== false ? "checked" : ""} />
            Include resume text from Resume Lab (best-effort context for follow-ups)
          </label>
        </form>
        <div class="form-actions mock-actions">
          <button class="btn-primary" id="mock-start" type="button" ${disabledStart ? "disabled" : ""}>
            <i class="fa-solid fa-phone-volume"></i> Start session
          </button>
          <button class="btn-secondary" id="mock-send-reply" type="button" ${replyLocked ? "disabled" : ""}>
            Send reply
          </button>
          <button class="btn-secondary" id="mock-end-early" type="button" ${
            !viewState.mockTranscript.length || viewState.mockSessionClosed || viewState.mockBusy
              ? "disabled"
              : ""
          }>
            End &amp; debrief
          </button>
          <button class="btn-ghost" id="mock-reset" type="button" ${viewState.mockBusy || viewState.mockDebriefBusy ? "disabled" : ""}>
            Clear session
          </button>
        </div>
        ${viewState.mockError ? '<p class="ai-error">' + st(viewState.mockError) + "</p>" : ""}
        <div id="mock-transcript-wrap" class="mock-transcript-wrap">
          ${renderMockTranscript()}
        </div>
        <label class="form-row-full mock-reply-label" ${showReply ? "" : "hidden"}>
          Your spoken answer
          <textarea id="mock-reply-box" rows="4" placeholder="Answer as you would on a live call. Be specific; STAR works well." ${replyLocked ? "disabled" : ""}></textarea>
        </label>
        ${renderMockDebriefCard()}
      </article>`;
  }

  function renderView() {
    hydrateMockIfEmpty();
    hydrateIntelIfEmpty();
    const drillHidden = viewState.prepMode !== "drill" ? " hidden" : "";
    const mockHidden = viewState.prepMode !== "mock" ? " hidden" : "";
    const drillBtnClass = viewState.prepMode === "drill" ? " btn-primary" : " btn-secondary";
    const mockBtnClass = viewState.prepMode === "mock" ? " btn-primary" : " btn-secondary";
    const heroBtnsHidden = viewState.prepMode !== "drill" ? " hidden" : "";
    return `
      <section class="page-container">
        <section class="hero-panel">
          <div>
            <p class="eyebrow">Interview Prep</p>
            <h1 class="page-title">Mock Interview Coach</h1>
            <p class="page-subtitle">Research public interview clues (Phase A), drill STAR answers, or run a multi-round virtual interview with debrief (Phase B).</p>
          </div>
          <div class="hero-actions interview-hero-split">
            <div class="prep-mode-toggle" role="group" aria-label="Prep mode">
              <button type="button" class="toggle-pill${drillBtnClass}" id="prep-mode-drill">
                Question drill
              </button>
              <button type="button" class="toggle-pill${mockBtnClass}" id="prep-mode-mock">
                Virtual interview
              </button>
            </div>
            <div class="prep-drill-quick-actions"${heroBtnsHidden}>
              <button class="btn-secondary" id="interview-clear" type="button">Reset drill</button>
              <button class="btn-primary" id="interview-generate" type="button">
                <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Questions
              </button>
            </div>
          </div>
        </section>

        ${renderIntelPanel()}

        <section class="drill-stack"${drillHidden}>
          <section class="two-pane">
            <article class="card panel-lg">
              <div class="panel-head">
                <h2>Target Role</h2>
                <span class="chip cyan">Input</span>
              </div>
              <form id="interview-form" class="form-grid">
                <label>Role<input name="role" placeholder="Frontend Engineer" required /></label>
                <label>Stage
                  <select name="stage">
                    <option value="screen">Recruiter Screen</option>
                    <option value="first" selected>First Interview</option>
                    <option value="final">Final Round</option>
                  </select>
                </label>
                <label class="form-row-full">Focus Areas
                  <input name="focus" placeholder="Behavioral, system design, React internals..." />
                </label>
              </form>
              <div id="interview-output">${viewState.busy ? '<p class="ai-meta">Generating questions...</p>' : renderQuestions()}</div>
            </article>

            <article class="card panel-lg">
              <div class="panel-head">
                <h2>Practice</h2>
                <span class="chip green">STAR Rubric</span>
              </div>
              <div id="practice-output">${renderPractice()}</div>
            </article>
          </section>

          ${renderFeedback()}
        </section>

        <section class="mock-stack"${mockHidden}>
          ${renderMockPanel()}
        </section>
      </section>
    `;
  }

  async function generateQuestions() {
    const form = document.getElementById("interview-form");
    if (!form) return;
    const fd = new FormData(form);
    const input = {
      role: String(fd.get("role") || "").trim(),
      stage: String(fd.get("stage") || "first"),
      focus: String(fd.get("focus") || "").trim()
    };
    if (!input.role) {
      viewState.error = "Role is required.";
      document.getElementById("interview-output").innerHTML =
        '<p class="ai-error">' + viewState.error + "</p>";
      return;
    }
    // Phase Billing: entitlement gate (question bank).
    const gate = window.CBV2 && window.CBV2.entitlementGate;
    if (gate) {
      const ok = await gate.checkQuota("ai_question_banks");
      if (!ok) return;
    }
    // Phase 2: pipe JD + candidate background into drill mode so questions
    // reflect the actual posting (e.g. "the JD emphasizes observability —
    // they'll likely ask about debugging a production outage"). Falls back
    // gracefully when the mock metadata hasn't been filled in yet.
    const m = viewState.mockMeta || {};
    if (m.jd && String(m.jd).trim()) {
      input.jobDescription = String(m.jd).trim().slice(0, 6000);
    }
    if (m.company && !input.company) {
      input.company = String(m.company).trim();
    }
    const background = buildCandidateBackground(true, 3000);
    if (background) {
      input.background = background;
    }
    viewState.busy = true;
    viewState.error = "";
    viewState.questions = null;
    viewState.feedback = null;
    viewState.answers = {};
    viewState.activeIndex = 0;
    viewState.score = null;
    document.getElementById("interview-output").innerHTML = '<p class="ai-meta">Generating questions...</p>';

    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }
      const result = await ai.runSkill("interview-coach", input);
      viewState.questions = result.data.questions;
      viewState.feedback = result.data.feedback;
      // Phase Billing: optimistic decrement.
      const ent = window.CBV2 && window.CBV2.entitlements;
      if (ent && ent.recordConsumption) ent.recordConsumption("ai_question_banks");
      window.CBV2.store.setInterviewSet(result);
    } catch (error) {
      viewState.error = error && error.message ? error.message : "AI action failed";
    } finally {
      viewState.busy = false;
      window.CBV2.renderCurrentRoute();
    }
  }

  async function scoreCurrentAnswer() {
    const box = document.getElementById("answer-box");
    if (!box) return;
    const answer = box.value.trim();
    viewState.answers[viewState.activeIndex] = answer;
    if (!answer) {
      return;
    }
    viewState.scoring = true;
    viewState.score = null;
    document.getElementById("practice-output").innerHTML = renderPractice();
    try {
      const ai = window.CBAI || {};
      const result = await ai.runSkill("interview-score", {
        question: viewState.questions[viewState.activeIndex],
        answer: answer
      });
      viewState.score = result;
    } catch (error) {
      viewState.score = {
        data: {
          score: 0,
          strengths: [],
          improvements: [error && error.message ? error.message : "Scoring failed."]
        }
      };
    } finally {
      viewState.scoring = false;
      document.getElementById("practice-output").innerHTML = renderPractice();
      bindPracticeControls();
    }
  }

  function bindQuestionList() {
    const buttons = document.querySelectorAll(".q-item[data-q-index]");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const idx = Number(btn.getAttribute("data-q-index"));
        const current = document.getElementById("answer-box");
        if (current) {
          viewState.answers[viewState.activeIndex] = current.value;
        }
        viewState.activeIndex = idx;
        viewState.score = null;
        document.getElementById("interview-output").innerHTML = renderQuestions();
        document.getElementById("practice-output").innerHTML = renderPractice();
        bindQuestionList();
        bindPracticeControls();
      });
    });
  }

  function bindPracticeControls() {
    const save = document.getElementById("save-answer");
    const score = document.getElementById("score-answer");
    const box = document.getElementById("answer-box");
    if (save && box) {
      save.addEventListener("click", function () {
        viewState.answers[viewState.activeIndex] = box.value;
        save.innerHTML = "Saved";
        setTimeout(function () {
          save.innerHTML = "Save";
        }, 900);
      });
    }
    if (score) {
      score.addEventListener("click", function () {
        scoreCurrentAnswer();
      });
    }
  }

  function resetDrillOnly() {
    viewState.busy = false;
    viewState.error = "";
    viewState.questions = null;
    viewState.feedback = null;
    viewState.activeIndex = 0;
    viewState.answers = {};
    viewState.score = null;
    window.CBV2.store.setInterviewSet(null);
    window.CBV2.renderCurrentRoute();
  }

  // Phase 4.5: persona selector chip strip for the mock setup form.
  // Reads canonical persona list from window.CBV2.interviewPersonas
  // (registered by interview.personas.js loaded before this file).
  // Renders one chip per persona + a hidden input that FormData reads
  // back via readMockMetaFromForm.
  function renderPersonaSelector(activeId) {
    const st = getSt();
    const reg = window.CBV2 && window.CBV2.interviewPersonas;
    if (!reg) {
      // Personas module not loaded — silently fall back to no selector.
      // The hidden input still appears so the form data round-trips.
      return '<input type="hidden" name="mockPersona" value="' + st(activeId || "") + '" />';
    }
    const personas = reg.list();
    const chips = personas.map(function (p) {
      const isActive = p.id === activeId;
      return (
        '<button type="button" class="interview-persona-chip interview-persona-chip--' + st(p.tone || "blue") + (isActive ? " is-active" : "") + '"' +
          ' data-persona-pick="' + st(p.id) + '"' +
          ' title="' + st(p.tagline) + '"' +
        '>' +
          '<i class="fa-solid ' + st(p.icon || "fa-user") + '" aria-hidden="true"></i>' +
          '<span class="interview-persona-chip-label">' + st(p.label) + '</span>' +
          '<small class="interview-persona-chip-diff">' + st(p.difficulty || "") + '</small>' +
        '</button>'
      );
    }).join("");
    return (
      '<div class="form-row-full interview-persona-row">' +
        '<div class="interview-persona-head">' +
          '<span>Interviewer persona</span>' +
          '<small class="ai-meta">Pick the style you want to practice. The AI adopts that voice end-to-end.</small>' +
        '</div>' +
        '<div class="interview-persona-strip" role="radiogroup" aria-label="Interviewer persona">' +
          chips +
        '</div>' +
        '<input type="hidden" name="mockPersona" id="mock-persona-hidden" value="' + st(activeId || "technical_lead") + '" />' +
      '</div>'
    );
  }

  function bindPersonaSelector() {
    const buttons = document.querySelectorAll("[data-persona-pick]");
    const hidden = document.getElementById("mock-persona-hidden");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-persona-pick") || "";
        if (!id) return;
        // Update hidden field + toggle active class in place — no full
        // re-render needed so the user's form values + scroll position
        // stay put.
        if (hidden) hidden.value = id;
        viewState.mockMeta.persona = id;
        buttons.forEach(function (b) { b.classList.remove("is-active"); });
        btn.classList.add("is-active");
      });
    });
  }

  function readMockMetaFromForm() {
    const form = document.getElementById("mock-session-form");
    if (!form) return;
    const fd = new FormData(form);
    // Phase 4.5: persona is a hidden field driven by the chip selector.
    // Falls back to the prior selection if the chips haven't rendered
    // yet (race during streaming re-renders).
    const personaFromForm = String(fd.get("mockPersona") || "").trim();
    const prior = (viewState.mockMeta && viewState.mockMeta.persona) || "technical_lead";
    const validIds = window.CBV2.interviewPersonas && window.CBV2.interviewPersonas._persona_ids;
    const persona = personaFromForm && validIds && validIds.indexOf(personaFromForm) >= 0
      ? personaFromForm
      : prior;
    viewState.mockMeta = {
      company: String(fd.get("mockCompany") || "").trim(),
      role: String(fd.get("mockRole") || "").trim(),
      stage: String(fd.get("mockStage") || "first"),
      focus: String(fd.get("mockFocus") || "").trim(),
      jd: String(fd.get("mockJd") || "").trim(),
      useResume: fd.get("mockUseResume") === "on",
      persona: persona
    };
  }

  // ─── Phase 4.5 voice helpers ────────────────────────────────────────
  // Speak the most recent interviewer message aloud, in the active
  // persona's voice profile. No-op when voice mode is off or the
  // synthesis API is unsupported.
  function speakInterviewerTurn(text) {
    if (!viewState.voiceMode) return;
    const voice = window.CBV2 && window.CBV2.interviewVoice;
    if (!voice || !voice.isSynthesisSupported()) return;
    const personas = window.CBV2 && window.CBV2.interviewPersonas;
    const persona = personas ? personas.get(viewState.mockMeta.persona || personas.DEFAULT_ID) : null;
    const profile = (persona && persona.voiceProfile) || null;
    viewState.voiceSpeaking = true;
    window.CBV2.renderCurrentRoute();
    voice.speak(text, {
      profile: profile,
      onEnd: function () {
        viewState.voiceSpeaking = false;
        window.CBV2.renderCurrentRoute();
        // Auto-open the mic after the interviewer finishes — natural
        // conversational rhythm; the candidate doesn't have to click.
        // Only do this if voice mode is still on and the session isn't
        // closed (avoids re-listening during debrief).
        if (viewState.voiceMode && !viewState.mockSessionClosed && !viewState.mockBusy) {
          startVoiceListening();
        }
      },
      onError: function (err) {
        viewState.voiceSpeaking = false;
        viewState.voiceError = err && err.message ? err.message : "Voice playback failed.";
        window.CBV2.renderCurrentRoute();
      }
    });
  }

  // Begin push-to-talk recognition. Interim results populate the reply
  // textarea live; final transcript stays in the textarea so the user
  // can review + edit before sending.
  function startVoiceListening() {
    const voice = window.CBV2 && window.CBV2.interviewVoice;
    if (!voice || !voice.isRecognitionSupported()) return;
    if (viewState.voiceListening) return;
    viewState.voiceListening = true;
    viewState.voiceInterim = "";
    viewState.voiceError = "";
    window.CBV2.renderCurrentRoute();
    voice.listen({
      lang: "en-US",
      continuous: false,
      interimResults: true,
      onResult: function (res) {
        viewState.voiceInterim = res.text;
        // Mirror interim text into the reply textarea so the user sees
        // their words appear in real time.
        const box = document.getElementById("mock-reply-box");
        if (box) box.value = res.text;
      },
      onEnd: function (res) {
        viewState.voiceListening = false;
        viewState.voiceInterim = "";
        const box = document.getElementById("mock-reply-box");
        const finalText = (box && box.value) || (res && res.text) || "";
        window.CBV2.renderCurrentRoute();
        // Auto-submit if we have substantive text. Trim + minimum length
        // gate prevents tiny "uh" pickups from triggering a turn.
        if (finalText.trim().length >= 8 && !viewState.mockBusy) {
          submitMockReply();
        }
      },
      onError: function (err) {
        viewState.voiceListening = false;
        viewState.voiceError = err && err.message ? err.message : "Microphone error.";
        window.CBV2.renderCurrentRoute();
      }
    });
  }

  function stopVoiceListening() {
    const voice = window.CBV2 && window.CBV2.interviewVoice;
    if (!voice) return;
    voice.stopListening();
    viewState.voiceListening = false;
    viewState.voiceInterim = "";
  }

  async function toggleVoiceMode() {
    const voice = window.CBV2 && window.CBV2.interviewVoice;
    if (!voice) return;
    if (!voice.isFullySupported()) {
      viewState.voiceError = !voice.isRecognitionSupported()
        ? "Speech recognition isn't available in this browser. Chrome, Edge, or Safari work best."
        : "Speech synthesis isn't available in this browser.";
      window.CBV2.renderCurrentRoute();
      return;
    }
    // Phase Billing: voice mode is gated to Pro / Career. Free + Plus
    // get an upgrade modal pointing at Pro. Turning OFF doesn't need
    // a check.
    if (!viewState.voiceMode) {
      const gate = window.CBV2 && window.CBV2.entitlementGate;
      if (gate) {
        const ok = await gate.checkFeature("voice_mode");
        if (!ok) return;
      }
    }
    viewState.voiceMode = !viewState.voiceMode;
    viewState.voiceError = "";
    if (!viewState.voiceMode) {
      // Turning OFF: stop any in-flight speaking / listening.
      voice.stopSpeaking();
      voice.stopListening();
      viewState.voiceListening = false;
      viewState.voiceSpeaking = false;
    }
    window.CBV2.renderCurrentRoute();
  }

  function renderVoiceToolbar() {
    const voice = window.CBV2 && window.CBV2.interviewVoice;
    if (!voice) return "";
    const st = getSt();
    const supported = voice.isFullySupported();
    const recOnly = voice.isRecognitionSupported() && !voice.isSynthesisSupported();
    if (!supported && !recOnly) {
      // Neither — surface a tiny notice instead of a broken toggle.
      return '<p class="ai-meta interview-voice-unsupported"><i class="fa-solid fa-circle-info"></i> Voice mode needs Chrome, Edge, or Safari.</p>';
    }
    const on = viewState.voiceMode;
    const speaking = viewState.voiceSpeaking;
    const listening = viewState.voiceListening;
    const errLine = viewState.voiceError
      ? '<p class="ai-error interview-voice-error">' + st(viewState.voiceError) + '</p>'
      : '';
    const indicator = on
      ? (listening
          ? '<span class="interview-voice-indicator is-listening"><i class="fa-solid fa-microphone"></i> Listening…</span>'
          : speaking
            ? '<span class="interview-voice-indicator is-speaking"><i class="fa-solid fa-volume-high fa-beat-fade"></i> Speaking…</span>'
            : '<span class="interview-voice-indicator is-ready"><i class="fa-solid fa-circle"></i> Voice ready</span>')
      : '';
    return (
      '<div class="interview-voice-bar">' +
        '<button type="button" id="mock-voice-toggle" class="' + (on ? "btn-primary" : "btn-ghost") + '" title="Voice mode: speak your reply, the interviewer speaks back">' +
          '<i class="fa-solid ' + (on ? "fa-microphone" : "fa-microphone-slash") + '"></i> ' +
          (on ? "Voice on" : "Voice off") +
        '</button>' +
        indicator +
        errLine +
      '</div>'
    );
  }

  function bindVoiceControls() {
    const toggle = document.getElementById("mock-voice-toggle");
    if (toggle) {
      toggle.addEventListener("click", function () { toggleVoiceMode(); });
    }
    const mic = document.getElementById("mock-voice-mic");
    if (mic) {
      mic.addEventListener("click", function () {
        if (viewState.voiceListening) {
          stopVoiceListening();
        } else {
          // Stop interviewer playback when user wants to interject —
          // mirrors a real interview interruption.
          const voice = window.CBV2 && window.CBV2.interviewVoice;
          if (voice && viewState.voiceSpeaking) voice.stopSpeaking();
          startVoiceListening();
        }
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  function scrollMockTranscript() {
    window.requestAnimationFrame(function () {
      const el =
        document.getElementById("mock-transcript-shell") ||
        document.getElementById("mock-transcript-wrap");
      if (el && typeof el.scrollTop === "number") {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  async function runInterviewDebrief(earlyFlag) {
    viewState.mockDebriefBusy = true;
    viewState.mockError = "";
    viewState.mockEarlyEnd = !!earlyFlag;
    window.CBV2.renderCurrentRoute();
    try {
      const ai = window.CBAI || {};
      if (typeof ai.runSkill !== "function") {
        throw new Error("AI orchestrator not available.");
      }
      const m = viewState.mockMeta;
      const env = await ai.runSkill("interview-session-debrief", {
        company: m.company,
        role: m.role,
        stage: m.stage,
        transcript: JSON.stringify(viewState.mockTranscript),
        earlyEnd: !!earlyFlag
      });
      viewState.mockDebrief = env;
    } catch (err) {
      viewState.mockError = err && err.message ? String(err.message) : "Debrief failed.";
      viewState.mockDebrief = null;
    } finally {
      viewState.mockDebriefBusy = false;
      viewState.mockSessionClosed = true;
      persistMockSnapshot();
      window.CBV2.renderCurrentRoute();
    }
  }

  async function runInterviewStep(payload, streamCallbacks) {
    const ai = window.CBAI || {};
    if (typeof ai.runSkill !== "function") {
      throw new Error("AI orchestrator not available.");
    }
    // Phase 1: prefer streaming for the mock interview turn-by-turn UX so the
    // first token shows in ~100ms instead of waiting 4-8s for the full reply.
    if (streamCallbacks && typeof ai.runSkillStreamed === "function") {
      try {
        return await ai.runSkillStreamed("interview-session-step", payload, streamCallbacks);
      } catch (err) {
        // Streaming-specific failure (network, SSE parse) → fall back to blocking.
        // Do NOT swallow auth/4xx errors — those should still surface.
        const msg = err && err.message ? String(err.message) : "";
        if (/401|403|429|5\d\d/.test(msg)) {
          throw err;
        }
        // Continue to blocking fallback below.
      }
    }
    return ai.runSkill("interview-session-step", payload);
  }

  async function startMockInterview() {
    readMockMetaFromForm();
    if (!viewState.mockMeta.role) {
      viewState.mockError = "Role is required for a virtual interview.";
      window.CBV2.renderCurrentRoute();
      return;
    }
    // Phase Billing: entitlement gate. Mock interviews count against
    // a monthly quota. Voice mode is also gated separately when the
    // user toggles voice — see toggleVoiceMode below.
    const gate = window.CBV2 && window.CBV2.entitlementGate;
    if (gate) {
      const ok = await gate.checkQuota("ai_mocks");
      if (!ok) return;
    }
    viewState.mockBusy = true;
    viewState.mockError = "";
    viewState.mockTranscript = [];
    viewState.mockInterviewerTurns = 0;
    viewState.mockSessionClosed = false;
    viewState.mockEarlyEnd = false;
    viewState.mockDebrief = null;
    window.CBV2.renderCurrentRoute();
    // Pre-create an in-progress interviewer bubble that streaming deltas will fill.
    const streamingBubble = {
      speaker: "interviewer",
      text: "",
      phase: "warmup",
      streaming: true
    };
    viewState.mockTranscript.push(streamingBubble);
    const streamCallbacks = createStreamCallbacks(streamingBubble);
    // Phase Billing: optimistic decrement once the session is starting.
    // Done after the entitlement gate so we only decrement when the
    // user has actually committed to this session.
    const entOpt = window.CBV2 && window.CBV2.entitlements;
    if (entOpt && entOpt.recordConsumption) entOpt.recordConsumption("ai_mocks");
    try {
      const env = await runInterviewStep(
        Object.assign({}, intelStepPayloadBase(), {
          openingInit: true,
          turnIndex: 0
        }),
        streamCallbacks
      );
      // Replace the streaming bubble's text with the validated final message
      // (handles both streamed + fallback-blocking paths).
      streamingBubble.text = env.data.message;
      streamingBubble.phase = env.data.phase;
      streamingBubble.streaming = false;
      viewState.mockInterviewerTurns = 1;
      // Phase 4.5 voice: speak the AI's opening turn aloud if voice
      // mode is on. Done AFTER the bubble text is finalized so chunks
      // match exactly what the user sees.
      speakInterviewerTurn(env.data.message);
      if (env.data.isComplete) {
        viewState.mockSessionClosed = true;
        await runInterviewDebrief(false);
        return;
      }
    } catch (err) {
      // Drop the empty in-progress bubble so users don't see a ghost row.
      const idx = viewState.mockTranscript.indexOf(streamingBubble);
      if (idx !== -1) viewState.mockTranscript.splice(idx, 1);
      viewState.mockError = err && err.message ? String(err.message) : "Interview step failed.";
    } finally {
      viewState.mockBusy = false;
      persistMockSnapshot();
      window.CBV2.renderCurrentRoute();
      scrollMockTranscript();
    }
  }

  // Build callbacks for the SSE stream. Mutates the provided bubble in-place
  // so the existing render path picks up tokens as they arrive.
  function createStreamCallbacks(bubble) {
    let frame = null;
    function scheduleRender() {
      if (frame !== null) return;
      frame = requestAnimationFrame(function () {
        frame = null;
        // Render only the active streaming row, not the whole route, to keep
        // typing-indicator latency low.
        const node = document.querySelector('[data-streaming-bubble="1"]');
        if (node) {
          node.textContent = bubble.text;
          scrollMockTranscript();
        } else {
          // Fallback to full re-render if the partial node isn't mounted.
          window.CBV2.renderCurrentRoute();
        }
      });
    }
    return {
      onMeta: function () { /* could surface model name */ },
      onDelta: function (data) {
        if (!data || typeof data.text !== "string") return;
        bubble.text += data.text;
        scheduleRender();
      },
      onWarn: function () { /* schema warnings come AFTER stream — non-fatal */ },
      onError: function (data) {
        bubble.streaming = false;
        viewState.mockError = (data && data.message) ? data.message : "Stream failed.";
        window.CBV2.renderCurrentRoute();
      },
      onDone: function () { bubble.streaming = false; }
    };
  }

  async function submitMockReply() {
    readMockMetaFromForm();
    const box = document.getElementById("mock-reply-box");
    const text = box && box.value ? String(box.value).trim() : "";
    if (!text) {
      return;
    }
    if (viewState.mockSessionClosed || viewState.mockBusy) {
      return;
    }

    if (viewState.mockInterviewerTurns >= MOCK_MAX_INTERVIEWER_TURNS) {
      viewState.mockTranscript.push({ speaker: "candidate", text: text });
      box.value = "";
      viewState.mockBusy = true;
      window.CBV2.renderCurrentRoute();
      viewState.mockBusy = false;
      await runInterviewDebrief(true);
      return;
    }

    viewState.mockTranscript.push({ speaker: "candidate", text: text });
    if (box) {
      box.value = "";
    }
    viewState.mockBusy = true;
    viewState.mockError = "";
    // Streaming bubble for the next interviewer turn.
    const streamingBubble = {
      speaker: "interviewer",
      text: "",
      phase: "behavioral",
      streaming: true
    };
    viewState.mockTranscript.push(streamingBubble);
    window.CBV2.renderCurrentRoute();

    const streamCallbacks = createStreamCallbacks(streamingBubble);
    try {
      const env = await runInterviewStep(
        Object.assign({}, intelStepPayloadBase(), {
          openingInit: false,
          // Send transcript without the in-progress empty interviewer bubble.
          transcript: viewState.mockTranscript.filter(function (m) { return !m.streaming; }),
          turnIndex: viewState.mockInterviewerTurns
        }),
        streamCallbacks
      );
      streamingBubble.text = env.data.message;
      streamingBubble.phase = env.data.phase;
      streamingBubble.streaming = false;
      viewState.mockInterviewerTurns += 1;
      // Phase 4.5 voice: speak each new interviewer turn aloud in the
      // persona's voice. No-op if voice mode is off.
      speakInterviewerTurn(env.data.message);

      if (env.data.isComplete) {
        viewState.mockSessionClosed = true;
        await runInterviewDebrief(false);
        return;
      }

      if (viewState.mockInterviewerTurns >= MOCK_MAX_INTERVIEWER_TURNS) {
        viewState.mockSessionClosed = true;
        await runInterviewDebrief(true);
        return;
      }
    } catch (err) {
      const idx = viewState.mockTranscript.indexOf(streamingBubble);
      if (idx !== -1) viewState.mockTranscript.splice(idx, 1);
      viewState.mockError = err && err.message ? String(err.message) : "Interview step failed.";
    } finally {
      viewState.mockBusy = false;
      persistMockSnapshot();
      window.CBV2.renderCurrentRoute();
      scrollMockTranscript();
    }
  }

  async function endMockEarly() {
    if (!viewState.mockTranscript.length || viewState.mockBusy) {
      return;
    }
    viewState.mockBusy = true;
    viewState.mockError = "";
    window.CBV2.renderCurrentRoute();
    viewState.mockBusy = false;
    await runInterviewDebrief(true);
  }

  function resetMockSession() {
    if (viewState.mockBusy || viewState.mockDebriefBusy) {
      return;
    }
    viewState.mockTranscript = [];
    viewState.mockInterviewerTurns = 0;
    viewState.mockSessionClosed = false;
    viewState.mockEarlyEnd = false;
    viewState.mockDebrief = null;
    viewState.mockError = "";
    window.CBV2.store.setInterviewMockSession(null);
    window.CBV2.renderCurrentRoute();
  }

  // Layout refresh: prepMode is now a 4-step journey. Legacy "drill"
  // and "mock" still work and map onto their corresponding steps so
  // existing entry points don't break.
  const PREP_STEPS = ["research", "drill", "mock", "debrief"];

  function setPrepMode(mode) {
    if (PREP_STEPS.indexOf(mode) < 0) return;
    viewState.prepMode = mode;
    window.CBV2.renderCurrentRoute();
  }

  function getStoreApplications() {
    const store = window.CBV2.store;
    if (!store || typeof store.getApplications !== "function") return [];
    try {
      return store.getApplications() || [];
    } catch (_) {
      return [];
    }
  }

  function getStoreEvents() {
    const store = window.CBV2.store;
    if (!store || typeof store.getEvents !== "function") return [];
    try {
      return store.getEvents() || [];
    } catch (_) {
      return [];
    }
  }

  function stageLabel(stage) {
    const s = String(stage || "").toLowerCase();
    if (s === "screen") return "Recruiter screen";
    if (s === "first") return "First interview";
    if (s === "final") return "Final round";
    if (s === "interview") return "Interview";
    if (s === "offer") return "Offer stage";
    if (s === "applied") return "Applied";
    if (s === "saved") return "Saved";
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Interview";
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

  function hydrateActiveRoleContext(force) {
    const svc = window.CBV2.roleContext;
    const ctx = getActiveRoleContext();
    if (!ctx) return null;
    const key = svc && typeof svc.keyFor === "function"
      ? svc.keyFor(ctx)
      : [ctx.appId || "", ctx.company || "", ctx.role || "", ctx.capturedAt || ""].join("|");
    const emptyTarget = !viewState.intelForm.company && !viewState.intelForm.role &&
      !viewState.mockMeta.company && !viewState.mockMeta.role;
    if (force || (viewState.activeRoleContextKey !== key && (ctx.destination === "interview" || emptyTarget))) {
      viewState.intelForm.company = String(ctx.company || "").trim();
      viewState.intelForm.role = String(ctx.role || "").trim();
      viewState.intelForm.stage = "first";
      viewState.mockMeta.company = String(ctx.company || "").trim();
      viewState.mockMeta.role = String(ctx.role || "").trim();
      viewState.mockMeta.stage = "first";
      if (roleContextJobText(ctx)) viewState.mockMeta.jd = roleContextJobText(ctx);
      if (ctx.nextAction && !viewState.mockMeta.focus) viewState.mockMeta.focus = ctx.nextAction;
      viewState.activeRoleContextKey = key;
    }
    return ctx;
  }

  function getTargetApplications() {
    const priority = { interview: 0, offer: 1, applied: 2, saved: 3, rejected: 8, withdrawn: 9 };
    return getStoreApplications()
      .filter(function (app) {
        return app && (app.company || app.role);
      })
      .sort(function (a, b) {
        const as = priority[String(a.stage || "").toLowerCase()] ?? 5;
        const bs = priority[String(b.stage || "").toLowerCase()] ?? 5;
        if (as !== bs) return as - bs;
        return String(b.appliedAt || "").localeCompare(String(a.appliedAt || ""));
      });
  }

  function inferActiveTarget() {
    const apps = getTargetApplications();
    const company = String(viewState.intelForm.company || viewState.mockMeta.company || "").trim();
    const role = String(viewState.intelForm.role || viewState.mockMeta.role || "").trim();
    let app = null;

    if (company || role) {
      app = apps.find(function (x) {
        const xc = String(x.company || "").toLowerCase();
        const xr = String(x.role || "").toLowerCase();
        return (
          (!company || xc === company.toLowerCase()) &&
          (!role || xr === role.toLowerCase())
        );
      }) || null;
    }

    if (!app) {
      app =
        apps.find(function (x) { return String(x.stage || "").toLowerCase() === "interview"; }) ||
        apps[0] ||
        null;
    }

    return {
      app: app,
      apps: apps,
      company: company || (app && app.company) || "Target company",
      role: role || (app && app.role) || "Target role",
      stage: viewState.intelForm.stage || viewState.mockMeta.stage || "first"
    };
  }

  function getUpcomingInterview(target) {
    const events = getStoreEvents()
      .filter(function (ev) {
        return ev && String(ev.type || "").toLowerCase() === "interview";
      })
      .sort(function (a, b) {
        return String(a.date || "").localeCompare(String(b.date || ""));
      });
    if (!events.length) return null;
    const company = target && target.company ? String(target.company).toLowerCase() : "";
    const role = target && target.role ? String(target.role).toLowerCase() : "";
    return (
      events.find(function (ev) {
        const title = String(ev.title || "").toLowerCase();
        return (company && title.indexOf(company) >= 0) || (role && title.indexOf(role) >= 0);
      }) ||
      events[0]
    );
  }

  function hasResumeContext() {
    const store = window.CBV2.store;
    if (!store || typeof store.getEffectiveResumeBaseText !== "function") return false;
    try {
      return String(store.getEffectiveResumeBaseText() || "").trim().length > 80;
    } catch (_) {
      return false;
    }
  }

  function readinessModel(target) {
    const hasIntel = !!(viewState.intelPackEnvelope && viewState.intelPackEnvelope.data);
    const hasMock = !!(viewState.mockTranscript && viewState.mockTranscript.length);
    const hasDebrief = !!(viewState.mockDebrief && viewState.mockDebrief.data);
    const hasQuestions = !!(viewState.questions && viewState.questions.length);
    const hasResume = hasResumeContext();
    const upcoming = getUpcomingInterview(target);
    let score = 18;
    if (hasIntel) score += 22;
    if (hasQuestions) score += 17;
    if (hasMock) score += 18;
    if (hasDebrief) score += 13;
    if (hasResume) score += 8;
    if (upcoming) score += 4;
    score = Math.max(0, Math.min(100, score));
    return {
      score: score,
      hasIntel: hasIntel,
      hasMock: hasMock,
      hasDebrief: hasDebrief,
      hasQuestions: hasQuestions,
      hasResume: hasResume,
      upcoming: upcoming
    };
  }

  function renderTargetOptions(target) {
    const st = getSt();
    if (!target.apps.length) {
      return '<option value="">No pipeline targets yet</option>';
    }
    return target.apps
      .map(function (app) {
        const value = st(app.id || "");
        const label = st((app.company || "Company") + " - " + (app.role || "Role"));
        const selected = target.app && target.app.id === app.id ? " selected" : "";
        return '<option value="' + value + '"' + selected + ">" + label + "</option>";
      })
      .join("");
  }

  function applySelectedTarget(appId) {
    const app = getTargetApplications().find(function (x) {
      return String(x.id || "") === String(appId || "");
    });
    if (!app) return;
    const svc = window.CBV2.roleContext;
    let ctx = null;
    if (svc && typeof svc.useApplication === "function") {
      ctx = svc.useApplication(app, { destination: "interview", origin: "interview-target-picker" });
      viewState.activeRoleContextKey = svc.keyFor ? svc.keyFor(ctx) : "";
    }
    const focus = [app.nextAction, app.notes]
      .filter(Boolean)
      .join(" ")
      .slice(0, 220);
    viewState.intelForm.company = String(app.company || "").trim();
    viewState.intelForm.role = String(app.role || "").trim();
    viewState.intelForm.stage = "first";
    viewState.mockMeta.company = String(app.company || "").trim();
    viewState.mockMeta.role = String(app.role || "").trim();
    viewState.mockMeta.stage = "first";
    if (ctx && roleContextJobText(ctx)) {
      viewState.mockMeta.jd = roleContextJobText(ctx);
    }
    if (focus && !viewState.mockMeta.focus) {
      viewState.mockMeta.focus = focus;
    }
    window.CBV2.renderCurrentRoute();
  }

  function renderCommandHeroV2(target, model) {
    const st = getSt();
    const drillBtnClass = viewState.prepMode === "drill" ? " btn-primary" : " btn-secondary";
    const mockBtnClass = viewState.prepMode === "mock" ? " btn-primary" : " btn-secondary";
    const heroBtnsHidden = viewState.prepMode !== "drill" ? " hidden" : "";
    const next = model.upcoming
      ? st((model.upcoming.title || "Interview") + (model.upcoming.date ? " on " + model.upcoming.date : ""))
      : "No interview date logged";

    return `
      <section class="interview-command-hero">
        <div class="interview-hero-copy">
          <p class="eyebrow">Interview Prep</p>
          <h1 class="page-title">Interview Command Center</h1>
          <p class="page-subtitle">
            Turn company research, your resume context, role evidence, and realistic AI rehearsal into one interview readiness system.
          </p>
          <div class="interview-target-bar">
            <label class="interview-target-picker">
              <span>Preparing for</span>
              <select id="interview-target-select" ${target.apps.length ? "" : "disabled"}>
                ${renderTargetOptions(target)}
              </select>
            </label>
            <div class="interview-target-chips" aria-label="Active interview target">
              <span><i class="fa-solid fa-building"></i><b>${st(target.company)}</b></span>
              <span><i class="fa-solid fa-briefcase"></i><b>${st(target.role)}</b></span>
              <span><i class="fa-solid fa-layer-group"></i><b>${st(stageLabel(target.stage))}</b></span>
            </div>
          </div>
          <div class="hero-actions interview-hero-actions">
            <div class="prep-mode-toggle" role="group" aria-label="Prep mode">
              <button type="button" class="toggle-pill${drillBtnClass}" id="prep-mode-drill">
                <i class="fa-solid fa-list-check"></i> Question drill
              </button>
              <button type="button" class="toggle-pill${mockBtnClass}" id="prep-mode-mock">
                <i class="fa-solid fa-microphone-lines"></i> Virtual interview
              </button>
            </div>
            <div class="prep-drill-quick-actions"${heroBtnsHidden}>
              <button class="btn-secondary" id="interview-clear" type="button">Reset drill</button>
              <button class="btn-primary" id="interview-generate" type="button">
                <i class="fa-solid fa-wand-magic-sparkles"></i> Generate questions
              </button>
            </div>
          </div>
        </div>
        <aside class="interview-readiness-card" aria-label="Interview readiness">
          <div class="readiness-orbit" style="--score:${model.score}">
            <strong>${model.score}</strong>
            <span>readiness</span>
          </div>
          <div class="readiness-summary">
            <span>Next interview</span>
            <strong>${next}</strong>
          </div>
          <div class="readiness-flags">
            <span class="${model.hasIntel ? "is-ready" : ""}"><i class="fa-solid fa-magnifying-glass-chart"></i> Research</span>
            <span class="${model.hasQuestions ? "is-ready" : ""}"><i class="fa-solid fa-circle-question"></i> Questions</span>
            <span class="${model.hasMock ? "is-ready" : ""}"><i class="fa-solid fa-comments"></i> Mock</span>
            <span class="${model.hasResume ? "is-ready" : ""}"><i class="fa-solid fa-file-lines"></i> Resume context</span>
          </div>
        </aside>
      </section>`;
  }

  function renderReadinessStripV2(model) {
    const items = [
      {
        icon: "fa-building-shield",
        label: "Company brief",
        value: model.hasIntel ? "Source-backed" : "Research needed",
        tone: model.hasIntel ? "ready" : "todo"
      },
      {
        icon: "fa-circle-question",
        label: "Question bank",
        value: viewState.questions && viewState.questions.length ? viewState.questions.length + " active prompts" : "Not generated",
        tone: model.hasQuestions ? "ready" : "todo"
      },
      {
        icon: "fa-user-tie",
        label: "Simulation",
        value: model.hasDebrief ? "Debrief complete" : (model.hasMock ? "Session in progress" : "Not rehearsed"),
        tone: model.hasMock ? "ready" : "todo"
      },
      {
        icon: "fa-fingerprint",
        label: "Candidate context",
        value: model.hasResume ? "Resume connected" : "Resume missing",
        tone: model.hasResume ? "ready" : "todo"
      }
    ];
    return (
      '<section class="interview-readiness-strip">' +
      items
        .map(function (item) {
          return (
            '<article class="interview-signal ' + item.tone + '">' +
            '<i class="fa-solid ' + item.icon + '"></i>' +
            '<span>' + item.label + "</span>" +
            "<strong>" + item.value + "</strong>" +
            "</article>"
          );
        })
        .join("") +
      "</section>"
    );
  }

  function buildPhase4InterviewIntel(target) {
    const svc = window.CBV2.productIntel;
    if (!svc || typeof svc.interviewPrep !== "function") return null;
    const store = window.CBV2.store;
    const all = store && typeof store.getAll === "function" ? store.getAll() : {};
    return svc.interviewPrep(target, {
      all: all,
      app: target && target.app,
      questions: viewState.questions || [],
      intelSession: all.interview && all.interview.intelSession,
      mockDebrief: viewState.mockDebrief
    });
  }

  function renderPhase4InterviewIntel(target) {
    const st = getSt();
    const intel = buildPhase4InterviewIntel(target);
    if (!intel) return "";
    const process = (intel.likelyProcess || []).slice(0, 4).map(function (step) {
      return (
        '<article class="phase4-process-step">' +
          '<div><strong>' + st(step.name) + '</strong><p>' + st(step.focus) + '</p></div>' +
          '<span class="num-font">' + st(String(step.readiness || 0)) + '</span>' +
        '</article>'
      );
    }).join("");
    const questions = (intel.questionBank || []).slice(0, 6).map(function (q) {
      return '<li><i class="fa-solid fa-circle-question"></i><span>' + st(q) + "</span></li>";
    }).join("");
    const drills = (intel.weakDrills || []).slice(0, 5).map(function (d) {
      return '<li><i class="fa-solid fa-dumbbell"></i><span>' + st(d) + "</span></li>";
    }).join("");
    const sources = (intel.sources || []).slice(0, 4).map(function (src) {
      return (
        '<li><a href="' + st(src.url || "#") + '" target="_blank" rel="noopener noreferrer">' +
          st(src.title || "Source") +
        '</a><span>' + st(src.insight || src.kind || "") + "</span></li>"
      );
    }).join("");
    const rubric = (intel.mockRubric || []).map(function (r) {
      return '<span><b>' + st(String(r.weight)) + '%</b> ' + st(r.label) + '</span>';
    }).join("");
    return (
      '<section class="phase4-intel-panel phase4-interview-intel">' +
        '<div class="phase4-intel-head">' +
          '<div><p class="eyebrow">Phase 4 intelligence</p><h2>Interview preparation built from role evidence.</h2><p>Research, likely process, questions, weak-area drills, and mock scoring now sit in one preparation model.</p></div>' +
          '<span class="chip ' + (intel.sourceConfidence === "Source-backed" ? "green" : "warning") + '">' + st(intel.sourceConfidence) + '</span>' +
        '</div>' +
        '<div class="phase4-interview-grid">' +
          '<article class="phase4-card phase4-card--wide"><h3>Likely interview process</h3><div class="phase4-process-list">' + process + '</div></article>' +
          '<article class="phase4-card"><h3>Question bank preview</h3><ul class="phase4-list">' + questions + '</ul></article>' +
          '<article class="phase4-card"><h3>Weak-area drills</h3><ul class="phase4-list">' + drills + '</ul></article>' +
          '<article class="phase4-card"><h3>Mock interview rubric</h3><div class="phase4-rubric">' + rubric + '</div></article>' +
          '<article class="phase4-card"><h3>Research sources</h3>' + (sources ? '<ul class="phase4-source-list">' + sources + '</ul>' : '<p class="muted">Run company research to attach source-backed signals and reading links.</p>') + '</article>' +
        '</div>' +
      '</section>'
    );
  }

  function renderPlainApplicationNotes(notes) {
    const st = getSt();
    const blocks = String(notes || "")
      .trim()
      .split(/\n{2,}/)
      .map(function (block) { return block.trim(); })
      .filter(Boolean);
    if (!blocks.length) {
      return '<p>No application notes saved yet.</p>';
    }
    return blocks.map(function (block) {
      return '<p>' + st(block).replace(/\n/g, "<br>") + '</p>';
    }).join("");
  }

  function renderApplicationNotes(app) {
    const notes = String((app && app.notes) || "").trim();
    const formatter = window.CBV2.jobNotes;
    if (notes && formatter && typeof formatter.renderImportedSnapshot === "function") {
      const structured = formatter.renderImportedSnapshot(app, {
        compact: true,
        kicker: "Job-board capture",
        title: "Application notes",
        badge: "Structured"
      });
      if (structured) {
        return '<dd class="interview-application-notes interview-application-notes--structured">' + structured + '</dd>';
      }
    }
    return '<dd class="interview-application-notes">' + renderPlainApplicationNotes(notes) + '</dd>';
  }

  function renderPrepBriefV2(target, model) {
    const st = getSt();
    const app = target.app || {};
    const nextAction = app.nextAction || "Choose a target, run research, generate practice questions, then complete a mock interview.";
    return `
      <article class="interview-side-panel">
        <div class="interview-panel-kicker"><i class="fa-solid fa-crosshairs"></i> Active target</div>
        <h2>${st(target.company)}</h2>
        <p class="interview-role-line">${st(target.role)}</p>
        <dl class="interview-brief-list">
          <div><dt>Pipeline stage</dt><dd>${st(stageLabel(app.stage || target.stage))}</dd></div>
          <div><dt>Next action</dt><dd>${st(nextAction)}</dd></div>
          <div class="interview-brief-notes"><dt>Application notes</dt>${renderApplicationNotes(app)}</div>
        </dl>
        <div class="interview-mini-score">
          <span>Prep coverage</span>
          <div><b style="width:${model.score}%"></b></div>
          <strong>${model.score}%</strong>
        </div>
      </article>`;
  }

  function renderActionPlanV2(model) {
    const actions = [];
    if (!model.hasIntel) actions.push("Run company research to understand process signals and likely topics.");
    if (!model.hasQuestions) actions.push("Generate a role-specific question bank and save first-pass answers.");
    if (!model.hasMock) actions.push("Complete one AI mock interview before the real call.");
    if (!model.hasDebrief) actions.push("Use the debrief to tighten weak stories and follow-up questions.");
    actions.push("Prepare three questions about team expectations, success metrics, and next steps.");
    return (
      '<article class="interview-side-panel interview-action-plan">' +
      '<div class="interview-panel-kicker"><i class="fa-solid fa-route"></i> Next best plan</div>' +
      "<h2>Before the call</h2>" +
      '<ul class="interview-checklist">' +
      actions
        .slice(0, 5)
        .map(function (x, i) {
          return '<li><span>' + String(i + 1).padStart(2, "0") + "</span><p>" + getSt()(x) + "</p></li>";
        })
        .join("") +
      "</ul></article>"
    );
  }

  function renderIntelPackV2() {
    const st = getSt();
    const env = viewState.intelPackEnvelope;
    if (!env || !env.data) {
      return '<div class="interview-empty-state"><i class="fa-solid fa-satellite-dish"></i><strong>No briefing yet</strong><span>Run research to build a company-aware prep brief with source links, likely topics, and a practical checklist.</span></div>';
    }
    const d = env.data;
    const themes = Array.isArray(d.suggestedQuestionThemes)
      ? d.suggestedQuestionThemes.slice(0, 6).map(function (x) { return '<span>' + st(String(x)) + "</span>"; }).join("")
      : "";
    const reads = Array.isArray(d.recommendedReads)
      ? d.recommendedReads.slice(0, 4).map(function (r) {
          return (
            '<li><a href="' + st(r.url || "#") + '" target="_blank" rel="noopener noreferrer">' +
            st(String(r.title || "Read")) +
            '</a><p>' + st(String(r.reason || "")) + "</p></li>"
          );
        }).join("")
      : "";
    const checklist = Array.isArray(d.prepChecklist)
      ? d.prepChecklist.slice(0, 6).map(function (x) { return "<li>" + st(String(x)) + "</li>"; }).join("")
      : "";
    const cited = Array.isArray(d.citedInsights)
      ? d.citedInsights.slice(0, 4).map(function (x) {
          return (
            '<li><a href="' + st(x.url || "#") + '" target="_blank" rel="noopener noreferrer">' +
            st(String(x.sourceTitle || "Source")) +
            '</a><p>' + st(String(x.insight || "")) + "</p></li>"
          );
        }).join("")
      : "";
    return `
      <div class="interview-intel-result">
        <section class="intel-overview-block">
          <span>Interview brief</span>
          <p>${st(d.processOverview || "")}</p>
        </section>
        ${themes ? '<section><h3>Question patterns to prepare</h3><div class="interview-chip-cloud">' + themes + "</div></section>" : ""}
        <div class="intel-result-grid">
          ${reads ? '<section><h3>Read before the call</h3><ul class="intel-read-list">' + reads + "</ul></section>" : ""}
        ${checklist ? '<section><h3>Preparation checklist</h3><ul class="interview-bullet-list">' + checklist + "</ul></section>" : ""}
        </div>
        ${cited ? '<section><h3>Source-backed signals</h3><ul class="intel-read-list source-list">' + cited + "</ul></section>" : ""}
        ${d.limitationsNote ? '<p class="intel-limitations">' + st(d.limitationsNote) + "</p>" : ""}
      </div>`;
  }

  function renderIntelPanelV2() {
    const st = getSt();
    const f = viewState.intelForm;
    const includeIntel = viewState.intelIncludeInMock !== false;
    const runDisabled = viewState.intelBusy || viewState.mockBusy || viewState.mockDebriefBusy;
    const hitCount = viewState.intelHits.length;
    const warns = viewState.intelWarnings.length
      ? '<div class="intel-warn"><p class="ai-meta">Search notes</p><ul class="task-list">' +
        viewState.intelWarnings.map(function (w) { return "<li>" + st(String(w)) + "</li>"; }).join("") +
        "</ul></div>"
      : "";
    const hits = hitCount
      ? '<details class="intel-source-drawer"><summary>' + hitCount + ' public sources found</summary><ul class="intel-hits">' +
        viewState.intelHits.slice(0, 8).map(function (h) {
          return (
            '<li class="intel-hit"><a href="' + st((h && h.url) || "#") + '" target="_blank" rel="noopener noreferrer">' +
            st(String((h && h.title) || "Source").slice(0, 140)) +
            '</a><span class="ai-meta">' + st(String((h && h.snippet) || "").slice(0, 180)) + "</span></li>"
          );
        }).join("") +
        "</ul></details>"
      : "";
    return `
      <article class="interview-panel interview-intel-panel">
        <header class="interview-panel-head">
          <div>
            <p class="interview-panel-kicker"><i class="fa-solid fa-building-shield"></i> Company intelligence</p>
            <h2>Research the company like a prepared insider.</h2>
            <p>Build a public-source briefing, identify likely interview angles, and pass the brief into your AI interviewer.</p>
          </div>
          <span class="interview-phase-badge">Phase A</span>
        </header>
        <div class="interview-intel-layout">
          <form id="intel-research-form" class="form-grid interview-form-grid">
            <label>Company<input name="intelCompany" required placeholder="e.g. Stripe" value="${st(f.company)}" /></label>
            <label>Role<input name="intelRole" placeholder="Senior Backend Engineer" value="${st(f.role)}" /></label>
            <label>Brief stage
              <select name="intelStage">
                <option value="screen"${f.stage === "screen" ? " selected" : ""}>Recruiter Screen</option>
                <option value="first"${f.stage === "first" ? " selected" : ""}>First Interview</option>
                <option value="final"${f.stage === "final" ? " selected" : ""}>Final Round</option>
              </select>
            </label>
            <label class="form-row-full intel-check">
              <input type="checkbox" name="intelIncludeMock" ${includeIntel ? "checked" : ""} />
              Use this briefing inside the virtual interview
            </label>
            <div class="form-actions intel-actions">
              <button class="btn-primary" id="intel-run" type="button" ${runDisabled ? "disabled" : ""}>
                <i class="fa-solid fa-magnifying-glass"></i> Build research brief
              </button>
              <button class="btn-secondary" id="intel-copy-mock" type="button">Sync to mock</button>
              <button class="btn-ghost" id="intel-clear" type="button" ${viewState.intelBusy ? "disabled" : ""}>Clear</button>
            </div>
          </form>
          <div class="interview-research-map">
            <strong>Research scope</strong>
            <span><i class="fa-solid fa-check"></i> Official pages and public web snippets</span>
            <span><i class="fa-solid fa-check"></i> Process signals and question themes</span>
            <span><i class="fa-solid fa-check"></i> Reading list and prep checklist</span>
          </div>
        </div>
        ${viewState.intelBusy ? '<p class="ai-meta">Searching public sources and synthesizing the briefing...</p>' : ""}
        ${viewState.intelError ? '<p class="ai-error">' + st(viewState.intelError) + "</p>" : ""}
        ${warns}
        ${renderIntelPackV2()}
        ${hits}
      </article>`;
  }

  function renderDrillStackV2(hiddenAttr) {
    const st = getSt();
    const activeStage = viewState.intelForm.stage || viewState.mockMeta.stage || "first";
    return `
      <section class="drill-stack"${hiddenAttr}>
        <div class="interview-split-grid">
          <article class="interview-panel interview-drill-panel">
            <header class="interview-panel-head compact">
              <div>
                <p class="interview-panel-kicker"><i class="fa-solid fa-list-check"></i> Question drill</p>
                <h2>Practice the questions that matter most.</h2>
              </div>
              <span class="interview-phase-badge">STAR</span>
            </header>
            <form id="interview-form" class="form-grid interview-form-grid">
              <label>Role<input name="role" placeholder="Frontend Engineer" required value="${st(viewState.intelForm.role || viewState.mockMeta.role || "")}" /></label>
              <label>Stage
                <select name="stage">
                  <option value="screen"${activeStage === "screen" ? " selected" : ""}>Recruiter Screen</option>
                  <option value="first"${activeStage === "first" ? " selected" : ""}>First Interview</option>
                  <option value="final"${activeStage === "final" ? " selected" : ""}>Final Round</option>
                </select>
              </label>
              <label class="form-row-full">Focus areas
                <input name="focus" placeholder="Behavioral, system design, React internals..." value="${st(viewState.mockMeta.focus || "")}" />
              </label>
            </form>
            <div id="interview-output" class="interview-question-bank">${viewState.busy ? '<p class="ai-meta">Generating questions...</p>' : renderQuestions()}</div>
          </article>
          <article class="interview-panel interview-practice-panel">
            <header class="interview-panel-head compact">
              <div>
                <p class="interview-panel-kicker"><i class="fa-solid fa-pen-nib"></i> Answer builder</p>
                <h2>Shape stronger stories.</h2>
              </div>
              <span class="interview-phase-badge green">Score</span>
            </header>
            <div id="practice-output">${renderPractice() || '<div class="interview-empty-state"><i class="fa-solid fa-comment-dots"></i><strong>No active question</strong><span>Generate questions, choose one, then write a concise STAR answer with evidence and metrics.</span></div>'}</div>
          </article>
        </div>
        ${renderFeedbackV2()}
      </section>`;
  }

  function renderFeedbackV2() {
    const st = getSt();
    if (!viewState.feedback || !viewState.feedback.length) return "";
    return (
      '<article class="interview-panel interview-coaching-panel">' +
      '<header class="interview-panel-head compact"><div><p class="interview-panel-kicker"><i class="fa-solid fa-lightbulb"></i> Coaching layer</p><h2>What to tighten next</h2></div><span class="interview-phase-badge violet">AI</span></header>' +
      '<ul class="interview-coach-list">' +
      viewState.feedback.map(function (f) { return "<li>" + st(f) + "</li>"; }).join("") +
      "</ul></article>"
    );
  }

  function renderMockDebriefCardV2() {
    const st = getSt();
    if (viewState.mockDebriefBusy) {
      return '<div class="mock-debrief interview-debrief-card"><p class="ai-meta">Generating coaching debrief from your transcript...</p></div>';
    }
    if (!viewState.mockDebrief || !viewState.mockDebrief.data) return "";
    const d = viewState.mockDebrief.data;
    const score = Math.round(Number(d.overallScore) || 0);
    const gaps = Array.isArray(d.topGaps) ? d.topGaps.slice(0, 5) : [];
    const outlines = Array.isArray(d.improvedAnswerOutlines) ? d.improvedAnswerOutlines.slice(0, 4) : [];
    const drills = Array.isArray(d.nextPracticeFocus) ? d.nextPracticeFocus.slice(0, 4) : [];
    return `
      <section class="mock-debrief interview-debrief-card">
        <div class="debrief-score">
          <div class="readiness-orbit small" style="--score:${score}"><strong>${score}</strong><span>score</span></div>
          <div><h3>Session debrief</h3><p>${st(d.summary || "")}</p></div>
        </div>
        <div class="debrief-grid">
          ${gaps.length ? '<section><h4>Top gaps</h4><ul>' + gaps.map(function (g) { return "<li>" + st(g) + "</li>"; }).join("") + "</ul></section>" : ""}
          ${outlines.length ? '<section><h4>Sharper answer outlines</h4><ul>' + outlines.map(function (o) { return "<li>" + st(o) + "</li>"; }).join("") + "</ul></section>" : ""}
          ${drills.length ? '<section><h4>Next drills</h4><ul>' + drills.map(function (x) { return "<li>" + st(x) + "</li>"; }).join("") + "</ul></section>" : ""}
        </div>
      </section>`;
  }

  function renderMockPanelV2() {
    const st = getSt();
    const m = viewState.mockMeta;
    const disabledStart = viewState.mockBusy || viewState.mockDebriefBusy;
    const showReply =
      viewState.mockTranscript.length > 0 &&
      !viewState.mockSessionClosed &&
      !viewState.mockDebriefBusy;
    const replyLocked = viewState.mockBusy || !showReply;
    return `
      <article class="interview-panel mock-panel">
        <header class="interview-panel-head">
          <div>
            <p class="interview-panel-kicker"><i class="fa-solid fa-user-tie"></i> Virtual interview</p>
            <h2>Rehearse with a realistic AI interviewer.</h2>
            <p>Run a multi-turn interview, answer under pressure, and leave with a structured debrief you can act on.</p>
          </div>
          <span class="interview-phase-badge blue">Phase B</span>
        </header>
        <div class="interview-session-grid">
          <form id="mock-session-form" class="form-grid interview-form-grid mock-setup-form">
            <label>Company<input name="mockCompany" placeholder="Acme Inc." value="${st(m.company)}" /></label>
            <label>Role<input name="mockRole" placeholder="Frontend Engineer" required value="${st(m.role)}" /></label>
            <label>Stage
              <select name="mockStage">
                <option value="screen"${m.stage === "screen" ? " selected" : ""}>Recruiter Screen</option>
                <option value="first"${m.stage === "first" ? " selected" : ""}>First Interview</option>
                <option value="final"${m.stage === "final" ? " selected" : ""}>Final Round</option>
              </select>
            </label>
            <label class="form-row-full">Focus areas
              <input name="mockFocus" placeholder="Behavioral, system design, leadership..." value="${st(m.focus)}" />
            </label>
            ${renderPersonaSelector(m.persona || "technical_lead")}
            <label class="form-row-full">Job description
              <textarea name="mockJd" rows="4" placeholder="Paste JD excerpt or key requirements.">${st(m.jd)}</textarea>
            </label>
            <label class="form-row-full mock-check">
              <input type="checkbox" name="mockUseResume" ${m.useResume !== false ? "checked" : ""} />
              Include Resume Lab context for follow-up questions
            </label>
            <div class="form-actions mock-actions">
              <button class="btn-primary" id="mock-start" type="button" ${disabledStart ? "disabled" : ""}>
                <i class="fa-solid fa-phone-volume"></i> Start session
              </button>
              <button class="btn-secondary" id="mock-send-reply" type="button" ${replyLocked ? "disabled" : ""}>Send reply</button>
              <button class="btn-secondary" id="mock-end-early" type="button" ${
                !viewState.mockTranscript.length || viewState.mockSessionClosed || viewState.mockBusy
                  ? "disabled"
                  : ""
              }>End and debrief</button>
              <button class="btn-ghost" id="mock-reset" type="button" ${viewState.mockBusy || viewState.mockDebriefBusy ? "disabled" : ""}>Clear session</button>
            </div>
          </form>
          <aside class="mock-stage-map">
            <strong>Session path</strong>
            <span class="${viewState.mockInterviewerTurns >= 1 ? "is-active" : ""}">Opening</span>
            <span class="${viewState.mockInterviewerTurns >= 2 ? "is-active" : ""}">Behavioral</span>
            <span class="${viewState.mockInterviewerTurns >= 4 ? "is-active" : ""}">Role depth</span>
            <span class="${viewState.mockSessionClosed ? "is-active" : ""}">Debrief</span>
          </aside>
        </div>
        ${viewState.mockError ? '<p class="ai-error">' + st(viewState.mockError) + "</p>" : ""}
        ${renderVoiceToolbar()}
        <div id="mock-transcript-wrap" class="mock-transcript-wrap interview-transcript-wrap">
          ${renderMockTranscript()}
        </div>
        <label class="mock-reply-label interview-reply-box" ${showReply ? "" : "hidden"}>
          <span class="interview-reply-head">
            <span>Your spoken answer</span>
            ${viewState.voiceMode && window.CBV2.interviewVoice && window.CBV2.interviewVoice.isRecognitionSupported()
              ? '<button type="button" id="mock-voice-mic" class="interview-voice-mic ' + (viewState.voiceListening ? "is-listening" : "") + '" title="' + (viewState.voiceListening ? "Stop listening" : "Hold or click to speak") + '">' +
                '<i class="fa-solid ' + (viewState.voiceListening ? "fa-stop" : "fa-microphone") + '"></i> ' +
                (viewState.voiceListening ? "Listening — click to stop" : "Tap to speak") +
              '</button>'
              : ''}
          </span>
          <textarea id="mock-reply-box" rows="4" placeholder="Answer as you would on a live call. Be specific; STAR works well." ${replyLocked ? "disabled" : ""}></textarea>
        </label>
        ${renderMockDebriefCardV2()}
      </article>`;
  }

  // Layout refresh: slim command header. Drops the duplicate readiness
  // strip below (orbit already shows readiness) and drops the
  // drill/mock toggle (replaced by the step rail). Keeps target
  // picker, the page title, and the readiness orbit only.
  function renderSlimHeader(target, model) {
    const st = getSt();
    const next = model.upcoming
      ? st((model.upcoming.title || "Interview") + (model.upcoming.date ? " on " + model.upcoming.date : ""))
      : "No interview date logged";
    return `
      <section class="interview-slim-header">
        <div class="interview-slim-head-copy">
          <p class="eyebrow">Interview Prep</p>
          <h1 class="page-title">Interview Command Center</h1>
          <p class="page-subtitle">A four-step path: research the company, build a question bank, rehearse with an AI interviewer, and review the debrief.</p>
          <label class="interview-target-picker">
            <span>Preparing for</span>
            <select id="interview-target-select" ${target.apps.length ? "" : "disabled"}>
              ${renderTargetOptions(target)}
            </select>
          </label>
        </div>
        <aside class="interview-readiness-card interview-readiness-card--compact" aria-label="Interview readiness">
          <div class="readiness-orbit" style="--score:${model.score}">
            <strong>${model.score}</strong>
            <span>readiness</span>
          </div>
          <div class="readiness-summary">
            <span>Next interview</span>
            <strong>${next}</strong>
          </div>
        </aside>
      </section>`;
  }

  // Layout refresh: step rail replaces the drill/mock toggle. Each step
  // shows a number, a label, and a tiny status dot (done/active/todo)
  // driven by the readiness model. Clicking the rail navigates between
  // steps WITHOUT losing the form values in the other steps.
  function renderStepRail(model) {
    const st = getSt();
    const step = viewState.prepMode || "research";
    const stepCfg = [
      { id: "research", n: 1, label: "Research",     icon: "fa-building-shield", done: !!model.hasIntel },
      { id: "drill",    n: 2, label: "Question Bank", icon: "fa-list-check",      done: !!model.hasQuestions },
      { id: "mock",     n: 3, label: "Mock Interview", icon: "fa-microphone-lines", done: !!model.hasMock },
      { id: "debrief",  n: 4, label: "Debrief",      icon: "fa-clipboard-check", done: !!model.hasDebrief },
    ];
    return (
      '<nav class="interview-step-rail" role="tablist" aria-label="Interview prep steps">' +
        stepCfg.map(function (s) {
          const isActive = s.id === step;
          const status = s.done ? "is-done" : (isActive ? "is-active" : "is-todo");
          return (
            '<button type="button" class="interview-step ' + status + (isActive ? " is-current" : "") + '"' +
              ' id="prep-step-' + s.id + '"' +
              ' role="tab"' +
              ' aria-selected="' + (isActive ? "true" : "false") + '"' +
              ' aria-controls="prep-step-panel-' + s.id + '">' +
              '<span class="interview-step-num">' + s.n + '</span>' +
              '<span class="interview-step-body">' +
                '<i class="fa-solid ' + s.icon + '"></i>' +
                '<strong>' + st(s.label) + '</strong>' +
              '</span>' +
              '<span class="interview-step-dot" aria-hidden="true"></span>' +
            '</button>'
          );
        }).join("") +
      '</nav>'
    );
  }

  // Layout refresh: a single compact sticky sidebar replacing the old
  // PrepBrief + ActionPlan left rail. Shows the active target compact,
  // a mini readiness meter, and a short "next action" line keyed off
  // the current step. The full action plan now lives at the bottom of
  // the Debrief step where it belongs.
  function renderContextSidebar(target, model) {
    const st = getSt();
    const app = target.app || {};
    const step = viewState.prepMode || "research";
    const nextLineByStep = {
      research: !model.hasIntel
        ? "Build a research brief — process signals + likely questions."
        : "Research is complete. Move on to the question bank.",
      drill: !model.hasQuestions
        ? "Generate role-specific practice questions."
        : "Pick a question and shape a STAR answer.",
      mock: !model.hasMock
        ? "Start a virtual interview to rehearse under pressure."
        : "Continue the session or end early for a debrief.",
      debrief: model.hasDebrief
        ? "Review the debrief and queue your next drills."
        : "Complete a mock interview to unlock the debrief.",
    };
    return (
      '<aside class="interview-context-sidebar">' +
        '<div class="interview-context-target">' +
          '<div class="interview-panel-kicker"><i class="fa-solid fa-crosshairs"></i> Active target</div>' +
          '<h3>' + st(target.company) + '</h3>' +
          '<p class="interview-context-role">' + st(target.role) + '</p>' +
          '<dl class="interview-context-meta">' +
            '<div><dt>Stage</dt><dd>' + st(stageLabel(app.stage || target.stage)) + '</dd></div>' +
            '<div><dt>Next action</dt><dd>' + st(nextLineByStep[step] || "Continue prep.") + '</dd></div>' +
          '</dl>' +
        '</div>' +
        '<div class="interview-context-readiness">' +
          '<span>Prep coverage</span>' +
          '<div class="interview-context-meter"><b style="width:' + model.score + '%"></b></div>' +
          '<strong>' + model.score + '%</strong>' +
          '<ul class="interview-context-flags">' +
            '<li class="' + (model.hasIntel ? "is-ready" : "") + '"><i class="fa-solid fa-magnifying-glass-chart"></i> Research</li>' +
            '<li class="' + (model.hasQuestions ? "is-ready" : "") + '"><i class="fa-solid fa-circle-question"></i> Questions</li>' +
            '<li class="' + (model.hasMock ? "is-ready" : "") + '"><i class="fa-solid fa-comments"></i> Mock</li>' +
            '<li class="' + (model.hasResume ? "is-ready" : "") + '"><i class="fa-solid fa-file-lines"></i> Resume</li>' +
          '</ul>' +
        '</div>' +
      '</aside>'
    );
  }

  // Layout refresh: Debrief step content. Combines the feedback list
  // and mock debrief card + the action plan (moved here from the old
  // left rail since it's the "what to do next" view).
  function renderDebriefStep(model) {
    const has = !!viewState.mockDebrief || !!(viewState.feedback && viewState.feedback.length);
    if (!has && !viewState.mockDebriefBusy) {
      return (
        '<article class="interview-panel interview-debrief-empty">' +
          '<header class="interview-panel-head compact">' +
            '<div><p class="interview-panel-kicker"><i class="fa-solid fa-clipboard-check"></i> Debrief</p>' +
            '<h2>Run a mock interview to unlock your debrief.</h2></div>' +
          '</header>' +
          '<p class="ai-meta">After a mock session you\'ll see a structured debrief here: overall score, top gaps, sharper answer outlines, and the next drills to focus on.</p>' +
          '<div class="interview-debrief-empty-cta">' +
            '<button type="button" class="btn-primary" id="prep-step-mock-jump"><i class="fa-solid fa-microphone-lines"></i> Start a mock interview</button>' +
          '</div>' +
        '</article>' +
        renderActionPlanV2(model)
      );
    }
    return (
      renderFeedbackV2() +
      renderMockDebriefCardV2() +
      renderActionPlanV2(model)
    );
  }

  // Layout refresh: new step-based renderer. ONE panel visible at a
  // time. The step rail provides the navigation; the sticky sidebar
  // keeps target context + readiness visible across steps.
  function renderViewV2() {
    hydrateMockIfEmpty();
    hydrateIntelIfEmpty();
    hydrateDrillIfEmpty();
    hydrateActiveRoleContext(false);
    const target = inferActiveTarget();
    const model = readinessModel(target);
    const step = PREP_STEPS.indexOf(viewState.prepMode) >= 0 ? viewState.prepMode : "research";

    // Build the active panel content. We don't render hidden panels at
    // all (saves layout work + DOM weight). State persists in viewState
    // so switching steps doesn't lose form values.
    let activePanel = "";
    if (step === "research") {
      activePanel = renderIntelPanelV2();
    } else if (step === "drill") {
      activePanel = renderDrillStackV2("");
    } else if (step === "mock") {
      activePanel = '<section class="mock-stack">' + renderMockPanelV2() + '</section>';
    } else if (step === "debrief") {
      activePanel = renderDebriefStep(model);
    }

    return `
      <section class="page-container interview-page interview-page--stepped">
        ${renderSlimHeader(target, model)}
        ${renderStepRail(model)}
        <section class="interview-workbench interview-workbench--stepped">
          ${renderContextSidebar(target, model)}
          <main class="interview-main-stack" id="prep-step-panel-${step}" role="tabpanel">
            ${activePanel}
          </main>
        </section>
      </section>
    `;
  }

  window.CBV2.routes.interview = renderViewV2;
  window.CBV2.afterRender.interview = function () {
    // Phase 4.5: persona chip selector lives inside the mock setup form
    // and is rendered on every interview-route render.
    bindPersonaSelector();
    // Phase 4.5 voice: bind voice mode toggle + push-to-talk mic.
    // The bindings are idempotent — bind on every render so they
    // survive view re-renders during streaming.
    bindVoiceControls();
    const targetSelect = document.getElementById("interview-target-select");
    if (targetSelect) {
      targetSelect.addEventListener("change", function () {
        applySelectedTarget(targetSelect.value);
      });
    }
    const gen = document.getElementById("interview-generate");
    const clear = document.getElementById("interview-clear");
    if (gen) {
      gen.addEventListener("click", function () {
        if (!viewState.busy) {
          generateQuestions();
        }
      });
    }
    if (clear) {
      clear.addEventListener("click", resetDrillOnly);
    }
    // Layout refresh: bind the new 4-step rail. Each button maps to
    // a prepMode step. Old prep-mode-drill / prep-mode-mock IDs are
    // gone — the step rail uses prep-step-<id> instead.
    PREP_STEPS.forEach(function (stepId) {
      const btn = document.getElementById("prep-step-" + stepId);
      if (btn) {
        btn.addEventListener("click", function () { setPrepMode(stepId); });
      }
    });
    // Empty-debrief "Start a mock interview" jump button.
    const jumpMock = document.getElementById("prep-step-mock-jump");
    if (jumpMock) {
      jumpMock.addEventListener("click", function () { setPrepMode("mock"); });
    }
    bindQuestionList();
    bindPracticeControls();

    const start = document.getElementById("mock-start");
    if (start) {
      start.addEventListener("click", function () {
        if (!viewState.mockBusy && !viewState.mockDebriefBusy) {
          startMockInterview();
        }
      });
    }
    const sendReply = document.getElementById("mock-send-reply");
    const replyBox = document.getElementById("mock-reply-box");
    if (sendReply) {
      sendReply.addEventListener("click", submitMockReply);
    }
    if (replyBox) {
      replyBox.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.shiftKey && !viewState.mockBusy && !viewState.mockSessionClosed) {
          ev.preventDefault();
          submitMockReply();
        }
      });
    }
    const endEarly = document.getElementById("mock-end-early");
    if (endEarly) {
      endEarly.addEventListener("click", endMockEarly);
    }
    const resetMock = document.getElementById("mock-reset");
    if (resetMock) {
      resetMock.addEventListener("click", resetMockSession);
    }

    const intelRun = document.getElementById("intel-run");
    if (intelRun) {
      intelRun.addEventListener("click", function () {
        if (
          !viewState.intelBusy &&
          !viewState.mockBusy &&
          !viewState.mockDebriefBusy
        ) {
          runCompanyIntelResearch();
        }
      });
    }
    const intelInclude = document.querySelector('[name="intelIncludeMock"]');
    if (intelInclude) {
      intelInclude.addEventListener("change", function () {
        readIntelFormFromDom();
        persistIntelSnapshot();
      });
    }
    const intelClear = document.getElementById("intel-clear");
    if (intelClear) {
      intelClear.addEventListener("click", clearIntelResearch);
    }
    const intelCopyMock = document.getElementById("intel-copy-mock");
    if (intelCopyMock) {
      intelCopyMock.addEventListener("click", applyIntelCompanyToVirtual);
    }

    scrollMockTranscript();
  };
})();
