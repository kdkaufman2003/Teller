import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

export async function GET() {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx && ctx.error) return ctx.error;
  if (!hasServiceRole()) {
    return NextResponse.json({ error: "Service role not configured" }, { status: 503 });
  }

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("teller_organizations")
    .select("id, name, industry_id, setup_completed_at, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ organizations: data ?? [] });
}
