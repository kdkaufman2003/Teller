import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { previewScenario } from "@/lib/planning/scenarios/load-scenario-report";
import { assertForecastVersionOwned } from "@/lib/planning/scenarios/scenario-crud";
import type { ScenarioDriverInput, ScenarioType } from "@/lib/planning/scenarios/types";
import { validateScenarioDrivers, validateScenarioType } from "@/lib/planning/scenarios/validation";

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    forecastId?: string;
    forecastVersionId?: string;
    scenarioType?: string;
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
    asOfDate?: string;
  };

  if (!body.forecastId?.trim()) return jsonError("forecastId is required", 400);
  if (!body.forecastVersionId?.trim()) return jsonError("forecastVersionId is required", 400);

  let scenarioType: ScenarioType;
  try {
    scenarioType = validateScenarioType(body.scenarioType ?? "custom");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid scenario type", 400);
  }

  const drivers: ScenarioDriverInput[] =
    scenarioType === "base" ? [] : ((body.drivers ?? []) as ScenarioDriverInput[]);
  try {
    validateScenarioDrivers(drivers);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid drivers", 400);
  }

  try {
    await assertForecastVersionOwned(
      ctx.supabase,
      ctx.organizationId,
      body.forecastId.trim(),
      body.forecastVersionId.trim(),
    );

    const { data: accounts, error: accountsError } = await ctx.supabase
      .from("teller_accounts")
      .select("id, code, name, type, subtype, archived")
      .eq("organization_id", ctx.organizationId);
    if (accountsError) return jsonError(accountsError.message, 400);

    const result = await previewScenario(ctx.supabase, ctx.organizationId, {
      forecastId: body.forecastId.trim(),
      forecastVersionId: body.forecastVersionId.trim(),
      scenarioType,
      drivers,
      cashAdjustments: body.cashAdjustments,
      asOfDate: body.asOfDate,
      accounts: (accounts ?? []) as Array<{
        id: string;
        code: string;
        name: string;
        type: string;
        subtype: string;
        archived?: boolean;
      }>,
    });

    return NextResponse.json({
      forecastSummary: result.forecast.scenario.summary,
      cashSummary: result.cash.scenario.summary,
      warnings: result.cash.scenario.warnings,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not preview scenario", 400);
  }
}
