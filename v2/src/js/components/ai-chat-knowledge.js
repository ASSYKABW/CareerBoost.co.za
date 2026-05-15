// Knowledge manifest for the in-app AI guidance panel.
//
// Single source of truth for what the chat AI knows about the app.
// When you add a feature or change a route, update FEATURES below — the
// system prompt is auto-composed from this list at request time so the
// AI stays in sync without prompt-engineering work.
//
// Keep entries SHORT and FACTUAL. The model is good at expansion; what
// it can't do is invent the right route name or tier gating, so those
// fields must be accurate.

(function () {
  window.CBV2 = window.CBV2 || {};

  const FEATURES = [
    {
      id: "dashboard",
      name: "Dashboard",
      route: "#/dashboard",
      tier: "free",
      summary: "Command center showing your pipeline snapshot, recent activity, and recommended next actions.",
      whenToUse: "the user wants an overview of where their job search stands today."
    },
    {
      id: "job-search",
      name: "Job Search",
      route: "#/job-search",
      tier: "free",
      summary: "Search jobs across multiple boards (Remotive, Arbeitnow, Jobicy, The Muse, Adzuna). Results are ranked by your role profile.",
      whenToUse: "the user wants to find new roles to apply to."
    },
    {
      id: "pipeline",
      name: "Pipeline",
      route: "#/applications",
      tier: "free",
      summary: "Track every application by stage (saved → applied → screen → interview → offer). Notes, dates, and follow-up reminders per row.",
      whenToUse: "the user wants to add, organize, or update applications they're tracking."
    },
    {
      id: "resume",
      name: "Resume Lab",
      route: "#/resume",
      tier: "free",
      summary: "Edit your master resume, run AI critique, and generate a tailored version against a specific job. Free tier: 1 tailor / month.",
      whenToUse: "the user wants to improve their resume or tailor it to a saved job."
    },
    {
      id: "cover-letter",
      name: "Cover Letter Studio",
      route: "#/cover-letter",
      tier: "free",
      summary: "Generate a cover letter for a saved job in your tone of choice. Free tier: 2 letters / month.",
      whenToUse: "the user needs a cover letter for an application."
    },
    {
      id: "interview",
      name: "Interview Prep",
      route: "#/interview",
      tier: "free",
      summary: "Generate likely interview questions for a role, run a text-based mock interview, and get a STAR-format debrief. Free tier: 1 mock / month.",
      whenToUse: "the user has an upcoming interview or wants to practice answering."
    },
    {
      id: "calendar",
      name: "Calendar",
      route: "#/calendar",
      tier: "free",
      summary: "Schedule interviews and reminders. Optional Google Calendar sync and .ics export.",
      whenToUse: "the user wants to schedule or review interview-related events."
    },
    {
      id: "analytics",
      name: "Analytics",
      route: "#/analytics",
      tier: "plus",
      summary: "Response rates, time-to-interview, stage conversion, and skill-gap insights from your pipeline.",
      whenToUse: "the user wants to understand their funnel performance or what's blocking them."
    },
    {
      id: "extension",
      name: "Chrome / Edge Extension",
      route: "#/settings?tab=extension",
      tier: "free",
      summary: "One-click capture from LinkedIn, Indeed, Greenhouse, and Lever directly into the user's pipeline. Downloadable as a .zip from Settings > Extension.",
      whenToUse: "the user wants to save jobs from job boards without manual entry, or asks how to install the extension."
    },
    {
      id: "settings",
      name: "Settings",
      route: "#/settings",
      tier: "free",
      summary: "Profile, job-search profile, AI personalization, documents, data/privacy, appearance, account, extension install, and billing.",
      whenToUse: "the user wants to change preferences, update their profile, or manage their account."
    },
    {
      id: "billing",
      name: "Billing & Plan",
      route: "#/settings?tab=billing",
      tier: "free",
      summary: "Current plan, monthly usage meters, and Stripe billing portal. Plans: Free, Plus, Pro, Career.",
      whenToUse: "the user asks about upgrading, their current plan, or what features they have."
    }
  ];

  const CONCEPTS = [
    {
      term: "Pipeline",
      explain: "Your tracked applications, organized by stage. Drag-and-drop between columns."
    },
    {
      term: "Tailor",
      explain: "AI rewrites your resume bullets and summary to align with a specific job's keywords. The original facts stay; only phrasing and emphasis change."
    },
    {
      term: "Mock interview",
      explain: "A text-based simulated interview. The AI asks ~6-10 questions in role-appropriate phases, then gives a STAR-format debrief."
    },
    {
      term: "STAR",
      explain: "Situation, Task, Action, Result — the structure interview answers should follow. Used in the interview debrief scoring."
    },
    {
      term: "Free plan",
      explain: "Pipeline tracking, the extension, calendar reminders, plus monthly AI quotas: 1 resume tailor, 2 cover letters, 1 mock interview, 1 research brief, 5 saved jobs."
    }
  ];

  function getFeatureByRoute(hashPath) {
    if (!hashPath) return null;
    const path = String(hashPath).split("?")[0].toLowerCase();
    return FEATURES.find(function (f) {
      return String(f.route || "").split("?")[0].toLowerCase() === path;
    }) || null;
  }

  // System-prompt builder. Composed at request time so changes here
  // ship to the AI instantly without server-side prompt deploys.
  // Output is ~1.2KB which fits comfortably in the cacheable systemStable.
  function buildSystemPrompt() {
    const featureLines = FEATURES.map(function (f) {
      return "- " + f.name + " (route: " + f.route + ", tier: " + f.tier + ") — "
        + f.summary + " When to use: " + f.whenToUse;
    }).join("\n");

    const conceptLines = CONCEPTS.map(function (c) {
      return "- " + c.term + ": " + c.explain;
    }).join("\n");

    return [
      "You are CareerBoost AI, an in-app guidance assistant for the CareerBoost job-search platform.",
      "Your job is to help users find and understand the right feature for what they want to do — nothing more.",
      "",
      "RULES:",
      "1. Only answer questions about CareerBoost (this app), job searching, resumes, cover letters, interviews, and adjacent career topics.",
      "2. If asked about anything off-topic, briefly say so and offer a related CareerBoost suggestion.",
      "3. Never invent features. If you don't know whether something exists, say so.",
      "4. When recommending a feature, include a markdown link to its route: [Open <name>](<route>). The link must come from the FEATURES list below.",
      "5. Be concise: 1–3 short paragraphs, plain language, no preamble.",
      "6. Don't ask multiple clarifying questions in a row — make a best-guess recommendation and offer to refine.",
      "7. Don't try to take actions on the user's behalf (you can't update their data, run AI flows, or click buttons for them). You can only guide.",
      "",
      "FEATURES:",
      featureLines,
      "",
      "CONCEPTS:",
      conceptLines
    ].join("\n");
  }

  function buildUserMessage(question, options) {
    const opts = options || {};
    const history = Array.isArray(opts.history) ? opts.history : [];
    const route = opts.currentRoute ? String(opts.currentRoute) : "";

    const lines = [];
    if (route) {
      const here = getFeatureByRoute(route);
      lines.push("USER IS CURRENTLY ON: " + route + (here ? " (" + here.name + ")" : ""));
    }
    if (history.length) {
      lines.push("");
      lines.push("RECENT CONVERSATION (oldest first):");
      history.slice(-6).forEach(function (turn) {
        const who = turn.role === "assistant" ? "Assistant" : "User";
        const text = String(turn.text || "").slice(0, 400);
        if (text) lines.push(who + ": " + text);
      });
    }
    lines.push("");
    lines.push("USER QUESTION:");
    lines.push(String(question || "").slice(0, 800));
    return lines.join("\n");
  }

  window.CBV2.aiChatKnowledge = {
    FEATURES: FEATURES,
    CONCEPTS: CONCEPTS,
    getFeatureByRoute: getFeatureByRoute,
    buildSystemPrompt: buildSystemPrompt,
    buildUserMessage: buildUserMessage
  };
})();
