// Resume → .docx generator. Uses the `docx` library (v9) loaded from CDN.
//
// Everything here strictly sticks to the verified v9 API surface:
// Document / Paragraph / TextRun / Table / TableRow / TableCell, with
// AlignmentType, BorderStyle, WidthType, ShadingType, TabStopType,
// TabStopPosition.MAX. No exotic properties — that's what was producing the
// "Word experienced an error trying to open the file" crashes.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  const DOCX_CDN = "https://unpkg.com/docx@9/dist/index.iife.js";
  let docxPromise = null;

  function loadDocx() {
    if (window.docx) return Promise.resolve(window.docx);
    if (docxPromise) return docxPromise;
    docxPromise = new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = DOCX_CDN;
      s.async = true;
      s.onload = function () {
        if (window.docx) resolve(window.docx);
        else reject(new Error("docx loaded but global `docx` missing"));
      };
      s.onerror = function () { reject(new Error("Failed to load docx library (offline?)")); };
      document.head.appendChild(s);
    });
    return docxPromise;
  }

  // ---------------------------------------------------------------------------
  // Constants + tiny helpers
  // ---------------------------------------------------------------------------
  // Usable content width in DXA at 0 margins = A4 page width = 11906.
  // TabStopPosition.MAX is 9026 which is a safe "right edge" tab target when
  // we're still using non-zero margins.
  const CONTENT_WIDTH_DXA_A4 = 11906;

  function cleanHex(hex, fallback) {
    const s = (hex || "").replace(/^#/, "").toUpperCase();
    if (/^[0-9A-F]{6}$/.test(s)) return s;
    if (/^[0-9A-F]{3}$/.test(s)) return s.split("").map(function (c) { return c + c; }).join("");
    return fallback || "111111";
  }

  function halfPoints(pt) {
    // docx text `size` is in half-points. Always return an integer.
    if (typeof pt !== "number" || !isFinite(pt)) return 21;
    return Math.max(14, Math.round(pt * 2));
  }

  function monogramFrom(name) {
    if (!name) return "";
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function bulletTexts(bullets) {
    if (!Array.isArray(bullets)) return [];
    return bullets.map(function (b) { return b && b.text ? b.text : ""; }).filter(Boolean);
  }

  /** Flat skill lines in group order, case-insensitive dedupe (matches HTML export). */
  function flattenSkillItems(resume) {
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

  function dateRange(e) {
    const s = (e && e.startDate) || "";
    const end = e && e.current ? "Present" : ((e && e.endDate) || "");
    if (!s && !end) return "";
    return s + (s && end ? " — " : "") + end;
  }

  // ---------------------------------------------------------------------------
  // Style preset per template (kept simple — colors + font + layout hint)
  // ---------------------------------------------------------------------------
  function stylePreset(style, accentHex) {
    const A = cleanHex(accentHex, "1F2E4A");
    if (style === "executive") {
      return { font: "Cambria", ink: "1F2E4A", accent: A, gold: "B8935C", sideBg: "F7F5F0", sideWidthPct: 35, layout: "sidebar", heroBg: "1F2E4A" };
    }
    if (style === "timeline") {
      return { font: "Calibri", ink: "13294B", accent: A, sideBg: "F2EFE6", sideWidthPct: 34, layout: "sidebar" };
    }
    if (style === "sidebar") {
      return { font: "Calibri", ink: "2C3E50", accent: A, sideBg: A, sideText: "FFFFFF", sideWidthPct: 36, layout: "sidebar" };
    }
    if (style === "editorial") {
      return { font: "Cambria", ink: "2B2F3A", accent: A, sideBg: "F7F5F0", sideWidthPct: 32, layout: "sidebar", heroBg: "2B2F3A" };
    }
    if (style === "modern")  return { font: "Calibri", ink: "0F172A", accent: A, layout: "single" };
    if (style === "minimal") return { font: "Calibri", ink: "171717", accent: A, layout: "single" };
    return { font: "Cambria", ink: "0F172A", accent: A, layout: "single" }; // classic
  }

  function resolveDocxOpts(style, opts) {
    const p = stylePreset(style || "classic", (opts && opts.accent) || "");
    const basePt = (opts && typeof opts.fontSize === "number") ? opts.fontSize : 10.5;
    if (opts && opts.fontFamily === "serif") p.font = "Cambria";
    else if (opts && opts.fontFamily === "mono") p.font = "Consolas";
    else if (opts && opts.fontFamily === "sans") p.font = "Calibri";
    const pageSize = (opts && opts.pageSize === "letter") ? "letter" : "a4";
    const quality = (opts && opts.quality === "high") ? "high" : "balanced";
    return Object.assign({}, p, { basePt: basePt, baseSize: halfPoints(basePt), pageSize: pageSize, quality: quality });
  }

  // ---------------------------------------------------------------------------
  // Builder factory
  // ---------------------------------------------------------------------------
  function makeBuilder(d, o) {
    const AL = d.AlignmentType;
    const BOR = d.BorderStyle;
    const TAB = d.TabStopType;
    const TABMAX = d.TabStopPosition.MAX;

    function run(text, over) {
      const cfg = Object.assign({ text: text == null ? "" : String(text), font: o.font, size: o.baseSize }, over || {});
      // Ensure size is an integer half-points
      if (typeof cfg.size === "number") cfg.size = Math.max(14, Math.round(cfg.size));
      return new d.TextRun(cfg);
    }

    function para(children, over) {
      return new d.Paragraph(Object.assign({ children: Array.isArray(children) ? children : [children] }, over || {}));
    }

    function bulletPara(text, over) {
      return new d.Paragraph(Object.assign({
        children: [run(text)],
        bullet: { level: 0 },
        spacing: { after: 60 }
      }, over || {}));
    }

    function blankPara(after) {
      return new d.Paragraph({ children: [run("")], spacing: { after: after || 40 } });
    }

    function rightTabLine(leftRuns, rightRuns, position) {
      const pos = position || (TABMAX - 400);
      return new d.Paragraph({
        children: [].concat(leftRuns, [run("\t")], rightRuns),
        tabStops: [{ type: TAB.RIGHT, position: pos }],
        spacing: { after: 40 }
      });
    }

    function mainSectionHeading(label, colorHex) {
      return new d.Paragraph({
        children: [run(label.toUpperCase(), {
          bold: true,
          size: Math.max(o.baseSize + 2, 22),
          color: colorHex || o.ink
        })],
        spacing: { before: 160, after: 80 },
        border: { bottom: { color: "D4D4D8", space: 2, size: 6, style: BOR.SINGLE } }
      });
    }

    function sideSectionHeading(label, colorHex, underlineHex) {
      return new d.Paragraph({
        children: [run(label.toUpperCase(), {
          bold: true,
          size: Math.max(o.baseSize, 20),
          color: colorHex || o.ink
        })],
        spacing: { before: 160, after: 80 },
        border: { bottom: { color: underlineHex || "D4D4D8", space: 2, size: 4, style: BOR.SINGLE } }
      });
    }

    return {
      d: d, AL: AL, BOR: BOR, TAB: TAB, TABMAX: TABMAX,
      run: run, para: para, bulletPara: bulletPara, blankPara: blankPara,
      rightTabLine: rightTabLine,
      mainSectionHeading: mainSectionHeading,
      sideSectionHeading: sideSectionHeading
    };
  }

  // ---------------------------------------------------------------------------
  // Single-column content (Classic / Modern / Minimal)
  // ---------------------------------------------------------------------------
  function buildHeaderSingleCol(resume, b, o, style) {
    const h = resume.header || {};
    const nameSize = style === "minimal" ? 44 : (style === "modern" ? 40 : 32);
    const out = [];

    out.push(b.para([b.run(h.name || "", {
      bold: true,
      size: nameSize,
      color: style === "minimal" ? o.accent : "0F172A"
    })], {
      alignment: style === "classic" ? b.AL.CENTER : b.AL.LEFT,
      spacing: { after: 60 }
    }));

    if (h.title) {
      out.push(b.para([b.run(h.title, {
        italics: style === "classic",
        color: style === "modern" ? o.accent : "525252",
        size: o.baseSize + 2,
        bold: style === "modern"
      })], {
        alignment: style === "classic" ? b.AL.CENTER : b.AL.LEFT,
        spacing: { after: 80 }
      }));
    }

    const bits = [];
    if (h.email) bits.push(h.email);
    if (h.phone) bits.push(h.phone);
    if (h.location) bits.push(h.location);
    (h.links || []).forEach(function (l) { if (l && (l.label || l.url)) bits.push(l.label || l.url); });
    if (bits.length) {
      out.push(b.para([b.run(bits.join("  •  "), { color: "525252", size: o.baseSize - 1 })], {
        alignment: style === "classic" ? b.AL.CENTER : b.AL.LEFT,
        spacing: { after: 200 }
      }));
    }

    if (style === "classic") {
      out.push(new b.d.Paragraph({
        children: [b.run("")],
        border: { bottom: { color: "111111", space: 1, size: 8, style: b.BOR.SINGLE } },
        spacing: { after: 160 }
      }));
    }

    return out;
  }

  function buildSummary(resume, b, o, label) {
    if (!resume.summary) return [];
    return [
      b.mainSectionHeading(label || "Summary"),
      b.para([b.run(resume.summary)], { alignment: b.AL.JUSTIFIED, spacing: { after: 120 } })
    ];
  }

  function buildExperience(resume, b, o) {
    const exps = Array.isArray(resume.experience) ? resume.experience : [];
    if (!exps.length) return [];
    const out = [b.mainSectionHeading("Experience")];
    exps.forEach(function (e) {
      const range = dateRange(e);
      out.push(b.rightTabLine(
        [b.run(e.role || "", { bold: true, size: o.baseSize + 1, color: o.ink })],
        [b.run(range, { color: "6B7280", size: o.baseSize - 1 })]
      ));
      const companyBits = [];
      if (e.company) companyBits.push(e.company);
      if (e.location) companyBits.push(e.location);
      if (companyBits.length) {
        out.push(b.para([b.run(companyBits.join(" · "), { italics: true, color: o.accent })], { spacing: { after: 60 } }));
      }
      bulletTexts(e.bullets).forEach(function (t) { out.push(b.bulletPara(t)); });
      out.push(b.blankPara(40));
    });
    return out;
  }

  function buildEducation(resume, b, o) {
    const edus = Array.isArray(resume.education) ? resume.education : [];
    if (!edus.length) return [];
    const out = [b.mainSectionHeading("Education")];
    edus.forEach(function (e) {
      const range = (e.startDate || "") + (e.startDate && e.endDate ? " — " : "") + (e.endDate || "");
      out.push(b.rightTabLine(
        [b.run(e.school || "", { bold: true, size: o.baseSize + 1, color: o.ink })],
        [b.run(range, { color: "6B7280", size: o.baseSize - 1 })]
      ));
      const degreeLine = [e.degree, e.field].filter(Boolean).join(", ");
      if (degreeLine) {
        out.push(b.para([b.run(degreeLine, { italics: true, color: "525252" })], { spacing: { after: 40 } }));
      }
      if (e.notes) {
        out.push(b.para([b.run(e.notes, { color: "525252" })], { spacing: { after: 40 } }));
      }
    });
    return out;
  }

  function buildSkills(resume, b, o) {
    const all = flattenSkillItems(resume);
    if (!all.length) return [];
    return [
      b.mainSectionHeading("Skills"),
      b.para([b.run(all.join(", "))], { spacing: { after: 60 } })
    ];
  }

  function buildProjects(resume, b, o) {
    const prjs = Array.isArray(resume.projects) ? resume.projects : [];
    if (!prjs.length) return [];
    const out = [b.mainSectionHeading("Projects")];
    prjs.forEach(function (p) {
      out.push(b.rightTabLine(
        [b.run(p.name || "", { bold: true, size: o.baseSize + 1, color: o.ink })],
        p.url ? [b.run(p.url, { color: "6B7280", size: o.baseSize - 1 })] : [b.run("")]
      ));
      if (p.description) out.push(b.para([b.run(p.description, { color: "525252" })], { spacing: { after: 40 } }));
      bulletTexts(p.bullets).forEach(function (t) { out.push(b.bulletPara(t)); });
    });
    return out;
  }

  function buildCertifications(resume, b, o) {
    const items = Array.isArray(resume.certifications) ? resume.certifications : [];
    if (!items.length) return [];
    const out = [b.mainSectionHeading("Certifications")];
    items.forEach(function (c) {
      const meta = [c.issuer, c.date].filter(Boolean).join(" · ");
      out.push(new b.d.Paragraph({
        children: [
          b.run(c.name || "", { bold: true, color: o.ink }),
          meta ? b.run(" — " + meta, { color: "525252" }) : b.run("")
        ],
        bullet: { level: 0 },
        spacing: { after: 40 }
      }));
    });
    return out;
  }

  function buildLanguages(resume, b, o) {
    const langs = Array.isArray(resume.languages) ? resume.languages : [];
    if (!langs.length) return [];
    return [
      b.mainSectionHeading("Languages"),
      b.para([b.run(langs.map(function (l) {
        return (l.name || "") + (l.level ? " (" + l.level + ")" : "");
      }).join(" · "))], { spacing: { after: 60 } })
    ];
  }

  function buildInterests(resume, b, o) {
    const items = Array.isArray(resume.interests) ? resume.interests : [];
    const labels = items.map(function (i) { return i && i.label ? i.label : ""; }).filter(Boolean);
    if (!labels.length) return [];
    return [
      b.mainSectionHeading("Interests"),
      b.para([b.run(labels.join(" · "))], { spacing: { after: 60 } })
    ];
  }

  function buildReferences(resume, b, o) {
    const items = Array.isArray(resume.references) ? resume.references : [];
    if (!items.length) return [];
    const out = [b.mainSectionHeading("References")];
    items.forEach(function (r) {
      out.push(b.para([b.run(r.name || "", { bold: true, color: o.ink })], { spacing: { after: 20 } }));
      const meta = [r.role, r.company].filter(Boolean).join(" · ");
      if (meta) out.push(b.para([b.run(meta, { italics: true, color: "525252" })], { spacing: { after: 20 } }));
      const contact = [r.email, r.phone].filter(Boolean).join("  ·  ");
      if (contact) out.push(b.para([b.run(contact, { color: "374151" })], { spacing: { after: 20 } }));
      if (r.note) out.push(b.para([b.run(r.note, { color: "374151", size: o.baseSize - 1 })], { spacing: { after: 60 } }));
      else out.push(b.blankPara(60));
    });
    return out;
  }

  function buildSingleColumn(resume, b, o, style) {
    return [].concat(
      buildHeaderSingleCol(resume, b, o, style),
      buildSummary(resume, b, o, style === "minimal" ? "About" : (style === "modern" ? "Profile" : "Summary")),
      buildExperience(resume, b, o),
      buildEducation(resume, b, o),
      buildSkills(resume, b, o),
      buildProjects(resume, b, o),
      buildCertifications(resume, b, o),
      buildLanguages(resume, b, o),
      buildInterests(resume, b, o),
      buildReferences(resume, b, o)
    );
  }

  // ---------------------------------------------------------------------------
  // Two-column (sidebar) templates — rendered as a single-row Table
  // ---------------------------------------------------------------------------
  function buildHero(resume, b, o, style) {
    const h = resume.header || {};
    const mono = monogramFrom(h.name);

    if (style === "executive") {
      const dark = "1F2E4A";
      const gold = "B8935C";
      const out = [];
      if (mono) {
        out.push(new b.d.Paragraph({
          children: [b.run(mono, { bold: true, size: o.baseSize + 6, color: dark })],
          alignment: b.AL.CENTER,
          shading: { fill: dark, type: b.d.ShadingType.CLEAR, color: dark },
          spacing: { before: 160, after: 40 }
        }));
      }
      out.push(new b.d.Paragraph({
        children: [b.run((h.name || "").toUpperCase(), { color: gold, size: o.baseSize + 18, bold: true })],
        alignment: b.AL.CENTER,
        shading: { fill: dark, type: b.d.ShadingType.CLEAR, color: dark },
        spacing: { after: 40 }
      }));
      out.push(new b.d.Paragraph({
        children: [b.run(h.title ? h.title.toUpperCase() : " ", { color: "E8E3D5", size: o.baseSize - 1 })],
        alignment: b.AL.CENTER,
        shading: { fill: dark, type: b.d.ShadingType.CLEAR, color: dark },
        spacing: { after: 200 }
      }));
      return out;
    }

    if (style === "timeline") {
      const ink = "0F172A";
      const out = [];
      out.push(b.para([b.run((h.name || "").toUpperCase(), { bold: true, size: o.baseSize + 16, color: ink })], { spacing: { before: 200, after: 40 } }));
      if (h.title) {
        out.push(b.para([b.run(h.title.toUpperCase(), { color: o.accent, size: o.baseSize - 1, bold: true })], { spacing: { after: 40 } }));
      }
      out.push(new b.d.Paragraph({
        children: [b.run("")],
        border: { bottom: { color: o.accent, space: 1, size: 18, style: b.BOR.SINGLE } },
        spacing: { after: 120 }
      }));
      return out;
    }

    if (style === "editorial") {
      const dark = "2B2F3A";
      const out = [];
      out.push(new b.d.Paragraph({
        children: [
          b.run((h.name || "").toUpperCase(), { bold: true, size: o.baseSize + 16, color: "FFFFFF" }),
          b.run("\t"),
          b.run(mono || "", { color: "FFFFFF", size: o.baseSize + 6 })
        ],
        tabStops: [{ type: b.TAB.RIGHT, position: b.TABMAX - 200 }],
        shading: { fill: dark, type: b.d.ShadingType.CLEAR, color: dark },
        spacing: { before: 160, after: 40 }
      }));
      out.push(new b.d.Paragraph({
        children: [b.run(h.title ? h.title.toUpperCase() : " ", { color: "D6D9E0", size: o.baseSize - 1 })],
        shading: { fill: dark, type: b.d.ShadingType.CLEAR, color: dark },
        spacing: { after: 200 }
      }));
      return out;
    }

    // sidebar — hero lives inside the sidebar cell, nothing here
    return [];
  }

  function buildSidebarChildren(resume, b, o, style) {
    const h = resume.header || {};
    const onDark = style === "sidebar";
    const sideText = onDark ? "FFFFFF" : o.ink;
    const muted = onDark ? "CFD6DE" : "525252";
    const headingColor = onDark ? "FFFFFF" : o.ink;
    const underline = onDark ? "BCC7D2" : "D4D4D8";

    const out = [];

    // Sidebar template: name + title inside the sidebar
    if (style === "sidebar") {
      if (h.name) {
        out.push(b.para([b.run(h.name.toUpperCase(), { bold: true, size: o.baseSize + 8, color: sideText })], {
          alignment: b.AL.CENTER,
          spacing: { after: 40 }
        }));
      }
      if (h.title) {
        out.push(b.para([b.run(h.title, { color: muted, size: o.baseSize - 1 })], {
          alignment: b.AL.CENTER,
          spacing: { after: 160 }
        }));
      }
    }

    // Contact / Profile
    const contactBits = [];
    if (h.email)           contactBits.push({ label: "Email", value: h.email });
    if (h.phone)           contactBits.push({ label: "Phone", value: h.phone });
    if (h.location)        contactBits.push({ label: "Address", value: h.location });
    if (h.dateOfBirth)     contactBits.push({ label: "Date of birth", value: h.dateOfBirth });
    if (h.nationality)     contactBits.push({ label: "Nationality", value: h.nationality });
    if (h.drivingLicense)  contactBits.push({ label: "Driving licence", value: h.drivingLicense });
    (h.links || []).forEach(function (l) {
      if (l && (l.label || l.url)) contactBits.push({ label: l.label || "Link", value: l.url || l.label });
    });
    if (contactBits.length) {
      out.push(b.sideSectionHeading(style === "sidebar" ? "Profile" : "Contact", headingColor, underline));
      contactBits.forEach(function (c) {
        out.push(b.para([b.run(c.label, { bold: true, color: sideText, size: o.baseSize - 1 })], { spacing: { after: 10 } }));
        out.push(b.para([b.run(c.value, { color: muted, size: o.baseSize - 1 })], { spacing: { after: 80 } }));
      });
    }

    // Skills (single flat list under heading — no per-group labels)
    const flatSkills = flattenSkillItems(resume);
    if (flatSkills.length) {
      out.push(b.sideSectionHeading("Skills", headingColor, underline));
      flatSkills.forEach(function (s) {
        out.push(new b.d.Paragraph({
          children: [b.run(s, { color: onDark ? "E5EAF0" : "374151", size: o.baseSize - 1 })],
          bullet: { level: 0 },
          spacing: { after: 30 }
        }));
      });
    }

    // Languages
    const langs = Array.isArray(resume.languages) ? resume.languages : [];
    if (langs.length) {
      out.push(b.sideSectionHeading("Languages", headingColor, underline));
      langs.forEach(function (l) {
        out.push(b.para([
          b.run(l.name || "", { bold: true, color: sideText, size: o.baseSize - 1 }),
          l.level ? b.run(" (" + l.level + ")", { color: muted, size: o.baseSize - 1 }) : b.run("")
        ], { spacing: { after: 30 } }));
      });
    }

    // Education lives in sidebar for Executive / Editorial
    if (style === "executive" || style === "editorial") {
      const edus = Array.isArray(resume.education) ? resume.education : [];
      if (edus.length) {
        out.push(b.sideSectionHeading("Education", headingColor, underline));
        edus.forEach(function (e) {
          out.push(b.para([b.run((e.school || "").toUpperCase(), { bold: true, color: sideText, size: o.baseSize - 1 })], { spacing: { after: 10 } }));
          const range = (e.startDate || "") + (e.startDate && e.endDate ? " — " : "") + (e.endDate || "");
          if (range) out.push(b.para([b.run(range, { color: muted, size: o.baseSize - 1 })], { spacing: { after: 10 } }));
          const degree = [e.degree, e.field].filter(Boolean).join(", ");
          if (degree) {
            out.push(b.para([b.run(degree, { italics: true, color: onDark ? "E5EAF0" : "374151", size: o.baseSize - 1 })], { spacing: { after: 80 } }));
          } else {
            out.push(b.blankPara(80));
          }
        });
      }
    }

    // Interests (Hobbies label for sidebar)
    const interests = (Array.isArray(resume.interests) ? resume.interests : [])
      .map(function (i) { return i && i.label ? i.label : ""; }).filter(Boolean);
    if (interests.length) {
      out.push(b.sideSectionHeading(style === "sidebar" ? "Hobbies" : "Interests", headingColor, underline));
      interests.forEach(function (label) {
        out.push(new b.d.Paragraph({
          children: [b.run(label, { color: onDark ? "E5EAF0" : "374151", size: o.baseSize - 1 })],
          bullet: { level: 0 },
          spacing: { after: 30 }
        }));
      });
    }

    // Certifications in sidebar for Executive / Editorial / Timeline
    if (style === "executive" || style === "editorial" || style === "timeline") {
      const certs = Array.isArray(resume.certifications) ? resume.certifications : [];
      if (certs.length) {
        out.push(b.sideSectionHeading("Certifications", headingColor, underline));
        certs.forEach(function (c) {
          const meta = [c.issuer, c.date].filter(Boolean).join(" · ");
          out.push(b.para([
            b.run(c.name || "", { bold: true, color: sideText, size: o.baseSize - 1 }),
            meta ? b.run(" — " + meta, { color: muted, size: o.baseSize - 1 }) : b.run("")
          ], { spacing: { after: 30 } }));
        });
      }
    }

    if (style === "timeline") {
      const refs = Array.isArray(resume.references) ? resume.references : [];
      if (refs.length) {
        out.push(b.sideSectionHeading("References", headingColor, underline));
        refs.forEach(function (r) {
          out.push(b.para([b.run(r.name || "", { bold: true, color: sideText, size: o.baseSize - 1 })], { spacing: { after: 10 } }));
          const meta = [r.role, r.company].filter(Boolean).join(" · ");
          if (meta) out.push(b.para([b.run(meta, { italics: true, color: muted, size: o.baseSize - 1 })], { spacing: { after: 40 } }));
        });
      }
    }

    if (!out.length) out.push(b.para([b.run("")]));
    return out;
  }

  function buildMainChildren(resume, b, o, style) {
    const summaryLabel = style === "editorial" ? "Professional profile"
      : style === "timeline" ? "Profile"
      : "Summary";

    const out = [];
    if (resume.summary) Array.prototype.push.apply(out, buildSummary(resume, b, o, summaryLabel));
    Array.prototype.push.apply(out, buildExperience(resume, b, o));
    if (style === "sidebar" || style === "timeline") {
      Array.prototype.push.apply(out, buildEducation(resume, b, o));
    }
    Array.prototype.push.apply(out, buildProjects(resume, b, o));
    if (style === "sidebar") {
      Array.prototype.push.apply(out, buildCertifications(resume, b, o));
    }
    if (style !== "timeline") {
      Array.prototype.push.apply(out, buildReferences(resume, b, o));
    }
    if (!out.length) out.push(b.para([b.run("")]));
    return out;
  }

  function buildTwoColumn(resume, b, o, style) {
    const d = b.d;
    const heroParagraphs = buildHero(resume, b, o, style);
    const sidebar = buildSidebarChildren(resume, b, o, style);
    const main = buildMainChildren(resume, b, o, style);

    const sideFill = o.sideBg || "F7F5F0";
    const sideWidth = Math.round(CONTENT_WIDTH_DXA_A4 * (o.sideWidthPct || 34) / 100);
    const mainWidth = CONTENT_WIDTH_DXA_A4 - sideWidth;

    const noBorder = { style: b.BOR.NONE, size: 0, color: "FFFFFF" };

    const table = new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      columnWidths: [sideWidth, mainWidth],
      borders: {
        top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
        insideHorizontal: noBorder, insideVertical: noBorder
      },
      rows: [
        new d.TableRow({
          children: [
            new d.TableCell({
              width: { size: sideWidth, type: d.WidthType.DXA },
              shading: { fill: sideFill, type: d.ShadingType.CLEAR, color: sideFill },
              margins: { top: 300, bottom: 300, left: 280, right: 240 },
              children: sidebar
            }),
            new d.TableCell({
              width: { size: mainWidth, type: d.WidthType.DXA },
              margins: { top: 300, bottom: 300, left: 320, right: 280 },
              children: main
            })
          ]
        })
      ]
    });

    return [].concat(heroParagraphs, [table]);
  }

  // ---------------------------------------------------------------------------
  // Public entry points
  // ---------------------------------------------------------------------------
  function buildDocx(resume, opts, style, docx) {
    const o = resolveDocxOpts(style || "classic", opts);
    const b = makeBuilder(docx, o);

    const children = (o.layout === "sidebar")
      ? buildTwoColumn(resume, b, o, style)
      : buildSingleColumn(resume, b, o, style);

    // Page + margins
    const pageSize = (o.pageSize === "letter")
      ? { width: 12240, height: 15840 }    // 8.5" × 11" in DXA
      : { width: 11906, height: 16838 };   // A4 in DXA
    const margins = (function () {
      if (o.quality === "high") {
        if (o.layout === "sidebar") return { top: 220, right: 220, bottom: 220, left: 220 };
        return { top: 980, right: 1080, bottom: 980, left: 1080 };
      }
      if (o.layout === "sidebar") return { top: 0, right: 0, bottom: 0, left: 0 };
      return { top: 900, right: 1000, bottom: 900, left: 1000 };
    })();

    const h = (resume && resume.header) || {};

    return new docx.Document({
      creator: "Career Boost — Resume Lab",
      title: (h.name || "Resume") + " — Resume",
      styles: {
        default: { document: { run: { font: o.font, size: o.baseSize } } }
      },
      sections: [{
        properties: { page: { size: pageSize, margin: margins } },
        children: children
      }]
    });
  }

  async function toBlob(resume, opts, style) {
    const docxLib = await loadDocx();
    if (window.CBV2.resume && window.CBV2.resume.model && window.CBV2.resume.model.ensureShape) {
      window.CBV2.resume.model.ensureShape(resume);
    }
    const doc = buildDocx(resume, opts, style, docxLib);
    return docxLib.Packer.toBlob(doc);
  }

  window.CBV2.resume.docx = {
    loadDocx: loadDocx,
    buildDocx: buildDocx,
    toBlob: toBlob
  };
})();
