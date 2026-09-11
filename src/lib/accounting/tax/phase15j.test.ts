import { describe, expect, it } from "vitest";
import { roundMoney } from "../payment-fees";
import { buildTaxAttentionItems } from "./owner/attention";
import { selectNextFilingPeriod } from "./owner/next-period";
import { aggregateTaxOwedFromPeriods, filingPeriodStatusLabel } from "./owner";
import type { TaxOwnerPeriodSummary } from "./owner/types";

function period(overrides: Partial<TaxOwnerPeriodSummary>): TaxOwnerPeriodSummary {
  return {
    id: overrides.id ?? "p1",
    periodStart: overrides.periodStart ?? "2026-06-01",
    periodEnd: overrides.periodEnd ?? "2026-06-30",
    status: overrides.status ?? "open",
    statusLabel: overrides.statusLabel ?? "Open",
    jurisdictionKey: overrides.jurisdictionKey ?? "US-KS",
    state: overrides.state ?? "KS",
    authorityName: overrides.authorityName ?? "Kansas DOR",
    registrationId: overrides.registrationId ?? "reg-1",
    taxOwed: overrides.taxOwed ?? 0,
    taxPaid: overrides.taxPaid ?? 0,
    remaining: overrides.remaining ?? 0,
    dueDate: overrides.dueDate ?? null,
    dueDateConfigured: overrides.dueDateConfigured ?? false,
    exceptionCount: overrides.exceptionCount ?? 0,
    glDifference: overrides.glDifference ?? null,
  };
}

describe("Phase 15J owner tax overview", () => {
  it("maps filing period statuses to readable labels", () => {
    expect(filingPeriodStatusLabel("ready_for_review")).toBe("Ready for review");
    expect(filingPeriodStatusLabel("filed")).toBe("Filed");
    expect(filingPeriodStatusLabel("needs_review")).toBe("Needs review");
  });

  it("selects filed unpaid period before future open period", () => {
    const next = selectNextFilingPeriod(
      [
        period({ id: "future", periodStart: "2026-07-01", periodEnd: "2026-07-31", status: "open", remaining: 0 }),
        period({
          id: "unpaid",
          status: "filed",
          taxOwed: 4000,
          taxPaid: 2500,
          remaining: 1500,
        }),
      ],
      "2026-06-30",
    );
    expect(next?.id).toBe("unpaid");
  });

  it("selects ready_for_review period when no unpaid balance", () => {
    const next = selectNextFilingPeriod(
      [
        period({ id: "closed", status: "closed", remaining: 0 }),
        period({ id: "review", status: "ready_for_review", remaining: 0, periodEnd: "2026-06-30" }),
        period({ id: "future", status: "open", periodEnd: "2026-07-31", remaining: 0 }),
      ],
      "2026-06-30",
    );
    expect(next?.id).toBe("review");
  });

  it("aggregates tax owed from period remaining balances only", () => {
    const owed = aggregateTaxOwedFromPeriods([
      period({ remaining: 1500 }),
      period({ id: "p2", remaining: 0 }),
      period({ id: "p3", remaining: 250 }),
    ]);
    expect(owed).toBe(1750);
  });

  it("builds attention items for incomplete setup and needs-review transactions", () => {
    const items = buildTaxAttentionItems({
      readinessChecks: [
        { key: "registration", label: "Registration", ownerLabel: "Where You Collect Tax", passed: false },
      ],
      setupConfigured: false,
      needsReviewTransactionCount: 3,
      periods: [],
      expiredExemptionCount: 0,
      rejectedExemptionCount: 0,
    });
    expect(items.some((item) => item.id === "setup-incomplete")).toBe(true);
    expect(items.some((item) => item.title.includes("3 transactions"))).toBe(true);
  });

  it("builds attention for filed period with remaining balance", () => {
    const items = buildTaxAttentionItems({
      readinessChecks: [{ key: "registration", label: "Registration", ownerLabel: "Registration", passed: true }],
      setupConfigured: true,
      needsReviewTransactionCount: 0,
      periods: [period({ id: "filed-unpaid", status: "filed", remaining: 1500, state: "KS" })],
      expiredExemptionCount: 0,
      rejectedExemptionCount: 0,
    });
    expect(items.some((item) => item.id === "period-unpaid-filed-unpaid")).toBe(true);
    expect(items[0]?.severity).toBe("critical");
  });

  it("preserves filed vs paid distinction in period amounts", () => {
    const filedUnpaid = period({ status: "filed", taxOwed: 4000, taxPaid: 2500, remaining: 1500 });
    expect(filedUnpaid.status).toBe("filed");
    expect(filedUnpaid.remaining).toBeGreaterThan(0);
    expect(filedUnpaid.taxPaid).toBeLessThan(filedUnpaid.taxOwed);
  });

  it("reconciles owner owed aggregate to period remainings", () => {
    const periods = [
      period({ remaining: 100 }),
      period({ id: "p2", remaining: 50.25 }),
    ];
    const owed = aggregateTaxOwedFromPeriods(periods);
    const expected = roundMoney(periods.reduce((sum, row) => sum + row.remaining, 0));
    expect(owed).toBe(expected);
  });

  it("owner summary does not expose accountant detail by default in types", () => {
    const ownerPeriod = period({});
    expect(ownerPeriod.glDifference).toBeNull();
    expect(ownerPeriod.exceptionCount).toBe(0);
  });

  it("does not infer due dates when not configured", () => {
    const next = period({ dueDateConfigured: false, dueDate: null });
    expect(next.dueDateConfigured).toBe(false);
    expect(next.dueDate).toBeNull();
  });

  it("handles zero-liability period without treating as missing data", () => {
    const zero = period({ status: "filed", taxOwed: 0, taxPaid: 0, remaining: 0 });
    expect(aggregateTaxOwedFromPeriods([zero])).toBe(0);
  });
});
