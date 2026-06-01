// POST /functions/v1/resume-pdf
// Body: { html: string, fileName?: string, pageSize?: "a4" | "letter" }
// Auth: Supabase JWT (Authorization: Bearer <access_token>)
//
// Renders a PDF server-side via PDFShift (or compatible provider) so output is
// consistent across devices and browsers.
import { corsHeaders, errorResponse, handleOptions, withCors } from "../_shared/cors.ts";
import { getAuthedUser } from "../_shared/auth.ts";

interface PdfBody {
  html?: string;
  fileName?: string;
  pageSize?: "a4" | "letter";
}

function pdfFilename(raw?: string) {
  const cleaned = String(raw || "resume")
    // Header values must be ByteString-safe (ASCII). Normalize then strip.
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return (cleaned || "resume") + ".pdf";
}

function normalizePageSize(v?: string) {
  return v === "letter" ? "Letter" : "A4";
}

async function renderWithPdfShift(
  html: string,
  pageSize: "A4" | "Letter",
): Promise<ArrayBuffer> {
  const key = Deno.env.get("PDFSHIFT_API_KEY") || "";
  if (!key) {
    throw new Error("PDF export not configured: missing PDFSHIFT_API_KEY secret.");
  }

  // https://api.pdfshift.io/v3/convert/pdf
  // PDFShift v3 uses X-API-Key auth (Basic Auth is legacy and often rejected).
  // We still try fallback variants for compatibility with older keys/accounts.
  const payload = {
    source: html,
    sandbox: false,
    use_print: true,
    format: pageSize,
    // Keep margins explicit to avoid provider defaults that can vary.
    margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
  };

  const attempts: Array<Record<string, string>> = [
    { "X-API-Key": key, "Content-Type": "application/json" },
    { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json" },
  ];

  let lastError = "";
  for (const headers of attempts) {
    const resp = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      return await resp.arrayBuffer();
    }

    const txt = await resp.text().catch(() => "");
    lastError = "PDF provider error (" + resp.status + "): " + (txt || "failed to render PDF");
    // Retry with next auth variant only for auth-related responses.
    if (resp.status !== 401 && resp.status !== 403) {
      break;
    }
  }

  throw new Error(lastError || "PDF provider error: failed to render PDF");
}

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    // Enforce authenticated user to prevent anonymous abuse.
    await getAuthedUser(req);
  } catch (err) {
    return errorResponse(String((err as Error).message || "Unauthorized"), 401);
  }

  let body: PdfBody;
  try {
    body = (await req.json()) as PdfBody;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const html = (body.html || "").trim();
  if (!html) return errorResponse("Missing html", 400);
  if (html.length > 2_000_000) return errorResponse("HTML payload too large", 413);

  const pageSize = normalizePageSize(body.pageSize);
  const filename = pdfFilename(body.fileName);

  try {
    const bytes = await renderWithPdfShift(html, pageSize);
    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse((err as Error).message || "PDF render failed", 502);
  }
}));

