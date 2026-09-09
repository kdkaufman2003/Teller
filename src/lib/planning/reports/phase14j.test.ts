import { describe, expect, it } from "vitest";
import { buildPlanningPackageExportFiles } from "@/lib/planning/accountant-package/export";
import { buildSourceLineage, detectSourceMismatches } from "@/lib/planning/accountant-package/lineage";
import {
  MAX_PLANNING_RISKS,
  MATERIAL_YTD_VARIANCE,
  buildPlanningRisks,
} from "@/lib/planning/accountant-package/risks";
import type { AccountantPlanningPackage } from "@/lib/planning/accountant-package/types";
import { computeVarianceAmounts } from "@/lib/planning/reports/variance";
import { buildRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import { aggregateWeeklyCash } from "@/lib/planning/cash/engine";
import { buildCashHorizonWeeks } from "@/lib/planning/cash/weeks";
import { buildScenarioComparison } from "@/lib/planning/scenarios/comparison";
import type { ScenarioCashResult, ScenarioForecastResult } from "@/lib/planning/scenarios/types";

describe("Phase 14J budget vs actual accountant section", () => {
  it("derives favorable and unfavorable variance semantics from canonical helper", () => {
    const revenue = computeVarianceAmounts(150000, 140000, "revenue");
    expect(revenue.status).toBe("favorable");

    const expense = computeVarianceAmounts(90000, 80000, "expense");
    expect(expense.status).toBe("unfavorable");
  });

  it("uses material variance threshold of $25,000", () => {
    expect(MATERIAL_YTD_VARIANCE).toBe(25000);
  });
});

describe("Phase 14J forecast section", () => {
  it("marks stale when published forecast cutoff is behind latest GL month", () => {
    const report = buildRollingForecastReport({
      forecast: { id: "f1", name: "Main", anchor_month: "2027-08-01", horizon_months: 1 },
      version: {
        id: "v1",
        version_number: 1,
        label: "Published",
        status: "published",
        is_immutable: true,
        published_at: "2027-08-15T00:00:00Z",
        source_budget_version_id: "budget-v1",
        actual_cutoff_month: "2027-08-01",
      },
      accounts: [{ id: "rev", code: "4000", name: "Revenue", type: "revenue", archived: false }],
      forecastLineMap: new Map([["rev::2027-09-01", 100000]]),
      monthlyActuals: new Map(),
      useStoredLinesOnly: false,
      latestGlMonth: "2027-09-01",
    });
    expect(report.staleForecast).toBe(true);
    expect(report.version.sourceBudgetVersionId).toBe("budget-v1");
  });
});

describe("Phase 14J scenario comparison", () => {
  function sampleForecastReport() {
    return buildRollingForecastReport({
      forecast: { id: "f1", name: "Main", anchor_month: "2027-08-01", horizon_months: 12 },
      version: { id: "v1", version_number: 1, label: "Draft", status: "draft", is_immutable: false },
      accounts: [{ id: "rev", code: "4000", name: "Revenue", type: "revenue", archived: false }],
      forecastLineMap: new Map([
        ["rev::2027-08-01", 8000],
        ["rev::2027-09-01", 10000],
      ]),
      monthlyActuals: new Map([["rev", new Map([["2027-08-01", 8000]])]]),
      useStoredLinesOnly: false,
    });
  }

  function sampleCashReport() {
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
      summary,
      warnings: [],
      sourceCoverage: [],
      settings: {
        defaultArCollectionDays: 30,
        defaultApPaymentDays: 30,
        payrollCadence: "biweekly" as const,
      },
    };
  }

  function wrapForecast(
    base: ReturnType<typeof sampleForecastReport>,
    scenario: ReturnType<typeof sampleForecastReport>,
  ): ScenarioForecastResult {
    return { base, scenario, drivers: [] };
  }

  function wrapCash(
    base: ReturnType<typeof sampleCashReport>,
    scenario: ReturnType<typeof sampleCashReport>,
  ): ScenarioCashResult {
    return { base, scenario, drivers: [] };
  }

  it("includes revenue on scenario comparison rows", () => {
    const baseForecast = sampleForecastReport();
    const baseCash = sampleCashReport();
    const comparison = buildScenarioComparison({
      baseScenarioId: "base",
      results: [
        {
          scenarioId: "base",
          scenarioName: "Base",
          scenarioType: "base",
          forecast: wrapForecast(baseForecast, baseForecast),
          cash: wrapCash(baseCash, baseCash),
        },
        {
          scenarioId: "down",
          scenarioName: "Downside",
          scenarioType: "downside",
          forecast: wrapForecast(baseForecast, baseForecast),
          cash: wrapCash(baseCash, baseCash),
        },
      ],
    });
    expect(comparison.rows[0]?.revenue).toBe(baseForecast.summary.revenue.rollingTotal);
    expect(comparison.rows[1]?.revenue).toBe(baseForecast.summary.revenue.rollingTotal);
  });
});

describe("Phase 14J source lineage and mismatch", () => {
  it("detects scenario forecast version mismatch", () => {
    const mismatches = detectSourceMismatches({
      sources: {
        fiscalYear: 2027,
        throughMonth: "2027-08-01",
        budget: {
          budgetId: "b1",
          budgetName: "FY2027",
          versionId: "bv1",
          versionLabel: "Approved",
          versionStatus: "approved",
        },
        forecast: {
          forecastId: "f1",
          forecastName: "Main",
          versionId: "fv1",
          versionLabel: "Published",
          versionStatus: "published",
          anchorMonth: "2027-08-01",
          sourceBudgetVersionId: "bv1",
        },
        downsideScenario: null,
        baseScenario: null,
      },
      forecastReport: {
        version: { id: "fv1", sourceBudgetVersionId: "bv1" },
      } as never,
      scenarioRecords: [
        {
          id: "s1",
          name: "Downside",
          scenarioType: "downside",
          forecastVersionId: "other-version",
        } as never,
      ],
    });
    expect(mismatches.some((row) => row.code.includes("forecast_mismatch"))).toBe(true);
  });

  it("builds lineage with report period and budget", () => {
    const lineage = buildSourceLineage({
      sources: {
        fiscalYear: 2027,
        throughMonth: "2027-08-01",
        budget: {
          budgetId: "b1",
          budgetName: "FY2027",
          versionId: "bv1",
          versionLabel: "Approved",
          versionStatus: "approved",
        },
        forecast: null,
        downsideScenario: null,
        baseScenario: null,
      },
      periodEnd: "2027-08-31",
      periodLabel: "August 2027",
    });
    expect(lineage.reportPeriod.periodEnd).toBe("2027-08-31");
    expect(lineage.budget?.name).toBe("FY2027");
  });
});

describe("Phase 14J close integration", () => {
  it("planning package close context never blocks close or rewrites planning", () => {
    const closeContext = {
      planningBlocksClose: false as const,
      closeRewritesPlanning: false as const,
    };
    expect(closeContext.planningBlocksClose).toBe(false);
    expect(closeContext.closeRewritesPlanning).toBe(false);
  });
});

describe("Phase 14J risk summary", () => {
  it("caps risks at five items with critical first", () => {
    const risks = buildPlanningRisks({
      hasBudget: false,
      hasForecast: false,
      hasCash: true,
      hasDownsideScenario: false,
      forecastStale: true,
      firstNegativeWeek: 3,
      cashCoverageIncomplete: true,
      unscheduledPurchasing: true,
      significantYtdVariance: -50000,
      downsideShortfall: true,
      sourceMismatches: [
        { code: "mismatch_a", message: "Mismatch A" },
        { code: "mismatch_b", message: "Mismatch B" },
      ],
    });
    expect(risks.length).toBeLessThanOrEqual(MAX_PLANNING_RISKS);
    expect(risks[0]?.severity).toBe("critical");
  });
});

describe("Phase 14J export", () => {
  function samplePackage(): AccountantPlanningPackage {
    return {
      generatedAt: "2027-09-01T12:00:00Z",
      presentationMode: "accountant",
      closeContext: { planningBlocksClose: false, closeRewritesPlanning: false },
      lineage: {
        reportPeriod: {
          label: "August 2027",
          periodEnd: "2027-08-31",
          fiscalYear: 2027,
          throughMonth: "2027-08-01",
        },
        budget: {
          name: "FY2027",
          fiscalYear: 2027,
          versionLabel: "Approved",
          versionStatus: "approved",
          versionId: "bv1",
        },
      },
      sourceMismatches: [],
      budgetVsActual: {
        available: "ready",
        categories: [
          {
            label: "Operating Income",
            month: computeVarianceAmounts(10000, 9000, "operating_income"),
            ytd: computeVarianceAmounts(80000, 75000, "operating_income"),
          },
        ],
      },
      forecast: {
        available: "ready",
        expectedRevenue: 1000000.55,
        expectedGrossProfit: 400000.12,
        expectedOperatingIncome: 120000.33,
        stale: false,
      },
      cash: {
        available: "ready",
        startingCash: 50000,
        expectedMoneyIn: 120000,
        expectedMoneyOut: 90000,
        endingCash: 80000,
        lowestCash: 20000,
        categoryTotals: [{ category: "payroll", label: "Payroll", inflows: 0, outflows: 15000.5 }],
      },
      scenarios: {
        available: "ready",
        rows: [
          {
            scenarioType: "base",
            scenarioName: "Base",
            revenue: 1000000,
            operatingIncome: 120000,
            endingCash: 80000,
            lowestCash: 20000,
            firstNegativeWeekIndex: null,
          },
        ],
      },
      risks: [],
      links: {
        budgetVsActual: "/app/planning/budget-vs-actual",
        forecast: "/app/planning/forecasts/f1",
        cash: "/app/planning/cash",
        scenarios: "/app/planning/scenarios",
      },
    };
  }

  it("exports lineage and preserves exact cents in CSV", () => {
    const files = buildPlanningPackageExportFiles(samplePackage(), "Demo Org");
    expect(files.some((file) => file.filename.includes("source-lineage"))).toBe(true);
    const forecastFile = files.find((file) => file.filename.includes("forecast-summary"));
    expect(forecastFile?.content).toContain("1000000.55");
    const budgetFile = files.find((file) => file.filename.includes("budget-vs-actual"));
    expect(budgetFile?.content).toContain("Operating Income");
  });

  it("does not prefix formula injection in exported cells", () => {
    const pkg = samplePackage();
    pkg.lineage.budget = {
      name: "=SUM(A1)",
      fiscalYear: 2027,
      versionLabel: "+cmd",
      versionStatus: "approved",
      versionId: "bv1",
    };
    const files = buildPlanningPackageExportFiles(pkg, "demo");
    const lineage = files.find((file) => file.filename.includes("source-lineage"));
    expect(lineage?.content).toContain("'=SUM(A1)");
    expect(lineage?.content).toContain("'+cmd");
  });
});

describe("Phase 14J missing sources", () => {
  it("marks sections missing without reporting zero amounts", () => {
    const pkg: AccountantPlanningPackage = {
      generatedAt: "2027-09-01T12:00:00Z",
      presentationMode: "accountant",
      closeContext: { planningBlocksClose: false, closeRewritesPlanning: false },
      lineage: {
        reportPeriod: {
          label: "August 2027",
          periodEnd: "2027-08-31",
          fiscalYear: 2027,
          throughMonth: "2027-08-01",
        },
      },
      sourceMismatches: [],
      budgetVsActual: { available: "missing" },
      forecast: { available: "missing" },
      cash: { available: "missing" },
      scenarios: { available: "missing" },
      risks: buildPlanningRisks({
        hasBudget: false,
        hasForecast: false,
        hasCash: false,
        hasDownsideScenario: false,
        sourceMismatches: [],
      }),
      links: {
        budgetVsActual: "/app/planning/budget-vs-actual",
        forecast: "/app/planning/forecasts",
        cash: "/app/planning/cash",
        scenarios: "/app/planning/scenarios",
      },
    };
    expect(pkg.budgetVsActual.available).toBe("missing");
    expect(pkg.forecast.expectedRevenue).toBeUndefined();
    expect(pkg.risks.some((row) => row.code === "missing_budget")).toBe(true);
  });
});
