(function () {
  window.CBJobs = window.CBJobs || {};

  const CONCURRENCY = 3;
  const SCORE_TOP_N = 12;

  function getResumeText() {
    const store = window.CBV2 && window.CBV2.store;
    if (!store) return "";
    if (typeof store.getEffectiveResumeBaseText === "function") {
      const preferred = store.getEffectiveResumeBaseText();
      if (preferred && preferred.trim().length > 10) return preferred;
    }
    const all = store.getAll();
    const base = (all && all.resume && all.resume.base) || "";
    if (base && base.trim().length > 10) return base;
    const tailored = all && all.resume && all.resume.tailored;
    if (tailored && tailored.data) {
      const d = tailored.data;
      const parts = [d.summary || "", (d.keywords || []).join(" "), (d.bullets || []).join(" ")];
      return parts.join("\n");
    }
    return "";
  }

  async function runBatched(tasks, concurrency) {
    const results = new Array(tasks.length);
    let cursor = 0;
    async function worker() {
      while (cursor < tasks.length) {
        const idx = cursor;
        cursor += 1;
        try {
          results[idx] = await tasks[idx]();
        } catch (err) {
          results[idx] = { error: err && err.message ? err.message : String(err) };
        }
      }
    }
    const pool = [];
    for (let i = 0; i < Math.min(concurrency, tasks.length); i += 1) {
      pool.push(worker());
    }
    await Promise.all(pool);
    return results;
  }

  window.CBJobs.hasResume = function () {
    return Boolean(getResumeText().trim());
  };

  window.CBJobs.scoreJobs = async function (jobs, options) {
    options = options || {};
    const resume = options.resume != null ? options.resume : getResumeText();
    const topN = options.topN || SCORE_TOP_N;
    const ai = window.CBAI;
    if (!ai || typeof ai.runSkill !== "function") {
      return { scores: {}, scored: 0, skipped: jobs.length, reason: "AI orchestrator unavailable" };
    }
    if (!resume || !resume.trim()) {
      return { scores: {}, scored: 0, skipped: jobs.length, reason: "No resume content available" };
    }

    const subset = jobs.slice(0, topN);
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    const tasks = subset.map(function (job) {
      return function () {
        return ai
          .runSkill("job-match-score", { resume: resume, job: job })
          .then(function (envelope) {
            const out = {
              jobId: job.id,
              score: envelope.data.score,
              fitSummary: envelope.data.fitSummary,
              reasons: envelope.data.reasons,
              missingSkills: envelope.data.missingSkills,
              provider: envelope.provider,
              promptVersion: envelope.promptVersion
            };
            if (onProgress) onProgress(out);
            return out;
          })
          .catch(function (err) {
            return { jobId: job.id, error: err && err.message ? err.message : "Score failed" };
          });
      };
    });

    const results = await runBatched(tasks, CONCURRENCY);
    const scores = {};
    let scored = 0;
    results.forEach(function (r) {
      if (r && r.jobId && !r.error) {
        scores[r.jobId] = r;
        scored += 1;
      }
    });
    return { scores: scores, scored: scored, skipped: jobs.length - scored, reason: null };
  };

  window.CBJobs.parseQuery = async function (text) {
    const ai = window.CBAI;
    if (!ai || typeof ai.runSkill !== "function") {
      return null;
    }
    try {
      const envelope = await ai.runSkill("query-parse", { text: text });
      return envelope.data;
    } catch (err) {
      return null;
    }
  };
})();
