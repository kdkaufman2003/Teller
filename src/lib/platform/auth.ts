import { jsonError } from "@/lib/api";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import type { NextResponse } from "next/server";

export async function isPlatformAdmin(): Promise<boolean> {
  const session = await getSessionContext();
  if (!session?.userId) return false;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("teller_platform_admins")
    .select("user_id")
    .eq("user_id", session.userId)
    .maybeSingle();

  if (error) return false;
  return Boolean(data?.user_id);
}

export async function requirePlatformAdmin() {
  const session = await getSessionContext();
  if (!session) {
    return { error: jsonError("Unauthorized", 401) as NextResponse };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("teller_platform_admins")
    .select("user_id")
    .eq("user_id", session.userId)
    .maybeSingle();

  if (error || !data) {
    return { error: jsonError("Forbidden", 403) as NextResponse };
  }

  return { session, supabase };
}
