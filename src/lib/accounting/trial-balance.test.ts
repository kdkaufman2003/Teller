import { describe, expect, it } from "vitest";
import {
  computeTrialBalanceRowTotals,
  isTrialBalanceBalanced,
} from "./trial-balance";

describe("trial balance totals", () => {
  it("computes unadjusted and adjusted columns from bucket inputs", () => {
    const row = computeTrialBalanceRowTotals({
      openingDebit: 100,
      openingCredit: 0,
      periodDebit: 50,
      periodCredit: 20,
      adjustmentDebit: 10,
      adjustmentCredit: 5,
    });
    expect(row.unadjustedDebit).toBe(140);
    expect(row.unadjustedCredit).toBe(15);
    expect(row.adjustedDebit).toBe(150);
    expect(row.adjustedCredit).toBe(20);
  });

  it("treats equal adjusted totals as balanced within tolerance", () => {
    expect(isTrialBalanceBalanced(1000, 1000)).toBe(true);
    expect(isTrialBalanceBalanced(1000.005, 1000)).toBe(true);
  });

  it("flags material imbalance", () => {
    expect(isTrialBalanceBalanced(1000, 999)).toBe(false);
    expect(isTrialBalanceBalanced(500, 501.5)).toBe(false);
  });

  it("returns adjusted equal to unadjusted when no adjustments", () => {
    const row = computeTrialBalanceRowTotals({
      openingDebit: 200,
      openingCredit: 50,
      periodDebit: 75,
      periodCredit: 25,
      adjustmentDebit: 0,
      adjustmentCredit: 0,
    });
    expect(row.adjustedDebit).toBe(row.unadjustedDebit);
    expect(row.adjustedCredit).toBe(row.unadjustedCredit);
    expect(isTrialBalanceBalanced(row.adjustedDebit, row.adjustedCredit)).toBe(false);
  });

  it("balances when debits and credits net across rows", () => {
    const debitHeavy = computeTrialBalanceRowTotals({
      openingDebit: 0,
      openingCredit: 0,
      periodDebit: 500,
      periodCredit: 0,
      adjustmentDebit: 0,
      adjustmentCredit: 0,
    });
    const creditHeavy = computeTrialBalanceRowTotals({
      openingDebit: 0,
      openingCredit: 0,
      periodDebit: 0,
      periodCredit: 500,
      adjustmentDebit: 0,
      adjustmentCredit: 0,
    });
    const totalDebit = debitHeavy.adjustedDebit + creditHeavy.adjustedDebit;
    const totalCredit = debitHeavy.adjustedCredit + creditHeavy.adjustedCredit;
    expect(isTrialBalanceBalanced(totalDebit, totalCredit)).toBe(true);
  });
});
