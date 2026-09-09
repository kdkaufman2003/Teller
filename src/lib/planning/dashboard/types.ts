import type { CashSourceCoverageItem } from "@/lib/planning/cash/types";
import type { VarianceStatus } from "@/lib/planning/reports/variance";

export type DashboardAvailability = "ready" | "missing";

export type DashboardMetricVariance = {
  amount: number;
  status: VarianceStatus;
  label: string;
};

export type DashboardBudgetSource = {
  available: DashboardAvailability;
  budgetId?: string;
  budgetName?: string;
  versionId?: string;
  versionLabel?: string;
  versionStatus?: string;
  fiscalYear?: number;
};

export type DashboardForecastSource = {
  available: DashboardAvailability;
  forecastId?: string;
  forecastName?: string;
  versionId?: string;
  versionLabel?: string;
  versionStatus?: string;
  anchorMonth?: string;
  stale?: boolean;
  staleMessage?: string;
};

export type DashboardCashSource = {
  available: DashboardAvailability;
  asOfDate?: string;
  runId?: string;
};

export type DashboardScenarioSource = {
  available: DashboardAvailability;
  scenarioId?: string;
  scenarioName?: string;
  forecastVersionId?: string;
};

export type DashboardVsPlanCard = {
  available: DashboardAvailability;
  headline?: string;
  direction?: "ahead" | "behind" | "on_plan";
  actual?: number;
  plan?: number;
  variance?: DashboardMetricVariance;
  throughMonthLabel?: string;
  href: string;
};

export type DashboardForecastMetricCard = {
  available: DashboardAvailability;
  value?: number;
  vsPlan?: DashboardMetricVariance;
  href: string;
};

export type DashboardCashCard = {
  available: DashboardAvailability;
  startingCash?: number;
  endingCash?: number;
  href: string;
};

export type DashboardLowestCashCard = {
  available: DashboardAvailability;
  lowestCash?: number;
  lowestCashWeekIndex?: number | null;
  lowestCashDate?: string | null;
  firstNegativeWeekIndex?: number | null;
  firstNegativeWeekLabel?: string | null;
  shortfall?: boolean;
  href: string;
};

export type DashboardDownsideCard = {
  available: DashboardAvailability;
  exists: boolean;
  endingCash?: number;
  operatingIncome?: number;
  endingCashDelta?: number;
  operatingIncomeDelta?: number;
  href: string;
  createHref: string;
};

export type DashboardAttentionItem = {
  code: string;
  severity: "critical" | "warn" | "info";
  message: string;
  href?: string;
};

export type DashboardQuickAction = {
  label: string;
  href: string;
};

export type DashboardCashWeekPoint = {
  weekIndex: number;
  label: string;
  closingCash: number;
};

export type PlanningDashboardReport = {
  asOfDate: string;
  budget: DashboardBudgetSource;
  forecast: DashboardForecastSource;
  cash: DashboardCashSource;
  scenario: DashboardScenarioSource;
  vsPlan: DashboardVsPlanCard;
  expectedRevenue: DashboardForecastMetricCard;
  expectedOperatingIncome: DashboardForecastMetricCard;
  cashOutlook: DashboardCashCard;
  lowestCash: DashboardLowestCashCard;
  downside: DashboardDownsideCard;
  attention: DashboardAttentionItem[];
  quickActions: DashboardQuickAction[];
  cashWeeks: DashboardCashWeekPoint[];
  sourceCoverage: CashSourceCoverageItem[];
};
