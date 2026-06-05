// Shared Resend send helper.
//
// A thin, reusable wrapper around the Resend HTTP API so multiple functions
// (the lifecycle drip sender, future automated sends) share one code path.
// The existing admin-send-email keeps its own inline copy for now — this
// helper is additive and does not change that production path.

const RESEND_API = "https://api.resend.com/emails";

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  replyTo?: string;
}

export interface SendResult {
  ok: boolean;
  id: string | null;
  error: string | null;
  status: number;
}

export function resendConfigured(): boolean {
  return !!(Deno.env.get("RESEND_API_KEY") && Deno.env.get("RESEND_FROM_EMAIL"));
}

export function fromHeader(): string {
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "";
  const fromName = Deno.env.get("RESEND_FROM_NAME") || "CareerBoost";
  return fromName + " <" + fromEmail + ">";
}

// Rough HTML→text so the text/* part is non-empty (deliverability). Operator/
// template strings, not crawled pages — a light strip is enough.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Sanitize a Resend tag value (must match /^[A-Za-z0-9_-]+$/).
export function tagValue(v: string): string {
  return String(v).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  if (!key || !fromEmail) {
    return { ok: false, id: null, error: "Resend not configured (RESEND_API_KEY/RESEND_FROM_EMAIL).", status: 503 };
  }
  const payload: Record<string, unknown> = {
    from: fromHeader(),
    to: [args.to],
    subject: args.subject,
    html: args.html,
    text: args.text || htmlToText(args.html),
  };
  if (args.headers) payload.headers = args.headers;
  if (args.tags) payload.tags = args.tags;
  if (args.replyTo) payload.reply_to = args.replyTo;

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    let j: { id?: string; message?: string; name?: string } = {};
    try { j = JSON.parse(txt); } catch { /* non-JSON */ }
    if (!res.ok || !j.id) {
      return { ok: false, id: null, error: "Resend HTTP " + res.status + ": " + (j.message || j.name || txt.slice(0, 200)), status: res.status };
    }
    return { ok: true, id: j.id, error: null, status: res.status };
  } catch (err) {
    return { ok: false, id: null, error: "Network error: " + ((err as Error).message || "unknown"), status: 0 };
  }
}
