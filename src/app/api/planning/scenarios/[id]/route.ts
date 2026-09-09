import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  archiveScenario,
  getScenario,
  listScenarioCashAdjustments,
  listScenarioDrivers,
  updateScenario,
} from "@/lib/planning/scenarios/scenario-crud";
import type { ScenarioDriverInput, ScenarioStatus } from "@/lib/planning/scenarios/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;

  try {
    const [scenario, drivers, cashAdjustments] = await Promise.all([
      getScenario(ctx.supabase, ctx.organizationId, id),
      listScenarioDrivers(ctx.supabase, ctx.organizationId, id),
      listScenarioCashAdjustments(ctx.supabase, ctx.organizationId, id),
    ]);
    return NextResponse.json({ scenario, drivers, cashAdjustments });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Scenario not found", 404);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;
  const body = (await request.json()) as {
    name?: string;
    status?: ScenarioStatus;
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

  try {
    const scenario = await updateScenario(ctx.supabase, {
      organizationId: ctx.organizationId,
      scenarioId: id,
      actorId: ctx.session.userId,
      name: body.name,
      status: body.status,
      drivers: body.drivers as ScenarioDriverInput[] | undefined,
      cashAdjustments: body.cashAdjustments,
    });
    return NextResponse.json({ scenario });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not update scenario", 400);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;

  try {
    await archiveScenario(ctx.supabase, {
      organizationId: ctx.organizationId,
      scenarioId: id,
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not archive scenario", 400);
  }
}
