import { describe, expect, it } from "vitest";
import {
  buildCashBasisProfitAndLoss,
  buildProfitAndLoss,
  buildSalesSummary,
  isBilledInvoice,
  reportPeriodRange,
  type AccountRow,
  type JournalLineRow,
} from "./reports";

const ACCOUNTS: AccountRow[] = [
  { id: "r1", code: "4000", name: "Equipment Sales", type: "revenue" },
  { id: "c1", code: "5000", name: "Equipment Cost", type: "cogs" },
  { id: "e1", code: "6100", name: "Vehicle & Fuel", type: "expense" },
  { id: "a1", code: "1000", name: "Cash", type: "asset" },
];

describe("buildProfitAndLoss", () => {
  it("totals revenue, cogs, expenses, and net income", () => {
    const lines: JournalLineRow[] = [
      { account_id: "r1", debit: 0, credit: 10000 },
      { account_id: "c1", debit: 4000, credit: 0 },
      { account_id: "e1", debit: 500, credit: 0 },
      { account_id: "a1", debit: 5500, credit: 0 },
    ];

    const report = buildProfitAndLoss(lines, ACCOUNTS);
    expect(report.totalRevenue).toBe(10000);
    expect(report.totalCogs).toBe(4000);
    expect(report.grossProfit).toBe(6000);
    expect(report.totalExpenses).toBe(500);
    expect(report.netIncome).toBe(5500);
  });
});

describe("buildSalesSummary", () => {
  it("summarizes invoice activity for a period", () => {
    const range = reportPeriodRange("ytd", new Date("2026-09-04"));
    const summary = buildSalesSummary(
      [
        {
          status: "paid",
          total: 1000,
          issue_date: "2026-03-01",
          party_id: "p1",
          posted_entry_id: "je-1",
        },
        {
          status: "open",
          total: 500,
          amount_paid: 0,
          issue_date: "2026-04-01",
          party_id: "p1",
          posted_entry_id: "je-2",
        },
        {
          status: "draft",
          total: 200,
          issue_date: "2026-05-01",
          party_id: null,
        },
        {
          status: "open",
          total: 300,
          issue_date: "2026-06-01",
          party_id: "p3",
          posted_entry_id: null,
        },
        {
          status: "paid",
          total: 800,
          issue_date: "2025-12-01",
          party_id: "p2",
          posted_entry_id: "je-old",
        },
      ],
      new Map([
        ["p1", "ABC Mechanical"],
        ["p2", "Old Customer"],
      ]),
      range,
    );

    expect(summary.postedTotal).toBe(1500);
    expect(summary.invoiced).toBe(1500);
    expect(summary.collected).toBe(1000);
    expect(summary.awaitingPayment).toBe(500);
    expect(summary.open).toBe(500);
    expect(summary.draft).toBe(200);
    expect(summary.topCustomers[0]?.name).toBe("ABC Mechanical");
  });

  it("excludes draft and unposted invoices from billed sales", () => {
    expect(
      isBilledInvoice({ status: "draft", posted_entry_id: null }),
    ).toBe(false);
    expect(
      isBilledInvoice({ status: "open", posted_entry_id: null }),
    ).toBe(false);
    expect(
      isBilledInvoice({ status: "open", posted_entry_id: "je-1" }),
    ).toBe(true);
    expect(
      isBilledInvoice({ status: "partially_paid", posted_entry_id: "je-1" }),
    ).toBe(true);
  });
});

describe("reportPeriodRange", () => {
  it("returns year-to-date bounds", () => {
    const range = reportPeriodRange("ytd", new Date("2026-09-04"));
    expect(range.start).toBe("2026-01-01");
    expect(range.end).toBe("2026-09-04");
  });

  it("uses fiscal year start for YTD when not January", () => {
    const range = reportPeriodRange("ytd", new Date("2026-05-15"), 4);
    expect(range.start).toBe("2026-04-01");
    expect(range.end).toBe("2026-05-15");
    expect(range.label).toMatch(/Fiscal YTD/i);
  });
});

describe("buildCashBasisProfitAndLoss", () => {
  it("uses only paid invoices for revenue", () => {
    const range = reportPeriodRange("ytd", new Date("2026-09-04"));
    const report = buildCashBasisProfitAndLoss(
      [
        {
          status: "paid",
          total: 1000,
          issue_date: "2026-03-01",
          party_id: "p1",
          posted_entry_id: "je-1",
        },
        {
          status: "open",
          total: 1500,
          issue_date: "2026-04-01",
          party_id: "p2",
          posted_entry_id: "je-2",
        },
      ],
      [],
      ACCOUNTS,
      range,
    );
    expect(report.totalRevenue).toBe(1000);
  });
});
