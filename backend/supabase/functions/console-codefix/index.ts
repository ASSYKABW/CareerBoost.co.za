// POST /functions/v1/console-codefix
// Body: { action: "verify" | "file-issue", incident?, dispatch? }
// Auth: admin role + AAL2/MFA (getAuthedAdmin). Mutations require the
// X-CB-Admin-Nonce CSRF header and are rate-limited + audit-logged.
//
// The "code agent" bridge (Phase D part 2). It does NOT edit production — it
// files a richly-contextualised GitHub issue (labelled `agent-fix`) that a
// coding agent / GitHub Action can pick up to open a PR against `develop`.
// This respects the deploy rule (agent can never touch prod directly).
//
//   verify     → confirm GITHUB_TOKEN reaches GitHub + repo access + label.
//   file-issue → create the issue from an incident; ensures the `agent-fix`
//                label exists first; returns the issue URL + number. Optional
//                dispatch of a workflow when GITHUB_WORKFLOW is configured.
//
// Server env: GITHUB_TOKEN (required), GITHUB_REPO (default
// ASSYKABW/CareerBoost.co.za), GITHUB_WORKFLOW (optional file name for
// workflow_dispatch), GITHUB_BASE_BRANCH (default "develop").
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";

const GH_API = "https://api.github.com/";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
    "User-Agent": "careerboost-console",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ensureLabel(repo: string, token: string): Promise<void> {
  const H = ghHeaders(token);
  const got = await fetch(GH_API + "repos/" + repo + "/labels/agent-fix", { headers: H });
  if (got.status === 200) return;
  // 404 → create it (ignore races / other errors: issue creation still works
  // even if the label add is dropped).
  await fetch(GH_API + "repos/" + repo + "/labels", {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "agent-fix",
      color: "d73a4a",
      description: "Filed by the CareerBoost Console for an automated code fix",
    }),
  }).catch(() => {});
}

function clip(s: unknown, n: number): string {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, n) + "\n…(truncated)" : str;
}

function buildIssueBody(inc: Record<string, unknown>, who: string): string {
  const section = clip(inc.section || "—", 120);
  const severity = clip(inc.severity || "—", 40);
  const when = clip(inc.when || inc.created_at || "—", 80);
  const id = clip(inc.id || "—", 120);
  const desc = clip(inc.body || inc.description || inc.detail || "(no description provided)", 4000);
  const logs = clip(inc.logs || inc.error || "", 6000);

  let md = "**Filed automatically from the CareerBoost Console** by `" + who + "`.\n\n";
  md += "| Field | Value |\n|---|---|\n";
  md += "| Section | " + section + " |\n";
  md += "| Severity | " + severity + " |\n";
  md += "| Detected | " + when + " |\n";
  md += "| Incident ID | `" + id + "` |\n\n";
  md += "### What's wrong\n" + desc + "\n\n";
  if (logs) md += "### Logs / error\n```\n" + logs + "\n```\n\n";
  md += "---\n";
  md += "🤖 Created by the Console code-fix bridge. A coding agent should open a PR " +
    "against `develop` (never `main` directly) and reference this issue.\n";
  return md;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const action = String(body.action || "verify");

  // CSRF before auth on mutations (same order as other console mutations).
  if (action !== "verify") {
    const csrf = checkAdminCsrf(req);
    if (!csrf.ok) return errorResponse(csrf.error, csrf.status);
  }

  let admin;
  try {
    admin = await getAuthedAdmin(req);
  } catch (err) {
    const msg = (err as Error).message || "Admin access denied.";
    return errorResponse(msg, msg.includes("required") ? 403 : 401);
  }

  const token = Deno.env.get("GITHUB_TOKEN") || "";
  const repo = Deno.env.get("GITHUB_REPO") || "ASSYKABW/CareerBoost.co.za";
  if (!token) {
    return errorResponse(
      "GITHUB_TOKEN is not configured on the server — add it in Supabase → Edge Functions → Secrets.",
      503,
    );
  }
  const H = ghHeaders(token);

  // ── verify ────────────────────────────────────────────────────────
  if (action === "verify") {
    const meR = await fetch(GH_API + "user", { headers: H });
    const me = meR.ok ? await meR.json() : null;
    const repoR = await fetch(GH_API + "repos/" + repo, { headers: H });
    const repoJ = repoR.ok ? await repoR.json() : null;
    const labelR = await fetch(GH_API + "repos/" + repo + "/labels/agent-fix", { headers: H });
    return jsonResponse({
      ok: meR.ok && repoR.ok,
      login: me && me.login ? me.login : null,
      repo: repoJ && repoJ.full_name ? repoJ.full_name : null,
      canWrite: !!(repoJ && repoJ.permissions && (repoJ.permissions.push || repoJ.permissions.admin)),
      labelExists: labelR.status === 200,
      userStatus: meR.status,
      repoStatus: repoR.status,
    });
  }

  // ── file-issue (mutation) ─────────────────────────────────────────
  if (action === "file-issue") {
    const rate = await enforceAdminRate(admin, "console-codefix");
    if (!rate.allowed) return errorResponse(rate.reason || "Admin rate limit exceeded.", 429);

    const meta = extractRequestMeta(req);
    const inc = (body.incident && typeof body.incident === "object" ? body.incident : {}) as Record<string, unknown>;
    const rawTitle = String(inc.title || "").trim();
    if (!rawTitle) return errorResponse("incident.title is required.", 400);

    const who = String((admin as { email?: string; id?: string }).email || (admin as { id?: string }).id || "operator");
    const title = "[agent-fix] " + clip(rawTitle, 200);
    const issueBody = buildIssueBody(inc, who);

    await ensureLabel(repo, token);

    const createR = await fetch(GH_API + "repos/" + repo + "/issues", {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: issueBody, labels: ["agent-fix"] }),
    });
    if (!createR.ok) {
      const txt = await createR.text().catch(() => "");
      await logAdminAction(admin, "codefix_file_issue", {
        payload: { section: inc.section || null, title: rawTitle }, resultStatus: "failed", ...meta,
      });
      return errorResponse("GitHub issue creation failed (" + createR.status + "): " + clip(txt, 300), 502);
    }
    const issue = await createR.json();

    // Optional: kick a workflow that runs the coding agent (only when the
    // operator asked AND a workflow file is configured). Best-effort.
    let dispatched = false;
    const workflow = Deno.env.get("GITHUB_WORKFLOW") || "";
    if (body.dispatch === true && workflow) {
      const baseBranch = Deno.env.get("GITHUB_BASE_BRANCH") || "develop";
      const dR = await fetch(GH_API + "repos/" + repo + "/actions/workflows/" + workflow + "/dispatches", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: baseBranch, inputs: { issue: String(issue.number) } }),
      }).catch(() => null);
      dispatched = !!(dR && dR.status === 204);
    }

    await logAdminAction(admin, "codefix_file_issue", {
      payload: { section: inc.section || null, title: rawTitle, issueNumber: issue.number, dispatched },
      resultStatus: "success", ...meta,
    });
    return jsonResponse({
      ok: true,
      issueUrl: issue.html_url,
      issueNumber: issue.number,
      dispatched,
    });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
