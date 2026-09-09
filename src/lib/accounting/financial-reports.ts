import { asNumber } from "@/lib/format";
import type { AccountRow, DateRange, JournalLineRow, ProfitAndLoss } from "./reports";
import { computeDerivedRetainedEarnings, computeDerivedRetainedEarningsFromTotals } from "./derived-retained-earnings";
import type { GlAccountTotalRow } from "./gl-account-totals";
import { accountBalancesMapFromTotals } from "./gl-account-totals";
import { parseFiscalYearStart } from "@/lib/org/config";
import { buildCashFlowStatement as buildCashFlowStatementV2 } from "./cash-flow-report";

export { buildArAging, buildApAging, agingBucketForDate } from "./aging-service";

export type FinancialReportLine = {
  code: string;
  name: string;
  amount: number;
};

export type BalanceSheet = {
  asOf: string;
  assets: FinancialReportLine[];
  liabilities: FinancialReportLine[];
  equity: FinancialReportLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentEarnings: number;
  balanced: boolean;
};

export type {
  AgingBucket,
  AgingBucketId,
  AgingCustomerRow,
  AgingReport,
} from "./aging-service";

export type CashFlowLine = {
  label: string;
  amount: number;
};

export type CashFlowStatement = {
  operating: CashFlowLine[];
  netOperating: number;
  netInvesting: number;
  netFinancing: number;
  netChangeInCash: number;
  beginningCash: number;
  endingCash: number;
};

type DatedJournalLine = JournalLineRow & { entry_date: string };

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function balanceForType(type: string, debit: number, credit: number): number {
  if (type === "asset") return debit - credit;
  if (type === "liability" || type === "equity") return credit - debit;
  if (type === "revenue") return credit - debit;
  if (type === "cogs" || type === "expense") return debit - credit;
  return debit - credit;
}

export function accumulateAccountBalances(
  lines: DatedJournalLine[],
  accounts: AccountRow[],
  asOf: string,
) {
  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  const balances = new Map<string, number>();

  for (const line of lines) {
    if (line.entry_date > asOf) continue;
    const account = accountMap.get(line.account_id);
    if (!account) continue;
    const delta = balanceForType(account.type, asNumber(line.debit), asNumber(line.credit));
    balances.set(account.id, roundMoney((balances.get(account.id) ?? 0) + delta));
  }

  return balances;
}

function linesForAccounts(
  balances: Map<string, number>,
  accounts: AccountRow[],
  type: string,
): FinancialReportLine[] {
  return accounts
    .filter((account) => account.type === type)
    .map((account) => ({
      code: account.code,
      name: account.name,
      amount: roundMoney(balances.get(account.id) ?? 0),
    }))
    .filter((row) => row.amount !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function buildBalanceSheet(
  lines: DatedJournalLine[],
  accounts: AccountRow[],
  asOf: string,
  fiscalYearStartMonth = 1,
): BalanceSheet {
  const balances = accumulateAccountBalances(lines, accounts, asOf);

  const assets = linesForAccounts(balances, accounts, "asset");
  const liabilities = linesForAccounts(balances, accounts, "liability");
  const equityAccounts = linesForAccounts(balances, accounts, "equity").filter(
    (row) => row.code !== "3999",
  );

  const derived = computeDerivedRetainedEarnings({
    lines,
    accounts,
    asOfDate: asOf,
    fiscalYearStartMonth: parseFiscalYearStart(fiscalYearStartMonth),
  });

  const totalAssets = roundMoney(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, row) => sum + row.amount, 0));
  const equityFromAccounts = roundMoney(
    equityAccounts.reduce((sum, row) => sum + row.amount, 0),
  );
  const totalEquity = roundMoney(
    equityFromAccounts + derived.priorPeriodDerivedEarnings + derived.currentFiscalYearEarnings,
  );

  const equity: FinancialReportLine[] = [...equityAccounts];
  if (derived.priorPeriodDerivedEarnings !== 0) {
    equity.push({
      code: "3198",
      name: "Prior years' earnings (derived)",
      amount: derived.priorPeriodDerivedEarnings,
    });
  }
  if (derived.currentFiscalYearEarnings !== 0) {
    equity.push({
      code: "3999",
      name: "Current fiscal year earnings",
      amount: derived.currentFiscalYearEarnings,
    });
  }

  const balanced = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.05;

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    currentEarnings: derived.currentFiscalYearEarnings,
    balanced,
  };
}

export function buildBalanceSheetFromTotals(input: {
  cumulativeTotals: GlAccountTotalRow[];
  priorTotals: GlAccountTotalRow[];
  accounts: AccountRow[];
  asOf: string;
  fiscalYearStartMonth?: number;
}): BalanceSheet {
  const balances = accountBalancesMapFromTotals(input.cumulativeTotals, input.accounts);
  const assets = linesForAccounts(balances, input.accounts, "asset");
  const liabilities = linesForAccounts(balances, input.accounts, "liability");
  const equityAccounts = linesForAccounts(balances, input.accounts, "equity").filter(
    (row) => row.code !== "3999",
  );

  const derived = computeDerivedRetainedEarningsFromTotals({
    cumulativeTotals: input.cumulativeTotals,
    priorTotals: input.priorTotals,
    accounts: input.accounts,
    asOfDate: input.asOf,
    fiscalYearStartMonth: parseFiscalYearStart(input.fiscalYearStartMonth ?? 1),
  });

  const totalAssets = roundMoney(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, row) => sum + row.amount, 0));
  const equityFromAccounts = roundMoney(
    equityAccounts.reduce((sum, row) => sum + row.amount, 0),
  );
  const totalEquity = roundMoney(
    equityFromAccounts + derived.priorPeriodDerivedEarnings + derived.currentFiscalYearEarnings,
  );

  const equity: FinancialReportLine[] = [...equityAccounts];
  if (derived.priorPeriodDerivedEarnings !== 0) {
    equity.push({
      code: "3198",
      name: "Prior years' earnings (derived)",
      amount: derived.priorPeriodDerivedEarnings,
    });
  }
  if (derived.currentFiscalYearEarnings !== 0) {
    equity.push({
      code: "3999",
      name: "Current fiscal year earnings",
      amount: derived.currentFiscalYearEarnings,
    });
  }

  const balanced = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.05;

  return {
    asOf: input.asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    currentEarnings: derived.currentFiscalYearEarnings,
    balanced,
  };
}

export function buildCashFlowStatement(
  lines: DatedJournalLine[],
  accounts: AccountRow[],
  range: DateRange,
  profitAndLoss: ProfitAndLoss,
): CashFlowStatement {
  const end = range.end ?? new Date().toISOString().slice(0, 10);
  const start =
    range.start ??
    (lines.length ? lines.map((line) => line.entry_date).sort()[0]! : end);

  const full = buildCashFlowStatementV2({
    lines,
    accounts,
    startDate: start,
    endDate: end,
    accrualNetIncome: profitAndLoss.netIncome,
  });

  return {
    operating: full.operating,
    netOperating: full.netOperating,
    netInvesting: full.netInvesting,
    netFinancing: full.netFinancing,
    netChangeInCash: full.netChangeInCash,
    beginningCash: full.beginningCash,
    endingCash: full.endingCash,
  };
}

export type ReportTab =
  | "overview"
  | "balance_sheet"
  | "cash_flow"
  | "ar_aging"
  | "ap_aging"
  | "planning";

export function parseReportTab(value: string | null | undefined): ReportTab {
  if (
    value === "balance_sheet" ||
    value === "cash_flow" ||
    value === "ar_aging" ||
    value === "ap_aging" ||
    value === "planning"
  ) {
    return value;
  }
  return "overview";
}
