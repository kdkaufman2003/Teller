import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { createScenario, listScenarios } from "@/lib/planning/scenarios/scenario-crud";
import type { ScenarioDriverInput, ScenarioType } from "@/lib/planning/scenarios/types";
import { validateScenarioType } from "@/lib/planning/scenarios/validation";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const forecastId = url.searchParams.get("forecastId") ?? undefined;

  try {
    const scenarios = await listScenarios(ctx.supabase, ctx.organizationId, forecastId);
    return NextResponse.json({ scenarios, schemaReady: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load scenarios";
    if (/does not exist|schema cache|034-phase14h/i.test(message)) {
      return NextResponse.json({ scenarios: [], schemaReady: false, error: message });
    }
    return jsonError(message, 500);
  }
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    forecastId?: string;
    forecastVersionId?: string;
    scenarioType?: string;
    name?: string;
    drivers?: Array<{
      driverType: string;
      valueNumeric?: number | null;
      valueText?: string;
      targetScope?: string;
    }>;
    cashAdjustments?: Array<{
      effectiveDate: string;
      flowKind: "inflow" | "outflow";
      amount: number;
      label: string;
      notes?: string;
    }>;
  };

  if (!body.forecastId?.trim()) return jsonError("forecastId is required", 400);
  if (!body.forecastVersionId?.trim()) return jsonError("forecastVersionId is required", 400);

  let scenarioType: ScenarioType;
  try {
    scenarioType = validateScenarioType(body.scenarioType ?? "custom");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid scenario type", 400);
  }

  try {
    const scenario = await createScenario(ctx.supabase, {
      organizationId: ctx.organizationId,
      actorId: ctx.session.userId,
      forecastId: body.forecastId.trim(),
      forecastVersionId: body.forecastVersionId.trim(),
      scenarioType,
      name: body.name,
      drivers: body.drivers as ScenarioDriverInput[] | undefined,
      cashAdjustments: body.cashAdjustments,
    });
    return NextResponse.json({ scenario });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create scenario", 400);
  }
}
