// Lifecycle email sequences (static, on-brand copy — no AI/LLM at send time).
//
// Day offsets are measured from each user's anchor_at:
//   onboarding / education → anchor = signup_at
//   reengagement           → anchor = the run that detected inactivity
//
// Each step's CTA carries UTM so signups/visits attribute back to the drip
// (utm_source=email, utm_medium=drip, utm_campaign=<sequenceKey>:<step>).

export interface DripStep {
  dayOffset: number;
  subject: string;
  heading: string;
  paragraphs: string[];   // each becomes a <p>; may contain inline HTML
  cta: { label: string; path: string }; // path is appended to the site origin
}

export interface Sequence {
  key: string;
  label: string;
  kind: "onboarding" | "education" | "reengagement";
  // For onboarding/education: only auto-enroll users whose signup_at is within
  // this many days, so old accounts aren't dropped into a "welcome" series.
  enrollWithinDays: number;
  steps: DripStep[];
}

export const SEQUENCES: Sequence[] = [
  {
    key: "welcome",
    label: "Welcome series",
    kind: "onboarding",
    enrollWithinDays: 10,
    steps: [
      {
        dayOffset: 0,
        subject: "Welcome to CareerBoost 👋",
        heading: "Welcome to CareerBoost",
        paragraphs: [
          "You just took a real step toward your next role. CareerBoost helps South African job seekers find roles, tailor a CV to each one, and walk into interviews ready.",
          "The fastest win on day one: upload your CV so we can score it and spot quick improvements.",
        ],
        cta: { label: "Upload your CV", path: "/#/resume-lab" },
      },
      {
        dayOffset: 2,
        subject: "Tailor your CV to any job in minutes",
        heading: "One CV per job beats one CV for all",
        paragraphs: [
          "Recruiters skim. A CV that mirrors the job description gets noticed — and that's exactly what our tailoring does, automatically.",
          "Paste a job description and we'll rework your CV to match it, then show you what changed.",
        ],
        cta: { label: "Tailor my CV", path: "/#/resume-lab" },
      },
      {
        dayOffset: 5,
        subject: "Ready to apply with confidence?",
        heading: "Find a role and apply — the smart way",
        paragraphs: [
          "Search live roles across South Africa, save the ones that fit, and let CareerBoost tailor your application to each.",
          "Then prep for the interview with practice questions built from the exact job you're chasing.",
        ],
        cta: { label: "Search live jobs", path: "/#/job-search" },
      },
    ],
  },
  {
    key: "feature-tips",
    label: "Feature tips",
    kind: "education",
    enrollWithinDays: 21,
    steps: [
      {
        dayOffset: 3,
        subject: "Get more from Resume Lab",
        heading: "Resume Lab: your CV's coach",
        paragraphs: [
          "Resume Lab scores your CV, flags weak spots, and rewrites bullet points to be specific and quantified — the things recruiters actually reward.",
          "Spend five minutes acting on its top suggestions and watch your score climb.",
        ],
        cta: { label: "Open Resume Lab", path: "/#/resume-lab" },
      },
      {
        dayOffset: 7,
        subject: "Search smarter (and from your browser)",
        heading: "Find roles without the busywork",
        paragraphs: [
          "Job Search pulls live roles from multiple boards into one place, with a match score against your profile.",
          "Prefer to browse on the boards directly? The CareerBoost browser extension brings your tools to any job page.",
        ],
        cta: { label: "Try Job Search", path: "/#/job-search" },
      },
      {
        dayOffset: 14,
        subject: "Walk into interviews ready",
        heading: "Interview prep, tailored to the job",
        paragraphs: [
          "Generate likely questions from a specific job description, draft strong answers using your own experience, and practise until it's natural.",
          "Need a cover letter too? We'll draft one that matches the role in your voice.",
        ],
        cta: { label: "Prep for interviews", path: "/#/interview-prep" },
      },
    ],
  },
  {
    key: "reengagement",
    label: "Re-engagement",
    kind: "reengagement",
    enrollWithinDays: 0, // not used for this kind (enrolled by inactivity)
    steps: [
      {
        dayOffset: 0,
        subject: "New roles are waiting for you",
        heading: "It's been a minute — let's get you moving",
        paragraphs: [
          "The job market doesn't stand still, and neither should your search. Fresh roles matching your profile come up every week.",
          "Pick up where you left off — it only takes a few minutes to line up your next application.",
        ],
        cta: { label: "See new jobs", path: "/#/job-search" },
      },
      {
        dayOffset: 7,
        subject: "Still job hunting? Here's a head start",
        heading: "A stronger CV is the fastest win",
        paragraphs: [
          "If you've got a few minutes, run your CV through Resume Lab. Small, specific improvements often make the difference between a skim and a callback.",
          "We're in your corner whenever you're ready.",
        ],
        cta: { label: "Improve my CV", path: "/#/resume-lab" },
      },
    ],
  },
];

export function sequenceByKey(key: string): Sequence | undefined {
  return SEQUENCES.find((s) => s.key === key);
}
