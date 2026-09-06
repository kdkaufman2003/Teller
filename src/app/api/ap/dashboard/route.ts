import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { buildApDashboardSummary } from "@/lib/accounting/ap-dashboard";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  try {
    const summary = await buildApDashboardSummary(ctx.supabase, ctx.organizationId);
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load AP dashboard";
    return jsonError(message, 500);
  }
}
