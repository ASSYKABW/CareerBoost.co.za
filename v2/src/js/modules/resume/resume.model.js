// Resume data model + helpers.
// The structured resume is stored locally under cache.resume.structured and
// (when backend is active) packed into the resumes.tailored jsonb column as
// { structured: {...}, result: {...last tailor...} }.
//
// AI parsers return a "lean" schema — no ids, simple arrays. normalizeParsed()
// converts that into the full structured resume with ids and group labels.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  const newId = function (prefix) {
    return (
      prefix +
      "_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6)
    );
  };

  function emptyResume() {
    return {
      id: newId("resume"),
      name: "Base resume",
      updatedAt: new Date().toISOString(),
      source: "blank",
      rawText: "",
      header: {
        name: "",
        title: "",
        email: "",
        phone: "",
        location: "",
        links: [],
        // Optional extras — rendered by premium templates when present
        photo: "",            // Data URL (data:image/...) or empty
        dateOfBirth: "",
        drivingLicense: "",
        nationality: ""
      },
      summary: "",
      experience: [],
      education: [],
      skills: { groups: [] },
      projects: [],
      certifications: [],
      languages: [],
      interests: [],          // [{ id, label }]
      references: []          // [{ id, name, role, company, email, phone, note }]
    };
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }
  function str(v) {
    return typeof v === "string" ? v : "";
  }
  function bool(v) {
    return v === true || v === "true";
  }

  // Accept the "lean" shape from the AI parser and produce the full structured
  // resume with ids, section arrays, and sensible defaults.
  function normalizeParsed(parsed, meta) {
    const base = emptyResume();
    if (!parsed || typeof parsed !== "object") return base;

    const header = parsed.header || {};
    base.header = {
      name: str(header.name || parsed.name),
      title: str(header.title || parsed.title),
      email: str(header.email),
      phone: str(header.phone),
      location: str(header.location),
      links: arr(header.links)
        .map(function (l) {
          if (!l) return null;
          if (typeof l === "string") return { label: "Link", url: l };
          return { label: str(l.label) || "Link", url: str(l.url) };
        })
        .filter(Boolean),
      photo: str(header.photo),
      dateOfBirth: str(header.dateOfBirth),
      drivingLicense: str(header.drivingLicense),
      nationality: str(header.nationality)
    };

    base.summary = str(parsed.summary);

    base.experience = arr(parsed.experience).map(function (e) {
      const bullets = arr(e && e.bullets)
        .map(function (b) {
          const text = typeof b === "string" ? b : str(b && b.text);
          if (!text) return null;
          return { id: newId("blt"), text: text };
        })
        .filter(Boolean);
      return {
        id: newId("exp"),
        company: str(e && e.company),
        role: str(e && e.role),
        location: str(e && e.location),
        startDate: str(e && e.startDate),
        endDate: str(e && e.endDate),
        current: bool(e && e.current),
        bullets: bullets
      };
    });

    base.education = arr(parsed.education).map(function (e) {
      return {
        id: newId("edu"),
        school: str(e && e.school),
        degree: str(e && e.degree),
        field: str(e && e.field),
        startDate: str(e && e.startDate),
        endDate: str(e && e.endDate),
        notes: str(e && e.notes)
      };
    });

    // Skills: the AI may return a flat array of strings OR a grouped object.
    if (Array.isArray(parsed.skills)) {
      base.skills.groups = [
        { id: newId("skg"), label: "Core skills", items: parsed.skills.map(String).filter(Boolean) }
      ];
    } else if (parsed.skills && typeof parsed.skills === "object") {
      const groups = arr(parsed.skills.groups);
      base.skills.groups = groups.length
        ? groups.map(function (g) {
            return {
              id: newId("skg"),
              label: str(g.label) || "Skills",
              items: arr(g.items).map(String).filter(Boolean)
            };
          })
        : [{ id: newId("skg"), label: "Core skills", items: [] }];
    }

    base.projects = arr(parsed.projects).map(function (p) {
      return {
        id: newId("prj"),
        name: str(p && p.name),
        description: str(p && p.description),
        bullets: arr(p && p.bullets)
          .map(function (b) {
            const text = typeof b === "string" ? b : str(b && b.text);
            return text ? { id: newId("blt"), text: text } : null;
          })
          .filter(Boolean),
        url: str(p && p.url)
      };
    });

    base.certifications = arr(parsed.certifications).map(function (c) {
      return {
        id: newId("cert"),
        name: str(c && c.name),
        issuer: str(c && c.issuer),
        date: str(c && c.date)
      };
    });

    base.languages = arr(parsed.languages).map(function (l) {
      return {
        id: newId("lng"),
        name: str(l && l.name),
        level: str(l && l.level)
      };
    });

    base.interests = arr(parsed.interests).map(function (i) {
      const label = typeof i === "string" ? i : str(i && (i.label || i.name));
      return label ? { id: newId("int"), label: label } : null;
    }).filter(Boolean);

    base.references = arr(parsed.references).map(function (r) {
      if (!r) return null;
      return {
        id: newId("ref"),
        name: str(r.name),
        role: str(r.role || r.title),
        company: str(r.company || r.organization),
        email: str(r.email),
        phone: str(r.phone),
        note: str(r.note || r.relation)
      };
    }).filter(Boolean);

    if (meta) {
      if (meta.source) base.source = meta.source;
      if (meta.rawText) base.rawText = meta.rawText;
      if (meta.name) base.name = meta.name;
    }

    return base;
  }

  /** Skills across all groups, order preserved, case-insensitive dedupe. */
  function flattenSkillLines(resume) {
    const groups = (resume.skills && resume.skills.groups) || [];
    const seen = Object.create(null);
    const out = [];
    groups.forEach(function (g) {
      (g.items || []).forEach(function (s) {
        if (s == null) return;
        const t = String(s).trim();
        if (!t) return;
        const key = t.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        out.push(t);
      });
    });
    return out;
  }

  // Re-assemble structured data into a single plain-text block, used as input
  // to tailor / cover-letter / critique skills.
  function toPlainText(resume) {
    if (!resume) return "";
    const lines = [];
    const h = resume.header || {};
    if (h.name) lines.push(h.name);
    const contact = [h.email, h.phone, h.location].filter(Boolean).join(" · ");
    if (contact) lines.push(contact);
    if (h.links && h.links.length) {
      lines.push(h.links.map(function (l) { return l.label + ": " + l.url; }).join(" · "));
    }
    lines.push("");

    if (resume.summary) {
      lines.push("SUMMARY");
      lines.push(resume.summary);
      lines.push("");
    }

    if (resume.experience && resume.experience.length) {
      lines.push("EXPERIENCE");
      resume.experience.forEach(function (e) {
        const dates = [e.startDate, e.current ? "Present" : e.endDate]
          .filter(Boolean)
          .join(" – ");
        const head = [e.role, e.company].filter(Boolean).join(" — ");
        lines.push((head || "Role") + (dates ? "  (" + dates + ")" : ""));
        if (e.location) lines.push(e.location);
        (e.bullets || []).forEach(function (b) { lines.push("• " + b.text); });
        lines.push("");
      });
    }

    if (resume.education && resume.education.length) {
      lines.push("EDUCATION");
      resume.education.forEach(function (e) {
        const dates = [e.startDate, e.endDate].filter(Boolean).join(" – ");
        const head = [e.degree, e.field].filter(Boolean).join(" in ");
        lines.push([head, e.school].filter(Boolean).join(" — ") + (dates ? "  (" + dates + ")" : ""));
        if (e.notes) lines.push(e.notes);
      });
      lines.push("");
    }

    const flatSkills = flattenSkillLines(resume);
    if (flatSkills.length) {
      lines.push("SKILLS");
      lines.push(flatSkills.join(", "));
      lines.push("");
    }

    if (resume.projects && resume.projects.length) {
      lines.push("PROJECTS");
      resume.projects.forEach(function (p) {
        lines.push(p.name + (p.url ? " — " + p.url : ""));
        if (p.description) lines.push(p.description);
        (p.bullets || []).forEach(function (b) { lines.push("• " + b.text); });
        lines.push("");
      });
    }

    if (resume.certifications && resume.certifications.length) {
      lines.push("CERTIFICATIONS");
      resume.certifications.forEach(function (c) {
        lines.push([c.name, c.issuer, c.date].filter(Boolean).join(" — "));
      });
      lines.push("");
    }

    if (resume.languages && resume.languages.length) {
      lines.push("LANGUAGES");
      lines.push(resume.languages.map(function (l) {
        return l.name + (l.level ? " (" + l.level + ")" : "");
      }).join(", "));
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Quick completeness scorecard used in the editor sidebar until we ship the
  // real critique skill in Phase 2.
  function completeness(resume) {
    if (!resume) return { score: 0, missing: ["upload a resume"] };
    const missing = [];
    const h = resume.header || {};
    if (!h.name) missing.push("full name");
    if (!h.email) missing.push("email");
    if (!resume.summary) missing.push("summary");
    if (!resume.experience || !resume.experience.length) missing.push("work experience");
    if (!resume.education || !resume.education.length) missing.push("education");
    const hasSkills = resume.skills &&
      resume.skills.groups &&
      resume.skills.groups.some(function (g) { return g.items && g.items.length; });
    if (!hasSkills) missing.push("skills");

    // Quantified bullet detection — use the shared honest "measurable impact"
    // detector when available (ignores bare years, versions, "24/7"). Falls
    // back to the naive digit check only if the quality module isn't loaded.
    const q = (window.CBV2.resume && window.CBV2.resume.quality) || null;
    const hasMetric = (q && typeof q.hasImpactMetric === "function")
      ? q.hasImpactMetric
      : function (t) { return /\d/.test(String(t == null ? "" : t)); };
    let totalBullets = 0;
    let quantifiedBullets = 0;
    (resume.experience || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) {
        totalBullets += 1;
        if (hasMetric(b.text)) quantifiedBullets += 1;
      });
    });

    // Score: 6 section checks + bullet quantification ratio
    const sectionHits = 6 - missing.length;
    const bulletScore = totalBullets ? quantifiedBullets / totalBullets : 0;
    const raw = (sectionHits / 6) * 0.7 + bulletScore * 0.3;
    const score = Math.round(raw * 100);

    return {
      score: score,
      missing: missing,
      totalBullets: totalBullets,
      quantifiedBullets: quantifiedBullets
    };
  }

  // Ensures an older stored resume has all of the newer optional fields. Safe
  // to call repeatedly — it only fills missing keys, never overwrites data.
  function ensureShape(resume) {
    if (!resume || typeof resume !== "object") return resume;
    if (!resume.header) resume.header = {};
    const h = resume.header;
    if (typeof h.photo !== "string") h.photo = "";
    if (typeof h.dateOfBirth !== "string") h.dateOfBirth = "";
    if (typeof h.drivingLicense !== "string") h.drivingLicense = "";
    if (typeof h.nationality !== "string") h.nationality = "";
    if (!Array.isArray(h.links)) h.links = [];
    if (!Array.isArray(resume.interests)) resume.interests = [];
    if (!Array.isArray(resume.references)) resume.references = [];
    // Backfill missing ids on interests/references
    resume.interests = resume.interests.map(function (i) {
      if (!i) return null;
      if (typeof i === "string") return { id: newId("int"), label: i };
      return { id: i.id || newId("int"), label: str(i.label || i.name) };
    }).filter(Boolean);
    resume.references = resume.references.map(function (r) {
      if (!r || typeof r !== "object") return null;
      return {
        id: r.id || newId("ref"),
        name: str(r.name),
        role: str(r.role),
        company: str(r.company),
        email: str(r.email),
        phone: str(r.phone),
        note: str(r.note)
      };
    }).filter(Boolean);
    return resume;
  }

  window.CBV2.resume.model = {
    newId: newId,
    emptyResume: emptyResume,
    normalizeParsed: normalizeParsed,
    toPlainText: toPlainText,
    completeness: completeness,
    ensureShape: ensureShape
  };
})();
