// Numeric fact guard for agent-authored marketing copy.
//
// WHY THIS EXISTS
// The Marketing Copilot used to reason from CareerBoost's own analytics, which
// describe a pre-launch product — so it had nothing true to say and reached for
// filler. Giving it the live market scan fixed the input, but not the failure
// mode: asked for a LinkedIn post it produced
//
//   "30% of job postings ... according to our sample of 1,000 job postings"
//
// when the real scan was 238 postings and never said 30%. It invented BOTH the
// share and the sample, and it called save_draft before it read the facts.
//
// A prompt is a request, not a constraint. The weekly planner solved the same
// class of problem structurally — it decides the angle so the model cannot —
// and this does the same for numbers: a draft may only cite figures that exist
// in this week's snapshot. save_draft rejects anything else and hands the model
// the real numbers to rewrite with, so the fabrication never reaches the queue.
//
// Deliberately narrow. It flags the two shapes an invented statistic actually
// takes — a percentage, and a sample size — and ignores everything else, so
// prices (R380/mo), hashtag counts and script timings pass untouched. A guard
// that cries wolf gets removed; this one only speaks when it is right.

/** Every number this week's snapshots support, in canonical form. */
export interface AllowedFacts {
  /** Percentage-ish values (0–100), e.g. 25, 20.6, 10.3 */
  percents: number[];
  /** Whole counts: sample sizes, skill counts, city counts. */
  counts: number[];
}

function walkNumbers(value: unknown, out: number[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "number" && Number.isFinite(value)) { out.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) walkNumbers(v, out, depth + 1); return; }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) walkNumbers(v, out, depth + 1);
  }
}

/**
 * Collect the legal numbers from a set of snapshot rows.
 * `rows` are the market_snapshots records ({ scanned, facts }).
 */
export function allowedFactsFrom(rows: Array<Record<string, unknown>>): AllowedFacts {
  const raw: number[] = [];
  let total = 0;
  for (const r of rows) {
    const scanned = Number(r.scanned) || 0;
    total += scanned;
    raw.push(scanned);
    walkNumbers(r.facts, raw);
  }
  if (total) raw.push(total); // the combined sample is quotable too

  const percents: number[] = [];
  const counts: number[] = [];
  for (const n of raw) {
    if (!Number.isFinite(n)) continue;
    if (n >= 0 && n <= 100) percents.push(n);
    // A share stored as a ratio (0.279) is also legitimately "27.9%".
    if (n > 0 && n < 1) percents.push(n * 100);
    if (Number.isInteger(n) && n >= 0) counts.push(n);
  }
  return { percents, counts };
}

const PCT_RE = /(\d{1,3}(?:[.,]\d+)?)\s*(?:%|per\s?cent|percent)/gi;
// "sample of 1,000", "1 000 postings", "238 job postings", "68 listings/roles/adverts"
const SAMPLE_RE = /(?:sample of\s+|scan(?:ned)? of\s+|across\s+|out of\s+)?(\d[\d\s,.]{0,9}\d|\d)\s*(?:job\s+)?(?:postings?|listings?|adverts?|vacancies|roles?|jobs?)\b/gi;

function toNum(s: string): number {
  return Number(String(s).replace(/[\s,](?=\d{3}\b)/g, "").replace(/\s/g, "").replace(",", "."));
}

/**
 * Numbers the copy claims that this week's scan does not support.
 * Percentages match within `tol` so 10.3% may be written as 10%.
 */
export function offendingClaims(text: string, allowed: AllowedFacts, tol = 0.6): string[] {
  const bad: string[] = [];
  const src = String(text || "");

  PCT_RE.lastIndex = 0;
  for (let m = PCT_RE.exec(src); m; m = PCT_RE.exec(src)) {
    const n = toNum(m[1]);
    if (!Number.isFinite(n)) continue;
    // Rounding in either direction is fine; invention is not.
    const ok = allowed.percents.some((a) => Math.abs(a - n) <= tol || Math.abs(Math.round(a) - n) < 0.001);
    if (!ok) bad.push(m[0].trim());
  }

  SAMPLE_RE.lastIndex = 0;
  for (let m = SAMPLE_RE.exec(src); m; m = SAMPLE_RE.exec(src)) {
    const n = toNum(m[1]);
    if (!Number.isFinite(n) || n < 10) continue; // "3 roles" is prose, not a stat
    if (!allowed.counts.some((a) => a === n)) bad.push(m[0].trim());
  }
  return Array.from(new Set(bad));
}

/** A short, quotable menu of the real numbers, for the rejection message. */
export function factMenu(rows: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const r of rows) {
    const f = (r.facts || {}) as Record<string, unknown>;
    const bits: string[] = [];
    const scanned = Number(r.scanned) || 0;
    if (f.salaryDisclosedShare != null) bits.push(f.salaryDisclosedShare + "% advertise a salary");
    if (f.remoteShare != null) bits.push(f.remoteShare + "% remote-friendly");
    const skills = Array.isArray(f.topSkills) ? (f.topSkills as Array<Record<string, unknown>>).slice(0, 3) : [];
    if (skills.length) bits.push("top skills " + skills.map((s) => s.name + " " + s.share + "%").join(", "));
    parts.push(String(r.label || r.segment) + " (sample " + scanned + "): " + (bits.join("; ") || "no quotable shares"));
  }
  return parts.join(" | ");
}
