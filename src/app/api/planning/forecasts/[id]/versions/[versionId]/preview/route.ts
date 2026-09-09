import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { previewForecastAssumptions } from "@/lib/planning/forecasts/forecast-refresh";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;

  try {
    const preview = await previewForecastAssumptions(ctx.supabase, {
      organizationId: ctx.organizationId,
      forecastId: id,
      versionId,
    });
    return NextResponse.json({ preview });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not preview forecast", 400);
  }
}
