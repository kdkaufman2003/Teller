import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { createForecastWithSeed, listForecasts } from "@/lib/planning/forecasts/forecast-crud";
import type { ForecastBaselineKind } from "@/lib/planning/forecasts/types";
import { defaultAnchorMonth } from "@/lib/planning/forecasts/periods";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  try {
    const forecasts = await listForecasts(ctx.supabase, ctx.organizationId);
    return NextResponse.json({ forecasts, schemaReady: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load forecasts";
    if (/does not exist|schema cache/i.test(message)) {
      return NextResponse.json({ forecasts: [], schemaReady: false });
    }
    return jsonError(message, 500);
  }
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    name?: string;
    anchorMonth?: string;
    horizonMonths?: number;
    baselineKind?: ForecastBaselineKind;
    sourceBudgetVersionId?: string;
    sourceForecastVersionId?: string;
  };

  if (!body.name?.trim()) {
    return jsonError("name is required", 400);
  }

  try {
    const result = await createForecastWithSeed(ctx.supabase, {
      organizationId: ctx.organizationId,
      name: body.name.trim(),
      anchorMonth: body.anchorMonth ?? defaultAnchorMonth(),
      horizonMonths: body.horizonMonths ?? 12,
      baselineKind: body.baselineKind ?? "blank",
      sourceBudgetVersionId: body.sourceBudgetVersionId ?? null,
      sourceForecastVersionId: body.sourceForecastVersionId ?? null,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create forecast", 400);
  }
}
