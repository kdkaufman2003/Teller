export type ForecastVersionStatus = "draft" | "published" | "archived";
export type ForecastBaselineKind = "blank" | "budget" | "prior_forecast";
export type ForecastLineSourceKind =
  | "manual"
  | "budget"
  | "clone"
  | "actual"
  | "assumption";

/** V1 assumption calculation types (stored in parameters.assumptionType). */
export type AssumptionType =
  | "percentage_change"
  | "fixed_monthly_amount"
  | "target_margin"
  | "month_multiplier"
  | "note";

export type AssumptionTargetScope = "all_revenue" | "all_cogs" | "all_expense" | "account";

export type ForecastAssumptionKind =
  | "revenue_growth"
  | "labor_cost"
  | "material_inflation"
  | "rent_increase"
  | "seasonality"
  | "other"
  | "general";

export type ForecastAssumptionValueType = "percentage" | "currency" | "text";

export type ForecastLineInput = {
  accountId: string;
  periodMonth: string;
  amount: number;
  notes?: string;
  sourceKind?: ForecastLineSourceKind;
  metadata?: Record<string, unknown>;
};

export type ForecastAssumptionInput = {
  name: string;
  description?: string;
  assumptionKind?: ForecastAssumptionKind;
  assumptionType?: AssumptionType;
  targetScope?: AssumptionTargetScope;
  valueType?: ForecastAssumptionValueType;
  valueNumeric?: number | null;
  valueText?: string | null;
  effectiveStartMonth?: string | null;
  effectiveEndMonth?: string | null;
  targetAccountId?: string | null;
  parameters?: Record<string, unknown>;
  priority?: number;
};

export type CreateForecastInput = {
  organizationId: string;
  name: string;
  anchorMonth: string;
  horizonMonths?: number;
  baselineKind?: ForecastBaselineKind;
  sourceBudgetVersionId?: string | null;
  sourceForecastVersionId?: string | null;
  actorId?: string | null;
};

export const MAX_FORECAST_BULK_LINES = 5000;

export const BASELINE_SOURCE_KINDS: ForecastLineSourceKind[] = ["budget", "clone"];

export type ForecastAssumptionRecord = {
  id: string;
  name: string;
  description: string;
  assumptionKind: ForecastAssumptionKind;
  assumptionType: AssumptionType;
  targetScope: AssumptionTargetScope;
  valueType: ForecastAssumptionValueType;
  valueNumeric: number | null;
  valueText: string | null;
  effectiveStartMonth: string | null;
  effectiveEndMonth: string | null;
  targetAccountId: string | null;
  parameters: Record<string, unknown>;
  priority: number;
};

export type ForecastCellSource = "actual" | "manual" | "assumption" | "baseline";

export type ForecastCellMeta = {
  source: ForecastCellSource;
  explanation: string;
  assumptionId?: string;
};

export type AssumptionPreviewSummary = {
  revenue: { before: number; after: number; change: number };
  cogs: { before: number; after: number; change: number };
  expenses: { before: number; after: number; change: number };
  grossProfit: { before: number; after: number; change: number };
  operatingIncome: { before: number; after: number; change: number };
};

export type AssumptionEngineResult = {
  effectiveValues: Map<string, number>;
  cellMeta: Map<string, ForecastCellMeta>;
  summary: AssumptionPreviewSummary;
  linesToPersist: ForecastLineInput[];
};
