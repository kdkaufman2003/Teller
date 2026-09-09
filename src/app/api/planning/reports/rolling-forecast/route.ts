import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { loadRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const forecastId = url.searchParams.get("forecastId");
  const versionId = url.searchParams.get("versionId");
  const budgetVersionId = url.searchParams.get("budgetVersionId");

  if (!forecastId) {
    return jsonError("forecastId is required", 400);
  }

  try {
    const report = await loadRollingForecastReport(ctx.supabase, ctx.organizationId, {
      forecastId,
      versionId,
      budgetVersionId,
    });
    return NextResponse.json({ report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load forecast report";
    if (/does not exist|schema cache/i.test(message)) {
      return jsonError("Apply Phase 14D patch to enable forecast reporting", 503);
    }
    return jsonError(message, 400);
  }
}
