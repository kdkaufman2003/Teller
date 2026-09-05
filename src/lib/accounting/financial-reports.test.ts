import { describe, expect, it } from "vitest";
import {
  buildApAging,
  buildArAging,
  buildBalanceSheet,
  buildCashFlowStatement,
  agingBucketForDate,
} from "./financial-reports";
import { buildProfitAndLoss, reportPeriodRange, type AccountRow } from "./reports";

const ACCOUNTS: AccountRow[] = [
  { id: "cash", code: "1000", name: "Cash", type: "asset" },
  { id: "ar", code: "1100", name: "Accounts Receivable", type: "asset" },
  { id: "ap", code: "2000", name: "Accounts Payable", type: "liability" },
  { id: "eq", code: "3000", name: "Owner's Equity", type: "equity" },
  { id: "rev", code: "4000", name: "Sales", type: "revenue" },
  { id: "exp", code: "6100", name: "Fuel", type: "expense" },
];

describe("buildBalanceSheet", () => {
  it("balances assets against liabilities, equity, and current earnings", () => {
    const lines = [
      { account_id: "cash", debit: 10000, credit: 0, entry_date: "2026-01-01" },
      { account_id: "eq", debit: 0, credit: 10000, entry_date: "2026-01-01" },
      { account_id: "ar", debit: 5000, credit: 0, entry_date: "2026-03-05" },
      { account_id: "rev", debit: 0, credit: 5000, entry_date: "2026-03-05" },
      { account_id: "exp", debit: 1000, credit: 0, entry_date: "2026-03-10" },
      { account_id: "cash", debit: 0, credit: 1000, entry_date: "2026-03-10" },
    ];

    const sheet = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31");
    expect(sheet.totalAssets).toBe(14000);
    expect(sheet.currentEarnings).toBe(4000);
    expect(sheet.balanced).toBe(true);
  });
});

describe("buildCashFlowStatement", () => {
  it("derives operating cash from net income and working capital changes", () => {
    const range = reportPeriodRange("month", new Date("2026-03-31"));
    const lines = [
      { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-03-01" },
      { account_id: "cash", debit: 500, credit: 0, entry_date: "2026-03-15" },
      { account_id: "ar", debit: 1500, credit: 0, entry_date: "2026-03-05" },
      { account_id: "rev", debit: 0, credit: 1500, entry_date: "2026-03-05" },
    ];
    const pl = buildProfitAndLoss(
      lines.filter((line) => line.entry_date >= "2026-03-01"),
      ACCOUNTS,
    );
    const cashFlow = buildCashFlowStatement(lines, ACCOUNTS, range, pl);
    expect(cashFlow.endingCash).toBe(1500);
    expect(cashFlow.netOperating).toBeDefined();
  });
});

describe("buildArAging", () => {
  it("groups open invoice balances into aging buckets", () => {
    const report = buildArAging(
      [
        {
          status: "open",
          total: 1000,
          amount_paid: 0,
          issue_date: "2025-12-01",
          due_date: "2025-12-15",
          party_id: "p1",
          posted_entry_id: "je-1",
        },
        {
          status: "open",
          total: 500,
          amount_paid: 0,
          issue_date: "2026-03-20",
          due_date: "2026-04-01",
          party_id: "p2",
          posted_entry_id: "je-2",
        },
      ],
      new Map([
        ["p1", "ABC Mechanical"],
        ["p2", "Smith Residence"],
      ]),
      "2026-03-31",
    );

    expect(report.total).toBe(1500);
    expect(report.buckets.find((row) => row.id === "90_plus")?.amount).toBe(1000);
    expect(report.topCustomers[0]?.name).toBe("ABC Mechanical");
  });
});

describe("buildApAging", () => {
  it("uses remaining balance after partial payments", () => {
    const report = buildApAging(
      [
        {
          status: "partially_paid",
          total: 1000,
          amount_paid: 400,
          issue_date: "2026-03-01",
          due_date: "2026-03-15",
          party_id: "v1",
          posted_entry_id: "je-1",
        },
        {
          status: "paid",
          total: 500,
          amount_paid: 500,
          issue_date: "2026-03-01",
          due_date: "2026-03-15",
          party_id: "v2",
          posted_entry_id: "je-2",
        },
      ],
      new Map([["v1", "Supply Co"]]),
      "2026-03-31",
    );

    expect(report.total).toBe(600);
    expect(report.topCustomers[0]?.total).toBe(600);
  });
});

describe("agingBucketForDate", () => {
  it("classifies days past due", () => {
    expect(agingBucketForDate("2026-03-31", "2026-03-31")).toBe("current");
    expect(agingBucketForDate("2026-03-01", "2026-03-31")).toBe("1_30");
    expect(agingBucketForDate("2025-12-01", "2026-03-31")).toBe("90_plus");
  });
});
