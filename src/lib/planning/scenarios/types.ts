import type { CashOutlookReport } from "@/lib/planning/cash/types";
import type { RollingForecastReport } from "@/lib/planning/reports/rolling-forecast";

export type ScenarioType = "base" | "downside" | "upside" | "custom";
export type ScenarioStatus = "draft" | "active" | "archived";

export type ScenarioDriverType =
  | "revenue_percentage"
  | "cogs_percentage"
  | "expense_percentage"
  | "gross_margin_points"
  | "ar_days_adjustment"
  | "ap_days_adjustment"
  | "payroll_percentage"
  | "purchasing_percentage"
  | "capex_percentage"
  | "note";

export type ScenarioDriverInput = {
  driverType: ScenarioDriverType;
  valueNumeric?: number | null;
  valueText?: string;
  targetScope?: string;
};

export type ScenarioDriverRecord = ScenarioDriverInput & {
  id: string;
  scenarioId: string;
};

export type ScenarioCashAdjustmentInput = {
  effectiveDate: string;
  flowKind: "inflow" | "outflow";
  amount: number;
  label: string;
  notes?: string;
};

export type ScenarioCashAdjustmentRecord = ScenarioCashAdjustmentInput & {
  id: string;
  scenarioId: string;
};

export type ScenarioRecord = {
  id: string;
  organizationId: string;
  forecastId: string;
  forecastVersionId: string;
  name: string;
  scenarioType: ScenarioType;
  isSystem: boolean;
  status: ScenarioStatus;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioForecastResult = {
  base: RollingForecastReport;
  scenario: RollingForecastReport;
  drivers: ScenarioDriverRecord[];
};

export type ScenarioCashResult = {
  base: CashOutlookReport;
  scenario: CashOutlookReport;
  drivers: ScenarioDriverRecord[];
};

export type ScenarioMetricComparison = {
  label: string;
  base: number;
  scenario: number;
  delta: number;
  deltaPercent: number | null;
};

export type ScenarioComparisonRow = {
  scenarioId: string;
  scenarioName: string;
  scenarioType: ScenarioType;
  revenue: number;
  operatingIncome: number;
  endingCash: number;
  lowestCash: number;
  firstNegativeWeekIndex: number | null;
  runwayWeeks: number | "13+";
};

export type ScenarioComparisonReport = {
  baseScenarioId: string | null;
  rows: ScenarioComparisonRow[];
  forecastMetrics: ScenarioMetricComparison[];
  cashMetrics: ScenarioMetricComparison[];
  deltaExplanation: Array<{ label: string; amount: number }>;
  warnings: Array<{ code: string; message: string; severity: "info" | "warn" }>;
};

export type ScenarioPreviewInput = {
  forecastId: string;
  forecastVersionId: string;
  scenarioType: ScenarioType;
  name?: string;
  drivers: ScenarioDriverInput[];
  cashAdjustments?: ScenarioCashAdjustmentInput[];
  asOfDate?: string;
};
