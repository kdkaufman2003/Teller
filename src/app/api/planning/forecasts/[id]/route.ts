import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { getForecastDetail } from "@/lib/planning/forecasts/forecast-crud";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;

  try {
    const detail = await getForecastDetail(ctx.supabase, ctx.organizationId, id);
    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Forecast not found";
    if (/does not exist|schema cache/i.test(message)) {
      return jsonError("Apply Phase 14D patch to enable forecasts", 503);
    }
    return jsonError(message, 404);
  }
}
