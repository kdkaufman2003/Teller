import type { CashSourceCoverageItem } from "@/lib/planning/cash/types";
import type { VarianceAmounts } from "@/lib/planning/reports/variance";

export type PackageAvailability = "ready" | "missing";

export type AccountantCategoryVariance = {
  label: string;
  month: VarianceAmounts;
  ytd: VarianceAmounts;
};

export type AccountantPlanningRisk = {
  code: string;
  severity: "critical" | "warn" | "info";
  message: string;
  href?: string;
};

export type AccountantSourceLineage = {
  budget?: {
    name: string;
    fiscalYear: number;
    versionLabel: string;
    versionStatus: string;
    versionId: string;
  };
  forecast?: {
    name: string;
    versionLabel: string;
    versionStatus: string;
    versionId: string;
    anchorMonth: string;
    publishedAt?: string | null;
    actualCutoffMonth?: string;
    sourceBudgetVersionId?: string | null;
    stale: boolean;
    staleMessage?: string;
  };
  cash?: {
    asOfDate: string;
    generatedAt: string;
    runId?: string;
  };
  scenarios?: Array<{
    name: string;
    type: string;
    forecastVersionId: string;
  }>;
  reportPeriod: {
    label: string;
    periodEnd: string;
    fiscalYear: number;
    throughMonth: string;
  };
};

export type AccountantSourceMismatch = {
  code: string;
  message: string;
};

export type AccountantScenarioRow = {
  scenarioType: string;
  scenarioName: string;
  revenue: number;
  operatingIncome: number;
  endingCash: number;
  lowestCash: number;
  firstNegativeWeekIndex: number | null;
};

export type AccountantCashCategoryTotal = {
  category: string;
  label: string;
  inflows: number;
  outflows: number;
};

export type AccountantPlanningPackage = {
  generatedAt: string;
  presentationMode: "accountant";
  closeContext: {
    planningBlocksClose: false;
    closeRewritesPlanning: false;
  };
  lineage: AccountantSourceLineage;
  sourceMismatches: AccountantSourceMismatch[];
  budgetVsActual: {
    available: PackageAvailability;
    currentPeriodLabel?: string;
    categories?: AccountantCategoryVariance[];
    operatingIncome?: { month: VarianceAmounts; ytd: VarianceAmounts };
    materialVariances?: Array<{ label: string; ytdVariance: number; status: string }>;
  };
  forecast: {
    available: PackageAvailability;
    expectedRevenue?: number;
    expectedGrossProfit?: number;
    expectedOperatingIncome?: number;
    budgetComparison?: VarianceAmounts;
    stale?: boolean;
    staleMessage?: string;
  };
  cash: {
    available: PackageAvailability;
    startingCash?: number;
    expectedMoneyIn?: number;
    expectedMoneyOut?: number;
    endingCash?: number;
    lowestCash?: number;
    lowestCashDate?: string | null;
    firstNegativeWeekIndex?: number | null;
    firstNegativeWeekLabel?: string | null;
    runwayWeeks?: number | "13+";
    categoryTotals?: AccountantCashCategoryTotal[];
    sourceCoverage?: CashSourceCoverageItem[];
    warnings?: Array<{ code: string; message: string; severity: string }>;
  };
  scenarios: {
    available: PackageAvailability;
    rows?: AccountantScenarioRow[];
  };
  risks: AccountantPlanningRisk[];
  links: {
    budgetVsActual: string;
    forecast: string;
    cash: string;
    scenarios: string;
  };
};
