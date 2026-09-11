import { describe, expect, it } from "vitest";
import {
  detectRegistrationOverlap,
  generateFilingPeriodsForRegistration,
} from "./filing/period-generation";
import { assertFilingPeriodTransition, isImmutableFilingPeriodStatus } from "./filing/period-status";
import { evaluatePeriodReadiness } from "./filing/readiness";
import {
  aggregateRollforward,
  includesVendorTaxInUseTaxLiability,
  signedTaxAmountForTransaction,
} from "./filing/rollforward";
import type { TaxRegistrationRecord } from "./filing/types";

function registration(overrides: Partial<TaxRegistrationRecord> = {}): TaxRegistrationRecord {
  return {
    id: "reg-1",
    organizationId: "org-1",
    authorityId: "auth-1",
    jurisdictionKey: "US-KS",
    filingFrequency: "monthly",
    status: "active",
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

describe("Phase 15F period generation", () => {
  it("generates monthly periods", () => {
    const periods = generateFilingPeriodsForRegistration(
      registration({ filingFrequency: "monthly" }),
      "2026-01-01",
      "2026-03-31",
    );
    expect(periods).toHaveLength(3);
    expect(periods[0]).toEqual({
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      filingFrequency: "monthly",
    });
  });

  it("generates quarterly periods", () => {
    const periods = generateFilingPeriodsForRegistration(
      registration({ filingFrequency: "quarterly" }),
      "2026-01-01",
      "2026-12-31",
    );
    expect(periods).toHaveLength(4);
    expect(periods[1]?.periodStart).toBe("2026-04-01");
  });

  it("generates annual periods", () => {
    const periods = generateFilingPeriodsForRegistration(
      registration({ filingFrequency: "annual" }),
      "2026-01-01",
      "2027-12-31",
    );
    expect(periods.map((row) => row.periodStart)).toEqual(["2026-01-01", "2027-01-01"]);
  });

  it("respects registration effective date boundary", () => {
    const periods = generateFilingPeriodsForRegistration(
      registration({ effectiveFrom: "2026-02-15" }),
      "2026-01-01",
      "2026-03-31",
    );
    expect(periods[0]?.periodStart).toBe("2026-02-15");
    expect(periods.some((row) => row.periodEnd === "2026-01-31")).toBe(false);
  });

  it("respects registration end date boundary", () => {
    const periods = generateFilingPeriodsForRegistration(
      registration({ effectiveTo: "2026-02-10" }),
      "2026-01-01",
      "2026-12-31",
    );
    expect(periods.at(-1)?.periodEnd).toBe("2026-02-10");
  });

  it("is idempotent across repeated generation input", () => {
    const first = generateFilingPeriodsForRegistration(registration(), "2026-01-01", "2026-02-28");
    const second = generateFilingPeriodsForRegistration(registration(), "2026-01-01", "2026-02-28");
    expect(first).toEqual(second);
  });

  it("supports zero-activity period windows", () => {
    const periods = generateFilingPeriodsForRegistration(registration(), "2026-05-01", "2026-05-31");
    expect(periods).toHaveLength(1);
  });

  it("detects overlapping registrations", () => {
    const overlap = detectRegistrationOverlap([
      registration({ id: "a", authorityId: "auth-1", jurisdictionKey: "US-KS" }),
      registration({ id: "b", authorityId: "auth-1", jurisdictionKey: "US-KS", effectiveFrom: "2026-06-01" }),
    ]);
    expect(overlap).toBe(true);
  });
});

describe("Phase 15F liability rollforward", () => {
  it("aggregates sales and use tax separately", () => {
    const { totals } = aggregateRollforward([
      {
        id: "1",
        transactionType: "sales_tax_collected",
        transactionDate: "2026-06-01",
        taxAmount: 80,
        determinationStatus: "resolved",
      },
      {
        id: "2",
        transactionType: "use_tax_accrued",
        transactionDate: "2026-06-02",
        taxAmount: 20,
        determinationStatus: "resolved",
      },
    ]);
    expect(totals.salesTaxAccrued).toBe(80);
    expect(totals.useTaxAccrued).toBe(20);
    expect(totals.netAmount).toBe(100);
  });

  it("treats sales reversals and use-tax adjustments as liability reductions", () => {
    const salesReversal = signedTaxAmountForTransaction({
      id: "1",
      transactionType: "sales_tax_reversed",
      transactionDate: "2026-06-03",
      taxAmount: 15,
      determinationStatus: "resolved",
    });
    const useReversal = signedTaxAmountForTransaction({
      id: "2",
      transactionType: "tax_adjustment",
      transactionDate: "2026-06-04",
      taxAmount: 5,
      determinationStatus: "resolved",
      metadata: { purchaseTaxReversal: true },
    });
    expect(salesReversal.netAmount).toBe(-15);
    expect(useReversal.netAmount).toBe(-5);
  });

  it("excludes vendor tax from use-tax liability semantics", () => {
    const flagged = includesVendorTaxInUseTaxLiability([
      {
        id: "1",
        transactionType: "use_tax_accrued",
        transactionDate: "2026-06-01",
        taxAmount: 80,
        determinationStatus: "resolved",
        metadata: { vendorTax: 80, useTaxDue: 0, vendorTaxChargedDocument: 80 },
      },
    ]);
    expect(flagged).toBe(true);
  });

  it("preserves negative activity without forcing zero", () => {
    const { totals } = aggregateRollforward([
      {
        id: "1",
        transactionType: "sales_tax_collected",
        transactionDate: "2026-06-01",
        taxAmount: 10,
        determinationStatus: "resolved",
      },
      {
        id: "2",
        transactionType: "sales_tax_reversed",
        transactionDate: "2026-06-02",
        taxAmount: 25,
        determinationStatus: "resolved",
      },
    ]);
    expect(totals.netAmount).toBe(-15);
  });
});

describe("Phase 15F readiness and status", () => {
  it("blocks readiness when reconciliation exceptions are blocking", () => {
    const readiness = evaluatePeriodReadiness([
      {
        code: "SUBLEDGER_GL_DIFFERENCE",
        message: "Difference",
        severity: "blocking",
      },
    ]);
    expect(readiness.ready).toBe(false);
  });

  it("allows open to ready_for_review transition", () => {
    expect(() => assertFilingPeriodTransition("open", "ready_for_review")).not.toThrow();
  });

  it("prevents invalid filed period mutation semantics", () => {
    expect(isImmutableFilingPeriodStatus("filed")).toBe(true);
    expect(() => assertFilingPeriodTransition("filed", "open")).toThrow();
  });
});

describe("Phase 15F historical immutability contract", () => {
  it("uses transaction dates and posted amounts only", () => {
    const signed = signedTaxAmountForTransaction({
      id: "1",
      transactionType: "sales_tax_collected",
      transactionDate: "2026-01-15",
      taxAmount: 12.34,
      determinationStatus: "resolved",
    });
    expect(signed.salesTaxAccrued).toBe(12.34);
  });
});
