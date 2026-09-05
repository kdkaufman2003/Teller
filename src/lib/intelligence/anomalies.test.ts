import { describe, expect, it } from "vitest";
import {
  detectDuplicateAmounts,
  detectExpenseSpike,
  detectLargeJournalEntries,
} from "./anomalies";

describe("detectLargeJournalEntries", () => {
  it("flags entries above threshold", () => {
    const findings = detectLargeJournalEntries(
      [{ id: "je-1", entry_date: "2026-03-01", memo: "Equipment", totalDebit: 12000 }],
      10000,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Large journal entry");
  });
});

describe("detectDuplicateAmounts", () => {
  it("flags same-day duplicate totals", () => {
    const findings = detectDuplicateAmounts([
      { id: "a", entry_date: "2026-03-01", memo: "Fuel", totalDebit: 150 },
      { id: "b", entry_date: "2026-03-01", memo: "Fuel duplicate?", totalDebit: 150 },
    ]);
    expect(findings).toHaveLength(1);
  });
});

describe("detectExpenseSpike", () => {
  it("detects a month-over-month spike", () => {
    const finding = detectExpenseSpike([
      { month: "2026-01", amount: 1000 },
      { month: "2026-02", amount: 1100 },
      { month: "2026-03", amount: 2500 },
    ]);
    expect(finding?.title).toBe("Expense spike this month");
  });
});
