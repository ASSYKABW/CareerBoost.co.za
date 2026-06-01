// POST /functions/v1/testimonial-submit
//
// Public endpoint — no auth required. Accepts a JSON testimonial submission
// from the /testimonial.html form, validates it, and inserts a pending row.
//
// The submitter never sees the DB row; they just get a thank-you message.
// An operator approves/edits/rejects via admin-testimonials.

import { handleOptions, jsonResponse, errorResponse, withCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

const MAX_QUOTE = 800;
const MIN_QUOTE = 20;

Deno.serve(withCors(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const name    = String(body.name    ?? "").trim();
  const role    = String(body.role    ?? "").trim();
  const company = String(body.company ?? "").trim();
  const quote   = String(body.quote   ?? "").trim();
  const email   = String(body.email   ?? "").trim() || null;
  const rawRating = Number(body.rating);
  const rating  = Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5
    ? rawRating
    : null;

  if (!name)  return errorResponse("Your name is required.", 400);
  if (!quote) return errorResponse("A testimonial quote is required.", 400);
  if (quote.length < MIN_QUOTE) {
    return errorResponse(`Quote is too short — please share at least ${MIN_QUOTE} characters.`, 400);
  }
  if (quote.length > MAX_QUOTE) {
    return errorResponse(`Quote is too long (max ${MAX_QUOTE} characters).`, 400);
  }

  // Basic email format check if provided.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse("Please enter a valid email address, or leave it blank.", 400);
  }

  const svc = getServiceClient();
  const { error } = await svc.from("testimonials").insert({
    name,
    role,
    company,
    quote,
    email,
    rating,
    status: "pending",
    sort_order: 0,
  });

  if (error) {
    console.error("[testimonial-submit] insert error:", error.message);
    return errorResponse("Failed to save testimonial. Please try again.", 500);
  }

  return jsonResponse({
    ok: true,
    message: "Thank you! Your testimonial has been received and will be reviewed shortly.",
  });
}));
