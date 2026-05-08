(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.jobNotes && window.CBV2.jobNotes.version >= 2) return;

  function st(value) {
    const fn = window.CBV2.sanitizeText;
    return fn ? fn(value) : String(value == null ? "" : value);
  }

  function parseImportedNotes(notes) {
    const raw = String(notes || "").trim();
    if (!raw) return null;

    const looksImported =
      /Imported from .*CareerBoost extension/i.test(raw) ||
      /Imported from .*CareerBoost job search/i.test(raw) ||
      /Imported via CareerBoost job search/i.test(raw) ||
      /Job description snapshot\s*:/i.test(raw) ||
      /linkedin\.com\/jobs/i.test(raw);
    if (!looksImported) return null;

    const lines = raw.split(/\r?\n/);
    const parsed = {
      intro: "",
      source: "",
      location: "",
      description: "",
      meta: []
    };
    let readingDescription = false;
    const descriptionLines = [];

    lines.forEach(function (line) {
      const trimmed = line.trim();
      if (/^Job description snapshot\s*:?$/i.test(trimmed)) {
        readingDescription = true;
        return;
      }
      if (readingDescription) {
        descriptionLines.push(line);
        return;
      }
      if (/^Source\s*:/i.test(trimmed)) {
        parsed.source = trimmed.replace(/^Source\s*:\s*/i, "");
        return;
      }
      if (/^Location\s*:/i.test(trimmed)) {
        parsed.location = trimmed.replace(/^Location\s*:\s*/i, "");
        return;
      }
      if (!trimmed) return;
      if (!parsed.intro) {
        parsed.intro = trimmed;
      } else {
        parsed.meta.push(trimmed);
      }
    });

    parsed.description = descriptionLines.join("\n").trim();
    if (!parsed.description && !parsed.source && !parsed.location) return null;
    return parsed;
  }

  function titleCaseLabel(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); })
      .replace(/(['\u2019])(Ll|Re|Ve|D|M|S|T)\b/g, function (_m, mark, suffix) {
        return mark + suffix.toLowerCase();
      });
  }

  function normalizeJobDescription(value) {
    let text = String(value || "")
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .trim();

    const labels = [
      "About the job",
      "About the role",
      "Opportunity",
      "Role Description",
      "Recruiter",
      "Job Ref",
      "Date posted",
      "Location",
      "SUMMARY",
      "POSITION INFO",
      "Responsibilities",
      "Key Responsibilities",
      "Duties",
      "Requirements",
      "Qualifications",
      "Experience",
      "Skills",
      "Education",
      "What you will do",
      "What you'll do",
      "What you’ll do",
      "What we are looking for",
      "What we're looking for",
      "What we’re looking for",
      "What you will get to learn",
      "What you'll get to learn",
      "What you’ll get to learn",
      "What we offer"
    ];
    const escapedLabels = labels
      .map(function (label) { return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); })
      .join("|");

    text = text.replace(new RegExp("([^\\n])(" + escapedLabels + ")\\s*:", "gi"), "$1\n\n$2:");
    text = text.replace(new RegExp("\\b(" + escapedLabels + ")\\s*:\\s*", "gi"), "\n\n$1:\n");
    text = text.replace(/\s*[\u2022•]\s*/g, "\n• ");
    text = text.replace(
      /([^\n])\b(What you(?:'|’)ll do|What we(?:'|’)re looking for|What you(?:'|’)ll get to learn(?:\s*\([^)]*\))?)\b/gi,
      "$1\n\n$2\n"
    );
    text = text.replace(/([.!?])([A-Z])/g, "$1 $2");
    text = text.replace(/([a-z0-9)])([A-Z][a-z])/g, "$1\n$2");
    text = text.replace(/([a-z)])(\d+\s*[-+]\s*\d*\+?\s*years?)/gi, "$1\n$2");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }

  function isDescriptionHeading(line) {
    if (!line) return false;
    const clean = line.replace(/:$/, "").trim();
    if (!clean || clean.length > 72) return false;
    if (/^(about the job|about the role|opportunity|role description|summary|position info|responsibilities|key responsibilities|duties|requirements|qualifications|experience|skills|education|what you will do|what you'll do|what you’ll do|what we are looking for|what we're looking for|what we’re looking for|what you will get to learn|what you'll get to learn|what you’ll get to learn|what you['’]ll get to learn\s*\([^)]*\)|what we offer)$/i.test(clean)) {
      return true;
    }
    if (/^[A-Z][A-Z\s/&-]{3,}$/.test(clean)) return true;
    return false;
  }

  function isBulletLike(line) {
    return /^[-*\u2022]\s+/.test(line) ||
      /^\d+[.)]\s+/.test(line) ||
      /^\d+\s*[-+]/.test(line) ||
      /^(Design and install|Mining industry|Fire plan|Sprinkler|Smoke control|Fire detection|Rational fire|Quality assurance|Prepare|Coordinate|Review|Manage|Support|Develop|Maintain|Create|Analyze|Analyse)\b/i.test(line);
  }

  function pushJobSection(sections, current) {
    if (!current) return;
    if (!current.title && !current.body.length && !current.bullets.length) return;
    sections.push(current);
  }

  function renderJobDescription(value) {
    const normalized = normalizeJobDescription(value);
    if (!normalized) return "";

    const lines = normalized.split(/\n+/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    const facts = [];
    const contentLines = [];

    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^(Recruiter|Job Ref|Date posted|Location):\s*(.*)$/i);
      if (match) {
        let factValue = (match[2] || "").trim();
        if (!factValue && lines[i + 1] && !isDescriptionHeading(lines[i + 1])) {
          factValue = lines[i + 1].trim();
          i += 1;
        }
        if (factValue) facts.push({ label: titleCaseLabel(match[1]), value: factValue });
        continue;
      }
      contentLines.push(lines[i]);
    }

    const sections = [];
    let current = { title: "", body: [], bullets: [] };
    contentLines.forEach(function (line) {
      const asHeading = isDescriptionHeading(line);
      if (asHeading) {
        pushJobSection(sections, current);
        current = {
          title: titleCaseLabel(line.replace(/:$/, "")),
          body: [],
          bullets: []
        };
        return;
      }
      if (!current.title && !current.body.length && /^About the job\b/i.test(line)) {
        current.title = "About The Job";
        current.body.push(line.replace(/^About the job\s*/i, "").trim());
        return;
      }
      if (isBulletLike(line)) {
        current.bullets.push(line.replace(/^[-*\u2022]\s+/, ""));
      } else {
        current.body.push(line);
      }
    });
    pushJobSection(sections, current);

    const factHtml = facts.length
      ? '<div class="drawer-job-facts">' + facts.map(function (fact) {
          return (
            '<span class="drawer-job-fact">' +
              '<small>' + st(fact.label) + '</small>' +
              '<strong>' + st(fact.value) + '</strong>' +
            '</span>'
          );
        }).join("") + '</div>'
      : "";

    const sectionsHtml = sections.map(function (section) {
      const title = section.title || "Description";
      const body = section.body.filter(Boolean).map(function (paragraph) {
        return '<p>' + st(paragraph) + '</p>';
      }).join("");
      const bullets = section.bullets.length
        ? '<ul class="drawer-job-list">' + section.bullets.map(function (item) {
            return '<li>' + st(item) + '</li>';
          }).join("") + '</ul>'
        : "";
      return (
        '<section class="drawer-job-section">' +
          '<h4 class="drawer-job-section-title">' + st(title) + '</h4>' +
          '<div class="drawer-job-section-body">' + body + bullets + '</div>' +
        '</section>'
      );
    }).join("");

    return '<div class="drawer-job-description">' + factHtml + sectionsHtml + '</div>';
  }

  function captureKicker(parsed) {
    const intro = String((parsed && parsed.intro) || "");
    const source = String((parsed && parsed.source) || "");
    const combined = intro + " " + source;
    if (/linkedin/i.test(combined)) {
      return /extension/i.test(intro) ? "LinkedIn extension capture" : "LinkedIn job search capture";
    }
    if (/CareerBoost job search/i.test(intro)) return "Job search capture";
    if (/CareerBoost extension/i.test(intro)) return "Extension capture";
    return "Imported capture";
  }

  function sourceDisplayValue(source) {
    const raw = String(source || "").trim();
    if (!raw) return "";
    try {
      const u = new URL(raw);
      return u.hostname.replace(/^www\./, "");
    } catch (err) {
      return raw.replace(/^https?:\/\/(www\.)?/i, "");
    }
  }

  function renderImportedSnapshot(app, options) {
    options = options || {};
    const parsed = parseImportedNotes(app && app.notes);
    if (!parsed) return "";
    const compact = options.compact ? " drawer-job-snapshot--compact" : "";
    const kicker = options.kicker || captureKicker(parsed);
    const title = options.title || "Imported job description";
    const badge = options.badge || "Structured view";

    const meta = [];
    if (parsed.location) {
      meta.push(
        '<span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>' +
        st(parsed.location) + "</span>"
      );
    }
    if (parsed.source) {
      const icon = /linkedin/i.test(parsed.source)
        ? "fa-brands fa-linkedin"
        : "fa-solid fa-arrow-up-right-from-square";
      meta.push(
        '<span class="drawer-job-snapshot-meta-source" title="' + st(parsed.source) + '"><i class="' + icon + '" aria-hidden="true"></i>' +
        st(sourceDisplayValue(parsed.source)) + "</span>"
      );
    }
    parsed.meta.forEach(function (item) {
      meta.push('<span><i class="fa-solid fa-circle-info" aria-hidden="true"></i>' + st(item) + "</span>");
    });

    return (
      '<article class="drawer-job-snapshot' + compact + '">' +
        '<div class="drawer-job-snapshot-head">' +
          '<div>' +
            '<span class="drawer-job-snapshot-kicker">' + st(kicker) + '</span>' +
            '<strong>' + st(title) + '</strong>' +
          '</div>' +
          '<span class="chip cyan"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> ' + st(badge) + '</span>' +
        '</div>' +
        (parsed.intro ? '<p class="drawer-job-snapshot-intro">' + st(parsed.intro) + '</p>' : '') +
        (meta.length ? '<div class="drawer-job-snapshot-meta">' + meta.join("") + '</div>' : '') +
        (parsed.description
          ? '<div class="drawer-job-snapshot-copy">' + renderJobDescription(parsed.description) + '</div>'
          : '<p class="ai-meta">No job description text was captured for this listing.</p>') +
      '</article>'
    );
  }

  function cleanNoteText(value, max) {
    let text = String(value || "")
      .replace(/\r/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n\u2022 ")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (max && text.length > max) text = text.slice(0, max).trim();
    return text;
  }

  function providerLabel(job) {
    const providerSource = String((job && job.providerSource) || "").trim();
    if (providerSource) return providerSource;
    const raw = String((job && (job.source || job.provider || job.board)) || "").trim();
    const sourceUrl = String((job && job.url) || "").trim();
    if (sourceUrl) {
      try {
        const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
        if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
        if (host === "indeed.com" || host.endsWith(".indeed.com")) return "Indeed";
        if (host === "adzuna.com" || host.endsWith(".adzuna.com") || host.indexOf("adzuna.") === 0) return "Adzuna";
        if (host === "reed.co.uk" || host.endsWith(".reed.co.uk")) return "Reed.co.uk";
        if (host === "remotive.com" || host.endsWith(".remotive.com")) return "Remotive";
      } catch (err) {
        // Fall back to the reported provider label below.
      }
    }
    if (!raw) return "CareerBoost";
    if (/linkedin/i.test(raw)) return "LinkedIn";
    if (/indeed/i.test(raw)) return "Indeed";
    if (/adzuna/i.test(raw)) return "Adzuna";
    if (/remotive/i.test(raw)) return "Remotive";
    return raw;
  }

  function firstText(values) {
    for (let i = 0; i < values.length; i += 1) {
      const value = cleanNoteText(values[i], 0);
      if (value) return value;
    }
    return "";
  }

  function buildImportedNotes(job, options) {
    options = options || {};
    job = job || {};
    const provider = providerLabel(job);
    const sourceUrl = String(job.finalUrl || job.url || "").trim();
    const finalSource = String(job.finalSource || "").trim();
    const providerSource = String(job.providerSource || "").trim();
    const description = firstText([
      job.descriptionText,
      job.description,
      job.fullDescription,
      job.summary,
      job.snippet
    ]);
    const lines = [];
    lines.push(options.intro || ("Imported from " + provider + " via CareerBoost job search."));
    if (sourceUrl) lines.push("Source: " + sourceUrl);
    if (providerSource) lines.push("Found via: " + cleanNoteText(providerSource, 120));
    if (finalSource && finalSource !== providerSource) lines.push("Opens at: " + cleanNoteText(finalSource, 120));
    if (job.location) lines.push("Location: " + cleanNoteText(job.location, 180));
    if (job.company) lines.push("Company: " + cleanNoteText(job.company, 180));
    if (job.title) lines.push("Role: " + cleanNoteText(job.title, 180));
    if (job.employmentType) lines.push("Work type: " + cleanNoteText(job.employmentType, 120));
    if (job.salary) lines.push("Salary: " + cleanNoteText(job.salary, 120));
    if (job.postedAt) lines.push("Posted: " + cleanNoteText(job.postedAt, 80));
    if (Array.isArray(job.tags) && job.tags.length) {
      lines.push("Tags: " + job.tags.slice(0, 8).map(function (tag) {
        return cleanNoteText(tag, 60);
      }).filter(Boolean).join(", "));
    }
    lines.push("");
    lines.push("Job description snapshot:");
    if (description) {
      lines.push(normalizeJobDescription(cleanNoteText(description, options.maxDescription || 24000)));
    } else {
      lines.push("No job description text was captured for this listing. Open the source listing and paste the full description here before tailoring materials.");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  window.CBV2.jobNotes = {
    version: 2,
    buildImportedNotes: buildImportedNotes,
    parseImportedNotes: parseImportedNotes,
    normalizeJobDescription: normalizeJobDescription,
    renderImportedSnapshot: renderImportedSnapshot,
    renderJobDescription: renderJobDescription,
    _private: {
      isDescriptionHeading: isDescriptionHeading,
      isBulletLike: isBulletLike
    }
  };
})();
