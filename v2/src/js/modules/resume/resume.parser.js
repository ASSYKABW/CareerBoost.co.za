// Client-side file → plain text extractors for Resume Lab uploads.
// Loads PDF.js and mammoth.js from CDN on first use so the initial page load
// stays light. Supports .pdf, .doc/.docx, .txt, .md, .rtf.
(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.resume = window.CBV2.resume || {};

  const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs";
  const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs";
  const MAMMOTH_URL = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";

  let pdfjsPromise = null;
  let mammothPromise = null;

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[data-lib="' + url + '"]');
      if (existing) {
        if (existing.getAttribute("data-loaded") === "1") return resolve();
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.defer = true;
      s.setAttribute("data-lib", url);
      s.addEventListener("load", function () {
        s.setAttribute("data-loaded", "1");
        resolve();
      });
      s.addEventListener("error", function () {
        reject(new Error("Failed to load " + url));
      });
      document.head.appendChild(s);
    });
  }

  async function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = (async function () {
      const mod = await import(PDFJS_URL);
      if (mod.GlobalWorkerOptions) {
        mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      }
      return mod;
    })().catch(function (err) {
      pdfjsPromise = null;
      throw err;
    });
    return pdfjsPromise;
  }

  async function loadMammoth() {
    if (mammothPromise) return mammothPromise;
    mammothPromise = loadScript(MAMMOTH_URL).then(function () {
      if (!window.mammoth) throw new Error("mammoth.js did not expose a global");
      return window.mammoth;
    }).catch(function (err) {
      mammothPromise = null;
      throw err;
    });
    return mammothPromise;
  }

  function kindOf(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
    if (
      name.endsWith(".docx") ||
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) return "docx";
    if (name.endsWith(".doc") || file.type === "application/msword") return "doc";
    if (name.endsWith(".rtf") || file.type === "application/rtf" || file.type === "text/rtf") return "rtf";
    if (
      name.endsWith(".txt") || name.endsWith(".md") ||
      (file.type && file.type.indexOf("text/") === 0)
    ) return "text";
    return "unknown";
  }

  async function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error("Failed to read file")); };
      r.readAsArrayBuffer(file);
    });
  }

  async function readAsText(file) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(r.error || new Error("Failed to read file")); };
      r.readAsText(file);
    });
  }

  async function extractPdfText(file, onProgress) {
    const pdfjs = await loadPdfJs();
    const buf = await readAsArrayBuffer(file);
    const loadingTask = pdfjs.getDocument({ data: buf });
    const doc = await loadingTask.promise;
    const pages = doc.numPages;
    const chunks = [];
    for (let i = 1; i <= pages; i += 1) {
      if (onProgress) onProgress({ page: i, pages: pages });
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // PDF text items are fragments — join with spaces and newlines between items
      // whose y-position differs (best-effort ordering).
      let lastY = null;
      const line = [];
      const lines = [];
      content.items.forEach(function (item) {
        if (!item || typeof item.str !== "string") return;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          lines.push(line.join(" "));
          line.length = 0;
        }
        line.push(item.str);
        lastY = y;
      });
      if (line.length) lines.push(line.join(" "));
      chunks.push(lines.join("\n"));
    }
    return chunks.join("\n\n");
  }

  async function extractDocxText(file) {
    const mammoth = await loadMammoth();
    const buf = await readAsArrayBuffer(file);
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return (result && result.value) || "";
  }

  // Primitive RTF → text: strip control words and braces. Enough for most CVs.
  function stripRtf(rtf) {
    return rtf
      .replace(/\\par[d]?/g, "\n")
      .replace(/\\'([0-9a-f]{2})/gi, function (_, h) {
        try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ""; }
      })
      .replace(/\\[a-z]+-?\d* ?/gi, "")
      .replace(/[{}]/g, "")
      .replace(/\\\*/g, "")
      .trim();
  }

  function cleanupText(text) {
    if (!text) return "";
    return String(text)
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function extractText(file, onProgress) {
    if (!file) throw new Error("No file provided");
    const kind = kindOf(file);
    if (onProgress) onProgress({ stage: "reading", kind: kind, name: file.name });

    if (kind === "pdf") {
      const text = await extractPdfText(file, function (p) {
        if (onProgress) onProgress(Object.assign({ stage: "reading-pdf" }, p));
      });
      return { kind: kind, text: cleanupText(text) };
    }
    if (kind === "docx") {
      const text = await extractDocxText(file);
      return { kind: kind, text: cleanupText(text) };
    }
    if (kind === "doc") {
      // Legacy .doc (OLE Compound) can't be parsed reliably in the browser.
      throw new Error(
        "Legacy .doc files aren't supported. Please save as .docx or PDF and upload again."
      );
    }
    if (kind === "rtf") {
      const raw = await readAsText(file);
      return { kind: kind, text: cleanupText(stripRtf(raw)) };
    }
    if (kind === "text") {
      const raw = await readAsText(file);
      return { kind: kind, text: cleanupText(raw) };
    }
    throw new Error("Unsupported file type. Upload a PDF, .docx, or .txt file.");
  }

  window.CBV2.resume.parser = {
    extractText: extractText,
    kindOf: kindOf,
    // Exposed for Phase 4 (PDF/DOCX export) — we can share the same CDN loads.
    loadPdfJs: loadPdfJs,
    loadMammoth: loadMammoth
  };
})();
