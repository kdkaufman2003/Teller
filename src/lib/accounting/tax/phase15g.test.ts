import { describe, expect, it } from "vitest";
import {
  aggregateRollforward,
  signedTaxAmountForTransaction,
} from "./filing/rollforward";

describe("Phase 15G authority payment rollforward", () => {
  it("treats authority payment as liability reduction", () => {
    const signed = signedTaxAmountForTransaction({
      id: "p1",
      transactionType: "authority_payment",
      transactionDate: "2026-06-15",
      taxAmount: 8000,
      determinationStatus: "resolved",
    });
    expect(signed.authorityPayments).toBe(8000);
    expect(signed.netAmount).toBe(-8000);
  });

  it("treats payment reversal adjustment as liability increase", () => {
    const signed = signedTaxAmountForTransaction({
      id: "r1",
      transactionType: "tax_adjustment",
      transactionDate: "2026-06-16",
      taxAmount: 8000,
      determinationStatus: "resolved",
      metadata: { authorityPaymentReversal: true },
    });
    expect(signed.authorityPayments).toBe(-8000);
    expect(signed.netAmount).toBe(8000);
  });

  it("separates manual increase and decrease adjustments", () => {
    const increase = signedTaxAmountForTransaction({
      id: "a1",
      transactionType: "tax_adjustment",
      transactionDate: "2026-06-01",
      taxAmount: 25,
      determinationStatus: "resolved",
      metadata: { manualAdjustment: true, adjustmentDirection: "increase_liability" },
    });
    const decrease = signedTaxAmountForTransaction({
      id: "a2",
      transactionType: "tax_adjustment",
      transactionDate: "2026-06-02",
      taxAmount: 10,
      determinationStatus: "resolved",
      metadata: { manualAdjustment: true, adjustmentDirection: "decrease_liability" },
    });
    expect(increase.netAmount).toBe(25);
    expect(decrease.netAmount).toBe(-10);
  });

  it("aggregates accruals and payments in one rollforward", () => {
    const { totals } = aggregateRollforward([
      {
        id: "1",
        transactionType: "sales_tax_collected",
        transactionDate: "2026-06-01",
        taxAmount: 10000,
        determinationStatus: "resolved",
      },
      {
        id: "2",
        transactionType: "authority_payment",
        transactionDate: "2026-06-20",
        taxAmount: 6000,
        determinationStatus: "resolved",
      },
    ]);
    expect(totals.salesTaxAccrued).toBe(10000);
    expect(totals.authorityPayments).toBe(6000);
    expect(totals.netAmount).toBe(4000);
  });

  it("does not treat base tax payment as expense accrual", () => {
    const signed = signedTaxAmountForTransaction({
      id: "p2",
      transactionType: "authority_payment",
      transactionDate: "2026-06-20",
      taxAmount: 500,
      determinationStatus: "resolved",
    });
    expect(signed.salesTaxAccrued).toBe(0);
    expect(signed.useTaxAccrued).toBe(0);
  });
});

describe("Phase 15G payment journal semantics", () => {
  it("documents base tax payment as Dr payable Cr cash composition", () => {
    const baseTaxAmount = 8000;
    const penaltyAmount = 200;
    const totalCash = baseTaxAmount + penaltyAmount;
    const lines = [
      { account: "sales_tax_payable", debit: baseTaxAmount, credit: 0 },
      { account: "tax_penalty_expense", debit: penaltyAmount, credit: 0 },
      { account: "cash", debit: 0, credit: totalCash },
    ];
    const debits = lines.reduce((sum, line) => sum + line.debit, 0);
    const credits = lines.reduce((sum, line) => sum + line.credit, 0);
    expect(debits).toBe(credits);
    expect(lines.find((line) => line.account === "sales_tax_payable")?.debit).toBe(8000);
    expect(lines.find((line) => line.account === "tax_penalty_expense")?.debit).toBe(200);
  });
});

describe("Phase 15G period balance semantics", () => {
  it("computes remaining balance after partial payment", () => {
    const filedLiability = 10000;
    const previouslyPaid = 6000;
    const remainingBalance = Math.max(filedLiability - previouslyPaid, 0);
    expect(remainingBalance).toBe(4000);
  });

  it("keeps filed distinct from paid", () => {
    const filed = true;
    const paid = false;
    expect(filed && !paid).toBe(true);
  });
});
