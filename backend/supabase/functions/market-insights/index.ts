// POST /functions/v1/market-insights
// Body: { segment?: string }  — omit for every segment.
// Auth: any signed-in user (self-validated, see config.toml verify_jwt note).
//
// WHY THIS EXISTS
// Analytics could only ever describe the user to themselves: its "missing
// skills" were the skills the user had typed into their own must-have list,
// and its "Benchmark Positioning" compared them to hardcoded constants
// (8 apps/week, 30% interview rate) with no source. Meanwhile marketing-cron
// scans the live SA job market every week — 238 real postings across four
// segments, with skill demand, salary disclosure and remote share — and the
// only thing that ever read it was the admin Console.
//
// This is the read path that closes that gap. market_snapshots is
// service-role-only by design (0054: "Never exposed to the browser"), and that
// stays true: this function reads it with the service client and returns a
// curated, aggregate-only projection. No raw rows, no internals, nothing
// user-specific — the same public market facts for everyone.
//
// Honesty rules carried through from the scan itself:
//   • `sample` always travels with the numbers so the UI can attribute them.
//   • `quotable` (the scan's `sufficient` flag) is false when the sample is too
//     thin to state a percentage — the UI must degrade to words, not figures.
//   • If this week has no scan we serve the most recent week and say so via
//     `stale` + `weekStart`, rather than silently passing off old data as now.
import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getAuthedUser, getServiceClient } from "../_shared/auth.ts";

interface Counted { name?: unknown; share?: unknown; count?: unknown }

function mondayUtc(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

function pct(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function topList(v: unknown, limit: number): Array<{ name: string; share?: number; count?: number }> {
  if (!Array.isArray(v)) return [];
  return (v as Counted[]).slice(0, limit).map((x) => {
    const out: { name: string; share?: number; count?: number } = { name: String(x.name ?? "") };
    const s = pct(x.share);
    if (s !== null) out.share = s;
    const c = Number(x.count);
    if (Number.isFinite(c)) out.count = c;
    return out;
  }).filter((x) => x.name);
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message || "Unauthorized"), 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* body optional */ }
  const wanted = String(body.segment || "").trim().toLowerCase();

  const svc = getServiceClient();
  const thisWeek = mondayUtc(new Date());

  // Newest available week (usually thisWeek; older if no scan has run yet).
  let weekStart = thisWeek;
  try {
    const { data: latest } = await svc
      .from("market_snapshots")
      .select("week_start")
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest && latest.week_start) weekStart = String(latest.week_start);
  } catch (_e) { /* fall through with thisWeek */ }

  let rows: Array<Record<string, unknown>> = [];
  try {
    let q = svc
      .from("market_snapshots")
      .select("segment, label, scanned, sufficient, facts")
      .eq("week_start", weekStart);
    if (wanted) q = q.eq("segment", wanted);
    const { data, error } = await q;
    if (error) return errorResponse("Market lookup failed: " + error.message, 500);
    rows = (data || []) as Array<Record<string, unknown>>;
  } catch (e) {
    return errorResponse("Market lookup failed: " + ((e as Error).message || "unknown"), 500);
  }

  const segments = rows.map((r) => {
    const f = (r.facts || {}) as Record<string, unknown>;
    return {
      segment: String(r.segment ?? ""),
      label: String(r.label ?? r.segment ?? ""),
      sample: Number(r.scanned) || 0,
      // false => the UI must not print a percentage for this segment.
      quotable: !!r.sufficient,
      salaryDisclosedPct: pct(f.salaryDisclosedShare),
      remotePct: pct(f.remoteShare),
      postedLast7dPct: pct(f.postedLast7dShare),
      topSkills: topList(f.topSkills, 8),
      topCities: topList(f.topLocations, 5),
      sources: Array.isArray(f.sources) ? (f.sources as unknown[]).map(String).slice(0, 6) : [],
    };
  }).sort((a, b) => b.sample - a.sample);

  return jsonResponse({
    ok: true,
    weekStart: weekStart,
    stale: weekStart !== thisWeek,
    totalSample: segments.reduce((n, s) => n + s.sample, 0),
    segments: segments,
  });
}));
