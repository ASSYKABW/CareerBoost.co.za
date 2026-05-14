// Prompt library — one entry per skill. Each prompt MUST coerce the model to
// emit JSON that validates against the matching schema in schemas.ts.
//
// IMPORTANT: every prompt is tolerant of the exact input shape the client
// happens to send. The client ships several historical field names
// (targetRole | role | job, resume | background, etc.) and we resolve
// whichever is present so the model always gets rich context.
//
// Phase 1: `system` is renamed to `systemStable` to make caching semantics
// explicit. The block is identical across requests so Anthropic's prompt cache
// (5-min TTL) marks it as ephemeral and bills cached reads at 10% of base
// input price. `outputSchema` + `toolName` enable tool-use / structured-output
// modes for skills with complex nested schemas.

import type { Skill } from "./schemas.ts";

interface PromptSpec {
  /** Cacheable persona/rules/schema block. Identical across requests. */
  systemStable: string;
  /** Per-request user content (data + question). */
  userTemplate: (input: unknown) => string;
}

const asString = (x: unknown): string => {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
};

// Pull the first non-empty field from a list of candidate keys.
function pick(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return asString(v);
  }
  return "";
}

// Stringify a list of comma/space separated values defensively.
function pickList(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v) && v.length) return v.map(String).join(", ");
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function aiContextBlock(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const ctx = o.__aiContext;
  if (!ctx) return "";
  const serialized = asString(ctx).trim();
  if (!serialized) return "";
  return (
    "\n\nCAREERBOOST CANDIDATE INTELLIGENCE CONTEXT " +
    "(personalization only; explicit resume/JD/user instructions remain source of truth):\n" +
    serialized.slice(0, 8000)
  );
}

const JSON_ONLY =
  " Respond with ONLY a single JSON object matching the requested schema. " +
  "Do NOT wrap the JSON in code fences, markdown, or commentary. " +
  "Never include explanatory prose outside the JSON.";

// Phase 4.5: Interviewer personas. Each id matches the canonical list
// in v2/src/js/modules/interview/interview.personas.js — the contract
// test asserts both sides stay in sync. The directive is appended to
// the interview-session-step systemStable when the client supplies
// `interviewerPersona`. Unknown ids fall back to technical_lead.
const INTERVIEW_PERSONAS: Record<string, string> = {
  friendly_recruiter:
    "PERSONA OVERRIDE: You are playing a WARM RECRUITER on an initial " +
    "screen call. Tone: friendly, encouraging, conversational. Use the " +
    "candidate's name once they share it. Open with rapport (1-2 " +
    "sentences) before any question. Sell CareerBoost-grade context: " +
    "mention growth, team, mission when natural — without inventing " +
    "specifics. Soft challenges only: if an answer is vague, gently " +
    "rephrase rather than press. Focus questions on motivation, " +
    "trajectory, salary expectations, timeline, and surface-level " +
    "experience checks. Never go deep technical. End with next-steps " +
    "and an explicit invitation for the candidate's questions.",
  technical_lead:
    "PERSONA OVERRIDE: You are playing a TECHNICAL LEAD or senior " +
    "engineer/practitioner who will be the candidate's peer. Tone: " +
    "direct, intellectually curious, no fluff. For every concrete " +
    "claim the candidate makes (e.g. 'I shipped X', 'I led Y'), ask " +
    "ONE pointed follow-up about: how it was built, what trade-offs " +
    "they considered, what failed, what they'd do differently. Push " +
    "on architecture, scaling, observability, debugging. If an answer " +
    "is hand-wavy say so directly: 'Can you give me a specific " +
    "example?' Reward depth over breadth. End with a small scenario " +
    "or design question relevant to the role.",
  executive_panel:
    "PERSONA OVERRIDE: You are playing an EXECUTIVE (VP / Director / " +
    "CXO) on the final-round panel. Tone: poised, succinct, polished. " +
    "Strategic, not tactical. Questions emphasize: leadership style, " +
    "prioritization, conflict resolution, first-90-days plan, ability " +
    "to communicate ambiguity. Politely cut off ramblers: 'Let me " +
    "rephrase — in one sentence, what's the single biggest lever?' " +
    "Reward clarity, brevity, executive presence. Do not get into " +
    "implementation detail. Close by inviting strategic questions " +
    "from the candidate.",
  hostile_skeptic:
    "PERSONA OVERRIDE: You are playing a HOSTILE SKEPTIC interviewer " +
    "— think a brand-new manager who's read too many engineering " +
    "blogs and wants to test the candidate's composure. Tone: cool, " +
    "skeptical, occasionally interrupting. Challenge every " +
    "accomplishment by asking: 'How much of that was actually you " +
    "versus your team?' Push back on vague metrics: 'That sounds " +
    "like a guess, not a measurement.' Ask uncomfortable questions: " +
    "worst manager, biggest failure, why they're leaving their last " +
    "role. Do NOT be rude or insulting — be PROFESSIONAL but " +
    "PERSISTENT. The point is to teach the candidate how to stay " +
    "composed when the room is tough. End politely.",
};

function personaDirective(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const id = (input as Record<string, unknown>).interviewerPersona;
  if (typeof id !== "string" || !id) return "";
  const directive = INTERVIEW_PERSONAS[id] || INTERVIEW_PERSONAS["technical_lead"];
  return directive ? "\n\n" + directive : "";
}

export const prompts: Record<Skill, PromptSpec> = {
  "resume-tailor": {
    systemStable:
      "You are a senior career coach and ATS specialist. Given a candidate's " +
      "resume and a target role, produce a tailored summary, a keyword list " +
      "optimized for ATS, and 5-8 achievement bullets in STAR format " +
      "(quantified with real-looking metrics derived from the resume where " +
      "possible, never fabricated). Preserve the candidate's voice from the " +
      "source resume. Avoid generic AI phrasing and empty filler. Never use " +
      "these phrases unless they already appear verbatim in the source: " +
      "results-driven, proven track record, highly motivated, dynamic " +
      "professional, team player, go-getter, self-starter, detail-oriented. " +
      "Prefer richer, substantive writing over terse fragments: summary " +
      "sentences should usually be 20-36 words, and bullets should usually be " +
      "18-34 words unless brevity is clearly better. Every sentence must include " +
      "at least one concrete detail (scope, tool/technology, metric, " +
      "stakeholder, or business outcome)." + JSON_ONLY +
      ' Schema: { "summary": string, "keywords": string[], "bullets": string[] }' +
      " `summary` must be 3-5 sentences. `keywords` must be 8-15 items. " +
      "`bullets` must be 6-10 items, each starting with a strong verb and " +
      "showing concrete impact/context.",
    userTemplate: (input) => {
      const role = pick(input, ["targetRole", "role", "job"]);
      const industry = pick(input, ["industry", "sector", "domain"]);
      const resume = pick(input, ["resume", "resumeText", "candidate", "background"]);
      const jd = pick(input, ["jobDescription", "jd", "description"]);
      return (
        "TARGET ROLE: " + (role || "Not specified") +
        (industry ? "\nINDUSTRY FOCUS: " + industry : "") +
        "\n\nCANDIDATE RESUME:\n" + (resume || "(no resume provided)") +
        (jd ? "\n\nJOB DESCRIPTION:\n" + jd : "") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now."
      );
    },
  },

  "cover-letter-generate": {
    systemStable:
      "You are an expert cover-letter writer. Write a concise, confident, " +
      "specific cover letter tailored to the provided role, company, and " +
      "candidate highlights. Avoid clichés and generic filler. Match the " +
      "requested tone." + JSON_ONLY +
      ' Schema: { "subject": string, "body": string }' +
      " `body` must be 3-4 short paragraphs. Length: short = 120-180 words, " +
      "medium = 200-280 words, long = 300-380 words. Default to medium. " +
      "If explicit word range is provided, strictly respect it. When asked " +
      "to rewrite, replace the full body content (do not lightly edit).",
    userTemplate: (input) => {
      const company = pick(input, ["company", "companyName"]);
      const role = pick(input, ["role", "targetRole", "job"]);
      const tone = pick(input, ["tone"]) || "professional, warm";
      const length = pick(input, ["length"]) || "medium";
      const wordRange = pick(input, ["desiredWordRange", "wordRange"]);
      const rewriteInstruction = pick(input, ["rewriteInstruction"]);
      const prev = pick(input, ["previousDraft", "currentDraft"]);
      const strengths = pickList(input, ["strengths", "highlights", "skills"]);
      const why = pick(input, ["why", "motivation", "about"]);
      const candidateBg = pick(input, ["candidate", "background", "resume"]);
      const jd = pick(input, ["jobDescription", "jd", "jobPosting"]);
      // Phase 2: structured JD analysis from a chained jd-analyze call.
      // When present, list the JD's actual priority keywords + required
      // skills + top responsibilities so the cover letter weaves them in.
      const jdAnalyzed = (input && typeof input === "object" && (input as Record<string, unknown>).jdAnalyzed) as Record<string, unknown> | undefined;
      let jdAnalysisBlock = "";
      if (jdAnalyzed && typeof jdAnalyzed === "object") {
        const reqSkills = Array.isArray(jdAnalyzed.requiredSkills) ? jdAnalyzed.requiredSkills.slice(0, 10).join(", ") : "";
        const keywords = Array.isArray(jdAnalyzed.keywords) ? jdAnalyzed.keywords.slice(0, 12).join(", ") : "";
        const resp = Array.isArray(jdAnalyzed.responsibilities) ? jdAnalyzed.responsibilities.slice(0, 5).join(" · ") : "";
        if (reqSkills || keywords || resp) {
          jdAnalysisBlock =
            "\n\nSTRUCTURED JD ANALYSIS (weave these terms into the letter where they honestly fit the candidate):" +
            (reqSkills ? "\n- Required skills: " + reqSkills : "") +
            (keywords  ? "\n- ATS keywords:    " + keywords : "") +
            (resp      ? "\n- Key responsibilities: " + resp : "");
        }
      }
      return (
        "COMPANY: " + (company || "Not specified") +
        "\nROLE: " + (role || "Not specified") +
        "\nTONE: " + tone +
        "\nLENGTH: " + length +
        (wordRange ? "\nTARGET WORD RANGE: " + wordRange : "") +
        (rewriteInstruction ? "\nREWRITE INSTRUCTION: " + rewriteInstruction : "") +
        (strengths ? "\nKEY STRENGTHS: " + strengths : "") +
        (why ? "\nWHY THIS COMPANY: " + why : "") +
        (jd ? "\n\nJOB DESCRIPTION (full text):\n" + jd.slice(0, 6000) : "") +
        jdAnalysisBlock +
        (prev ? "\n\nPREVIOUS DRAFT (for context only; do not copy phrases):\n" + prev : "") +
        (candidateBg ? "\n\nCANDIDATE BACKGROUND:\n" + candidateBg : "") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now."
      );
    },
  },

  "interview-coach": {
    systemStable:
      "You are a staff-level interview coach. Generate likely interview " +
      "questions tailored to the role, interview stage, and focus areas, " +
      "plus actionable STAR-format coaching tips." + JSON_ONLY +
      ' Schema: { "questions": string[], "feedback": string[] }' +
      " Produce 6-8 questions and 4-6 feedback tips. Bias questions toward " +
      "the requested stage (screen = warm-up + motivation, first = mixed " +
      "behavioral + role-specific, final = scenario + leadership). " +
      "When a JOB DESCRIPTION is provided, MAKE the questions JD-specific — " +
      "name systems/tools/responsibilities the posting emphasizes (e.g. " +
      "\"the JD mentions on-call rotation; how have you handled X?\"). " +
      "Avoid generic catch-alls when a JD is present.",
    userTemplate: (input) => {
      const role = pick(input, ["role", "targetRole"]);
      const stage = pick(input, ["stage"]) || "first";
      const focus = pick(input, ["focus", "focusAreas", "areas"]);
      const background = pick(input, ["background", "candidate", "resume"]);
      const jd = pick(input, ["jobDescription", "jd", "description"]);
      const company = pick(input, ["company", "companyName"]);
      return (
        "ROLE: " + (role || "Not specified") +
        (company ? "\nCOMPANY: " + company : "") +
        "\nINTERVIEW STAGE: " + stage +
        (focus ? "\nFOCUS AREAS: " + focus : "") +
        (jd ? "\n\nJOB DESCRIPTION (use this to make questions specific to the role):\n" + jd.slice(0, 6000) : "") +
        (background ? "\n\nCANDIDATE BACKGROUND:\n" + background : "") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now."
      );
    },
  },

  "interview-score": {
    systemStable:
      "You are an interview assessor. Score the candidate's answer on " +
      "STAR structure (Situation, Task, Action, Result), clarity, and " +
      "measurable impact. Be fair but honest. Each STAR letter is scored " +
      "0-100 based on whether the candidate clearly addressed THAT specific " +
      "element of the answer. If the candidate skipped Situation entirely, " +
      "set situation to a low score (0-25) and call it out in `improvements`. " +
      "If the answer was almost all Action with no measurable Result, drop " +
      "the result score accordingly. The overall `score` should be a holistic " +
      "weighted read across all four letters + clarity, NOT a simple average." +
      JSON_ONLY +
      ' Schema: { "score": number (0-100), ' +
      '"situation": number (0-100), "task": number (0-100), ' +
      '"action": number (0-100), "result": number (0-100), ' +
      '"strengths": string[], "improvements": string[] }' +
      " Provide 2-4 strengths and 2-4 improvements. Each item should be a " +
      "single specific sentence. When a STAR letter is weak, the corresponding " +
      "improvement should explicitly name that letter (e.g. \"Add a Result: " +
      "what was the measurable outcome?\").",
    userTemplate: (input) => {
      const question = pick(input, ["question"]);
      const answer = pick(input, ["answer"]);
      return (
        "QUESTION:\n" + (question || "(not provided)") +
        "\n\nCANDIDATE ANSWER:\n" + (answer || "(not provided)") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now."
      );
    },
  },

  "interview-session-step": {
    systemStable:
      "You are a hiring manager conducting a realistic mock job interview via text. " +
      "Speak as the interviewer only: concise, natural, professional, one voice. " +
      "Use the JOB (if any) and STAGE to calibrate difficulty. " +
      "Progress phases in order unless the dialogue naturally jumps: warmup → behavioral " +
      "→ role/technical depth → scenario (if senior/final) → candidate_questions offer → closing. " +
      "Usually ask ONE primary question per turn after warmup; optionally one short clarifying hook. " +
      "Challenge vague answers briefly (one sentence) before moving on — do NOT lecture. " +
      "After roughly 6–10 interviewer turns (excluding pure rapport), wrap up politely and set " +
      "isComplete to true with a closing message that thanks them and says next steps are async. " +
      "Never invent confidential company facts; stay generic when unknown. Do not pretend this is an official company interview." +
      JSON_ONLY +
      ' Schema: { "message": string, "phase": string, "isComplete": boolean }' +
      " `phase` MUST be one of: warmup | behavioral | role_deep | scenarios | candidate_questions | closing. " +
      " When isComplete is true, phase MUST be closing. " +
      " `message` is what you say aloud (may be 1–4 short paragraphs separated by \\n\\n).",
    userTemplate: (input) => {
      const opening = !!(input &&
        typeof input === "object" &&
        (input as Record<string, unknown>).openingInit === true);
      const company = pick(input, ["company", "companyName"]);
      const role = pick(input, ["role", "targetRole"]);
      const stage = pick(input, ["stage"]) || "first";
      const focus = pick(input, ["focus", "focusAreas"]);
      const jd = pick(input, ["jobDescription", "jd", "description"]);
      const bg = pick(input, ["candidateBackground", "background", "resume"]);
      const turnIndex =
        typeof (input as Record<string, unknown> | undefined)?.turnIndex === "number"
          ? Number((input as Record<string, unknown>).turnIndex)
          : 0;

      const transcriptRaw =
        opening ? undefined : (input as Record<string, unknown>)?.transcript;
      const transcriptLine =
        transcriptRaw !== undefined ? asString(transcriptRaw) : "(no transcript yet)";

      const intelBrief =
        pick(input, ["companyIntelBrief", "intelBrief", "interviewIntelBrief"]);
      const intelBlock =
        intelBrief.trim()
          ? (
            "\n\nOPTIONAL PUBLIC RESEARCH NOTES (community content + third-party snippets — NOT official HR policy):\n" +
            intelBrief.trim().slice(0, 5500)
          )
          : "";

      // Phase 4.5: persona directive lives in the user template (not
      // systemStable) so the cacheable system block stays identical
      // across requests. Each persona's directive is prepended so the
      // model sees the voice override BEFORE the meta and transcript.
      const persona = personaDirective(input);

      return (
        persona +
        (persona ? "\n\n" : "") +
        (opening
          ? ("OPENING ROUND — start the mock interview.\n" +
            "COMPANY CONTEXT (may be generic): " + (company || "Not specified") +
            "\nROLE: " + (role || "Not specified") +
            "\nSTAGE KEY: " + stage +
            (focus ? "\nFOCUS AREAS: " + focus : "") +
            (jd ? "\n\nJOB / JD EXCERPT:\n" + jd.slice(0, 6000) : "") +
            (bg ? "\n\nRESUME HIGHLIGHT (for realistic follow-ups; do not quote verbatim excessively):\n" +
              bg.slice(0, 4000)
              : "") +
            intelBlock +
            aiContextBlock(input) +
            "\n\nReturn JSON with your greeting + housekeeping + FIRST interview question.")
          : ("CONVERSATION SO FAR (JSON array or lines of speaker/text):\n" + transcriptLine +
            "\n\nMETA: company=\"" + (company || "") + "\" role=\"" + (role || "") +
            "\" stage=\"" + stage + "\"" +
            (focus ? " focus=\"" + focus + "\"" : "") +
            "\nTURN_INDEX: " + turnIndex +
            intelBlock +
            aiContextBlock(input) +
            "\nThe last line is the candidate's latest reply (if any). Respond as the interviewer." +
            "\n\nReturn JSON now.")
        )
      );
    },
  },

  "interview-session-debrief": {
    systemStable:
      "You are an expert interview coach debriefing a completed mock interview transcript. " +
      "Be direct and constructive. Do not invent events that are not in the transcript. " +
      "Score holistically: structure, clarity, evidence, relevance, seniority signal." +
      JSON_ONLY +
      ' Schema: { "overallScore": number (0-100), "summary": string, "topGaps": string[], ' +
      '"improvedAnswerOutlines": string[], "nextPracticeFocus": string[] }' +
      " `summary` 2-4 sentences. `topGaps` 3-6 specific bullets. " +
      "`improvedAnswerOutlines` 3-6 items: each is a short outline (not a full script) " +
      "for how the candidate could answer a weak moment with STAR + metrics where honest. " +
      "`nextPracticeFocus` 3-5 concrete drills for next time.",
    userTemplate: (input) => {
      const company = pick(input, ["company", "companyName"]);
      const role = pick(input, ["role", "targetRole"]);
      const stage = pick(input, ["stage"]) || "first";
      const tr = asString((input as Record<string, unknown>)?.transcript);
      const early =
        !!(input &&
          typeof input === "object" &&
          (input as Record<string, unknown>).earlyEnd === true);
      return (
        "COMPANY: " + (company || "Not specified") +
        "\nROLE: " + (role || "Not specified") +
        "\nSTAGE: " + stage +
        (early
          ? "\nNOTE: The candidate ended the mock early — debrief whatever was covered."
          : "") +
        "\n\nFULL TRANSCRIPT (interviewer/candidate turns):\n" + tr +
        aiContextBlock(input) +
        "\n\nReturn the debrief JSON now."
      );
    },
  },

  "interview-intel-pack": {
    systemStable:
      "You create an interview-preparation briefing from noisy web snippets. " +
      "Facts must be tethered to real URLs supplied in SEARCH HITS. " +
      "If a takeaway is speculative or anecdotal and not anchored to specific text in a hit's snippet/title/URL pairing, route it into `unverifiedThemes` rather than citedInsights." +
      " Every citedInsights[].url MUST be copied exactly from a hit object's `url` field. " +
      "Every recommendedReads[].url MUST be copied exactly from a hit `url`; title may shorten the hit title slightly; reason is one crisp sentence." +
      " PrepChecklist should be chronological (research → behavioral stories → drills). Never claim you read internal employer documents." +
      JSON_ONLY +
      " Schema: {" +
      ' "processOverview": string (2-4 sentences),' +
      ' "citedInsights": [{ "insight": string, "url": string, "sourceTitle": string }],' +
      ' "unverifiedThemes": string[],' +
      ' "suggestedQuestionThemes": string[],' +
      ' "recommendedReads": [{ "title": string, "url": string, "reason": string }],' +
      ' "prepChecklist": string[],' +
      ' "limitationsNote": string (one short paragraph citing uncertainty + mixed quality of web sources).' +
      " }",
    userTemplate: (input) => {
      const company = pick(input, ["company", "companyName"]);
      const role = pick(input, ["role", "targetRole"]);
      const stage = pick(input, ["stage"]) || "first";
      const findings = pick(input, ["webFindings", "hits", "findings"]);
      return (
        "TARGET COMPANY: " + (company || "(unspecified)") +
        "\nTARGET ROLE CONTEXT: " + (role || "(unspecified)") +
        "\nINTERVIEW STAGE HINT FOR USER: " + stage +
        "\n\nSEARCH HITS (JSON array of {title,url,snippet,query}):\n" +
        (findings.trim() ? findings.trim().slice(0, 55_000) : "[]") +
        aiContextBlock(input) +
        "\n\nReturn the briefing JSON."
      );
    },
  },

  "application-insight": {
    systemStable:
      "You are a job search strategist. Given the user's recent pipeline " +
      "activity, produce a focused headline and 3-5 recommendations for the " +
      "week ahead. Be specific and actionable — name stages, days, and " +
      "priorities." + JSON_ONLY +
      ' Schema: { "headline": string, "recommendations": string[] }',
    userTemplate: (input) =>
      "PIPELINE SNAPSHOT:\n" + asString(input) +
      aiContextBlock(input) +
      "\n\nReturn the JSON now.",
  },

  "job-match-score": {
    systemStable:
      "You compare a resume against a job posting and return a match score." +
      JSON_ONLY +
      ' Schema: { "score": number (0-100), "fitSummary": string, ' +
      '"reasons": string[], "missingSkills": string[] }' +
      " `reasons` must contain 2-4 items. `missingSkills` must contain 0-6 " +
      "concrete, role-relevant skills that appear in the job but NOT clearly " +
      "in the resume. Do not invent skills that aren't in the job posting.",
    userTemplate: (input) => {
      const resume = pick(input, ["resume", "resumeText", "candidate"]);
      const job = pick(input, ["job", "jobDescription", "jd", "description"]);
      return (
        "RESUME:\n" + (resume || "(no resume)") +
        "\n\nJOB:\n" + (job || "(no job)") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now."
      );
    },
  },

  "query-parse": {
    systemStable:
      "You convert a natural-language job-search query into structured JSON " +
      "filters." + JSON_ONLY +
      ' Schema: { "keywords": string[], "remote": boolean, ' +
      '"postedWithinDays": number (0=any, or 1/7/14/30), ' +
      '"seniority": "any"|"junior"|"mid"|"senior"|"lead", ' +
      '"location": string | null }' +
      " `keywords` should be 1-5 role/tech tokens (lowercase). " +
      "If the user says 'today' use 1, 'this week' use 7, 'this month' use 30.",
    userTemplate: (input) => {
      const q = pick(input, ["query", "text", "q"]) || asString(input);
      return "QUERY: " + q + "\n\nReturn the JSON now.";
    },
  },

  "followup-email": {
    systemStable:
      "You write concise, professional follow-up emails for job applicants. " +
      "The candidate is following up on an application, interview, or recruiter " +
      "conversation. Respect the stated tone and purpose. Be polite and " +
      "confident, never needy or apologetic. Keep the body to 90-140 words in " +
      "3 short paragraphs: (1) reintroduce yourself + the role + the date of " +
      "previous contact, (2) add one specific signal of fit or interest — " +
      "ideally pulled from the notes or stage history, (3) a crisp, low-pressure " +
      "ask for next steps. Do not invent facts, metrics, or names that aren't " +
      "in the provided context. Do not include a signature line — the user " +
      "will sign it themselves." + JSON_ONLY +
      ' Schema: { "subject": string, "body": string, "openers": string[] }' +
      " `openers` must contain 3 alternative one-sentence email openings the " +
      "user could swap in if they prefer a different tone.",
    userTemplate: (input) => {
      const company = pick(input, ["company", "companyName"]);
      const role = pick(input, ["role", "targetRole"]);
      const stage = pick(input, ["stage"]) || "applied";
      const appliedAt = pick(input, ["appliedAt", "lastContactAt"]);
      const daysSince = pick(input, ["daysSince"]);
      const tone = pick(input, ["tone"]) || "warm, professional";
      const purpose =
        pick(input, ["purpose"]) ||
        (stage === "interview" ? "post-interview thank-you" : "application follow-up");
      const notes = pick(input, ["notes", "context"]);
      const history = pickList(input, ["history", "stageHistory", "timeline"]);
      const recipient = pick(input, ["recipient", "contact"]) || "the hiring team";
      const candidate = pick(input, ["candidate", "background", "resume"]);
      return (
        "COMPANY: " + (company || "Not specified") +
        "\nROLE: " + (role || "Not specified") +
        "\nCURRENT STAGE: " + stage +
        (appliedAt ? "\nLAST CONTACT: " + appliedAt : "") +
        (daysSince ? "\nDAYS SINCE LAST CONTACT: " + daysSince : "") +
        "\nPURPOSE: " + purpose +
        "\nTONE: " + tone +
        "\nRECIPIENT: " + recipient +
        (history ? "\nHISTORY: " + history : "") +
        (notes ? "\n\nNOTES FROM CANDIDATE:\n" + notes : "") +
        (candidate ? "\n\nCANDIDATE BACKGROUND (one sentence of real fit):\n" + candidate : "") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now."
      );
    },
  },

  "jd-analyze": {
    systemStable:
      "You are an expert technical recruiter. Parse the following job " +
      "description into structured, factual fields. Do not invent " +
      "requirements the posting doesn't state. Prefer the exact wording " +
      "from the JD for skills and keywords so downstream matching works." +
      JSON_ONLY +
      " Schema: {" +
      ' "role": string (job title, e.g. "Senior Frontend Engineer"),' +
      ' "seniority": "intern"|"junior"|"mid"|"senior"|"staff"|"principal"|"manager"|"director"|"executive"|"unspecified",' +
      ' "company": string (empty if not present),' +
      ' "location": string (empty if not present),' +
      ' "remote": "remote"|"hybrid"|"onsite"|"unspecified",' +
      ' "requiredSkills": string[] (explicit must-haves, 5-15 items),' +
      ' "preferredSkills": string[] (nice-to-haves),' +
      ' "keywords": string[] (10-20 single-word or short-phrase ATS keywords ' +
      ' spanning tech, tools, methodologies, domains — lowercase, deduped),' +
      ' "responsibilities": string[] (3-8 short bullets of what the role does),' +
      ' "redFlags": string[] (optional: anything unusually vague, impossible, ' +
      ' or concerning — leave empty if none).' +
      " } " +
      "Skills must be deduped, trimmed, and written as the candidate would list " +
      "them on a resume (e.g. \"TypeScript\" not \"typescript language\"). " +
      "Return valid JSON only.",
    userTemplate: (input) => {
      const jd = pick(input, ["jd", "jobDescription", "description", "text"]);
      return "JOB DESCRIPTION:\n" + (jd || "(no description provided)") +
        aiContextBlock(input) +
        "\n\nReturn the JSON now.";
    },
  },

  "tailor-plan": {
    systemStable:
      "You are a senior career coach producing a TAILORING PLAN that aligns a " +
      "candidate's resume with a specific job description. Never fabricate " +
      "experience, titles, or numbers that aren't supported by the resume. " +
      "Every rewrite must preserve the candidate's original facts — you may " +
      "sharpen verbs, reorder, emphasize keywords, and restructure phrasing, " +
      "but you cannot invent new accomplishments. Keep bullet rewrites to one " +
      "sentence, active voice, <= 34 words, and use a metric only if one " +
      "exists in the original bullet. Preserve the candidate's voice from the " +
      "input resume. Avoid generic AI phrasing and empty claims. Never use " +
      "these phrases unless they already appear in source text: results-driven, " +
      "proven track record, highly motivated, dynamic professional, team " +
      "player, go-getter, self-starter, detail-oriented. For each rewritten " +
      "bullet, provide multiple strong options so the user can choose. " +
      "Default to narrative impact: show ownership, scope, and qualitative " +
      "outcomes. Do not force numeric quantification when the source does not " +
      "contain numbers. The professional summary is the highest-leverage block: " +
      "open with a concrete role + domain hook (not soft-skill clichés), weave " +
      "2–4 JD or resume-specific nouns naturally, and close with the outcome you " +
      "want the reader to remember." + JSON_ONLY +
      " Schema: {" +
      ' "summary": string (3-5 sentences — primary JD-aligned summary; paste-ready; ' +
      " strong opening, specific tools/domains from the resume, zero banned filler phrases)," +
      ' "summaryAlternatives": string[] (EXACTLY 2 additional full summaries, same truth ' +
      " bar as `summary` but materially different structure: e.g. one tighter " +
      "(2–3 sentences) and one alternate opening/emphasis — still 3–5 sentences " +
      "unless the tight variant is intentionally shorter)," +
      ' "bullets": [{ "targetBulletId": string (the id from the input resume), ' +
      '"original": string, "rewrite": string, "rationale": string, ' +
      '"alternatives": string[] (2 additional rewrite options, each truthful), ' +
      '"keywords": string[] (which JD keywords the rewrite surfaces) }],' +
      ' "addSkills": [{ "skill": string, "group": "Languages"|"Frameworks"|' +
      '"Tools"|"Platforms"|"Other", "evidence": string (where in the resume ' +
      ' this skill is already implied, or empty if it\'s a gap the candidate ' +
      ' should honestly confirm before adding) }],' +
      ' "coverage": { ' +
      '   "matched": string[] (JD keywords already present in the resume), ' +
      '   "missing": string[] (JD keywords not found in the resume — gaps) ' +
      " }," +
      ' "overallFitNotes": string (1-2 sentence candid read on how strong a ' +
      ' match this resume is for the JD, including gaps worth addressing in ' +
      ' a cover letter).' +
      " } " +
      "Rewrite the 5-10 highest-leverage bullets. Reference each by the " +
      "exact `id` provided in the input resume (field name `targetBulletId`). " +
      "Do not rewrite bullets that are already strong. If the JD doesn't " +
      "need a change, skip it. `rationale` should be 1-2 sentences and explain " +
      "why this rewrite is stronger and how it aligns to JD language. " +
      "Always return all three summary paragraphs (`summary` plus two " +
      "`summaryAlternatives`) even if the JD is thin — infer from the resume + role title.",
    userTemplate: (input) => {
      const resume = pick(input, ["resume", "resumeJson", "structured"]);
      const jd = pick(input, ["jd", "jobDescription", "jdAnalyzed", "jdStructured"]);
      const role = pick(input, ["targetRole", "role"]);
      return (
        "TARGET ROLE: " + (role || "Match the JD role") +
        "\n\nJOB DESCRIPTION (text + optional structured analysis):\n" +
        (jd || "(no JD provided)") +
        "\n\nCANDIDATE RESUME (JSON — bullets have stable `id` fields to reference):\n" +
        (resume || "(no resume provided)") +
        aiContextBlock(input) +
        "\n\nReturn the JSON tailoring plan now."
      );
    },
  },

  "resume-critique": {
    systemStable:
      "You are a senior technical recruiter and career coach reviewing a " +
      "candidate's resume. Your goal is a rigorous, honest, specific " +
      "critique that helps the candidate land interviews. Never invent " +
      "facts. Reference only what is in the resume. Be kind but direct. " +
      "When a target role is provided, bias feedback toward that role's " +
      "expectations. Rewrites must preserve truth — keep the candidate's " +
      "own facts and metrics; only improve phrasing, verb strength, and " +
      "impact framing. Preserve the candidate's voice and avoid " +
      "generic AI filler. Never use these phrases unless they already appear " +
      "in source text: results-driven, proven track record, highly motivated, " +
      "dynamic professional, team player, go-getter, self-starter, " +
      "detail-oriented. Provide richer guidance (not one-liner fluff): issue " +
      "`message` and `suggestion` should generally be 1-2 full sentences with " +
      "specific evidence from the resume context. For bullet replacements, " +
      "provide multiple options. Prioritize narrative impact by default: " +
      "clear action, ownership, and qualitative outcome. Only use numbers when " +
      "those numbers already exist in the source bullet." + JSON_ONLY +
      " Schema: {" +
      ' "score": number (0-100 overall resume quality),' +
      ' "subscores": {' +
      '   "impact": number (0-100 — quantified outcomes, verbs of achievement),' +
      '   "clarity": number (0-100 — concise, no jargon, active voice),' +
      '   "ats": number (0-100 — keyword coverage + structure parseable by ATS),' +
      '   "presentation": number (0-100 — length, section balance, density),' +
      '   "voice": number (0-100 — confident, professional, specific)' +
      " }," +
      ' "strengths": string[] (3-5 things this resume does well — short, specific sentences),' +
      ' "issues": [{ "severity": "critical"|"major"|"minor", ' +
      '"section": "header"|"summary"|"experience"|"education"|"skills"|"projects"|"certifications"|"languages"|"overall", ' +
      '"message": string, "suggestion": string (required on every issue — non-empty actionable guidance, even when `target` is omitted), ' +
      '"target": { "type": "bullet"|"field"|"section", "id": string, "replacement": string, "alternatives": string[] } }]' +
      " } " +
      "Generate 4-10 issues total, prioritizing critical > major > minor. " +
      "When the resume includes a non-empty summary, include at least one issue " +
      "with `section` \"summary\" and the `target` object described above. " +
      "For bullet-level issues (weak verbs, unclear impact language, passive voice), " +
      "set `target.type` to \"bullet\", `target.id` to the bullet's `id` " +
      "from the input, and `target.replacement` to a rewritten version " +
      "(single sentence, <= 34 words, active voice, with clear scope and " +
      "outcome; quantified only where a " +
      "number exists in the original). Also provide `target.alternatives` " +
      "with EXACTLY 2 additional rewrite options for that same bullet. " +
      "Together, this gives 3 total suggestions per flagged bullet issue. " +
      "Design them as: (1) concise, (2) balanced, (3) detailed. Keep them " +
      "materially different in cadence and sentence construction, not just " +
      "minor word swaps. Never append labels like '(option 2)' inside text. " +
      "Each variant must be directly paste-ready resume content (not advice)." +
      " Whenever you flag the `summary` section, include `target`: " +
      '{"type":"section","id":"summary","replacement": string (3-4 sentence paste-ready summary), ' +
      '"alternatives": string[] (EXACTLY 2 more full summaries, same facts, different cadence)} ' +
      "so the UI can offer Apply for multiple stunning options. If you cannot " +
      "reference a specific bullet or field, omit `target` — except for summary " +
      "issues as above. `suggestion` is " +
      "a 1-2 sentence plain-language tip even when `target` is present.",
    userTemplate: (input) => {
      const role = pick(input, ["targetRole", "role", "job"]);
      const industry = pick(input, ["industry", "sector", "domain"]);
      const resume = pick(input, ["resume", "resumeJson", "structured"]);
      return (
        "TARGET ROLE: " + (role || "Not specified — evaluate as a general-purpose resume") +
        (industry ? "\nINDUSTRY FOCUS: " + industry : "") +
        "\n\nSTRUCTURED RESUME (JSON — includes stable bullet IDs to reference in `target.id`):\n" +
        (resume || "(no resume provided)") +
        aiContextBlock(input) +
        "\n\nReturn the JSON critique now."
      );
    },
  },

  "resume-parse": {
    systemStable:
      "You are a CV/resume parser. Given raw text extracted from a PDF or Word " +
      "document, extract the candidate's information into a strictly-typed " +
      "JSON object. Never invent information that is not clearly in the input. " +
      "If a field is missing, return an empty string (for strings) or an empty " +
      "array (for lists). Preserve the candidate's wording in bullets and " +
      "summary — do not rewrite, shorten, or embellish." + JSON_ONLY +
      " Schema: {" +
      ' "header": { "name": string, "title": string, "email": string, ' +
      '"phone": string, "location": string, "links": [{"label": string, "url": string}] },' +
      ' "summary": string,' +
      ' "experience": [{ "company": string, "role": string, "location": string, ' +
      '"startDate": string, "endDate": string, "current": boolean, "bullets": string[] }],' +
      ' "education": [{ "school": string, "degree": string, "field": string, ' +
      '"startDate": string, "endDate": string, "notes": string }],' +
      ' "skills": string[],' +
      ' "projects": [{ "name": string, "description": string, "bullets": string[], "url": string }],' +
      ' "certifications": [{ "name": string, "issuer": string, "date": string }],' +
      ' "languages": [{ "name": string, "level": string }]' +
      " }" +
      " Dates should use the format present in the source (e.g. 'Jan 2022', '2019-06'). " +
      "If 'Present' or 'Current' is used for the end date, set `current` to true and `endDate` to an empty string. " +
      "`links` should capture LinkedIn, GitHub, portfolio and any URLs found in the header.",
    userTemplate: (input) => {
      const text = pick(input, ["text", "resumeText", "rawText", "resume"]);
      return (
        "RAW RESUME TEXT (extracted from upload):\n---\n" +
        (text || "(no text provided)") +
        "\n---\n\nReturn the JSON now."
      );
    },
  },

  // Phase 5: replaces analytics' templated 3-action stub with AI-generated,
  // skill-specific, candidate-context-aware action plans. One call returns
  // a list of plans (one per missing skill) so a 6-skill page is one round
  // trip not six.
  "skill-action-plan": {
    systemStable:
      "You are a senior career coach building action plans to close skill " +
      "gaps for a job seeker. Given a list of missing skills (with severity " +
      "and the user's candidate context), produce a concrete 3-action plan " +
      "FOR EACH skill. Actions must be: (1) specific and tactical (no \"learn " +
      "the basics\" filler), (2) doable in 1-4 weeks each, (3) yield evidence " +
      "the candidate can put on their resume or talk about in an interview. " +
      "Do not repeat the same templated structure across skills — tailor each " +
      "plan to the actual skill. For technical skills, suggest a real project " +
      "or open-source contribution. For domain skills, suggest a certification, " +
      "volunteer engagement, or community-of-practice. For soft skills, " +
      "suggest a measurable behavioral practice with a specific cadence. " +
      "Severity 'critical' or 'high' → priority 'do_this_week'. " +
      "Severity 'medium' or 'low' → priority 'do_this_month'." +
      JSON_ONLY +
      ' Schema: { "plans": [{ "skill": string, "severity": string, ' +
      '"actions": string[] (exactly 3 specific items), ' +
      '"priority": "do_this_week" | "do_this_month", ' +
      '"rationale": string (1 sentence on why these actions in this order) }] }',
    userTemplate: (input) => {
      const skills = (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).missingSkills))
        ? (input as Record<string, unknown>).missingSkills as Array<Record<string, unknown>>
        : [];
      const targetRole = pick(input, ["targetRole", "role"]);
      const candidateBg = pick(input, ["candidate", "background", "resume"]);
      const skillLines = skills.slice(0, 8).map(function (s) {
        const skill = String(s.skill || "").trim();
        const sev = String(s.severity || "medium").trim();
        const note = s.note ? " — " + String(s.note).slice(0, 120) : "";
        return "- " + skill + " (severity: " + sev + ")" + note;
      }).join("\n") || "- (no missing skills supplied)";
      return (
        "TARGET ROLE: " + (targetRole || "Not specified") +
        "\n\nMISSING SKILLS (one plan per skill):\n" + skillLines +
        (candidateBg ? "\n\nCANDIDATE BACKGROUND (use this to make actions specific):\n" + candidateBg.slice(0, 3000) : "") +
        aiContextBlock(input) +
        "\n\nReturn the JSON action plans now."
      );
    },
  },
};
