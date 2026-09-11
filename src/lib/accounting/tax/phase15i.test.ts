import { describe, expect, it } from "vitest";
import { neutralizeTaxCsvFormula, sanitizeTaxCsvCell, taxRowsToCsv } from "./reports/csv";
import { filterTransactions, parseTaxReportFilters, TRANSACTION_ID_BATCH_SIZE } from "./reports/filters";
import { paginateRows } from "./reports/load";
import { buildTaxSummaryFromTransactions } from "./reports/summary";
import { buildTaxRollforwardFromTransactions } from "./reports/rollforward";
import { sumDetailTaxAmount } from "./reports/details";
import type { LoadedTaxTransaction, TaxReportFilters } from "./reports/types";

const ORG = "00000000-0000-0000-0000-000000000101";

function tx(overrides: Partial<LoadedTaxTransaction>): LoadedTaxTransaction {
  return {
    id: overrides.id ?? "tx-1",
    organizationId: ORG,
    transactionType: "sales_tax_collected",
    sourceType: "invoice",
    determinationStatus: "resolved",
    transactionDate: "2026-06-15",
    taxableBasis: 100,
    taxAmount: 6.5,
    ...overrides,
  };
}

const baseFilters: TaxReportFilters = {
  organizationId: ORG,
  startDate: "2026-06-01",
  endDate: "2026-06-30",
};

describe("Phase 15I tax reports", () => {
  it("builds tax summary from posted subledger transactions", () => {
    const summary = buildTaxSummaryFromTransactions(baseFilters, [
      tx({ id: "s1", transactionType: "sales_tax_collected", taxableBasis: 200, taxAmount: 13 }),
      tx({ id: "u1", transactionType: "use_tax_accrued", taxableBasis: 50, taxAmount: 3.25 }),
      tx({
        id: "e1",
        transactionType: "sales_tax_collected",
        determinationStatus: "exempt",
        taxableBasis: 75,
        taxAmount: 0,
      }),
      tx({ id: "p1", transactionType: "authority_payment", taxAmount: 10 }),
    ]);

    expect(summary.salesTaxAccrued).toBe(13);
    expect(summary.useTaxAccrued).toBe(3.25);
    expect(summary.authorityPayments).toBe(10);
    expect(summary.taxableSales).toBe(200);
    expect(summary.exemptSales).toBe(75);
    expect(summary.netLiabilityChange).toBe(6.25);
  });

  it("rollforward balances to zero difference for clean period", () => {
    const beginning = [tx({ id: "b1", transactionDate: "2026-05-15", taxAmount: 20 })];
    const period = [
      tx({ id: "p1", transactionType: "sales_tax_collected", taxAmount: 13 }),
      tx({ id: "p2", transactionType: "authority_payment", taxAmount: 8 }),
    ];
    const report = buildTaxRollforwardFromTransactions(baseFilters, beginning, period);
    expect(report.beginningLiability).toBe(20);
    expect(report.endingOutstandingLiability).toBe(25);
    expect(report.rollforwardDifference).toBe(0);
  });

  it("detail tax amounts reconcile to summary sales tax total", () => {
    const transactions = [
      tx({ id: "1", taxAmount: 6.5 }),
      tx({ id: "2", taxAmount: 3.5 }),
      tx({ id: "3", transactionType: "use_tax_accrued", taxAmount: 2 }),
    ];
    const summary = buildTaxSummaryFromTransactions(baseFilters, transactions);
    const salesDetailTotal = sumDetailTaxAmount(
      transactions.filter((row) => row.transactionType === "sales_tax_collected"),
    );
    expect(salesDetailTotal).toBe(10);
    expect(summary.salesTaxAccrued).toBe(10);
  });

  it("filters by registration and state without recalculating tax law", () => {
    const rows = [
      tx({ id: "1", registrationId: "reg-ks", primaryJurisdictionKey: "US-KS" }),
      tx({ id: "2", registrationId: "reg-mo", primaryJurisdictionKey: "US-MO" }),
    ];
    const ksOnly = filterTransactions(rows, { ...baseFilters, state: "KS", registrationId: "reg-ks" });
    expect(ksOnly).toHaveLength(1);
    expect(ksOnly[0]?.id).toBe("1");
  });

  it("paginates detail rows for large datasets", () => {
    const rows = Array.from({ length: 250 }, (_, index) => tx({ id: `tx-${index}` }));
    const page = paginateRows(rows, { limit: 100, offset: 100 });
    expect(page.total).toBe(250);
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]?.id).toBe("tx-100");
  });

  it("uses batch size safe for large journal id lists", () => {
    expect(TRANSACTION_ID_BATCH_SIZE).toBeLessThanOrEqual(100);
    const ids = Array.from({ length: 496 }, (_, i) => `id-${i}`);
    const batches = Math.ceil(ids.length / TRANSACTION_ID_BATCH_SIZE);
    expect(batches).toBeGreaterThan(1);
  });

  it("sanitizes CSV formula injection prefixes", () => {
    expect(sanitizeTaxCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutralizeTaxCsvFormula("=HYPERLINK(\"evil\")").startsWith("'")).toBe(true);
    expect(sanitizeTaxCsvCell("+123")).toBe("'+123");
    expect(sanitizeTaxCsvCell("-123")).toBe("'-123");
    expect(sanitizeTaxCsvCell("@cmd")).toBe("'@cmd");
  });

  it("export CSV totals match numeric summary values", () => {
    const summary = buildTaxSummaryFromTransactions(baseFilters, [tx({ taxAmount: 6.5, taxableBasis: 100 })]);
    const csv = taxRowsToCsv(
      [{ salesTaxAccrued: summary.salesTaxAccrued.toFixed(2), taxableSales: summary.taxableSales.toFixed(2) }],
      [
        { key: "salesTaxAccrued", header: "Sales Tax Accrued" },
        { key: "taxableSales", header: "Taxable Sales" },
      ],
    );
    expect(csv).toContain("6.50");
    expect(csv).toContain("100.00");
  });

  it("preserves historical exempt snapshot fields in report filters", () => {
    const filters = parseTaxReportFilters({
      organizationId: ORG,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      determinationStatus: "exempt",
    });
    expect(filters.determinationStatus).toBe("exempt");
    expect(filters.organizationId).toBe(ORG);
  });

  it("does not mutate accounting — report builders are pure over loaded rows", () => {
    const rows = [tx({ id: "immutable" })];
    const before = JSON.stringify(rows);
    buildTaxSummaryFromTransactions(baseFilters, rows);
    buildTaxRollforwardFromTransactions(baseFilters, [], rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
