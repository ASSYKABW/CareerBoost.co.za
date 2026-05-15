(function () {
  function intelCitedInsightRow(v) {
    return Boolean(
      v &&
        typeof v === "object" &&
        typeof v.insight === "string" &&
        typeof v.url === "string" &&
        typeof v.sourceTitle === "string"
    );
  }

  function intelReadRow(v) {
    return Boolean(
      v &&
        typeof v === "object" &&
        typeof v.title === "string" &&
        typeof v.url === "string" &&
        typeof v.reason === "string"
    );
  }

  const skillSchemas = {
    "resume-tailor": function (data) {
      return Boolean(
        data &&
          typeof data.summary === "string" &&
          Array.isArray(data.keywords) &&
          Array.isArray(data.bullets)
      );
    },
    "cover-letter-generate": function (data) {
      return Boolean(data && typeof data.subject === "string" && typeof data.body === "string");
    },
    "interview-coach": function (data) {
      return Boolean(data && Array.isArray(data.questions) && Array.isArray(data.feedback));
    },
    "interview-score": function (data) {
      // Phase 4: STAR sub-scores (situation/task/action/result) are optional —
      // backwards compatible with old server envelopes that don't ship them.
      const isOptNum = function (v) { return v == null || typeof v === "number"; };
      return Boolean(
        data &&
          typeof data.score === "number" &&
          Array.isArray(data.strengths) &&
          Array.isArray(data.improvements) &&
          isOptNum(data.situation) &&
          isOptNum(data.task) &&
          isOptNum(data.action) &&
          isOptNum(data.result)
      );
    },
    "interview-session-step": function (data) {
      return Boolean(
        data &&
          typeof data.message === "string" &&
          typeof data.phase === "string" &&
          typeof data.isComplete === "boolean"
      );
    },
    "interview-session-debrief": function (data) {
      return Boolean(
        data &&
          typeof data.overallScore === "number" &&
          typeof data.summary === "string" &&
          Array.isArray(data.topGaps) &&
          Array.isArray(data.improvedAnswerOutlines) &&
          Array.isArray(data.nextPracticeFocus)
      );
    },
    "interview-intel-pack": function (data) {
      return Boolean(
        data &&
          typeof data.processOverview === "string" &&
          Array.isArray(data.citedInsights) &&
          data.citedInsights.every(intelCitedInsightRow) &&
          Array.isArray(data.unverifiedThemes) &&
          Array.isArray(data.suggestedQuestionThemes) &&
          Array.isArray(data.recommendedReads) &&
          data.recommendedReads.every(intelReadRow) &&
          Array.isArray(data.prepChecklist) &&
          typeof data.limitationsNote === "string"
      );
    },
    "application-insight": function (data) {
      return Boolean(
        data &&
          typeof data.headline === "string" &&
          Array.isArray(data.recommendations)
      );
    },
    "job-match-score": function (data) {
      return Boolean(
        data &&
          typeof data.score === "number" &&
          typeof data.fitSummary === "string" &&
          Array.isArray(data.reasons) &&
          Array.isArray(data.missingSkills)
      );
    },
    "query-parse": function (data) {
      return Boolean(
        data &&
          Array.isArray(data.keywords) &&
          typeof data.remote === "boolean" &&
          typeof data.postedWithinDays === "number" &&
          typeof data.seniority === "string" &&
          (data.location === undefined ||
            data.location === null ||
            typeof data.location === "string")
      );
    },
    "followup-email": function (data) {
      return Boolean(
        data &&
          typeof data.subject === "string" &&
          typeof data.body === "string" &&
          Array.isArray(data.openers)
      );
    },
    "resume-parse": function (data) {
      // Tolerant schema: every section may be empty, but the top-level
      // container + header must exist and `experience` must be an array.
      return Boolean(
        data &&
          typeof data === "object" &&
          data.header &&
          typeof data.header === "object" &&
          Array.isArray(data.experience)
      );
    },
    "resume-critique": function (data) {
      return Boolean(
        data &&
          typeof data === "object" &&
          typeof data.score === "number" &&
          data.subscores &&
          typeof data.subscores === "object" &&
          Array.isArray(data.strengths) &&
          Array.isArray(data.issues)
      );
    },
    "jd-analyze": function (data) {
      return Boolean(
        data &&
          typeof data === "object" &&
          typeof data.role === "string" &&
          Array.isArray(data.requiredSkills) &&
          Array.isArray(data.keywords)
      );
    },
    "tailor-plan": function (data) {
      return Boolean(
        data &&
          typeof data === "object" &&
          typeof data.summary === "string" &&
          Array.isArray(data.bullets) &&
          Array.isArray(data.addSkills) &&
          (!data.summaryAlternatives || Array.isArray(data.summaryAlternatives))
      );
    },
    "skill-action-plan": function (data) {
      return Boolean(
        data &&
          typeof data === "object" &&
          Array.isArray(data.plans) &&
          data.plans.every(function (p) {
            return p && typeof p === "object" &&
              typeof p.skill === "string" &&
              Array.isArray(p.actions);
          })
      );
    },
    "chat-assist": function (data) {
      return Boolean(data && typeof data.reply === "string");
    }
  };

  const promptVersions = {
    "resume-tailor": "resume-tailor@v1.0.0",
    "cover-letter-generate": "cover-letter-generate@v1.0.0",
    "interview-coach": "interview-coach@v1.0.0",
    "interview-score": "interview-score@v1.0.0",
    "interview-session-step": "interview-session-step@v1.0.0",
    "interview-session-debrief": "interview-session-debrief@v1.0.0",
    "interview-intel-pack": "interview-intel-pack@v1.0.0",
    "application-insight": "application-insight@v1.0.0",
    "job-match-score": "job-match-score@v1.0.0",
    "query-parse": "query-parse@v1.0.0",
    "followup-email": "followup-email@v1.0.0",
    "resume-parse": "resume-parse@v1.0.0",
    "resume-critique": "resume-critique@v1.0.0",
    "jd-analyze": "jd-analyze@v1.0.0",
    "tailor-plan": "tailor-plan@v1.0.0",
    "skill-action-plan": "skill-action-plan@v1.0.0",
    "chat-assist": "chat-assist@v1.0.0"
  };

  window.CBAI = window.CBAI || {};
  window.CBAI.schemas = skillSchemas;
  window.CBAI.promptVersions = promptVersions;
})();
