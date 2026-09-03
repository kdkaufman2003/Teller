import { NextResponse } from "next/server";
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
