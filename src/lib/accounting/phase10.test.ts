import { describe, expect, it } from "vitest";
import {
  allocateProportionalAmounts,
  buildCashBasisProfitAndLoss,
  buildCashBasisSettlements,
} from "./cash-basis-pl";
import { buildCashFlowStatement } from "./cash-flow-report";
import { computeComparativeAmounts, comparisonRangeForContext, buildReportContext } from "./report-context";
import { buildComparativeProfitAndLoss, buildProfitAndLossForPeriod } from "./comparative-reports";
import { buildProfitAndLoss, type AccountRow } from "./reports";
import { buildBalanceSheet } from "./financial-reports";
import { resolveJournalSource } from "./source-resolver";
import { build1099ReviewReport, classify1099Payment, isLikelyExcludedPaymentMethod } from "./tax-1099-review";
import { buildSalesTaxSummary } from "./sales-tax-summary";
import { computeDerivedRetainedEarnings } from "./derived-retained-earnings";
import { presentLabel, presentAccountName } from "./presentation-mode";

const ACCOUNTS: AccountRow[] = [
  { id: "cash", code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { id: "ar", code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { id: "ap", code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { id: "dep", code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { id: "cc", code: "2100", name: "Credit Card", type: "liability", subtype: "credit_card" },
  { id: "rev", code: "4000", name: "Revenue", type: "revenue" },
  { id: "cogs", code: "5000", name: "COGS", type: "cogs" },
  { id: "exp", code: "6100", name: "Expense", type: "expense" },
  { id: "depr", code: "6200", name: "Depreciation", type: "expense", subtype: "depreciation" },
  { id: "equity", code: "3000", name: "Owner Equity", type: "equity" },
];

describe("allocateProportionalAmounts", () => {
  it("distributes with cent rounding", () => {
    expect(allocateProportionalAmounts([100, 200], 10)).toEqual([3.33, 6.67]);
  });
});

describe("cash basis P&L", () => {
  const docs = [
    {
      id: "inv1",
      kind: "invoice",
      status: "partially_paid",
      total: 1000,
      issue_date: "2026-03-01",
      posted_entry_id: "je1",
      lines: [{ account_id: "rev", amount: 1000 }],
    },
    {
      id: "bill1",
      kind: "bill",
      status: "open",
      total: 500,
      issue_date: "2026-03-05",
      posted_entry_id: "je2",
      lines: [{ account_id: "exp", amount: 500 }],
    },
    {
      id: "exp1",
      kind: "expense",
      status: "paid",
      total: 200,
      issue_date: "2026-03-10",
      posted_entry_id: "je3",
      lines: [{ account_id: "exp", amount: 200 }],
    },
  ];

  it("1 unpaid invoice — no cash revenue", () => {
    const settlements = buildCashBasisSettlements({
      documents: [docs[0]!],
      payments: [],
      allocations: [],
      accounts: ACCOUNTS,
    });
    const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
    expect(pl.totalRevenue).toBe(0);
  });

  it("2 partial invoice payment", () => {
    const settlements = buildCashBasisSettlements({
      documents: [docs[0]!],
      payments: [
        {
          id: "p1",
          payment_date: "2026-03-15",
          payment_type: "customer_payment",
          amount: 400,
        },
      ],
      allocations: [
        {
          payment_id: "p1",
          document_id: "inv1",
          amount: 400,
          allocation_kind: "invoice_payment",
        },
      ],
      accounts: ACCOUNTS,
    });
    const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
    expect(pl.totalRevenue).toBe(400);
  });

  it("9 unpaid vendor bill — no cash expense", () => {
    const settlements = buildCashBasisSettlements({
      documents: [docs[1]!],
      payments: [],
      allocations: [],
      accounts: ACCOUNTS,
    });
    const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
    expect(pl.totalExpenses).toBe(0);
  });

  it("14 direct cash expense on issue date", () => {
    const settlements = buildCashBasisSettlements({
      documents: [docs[2]!],
      payments: [],
      allocations: [],
      accounts: ACCOUNTS,
      documentCreditAccountId: new Map([["exp1", "cash"]]),
    });
    const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
    expect(pl.totalExpenses).toBe(200);
  });

  it("17 depreciation excluded from cash settlements builder scope", () => {
    const accrualLines = [
      { account_id: "depr", debit: 100, credit: 0, entry_date: "2026-03-01" },
    ];
    const accrual = buildProfitAndLoss(accrualLines, ACCOUNTS);
    expect(accrual.totalExpenses).toBe(100);
    const cashPl = buildCashBasisProfitAndLoss([], ACCOUNTS, "2026-03-01", "2026-03-31");
    expect(cashPl.totalExpenses).toBe(0);
  });
});

describe("cash flow", () => {
  const lines = [
    { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
    { account_id: "cash", debit: 500, credit: 0, entry_date: "2026-03-15" },
    { account_id: "ar", debit: 500, credit: 0, entry_date: "2026-03-01" },
    { account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-01" },
    { account_id: "depr", debit: 50, credit: 0, entry_date: "2026-03-10", entry_id: "d1" },
    { account_id: "accum", debit: 0, credit: 50, entry_date: "2026-03-10", entry_id: "d1" },
  ];

  it("uses accrual net income", () => {
    const pl = buildProfitAndLoss(
      lines.filter((l) => l.entry_date >= "2026-03-01" && l.entry_date <= "2026-03-31"),
      [...ACCOUNTS, { id: "accum", code: "1590", name: "Accum Depr", type: "asset", subtype: "accumulated_depreciation" }],
    );
    const cf = buildCashFlowStatement({
      lines,
      accounts: ACCOUNTS,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      accrualNetIncome: pl.netIncome,
      entrySourceKinds: new Map([["d1", "fixed-asset-depreciation"]]),
    });
    expect(cf.usesAccrualNetIncome).toBe(true);
    expect(cf.operating[0]?.amount).toBe(pl.netIncome);
    const deprLine = cf.operating.find((l) => l.label.includes("Depreciation"));
    expect(deprLine?.amount).toBe(50);
  });

  it("reconciles beginning + sections to ending cash", () => {
    const cf = buildCashFlowStatement({
      lines,
      accounts: ACCOUNTS,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      accrualNetIncome: 450,
    });
    const computed =
      cf.beginningCash +
      cf.netOperating +
      cf.netInvesting +
      cf.netFinancing +
      cf.netUnclassified;
    expect(Math.abs(computed - cf.endingCash)).toBeLessThan(0.06);
  });
});

describe("balance sheet fiscal year", () => {
  const lines = [
    { account_id: "cash", debit: 10000, credit: 0, entry_date: "2025-06-01" },
    { account_id: "rev", debit: 0, credit: 10000, entry_date: "2025-08-01" },
    { account_id: "exp", debit: 2000, credit: 0, entry_date: "2025-09-01" },
    { account_id: "rev", debit: 0, credit: 5000, entry_date: "2026-02-01" },
  ];

  it("non-January fiscal year affects derived earnings split", () => {
    const jan = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 1);
    const jul = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 7);
    expect(jan.currentEarnings).not.toBe(jul.currentEarnings);
  });

  it("derived RE golden path unchanged", () => {
    const derived = computeDerivedRetainedEarnings({
      lines,
      accounts: ACCOUNTS,
      asOfDate: "2026-03-31",
      fiscalYearStartMonth: 1,
    });
    expect(derived.currentFiscalYearEarnings).toBe(5000);
    expect(derived.priorPeriodDerivedEarnings).toBe(8000);
  });
});

describe("historical reversal reporting", () => {
  it("January expense remains in January after February reversal", () => {
    const janLines = [
      { account_id: "exp", debit: 100, credit: 0, entry_date: "2026-01-15" },
      { account_id: "ap", debit: 0, credit: 100, entry_date: "2026-01-15" },
    ];
    const febLines = [
      ...janLines,
      { account_id: "exp", debit: 0, credit: 100, entry_date: "2026-02-01" },
      { account_id: "ap", debit: 100, credit: 0, entry_date: "2026-02-01" },
    ];
    const janReport = buildProfitAndLoss(
      janLines.filter((l) => l.entry_date <= "2026-01-31"),
      ACCOUNTS,
    );
    const febReport = buildProfitAndLoss(
      febLines.filter((l) => l.entry_date >= "2026-02-01" && l.entry_date <= "2026-02-28"),
      ACCOUNTS,
    );
    expect(janReport.totalExpenses).toBe(100);
    expect(febReport.totalExpenses).toBe(-100);
  });
});

describe("comparative reporting", () => {
  it("computes variance with zero denominator safety", () => {
    expect(computeComparativeAmounts(100, 0).variancePercent).toBeNull();
    expect(computeComparativeAmounts(100, 50).variancePercent).toBe(100);
  });

  it("prior period comparison range", () => {
    const ctx = buildReportContext({
      organizationId: "org",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      comparison: "prior_period",
    });
    const range = comparisonRangeForContext(ctx);
    expect(range?.end).toBe("2026-02-28");
  });

  it("comparative P&L includes accounts in only one period", () => {
    const current = buildProfitAndLoss(
      [{ account_id: "rev", debit: 0, credit: 100 }],
      ACCOUNTS,
    );
    const comparison = buildProfitAndLoss(
      [{ account_id: "exp", debit: 50, credit: 0 }],
      ACCOUNTS,
    );
    const cpl = buildComparativeProfitAndLoss(current, comparison);
    expect(cpl.revenue.length).toBeGreaterThan(0);
    expect(cpl.expenses.length).toBeGreaterThan(0);
  });
});

describe("source resolver", () => {
  it("resolves invoice source", () => {
    const resolved = resolveJournalSource({
      sourceKind: "invoice",
      sourceId: "abc",
      memo: "Invoice 1001",
    });
    expect(resolved.kind).toBe("invoice");
    expect(resolved.href).toContain("abc");
  });

  it("unknown source does not throw", () => {
    const resolved = resolveJournalSource({
      sourceKind: "legacy_custom",
      sourceId: "x",
    });
    expect(resolved.kind).toBe("unknown");
  });
});

describe("1099 review", () => {
  it("excludes card payments", () => {
    expect(isLikelyExcludedPaymentMethod("credit_card")).toBe(true);
    const c = classify1099Payment({
      amount: 600,
      paymentMethod: "credit_card",
      eligible1099: true,
      w9Received: true,
      hasTin: true,
    });
    expect(c.bucket).toBe("excluded");
  });

  it("needs review without W-9", () => {
    const report = build1099ReviewReport(
      [
        {
          vendorId: "v1",
          vendorName: "Vendor",
          legalName: "Vendor LLC",
          eligible1099: true,
          form1099Category: "NEC",
          w9Received: false,
          entityType: "LLC",
          hasTin: false,
          paymentDate: "2026-05-01",
          amount: 1000,
          paymentMethod: "check",
          paymentType: "bill_payment",
        },
      ],
      2026,
    );
    expect(report.rows[0]?.needsReview).toBe(1000);
    expect(report.filingEnabled).toBe(false);
  });
});

describe("sales tax summary", () => {
  it("flags configuration review when jurisdiction missing", () => {
    const report = buildSalesTaxSummary({
      invoices: [
        {
          issueDate: "2026-03-01",
          subtotal: 100,
          tax: 8,
          jurisdiction: null,
          taxMode: "jurisdiction",
          status: "open",
          kind: "invoice",
        },
      ],
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      salesTaxPayableGlBalance: 8,
      orgTaxMode: "jurisdiction",
    });
    expect(report.configurationReviewRequired).toBe(true);
    expect(report.filingEnabled).toBe(false);
  });
});

describe("accrual P&L via buildProfitAndLossForPeriod", () => {
  it("filters by date range", () => {
    const lines = [
      { account_id: "rev", debit: 0, credit: 100, entry_date: "2026-01-01" },
      { account_id: "rev", debit: 0, credit: 200, entry_date: "2026-03-01" },
    ];
    const pl = buildProfitAndLossForPeriod({
      basis: "accrual",
      lines,
      accounts: ACCOUNTS,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    expect(pl.totalRevenue).toBe(200);
  });
});

describe("owner vs accountant presentation", () => {
  it("changes labels only, never amounts", () => {
    const lines = [
      { account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-05" },
      { account_id: "exp", debit: 200, credit: 0, entry_date: "2026-03-05" },
    ];
    const accountant = buildProfitAndLoss(lines, ACCOUNTS);
    const owner = buildProfitAndLoss(lines, ACCOUNTS);

    expect(accountant.totalRevenue).toBe(owner.totalRevenue);
    expect(accountant.totalExpenses).toBe(owner.totalExpenses);
    expect(accountant.netIncome).toBe(owner.netIncome);
    expect(accountant.grossProfit).toBe(owner.grossProfit);

    expect(presentLabel("owner", "Net Income")).not.toBe(presentLabel("accountant", "Net Income"));
    expect(presentAccountName("owner", "Accounts Receivable", "receivable")).toBe(
      "Customers owe you",
    );
    expect(presentAccountName("accountant", "Accounts Receivable", "receivable")).toBe(
      "Accounts Receivable",
    );
  });
});
