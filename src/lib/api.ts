import { NextResponse } from "next/server";
import { canWriteBooks } from "@/lib/auth/roles";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireBooks() {
  const session = await getSessionContext();
  if (!session) return { error: jsonError("Unauthorized", 401) as NextResponse };
  if (!session.organization) {
    return { error: jsonError("Complete setup first", 409) as NextResponse };
  }
  const supabase = await createClient();
  return { session, supabase, organizationId: session.organization.id };
}

/** Requires owner or admin (period close, CPA settings). */
export async function requireAdminBooks() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx;
  const role = ctx.session.profile?.role;
  if (role !== "owner" && role !== "admin") {
    return { error: jsonError("Only owners and admins can perform this action", 403) as NextResponse };
  }
  return ctx;
}

/** Requires an authenticated org member who can change books (not viewer). */
export async function requireWriteBooks() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx;
  if (!canWriteBooks(ctx.session.profile?.role)) {
    return { error: jsonError("You do not have permission to change books", 403) as NextResponse };
  }
  return ctx;
}
