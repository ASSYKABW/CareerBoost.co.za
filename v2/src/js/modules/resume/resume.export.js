(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  const templates = function () { return (window.CBV2.resume && window.CBV2.resume.templates) || null; };
  const docxMod = function () { return (window.CBV2.resume && window.CBV2.resume.docx) || null; };

  function sanitizeFilename(s) {
    return String(s || "resume")
      .replace(/[\\/:"*?<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "resume";
  }

  function baseFilename(resume, templateId) {
    const name = resume && resume.header && resume.header.name ? resume.header.name : "resume";
    const role = resume && resume.header && resume.header.title ? " " + resume.header.title : "";
    return sanitizeFilename(name + role + " — " + templateId);
  }

  // ---------------------------------------------------------------------------
  // PDF export via native print — opens a new window, prints, user saves as PDF.
  // ---------------------------------------------------------------------------
  function downloadPdf(resume, templateId, opts) {
    const t = templates();
    if (!t) throw new Error("Templates module not loaded.");
    const html = t.renderStandaloneHtml(templateId, resume, opts);
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) {
      throw new Error("Your browser blocked the print window. Please allow pop-ups and try again.");
    }
    // Inject a tiny print helper that triggers the dialog once ready.
    const helper = (
      '<script>(function(){' +
        'function go(){try{window.focus();window.print();}catch(e){}}' +
        'if(document.readyState==="complete")setTimeout(go,150);' +
        'else window.addEventListener("load",function(){setTimeout(go,150);});' +
      '})();<\/script>'
    );
    const finalHtml = html.replace("</body>", helper + "</body>");
    win.document.open();
    win.document.write(finalHtml);
    win.document.close();
  }

  // ---------------------------------------------------------------------------
  // DOCX export — lazy-loads docx, builds a Blob, triggers download.
  // ---------------------------------------------------------------------------
  async function downloadDocx(resume, templateId, opts) {
    const t = templates();
    const d = docxMod();
    if (!t || !d) throw new Error("Export modules not loaded.");
    const style = (t.get(templateId) || {}).docxStyle || "classic";
    const blob = await d.toBlob(resume, opts, style);
    const filename = baseFilename(resume, templateId) + ".docx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 400);
  }

  // Produce a full document HTML string we can feed into an iframe for preview.
  function previewHtml(resume, templateId, opts) {
    const t = templates();
    if (!t) return "";
    return t.renderStandaloneHtml(templateId, resume, opts);
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Plain-text export (.txt). ATS systems parse plain text most
  // reliably, so this is a meaningful gap-fill in the "ATS-friendly" claim.
  // Uses the existing model.toPlainText() — same content the AI prompts see.
  // ---------------------------------------------------------------------------
  function downloadTxt(resume, templateId) {
    const model = (window.CBV2.resume && window.CBV2.resume.model) || null;
    if (!model || typeof model.toPlainText !== "function") {
      throw new Error("Resume model not loaded.");
    }
    const text = model.toPlainText(resume);
    if (!text || !text.trim()) {
      throw new Error("Nothing to export — your resume is empty.");
    }
    // Prepend a UTF-8 BOM so Windows Notepad et al. render accents correctly.
    const blob = new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" });
    const filename = baseFilename(resume, templateId || "ats-text") + ".txt";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 400);
  }

  window.CBV2.resume.export = {
    downloadPdf: downloadPdf,
    downloadDocx: downloadDocx,
    downloadTxt: downloadTxt,
    previewHtml: previewHtml,
    baseFilename: baseFilename
  };
})();
