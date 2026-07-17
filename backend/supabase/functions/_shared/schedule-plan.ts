// Weekly content schedule planner (Marketing Phase 2).
//
// Pure, deterministic, AI-free. Given the angles this week's market scan
// supports, it decides WHAT gets said on WHICH day, in WHICH format, about
// WHICH segment. Only after that is settled does a model write the words.
//
// This split is the point. The operator's requirement was "change of content,
// not just the same thing" — so variety is a property of the selection rules,
// enforced here and testable, rather than an instruction we hope a model
// honours. It lives in _shared/ (not the function body) so it can be tested
// without standing up an HTTP server.
import type { Angle } from "./market-facts.ts";

export type Cand = { angle: Angle; segment: string; label: string; factsBlock: string };

/**
 * The shape of a week: two long-form pieces, two LinkedIn posts (the lead
 * channel for this audience), one X post. Monday opens with a lead post,
 * Friday closes long.
 */
export const WEEK_PLAN: Array<{ day: string; format: string }> = [
  { day: "Mon", format: "social_linkedin" },
  { day: "Tue", format: "blog" },
  { day: "Wed", format: "social_x" },
  { day: "Thu", format: "social_linkedin" },
  { day: "Fri", format: "blog" },
];

export const MAX_PER_SEGMENT_PER_WEEK = 2;

export interface PlannedSlot {
  dayIdx: number; day: string; date: string; format: string;
  segment: string; label: string; angleId: string; hook: string;
  brief: string; factsBlock: string; salience: number;
}

export function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Fill the week's slots from the candidate angles.
 *
 * HARD rules — these never relax, and a short week is the acceptable price:
 *   1. Never repeat an angle within the week.
 *   2. At most MAX_PER_SEGMENT_PER_WEEK slots per segment.
 *
 * PREFERENCES — relaxed in this order when they cannot all be satisfied:
 *   3. Don't run the same segment two days running.
 *   4. Prefer angles we haven't just published.
 *   5. Among whatever survives, take the most newsworthy (salience).
 *
 * Both hard rules exist for one reason: a week that says the same thing five
 * ways is the exact complaint this engine was built to answer. If only one
 * segment has usable data we publish three good slots, not five padded ones —
 * and the caller reports the short week rather than hiding it.
 */
export function planWeek(cands: Cand[], weekStart: string, recentAngles: Set<string>): PlannedSlot[] {
  const slots: PlannedSlot[] = [];
  const usedAngles = new Set<string>();
  const perSegment: Record<string, number> = {};
  let prevSegment = "";

  for (let i = 0; i < WEEK_PLAN.length; i++) {
    const plan = WEEK_PLAN[i];

    // Hard rules first: distinct angle AND segment under its cap. Anything
    // that fails these is not a candidate at all, however newsworthy it is.
    const eligible = cands.filter((c) =>
      !usedAngles.has(c.angle.id) &&
      (perSegment[c.segment] || 0) < MAX_PER_SEGMENT_PER_WEEK);
    if (!eligible.length) break; // short week, by design

    // Preferences, each relaxed only if it would leave us nothing.
    const tiers = [
      eligible.filter((c) => c.segment !== prevSegment && !recentAngles.has(c.angle.id)),
      eligible.filter((c) => c.segment !== prevSegment),
      eligible,
    ];
    const pool = tiers.find((t) => t.length) as Cand[];
    const chosen = pool.slice().sort((a, b) => b.angle.salience - a.angle.salience)[0];

    usedAngles.add(chosen.angle.id);
    perSegment[chosen.segment] = (perSegment[chosen.segment] || 0) + 1;
    prevSegment = chosen.segment;

    slots.push({
      dayIdx: i,
      day: plan.day,
      date: addDays(weekStart, i),
      format: plan.format,
      segment: chosen.segment,
      label: chosen.label,
      angleId: chosen.angle.id,
      hook: chosen.angle.hook,
      brief: chosen.angle.brief,
      factsBlock: chosen.factsBlock,
      salience: chosen.angle.salience,
    });
  }
  return slots;
}
