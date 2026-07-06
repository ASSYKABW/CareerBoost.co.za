// POST /functions/v1/console-ship
// Body: { action: "list" | "deploy" | "reject", number?, reason? }
// Auth: admin role + AAL2/MFA (getAuthedAdmin). Mutations require the
// X-CB-Admin-Nonce CSRF header and are rate-limited + audit-logged.
//
// The "Ship" section: review each agent-fix PR on its Vercel PREVIEW, then
// deploy it. "Deploy" merges the PR into the production branch (main) → Vercel
// ships it live. One fix at a time; the operator is the gate (nothing reaches
// prod without a click here).
//
//   list   → open agent-fix PRs with: title, linked issue, diff stats,
//            mergeability, and the Vercel preview URL (from the GitHub
//            deployment Vercel creates for the PR branch).
//   deploy → squash-merge the PR into main (live). { number }.
//   reject → comment (optional) + close the PR. { number, reason? }.
//
// Server env: GITHUB_TOKEN (required), GITHUB_REPO (default
// ASSYKABW/CareerBoost.co.za), GITHUB_PROD_BRANCH (default "main").
import { errorResponse, handleOptions, jsonResponse, withCors } from "../_shared/cors.ts";
import { getAuthedAdmin } from "../_shared/auth.ts";
import { checkAdminCsrf } from "../_shared/admin-csrf.ts";
import { enforceAdminRate } from "../_shared/admin-rate-limit.ts";
import { extractRequestMeta, logAdminAction } from "../_shared/admin-audit.ts";

const GH_API = "https://api.github.com/";
const AGENT_PREFIX = "agent-fix/"; // must match branch_prefix in agent-fix.yml

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
    "User-Agent": "careerboost-console",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function parseIssue(branch: string, body: string): number | null {
  const b = /(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)/i.exec(body || "");
  if (b) return Number(b[1]);
  const m = /agent-fix\/issue-(\d+)/i.exec(branch || "");
  return m ? Number(m[1]) : null;
}

// The actual Vercel preview URL lives on the GitHub Deployment that Vercel
// creates for the PR head commit (its status carries environment_url). Fall
// back to any vercel target_url on the combined commit status.
async function previewUrl(repo: string, sha: string, H: Record<string, string>): Promise<string | null> {
  try {
    const depR = await fetch(GH_API + "repos/" + repo + "/deployments?sha=" + sha + "&per_page=5", { headers: H });
    if (depR.ok) {
      const deps = await depR.json();
      for (const d of (deps || []).slice(0, 5)) {
        const stR = await fetch(GH_API + "repos/" + repo + "/deployments/" + d.id + "/statuses?per_page=10", { headers: H });
        if (!stR.ok) continue;
        const sts = await stR.json();
        const hit = (sts || []).find((s: Record<string, unknown>) => s.environment_url || s.target_url);
        const url = hit && (hit.environment_url || hit.target_url);
        if (url) return String(url);
      }
    }
  } catch { /* fall through */ }
  try {
    const csR = await fetch(GH_API + "repos/" + repo + "/commits/" + sha + "/status", { headers: H });
    if (csR.ok) {
      const cs = await csR.json();
      const v = (cs.statuses || []).find((s: Record<string, unknown>) => String(s.target_url || "").includes("vercel"));
      if (v && v.target_url) return String(v.target_url);
    }
  } catch { /* none */ }
  return null;
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const action = String(body.action || "list");

  if (action !== "list") {
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
  const prodBranch = Deno.env.get("GITHUB_PROD_BRANCH") || "main";
  if (!token) return errorResponse("GITHUB_TOKEN is not configured on the server.", 503);
  const H = ghHeaders(token);

  // ── list ──────────────────────────────────────────────────────────
  if (action === "list") {
    const prR = await fetch(GH_API + "repos/" + repo + "/pulls?state=open&per_page=50&sort=created&direction=desc", { headers: H });
    if (!prR.ok) {
      const txt = await prR.text().catch(() => "");
      return errorResponse("Could not list PRs (" + prR.status + "): " + txt.slice(0, 200), 502);
    }
    const prs = await prR.json();
    const agent = (prs || []).filter((p: Record<string, unknown>) => {
      const ref = (p.head as Record<string, unknown> | undefined)?.ref;
      return typeof ref === "string" && ref.startsWith(AGENT_PREFIX);
    }).slice(0, 12);

    const items = [];
    for (const p of agent) {
      const num = p.number as number;
      const head = p.head as Record<string, unknown>;
      const sha = String(head.sha || "");
      // Per-PR detail (mergeable + diff stats) + preview URL.
      let mergeable: boolean | null = null, mergeableState = "unknown", changed = 0, adds = 0, dels = 0;
      try {
        const dR = await fetch(GH_API + "repos/" + repo + "/pulls/" + num, { headers: H });
        if (dR.ok) {
          const d = await dR.json();
          mergeable = d.mergeable; mergeableState = d.mergeable_state || "unknown";
          changed = d.changed_files || 0; adds = d.additions || 0; dels = d.deletions || 0;
        }
      } catch { /* keep defaults */ }
      const preview = await previewUrl(repo, sha, H);
      items.push({
        number: num,
        title: String(p.title || ""),
        url: String(p.html_url || ""),
        branch: String(head.ref || ""),
        issue: parseIssue(String(head.ref || ""), String(p.body || "")),
        createdAt: String(p.created_at || ""),
        changedFiles: changed, additions: adds, deletions: dels,
        mergeable, mergeableState,
        previewUrl: preview,
        base: String((p.base as Record<string, unknown> | undefined)?.ref || ""),
      });
    }
    return jsonResponse({ ok: true, prodBranch, repo, prs: items });
  }

  // ── mutations ─────────────────────────────────────────────────────
  const rate = await enforceAdminRate(admin, "console-ship");
  if (!rate.allowed) return errorResponse(rate.reason || "Admin rate limit exceeded.", 429);
  const meta = extractRequestMeta(req);
  const number = Number(body.number || 0);
  if (!number) return errorResponse("A PR number is required.", 400);

  if (action === "deploy") {
    const mR = await fetch(GH_API + "repos/" + repo + "/pulls/" + number + "/merge", {
      method: "PUT",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: "squash" }),
    });
    const mJson = await mR.json().catch(() => ({}));
    if (!mR.ok) {
      await logAdminAction(admin, "ship_deploy", { payload: { number }, resultStatus: "failed", ...meta });
      return errorResponse("Deploy (merge) failed (" + mR.status + "): " + String(mJson.message || "").slice(0, 200), 502);
    }
    await logAdminAction(admin, "ship_deploy", {
      payload: { number, sha: mJson.sha || null, prodBranch }, resultStatus: "success", ...meta,
    });
    return jsonResponse({ ok: true, merged: true, sha: mJson.sha || null, prodBranch });
  }

  if (action === "reject") {
    const reason = String(body.reason || "").trim().slice(0, 500);
    if (reason) {
      await fetch(GH_API + "repos/" + repo + "/issues/" + number + "/comments", {
        method: "POST", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Rejected from the CareerBoost Console: " + reason }),
      }).catch(() => {});
    }
    const cR = await fetch(GH_API + "repos/" + repo + "/pulls/" + number, {
      method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
    if (!cR.ok) {
      const txt = await cR.text().catch(() => "");
      return errorResponse("Could not close PR (" + cR.status + "): " + txt.slice(0, 200), 502);
    }
    await logAdminAction(admin, "ship_reject", { payload: { number, reason: reason || null }, resultStatus: "success", ...meta });
    return jsonResponse({ ok: true, closed: true });
  }

  return errorResponse("Unknown action: " + action, 400);
}));
