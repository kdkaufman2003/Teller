import { describe, expect, it } from "vitest";
import { computeHealthReport, formatHealthGrade } from "./engine";
import type { HealthSignals } from "./types";

const cleanSignals: HealthSignals = {
  draftInvoiceCount: 0,
  overdueInvoiceCount: 0,
  openInvoiceCount: 2,
  draftExpenseCount: 0,
  receiptExpenseWithoutAttachment: 0,
  unmatchedBankCount: 0,
  suggestedBankCount: 0,
  bankConnectionCount: 0,
  bankConnectionErrorCount: 0,
  hfacEnabled: false,
  hfacStaleSync: false,
  hfacLastSyncedAt: null,
  taxPendingReviewCount: 0,
  lastPostedDate: "2026-08-31",
};

describe("computeHealthReport", () => {
  it("scores highly when books are caught up", () => {
    const report = computeHealthReport(cleanSignals);
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.grade).toBe("excellent");
    expect(report.attention).toHaveLength(0);
    expect(report.headline).toContain("2026-08-31");
  });

  it("creates attention items for overdue invoices and bank lines", () => {
    const report = computeHealthReport({
      ...cleanSignals,
      overdueInvoiceCount: 2,
      unmatchedBankCount: 4,
      bankConnectionCount: 1,
    });

    expect(report.score).toBeLessThan(90);
    expect(report.attention.some((item) => item.id === "overdue-invoices")).toBe(true);
    expect(report.attention.some((item) => item.id === "bank-unmatched")).toBe(true);
  });

  it("penalizes stale HFAC sync when integration is enabled", () => {
    const report = computeHealthReport({
      ...cleanSignals,
      hfacEnabled: true,
      hfacStaleSync: true,
      hfacLastSyncedAt: "2026-01-01",
    });

    expect(report.attention.some((item) => item.id === "hfac-stale")).toBe(true);
  });

  it("formats grades for display", () => {
    expect(formatHealthGrade("needs_work")).toBe("Needs work");
  });
});
