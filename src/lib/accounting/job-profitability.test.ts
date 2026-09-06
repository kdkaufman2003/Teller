import { describe, expect, it } from "vitest";
import {
  computeProjectedCost,
  computeProjectedRevenue,
  computeRemainingBudget,
  isEconomicDirectCostLine,
  marginPercent,
  summarizeJournalLinesForJob,
} from "./job-profitability";

const ACCOUNTS = [
  { id: "r1", code: "4100", name: "Service Revenue", type: "revenue" },
  { id: "c1", code: "5200", name: "Subcontractor", type: "cogs" },
  { id: "e1", code: "6100", name: "Materials", type: "expense" },
  { id: "cash", code: "1000", name: "Cash", type: "asset" },
];

describe("job profitability formulas", () => {
  it("computes remaining budget", () => {
    expect(computeRemainingBudget(10000, 4000)).toBe(6000);
    expect(computeRemainingBudget(3000, 5000)).toBe(0);
  });

  it("computes projected cost with budget floor vs committed", () => {
    expect(computeProjectedCost(4000, 6000, 2000)).toBe(10000);
    expect(computeProjectedCost(4000, 1000, 5000)).toBe(9000);
    expect(computeProjectedCost(4000, 0, 2500)).toBe(6500);
  });

  it("prioritizes projected revenue sources", () => {
    expect(
      computeProjectedRevenue({
        revisedContractAmount: 12000,
        estimatedRevenue: 10000,
        recognizedRevenue: 5000,
      }),
    ).toBe(12000);
    expect(
      computeProjectedRevenue({
        revisedContractAmount: null,
        estimatedRevenue: 10000,
        recognizedRevenue: 5000,
      }),
    ).toBe(10000);
    expect(
      computeProjectedRevenue({
        revisedContractAmount: null,
        estimatedRevenue: 0,
        recognizedRevenue: 5000,
      }),
    ).toBe(5000);
  });

  it("excludes settlement-side lines from direct cost", () => {
    expect(isEconomicDirectCostLine("expense", 0, 500, "direct")).toBe(false);
    expect(isEconomicDirectCostLine("expense", 500, 0, "direct")).toBe(true);
    expect(isEconomicDirectCostLine("expense", 500, 0, "indirect")).toBe(false);
  });

  it("summarizes revenue and direct cost from journal lines", () => {
    const summary = summarizeJournalLinesForJob(
      "job-1",
      [
        { account_id: "r1", debit: 0, credit: 5000, job_id: "job-1" },
        { account_id: "c1", debit: 1800, credit: 0, job_id: "job-1", cost_classification: "direct" },
        { account_id: "cash", debit: 0, credit: 1800, job_id: "job-1" },
        { account_id: "e1", debit: 200, credit: 0, job_id: "job-1", cost_classification: "indirect" },
      ],
      ACCOUNTS,
    );
    expect(summary.recognizedRevenue).toBe(5000);
    expect(summary.actualDirectCost).toBe(1800);
    expect(summary.indirectCost).toBe(200);
    expect(marginPercent(3200, 5000)).toBe(64);
  });
});
