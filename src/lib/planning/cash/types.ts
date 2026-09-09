export type CashFlowKind = "inflow" | "outflow";

export type CashLineCategory =
  | "ar_collection"
  | "ap_payment"
  | "payroll"
  | "recurring"
  | "purchasing"
  | "capex"
  | "manual"
  | "starting_cash";

export type CashWeekBucketResult =
  | { kind: "week"; weekIndex: number }
  | { kind: "overdue" }
  | { kind: "beyond" };

export type CashHorizonWeek = {
  weekIndex: number;
  periodStart: string;
  periodEnd: string;
  label: string;
};

export type CashStartingAccount = {
  accountId: string;
  code: string;
  name: string;
  subtype: string;
  balance: number;
};

export type CashStartingCash = {
  total: number;
  accounts: CashStartingAccount[];
  asOfDate: string;
};

export type CashFlowLine = {
  id?: string;
  weekIndex: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  flowKind: CashFlowKind;
  category: CashLineCategory;
  amount: number;
  sourceKind: string;
  sourceId: string | null;
  label: string;
  explanation: string;
  overdue?: boolean;
  beyondHorizon?: boolean;
  metadata?: Record<string, unknown>;
};

export type CashWeeklySummary = {
  weekIndex: number;
  periodStart: string;
  periodEnd: string;
  label: string;
  openingCash: number;
  cashIn: number;
  cashOut: number;
  netChange: number;
  closingCash: number;
  lines: CashFlowLine[];
};

export type CashOutlookWarning = {
  code: string;
  message: string;
  severity: "info" | "warn";
};

export type CashOutlookSummary = {
  startingCash: number;
  expectedMoneyIn: number;
  expectedMoneyOut: number;
  endingCash: number;
  lowestCash: number;
  lowestCashWeekIndex: number | null;
  lowestCashDate: string | null;
  firstNegativeWeekIndex: number | null;
  firstNegativeWeekLabel: string | null;
  runwayWeeks: number | "13+";
};

export type CashSourceCoverageItem = {
  key: string;
  label: string;
  included: boolean;
  count: number;
};

export type CashOutlookReport = {
  asOfDate: string;
  horizonWeeks: number;
  horizonStart: string;
  horizonEnd: string;
  startingCash: CashStartingCash;
  weeks: CashWeeklySummary[];
  beyondHorizon: CashFlowLine[];
  unscheduledPurchasing: CashFlowLine[];
  summary: CashOutlookSummary;
  warnings: CashOutlookWarning[];
  sourceCoverage: CashSourceCoverageItem[];
  settings: {
    defaultArCollectionDays: number;
    defaultApPaymentDays: number;
    payrollCadence: string;
  };
  runId?: string;
};

export type CashManualOverrideInput = {
  effectiveDate: string;
  flowKind: CashFlowKind;
  amount: number;
  label: string;
  notes?: string;
  planningCategory?: "general" | "capex";
};

export const CASH_HORIZON_WEEKS = 13;
