import { describe, expect, it } from "vitest";
import { computeDerivedRetainedEarnings } from "./derived-retained-earnings";
import type { AccountRow } from "./reports";

const accounts: AccountRow[] = [
  { id: "rev", code: "4000", name: "Revenue", type: "revenue" },
  { id: "exp", code: "6100", name: "Expense", type: "expense" },
  { id: "re", code: "3100", name: "Retained Earnings", type: "equity", subtype: "retained_earnings" },
  { id: "obe", code: "3900", name: "Opening Balance Equity", type: "equity", subtype: "opening_balance_equity" },
];

describe("computeDerivedRetainedEarnings", () => {
  it("A. opening migration balance — explicit RE only, no prior P&L in Teller", () => {
    const lines = [
      { account_id: "re", debit: 0, credit: 500_000, entry_date: "2026-01-01" },
      { account_id: "rev", debit: 0, credit: 50_000, entry_date: "2026-06-01" },
      { account_id: "exp", debit: 0, credit: 0, entry_date: "2026-06-01" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-12-31",
      fiscalYearStartMonth: 1,
    });

    expect(result.retainedEarningsGlBalance).toBe(500_000);
    expect(result.priorPeriodDerivedEarnings).toBe(0);
    expect(result.currentFiscalYearEarnings).toBe(50_000);
    expect(result.totalRetainedEarningsPresentation).toBe(550_000);
  });

  it("B. full historical GL — no explicit RE", () => {
    const lines = [
      { account_id: "rev", debit: 0, credit: 100_000, entry_date: "2025-06-15" },
      { account_id: "exp", debit: 20_000, credit: 0, entry_date: "2025-08-01" },
      { account_id: "rev", debit: 0, credit: 40_000, entry_date: "2026-03-01" },
      { account_id: "exp", debit: 15_000, credit: 0, entry_date: "2026-05-01" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-06-30",
      fiscalYearStartMonth: 1,
    });

    expect(result.retainedEarningsGlBalance).toBe(0);
    expect(result.priorPeriodDerivedEarnings).toBe(80_000);
    expect(result.currentFiscalYearEarnings).toBe(25_000);
    expect(result.totalRetainedEarningsPresentation).toBe(105_000);
  });

  it("C. opening RE plus visible prior-year P&L — additive, no subtraction", () => {
    const lines = [
      { account_id: "re", debit: 0, credit: 300_000, entry_date: "2025-01-01" },
      { account_id: "rev", debit: 0, credit: 40_000, entry_date: "2025-09-01" },
      { account_id: "rev", debit: 0, credit: 15_000, entry_date: "2026-04-01" },
      { account_id: "exp", debit: 5_000, credit: 0, entry_date: "2026-04-01" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-12-31",
      fiscalYearStartMonth: 1,
    });

    expect(result.retainedEarningsGlBalance).toBe(300_000);
    expect(result.priorPeriodDerivedEarnings).toBe(40_000);
    expect(result.currentFiscalYearEarnings).toBe(10_000);
    expect(result.totalRetainedEarningsPresentation).toBe(350_000);
  });

  it("D. prior-year loss reduces total presentation", () => {
    const lines = [
      { account_id: "re", debit: 0, credit: 200_000, entry_date: "2025-01-01" },
      { account_id: "exp", debit: 30_000, credit: 0, entry_date: "2025-06-01" },
      { account_id: "rev", debit: 0, credit: 20_000, entry_date: "2026-03-01" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-12-31",
      fiscalYearStartMonth: 1,
    });

    expect(result.priorPeriodDerivedEarnings).toBe(-30_000);
    expect(result.currentFiscalYearEarnings).toBe(20_000);
    expect(result.totalRetainedEarningsPresentation).toBe(190_000);
  });

  it("E. non-calendar fiscal year starting July", () => {
    const lines = [
      { account_id: "rev", debit: 0, credit: 50_000, entry_date: "2025-09-01" },
      { account_id: "rev", debit: 0, credit: 30_000, entry_date: "2026-08-01" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-09-15",
      fiscalYearStartMonth: 7,
    });

    expect(result.priorPeriodDerivedEarnings).toBe(50_000);
    expect(result.currentFiscalYearEarnings).toBe(30_000);
  });

  it("F. Opening Balance Equity remains separate from retained earnings", () => {
    const lines = [
      { account_id: "obe", debit: 0, credit: 25_000, entry_date: "2026-01-01" },
      { account_id: "rev", debit: 0, credit: 10_000, entry_date: "2026-06-01" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-12-31",
      fiscalYearStartMonth: 1,
    });

    expect(result.retainedEarningsGlBalance).toBe(0);
    expect(result.currentFiscalYearEarnings).toBe(10_000);
    expect(result.totalRetainedEarningsPresentation).toBe(10_000);
  });

  it("G. AJE revenue/expense activity included in current FY earnings", () => {
    const lines = [
      { account_id: "exp", debit: 2_000, credit: 0, entry_date: "2026-03-15" },
      { account_id: "rev", debit: 0, credit: 5_000, entry_date: "2026-03-20" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-03-31",
      fiscalYearStartMonth: 1,
    });

    expect(result.currentFiscalYearEarnings).toBe(3_000);
  });

  it("H. credit memos/refunds reduce revenue through normal GL economics", () => {
    const lines = [
      { account_id: "rev", debit: 0, credit: 10_000, entry_date: "2026-02-01" },
      { account_id: "rev", debit: 1_500, credit: 0, entry_date: "2026-02-15" },
    ];

    const result = computeDerivedRetainedEarnings({
      lines,
      accounts,
      asOfDate: "2026-02-28",
      fiscalYearStartMonth: 1,
    });

    expect(result.currentFiscalYearEarnings).toBe(8_500);
  });
});
