// Job Scout Agent health — is the agent system actually working?
//
// Surfaced in the Console "AI & Health" section (console-ai-health) and checked
// by the daily health-notify (job-scout). Signals:
//   - auto agents that haven't been scanned by the cron in a while → the
//     scheduler may be down (GitHub secret missing, function erroring).
//   - recent scan failures recorded in last_run_stats.
//   - delivery volume over 7d (proof the pipeline is producing value).
import { getServiceClient } from "./auth.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ScoutHealth {
  status: "healthy" | "warning" | "critical" | "idle";
  totalAgents: number;
  activeAutoAgents: number;   // active + non-manual cadence (should be auto-scanning)
  ranLast24h: number;
  lastCronAt: string | null;
  cronStaleHours: number | null;
  findings7d: number;
  scanErrors24h: number;
  exhaustedTrials: number;
  issues: string[];
}

export async function getScoutHealth(): Promise<ScoutHealth> {
  const svc = getServiceClient();
  const now = Date.now();
  const issues: string[] = [];

  let agents: Array<Record<string, unknown>> = [];
  try {
    const { data } = await svc
      .from("job_scout_agents")
      .select("active, cadence, last_run_at, last_run_stats, scan_count")
      .limit(20000);
    agents = (data || []) as Array<Record<string, unknown>>;
  } catch { /* table may not exist yet */ }

  const totalAgents = agents.length;
  const autoAgents = agents.filter((a) => a.active === true && String(a.cadence || "manual") !== "manual");
  const activeAutoAgents = autoAgents.length;

  let lastCron = 0;
  let ranLast24h = 0;
  let scanErrors24h = 0;
  let exhaustedTrials = 0;
  for (const a of agents) {
    const t = a.last_run_at ? Date.parse(String(a.last_run_at)) : 0;
    if (t) {
      if (t > lastCron) lastCron = t;
      if (now - t <= DAY) ranLast24h += 1;
    }
    const stats = (a.last_run_stats || {}) as Record<string, unknown>;
    const lanes = (stats.lanes || {}) as Record<string, { ok?: boolean }>;
    if (t && now - t <= DAY) {
      const laneFail = ["core", "external", "companies"].some((k) => lanes[k] && lanes[k].ok === false);
      if (laneFail) scanErrors24h += 1;
    }
    // scan_count column only exists post-0052; treat a stopped free trial as "exhausted".
    if (a.active === false && Number(a.scan_count || 0) >= 4) exhaustedTrials += 1;
  }

  const lastCronAt = lastCron ? new Date(lastCron).toISOString() : null;
  const cronStaleHours = lastCron ? Math.round((now - lastCron) / HOUR) : null;

  // 7-day delivery volume.
  let findings7d = 0;
  try {
    const { count } = await svc
      .from("job_scout_findings")
      .select("id", { count: "exact", head: true })
      .gte("found_at", new Date(now - 7 * DAY).toISOString());
    findings7d = count || 0;
  } catch { /* ignore */ }

  // Verdict. The strongest failure signal: auto agents exist but the cron hasn't
  // touched any of them recently → the scheduler is likely down.
  let status: ScoutHealth["status"] = "healthy";
  if (totalAgents === 0) {
    status = "idle";
  } else if (activeAutoAgents > 0 && (cronStaleHours == null || cronStaleHours >= 26)) {
    status = "critical";
    issues.push(
      `${activeAutoAgents} agent${activeAutoAgents === 1 ? "" : "s"} should auto-scan, but the scheduler hasn't run any in ` +
      (cronStaleHours == null ? "a long time" : cronStaleHours + "h") + " — check the Job Scout cron workflow + secret.",
    );
  } else if (scanErrors24h >= Math.max(2, Math.ceil(activeAutoAgents / 2))) {
    status = "warning";
    issues.push(`${scanErrors24h} agent scans hit a search-lane error in the last 24h.`);
  }

  return { status, totalAgents, activeAutoAgents, ranLast24h, lastCronAt, cronStaleHours, findings7d, scanErrors24h, exhaustedTrials, issues };
}
