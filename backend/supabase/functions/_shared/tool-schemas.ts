// JSON schemas for tool-use / structured-output enforcement.
//
// When a skill ships a schema here, the LLM call uses:
//   - Anthropic: tool_use mode (forces strict JSON via tool_choice)
//   - OpenAI:   response_format json_schema strict mode
//   - Gemini:   responseSchema (OpenAPI subset)
//
// Skills WITHOUT a schema fall through to free-form JSON output mode (still
// works, but more likely to need extractJson regex fallback). We add schemas
// only to high-complexity nested skills where JSON shape errors are common.
//
// Schemas use Draft-7-style { type, properties, required, items, enum }
// because that's the lowest common denominator across all three vendors.

import type { Skill } from "./schemas.ts";

const STRING_ARRAY = { type: "array", items: { type: "string" } } as const;

// ---------------------------------------------------------------------------
// resume-tailor
// ---------------------------------------------------------------------------
const RESUME_TAILOR_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keywords: STRING_ARRAY,
    bullets: STRING_ARRAY,
  },
  required: ["summary", "keywords", "bullets"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// tailor-plan — the highest-cost / highest-shape-error skill in the system
// ---------------------------------------------------------------------------
const TAILOR_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    summaryAlternatives: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 },
    bullets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          targetBulletId: { type: "string" },
          original: { type: "string" },
          rewrite: { type: "string" },
          rationale: { type: "string" },
          alternatives: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 },
          keywords: STRING_ARRAY,
        },
        required: ["targetBulletId", "rewrite"],
        additionalProperties: false,
      },
    },
    addSkills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          skill: { type: "string" },
          group: {
            type: "string",
            enum: ["Languages", "Frameworks", "Tools", "Platforms", "Other"],
          },
          evidence: { type: "string" },
        },
        required: ["skill"],
        additionalProperties: false,
      },
    },
    coverage: {
      type: "object",
      properties: {
        matched: STRING_ARRAY,
        missing: STRING_ARRAY,
      },
      required: ["matched", "missing"],
      additionalProperties: false,
    },
    overallFitNotes: { type: "string" },
  },
  required: ["summary", "bullets", "addSkills"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// resume-critique
// ---------------------------------------------------------------------------
const RESUME_CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    subscores: {
      type: "object",
      properties: {
        impact: { type: "number" },
        clarity: { type: "number" },
        ats: { type: "number" },
        presentation: { type: "number" },
        voice: { type: "number" },
      },
      required: ["impact", "clarity", "ats", "presentation", "voice"],
      additionalProperties: false,
    },
    strengths: STRING_ARRAY,
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          section: {
            type: "string",
            enum: [
              "header", "summary", "experience", "education",
              "skills", "projects", "certifications", "languages", "overall",
            ],
          },
          message: { type: "string" },
          suggestion: { type: "string" },
          target: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["bullet", "field", "section"] },
              id: { type: "string" },
              replacement: { type: "string" },
              alternatives: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        required: ["severity", "section", "message", "suggestion"],
        additionalProperties: false,
      },
    },
  },
  required: ["score", "subscores", "strengths", "issues"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// cover-letter-generate
// ---------------------------------------------------------------------------
const COVER_LETTER_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// interview-intel-pack — anti-hallucination schema
// ---------------------------------------------------------------------------
const INTERVIEW_INTEL_SCHEMA = {
  type: "object",
  properties: {
    processOverview: { type: "string" },
    citedInsights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insight: { type: "string" },
          url: { type: "string" },
          sourceTitle: { type: "string" },
        },
        required: ["insight", "url", "sourceTitle"],
        additionalProperties: false,
      },
    },
    unverifiedThemes: STRING_ARRAY,
    suggestedQuestionThemes: STRING_ARRAY,
    recommendedReads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          reason: { type: "string" },
        },
        required: ["title", "url", "reason"],
        additionalProperties: false,
      },
    },
    prepChecklist: STRING_ARRAY,
    limitationsNote: { type: "string" },
  },
  required: [
    "processOverview", "citedInsights", "unverifiedThemes",
    "suggestedQuestionThemes", "recommendedReads", "prepChecklist", "limitationsNote",
  ],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// query-parse
// ---------------------------------------------------------------------------
const QUERY_PARSE_SCHEMA = {
  type: "object",
  properties: {
    keywords: STRING_ARRAY,
    remote: { type: "boolean" },
    postedWithinDays: { type: "number" },
    seniority: { type: "string", enum: ["any", "junior", "mid", "senior", "lead"] },
    location: { type: ["string", "null"] },
  },
  required: ["keywords", "remote", "postedWithinDays", "seniority"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Export map — only skills with a defined schema appear here. Others fall
// through to the free-form JSON output path.
// ---------------------------------------------------------------------------
export const TOOL_SCHEMAS: Partial<Record<Skill, { toolName: string; schema: Record<string, unknown> }>> = {
  "resume-tailor":         { toolName: "emit_resume_tailor",     schema: RESUME_TAILOR_SCHEMA },
  "tailor-plan":           { toolName: "emit_tailor_plan",       schema: TAILOR_PLAN_SCHEMA },
  "resume-critique":       { toolName: "emit_resume_critique",   schema: RESUME_CRITIQUE_SCHEMA },
  "cover-letter-generate": { toolName: "emit_cover_letter",      schema: COVER_LETTER_SCHEMA },
  "interview-intel-pack":  { toolName: "emit_interview_intel",   schema: INTERVIEW_INTEL_SCHEMA },
  "query-parse":           { toolName: "emit_parsed_query",      schema: QUERY_PARSE_SCHEMA },
};
