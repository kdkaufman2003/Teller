import { NextResponse } from "next/server";
import { listUnassignedFixedAssetActivity } from "@/lib/accounting/unassigned-fixed-asset-activity";
import { requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const rows = await listUnassignedFixedAssetActivity(ctx.supabase, ctx.organizationId);
  return NextResponse.json({ rows });
}
