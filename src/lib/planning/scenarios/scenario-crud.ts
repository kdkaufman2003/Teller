import type { SupabaseClient } from "@supabase/supabase-js";
import { recordPlanningAuditEvent } from "@/lib/planning/budgets/audit";
import { getForecastVersion } from "@/lib/planning/forecasts/forecast-crud";
import {
  defaultDriversForScenarioType,
  defaultScenarioName,
} from "./templates";
import type {
  ScenarioCashAdjustmentInput,
  ScenarioCashAdjustmentRecord,
  ScenarioDriverInput,
  ScenarioDriverRecord,
  ScenarioRecord,
  ScenarioStatus,
  ScenarioType,
} from "./types";
import {
  validateCashAdjustment,
  validateScenarioDrivers,
  validateScenarioName,
  validateScenarioType,
} from "./validation";

export function assertScenarioSchemaAvailable(error: { message: string } | null): void {
  if (error && /does not exist|schema cache/i.test(error.message)) {
    throw new Error(
      "Scenario planning tables are not available. Apply supabase/patches/034-phase14h-scenarios.sql manually.",
    );
  }
}

function mapScenario(row: Record<string, unknown>): ScenarioRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    forecastId: row.forecast_id as string,
    forecastVersionId: row.forecast_version_id as string,
    name: row.name as string,
    scenarioType: row.scenario_type as ScenarioType,
    isSystem: Boolean(row.is_system),
    status: row.status as ScenarioStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDriver(row: Record<string, unknown>): ScenarioDriverRecord {
  return {
    id: row.id as string,
    scenarioId: row.scenario_id as string,
    driverType: row.driver_type as ScenarioDriverRecord["driverType"],
    valueNumeric: row.value_numeric != null ? Number(row.value_numeric) : null,
    valueText: (row.value_text as string) ?? "",
    targetScope: (row.target_scope as string) ?? "all",
  };
}

export async function assertForecastVersionOwned(
  supabase: SupabaseClient,
  organizationId: string,
  forecastId: string,
  forecastVersionId: string,
): Promise<void> {
  const version = await getForecastVersion(supabase, organizationId, forecastVersionId);
  const forecast = version.teller_forecasts as { id: string; organization_id: string };
  if (forecast.id !== forecastId) throw new Error("Forecast version does not belong to forecast");
  if (forecast.organization_id !== organizationId) throw new Error("Forecast version not found");
}

export async function listScenarios(
  supabase: SupabaseClient,
  organizationId: string,
  forecastId?: string,
): Promise<ScenarioRecord[]> {
  let query = supabase
    .from("teller_scenarios")
    .select("*")
    .eq("organization_id", organizationId)
    .neq("status", "archived")
    .order("updated_at", { ascending: false });
  if (forecastId) query = query.eq("forecast_id", forecastId);
  const { data, error } = await query;
  assertScenarioSchemaAvailable(error);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapScenario(row));
}

export async function getScenario(
  supabase: SupabaseClient,
  organizationId: string,
  scenarioId: string,
): Promise<ScenarioRecord> {
  const { data, error } = await supabase
    .from("teller_scenarios")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", scenarioId)
    .maybeSingle();
  assertScenarioSchemaAvailable(error);
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Scenario not found");
  return mapScenario(data);
}

export async function listScenarioDrivers(
  supabase: SupabaseClient,
  organizationId: string,
  scenarioId: string,
): Promise<ScenarioDriverRecord[]> {
  const { data, error } = await supabase
    .from("teller_scenario_drivers")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("scenario_id", scenarioId);
  assertScenarioSchemaAvailable(error);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapDriver(row));
}

export async function listScenarioCashAdjustments(
  supabase: SupabaseClient,
  organizationId: string,
  scenarioId: string,
): Promise<ScenarioCashAdjustmentRecord[]> {
  const { data, error } = await supabase
    .from("teller_scenario_cash_adjustments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("scenario_id", scenarioId)
    .eq("active", true);
  assertScenarioSchemaAvailable(error);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    scenarioId: row.scenario_id as string,
    effectiveDate: row.effective_date as string,
    flowKind: row.flow_kind as "inflow" | "outflow",
    amount: Number(row.amount),
    label: row.label as string,
    notes: (row.notes as string) ?? "",
  }));
}

export async function createScenario(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorId?: string | null;
    forecastId: string;
    forecastVersionId: string;
    scenarioType: ScenarioType;
    name?: string;
    drivers?: ScenarioDriverInput[];
    cashAdjustments?: ScenarioCashAdjustmentInput[];
  },
): Promise<ScenarioRecord> {
  validateScenarioType(input.scenarioType);
  const name = input.name?.trim() || defaultScenarioName(input.scenarioType);
  validateScenarioName(name);
  await assertForecastVersionOwned(
    supabase,
    input.organizationId,
    input.forecastId,
    input.forecastVersionId,
  );

  const drivers =
    input.scenarioType === "base"
      ? []
      : input.drivers?.length
        ? input.drivers
        : defaultDriversForScenarioType(input.scenarioType);
  validateScenarioDrivers(drivers);
  for (const adjustment of input.cashAdjustments ?? []) {
    validateCashAdjustment(adjustment);
  }

  const { data, error } = await supabase
    .from("teller_scenarios")
    .insert({
      organization_id: input.organizationId,
      forecast_id: input.forecastId,
      forecast_version_id: input.forecastVersionId,
      name,
      scenario_type: input.scenarioType,
      is_system: input.scenarioType !== "custom",
      status: "active",
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  assertScenarioSchemaAvailable(error);
  if (error) throw new Error(error.message);

  const scenario = mapScenario(data!);
  if (drivers.length) {
    await replaceScenarioDrivers(supabase, {
      organizationId: input.organizationId,
      scenarioId: scenario.id,
      drivers,
    });
  }
  if (input.cashAdjustments?.length) {
    await replaceScenarioCashAdjustments(supabase, {
      organizationId: input.organizationId,
      scenarioId: scenario.id,
      adjustments: input.cashAdjustments,
    });
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "scenario_created",
    entityKind: "scenario",
    entityId: scenario.id,
    payload: { scenarioType: input.scenarioType, forecastVersionId: input.forecastVersionId },
  });

  return scenario;
}

export async function updateScenario(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scenarioId: string;
    actorId?: string | null;
    name?: string;
    status?: ScenarioStatus;
    drivers?: ScenarioDriverInput[];
    cashAdjustments?: ScenarioCashAdjustmentInput[];
  },
): Promise<ScenarioRecord> {
  const existing = await getScenario(supabase, input.organizationId, input.scenarioId);
  if (existing.scenarioType === "base" && input.drivers?.length) {
    validateScenarioDrivers(input.drivers);
  } else if (input.drivers?.length) {
    validateScenarioDrivers(input.drivers);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name != null) {
    validateScenarioName(input.name);
    patch.name = input.name.trim();
  }
  if (input.status) patch.status = input.status;

  const { data, error } = await supabase
    .from("teller_scenarios")
    .update(patch)
    .eq("organization_id", input.organizationId)
    .eq("id", input.scenarioId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  if (input.drivers) {
    await replaceScenarioDrivers(supabase, {
      organizationId: input.organizationId,
      scenarioId: input.scenarioId,
      drivers: input.drivers,
    });
  }
  if (input.cashAdjustments) {
    for (const adjustment of input.cashAdjustments) validateCashAdjustment(adjustment);
    await replaceScenarioCashAdjustments(supabase, {
      organizationId: input.organizationId,
      scenarioId: input.scenarioId,
      adjustments: input.cashAdjustments,
    });
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "scenario_updated",
    entityKind: "scenario",
    entityId: input.scenarioId,
    payload: {},
  });

  return mapScenario(data!);
}

export async function archiveScenario(
  supabase: SupabaseClient,
  input: { organizationId: string; scenarioId: string; actorId?: string | null },
): Promise<void> {
  await getScenario(supabase, input.organizationId, input.scenarioId);
  const { error } = await supabase
    .from("teller_scenarios")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.scenarioId);
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "scenario_archived",
    entityKind: "scenario",
    entityId: input.scenarioId,
    payload: {},
  });
}

async function replaceScenarioDrivers(
  supabase: SupabaseClient,
  input: { organizationId: string; scenarioId: string; drivers: ScenarioDriverInput[] },
): Promise<void> {
  await supabase
    .from("teller_scenario_drivers")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("scenario_id", input.scenarioId);

  if (!input.drivers.length) return;

  const { error } = await supabase.from("teller_scenario_drivers").insert(
    input.drivers.map((driver) => ({
      organization_id: input.organizationId,
      scenario_id: input.scenarioId,
      driver_type: driver.driverType,
      value_numeric: driver.valueNumeric ?? null,
      value_text: driver.valueText ?? "",
      target_scope: driver.targetScope ?? "all",
    })),
  );
  if (error) throw new Error(error.message);
}

async function replaceScenarioCashAdjustments(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scenarioId: string;
    adjustments: ScenarioCashAdjustmentInput[];
  },
): Promise<void> {
  await supabase
    .from("teller_scenario_cash_adjustments")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("scenario_id", input.scenarioId);

  if (!input.adjustments.length) return;

  const { error } = await supabase.from("teller_scenario_cash_adjustments").insert(
    input.adjustments.map((row) => ({
      organization_id: input.organizationId,
      scenario_id: input.scenarioId,
      effective_date: row.effectiveDate.slice(0, 10),
      flow_kind: row.flowKind,
      amount: row.amount,
      label: row.label.trim(),
      notes: row.notes?.trim() ?? "",
      active: true,
    })),
  );
  if (error) throw new Error(error.message);
}
