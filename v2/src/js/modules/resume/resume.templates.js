(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  // ---------------------------------------------------------------------------
  // Helpers — shared across all templates
  // ---------------------------------------------------------------------------
  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatRange(start, end, current) {
    const s = start || "";
    const e = current ? "Present" : (end || "");
    if (!s && !e) return "";
    return esc(s) + (s && e ? " — " : "") + esc(e);
  }

  function nonEmpty(arr) {
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  }

  function bulletTexts(bullets) {
    return nonEmpty(bullets).map(function (b) { return b && b.text ? b.text : ""; }).filter(Boolean);
  }

  /** All skill strings in group order, case-insensitive dedupe (export / print only). */
  function collectAllSkillItems(r) {
    const groups = (r.skills && r.skills.groups) || [];
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

  function monogramFrom(name) {
    if (!name) return "";
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex || "").replace(/^#/, "");
    if (h.length !== 3 && h.length !== 6) return "rgba(0,0,0," + (alpha || 1) + ")";
    const full = h.length === 3 ? h.split("").map(function (c) { return c + c; }).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + (alpha == null ? 1 : alpha) + ")";
  }

  // Icon set rendered as inline SVGs so they print without any icon-font dependency.
  // Each returns a small 14×14 / 16×16 svg tinted via currentColor.
  const ICONS = {
    mail:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    phone:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    location: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    link:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    cake:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s1-1 4-1 5 2 8 2 4-1 4-1"/><path d="M2 21h20"/><path d="M7 8v3"/><path d="M12 8v3"/><path d="M17 8v3"/><path d="M7 4h.01"/><path d="M12 4h.01"/><path d="M17 4h.01"/></svg>',
    car:      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 17h2a1 1 0 0 0 1-1v-3a5 5 0 0 0-5-5h-1l-2-3H8L6 8H5a5 5 0 0 0-5 5v3a1 1 0 0 0 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    flag:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>',
    heart:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    user:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    briefcase:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    book:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/></svg>',
    badge:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>',
    star:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
  };

  function headerContact(h) {
    const parts = [];
    if (h.email) parts.push({ icon: ICONS.mail, text: h.email, href: "mailto:" + h.email });
    if (h.phone) parts.push({ icon: ICONS.phone, text: h.phone, href: "tel:" + h.phone.replace(/\s+/g, "") });
    if (h.location) parts.push({ icon: ICONS.location, text: h.location });
    (h.links || []).forEach(function (l) {
      if (!l) return;
      const label = l.label || l.url || "";
      const url = l.url || "";
      if (label) parts.push({ icon: ICONS.link, text: label, href: url });
    });
    return parts;
  }

  function personalDetails(h) {
    const out = [];
    if (h.dateOfBirth) out.push({ icon: ICONS.cake, label: "Date of birth", value: h.dateOfBirth });
    if (h.nationality) out.push({ icon: ICONS.flag, label: "Nationality", value: h.nationality });
    if (h.drivingLicense) out.push({ icon: ICONS.car, label: "Driving licence", value: h.drivingLicense });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Normalized options
  // ---------------------------------------------------------------------------
  function defaultsFor(templateId) {
    if (templateId === "modern") {
      return { accent: "#1F5FFF", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "minimal") {
      return { accent: "#111111", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "executive") {
      return { accent: "#1F2E4A", fontSize: 10.5, pageSize: "a4", fontFamily: "serif" };
    }
    if (templateId === "timeline") {
      return { accent: "#13294B", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "sidebar") {
      return { accent: "#2C3E50", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "editorial") {
      return { accent: "#2B2F3A", fontSize: 10.5, pageSize: "a4", fontFamily: "serif" };
    }
    if (templateId === "metro-dark") {
      return { accent: "#343A40", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "soft-blue") {
      return { accent: "#9FB4DB", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "horizon-blue") {
      return { accent: "#AFCFE5", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "mint-line") {
      return { accent: "#2AB7A9", fontSize: 10.5, pageSize: "a4", fontFamily: "sans" };
    }
    if (templateId === "clean-pro") {
      return { accent: "#7A7A7A", fontSize: 10.5, pageSize: "a4", fontFamily: "serif" };
    }
    return { accent: "#0F172A", fontSize: 10.5, pageSize: "a4", fontFamily: "serif" };
  }

  function resolveOpts(templateId, opts) {
    const d = defaultsFor(templateId);
    const o = Object.assign({}, d, opts || {});
    if (typeof o.fontSize !== "number" || o.fontSize < 8 || o.fontSize > 14) o.fontSize = d.fontSize;
    if (o.pageSize !== "letter" && o.pageSize !== "a4") o.pageSize = "a4";
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(o.accent)) o.accent = d.accent;
    return o;
  }

  function injectCss(html, cssText) {
    if (!cssText) return html;
    return String(html || "").replace("</style>", cssText + "</style>");
  }

  function pageSizeCss(o) {
    return o.pageSize === "letter"
      ? "@page { size: Letter; margin: 0; }"
      : "@page { size: A4; margin: 0; }";
  }

  function fontStack(o) {
    if (o.fontFamily === "serif") return '"Source Serif Pro", "Georgia", "Cambria", serif';
    if (o.fontFamily === "mono") return '"JetBrains Mono", "SFMono-Regular", Menlo, monospace';
    return '"Inter", "Helvetica Neue", Arial, sans-serif';
  }

  // ---------------------------------------------------------------------------
  // Shared section renderers
  // ---------------------------------------------------------------------------
  function renderSummary(r) {
    if (!r.summary) return "";
    return '<p class="summary">' + esc(r.summary) + "</p>";
  }

  function renderExperienceItems(r) {
    const exps = nonEmpty(r.experience);
    if (!exps.length) return "";
    return exps.map(function (e) {
      const bl = bulletTexts(e.bullets);
      const range = formatRange(e.startDate, e.endDate, e.current);
      return (
        '<article class="exp-item">' +
          '<header class="exp-head">' +
            '<div class="exp-role">' + esc(e.role || "") + '</div>' +
            (range ? '<div class="exp-range">' + range + '</div>' : '') +
          '</header>' +
          '<div class="exp-company-row">' +
            '<span class="exp-company">' + esc(e.company || "") + '</span>' +
            (e.location ? '<span class="exp-location">' + esc(e.location) + '</span>' : '') +
          '</div>' +
          (bl.length ? '<ul class="exp-bullets">' + bl.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join("") + '</ul>' : '') +
        '</article>'
      );
    }).join("");
  }

  // Experience with dates rendered in a left date-column — used by sidebar/editorial.
  function renderExperienceDated(r) {
    const exps = nonEmpty(r.experience);
    if (!exps.length) return "";
    return exps.map(function (e) {
      const bl = bulletTexts(e.bullets);
      const range = formatRange(e.startDate, e.endDate, e.current);
      return (
        '<article class="exp-dated">' +
          '<div class="exp-dates">' + range + '</div>' +
          '<div class="exp-body">' +
            '<div class="exp-role">' + esc(e.role || "") + '</div>' +
            '<div class="exp-company">' + esc(e.company || "") + (e.location ? ' <span class="exp-location">· ' + esc(e.location) + '</span>' : '') + '</div>' +
            (bl.length ? '<ul class="exp-bullets">' + bl.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join("") + '</ul>' : '') +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function renderEducationItems(r) {
    const edus = nonEmpty(r.education);
    if (!edus.length) return "";
    return edus.map(function (e) {
      const range = formatRange(e.startDate, e.endDate, false);
      const degree = [e.degree, e.field].filter(Boolean).join(", ");
      return (
        '<article class="edu-item">' +
          '<header class="edu-head">' +
            '<div class="edu-school">' + esc(e.school || "") + '</div>' +
            (range ? '<div class="edu-range">' + range + '</div>' : '') +
          '</header>' +
          (degree ? '<div class="edu-degree">' + esc(degree) + '</div>' : '') +
          (e.notes ? '<div class="edu-notes">' + esc(e.notes) + '</div>' : '') +
        '</article>'
      );
    }).join("");
  }

  function renderSkillsFlat(r) {
    const all = collectAllSkillItems(r);
    if (!all.length) return "";
    return '<p class="lang-line">' + all.map(esc).join(" · ") + "</p>";
  }

  function renderSkillsBulletList(r) {
    const all = collectAllSkillItems(r);
    if (!all.length) return "";
    return '<ul class="skills-bullets">' + all.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join("") + '</ul>';
  }

  function renderSkillsGrouped(r) {
    return renderSkillsFlat(r);
  }

  function renderSkillsChips(r) {
    return renderSkillsFlat(r);
  }

  function renderSkillsSidebar(r) {
    return renderSkillsFlat(r);
  }

  function renderProjects(r) {
    const items = nonEmpty(r.projects);
    if (!items.length) return "";
    return items.map(function (p) {
      const bl = bulletTexts(p.bullets);
      const linkPart = p.url ? '<span class="prj-url">' + esc(p.url) + '</span>' : '';
      return (
        '<article class="prj-item">' +
          '<header class="prj-head">' +
            '<div class="prj-name">' + esc(p.name || "") + '</div>' +
            linkPart +
          '</header>' +
          (p.description ? '<p class="prj-desc">' + esc(p.description) + '</p>' : '') +
          (bl.length ? '<ul class="prj-bullets">' + bl.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join("") + '</ul>' : '') +
        '</article>'
      );
    }).join("");
  }

  function renderCertifications(r) {
    const items = nonEmpty(r.certifications);
    if (!items.length) return "";
    return '<ul class="cert-list">' + items.map(function (c) {
      const meta = [c.issuer, c.date].filter(Boolean).join(" · ");
      return (
        '<li>' +
          '<span class="cert-name">' + esc(c.name || "") + '</span>' +
          (meta ? '<span class="cert-meta"> — ' + esc(meta) + '</span>' : '') +
        '</li>'
      );
    }).join("") + '</ul>';
  }

  function renderLanguages(r) {
    const items = nonEmpty(r.languages);
    if (!items.length) return "";
    return '<p class="lang-line">' + items.map(function (l) {
      return esc(l.name || "") + (l.level ? ' <span class="lang-level">(' + esc(l.level) + ')</span>' : '');
    }).join(" · ") + '</p>';
  }

  function renderLanguagesList(r) {
    const items = nonEmpty(r.languages);
    if (!items.length) return "";
    return '<ul class="lang-list">' + items.map(function (l) {
      return '<li><span class="lang-name">' + esc(l.name || "") + '</span>' +
        (l.level ? ' <span class="lang-level">(' + esc(l.level) + ')</span>' : '') + '</li>';
    }).join("") + '</ul>';
  }

  function renderInterests(r) {
    const items = nonEmpty(r.interests);
    if (!items.length) return "";
    return '<ul class="interest-list">' + items.map(function (i) {
      return '<li>' + esc(i.label || "") + '</li>';
    }).join("") + '</ul>';
  }

  function renderReferences(r) {
    const items = nonEmpty(r.references);
    if (!items.length) return "";
    return items.map(function (ref) {
      const meta = [ref.role, ref.company].filter(Boolean).join(" · ");
      const contact = [ref.email, ref.phone].filter(Boolean).join("  ·  ");
      return (
        '<div class="ref-item">' +
          '<div class="ref-name">' + esc(ref.name || "") + '</div>' +
          (meta ? '<div class="ref-meta">' + esc(meta) + '</div>' : '') +
          (contact ? '<div class="ref-contact">' + esc(contact) + '</div>' : '') +
          (ref.note ? '<div class="ref-note">' + esc(ref.note) + '</div>' : '') +
        '</div>'
      );
    }).join("");
  }

  // =============================================================================
  // TEMPLATE 1 — Classic (serif, ATS-safe, single column)
  // =============================================================================
  function classicHtml(r, opts) {
    const o = resolveOpts("classic", opts);
    const h = r.header || {};
    const contacts = headerContact(h);
    const contactLine = contacts.map(function (c) { return c.text; }).join("  •  ");

    const sections = [
      r.summary && '<section class="rl-section"><h2>Summary</h2>' + renderSummary(r) + '</section>',
      renderExperienceItems(r) && '<section class="rl-section"><h2>Experience</h2>' + renderExperienceItems(r) + '</section>',
      renderEducationItems(r) && '<section class="rl-section"><h2>Education</h2>' + renderEducationItems(r) + '</section>',
      renderSkillsGrouped(r) && '<section class="rl-section"><h2>Skills</h2>' + renderSkillsGrouped(r) + '</section>',
      renderProjects(r) && '<section class="rl-section"><h2>Projects</h2>' + renderProjects(r) + '</section>',
      renderCertifications(r) && '<section class="rl-section"><h2>Certifications</h2>' + renderCertifications(r) + '</section>',
      renderLanguages(r) && '<section class="rl-section"><h2>Languages</h2>' + renderLanguages(r) + '</section>'
    ].filter(Boolean).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #111; line-height: 1.45; background: #fff; }' +
      '.rl-doc { padding: 22mm 20mm; max-width: 800px; margin: 0 auto; }' +
      '.rl-header { text-align: center; padding-bottom: 10px; border-bottom: 1.5px solid #111; }' +
      '.rl-name { font-size: ' + (o.fontSize + 12) + 'pt; letter-spacing: 0.04em; margin: 0 0 4px; font-weight: 700; text-transform: uppercase; }' +
      '.rl-title { font-size: ' + (o.fontSize + 1) + 'pt; color: #444; margin: 0 0 8px; font-style: italic; }' +
      '.rl-contact { font-size: ' + (o.fontSize - 1) + 'pt; color: #333; line-height: 1.5; }' +
      '.rl-section { margin-top: 14px; }' +
      '.rl-section h2 { font-size: ' + (o.fontSize + 3) + 'pt; font-weight: 700; margin: 0 0 6px; padding-bottom: 3px; border-bottom: 1px solid #ccc; text-transform: uppercase; letter-spacing: 0.08em; color: ' + o.accent + '; }' +
      '.summary { margin: 0 0 4px; }' +
      '.exp-item, .edu-item, .prj-item { margin-bottom: 10px; page-break-inside: avoid; }' +
      '.exp-head, .edu-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }' +
      '.exp-role, .edu-school, .prj-name { font-weight: 700; }' +
      '.exp-range, .edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #555; white-space: nowrap; }' +
      '.exp-company-row { display: flex; justify-content: space-between; font-style: italic; color: #333; margin: 1px 0 4px; }' +
      '.exp-bullets, .prj-bullets { margin: 4px 0 0 18px; padding: 0; }' +
      '.exp-bullets li, .prj-bullets li { margin-bottom: 2px; }' +
      '.edu-degree { font-style: italic; color: #333; }' +
      '.lang-line { margin: 0; color: #333; font-weight: 400; line-height: 1.55; }' +
      '.cert-list { margin: 0; padding-left: 18px; }' +
      '.cert-list li { margin-bottom: 2px; }' +
      '.cert-meta, .lang-level { color: #555; }' +
      '.prj-url { color: #555; font-size: ' + (o.fontSize - 1) + 'pt; }' +
      '.prj-desc { margin: 2px 0; color: #333; }'
    );

    return (
      '<div class="rl-doc rl-classic">' +
        '<header class="rl-header">' +
          '<h1 class="rl-name">' + esc(h.name || "") + '</h1>' +
          (h.title ? '<p class="rl-title">' + esc(h.title) + '</p>' : '') +
          (contactLine ? '<p class="rl-contact">' + esc(contactLine) + '</p>' : '') +
        '</header>' +
        sections +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE 2 — Modern (sans-serif, accent bar)
  // =============================================================================
  function modernHtml(r, opts) {
    const o = resolveOpts("modern", opts);
    const h = r.header || {};
    const contacts = headerContact(h);
    const contactHtml = contacts.map(function (c) {
      return '<span class="contact-item">' + esc(c.text) + '</span>';
    }).join("");

    const sections = [
      r.summary && '<section class="rl-section"><h2>Profile</h2><div class="section-body">' + renderSummary(r) + '</div></section>',
      renderExperienceItems(r) && '<section class="rl-section"><h2>Experience</h2><div class="section-body">' + renderExperienceItems(r) + '</div></section>',
      renderProjects(r) && '<section class="rl-section"><h2>Projects</h2><div class="section-body">' + renderProjects(r) + '</div></section>',
      renderEducationItems(r) && '<section class="rl-section"><h2>Education</h2><div class="section-body">' + renderEducationItems(r) + '</div></section>',
      renderSkillsChips(r) && '<section class="rl-section"><h2>Skills</h2><div class="section-body">' + renderSkillsChips(r) + '</div></section>',
      renderCertifications(r) && '<section class="rl-section"><h2>Certifications</h2><div class="section-body">' + renderCertifications(r) + '</div></section>',
      renderLanguages(r) && '<section class="rl-section"><h2>Languages</h2><div class="section-body">' + renderLanguages(r) + '</div></section>'
    ].filter(Boolean).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #1f2937; line-height: 1.5; background: #fff; }' +
      '.rl-doc { max-width: 820px; margin: 0 auto; padding: 18mm 16mm; }' +
      '.rl-header { padding: 16px 0 18px; border-left: 5px solid ' + o.accent + '; padding-left: 16px; margin-bottom: 18px; }' +
      '.rl-name { font-size: ' + (o.fontSize + 14) + 'pt; margin: 0 0 2px; font-weight: 700; letter-spacing: -0.01em; color: #0f172a; }' +
      '.rl-title { font-size: ' + (o.fontSize + 2) + 'pt; margin: 0 0 10px; color: ' + o.accent + '; font-weight: 600; letter-spacing: 0.02em; }' +
      '.rl-contact { font-size: ' + (o.fontSize - 1) + 'pt; color: #4b5563; display: flex; flex-wrap: wrap; gap: 14px; margin: 0; }' +
      '.contact-item { white-space: nowrap; }' +
      '.rl-section { margin-bottom: 14px; page-break-inside: avoid; }' +
      '.rl-section h2 { font-size: ' + (o.fontSize + 1) + 'pt; color: ' + o.accent + '; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }' +
      '.summary { margin: 0; color: #111827; }' +
      '.exp-item, .edu-item, .prj-item { margin-bottom: 12px; page-break-inside: avoid; }' +
      '.exp-head, .edu-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }' +
      '.exp-role, .edu-school, .prj-name { font-size: ' + (o.fontSize + 1) + 'pt; font-weight: 700; color: #111827; }' +
      '.exp-range, .edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #6b7280; font-weight: 600; white-space: nowrap; }' +
      '.exp-company-row { display: flex; justify-content: space-between; color: ' + o.accent + '; font-weight: 600; margin: 2px 0 6px; font-size: ' + o.fontSize + 'pt; }' +
      '.exp-location { color: #6b7280; font-weight: 400; }' +
      '.exp-bullets, .prj-bullets { margin: 4px 0 0 18px; padding: 0; color: #374151; }' +
      '.exp-bullets li, .prj-bullets li { margin-bottom: 3px; }' +
      '.edu-degree { color: #4b5563; font-weight: 500; }' +
      '.cert-list { margin: 0; padding-left: 18px; color: #374151; }' +
      '.cert-name { font-weight: 600; color: #111827; }' +
      '.cert-meta, .lang-level { color: #6b7280; }' +
      '.prj-url { color: ' + o.accent + '; font-size: ' + (o.fontSize - 1) + 'pt; }' +
      '.lang-line { margin: 0; color: #374151; font-weight: 400; line-height: 1.55; }' +
      '.section-body { padding-left: 2px; }'
    );

    return (
      '<div class="rl-doc rl-modern">' +
        '<header class="rl-header">' +
          '<h1 class="rl-name">' + esc(h.name || "") + '</h1>' +
          (h.title ? '<p class="rl-title">' + esc(h.title) + '</p>' : '') +
          (contacts.length ? '<p class="rl-contact">' + contactHtml + '</p>' : '') +
        '</header>' +
        sections +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE 3 — Minimal (ultra-clean, big whitespace)
  // =============================================================================
  function minimalHtml(r, opts) {
    const o = resolveOpts("minimal", opts);
    const h = r.header || {};
    const contacts = headerContact(h);

    const sections = [
      r.summary && '<section class="rl-section"><h2>About</h2>' + renderSummary(r) + '</section>',
      renderExperienceItems(r) && '<section class="rl-section"><h2>Experience</h2>' + renderExperienceItems(r) + '</section>',
      renderEducationItems(r) && '<section class="rl-section"><h2>Education</h2>' + renderEducationItems(r) + '</section>',
      renderSkillsFlat(r) && '<section class="rl-section"><h2>Skills</h2>' + renderSkillsFlat(r) + '</section>',
      renderProjects(r) && '<section class="rl-section"><h2>Projects</h2>' + renderProjects(r) + '</section>',
      renderCertifications(r) && '<section class="rl-section"><h2>Certifications</h2>' + renderCertifications(r) + '</section>',
      renderLanguages(r) && '<section class="rl-section"><h2>Languages</h2>' + renderLanguages(r) + '</section>'
    ].filter(Boolean).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #171717; line-height: 1.6; background: #fff; font-weight: 300; }' +
      '.rl-doc { max-width: 820px; margin: 0 auto; padding: 22mm 20mm; }' +
      '.rl-header { margin-bottom: 24px; }' +
      '.rl-name { font-size: ' + (o.fontSize + 18) + 'pt; margin: 0 0 4px; font-weight: 200; letter-spacing: -0.02em; color: ' + o.accent + '; }' +
      '.rl-title { font-size: ' + (o.fontSize + 1) + 'pt; margin: 0 0 12px; color: #737373; font-weight: 300; letter-spacing: 0.02em; }' +
      '.rl-contact { margin: 0; display: flex; flex-wrap: wrap; gap: 20px; font-size: ' + (o.fontSize - 1) + 'pt; color: #525252; font-weight: 400; }' +
      '.rl-section { margin: 0 0 18px; page-break-inside: avoid; }' +
      '.rl-section h2 { font-size: ' + (o.fontSize - 1) + 'pt; color: #737373; font-weight: 600; text-transform: uppercase; letter-spacing: 0.22em; margin: 0 0 10px; padding: 0 0 6px; border-bottom: 0.5px solid #e5e5e5; }' +
      '.summary { margin: 0; font-weight: 300; line-height: 1.7; }' +
      '.exp-item, .edu-item, .prj-item { margin-bottom: 14px; page-break-inside: avoid; }' +
      '.exp-head, .edu-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; }' +
      '.exp-role, .edu-school, .prj-name { font-weight: 500; color: #171717; font-size: ' + (o.fontSize + 1) + 'pt; }' +
      '.exp-range, .edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #a3a3a3; white-space: nowrap; font-weight: 300; }' +
      '.exp-company-row { display: flex; justify-content: space-between; color: #525252; margin: 2px 0 6px; }' +
      '.exp-company { font-weight: 400; }' +
      '.exp-location, .lang-level, .cert-meta { color: #a3a3a3; }' +
      '.exp-bullets, .prj-bullets { margin: 6px 0 0 0; padding: 0; list-style: none; }' +
      '.exp-bullets li, .prj-bullets li { margin-bottom: 4px; padding-left: 14px; position: relative; color: #404040; font-weight: 300; }' +
      '.exp-bullets li::before, .prj-bullets li::before { content: "—"; position: absolute; left: 0; color: #a3a3a3; }' +
      '.edu-degree { color: #525252; font-weight: 300; }' +
      '.cert-list { margin: 0; padding: 0; list-style: none; }' +
      '.cert-list li { margin-bottom: 4px; padding-left: 14px; position: relative; font-weight: 300; }' +
      '.cert-list li::before { content: "—"; position: absolute; left: 0; color: #a3a3a3; }' +
      '.cert-name { color: #171717; font-weight: 400; }' +
      '.prj-url { color: #a3a3a3; font-size: ' + (o.fontSize - 1) + 'pt; font-weight: 300; }' +
      '.prj-desc { margin: 2px 0 0; color: #525252; font-weight: 300; }' +
      '.lang-line { margin: 0; color: #404040; font-weight: 300; }'
    );

    return (
      '<div class="rl-doc rl-minimal">' +
        '<header class="rl-header">' +
          '<h1 class="rl-name">' + esc(h.name || "") + '</h1>' +
          (h.title ? '<p class="rl-title">' + esc(h.title) + '</p>' : '') +
          (contacts.length ? '<p class="rl-contact">' +
            contacts.map(function (c) { return '<span>' + esc(c.text) + '</span>'; }).join('') +
          '</p>' : '') +
        '</header>' +
        sections +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE 4 — Executive (dark navy hero + monogram + sidebar)
  // =============================================================================
  function executiveHtml(r, opts) {
    const o = resolveOpts("executive", opts);
    const h = r.header || {};
    const mono = monogramFrom(h.name);
    const ink = "#1F2E4A";
    const gold = "#B8935C";
    const accent = o.accent;

    const contactBits = [];
    if (h.phone) contactBits.push({ icon: ICONS.phone, text: h.phone });
    if (h.email) contactBits.push({ icon: ICONS.mail, text: h.email });
    if (h.location) contactBits.push({ icon: ICONS.location, text: h.location });
    (h.links || []).forEach(function (l) { if (l && l.label) contactBits.push({ icon: ICONS.link, text: l.label }); });

    const sidebar = [
      contactBits.length && (
        '<section class="side-section"><h3>Contact</h3>' +
          contactBits.map(function (c) {
            return '<div class="side-contact"><span class="side-ico">' + c.icon + '</span><span>' + esc(c.text) + '</span></div>';
          }).join("") +
        '</section>'
      ),
      renderEducationItems(r) && '<section class="side-section"><h3>Education</h3>' + renderEducationItems(r) + '</section>',
      renderSkillsSidebar(r) && '<section class="side-section"><h3>Skills</h3>' + renderSkillsSidebar(r) + '</section>',
      renderLanguagesList(r) && '<section class="side-section"><h3>Languages</h3>' + renderLanguagesList(r) + '</section>',
      renderCertifications(r) && '<section class="side-section"><h3>Certifications</h3>' + renderCertifications(r) + '</section>',
      renderInterests(r) && '<section class="side-section"><h3>Interests</h3>' + renderInterests(r) + '</section>'
    ].filter(Boolean).join("");

    const main = [
      r.summary && '<section class="main-section"><h2>Summary</h2>' + renderSummary(r) + '</section>',
      renderExperienceItems(r) && '<section class="main-section"><h2>Work Experience</h2>' + renderExperienceItems(r) + '</section>',
      renderProjects(r) && '<section class="main-section"><h2>Projects</h2>' + renderProjects(r) + '</section>',
      renderReferences(r) && '<section class="main-section"><h2>References</h2>' + renderReferences(r) + '</section>'
    ].filter(Boolean).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #1f2937; line-height: 1.5; background: #fff; }' +
      '.rl-doc { width: 100%; }' +
      '.exec-hero { background: ' + ink + '; color: #fff; padding: 34px 40px 30px; text-align: center; }' +
      '.exec-monogram { width: 46px; height: 46px; border-radius: 50%; background: ' + gold + '; color: ' + ink + '; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: ' + (o.fontSize + 4) + 'pt; letter-spacing: 0.05em; margin-bottom: 14px; font-family: ' + fontStack(o) + '; }' +
      '.exec-name { font-size: ' + (o.fontSize + 18) + 'pt; margin: 0 0 8px; font-weight: 400; letter-spacing: 0.18em; color: ' + gold + '; text-transform: uppercase; }' +
      '.exec-title { font-size: ' + (o.fontSize - 1) + 'pt; margin: 0; color: rgba(255,255,255,0.85); letter-spacing: 0.32em; text-transform: uppercase; font-weight: 500; }' +
      '.exec-body { display: table; width: 100%; table-layout: fixed; }' +
      '.exec-side, .exec-main { display: table-cell; vertical-align: top; }' +
      '.exec-side { width: 35%; }' +
      '.exec-main { width: 65%; }' +
      '.exec-side { background: #F7F5F0; padding: 24px 22px; border-right: 1px solid #e5e1d8; }' +
      '.exec-main { padding: 24px 26px; }' +
      '.side-section { margin-bottom: 20px; page-break-inside: avoid; }' +
      '.side-section h3 { font-size: ' + (o.fontSize + 2) + 'pt; color: ' + ink + '; margin: 0 0 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; padding-bottom: 4px; border-bottom: 1.5px solid ' + ink + '; }' +
      '.side-contact { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; font-size: ' + (o.fontSize - 0.5) + 'pt; color: #374151; }' +
      '.side-ico { color: ' + ink + '; flex: 0 0 13px; padding-top: 2px; }' +
      '.lang-line { margin: 0; color: #374151; font-weight: 400; line-height: 1.55; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.lang-list { margin: 0; padding: 0; list-style: none; color: #374151; }' +
      '.lang-list li { margin-bottom: 3px; }' +
      '.lang-name { font-weight: 600; color: #111827; }' +
      '.lang-level { color: #6b7280; }' +
      '.interest-list { margin: 0; padding-left: 16px; color: #374151; }' +
      '.cert-list { margin: 0; padding-left: 16px; color: #374151; }' +
      '.edu-item { margin-bottom: 10px; }' +
      '.edu-head { display: flex; flex-direction: column; }' +
      '.edu-school { font-weight: 700; color: ' + ink + '; font-size: ' + (o.fontSize + 0.5) + 'pt; }' +
      '.edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #6b7280; }' +
      '.edu-degree { color: #374151; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.main-section { margin-bottom: 18px; page-break-inside: avoid; }' +
      '.main-section h2 { font-size: ' + (o.fontSize + 3) + 'pt; color: ' + ink + '; margin: 0 0 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; padding-bottom: 5px; border-bottom: 2px solid ' + accent + '; }' +
      '.summary { margin: 0; color: #374151; text-align: justify; }' +
      '.exp-item, .prj-item { margin-bottom: 14px; page-break-inside: avoid; }' +
      '.exp-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }' +
      '.exp-role, .prj-name { font-weight: 700; color: ' + ink + '; font-size: ' + (o.fontSize + 1) + 'pt; text-transform: uppercase; letter-spacing: 0.04em; }' +
      '.exp-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #6b7280; white-space: nowrap; font-weight: 600; }' +
      '.exp-company-row { color: ' + accent + '; font-style: italic; margin: 2px 0 5px; }' +
      '.exp-location { color: #6b7280; }' +
      '.exp-bullets, .prj-bullets { margin: 4px 0 0 18px; padding: 0; color: #374151; }' +
      '.exp-bullets li, .prj-bullets li { margin-bottom: 3px; }' +
      '.prj-url { color: ' + accent + '; font-size: ' + (o.fontSize - 1) + 'pt; }' +
      '.prj-desc { margin: 2px 0; color: #374151; }' +
      '.ref-item { margin-bottom: 10px; }' +
      '.ref-name { font-weight: 700; color: ' + ink + '; }' +
      '.ref-meta { color: ' + accent + '; font-style: italic; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.ref-contact, .ref-note { color: #374151; font-size: ' + (o.fontSize - 0.5) + 'pt; }'
    );

    return (
      '<div class="rl-doc rl-executive">' +
        '<header class="exec-hero">' +
          (mono ? '<div class="exec-monogram">' + esc(mono) + '</div>' : '') +
          '<h1 class="exec-name">' + esc(h.name || "") + '</h1>' +
          (h.title ? '<p class="exec-title">' + esc(h.title) + '</p>' : '') +
        '</header>' +
        '<div class="exec-body">' +
          '<aside class="exec-side">' + sidebar + '</aside>' +
          '<main class="exec-main">' + main + '</main>' +
        '</div>' +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE 5 — Timeline (connected dots + 2-column)
  // =============================================================================
  function timelineHtml(r, opts) {
    const o = resolveOpts("timeline", opts);
    const h = r.header || {};
    const accent = o.accent;
    const ink = "#0f172a";

    const contactBits = [];
    if (h.phone) contactBits.push({ icon: ICONS.phone, text: h.phone });
    if (h.email) contactBits.push({ icon: ICONS.mail, text: h.email });
    if (h.location) contactBits.push({ icon: ICONS.location, text: h.location });
    (h.links || []).forEach(function (l) { if (l && l.label) contactBits.push({ icon: ICONS.link, text: l.label }); });

    const sideBlocks = [
      contactBits.length && (
        '<section class="tm-side-section"><h3>Contact</h3>' +
          contactBits.map(function (c) {
            return '<div class="side-contact"><span class="side-ico">' + c.icon + '</span><span>' + esc(c.text) + '</span></div>';
          }).join("") +
        '</section>'
      ),
      renderSkillsBulletList(r) && '<section class="tm-side-section"><h3>Skills</h3>' + renderSkillsBulletList(r) + '</section>',
      renderLanguagesList(r) && '<section class="tm-side-section"><h3>Languages</h3>' + renderLanguagesList(r) + '</section>',
      renderCertifications(r) && '<section class="tm-side-section"><h3>Certifications</h3>' + renderCertifications(r) + '</section>',
      renderReferences(r) && '<section class="tm-side-section"><h3>References</h3>' + renderReferences(r) + '</section>',
      renderInterests(r) && '<section class="tm-side-section"><h3>Interests</h3>' + renderInterests(r) + '</section>'
    ].filter(Boolean).join("");

    const timelineSections = [
      r.summary && ['<i class="fa">' + ICONS.user + '</i>', 'Profile', renderSummary(r)],
      renderExperienceItems(r) && ['<i class="fa">' + ICONS.briefcase + '</i>', 'Work Experience', renderExperienceItems(r)],
      renderEducationItems(r) && ['<i class="fa">' + ICONS.book + '</i>', 'Education', renderEducationItems(r)],
      renderProjects(r) && ['<i class="fa">' + ICONS.star + '</i>', 'Projects', renderProjects(r)]
    ].filter(Boolean);
    const timelineHtmlBlocks = timelineSections.map(function (t) {
      return (
        '<section class="tm-section">' +
          '<div class="tm-dot">' + t[0] + '</div>' +
          '<div class="tm-content">' +
            '<h2>' + esc(t[1]) + '</h2>' +
            '<div class="tm-body">' + t[2] + '</div>' +
          '</div>' +
        '</section>'
      );
    }).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #1f2937; line-height: 1.5; background: #fff; }' +
      '.rl-doc { width: 100%; background: #fafaf7; }' +
      '.tm-header { padding: 30px 40px 22px; background: transparent; border-bottom: 1px solid #e5e7eb; }' +
      '.tm-name { font-size: ' + (o.fontSize + 18) + 'pt; margin: 0 0 4px; font-weight: 800; letter-spacing: 0.04em; color: ' + ink + '; text-transform: uppercase; }' +
      '.tm-title { font-size: ' + (o.fontSize - 1) + 'pt; margin: 0; color: ' + accent + '; font-weight: 600; letter-spacing: 0.28em; text-transform: uppercase; }' +
      '.tm-divider { height: 3px; width: 60px; background: ' + accent + '; margin: 10px 0 0; }' +
      '.tm-body-grid { display: table; width: 100%; table-layout: fixed; }' +
      '.tm-side, .tm-main { display: table-cell; vertical-align: top; }' +
      '.tm-side { width: 34%; }' +
      '.tm-main { width: 66%; }' +
      '.tm-side { padding: 24px 22px; background: #F2EFE6; }' +
      '.tm-main { padding: 28px 36px; position: relative; }' +
      '.tm-main::before { content: ""; position: absolute; left: 46px; top: 34px; bottom: 24px; width: 1.5px; background: #d4d4d8; }' +
      '.tm-side-section { margin-bottom: 18px; page-break-inside: avoid; }' +
      '.tm-side-section h3 { font-size: ' + (o.fontSize + 1) + 'pt; color: ' + ink + '; margin: 0 0 8px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; position: relative; padding-bottom: 4px; }' +
      '.tm-side-section h3::after { content: ""; position: absolute; left: 0; bottom: 0; width: 30px; height: 2px; background: ' + accent + '; }' +
      '.side-contact { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 5px; font-size: ' + (o.fontSize - 0.5) + 'pt; color: #374151; }' +
      '.side-ico { color: ' + accent + '; flex: 0 0 13px; padding-top: 2px; }' +
      '.skills-bullets { margin: 0; padding-left: 16px; color: #374151; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.skills-bullets li { margin-bottom: 2px; }' +
      '.lang-list { margin: 0; padding: 0; list-style: none; color: #374151; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.lang-list li { margin-bottom: 3px; }' +
      '.lang-name { font-weight: 600; color: ' + ink + '; }' +
      '.lang-level { color: #6b7280; }' +
      '.cert-list, .interest-list { margin: 0; padding-left: 16px; color: #374151; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.cert-name { color: ' + ink + '; font-weight: 600; }' +
      '.ref-item { margin-bottom: 8px; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.ref-name { color: ' + ink + '; font-weight: 700; }' +
      '.ref-meta { color: #6b7280; }' +
      '.tm-section { position: relative; padding-left: 38px; margin-bottom: 18px; page-break-inside: avoid; }' +
      '.tm-dot { position: absolute; left: 2px; top: 0; width: 30px; height: 30px; border-radius: 50%; background: ' + ink + '; color: #fff; display: flex; align-items: center; justify-content: center; z-index: 1; border: 3px solid #fff; box-shadow: 0 0 0 1.5px #d4d4d8; }' +
      '.tm-dot svg { width: 14px; height: 14px; }' +
      '.tm-content h2 { font-size: ' + (o.fontSize + 3) + 'pt; color: ' + ink + '; margin: 4px 0 6px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }' +
      '.tm-body { padding-bottom: 4px; }' +
      '.summary { margin: 0; color: #374151; font-style: italic; }' +
      '.exp-item, .edu-item, .prj-item { margin-bottom: 10px; page-break-inside: avoid; }' +
      '.exp-head, .edu-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }' +
      '.exp-role, .edu-school, .prj-name { font-weight: 700; color: ' + ink + '; font-size: ' + (o.fontSize + 0.5) + 'pt; }' +
      '.exp-range, .edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #6b7280; white-space: nowrap; font-weight: 600; }' +
      '.exp-company-row { color: ' + accent + '; font-weight: 600; margin: 1px 0 4px; }' +
      '.exp-location { color: #6b7280; font-weight: 400; }' +
      '.exp-bullets, .prj-bullets { margin: 3px 0 0 18px; padding: 0; color: #374151; }' +
      '.exp-bullets li, .prj-bullets li { margin-bottom: 2px; }' +
      '.edu-degree { color: #525252; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.prj-url { color: ' + accent + '; font-size: ' + (o.fontSize - 1) + 'pt; }'
    );

    return (
      '<div class="rl-doc rl-timeline">' +
        '<header class="tm-header">' +
          '<h1 class="tm-name">' + esc(h.name || "") + '</h1>' +
          (h.title ? '<p class="tm-title">' + esc(h.title) + '</p>' : '') +
          '<div class="tm-divider"></div>' +
        '</header>' +
        '<div class="tm-body-grid">' +
          '<aside class="tm-side">' + sideBlocks + '</aside>' +
          '<main class="tm-main">' + timelineHtmlBlocks + '</main>' +
        '</div>' +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE 6 — Sidebar Pro (dark left sidebar with photo + icon contact)
  // =============================================================================
  function sidebarHtml(r, opts) {
    const o = resolveOpts("sidebar", opts);
    const h = r.header || {};
    const dark = o.accent;

    const contactBits = [];
    if (h.location) contactBits.push({ icon: ICONS.location, label: "Address", value: h.location });
    if (h.email) contactBits.push({ icon: ICONS.mail, label: "Email", value: h.email });
    if (h.phone) contactBits.push({ icon: ICONS.phone, label: "Phone", value: h.phone });
    if (h.dateOfBirth) contactBits.push({ icon: ICONS.cake, label: "Date of birth", value: h.dateOfBirth });
    if (h.drivingLicense) contactBits.push({ icon: ICONS.car, label: "Driving licence", value: h.drivingLicense });
    if (h.nationality) contactBits.push({ icon: ICONS.flag, label: "Nationality", value: h.nationality });
    (h.links || []).forEach(function (l) { if (l && (l.label || l.url)) contactBits.push({ icon: ICONS.link, label: l.label || "Link", value: l.url || l.label }); });

    const sidebar =
      (h.photo ? '<div class="sb-photo-wrap"><img class="sb-photo" src="' + esc(h.photo) + '" alt="" /></div>' : (monogramFrom(h.name) ? '<div class="sb-photo-wrap"><div class="sb-photo sb-mono">' + esc(monogramFrom(h.name)) + '</div></div>' : '')) +
      '<div class="sb-identity">' +
        '<h1 class="sb-name">' + esc(h.name || "") + '</h1>' +
        (h.title ? '<p class="sb-title">' + esc(h.title) + '</p>' : '') +
      '</div>' +
      (contactBits.length ? (
        '<section class="sb-section"><h3>Profile</h3>' +
          contactBits.map(function (c) {
            return (
              '<div class="sb-contact">' +
                '<span class="sb-ico">' + c.icon + '</span>' +
                '<div class="sb-contact-body">' +
                  '<div class="sb-contact-label">' + esc(c.label) + '</div>' +
                  '<div class="sb-contact-value">' + esc(c.value) + '</div>' +
                '</div>' +
              '</div>'
            );
          }).join("") +
        '</section>'
      ) : "") +
      (renderSkillsBulletList(r) ? '<section class="sb-section"><h3>Skills</h3>' + renderSkillsBulletList(r) + '</section>' : "") +
      (renderLanguagesList(r) ? '<section class="sb-section"><h3>Languages</h3>' + renderLanguagesList(r) + '</section>' : "") +
      (renderInterests(r) ? '<section class="sb-section"><h3>Hobbies</h3>' + renderInterests(r) + '</section>' : "");

    const main = [
      r.summary && '<section class="main-section main-lead">' + renderSummary(r) + '</section>',
      renderExperienceDated(r) && '<section class="main-section"><h2>Professional experience</h2>' + renderExperienceDated(r) + '</section>',
      renderEducationItems(r) && '<section class="main-section"><h2>Education</h2>' + renderEducationItems(r) + '</section>',
      renderProjects(r) && '<section class="main-section"><h2>Projects</h2>' + renderProjects(r) + '</section>',
      renderCertifications(r) && '<section class="main-section"><h2>Certifications</h2>' + renderCertifications(r) + '</section>',
      renderReferences(r) && '<section class="main-section"><h2>References</h2>' + renderReferences(r) + '</section>'
    ].filter(Boolean).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #1f2937; line-height: 1.5; background: #fff; }' +
      '.rl-doc { display: table; width: 100%; table-layout: fixed; }' +
      '.sb-side, .sb-main { display: table-cell; vertical-align: top; }' +
      '.sb-side { width: 36%; }' +
      '.sb-main { width: 64%; }' +
      '.sb-side { background: ' + dark + '; color: rgba(255,255,255,0.92); padding: 26px 22px; }' +
      '.sb-main { padding: 28px 30px; background: #fff; }' +
      '.sb-photo-wrap { display: flex; justify-content: center; margin-bottom: 16px; }' +
      '.sb-photo { width: 120px; height: 120px; border-radius: 50%; object-fit: cover; display: block; border: 3px solid rgba(255,255,255,0.12); background: #E5E5E5; }' +
      '.sb-mono { display: flex; align-items: center; justify-content: center; font-size: ' + (o.fontSize + 22) + 'pt; font-weight: 200; color: ' + dark + '; background: #F7F5F0; letter-spacing: 0.02em; }' +
      '.sb-identity { text-align: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.15); }' +
      '.sb-name { font-size: ' + (o.fontSize + 8) + 'pt; margin: 0 0 4px; font-weight: 700; letter-spacing: 0.04em; color: #fff; }' +
      '.sb-title { font-size: ' + (o.fontSize - 1) + 'pt; margin: 0; color: rgba(255,255,255,0.7); letter-spacing: 0.1em; text-transform: uppercase; }' +
      '.sb-section { margin-bottom: 20px; page-break-inside: avoid; }' +
      '.sb-section h3 { font-size: ' + (o.fontSize + 1) + 'pt; color: #fff; margin: 0 0 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding-bottom: 5px; border-bottom: 1px solid rgba(255,255,255,0.2); }' +
      '.sb-contact { display: flex; gap: 10px; margin-bottom: 10px; align-items: flex-start; }' +
      '.sb-ico { color: #fff; flex: 0 0 14px; padding-top: 3px; opacity: 0.9; }' +
      '.sb-contact-label { font-size: ' + (o.fontSize - 1) + 'pt; font-weight: 700; color: #fff; }' +
      '.sb-contact-value { font-size: ' + (o.fontSize - 1) + 'pt; color: rgba(255,255,255,0.75); word-break: break-word; }' +
      '.skills-bullets { margin: 0; padding-left: 16px; color: rgba(255,255,255,0.85); }' +
      '.skills-bullets li { margin-bottom: 3px; }' +
      '.lang-list { margin: 0; padding: 0; list-style: none; color: rgba(255,255,255,0.85); }' +
      '.lang-list li { margin-bottom: 4px; padding-left: 14px; position: relative; }' +
      '.lang-list li::before { content: "•"; position: absolute; left: 0; color: rgba(255,255,255,0.4); }' +
      '.lang-name { font-weight: 600; color: #fff; }' +
      '.lang-level { color: rgba(255,255,255,0.65); }' +
      '.interest-list { margin: 0; padding-left: 16px; color: rgba(255,255,255,0.85); }' +
      '.main-section { margin-bottom: 18px; page-break-inside: avoid; }' +
      '.main-section h2 { font-size: ' + (o.fontSize + 3) + 'pt; color: ' + dark + '; margin: 0 0 10px; font-weight: 700; letter-spacing: 0.04em; padding-bottom: 4px; border-bottom: 1.5px solid ' + dark + '; }' +
      '.main-lead { color: #374151; font-style: italic; margin-bottom: 22px; border-bottom: 1px solid #e5e7eb; padding-bottom: 14px; }' +
      '.summary { margin: 0; color: #374151; }' +
      '.exp-dated { display: grid; grid-template-columns: 80px 1fr; gap: 16px; margin-bottom: 14px; page-break-inside: avoid; }' +
      '.exp-dates { color: ' + dark + '; font-weight: 700; font-size: ' + (o.fontSize - 1) + 'pt; padding-top: 2px; }' +
      '.exp-body { min-width: 0; }' +
      '.exp-role { font-weight: 700; color: ' + dark + '; font-size: ' + (o.fontSize + 1) + 'pt; }' +
      '.exp-company { color: #4b5563; font-size: ' + o.fontSize + 'pt; margin-bottom: 3px; }' +
      '.exp-location { color: #9ca3af; }' +
      '.exp-bullets { margin: 4px 0 0 18px; padding: 0; color: #374151; }' +
      '.exp-bullets li { margin-bottom: 2px; }' +
      '.edu-item, .prj-item { margin-bottom: 10px; }' +
      '.edu-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }' +
      '.edu-school, .prj-name { font-weight: 700; color: ' + dark + '; }' +
      '.edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #6b7280; }' +
      '.edu-degree { color: #4b5563; font-style: italic; }' +
      '.prj-url { color: #6b7280; font-size: ' + (o.fontSize - 1) + 'pt; }' +
      '.prj-desc { margin: 2px 0; color: #374151; }' +
      '.prj-bullets { margin: 4px 0 0 18px; padding: 0; color: #374151; }' +
      '.cert-list { margin: 0; padding-left: 18px; color: #374151; }' +
      '.cert-name { font-weight: 600; color: ' + dark + '; }' +
      '.ref-item { margin-bottom: 10px; }' +
      '.ref-name { font-weight: 700; color: ' + dark + '; }' +
      '.ref-meta { color: #6b7280; font-style: italic; }'
    );

    return (
      '<div class="rl-doc rl-sidebar">' +
        '<aside class="sb-side">' + sidebar + '</aside>' +
        '<main class="sb-main">' + main + '</main>' +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE 7 — Editorial (magazine-style, dark name bar + monogram)
  // =============================================================================
  function editorialHtml(r, opts) {
    const o = resolveOpts("editorial", opts);
    const h = r.header || {};
    const ink = o.accent;
    const mono = monogramFrom(h.name);

    const contactBits = [];
    if (h.location) contactBits.push({ icon: ICONS.location, text: h.location });
    if (h.phone) contactBits.push({ icon: ICONS.phone, text: h.phone });
    if (h.email) contactBits.push({ icon: ICONS.mail, text: h.email });
    (h.links || []).forEach(function (l) { if (l && (l.label || l.url)) contactBits.push({ icon: ICONS.link, text: l.label || l.url }); });

    const sidebar =
      (contactBits.length ? (
        '<section class="ed-side-section"><h3>Contact</h3>' +
          contactBits.map(function (c) {
            return (
              '<div class="side-kv">' +
                '<div class="side-kv-label">' + esc(c.text.split("@")[0] ? "" : "") + '</div>' +
                '<div class="side-contact"><span class="side-ico">' + c.icon + '</span><span>' + esc(c.text) + '</span></div>' +
              '</div>'
            );
          }).join("") +
        '</section>'
      ) : "") +
      (renderEducationItems(r) ? '<section class="ed-side-section"><h3>Education</h3>' + renderEducationItems(r) + '</section>' : "") +
      (renderSkillsBulletList(r) ? '<section class="ed-side-section"><h3>Skills</h3>' + renderSkillsBulletList(r) + '</section>' : "") +
      (renderLanguagesList(r) ? '<section class="ed-side-section"><h3>Languages</h3>' + renderLanguagesList(r) + '</section>' : "") +
      (renderInterests(r) ? '<section class="ed-side-section"><h3>Interests</h3>' + renderInterests(r) + '</section>' : "") +
      (renderCertifications(r) ? '<section class="ed-side-section"><h3>Certifications</h3>' + renderCertifications(r) + '</section>' : "");

    const main = [
      r.summary && '<section class="main-section"><h2>Professional profile</h2>' + renderSummary(r) + '</section>',
      renderExperienceItems(r) && '<section class="main-section"><h2>Employment history</h2>' + renderExperienceItems(r) + '</section>',
      renderProjects(r) && '<section class="main-section"><h2>Selected projects</h2>' + renderProjects(r) + '</section>',
      renderReferences(r) && '<section class="main-section"><h2>References</h2>' + renderReferences(r) + '</section>'
    ].filter(Boolean).join("");

    const css = (
      '* { box-sizing: border-box; }' +
      'body { margin: 0; padding: 0; font-family: ' + fontStack(o) + '; font-size: ' + o.fontSize + 'pt; color: #1f2937; line-height: 1.55; background: #fff; }' +
      '.rl-doc { width: 100%; }' +
      '.ed-hero { background: ' + ink + '; color: #fff; padding: 22px 32px; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 18px; }' +
      '.ed-hero-name { font-size: ' + (o.fontSize + 18) + 'pt; font-weight: 700; letter-spacing: 0.04em; margin: 0; color: #fff; text-transform: uppercase; }' +
      '.ed-hero-title { font-size: ' + (o.fontSize - 0.5) + 'pt; margin: 6px 0 0; color: rgba(255,255,255,0.75); letter-spacing: 0.28em; text-transform: uppercase; }' +
      '.ed-mono { width: 52px; height: 52px; border: 1.5px solid rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: center; font-size: ' + (o.fontSize + 8) + 'pt; font-weight: 500; letter-spacing: 0.02em; }' +
      '.ed-body { display: table; width: 100%; table-layout: fixed; }' +
      '.ed-side, .ed-main { display: table-cell; vertical-align: top; }' +
      '.ed-side { width: 32%; }' +
      '.ed-main { width: 68%; }' +
      '.ed-side { padding: 26px 22px; background: #F7F5F0; border-right: 1px solid #e5e1d8; }' +
      '.ed-main { padding: 28px 30px; }' +
      '.ed-side-section { margin-bottom: 20px; page-break-inside: avoid; }' +
      '.ed-side-section h3 { font-size: ' + (o.fontSize - 0.5) + 'pt; color: ' + ink + '; margin: 0 0 10px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; padding-bottom: 4px; border-bottom: 1px solid #d6d3cc; }' +
      '.side-contact { display: flex; gap: 8px; align-items: flex-start; font-size: ' + (o.fontSize - 0.5) + 'pt; color: #374151; margin-bottom: 5px; word-break: break-word; }' +
      '.side-ico { color: ' + ink + '; flex: 0 0 13px; padding-top: 2px; }' +
      '.edu-item { margin-bottom: 10px; }' +
      '.edu-head { display: flex; flex-direction: column; }' +
      '.edu-school { font-weight: 700; color: ' + ink + '; font-size: ' + (o.fontSize - 0.5) + 'pt; text-transform: uppercase; letter-spacing: 0.04em; }' +
      '.edu-range { font-size: ' + (o.fontSize - 1.5) + 'pt; color: #737373; margin: 1px 0; }' +
      '.edu-degree { color: #525252; font-size: ' + (o.fontSize - 1) + 'pt; font-style: italic; }' +
      '.skills-bullets { margin: 0; padding-left: 16px; color: #404040; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.lang-list { margin: 0; padding: 0; list-style: none; color: #404040; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.lang-list li { margin-bottom: 3px; }' +
      '.lang-name { font-weight: 600; color: ' + ink + '; }' +
      '.lang-level { color: #737373; }' +
      '.interest-list, .cert-list { margin: 0; padding-left: 16px; color: #404040; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.cert-name { color: ' + ink + '; font-weight: 600; }' +
      '.main-section { margin-bottom: 20px; page-break-inside: avoid; }' +
      '.main-section h2 { font-size: ' + (o.fontSize + 1) + 'pt; color: ' + ink + '; margin: 0 0 10px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; padding-bottom: 4px; border-bottom: 1px solid #d6d3cc; }' +
      '.summary { margin: 0; color: #374151; }' +
      '.exp-item, .prj-item { margin-bottom: 14px; page-break-inside: avoid; }' +
      '.exp-head, .prj-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }' +
      '.exp-role, .prj-name { font-weight: 700; color: ' + ink + '; font-size: ' + (o.fontSize + 0.5) + 'pt; }' +
      '.exp-range, .edu-range { font-size: ' + (o.fontSize - 1) + 'pt; color: #737373; font-style: italic; white-space: nowrap; }' +
      '.exp-company-row { display: flex; gap: 10px; color: #525252; margin: 2px 0 5px; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.exp-company { font-weight: 600; color: ' + ink + '; }' +
      '.exp-location { color: #737373; }' +
      '.exp-bullets, .prj-bullets { margin: 4px 0 0 18px; padding: 0; color: #374151; }' +
      '.exp-bullets li, .prj-bullets li { margin-bottom: 3px; }' +
      '.prj-url { color: #737373; font-size: ' + (o.fontSize - 1) + 'pt; }' +
      '.prj-desc { margin: 2px 0; color: #525252; font-style: italic; }' +
      '.ref-item { margin-bottom: 10px; }' +
      '.ref-name { font-weight: 700; color: ' + ink + '; }' +
      '.ref-meta { color: #525252; font-style: italic; font-size: ' + (o.fontSize - 0.5) + 'pt; }' +
      '.ref-contact, .ref-note { color: #374151; font-size: ' + (o.fontSize - 0.5) + 'pt; }'
    );

    return (
      '<div class="rl-doc rl-editorial">' +
        '<header class="ed-hero">' +
          '<div>' +
            '<h1 class="ed-hero-name">' + esc(h.name || "") + '</h1>' +
            (h.title ? '<p class="ed-hero-title">' + esc(h.title) + '</p>' : '') +
          '</div>' +
          (mono ? '<div class="ed-mono">' + esc(mono) + '</div>' : '') +
        '</header>' +
        '<div class="ed-body">' +
          '<aside class="ed-side">' + sidebar + '</aside>' +
          '<main class="ed-main">' + main + '</main>' +
        '</div>' +
      '</div>' +
      '<style>' + pageSizeCss(o) + css + '</style>'
    );
  }

  // =============================================================================
  // TEMPLATE VARIANTS — requested styles inspired by uploaded references
  // =============================================================================
  function metroDarkHtml(r, opts) {
    const base = timelineHtml(r, Object.assign({}, opts, { accent: (opts && opts.accent) || "#343A40" }));
    return injectCss(base,
      '.rl-timeline .tm-header { background:#343A40 !important; border-bottom:none !important; padding:24px 34px 18px !important; }' +
      '.rl-timeline .tm-name { color:#fff !important; letter-spacing:0 !important; font-weight:800 !important; text-transform:none !important; font-size:28pt !important; }' +
      '.rl-timeline .tm-title { color:rgba(255,255,255,0.92) !important; letter-spacing:0 !important; text-transform:none !important; font-size:13pt !important; }' +
      '.rl-timeline .tm-divider { display:none !important; }' +
      '.rl-timeline .tm-side { background:#fff !important; width:32% !important; padding:20px 18px !important; }' +
      '.rl-timeline .tm-main { background:#fff !important; width:68% !important; padding:22px 28px !important; }' +
      '.rl-timeline .tm-main::before { left:38px !important; top:28px !important; }' +
      '.rl-timeline .tm-dot { width:24px !important; height:24px !important; left:0 !important; }' +
      '.rl-timeline .tm-content h2 { letter-spacing:0 !important; text-transform:none !important; font-size:15pt !important; }' +
      '.rl-timeline .exp-role { text-transform:none !important; letter-spacing:0 !important; }'
    );
  }

  function softBlueHtml(r, opts) {
    const base = sidebarHtml(r, Object.assign({}, opts, { accent: (opts && opts.accent) || "#9FB4DB" }));
    return injectCss(base,
      '.rl-sidebar .sb-side { background:#F4F5F7 !important; color:#374151 !important; width:33% !important; }' +
      '.rl-sidebar .sb-main { width:67% !important; position:relative !important; }' +
      '.rl-sidebar .sb-main::before { content:"' + esc(monogramFrom((r.header && r.header.name) || "")) + '"; position:absolute; right:18px; top:18px; width:52px; height:52px; border-radius:50%; background:#9FB4DB; color:#fff; font-weight:700; display:flex; align-items:center; justify-content:center; font-size:14pt; }' +
      '.rl-sidebar .sb-name { color:#9FB4DB !important; text-transform:none !important; font-size:24pt !important; line-height:1.05 !important; }' +
      '.rl-sidebar .sb-title { color:#6b7280 !important; text-transform:none !important; letter-spacing:0 !important; font-size:12pt !important; }' +
      '.rl-sidebar .sb-section h3, .rl-sidebar .sb-contact-label, .rl-sidebar .lang-name { color:#9FB4DB !important; border-bottom-color:#dbe4f3 !important; letter-spacing:0 !important; text-transform:none !important; }' +
      '.rl-sidebar .sb-contact-value, .rl-sidebar .skills-bullets, .rl-sidebar .lang-list, .rl-sidebar .interest-list { color:#374151 !important; }' +
      '.rl-sidebar .sb-photo { border:none !important; width:104px !important; height:104px !important; }'
    );
  }

  function horizonBlueHtml(r, opts) {
    const base = modernHtml(r, Object.assign({}, opts, { accent: (opts && opts.accent) || "#AFCFE5" }));
    return injectCss(base,
      '.rl-modern .rl-doc { border:1px solid #d5dde5 !important; padding:10mm 11mm !important; }' +
      '.rl-modern .rl-header { border-left:none !important; border-top:16px solid #AFCFE5 !important; border-bottom:2px solid #AFCFE5 !important; padding-top:10px !important; padding-left:0 !important; }' +
      '.rl-modern .rl-contact { justify-content:center !important; gap:10px !important; font-size:9pt !important; color:#334155 !important; }' +
      '.rl-modern .contact-item + .contact-item::before { content:"|"; margin-right:10px; color:#8ba8bf; }' +
      '.rl-modern .rl-name { letter-spacing:0.08em !important; text-transform:uppercase !important; font-size:25pt !important; }' +
      '.rl-modern .rl-title { color:#6b7280 !important; letter-spacing:0 !important; text-transform:none !important; }' +
      '.rl-modern .rl-section h2 { color:#111827 !important; border-bottom:2px solid #AFCFE5 !important; letter-spacing:0 !important; font-size:12pt !important; }'
    );
  }

  function mintLineHtml(r, opts) {
    const base = classicHtml(r, Object.assign({}, opts, { accent: (opts && opts.accent) || "#2AB7A9" }));
    return injectCss(base,
      '.rl-classic .rl-doc { border:1px solid #e5e7eb; border-left:2px solid #9fe2da; padding:14mm 13mm 14mm 16mm !important; }' +
      '.rl-classic .rl-header { text-align:left !important; border-bottom:none !important; padding-bottom:2px !important; }' +
      '.rl-classic .rl-name { letter-spacing:0.03em !important; }' +
      '.rl-classic .rl-title { font-style:normal !important; color:#6b7280 !important; }' +
      '.rl-classic .rl-section h2 { color:#2AB7A9 !important; border-bottom:none !important; letter-spacing:0.12em !important; }' +
      '.rl-classic .rl-section { position:relative; }' +
      '.rl-classic .rl-section::before { content:""; position:absolute; left:-11mm; top:4mm; width:7px; height:7px; border:1.5px solid #2AB7A9; border-radius:50%; background:#fff; }'
    );
  }

  function cleanProHtml(r, opts) {
    const base = editorialHtml(r, Object.assign({}, opts, { accent: (opts && opts.accent) || "#7A7A7A" }));
    return injectCss(base,
      '.rl-editorial .ed-hero { background:#f7f7f7 !important; color:#2f2f2f !important; border-bottom:1px solid #d8d8d8; }' +
      '.rl-editorial .ed-hero-name { color:#3f3f3f !important; font-weight:600 !important; }' +
      '.rl-editorial .ed-hero-title { color:#7a7a7a !important; letter-spacing:0.12em !important; }' +
      '.rl-editorial .ed-mono { border-color:#d2d2d2 !important; color:#666 !important; }' +
      '.rl-editorial .ed-side { background:#fff !important; border-right:1px solid #ececec !important; width:34% !important; }' +
      '.rl-editorial .ed-main { width:66% !important; }' +
      '.rl-editorial .ed-side-section h3, .rl-editorial .main-section h2 { color:#6a6a6a !important; border-bottom-color:#e5e5e5 !important; letter-spacing:0.12em !important; }' +
      '.rl-editorial .main-section { margin-bottom:14px !important; }' +
      '.rl-editorial .exp-item, .rl-editorial .prj-item { margin-bottom:10px !important; }'
    );
  }

  // ---------------------------------------------------------------------------
  // Templates registry
  // ---------------------------------------------------------------------------
  const TEMPLATES = [
    {
      id: "metro-dark",
      name: "Metro Dark",
      tagline: "Dark header · structured timeline",
      description: "Bold dark top band with structured left-right flow for skills and history, inspired by modern corporate CV layouts.",
      render: metroDarkHtml,
      docxStyle: "timeline",
      layout: "sidebar"
    },
    {
      id: "soft-blue",
      name: "Soft Blue Profile",
      tagline: "Photo-first · calm blue accents",
      description: "Gentle blue visual style with profile emphasis and clear hierarchy for contact, work history and education.",
      render: softBlueHtml,
      docxStyle: "sidebar",
      layout: "sidebar",
      supportsPhoto: true
    },
    {
      id: "horizon-blue",
      name: "Horizon Blue",
      tagline: "Clean rows · sky-blue separators",
      description: "Single-column business style with blue separators and highly readable section rhythm for fast recruiter scanning.",
      render: horizonBlueHtml,
      docxStyle: "modern",
      layout: "single"
    },
    {
      id: "mint-line",
      name: "Mint Line",
      tagline: "Left guide rail · airy layout",
      description: "Elegant vertical guide with mint accents and balanced white space, ideal for concise professional resumes.",
      render: mintLineHtml,
      docxStyle: "classic",
      layout: "single"
    },
    {
      id: "clean-pro",
      name: "Clean Pro",
      tagline: "Minimal two-column editorial",
      description: "Minimal neutral design with subtle structure and premium spacing inspired by high-end executive resume sheets.",
      render: cleanProHtml,
      docxStyle: "editorial",
      layout: "sidebar",
      supportsPhoto: true
    },
    {
      id: "executive",
      name: "Executive",
      tagline: "Dark hero · monogram · serif",
      description: "Premium navy header with monogram and gold accent. Two-column body with elegant serif typography — perfect for senior and executive roles.",
      render: executiveHtml,
      docxStyle: "executive",
      layout: "sidebar"
    },
    {
      id: "timeline",
      name: "Timeline",
      tagline: "Connected milestones · 2 columns",
      description: "Vertical timeline with connected section dots. Great for showing career progression clearly — tech, product, consulting.",
      render: timelineHtml,
      docxStyle: "timeline",
      layout: "sidebar"
    },
    {
      id: "sidebar",
      name: "Sidebar Pro",
      tagline: "Dark sidebar · photo · icons",
      description: "Dark left sidebar with optional photo, icon-based contact details, and hobbies. Modern and instantly recognizable.",
      render: sidebarHtml,
      docxStyle: "sidebar",
      layout: "sidebar",
      supportsPhoto: true
    },
    {
      id: "editorial",
      name: "Editorial",
      tagline: "Magazine banner · monogram",
      description: "Dark editorial banner with monogram, warm sidebar and tracked-out section labels. Sophisticated without being stuffy.",
      render: editorialHtml,
      docxStyle: "editorial",
      layout: "sidebar"
    },
    {
      id: "modern",
      name: "Modern",
      tagline: "Accent bar · skill chips",
      description: "Bold and contemporary single-column. Ideal for tech, product, and startups. Use the accent color to match your brand.",
      render: modernHtml,
      docxStyle: "modern",
      layout: "single"
    },
    {
      id: "classic",
      name: "Classic",
      tagline: "Serif · ATS-safe · single column",
      description: "Best for corporate, finance, legal, and roles where ATS parsing is critical. A proven design recruiters have read for decades.",
      render: classicHtml,
      docxStyle: "classic",
      layout: "single"
    },
    {
      id: "minimal",
      name: "Minimal",
      tagline: "Ultra-clean · generous whitespace",
      description: "Sophisticated and understated. A great choice for senior roles, consulting, and anyone who wants their content to speak for itself.",
      render: minimalHtml,
      docxStyle: "minimal",
      layout: "single"
    }
  ];

  function get(id) {
    return TEMPLATES.find(function (t) { return t.id === id; }) || TEMPLATES[0];
  }

  function list() {
    return TEMPLATES.slice();
  }

  function renderStandaloneHtml(templateId, resume, opts) {
    const tpl = get(templateId);
    if (window.CBV2.resume && window.CBV2.resume.model && window.CBV2.resume.model.ensureShape) {
      window.CBV2.resume.model.ensureShape(resume);
    }
    const inner = tpl.render(resume, opts);
    const name = (resume.header && resume.header.name) || "Resume";
    const qualityMode = (opts && opts.quality === "high") ? "high" : "balanced";

    // Global print CSS — preserve the selected template format (including
    // two-column layouts), while allowing long sections to paginate naturally.
    const printCss =
      '@media print {' +
        // Global print fidelity
        'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; text-rendering: geometricPrecision; }' +
        '.rl-doc, .rl-doc * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }' +
        '.rl-doc { margin: 0 auto !important; box-shadow: none !important; transform: none !important; min-height: 0 !important; }' +
        // Keep chosen multi-column structures intact (never collapse to single column)
        '.rl-doc, .exec-body, .tm-body-grid, .ed-body { display: table !important; width: 100% !important; table-layout: fixed !important; border-collapse: separate !important; border-spacing: 0 !important; }' +
        '.exec-side, .exec-main, .tm-side, .tm-main, .ed-side, .ed-main, .sb-side, .sb-main { display: table-cell !important; vertical-align: top !important; }' +
        // Stable page-break behavior
        '.rl-section, .main-section, .tm-section, .side-section, .sb-section, .ed-side-section, .tm-side-section { break-inside: auto !important; page-break-inside: auto !important; }' +
        '.exp-item, .exp-dated, .edu-item, .prj-item, .ref-item, .side-contact { break-inside: auto !important; page-break-inside: auto !important; orphans: 3; widows: 3; }' +
        // Keep headings with the first body lines
        'h1, h2, h3, h4 { break-after: avoid-page !important; page-break-after: avoid !important; }' +
        // Avoid splitting tiny rows/lists/icons/images
        '.exp-bullets li, .prj-bullets li, .cert-list li, .lang-list li, .interest-list li, .skills-bullets li, .sb-photo, img, svg { break-inside: avoid !important; page-break-inside: avoid !important; }' +
        // Avoid odd artifacts from long pseudo rails on printed pages
        '.tm-main::before { display: none !important; }' +
        (qualityMode === "high"
          ? (
            '@page { margin: 8mm !important; }' +
            'p, li { orphans: 4 !important; widows: 4 !important; }' +
            // Keep high quality pagination stable: do not force large blocks to avoid pages.
            // Forcing avoid-page on full sections creates large blank gaps in long CVs.
            '.rl-section, .main-section, .tm-section, .side-section, .sb-section, .ed-side-section, .tm-side-section, .exp-item, .exp-dated, .edu-item, .prj-item, .ref-item { break-inside: auto !important; page-break-inside: auto !important; }' +
            // Only keep very small units together.
            '.exp-bullets li, .prj-bullets li, .cert-list li, .lang-list li, .interest-list li { break-inside: avoid !important; page-break-inside: avoid !important; }'
          )
          : ''
        ) +
      '}' +
      // Keep preview iframe visually aligned with print output
      'html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }';

    return (
      '<!doctype html>' +
      '<html lang="en">' +
      '<head>' +
        '<meta charset="utf-8" />' +
        '<title>' + esc(name) + ' — Resume</title>' +
        '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
        '<style>' + printCss + '</style>' +
      '</head>' +
      '<body>' + inner + '</body>' +
      '</html>'
    );
  }

  window.CBV2.resume.templates = {
    list: list,
    get: get,
    renderStandaloneHtml: renderStandaloneHtml,
    defaultsFor: defaultsFor,
    resolveOpts: resolveOpts,
    monogramFrom: monogramFrom
  };
})();
