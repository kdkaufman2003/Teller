import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { recordPlanningAuditEvent } from "@/lib/planning/budgets/audit";
import { CAPEX_OVERRIDE_PREFIX } from "./capex-adapter";
import type { CashFlowKind, CashManualOverrideInput, CashOutlookReport } from "./types";

export function assertCashSchemaAvailable(error: { message: string } | null): void {
  if (error && /does not exist|schema cache/i.test(error.message)) {
    throw new Error(
      "Cash planning tables are not available. Apply supabase/patches/033-phase14f-cash-forecast.sql manually.",
    );
  }
}

export async function listCashManualOverrides(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const { data, error } = await supabase
    .from("teller_cash_forecast_overrides")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("effective_date");
  assertCashSchemaAvailable(error);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    effectiveDate: row.effective_date as string,
    flowKind: row.flow_kind as CashFlowKind,
    amount: roundMoney(Number(row.amount)),
    label: row.label as string,
    notes: (row.notes as string) ?? "",
  }));
}

export async function createCashManualOverride(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorId?: string | null;
    override: CashManualOverrideInput;
  },
) {
  if (!input.override.label.trim()) throw new Error("Description is required");
  if (input.override.amount <= 0) throw new Error("Amount must be positive");

  const notes =
    input.override.planningCategory === "capex"
      ? `${CAPEX_OVERRIDE_PREFIX}${input.override.notes?.trim() ?? ""}`.trim()
      : input.override.notes?.trim() ?? "";

  const row = {
    organization_id: input.organizationId,
    effective_date: input.override.effectiveDate.slice(0, 10),
    flow_kind: input.override.flowKind,
    amount: roundMoney(input.override.amount),
    label: input.override.label.trim(),
    notes,
    active: true,
    created_by: input.actorId ?? null,
  };

  const { data, error } = await supabase
    .from("teller_cash_forecast_overrides")
    .insert(row)
    .select("*")
    .single();
  assertCashSchemaAvailable(error);
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "cash_manual_adjustment_created",
    entityKind: "cash_override",
    entityId: data.id as string,
    payload: { label: row.label, amount: row.amount, flowKind: row.flow_kind },
  });

  return data;
}

export async function deleteCashManualOverride(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    overrideId: string;
    actorId?: string | null;
  },
) {
  const { data: existing, error: readError } = await supabase
    .from("teller_cash_forecast_overrides")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("id", input.overrideId)
    .maybeSingle();
  assertCashSchemaAvailable(readError);
  if (readError) throw new Error(readError.message);
  if (!existing) throw new Error("Manual adjustment not found");

  const { error } = await supabase
    .from("teller_cash_forecast_overrides")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.overrideId);
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "cash_manual_adjustment_deleted",
    entityKind: "cash_override",
    entityId: input.overrideId,
    payload: {},
  });
}

export async function persistCashForecastRun(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorId?: string | null;
    report: CashOutlookReport;
    settingsSnapshot: Record<string, unknown>;
  },
): Promise<string> {
  const { data: run, error: runError } = await supabase
    .from("teller_cash_forecast_runs")
    .insert({
      organization_id: input.organizationId,
      as_of_date: input.report.asOfDate,
      horizon_weeks: input.report.horizonWeeks,
      horizon_start: input.report.horizonStart,
      horizon_end: input.report.horizonEnd,
      starting_cash: input.report.startingCash.total,
      settings_snapshot: input.settingsSnapshot,
      status: "draft",
      created_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  assertCashSchemaAvailable(runError);
  if (runError) throw new Error(runError.message);

  const runId = run.id as string;
  const detailLines = input.report.weeks.flatMap((week) =>
    week.lines.map((line) => ({
      organization_id: input.organizationId,
      cash_forecast_run_id: runId,
      period_start: week.periodStart,
      period_end: week.periodEnd,
      period_grain: "week",
      flow_kind: line.flowKind,
      category: line.category,
      amount: line.amount,
      source_kind: line.sourceKind,
      source_id: line.sourceId,
      explanation: line.explanation,
      is_override: line.category === "manual" || line.category === "capex",
      metadata: line.metadata ?? {},
    })),
  );

  if (detailLines.length) {
    const { error: linesError } = await supabase
      .from("teller_cash_forecast_lines")
      .insert(detailLines);
    if (linesError) throw new Error(linesError.message);
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "cash_forecast_run_created",
    entityKind: "cash_forecast_run",
    entityId: runId,
    payload: {
      asOfDate: input.report.asOfDate,
      startingCash: input.report.startingCash.total,
      horizonWeeks: input.report.horizonWeeks,
    },
  });

  return runId;
}

export async function getCashForecastRun(
  supabase: SupabaseClient,
  organizationId: string,
  runId: string,
) {
  const { data, error } = await supabase
    .from("teller_cash_forecast_runs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", runId)
    .maybeSingle();
  assertCashSchemaAvailable(error);
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Cash forecast run not found");
  return data;
}
