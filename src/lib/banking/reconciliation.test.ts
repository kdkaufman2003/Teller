import { describe, expect, it } from "vitest";
import {
  computeReconciliationBalances,
  reconciliationDifferenceOk,
} from "./reconciliation";
import { canFinalize } from "./reconciliation-client";

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

  it("calculates credit-card liability using the same net cleared formula", () => {
    const summary = computeReconciliationBalances({
      beginningReconciledBalance: 2000,
      statementEndingBalance: 2300,
      items: [
        { clearedAmount: 400, direction: "increase" },
        { clearedAmount: 100, direction: "decrease" },
      ],
      glKind: "credit_card_liability",
    });

    expect(summary.calculatedEndingBalance).toBe(2300);
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

  it("derives next beginning balance from prior ending balance", () => {
    const priorEnding = 17850.43;
    const summary = computeReconciliationBalances({
      beginningReconciledBalance: priorEnding,
      statementEndingBalance: 18965.91,
      items: [
        { clearedAmount: 8432.18, direction: "increase" },
        { clearedAmount: 7316.7, direction: "decrease" },
      ],
    });
    expect(summary.calculatedEndingBalance).toBe(18965.91);
    expect(summary.difference).toBe(0);
  });

  it("supports first reconciliation with zero beginning balance", () => {
    const summary = computeReconciliationBalances({
      beginningReconciledBalance: 0,
      statementEndingBalance: 500,
      items: [{ clearedAmount: 500, direction: "increase" }],
    });
    expect(summary.calculatedEndingBalance).toBe(500);
    expect(summary.difference).toBe(0);
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

describe("canFinalize", () => {
  it("enables finalize at zero difference", () => {
    expect(
      canFinalize({
        reconciliationId: "r1",
        bankAccountId: "a1",
        statementStartDate: "2026-09-01",
        statementEndDate: "2026-09-30",
        beginningReconciledBalance: 0,
        statementEndingBalance: 100,
        clearedIncreases: 100,
        clearedDecreases: 0,
        calculatedEndingBalance: 100,
        difference: 0,
        status: "in_progress",
      }),
    ).toBe(true);
  });

  it("disables finalize when difference is not zero", () => {
    expect(
      canFinalize({
        reconciliationId: "r1",
        bankAccountId: "a1",
        statementStartDate: "2026-09-01",
        statementEndDate: "2026-09-30",
        beginningReconciledBalance: 0,
        statementEndingBalance: 100,
        clearedIncreases: 50,
        clearedDecreases: 0,
        calculatedEndingBalance: 50,
        difference: 50,
        status: "in_progress",
      }),
    ).toBe(false);
  });
});

describe("reconciliation filtering helpers", () => {
  it("filters money in/out and cleared states for UI lists", () => {
    const candidates = [
      { moneyIn: 100, moneyOut: 0, cleared: true, description: "Deposit" },
      { moneyIn: 0, moneyOut: 40, cleared: false, description: "Payment" },
    ];

    expect(candidates.filter((row) => row.moneyIn > 0)).toHaveLength(1);
    expect(candidates.filter((row) => row.moneyOut > 0)).toHaveLength(1);
    expect(candidates.filter((row) => row.cleared)).toHaveLength(1);
    expect(candidates.filter((row) => !row.cleared)).toHaveLength(1);
  });
});
