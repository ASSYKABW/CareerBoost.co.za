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
