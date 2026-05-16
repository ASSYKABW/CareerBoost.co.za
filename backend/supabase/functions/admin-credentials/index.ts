// POST /functions/v1/admin-credentials
//
// Admin-only status check for every API key the app depends on. Returns
// "set / not set" for each known Supabase Edge Function secret WITHOUT
// ever returning the value itself.
//
// This powers the admin "API Credentials" panel which surfaces:
//   - which keys are currently configured
//   - which are missing
//   - the copy-paste `npx supabase secrets set ...` command to rotate
//
// Why not also write secrets here?
//   Storing API keys in our database (so the admin UI could "save" them)
//   would put us one RLS bug, one backup, one stray console.log away from
//   global key leakage. Keys live in Supabase's own secret store; rotation
//   happens via the supabase CLI. This function is read-only and never
//   returns secret values.

import { errorResponse, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getAuthedAdmin } from "../_shared/auth.ts";

interface SecretSpec {
  /** Env var name as it appears in supabase secrets. */
  name: string;
  /** Human-readable label for the admin UI. */
  label: string;
  /** Category for grouping in the UI. */
  category: "ai" | "job-boards" | "search" | "billing" | "infrastructure";
  /** Which provider / service this belongs to. Used to group related keys. */
  service: string;
  /** One-line "what breaks without this" hint shown under the row. */
  purpose: string;
  /** Required for the service to work at all. Missing = users see errors. */
  required: boolean;
}

// Catalog of every key we care about. Add new rows here whenever a new
// service ships — the UI auto-renders them. Order = display order.
const CATALOG: SecretSpec[] = [
  // ---- AI providers ----------------------------------------------------
  {
    name: "ANTHROPIC_API_KEY", label: "Anthropic API key",
    category: "ai", service: "Anthropic (Claude)",
    purpose: "Resume tailoring, cover letters, interview prep, AI chat panel — Claude Sonnet + Haiku.",
    required: false,
  },
  {
    name: "OPENAI_API_KEY", label: "OpenAI API key",
    category: "ai", service: "OpenAI",
    purpose: "Follow-up email drafts, jobs-rerank embeddings (text-embedding-3-small), fallback for several skills.",
    required: false,
  },
  {
    name: "GEMINI_API_KEY", label: "Google Gemini API key",
    category: "ai", service: "Google Gemini",
    purpose: "Cheap-tier classifiers: query-parse, job-match-score, jd-analyze (Gemini 2.0 Flash).",
    required: false,
  },
  {
    name: "GROQ_API_KEY", label: "Groq API key",
    category: "ai", service: "Groq",
    purpose: "Optional fallback provider in the LLM routing chain. Skip if you don't use Groq.",
    required: false,
  },

  // ---- Job boards ------------------------------------------------------
  {
    name: "ADZUNA_APP_ID", label: "Adzuna App ID",
    category: "job-boards", service: "Adzuna",
    purpose: "8-country job fan-out in jobs-search. App ID + Key are both required for Adzuna to return any results.",
    required: false,
  },
  {
    name: "ADZUNA_APP_KEY", label: "Adzuna App Key",
    category: "job-boards", service: "Adzuna",
    purpose: "8-country job fan-out in jobs-search. App ID + Key are both required for Adzuna to return any results.",
    required: false,
  },

  // ---- LinkedIn-style external search (Google CSE) --------------------
  {
    name: "GOOGLE_CSE_API_KEY", label: "Google CSE API key",
    category: "search", service: "Google Programmable Search",
    purpose: "LinkedIn / Indeed X-ray search in external-search. Without this CSE results stay empty.",
    required: false,
  },
  {
    name: "GOOGLE_CSE_CX", label: "Google CSE engine ID (cx)",
    category: "search", service: "Google Programmable Search",
    purpose: "The custom search engine id paired with the API key above. Both required together.",
    required: false,
  },

  // ---- Billing ---------------------------------------------------------
  {
    name: "STRIPE_SECRET_KEY", label: "Stripe secret key",
    category: "billing", service: "Stripe",
    purpose: "Checkout sessions + customer portal. Required for paid plans to work.",
    required: false,
  },
  {
    name: "STRIPE_WEBHOOK_SECRET", label: "Stripe webhook signing secret",
    category: "billing", service: "Stripe",
    purpose: "Verifies webhook authenticity in stripe-webhook. Without this, subscription state can't sync.",
    required: false,
  },

  // ---- Infrastructure (managed by Supabase, can't be rotated by us) ---
  {
    name: "SUPABASE_URL", label: "Supabase project URL",
    category: "infrastructure", service: "Supabase",
    purpose: "Auto-set by Supabase. Not rotatable here.",
    required: true,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase service role key",
    category: "infrastructure", service: "Supabase",
    purpose: "Auto-set by Supabase. Rotation is done via the Supabase dashboard, not the CLI.",
    required: true,
  },
];

function isSet(name: string): boolean {
  const v = Deno.env.get(name);
  return typeof v === "string" && v.trim().length > 0;
}

// Provider-level "is this whole service usable?" rollup. A service like
// Adzuna needs BOTH app id AND app key — the UI uses this to render a
// single chip per service instead of two confusing per-env-var chips.
function serviceRollup(items: SecretSpec[]): Record<string, { set: boolean; missing: string[] }> {
  const groups: Record<string, SecretSpec[]> = {};
  for (const item of items) {
    if (!groups[item.service]) groups[item.service] = [];
    groups[item.service].push(item);
  }
  const out: Record<string, { set: boolean; missing: string[] }> = {};
  for (const service of Object.keys(groups)) {
    const members = groups[service];
    const missing = members.filter((m) => !isSet(m.name)).map((m) => m.name);
    out[service] = { set: missing.length === 0, missing };
  }
  return out;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    // getAuthedAdmin validates the caller's JWT AND that their
    // app_metadata.role is in ADMIN_ROLES. Non-admins get 403.
    await getAuthedAdmin(req);
  } catch (err) {
    return errorResponse(String((err as Error).message), 401);
  }

  const status = CATALOG.map((spec) => ({
    name: spec.name,
    label: spec.label,
    category: spec.category,
    service: spec.service,
    purpose: spec.purpose,
    required: spec.required,
    set: isSet(spec.name),
  }));

  return jsonResponse({
    ok: true,
    catalog: status,
    services: serviceRollup(CATALOG),
    // Surfaced to the UI so the copy-paste command can be pre-filled.
    // SUPABASE_URL host parsing → project ref (kddffkhwpbngiupfmcse.supabase.co → kddffkhwpbngiupfmcse).
    projectRef: (function () {
      const url = Deno.env.get("SUPABASE_URL") || "";
      const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\./i);
      return m ? m[1] : "";
    })(),
    generatedAt: new Date().toISOString(),
  });
});
