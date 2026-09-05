import { describe, expect, it } from "vitest";
import { buildFinancialNarrative, buildIntelligenceReport, buildScanSuggestions } from "./engine";
import type { IntelligenceContext } from "./types";

const BASE_CONTEXT: IntelligenceContext = {
  netIncome: 4200,
  totalRevenue: 12000,
  openAR: 3500,
  openAP: 900,
  collected: 8500,
  periodLabel: "March 2026",
  closedThrough: "2026-02-28",
  journalEntries: [],
  expenses: [],
  bankTransactions: [],
  expenseAccounts: [
    { id: "fuel", code: "6100", name: "Fuel" },
    { id: "other", code: "6900", name: "Other" },
  ],
  monthlyRevenue: [{ month: "2026-03", amount: 12000 }],
};

describe("buildFinancialNarrative", () => {
  it("summarizes revenue, receivables, and close status", () => {
    const narrative = buildFinancialNarrative(BASE_CONTEXT);
    expect(narrative[0]).toContain("$12,000.00");
    expect(narrative.some((line) => line.includes("awaiting payment"))).toBe(true);
    expect(narrative.some((line) => line.includes("closed through"))).toBe(true);
  });
});

describe("buildScanSuggestions", () => {
  it("creates categorization hints for unmatched bank lines", () => {
    const suggestions = buildScanSuggestions({
      ...BASE_CONTEXT,
      bankTransactions: [
        {
          id: "bank-1",
          posted_date: "2026-03-05",
          amount: 45.2,
          name: "Shell Oil #1234",
          merchant_name: "Shell",
          match_status: "unmatched",
        },
      ],
    });

    expect(suggestions.some((row) => row.kind === "categorization")).toBe(true);
  });
});

describe("buildIntelligenceReport", () => {
  it("returns narrative, insights, and pending suggestions", () => {
    const report = buildIntelligenceReport({
      context: BASE_CONTEXT,
      persistedSuggestions: [
        {
          kind: "anomaly",
          fingerprint: "anomaly:test",
          title: "Review entry",
          description: "Check this entry",
        },
      ],
      aiEnabled: false,
    });

    expect(report.narrative.length).toBeGreaterThan(0);
    expect(report.pendingCount).toBe(1);
    expect(report.aiEnabled).toBe(false);
  });
});
