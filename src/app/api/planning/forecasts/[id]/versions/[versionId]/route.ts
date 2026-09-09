import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  bulkUpsertForecastLines,
  getForecastVersion,
  listForecastAssumptions,
  listForecastLines,
} from "@/lib/planning/forecasts/forecast-crud";
import type { ForecastLineInput } from "@/lib/planning/forecasts/types";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;

  try {
    const version = await getForecastVersion(ctx.supabase, ctx.organizationId, versionId);
    const forecast = version.teller_forecasts as { id: string };
    if (forecast.id !== id) {
      return jsonError("Version does not belong to this forecast", 404);
    }

    const [lines, assumptions] = await Promise.all([
      listForecastLines(ctx.supabase, ctx.organizationId, versionId),
      listForecastAssumptions(ctx.supabase, ctx.organizationId, versionId),
    ]);

    return NextResponse.json({ version, lines, assumptions });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load forecast version", 404);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as { lines?: ForecastLineInput[] };

  if (!body.lines?.length) {
    return jsonError("lines are required", 400);
  }

  try {
    const result = await bulkUpsertForecastLines(ctx.supabase, {
      organizationId: ctx.organizationId,
      forecastId: id,
      versionId,
      lines: body.lines,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not save forecast", 400);
  }
}
