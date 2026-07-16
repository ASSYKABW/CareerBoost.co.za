// Market facts — turn a live jobs-search scan into publishable, honest numbers.
//
// WHY: the content engine was told "use ONLY the facts provided" and then given
// no facts, so it could only write generic advice. This builds real facts from
// the live SA job market (via our own jobs-search), which needs zero users —
// unlike the app's own pipeline, which is far too small to generalise from.
//
// HONESTY IS THE WHOLE POINT. Every fact carries the sample it came from, and
// below MIN_SAMPLE we refuse to emit percentages at all — a "61% of roles"
// claim from 12 postings is fabrication with extra steps. Copy must be able to
// say "across 412 postings we scanned this week", or say nothing.

export const MIN_SAMPLE = 25;

export interface ScannedJob {
  title?: string;
  company?: string;
  location?: string;
  remote?: boolean;
  postedAt?: string;
  tags?: string[];
  descriptionText?: string;
  salary?: string;
  employmentType?: string;
  source?: string;
}

export interface Counted { name: string; count: number; share: number }

export interface MarketFacts {
  scanned: number;
  sufficient: boolean;          // false → no percentage claims allowed
  remoteShare: number | null;   // %
  salaryDisclosedShare: number | null;
  postedLast7dShare: number | null;
  topSkills: Counted[];
  topCompanies: Counted[];
  topLocations: Counted[];
  sources: string[];
}

// Deliberately broad + SA-relevant. Matched whole-word against title + tags +
// description, so "R" or "go" style false positives are avoided by requiring
// word boundaries and (for the ambiguous ones) a longer alias.
const SKILL_LEXICON: Array<[string, string[]]> = [
  ["Excel", ["excel"]], ["SQL", ["sql"]], ["Python", ["python"]], ["JavaScript", ["javascript", "js"]],
  ["TypeScript", ["typescript"]], ["React", ["react", "reactjs"]], ["Angular", ["angular"]],
  ["Vue", ["vue", "vuejs"]], ["Node.js", ["node.js", "nodejs"]], ["Java", ["java"]],
  ["C#", ["c#", ".net", "dotnet"]], ["PHP", ["php"]], ["Laravel", ["laravel"]],
  ["AWS", ["aws"]], ["Azure", ["azure"]], ["Google Cloud", ["gcp", "google cloud"]],
  ["Docker", ["docker"]], ["Kubernetes", ["kubernetes", "k8s"]], ["Terraform", ["terraform"]],
  ["Power BI", ["power bi", "powerbi"]], ["Tableau", ["tableau"]], ["SAP", ["sap"]],
  ["Salesforce", ["salesforce"]], ["Figma", ["figma"]], ["Agile", ["agile"]], ["Scrum", ["scrum"]],
  ["Git", ["git", "github", "gitlab"]], ["CI/CD", ["ci/cd", "cicd"]], ["REST APIs", ["rest api", "restful"]],
  ["GraphQL", ["graphql"]], ["Linux", ["linux"]], ["Postgres", ["postgres", "postgresql"]],
  ["MySQL", ["mysql"]], ["MongoDB", ["mongodb"]], ["Redis", ["redis"]],
  ["Machine Learning", ["machine learning"]], ["Data Analysis", ["data analysis", "data analytics"]],
  ["Xero", ["xero"]], ["Pastel", ["pastel"]], ["Sage", ["sage"]], ["QuickBooks", ["quickbooks"]],
  ["IFRS", ["ifrs"]], ["Payroll", ["payroll"]], ["Bookkeeping", ["bookkeeping"]],
  ["Project Management", ["project management", "pmp", "prince2"]],
  ["Stakeholder Management", ["stakeholder"]], ["Customer Service", ["customer service"]],
  ["Sales", ["sales"]], ["Business Development", ["business development"]],
  ["Marketing", ["marketing"]], ["SEO", ["seo"]], ["Google Ads", ["google ads", "adwords"]],
  ["Copywriting", ["copywriting"]], ["Recruitment", ["recruitment"]], ["Matric", ["matric"]],
  ["Driver's Licence", ["driver's licence", "drivers licence", "driver's license"]],
];

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function hasTerm(hay: string, alias: string): boolean {
  // Whole-word-ish: avoids "sql" matching inside "mysql-ish" words while still
  // allowing punctuation-adjacent hits like "C#," or "(agile)".
  const re = new RegExp("(^|[^a-z0-9+#.])" + esc(alias) + "([^a-z0-9+#]|$)", "i");
  return re.test(hay);
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

function rank(map: Map<string, number>, total: number, limit: number): Counted[] {
  return [...map.entries()]
    .filter(([name]) => !!name)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count, share: pct(count, total) }));
}

// Normalise a location to a SA city where we can, so "Sandton, Gauteng" and
// "Johannesburg" don't fragment the ranking into noise.
const CITY_ALIASES: Array<[string, string[]]> = [
  ["Johannesburg", ["johannesburg", "sandton", "midrand", "randburg", "roodepoort", "jhb", "gauteng"]],
  ["Cape Town", ["cape town", "claremont", "century city", "stellenbosch", "western cape", "cpt"]],
  ["Durban", ["durban", "umhlanga", "pinetown", "kwazulu", "kzn"]],
  ["Pretoria", ["pretoria", "centurion", "tshwane"]],
  ["Port Elizabeth", ["port elizabeth", "gqeberha"]],
  ["Bloemfontein", ["bloemfontein"]],
  ["Remote", ["remote", "work from home", "anywhere"]],
];
function normaliseCity(raw: string): string {
  const s = (raw || "").toLowerCase();
  if (!s.trim()) return "";
  for (const [city, aliases] of CITY_ALIASES) {
    if (aliases.some((a) => s.includes(a))) return city;
  }
  return raw.split(",")[0].trim().slice(0, 40);
}

export function buildFacts(jobs: ScannedJob[]): MarketFacts {
  const list = Array.isArray(jobs) ? jobs : [];
  const scanned = list.length;
  const sufficient = scanned >= MIN_SAMPLE;

  const skills = new Map<string, number>();
  const companies = new Map<string, number>();
  const cities = new Map<string, number>();
  const sources = new Set<string>();
  let remote = 0, withSalary = 0, fresh7 = 0;
  const weekAgo = Date.now() - 7 * 86400000;

  for (const j of list) {
    const hay = [j.title || "", (j.tags || []).join(" "), j.descriptionText || ""].join(" ").toLowerCase();
    const seen = new Set<string>();
    for (const [skill, aliases] of SKILL_LEXICON) {
      if (seen.has(skill)) continue;
      if (aliases.some((a) => hasTerm(hay, a))) { skills.set(skill, (skills.get(skill) || 0) + 1); seen.add(skill); }
    }
    const co = (j.company || "").trim();
    if (co) companies.set(co, (companies.get(co) || 0) + 1);
    const city = normaliseCity(j.location || "");
    if (city) cities.set(city, (cities.get(city) || 0) + 1);
    if (j.source) sources.add(String(j.source));
    if (j.remote === true) remote++;
    if ((j.salary || "").trim()) withSalary++;
    const t = j.postedAt ? Date.parse(j.postedAt) : NaN;
    if (!Number.isNaN(t) && t >= weekAgo) fresh7++;
  }

  return {
    scanned,
    sufficient,
    // Below the floor we emit NO shares — the copy must not imply a rate.
    remoteShare: sufficient ? pct(remote, scanned) : null,
    salaryDisclosedShare: sufficient ? pct(withSalary, scanned) : null,
    postedLast7dShare: sufficient ? pct(fresh7, scanned) : null,
    topSkills: rank(skills, scanned, 10),
    topCompanies: rank(companies, scanned, 8),
    topLocations: rank(cities, scanned, 6),
    sources: [...sources].sort(),
  };
}

// ── Angles ──────────────────────────────────────────────────────────────
// Replaces the hardcoded 7-brief rotation. Each angle is derived FROM this
// week's real numbers, so the topic universe changes as the market changes
// instead of looping. Salience = how newsworthy the number actually is this
// week (a 12% salary-disclosure rate is a story; 60% is not), so the engine
// leads with what's genuinely interesting rather than what's next in a list.
export interface Angle {
  id: string;
  salience: number;   // 0..1
  hook: string;       // the concrete, checkable fact
  brief: string;      // what the writer should do with it
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

export function deriveAngles(
  segmentLabel: string,
  facts: MarketFacts,
  prev?: MarketFacts | null,
): Angle[] {
  const out: Angle[] = [];
  if (!facts || !facts.scanned) return out;
  const n = facts.scanned;
  const top = facts.topSkills[0];
  const c1 = facts.topLocations[0];
  const c2 = facts.topLocations[1];

  // Thin samples get angles that need no rate — named examples only.
  if (!facts.sufficient) {
    if (top) {
      out.push({
        id: "skill_examples_small",
        salience: 0.4,
        hook: `${top.name} appeared in ${top.count} of the ${n} ${segmentLabel} roles we scanned`,
        brief: `Write about what ${top.name} is doing to ${segmentLabel} hiring right now. We scanned only ${n} live roles this week, so talk in concrete named examples — do NOT state any percentage or imply a market-wide rate.`,
      });
    }
    return out;
  }

  if (facts.salaryDisclosedShare !== null && facts.salaryDisclosedShare < 40) {
    out.push({
      id: "salary_opacity",
      // The lower the disclosure, the better the story.
      salience: clamp01(1 - facts.salaryDisclosedShare / 40),
      hook: `only ${facts.salaryDisclosedShare}% of ${n} live ${segmentLabel} roles advertise a salary`,
      brief: `Lead with this: across the ${n} live ${segmentLabel} roles CareerBoost scanned for South African job seekers this week, only ${facts.salaryDisclosedShare}% advertised a salary. Make it useful — what a candidate should actually do when the money is hidden (how to research the band, when to name a number, how to ask without killing the offer). Do not moralise; be practical and specific.`,
    });
  }

  if (top && top.share >= 10) {
    out.push({
      id: "skill_lead",
      salience: clamp01(top.share / 40),
      hook: `${top.name} appears in ${top.share}% of ${segmentLabel} postings`,
      brief: `Lead with this: ${top.name} showed up in ${top.share}% (${top.count} of ${n}) of the live ${segmentLabel} roles we scanned this week — the most-requested skill. Give a candidate a concrete way to prove that skill on a CV, and name the runners-up (${facts.topSkills.slice(1, 4).map((s) => `${s.name} ${s.share}%`).join(", ")}).`,
    });
  }

  if (c1 && c2 && c1.count > 0) {
    const close = Math.abs(c1.count - c2.count) <= Math.max(2, c1.count * 0.2);
    out.push({
      id: "geo_split",
      salience: close ? 0.6 : 0.45,
      hook: `${c1.name} ${c1.count} vs ${c2.name} ${c2.count}`,
      brief: `Lead with where the ${segmentLabel} roles actually are this week: ${facts.topLocations.map((c) => `${c.name} ${c.count}`).join(", ")} (of ${n} scanned).${close ? ` ${c1.name} and ${c2.name} are effectively level — that's the hook.` : ""} Make it useful for someone deciding where to look or whether to relocate.`,
    });
  }

  if (facts.remoteShare !== null) {
    out.push({
      id: "remote_share",
      salience: clamp01(Math.abs(facts.remoteShare - 25) / 40 + 0.25),
      hook: `${facts.remoteShare}% of ${segmentLabel} roles are remote-friendly`,
      brief: `Lead with this: ${facts.remoteShare}% of the ${n} live ${segmentLabel} roles we scanned this week were remote-friendly. Be honest about what that means for a South African candidate (competition, time zones, what "remote" actually says in the ad) rather than cheerleading.`,
    });
  }

  if (facts.postedLast7dShare !== null && facts.postedLast7dShare >= 20) {
    out.push({
      id: "freshness",
      salience: clamp01(facts.postedLast7dShare / 70),
      hook: `${facts.postedLast7dShare}% of listings were posted in the last 7 days`,
      brief: `Lead with churn: ${facts.postedLast7dShare}% of the ${n} live ${segmentLabel} roles we scanned were posted in the last 7 days. The practical point is that a list you saw a month ago is mostly dead — argue for a weekly rhythm, and be concrete about what that rhythm looks like.`,
    });
  }

  // Week-over-week beats everything when it's real — but only when both weeks
  // clear the sample floor, otherwise it's noise wearing a suit.
  if (prev && prev.sufficient && facts.sufficient) {
    if (facts.remoteShare !== null && prev.remoteShare !== null) {
      const d = Math.round((facts.remoteShare - prev.remoteShare) * 10) / 10;
      if (Math.abs(d) >= 3) {
        out.push({
          id: "remote_shift",
          salience: clamp01(0.6 + Math.abs(d) / 30),
          hook: `remote share moved ${d > 0 ? "up" : "down"} ${Math.abs(d)} points to ${facts.remoteShare}%`,
          brief: `Lead with the move: remote-friendly ${segmentLabel} roles went ${d > 0 ? "up" : "down"} ${Math.abs(d)} points week-over-week (${prev.remoteShare}% → ${facts.remoteShare}%, samples of ${prev.scanned} and ${n}). One week is not a trend — say so plainly — but tell a candidate what to do about it now.`,
        });
      }
    }
    const was = new Map(prev.topSkills.map((s) => [s.name, s.share]));
    for (const s of facts.topSkills.slice(0, 4)) {
      const before = was.get(s.name);
      if (before === undefined) continue;
      const d = Math.round((s.share - before) * 10) / 10;
      if (Math.abs(d) >= 4) {
        out.push({
          id: "skill_shift_" + s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
          salience: clamp01(0.55 + Math.abs(d) / 30),
          hook: `${s.name} demand moved ${d > 0 ? "up" : "down"} ${Math.abs(d)} points`,
          brief: `Lead with the move: ${s.name} went from ${before}% to ${s.share}% of ${segmentLabel} postings week-over-week (samples of ${prev.scanned} and ${n}). Be honest that one week is not a trend, then give the practical read for a candidate.`,
        });
        break;
      }
    }
  }

  return out.sort((a, b) => b.salience - a.salience);
}

// Render facts for the content prompt. Everything is phrased so the writer can
// attribute it ("across N postings we scanned"), and when the sample is thin we
// say so explicitly instead of quietly shipping a percentage.
export function factsToPromptBlock(
  segmentLabel: string,
  facts: MarketFacts,
  prev?: MarketFacts | null,
): string {
  if (!facts || !facts.scanned) return "";
  const L: string[] = [];
  L.push(`LIVE MARKET SCAN — ${segmentLabel}`);
  // Describe the sample honestly. The scan is location-"balanced" on purpose:
  // filtering strictly to SA postal geography silently drops every remote board
  // and drives remote share to a fake 0%. So the real population is "roles a
  // South African can apply to" — local listings PLUS remote roles open to SA —
  // and the copy must not overclaim it as SA-postcode-only.
  L.push(`Sample: ${facts.scanned} live ${segmentLabel} postings visible to South African job seekers this week — local roles plus remote roles open to SA — from ${facts.sources.join(", ") || "our job feeds"}.`);
  L.push(`Attribution rule: you MAY cite these numbers, but you MUST attribute them like "across the ${facts.scanned} live ${segmentLabel} roles CareerBoost scanned for South African job seekers this week". Never round a number up. Never invent a number that is not listed here. Do not describe this as every job in South Africa — it is what our feeds saw this week.`);

  if (!facts.sufficient) {
    L.push(`⚠ SMALL SAMPLE (${facts.scanned} < ${MIN_SAMPLE}). Do NOT state percentages or trends. You may only mention concrete named examples (roles, companies, skills) and must avoid implying a market-wide rate.`);
  } else {
    if (facts.remoteShare !== null) L.push(`- Remote-friendly: ${facts.remoteShare}% of postings.`);
    if (facts.salaryDisclosedShare !== null) L.push(`- Advertised a salary: ${facts.salaryDisclosedShare}%.`);
    if (facts.postedLast7dShare !== null) L.push(`- Posted in the last 7 days: ${facts.postedLast7dShare}%.`);
  }
  if (facts.topSkills.length) {
    L.push("- Most-requested skills: " + facts.topSkills.map((s) => `${s.name} (${s.count}${facts.sufficient ? `, ${s.share}%` : ""})`).join(", ") + ".");
  }
  if (facts.topLocations.length) {
    L.push("- Where the roles are: " + facts.topLocations.map((c) => `${c.name} (${c.count})`).join(", ") + ".");
  }
  if (facts.topCompanies.length) {
    L.push("- Employers hiring most: " + facts.topCompanies.map((c) => `${c.name} (${c.count})`).join(", ") + ".");
  }

  // Week-over-week only when BOTH weeks clear the sample floor — otherwise a
  // "trend" is just sampling noise wearing a suit.
  if (prev && prev.sufficient && facts.sufficient) {
    const d: string[] = [];
    if (facts.remoteShare !== null && prev.remoteShare !== null) {
      const delta = Math.round((facts.remoteShare - prev.remoteShare) * 10) / 10;
      if (Math.abs(delta) >= 2) d.push(`remote share ${delta > 0 ? "up" : "down"} ${Math.abs(delta)} points (was ${prev.remoteShare}%)`);
    }
    const prevSkills = new Map(prev.topSkills.map((s) => [s.name, s.share]));
    for (const s of facts.topSkills.slice(0, 5)) {
      const was = prevSkills.get(s.name);
      if (was === undefined) { d.push(`${s.name} is newly in the top skills`); continue; }
      const delta = Math.round((s.share - was) * 10) / 10;
      if (Math.abs(delta) >= 3) d.push(`${s.name} ${delta > 0 ? "up" : "down"} ${Math.abs(delta)} points`);
    }
    if (d.length) L.push("- Week-over-week: " + d.slice(0, 4).join("; ") + ".");
  }
  return L.join("\n");
}
