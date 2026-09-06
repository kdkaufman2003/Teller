import { NextResponse } from "next/server";
import { listUnassignedJobActivity } from "@/lib/accounting/unassigned-job-activity";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const rows = await listUnassignedJobActivity(ctx.supabase, ctx.organizationId);
  return NextResponse.json({ rows });
}
