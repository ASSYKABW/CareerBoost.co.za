(function () {
  window.CBV2 = window.CBV2 || {};

  function triggerDownload(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  window.CBV2.downloadText = function (filename, text) {
    triggerDownload(filename, text, "text/plain;charset=utf-8");
  };

  window.CBV2.downloadHtml = function (filename, innerHtml, title) {
    const doc =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>" +
      (title || filename) +
      "</title>" +
      '<style>body{font-family:Inter,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#111;line-height:1.55;}h1,h2,h3{color:#0d1422;}ul{padding-left:20px;}.meta{color:#555;font-size:12px;margin-bottom:16px;}</style>' +
      "</head><body>" +
      innerHtml +
      "</body></html>";
    triggerDownload(filename, doc, "text/html;charset=utf-8");
  };

  window.CBV2.printHtml = function (innerHtml, title) {
    const win = window.open("", "_blank", "width=880,height=1100");
    if (!win) return;
    win.document.open();
    win.document.write(
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>" +
        (title || "Document") +
        "</title>" +
        '<style>body{font-family:Inter,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#111;line-height:1.55;}h1,h2,h3{color:#0d1422;}ul{padding-left:20px;}.meta{color:#555;font-size:12px;margin-bottom:16px;}@media print{body{margin:0;}}</style>' +
        "</head><body>" +
        innerHtml +
        '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>' +
        "</body></html>"
    );
    win.document.close();
  };
})();
