import { describe, expect, it } from "vitest";
import { aggregateWeeklyCash } from "@/lib/planning/cash/engine";
import type { CashOutlookReport } from "@/lib/planning/cash/types";
import { buildCashHorizonWeeks } from "@/lib/planning/cash/weeks";
import { MAX_ATTENTION_ITEMS, buildAttentionItems } from "@/lib/planning/dashboard/attention";
import {
  selectForecastFromList,
  selectForecastVersion,
} from "@/lib/planning/dashboard/source-selection";
import { computeVarianceAmounts } from "@/lib/planning/reports/variance";
import { buildRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";

describe("Phase 14I source selection", () => {
  it("prefers published forecast version over draft", () => {
    const version = selectForecastVersion([
      { id: "draft", version_number: 2, label: "Draft", status: "draft" },
      { id: "pub", version_number: 1, label: "Published", status: "published", published_at: "2027-08-01T00:00:00Z" },
    ]);
    expect(version?.id).toBe("pub");
  });

  it("falls back to draft when no published version", () => {
    const version = selectForecastVersion([
      { id: "draft", version_number: 2, label: "Draft", status: "draft" },
    ]);
    expect(version?.id).toBe("draft");
  });

  it("selects forecast with published version from list", () => {
    const selected = selectForecastFromList([
      {
        id: "f1",
        name: "Main",
        anchor_month: "2027-08-01",
        teller_forecast_versions: [
          { id: "v2", version_number: 2, label: "Draft", status: "draft" },
        ],
      },
      {
        id: "f2",
        name: "Published forecast",
        anchor_month: "2027-08-01",
        teller_forecast_versions: [
          { id: "v1", version_number: 1, label: "Published", status: "published", published_at: "2027-09-01T00:00:00Z" },
        ],
      },
    ]);
    expect(selected?.forecastId).toBe("f2");
    expect(selected?.versionStatus).toBe("published");
  });

  it("returns null when no forecast versions exist", () => {
    expect(selectForecastFromList([{ id: "f1", name: "Empty", anchor_month: "2027-01-01" }])).toBeNull();
  });
});

describe("Phase 14I attention", () => {
  function sampleCashReport(firstNegativeWeekIndex: number | null = null): CashOutlookReport {
    const { weeks, horizonStart, horizonEnd } = buildCashHorizonWeeks("2027-09-08", 13);
    const { weeks: aggregated, summary } = aggregateWeeklyCash({
      startingCash: 50000,
      horizonWeeks: weeks,
      flowLines: [],
    });
    return {
      asOfDate: "2027-09-08",
      horizonWeeks: 13,
      horizonStart,
      horizonEnd,
      startingCash: { total: 50000, accounts: [], asOfDate: "2027-09-08" },
      weeks: aggregated,
      beyondHorizon: [],
      unscheduledPurchasing: [],
      summary: {
        ...summary,
        firstNegativeWeekIndex,
        firstNegativeWeekLabel: firstNegativeWeekIndex ? "Week 7" : null,
      },
      warnings: [],
      sourceCoverage: [
        { key: "payroll", label: "Payroll", included: true, count: 0 },
      ],
      settings: { defaultArCollectionDays: 30, defaultApPaymentDays: 30, payrollCadence: "biweekly" },
    };
  }

  it("surfaces critical negative cash first", () => {
    const items = buildAttentionItems({
      hasBudget: true,
      hasForecast: true,
      hasCash: true,
      hasDownsideScenario: false,
      cashReport: sampleCashReport(7),
    });
    expect(items[0]?.severity).toBe("critical");
    expect(items[0]?.code).toBe("negative_cash");
  });

  it("includes info for missing downside scenario", () => {
    const items = buildAttentionItems({
      hasBudget: true,
      hasForecast: true,
      hasCash: true,
      hasDownsideScenario: false,
      cashReport: sampleCashReport(null),
    });
    expect(items.some((row) => row.code === "missing_downside" && row.severity === "info")).toBe(true);
  });

  it("limits attention items to five", () => {
    const items = buildAttentionItems({
      hasBudget: false,
      hasForecast: false,
      hasCash: true,
      hasDownsideScenario: false,
      forecastStale: true,
      cashReport: sampleCashReport(5),
    });
    expect(items.length).toBeLessThanOrEqual(MAX_ATTENTION_ITEMS);
  });

  it("warns when budget and forecast missing for new org", () => {
    const items = buildAttentionItems({
      hasBudget: false,
      hasForecast: false,
      hasCash: false,
      hasDownsideScenario: false,
    });
    expect(items.some((row) => row.code === "missing_budget")).toBe(true);
    expect(items.some((row) => row.code === "missing_forecast")).toBe(true);
  });
});

describe("Phase 14I card metrics reuse", () => {
  it("derives vs plan ahead/behind from canonical variance helper", () => {
    const favorable = computeVarianceAmounts(150000, 140000, "revenue");
    expect(favorable.status).toBe("favorable");
    expect(favorable.varianceAmount).toBe(10000);

    const unfavorable = computeVarianceAmounts(120000, 140000, "revenue");
    expect(unfavorable.status).toBe("unfavorable");
  });

  it("uses rolling forecast summary for expected revenue card values", () => {
    const report = buildRollingForecastReport({
      forecast: { id: "f1", name: "Main", anchor_month: "2027-08-01", horizon_months: 1 },
      version: { id: "v1", version_number: 1, label: "Draft", status: "draft", is_immutable: false },
      accounts: [{ id: "rev", code: "4000", name: "Revenue", type: "revenue", archived: false }],
      forecastLineMap: new Map([["rev::2027-09-01", 2480000]]),
      monthlyActuals: new Map(),
      budgetLineMap: new Map([["rev::2027-09-01", 2360000]]),
      useStoredLinesOnly: false,
    });
    const revenueRollup = report.categories.find((row) => row.category === "revenue");
    expect(report.summary.revenue.rollingTotal).toBe(2480000);
    expect(revenueRollup?.forecastVsBudget?.varianceAmount).toBe(120000);
  });
});
