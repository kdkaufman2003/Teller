import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { loadPlanningDashboard } from "@/lib/planning/dashboard/load-planning-dashboard";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const asOfDate = url.searchParams.get("asOfDate") ?? undefined;
  const fiscalYearRaw = url.searchParams.get("fiscalYear");
  const fiscalYear = fiscalYearRaw ? Number(fiscalYearRaw) : undefined;

  if (fiscalYearRaw && !Number.isFinite(fiscalYear)) {
    return jsonError("Invalid fiscalYear", 400);
  }

  try {
    const dashboard = await loadPlanningDashboard(ctx.supabase, ctx.organizationId, {
      asOfDate,
      fiscalYear,
    });
    return NextResponse.json({ dashboard });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load planning dashboard", 500);
  }
}
