// Mirror of client-side AI skill validators (src/js/ai/ai.schemas.js).
// Keep these in sync when you add new skills.

export type Skill =
  | "resume-tailor"
  | "cover-letter-generate"
  | "interview-coach"
  | "interview-score"
  | "interview-session-step"
  | "interview-session-debrief"
  | "interview-intel-pack"
  | "application-insight"
  | "job-match-score"
  | "query-parse"
  | "followup-email"
  | "resume-parse"
  | "resume-critique"
  | "jd-analyze"
  | "tailor-plan"
  | "skill-action-plan"
  | "chat-assist";

type Validator = (data: unknown) => boolean;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isArr = Array.isArray;

function isIntelCitedInsight(v: unknown): boolean {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return isStr(o.insight) && isStr(o.url) && isStr(o.sourceTitle);
}

function isIntelRecommendedRead(v: unknown): boolean {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return isStr(o.title) && isStr(o.url) && isStr(o.reason);
}

export const schemas: Record<Skill, Validator> = {
  "resume-tailor": (d) =>
    isObj(d) && isStr(d.summary) && isArr(d.keywords) && isArr(d.bullets),
  "cover-letter-generate": (d) =>
    isObj(d) && isStr(d.subject) && isStr(d.body),
  "interview-coach": (d) =>
    isObj(d) && isArr(d.questions) && isArr(d.feedback),
  "interview-score": (d) =>
    isObj(d) && isNum(d.score) && isArr(d.strengths) && isArr(d.improvements) &&
    // Phase 4: STAR sub-scores are optional for backwards compatibility — old
    // server responses without them still validate. When present they must be
    // numeric.
    (!("situation" in d) || isNum(d.situation)) &&
    (!("task" in d)      || isNum(d.task)) &&
    (!("action" in d)    || isNum(d.action)) &&
    (!("result" in d)    || isNum(d.result)),
  "interview-session-step": (d) =>
    isObj(d) &&
    isStr(d.message) &&
    isStr(d.phase) &&
    typeof (d as { isComplete?: unknown }).isComplete === "boolean",
  "interview-session-debrief": (d) =>
    isObj(d) &&
    isNum(d.overallScore) &&
    isStr(d.summary) &&
    isArr(d.topGaps) &&
    isArr(d.improvedAnswerOutlines) &&
    isArr(d.nextPracticeFocus),
  "interview-intel-pack": (d) =>
    isObj(d) &&
    isStr(d.processOverview) &&
    isArr(d.citedInsights) &&
    (d.citedInsights as unknown[]).every(isIntelCitedInsight) &&
    isArr(d.unverifiedThemes) &&
    isArr(d.suggestedQuestionThemes) &&
    isArr(d.recommendedReads) &&
    (d.recommendedReads as unknown[]).every(isIntelRecommendedRead) &&
    isArr(d.prepChecklist) &&
    isStr(d.limitationsNote),
  "application-insight": (d) =>
    isObj(d) && isStr(d.headline) && isArr(d.recommendations),
  "job-match-score": (d) =>
    isObj(d) &&
    isNum(d.score) &&
    isStr(d.fitSummary) &&
    isArr(d.reasons) &&
    isArr(d.missingSkills),
  "query-parse": (d) =>
    isObj(d) &&
    isArr(d.keywords) &&
    typeof d.remote === "boolean" &&
    isNum(d.postedWithinDays) &&
    isStr(d.seniority) &&
    (!("location" in d) || d.location === null || isStr(d.location)),
  "followup-email": (d) =>
    isObj(d) && isStr(d.subject) && isStr(d.body) && isArr(d.openers),
  "resume-parse": (d) =>
    isObj(d) && isObj(d.header) && isArr(d.experience),
  "resume-critique": (d) =>
    isObj(d) &&
    isNum(d.score) &&
    isObj(d.subscores) &&
    isArr(d.strengths) &&
    isArr(d.issues),
  "jd-analyze": (d) =>
    isObj(d) &&
    typeof d.role === "string" &&
    isArr(d.requiredSkills) &&
    isArr(d.keywords),
  "tailor-plan": (d) =>
    isObj(d) &&
    typeof d.summary === "string" &&
    isArr(d.bullets) &&
    isArr(d.addSkills) &&
    (!("summaryAlternatives" in d) || isArr(d.summaryAlternatives)),
  "skill-action-plan": (d) =>
    isObj(d) &&
    isArr(d.plans) &&
    (d.plans as unknown[]).every(function (p) {
      if (!isObj(p)) return false;
      const pp = p as Record<string, unknown>;
      return isStr(pp.skill) && isArr(pp.actions);
    }),
  "chat-assist": (d) => isObj(d) && isStr(d.reply),
};

export function validateSkillPayload(skill: string, data: unknown): void {
  const v = schemas[skill as Skill];
  if (!v) throw new Error(`Unknown AI skill: ${skill}`);
  if (!v(data)) throw new Error(`Model output failed the ${skill} schema.`);
}
