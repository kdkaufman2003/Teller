import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  clearForecastOverride,
  saveManualForecastOverride,
} from "@/lib/planning/forecasts/forecast-refresh";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as {
    action?: "save" | "clear";
    accountId?: string;
    periodMonth?: string;
    amount?: number;
  };

  if (!body.accountId || !body.periodMonth) {
    return jsonError("accountId and periodMonth are required", 400);
  }

  try {
    if (body.action === "clear") {
      await clearForecastOverride(ctx.supabase, {
        organizationId: ctx.organizationId,
        forecastId: id,
        versionId,
        accountId: body.accountId,
        periodMonth: body.periodMonth,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ ok: true, cleared: true });
    }

    if (body.amount == null) {
      return jsonError("amount is required to save override", 400);
    }

    const result = await saveManualForecastOverride(ctx.supabase, {
      organizationId: ctx.organizationId,
      forecastId: id,
      versionId,
      accountId: body.accountId,
      periodMonth: body.periodMonth,
      amount: Number(body.amount),
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not update override", 400);
  }
}
