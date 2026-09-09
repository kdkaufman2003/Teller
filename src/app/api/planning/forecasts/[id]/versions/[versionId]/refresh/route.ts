import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import { refreshForecastFromAssumptions } from "@/lib/planning/forecasts/forecast-refresh";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;

  try {
    const result = await refreshForecastFromAssumptions(ctx.supabase, {
      organizationId: ctx.organizationId,
      forecastId: id,
      versionId,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not refresh forecast", 400);
  }
}
