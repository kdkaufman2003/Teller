import { describe, expect, it } from "vitest";
import {
  computeReconciliationBalances,
  reconciliationDifferenceOk,
} from "./reconciliation";

describe("computeReconciliationBalances", () => {
  it("calculates asset bank ending balance and difference", () => {
    const summary = computeReconciliationBalances({
      beginningReconciledBalance: 1000,
      statementEndingBalance: 1450,
      items: [
        { clearedAmount: 500, direction: "increase" },
        { clearedAmount: 50, direction: "decrease" },
      ],
      glKind: "asset_bank",
    });

    expect(summary.clearedIncreases).toBe(500);
    expect(summary.clearedDecreases).toBe(50);
    expect(summary.calculatedEndingBalance).toBe(1450);
    expect(summary.difference).toBe(0);
  });

  it("flags non-zero difference", () => {
    const summary = computeReconciliationBalances({
      beginningReconciledBalance: 1000,
      statementEndingBalance: 1500,
      items: [{ clearedAmount: 400, direction: "increase" }],
    });
    expect(summary.difference).toBe(100);
    expect(reconciliationDifferenceOk(summary.difference)).toBe(false);
  });
});

describe("reconciliationDifferenceOk", () => {
  it("accepts differences within USD tolerance", () => {
    expect(reconciliationDifferenceOk(0)).toBe(true);
    expect(reconciliationDifferenceOk(0.01)).toBe(true);
    expect(reconciliationDifferenceOk(-0.01)).toBe(true);
    expect(reconciliationDifferenceOk(0.02)).toBe(false);
  });
});
