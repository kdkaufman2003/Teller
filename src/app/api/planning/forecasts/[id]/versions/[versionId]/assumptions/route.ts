import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  deleteForecastAssumption,
  upsertForecastAssumption,
} from "@/lib/planning/forecasts/forecast-crud";
import type { ForecastAssumptionInput } from "@/lib/planning/forecasts/types";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as ForecastAssumptionInput & { assumptionId?: string };

  if (!body.name?.trim()) {
    return jsonError("name is required", 400);
  }

  try {
    const assumption = await upsertForecastAssumption(ctx.supabase, {
      organizationId: ctx.organizationId,
      forecastId: id,
      versionId,
      assumption: body,
      assumptionId: body.assumptionId,
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ assumption });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not save assumption", 400);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { versionId } = await context.params;
  const assumptionId = new URL(request.url).searchParams.get("assumptionId");
  if (!assumptionId) {
    return jsonError("assumptionId is required", 400);
  }

  try {
    await deleteForecastAssumption(ctx.supabase, {
      organizationId: ctx.organizationId,
      versionId,
      assumptionId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not delete assumption", 400);
  }
}

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  return jsonError("Use forecast version endpoint for assumptions list", 405);
}
