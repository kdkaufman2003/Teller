export type ConsolidationScopeEntity = {
  legalEntityId: string;
  entityCode: string;
  name: string;
  booksClosedThrough: string | null;
};

export type ConsolidationScope = {
  organizationId: string;
  entities: ConsolidationScopeEntity[];
  scopeLabel: string;
  preElimination: true;
  currency: string;
};

export type EntityContribution = {
  legalEntityId: string;
  entityName: string;
  entityCode: string;
  amount: number;
  accountId?: string;
};

export type ConsolidationReportMode = "pre" | "post";

export type ConsolidatedReportMeta = {
  scope: ConsolidationScope;
  generatedAt: string;
  reportMode: ConsolidationReportMode;
  preEliminationLabel: string;
  postEliminationLabel?: string;
  intercompanyWarnings: string[];
  periodStatuses: Array<{
    legalEntityId: string;
    entityName: string;
    booksClosedThrough: string | null;
    status: "open" | "closed_for_date";
  }>;
};

export type ConsolidatedTrialBalanceRow = {
  groupKey: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  adjustedDebit: number;
  adjustedCredit: number;
  netBalance: number;
  isIntercompany: boolean;
  entityContributions: EntityContribution[];
};

export type ConsolidatedTrialBalanceReport = ConsolidatedReportMeta & {
  periodStart: string | null;
  periodEnd: string;
  rows: ConsolidatedTrialBalanceRow[];
  eliminationAdjustments?: Array<{
    groupKey: string;
    code: string;
    name: string;
    type: string;
    subtype: string;
    eliminationDebit: number;
    eliminationCredit: number;
  }>;
  totals: {
    adjustedDebit: number;
    adjustedCredit: number;
  };
  balanced: boolean;
};

export type ConsolidatedFinancialLine = {
  groupKey: string;
  code: string;
  name: string;
  amount: number;
  isIntercompany: boolean;
  entityContributions: EntityContribution[];
};

export type ConsolidatedProfitAndLossReport = ConsolidatedReportMeta & {
  periodStart: string | null;
  periodEnd: string;
  revenue: ConsolidatedFinancialLine[];
  cogs: ConsolidatedFinancialLine[];
  expenses: ConsolidatedFinancialLine[];
  totalRevenue: number;
  totalCogs: number;
  grossProfit: number;
  totalExpenses: number;
  netIncome: number;
  entityNetIncome: EntityContribution[];
};

export type ConsolidatedBalanceSheetReport = ConsolidatedReportMeta & {
  asOf: string;
  assets: ConsolidatedFinancialLine[];
  liabilities: ConsolidatedFinancialLine[];
  equity: ConsolidatedFinancialLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
  intercompanyDueFromTotal: number;
  intercompanyDueToTotal: number;
};

export type ConsolidatedCashFlowReport = ConsolidatedReportMeta & {
  periodStart: string;
  periodEnd: string;
  netOperating: number;
  netInvesting: number;
  netFinancing: number;
  netChangeInCash: number;
  beginningCash: number;
  endingCash: number;
  entityNetChange: EntityContribution[];
  limitation?: string | null;
};
