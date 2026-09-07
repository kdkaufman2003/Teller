import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { buildScheduleHubSummary } from "@/lib/accounting/schedules/schedule-summary";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);

  try {
    const summary = await buildScheduleHubSummary(ctx.supabase, ctx.organizationId, asOf);
    return NextResponse.json({ summary, asOf });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load summary", 400);
  }
}
