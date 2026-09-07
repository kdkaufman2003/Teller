import {
  buildBalanceSheet,
  type BalanceSheet,
  type FinancialReportLine,
} from "./financial-reports";
import { computeComparativeAmounts, type ComparativeAmounts } from "./report-context";
import {
  buildProfitAndLoss,
  type AccountRow,
  type JournalLineRow,
  type ProfitAndLoss,
} from "./reports";
import {
  buildCashBasisProfitAndLoss,
  buildCashBasisSettlements,
  type CashBasisAllocation,
  type CashBasisDocument,
  type CashBasisPayment,
} from "./cash-basis-pl";
import type { AccountingBasis } from "./reports";

export type ComparativeLine = FinancialReportLine & ComparativeAmounts;

export type ComparativeProfitAndLoss = {
  revenue: ComparativeLine[];
  cogs: ComparativeLine[];
  expenses: ComparativeLine[];
  totals: {
    totalRevenue: ComparativeAmounts;
    totalCogs: ComparativeAmounts;
    grossProfit: ComparativeAmounts;
    totalExpenses: ComparativeAmounts;
    netIncome: ComparativeAmounts;
  };
};

export type ComparativeBalanceSheet = {
  asOf: string;
  comparisonAsOf: string | null;
  assets: ComparativeLine[];
  liabilities: ComparativeLine[];
  equity: ComparativeLine[];
  totals: {
    totalAssets: ComparativeAmounts;
    totalLiabilities: ComparativeAmounts;
    totalEquity: ComparativeAmounts;
  };
  balanced: boolean;
};

type DatedLine = JournalLineRow & { entry_date: string };

function mergePlLines(
  current: ProfitAndLoss,
  comparison: ProfitAndLoss,
  section: "revenue" | "cogs" | "expenses",
): ComparativeLine[] {
  const currentLines = current[section];
  const comparisonLines = comparison[section];
  const codes = new Set([
    ...currentLines.map((l) => l.code),
    ...comparisonLines.map((l) => l.code),
  ]);

  return [...codes]
    .sort()
    .map((code) => {
      const cur = currentLines.find((l) => l.code === code);
      const cmp = comparisonLines.find((l) => l.code === code);
      const amounts = computeComparativeAmounts(cur?.amount ?? 0, cmp?.amount ?? 0);
      return {
        code,
        name: cur?.name ?? cmp?.name ?? code,
        amount: amounts.currentAmount,
        ...amounts,
      };
    })
    .filter((l) => Math.abs(l.currentAmount) >= 0.005 || Math.abs(l.comparisonAmount) >= 0.005);
}

export function buildComparativeProfitAndLoss(
  currentPl: ProfitAndLoss,
  comparisonPl: ProfitAndLoss,
): ComparativeProfitAndLoss {
  return {
    revenue: mergePlLines(currentPl, comparisonPl, "revenue"),
    cogs: mergePlLines(currentPl, comparisonPl, "cogs"),
    expenses: mergePlLines(currentPl, comparisonPl, "expenses"),
    totals: {
      totalRevenue: computeComparativeAmounts(
        currentPl.totalRevenue,
        comparisonPl.totalRevenue,
      ),
      totalCogs: computeComparativeAmounts(currentPl.totalCogs, comparisonPl.totalCogs),
      grossProfit: computeComparativeAmounts(currentPl.grossProfit, comparisonPl.grossProfit),
      totalExpenses: computeComparativeAmounts(
        currentPl.totalExpenses,
        comparisonPl.totalExpenses,
      ),
      netIncome: computeComparativeAmounts(currentPl.netIncome, comparisonPl.netIncome),
    },
  };
}

function mergeBsSection(
  current: FinancialReportLine[],
  comparison: FinancialReportLine[],
): ComparativeLine[] {
  const codes = new Set([...current.map((l) => l.code), ...comparison.map((l) => l.code)]);
  return [...codes]
    .sort()
    .map((code) => {
      const cur = current.find((l) => l.code === code);
      const cmp = comparison.find((l) => l.code === code);
      const amounts = computeComparativeAmounts(cur?.amount ?? 0, cmp?.amount ?? 0);
      return {
        code,
        name: cur?.name ?? cmp?.name ?? code,
        amount: amounts.currentAmount,
        ...amounts,
      };
    })
    .filter((l) => Math.abs(l.currentAmount) >= 0.005 || Math.abs(l.comparisonAmount) >= 0.005);
}

export function buildComparativeBalanceSheet(
  current: BalanceSheet,
  comparison: BalanceSheet,
): ComparativeBalanceSheet {
  return {
    asOf: current.asOf,
    comparisonAsOf: comparison.asOf,
    assets: mergeBsSection(current.assets, comparison.assets),
    liabilities: mergeBsSection(current.liabilities, comparison.liabilities),
    equity: mergeBsSection(current.equity, comparison.equity),
    totals: {
      totalAssets: computeComparativeAmounts(current.totalAssets, comparison.totalAssets),
      totalLiabilities: computeComparativeAmounts(
        current.totalLiabilities,
        comparison.totalLiabilities,
      ),
      totalEquity: computeComparativeAmounts(current.totalEquity, comparison.totalEquity),
    },
    balanced: current.balanced && comparison.balanced,
  };
}

export function buildProfitAndLossForPeriod(input: {
  basis: AccountingBasis;
  lines: DatedLine[];
  accounts: AccountRow[];
  startDate: string | null;
  endDate: string | null;
  cashBasis?: {
    documents: CashBasisDocument[];
    payments: CashBasisPayment[];
    allocations: CashBasisAllocation[];
  };
}): ProfitAndLoss {
  const periodLines = input.lines.filter((line) => {
    if (input.startDate && line.entry_date < input.startDate) return false;
    if (input.endDate && line.entry_date > input.endDate) return false;
    return true;
  });

  if (input.basis === "cash" && input.cashBasis) {
    const settlements = buildCashBasisSettlements({
      documents: input.cashBasis.documents,
      payments: input.cashBasis.payments,
      allocations: input.cashBasis.allocations,
      accounts: input.accounts,
    });
    return buildCashBasisProfitAndLoss(
      settlements,
      input.accounts,
      input.startDate,
      input.endDate,
    );
  }

  return buildProfitAndLoss(periodLines, input.accounts);
}

export function buildBalanceSheetsForComparison(input: {
  lines: DatedLine[];
  accounts: AccountRow[];
  asOf: string;
  comparisonAsOf: string;
  fiscalYearStart: number;
}): { current: BalanceSheet; comparison: BalanceSheet } {
  return {
    current: buildBalanceSheet(
      input.lines,
      input.accounts,
      input.asOf,
      input.fiscalYearStart,
    ),
    comparison: buildBalanceSheet(
      input.lines,
      input.accounts,
      input.comparisonAsOf,
      input.fiscalYearStart,
    ),
  };
}
