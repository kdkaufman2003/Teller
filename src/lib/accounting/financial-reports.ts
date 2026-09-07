import { asNumber } from "@/lib/format";
import type { AccountRow, DateRange, JournalLineRow, ProfitAndLoss } from "./reports";
import { buildProfitAndLoss, isBilledInvoice } from "./reports";
import { computeDerivedRetainedEarnings } from "./derived-retained-earnings";
import { parseFiscalYearStart } from "@/lib/org/config";

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

export type AgingBucketId = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export type AgingBucket = {
  id: AgingBucketId;
  label: string;
  amount: number;
  count: number;
};

export type AgingCustomerRow = {
  name: string;
  total: number;
  buckets: Record<AgingBucketId, number>;
};

export type AgingReport = {
  buckets: AgingBucket[];
  total: number;
  topCustomers: AgingCustomerRow[];
};

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

function accountBalanceTotal(
  balances: Map<string, number>,
  accounts: AccountRow[],
  matcher: (account: AccountRow) => boolean,
): number {
  return roundMoney(
    accounts
      .filter(matcher)
      .reduce((sum, account) => sum + (balances.get(account.id) ?? 0), 0),
  );
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
    (lines.length
      ? lines.map((line) => line.entry_date).sort()[0]
      : end);

  const startBalances = accumulateAccountBalances(lines, accounts, dayBefore(start));
  const endBalances = accumulateAccountBalances(lines, accounts, end);

  const isCash = (account: AccountRow) =>
    account.subtype === "bank" || account.code === "1000";
  const isReceivable = (account: AccountRow) =>
    account.subtype === "receivable" || account.code === "1100";
  const isPayable = (account: AccountRow) =>
    account.subtype === "payable" || account.code === "2000";

  const beginningCash = accountBalanceTotal(startBalances, accounts, isCash);
  const endingCash = accountBalanceTotal(endBalances, accounts, isCash);

  const arStart = accountBalanceTotal(startBalances, accounts, isReceivable);
  const arEnd = accountBalanceTotal(endBalances, accounts, isReceivable);
  const apStart = accountBalanceTotal(startBalances, accounts, isPayable);
  const apEnd = accountBalanceTotal(endBalances, accounts, isPayable);

  const deltaAr = roundMoney(arEnd - arStart);
  const deltaAp = roundMoney(apEnd - apStart);

  const operating: CashFlowLine[] = [
    { label: "Net income", amount: profitAndLoss.netIncome },
    { label: "Change in accounts receivable", amount: roundMoney(-deltaAr) },
    { label: "Change in accounts payable", amount: deltaAp },
  ];

  const netOperating = roundMoney(
    operating.reduce((sum, row) => sum + row.amount, 0),
  );
  const netChangeInCash = roundMoney(endingCash - beginningCash);
  const netInvesting = 0;
  const netFinancing = roundMoney(netChangeInCash - netOperating);

  return {
    operating,
    netOperating,
    netInvesting,
    netFinancing,
    netChangeInCash,
    beginningCash,
    endingCash,
  };
}

function dayBefore(isoDate: string): string {
  const date = new Date(isoDate.slice(0, 10) + "T12:00:00");
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function agingBucketForDate(referenceDate: string, asOf: string): AgingBucketId {
  const ref = new Date(referenceDate.slice(0, 10) + "T12:00:00").getTime();
  const asOfMs = new Date(asOf.slice(0, 10) + "T12:00:00").getTime();
  const days = Math.floor((asOfMs - ref) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

const AGING_LABELS: Record<AgingBucketId, string> = {
  current: "Current",
  "1_30": "1–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
};

type OpenDocumentRow = {
  total: number | string;
  amount_paid?: number | string;
  issue_date: string;
  due_date?: string | null;
  party_id: string | null;
  status: string;
  posted_entry_id?: string | null;
};

export function buildArAging(
  invoices: OpenDocumentRow[],
  partyNames: Map<string, string>,
  asOf: string,
): AgingReport {
  return buildDocumentAging(
    invoices.filter(
      (row) =>
        (row.status === "open" || row.status === "partially_paid") &&
        isBilledInvoice(row),
    ),
    partyNames,
    asOf,
    (row) => row.due_date || row.issue_date,
    (row) => asNumber(row.total) - asNumber(row.amount_paid),
  );
}

export function buildApAging(
  expenses: OpenDocumentRow[],
  partyNames: Map<string, string>,
  asOf: string,
): AgingReport {
  return buildDocumentAging(
    expenses.filter(
      (row) =>
        (row.status === "open" || row.status === "partially_paid") &&
        Boolean(row.posted_entry_id),
    ),
    partyNames,
    asOf,
    (row) => row.due_date || row.issue_date,
    (row) => asNumber(row.total) - asNumber(row.amount_paid),
  );
}

function buildDocumentAging(
  rows: OpenDocumentRow[],
  partyNames: Map<string, string>,
  asOf: string,
  dueDateFor: (row: OpenDocumentRow) => string,
  balanceFor: (row: OpenDocumentRow) => number,
): AgingReport {
  const bucketTotals = new Map<AgingBucketId, { amount: number; count: number }>();
  const customerTotals = new Map<
    string,
    { name: string; total: number; buckets: Record<AgingBucketId, number> }
  >();

  for (const id of Object.keys(AGING_LABELS) as AgingBucketId[]) {
    bucketTotals.set(id, { amount: 0, count: 0 });
  }

  for (const row of rows) {
    const balance = roundMoney(balanceFor(row));
    if (balance <= 0.009) continue;

    const bucket = agingBucketForDate(dueDateFor(row), asOf);
    const current = bucketTotals.get(bucket)!;
    current.amount = roundMoney(current.amount + balance);
    current.count += 1;
    bucketTotals.set(bucket, current);

    if (row.party_id) {
      const name = partyNames.get(row.party_id) || "Unknown";
      const existing = customerTotals.get(row.party_id) ?? {
        name,
        total: 0,
        buckets: {
          current: 0,
          "1_30": 0,
          "31_60": 0,
          "61_90": 0,
          "90_plus": 0,
        },
      };
      existing.total = roundMoney(existing.total + balance);
      existing.buckets[bucket] = roundMoney(existing.buckets[bucket] + balance);
      customerTotals.set(row.party_id, existing);
    }
  }

  const buckets = (Object.keys(AGING_LABELS) as AgingBucketId[]).map((id) => ({
    id,
    label: AGING_LABELS[id],
    amount: bucketTotals.get(id)?.amount ?? 0,
    count: bucketTotals.get(id)?.count ?? 0,
  }));

  const total = roundMoney(buckets.reduce((sum, row) => sum + row.amount, 0));
  const topCustomers = [...customerTotals.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return { buckets, total, topCustomers };
}

export type ReportTab = "overview" | "balance_sheet" | "cash_flow" | "ar_aging" | "ap_aging";

export function parseReportTab(value: string | null | undefined): ReportTab {
  if (
    value === "balance_sheet" ||
    value === "cash_flow" ||
    value === "ar_aging" ||
    value === "ap_aging"
  ) {
    return value;
  }
  return "overview";
}
