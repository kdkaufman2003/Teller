export type PlanningSettings = {
  defaultArCollectionDays: number;
  defaultApPaymentDays: number;
  forecastHorizonMonths: number;
  cashPlanningGrain: "weekly" | "monthly";
  payrollCadence: "weekly" | "biweekly" | "semimonthly" | "monthly";
  runwayThreshold: number;
};

export const DEFAULT_PLANNING_SETTINGS: PlanningSettings = {
  defaultArCollectionDays: 30,
  defaultApPaymentDays: 15,
  forecastHorizonMonths: 12,
  cashPlanningGrain: "weekly",
  payrollCadence: "biweekly",
  runwayThreshold: 0,
};

export function parsePlanningSettings(row: Record<string, unknown> | null): PlanningSettings {
  if (!row) return { ...DEFAULT_PLANNING_SETTINGS };
  return {
    defaultArCollectionDays: clampInt(row.default_ar_collection_days, 0, 365, 30),
    defaultApPaymentDays: clampInt(row.default_ap_payment_days, 0, 365, 15),
    forecastHorizonMonths: clampInt(row.forecast_horizon_months, 1, 36, 12),
    cashPlanningGrain: row.cash_planning_grain === "monthly" ? "monthly" : "weekly",
    payrollCadence: parsePayrollCadence(row.payroll_cadence),
    runwayThreshold: Math.max(0, Number(row.runway_threshold ?? 0)),
  };
}

export function planningSettingsToRow(
  organizationId: string,
  settings: Partial<PlanningSettings>,
  actorId?: string | null,
): Record<string, unknown> {
  const merged = { ...DEFAULT_PLANNING_SETTINGS, ...settings };
  return {
    organization_id: organizationId,
    default_ar_collection_days: merged.defaultArCollectionDays,
    default_ap_payment_days: merged.defaultApPaymentDays,
    forecast_horizon_months: merged.forecastHorizonMonths,
    cash_planning_grain: merged.cashPlanningGrain,
    payroll_cadence: merged.payrollCadence,
    runway_threshold: merged.runwayThreshold,
    updated_by: actorId ?? null,
    updated_at: new Date().toISOString(),
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parsePayrollCadence(value: unknown): PlanningSettings["payrollCadence"] {
  if (value === "weekly" || value === "semimonthly" || value === "monthly") return value;
  return "biweekly";
}
