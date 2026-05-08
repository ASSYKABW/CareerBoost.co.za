// Extract the authenticated user from a Supabase JWT on the incoming request.
// We use the service-role client only to *read* the user; we never return
// service-role tokens to the caller.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface AuthedUser {
  id: string;
  email: string | null;
}

export async function getAuthedUser(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Missing Authorization header.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnon) {
    throw new Error("Server misconfigured: SUPABASE_URL/ANON_KEY missing.");
  }

  // A common pitfall: the anon key is also a valid JWT accepted at the platform
  // level, but it has no user. Detect that case explicitly so we return a
  // clearer error than a generic "Invalid or expired session."
  if (token === supabaseAnon) {
    throw new Error("Received anon key, not a user session token. Please sign in.");
  }

  const client = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error) {
    throw new Error("Session rejected by Supabase Auth: " + error.message);
  }
  if (!data?.user) {
    throw new Error("No user attached to this token.");
  }

  return { id: data.user.id, email: data.user.email ?? null };
}

export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}
