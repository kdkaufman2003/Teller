import { describe, expect, it } from "vitest";
import { buildBalanceSheet } from "./financial-reports";
import { buildProfitAndLoss, type AccountRow } from "./reports";
import {
  cumulativeBalanceFromTotals,
  netIncomeFromTotals,
  periodActivityFromTotals,
  synthesizeCumulativeLines,
  synthesizePeriodPlLines,
  type GlAccountTotalRow,
} from "./gl-account-totals";
import { buildBalanceSheetFromTotals } from "./financial-reports";
import { computeDerivedRetainedEarningsFromTotals } from "./derived-retained-earnings";

const ACCOUNTS: AccountRow[] = [
  { id: "cash", code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { id: "ar", code: "1100", name: "AR", type: "asset", subtype: "receivable" },
  { id: "ap", code: "2000", name: "AP", type: "liability", subtype: "payable" },
  { id: "rev", code: "4000", name: "Revenue", type: "revenue" },
  { id: "exp", code: "6100", name: "Expense", type: "expense" },
  { id: "equity", code: "3000", name: "Equity", type: "equity" },
];

const LINES = [
  { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-01-15" },
  { account_id: "rev", debit: 0, credit: 1000, entry_date: "2026-01-15" },
  { account_id: "exp", debit: 200, credit: 0, entry_date: "2026-03-05" },
  { account_id: "cash", debit: 0, credit: 200, entry_date: "2026-03-05" },
  { account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-10" },
  { account_id: "ar", debit: 500, credit: 0, entry_date: "2026-03-10" },
];

function totalsFromLines(
  lines: typeof LINES,
  periodStart: string,
  periodEnd: string,
): GlAccountTotalRow[] {
  const byAccount = new Map<string, GlAccountTotalRow>();

  for (const account of ACCOUNTS) {
    byAccount.set(account.id, {
      account_id: account.id,
      opening_debit: 0,
      opening_credit: 0,
      period_debit: 0,
      period_credit: 0,
    });
  }

  for (const line of lines) {
    const row = byAccount.get(line.account_id)!;
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (line.entry_date < periodStart) {
      row.opening_debit = Number(row.opening_debit) + debit;
      row.opening_credit = Number(row.opening_credit) + credit;
    } else if (line.entry_date >= periodStart && line.entry_date <= periodEnd) {
      row.period_debit = Number(row.period_debit) + debit;
      row.period_credit = Number(row.period_credit) + credit;
    }
  }

  return [...byAccount.values()];
}

describe("gl account totals RPC synthesis", () => {
  it("matches line-based P&L for period activity", () => {
    const periodTotals = totalsFromLines(LINES, "2026-03-01", "2026-03-31");
    const linePl = buildProfitAndLoss(
      LINES.filter((l) => l.entry_date >= "2026-03-01" && l.entry_date <= "2026-03-31"),
      ACCOUNTS,
    );
    const rpcPl = buildProfitAndLoss(
      synthesizePeriodPlLines(periodTotals, ACCOUNTS, "2026-03-31"),
      ACCOUNTS,
    );
    expect(rpcPl.totalRevenue).toBe(linePl.totalRevenue);
    expect(rpcPl.totalExpenses).toBe(linePl.totalExpenses);
    expect(rpcPl.netIncome).toBe(linePl.netIncome);
  });

  it("matches line-based balance sheet cumulative totals", () => {
    const cumulativeTotals = totalsFromLines(LINES, "1970-01-01", "2026-03-31");
    const lineBs = buildBalanceSheet(LINES, ACCOUNTS, "2026-03-31", 1);
    const rpcBs = buildBalanceSheetFromTotals({
      cumulativeTotals,
      priorTotals: totalsFromLines(LINES, "1970-01-01", "2025-12-31"),
      accounts: ACCOUNTS,
      asOf: "2026-03-31",
      fiscalYearStartMonth: 1,
    });
    expect(rpcBs.totalAssets).toBe(lineBs.totalAssets);
    expect(rpcBs.totalLiabilities).toBe(lineBs.totalLiabilities);
  });

  it("derives retained earnings from totals", () => {
    const cumulative = totalsFromLines(LINES, "1970-01-01", "2026-03-31");
    const prior = totalsFromLines(LINES, "1970-01-01", "2025-12-31");
    const derived = computeDerivedRetainedEarningsFromTotals({
      cumulativeTotals: cumulative,
      priorTotals: prior,
      accounts: ACCOUNTS,
      asOfDate: "2026-03-31",
      fiscalYearStartMonth: 1,
    });
    expect(derived.currentFiscalYearEarnings).toBe(
      netIncomeFromTotals(cumulative, ACCOUNTS) - netIncomeFromTotals(prior, ACCOUNTS),
    );
  });

  it("aggregates cumulative balance per account", () => {
    const cumulative = totalsFromLines(LINES, "1970-01-01", "2026-03-31");
    const cashRow = cumulative.find((row) => row.account_id === "cash")!;
    expect(cumulativeBalanceFromTotals(cashRow, "asset")).toBe(800);
    const revRow = cumulative.find((row) => row.account_id === "rev")!;
    expect(periodActivityFromTotals(revRow, "revenue")).toBe(1500);
  });
});
