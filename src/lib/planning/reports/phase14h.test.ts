import { describe, expect, it } from "vitest";
import { aggregateWeeklyCash } from "@/lib/planning/cash/engine";
import type { CashFlowLine, CashOutlookReport } from "@/lib/planning/cash/types";
import { buildCashHorizonWeeks } from "@/lib/planning/cash/weeks";
import {
  applyCashScenarioOverlay,
  isProjectedCashSource,
  isRealCashObligation,
} from "@/lib/planning/scenarios/cash-overlay";
import { buildScenarioComparison } from "@/lib/planning/scenarios/comparison";
import { applyForecastScenarioOverlay } from "@/lib/planning/scenarios/forecast-overlay";
import type { ScenarioCashResult, ScenarioForecastResult } from "@/lib/planning/scenarios/types";
import {
  validateCashAdjustment,
  validateScenarioDrivers,
} from "@/lib/planning/scenarios/validation";
import { buildRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";

const accounts = [
  { id: "rev", code: "4000", name: "Revenue", type: "revenue", archived: false },
  { id: "cogs", code: "5000", name: "COGS", type: "cogs", archived: false },
  { id: "exp", code: "6000", name: "Expense", type: "expense", archived: false },
];

function sampleForecastReport() {
  const forecastLineMap = new Map<string, number>([
    ["rev::2027-08-01", 8000],
    ["rev::2027-09-01", 10000],
    ["cogs::2027-08-01", 3200],
    ["cogs::2027-09-01", 4000],
    ["exp::2027-08-01", 1200],
    ["exp::2027-09-01", 3000],
  ]);
  const monthlyActuals = new Map<string, Map<string, number>>([
    ["rev", new Map([["2027-08-01", 8000]])],
    ["cogs", new Map([["2027-08-01", 3200]])],
    ["exp", new Map([["2027-08-01", 1200]])],
  ]);

  return buildRollingForecastReport({
    forecast: {
      id: "f1",
      name: "Main",
      anchor_month: "2027-08-01",
      horizon_months: 12,
    },
    version: {
      id: "v1",
      version_number: 1,
      label: "Draft",
      status: "draft",
      is_immutable: false,
    },
    accounts,
    forecastLineMap,
    monthlyActuals,
    useStoredLinesOnly: false,
  });
}

function sampleCashReport(asOfDate = "2027-09-08"): CashOutlookReport {
  const { weeks, horizonStart, horizonEnd } = buildCashHorizonWeeks(asOfDate, 13);
  const lines: CashFlowLine[] = [
    {
      weekIndex: 2,
      periodStart: weeks[1]!.periodStart,
      periodEnd: weeks[1]!.periodEnd,
      flowKind: "inflow",
      category: "ar_collection",
      amount: 5000,
      sourceKind: "invoice_open",
      sourceId: "inv-1",
      label: "INV-1023",
      explanation: "AR",
      metadata: { collectionDate: weeks[1]!.periodStart },
    },
    {
      weekIndex: 3,
      periodStart: weeks[2]!.periodStart,
      periodEnd: weeks[2]!.periodEnd,
      flowKind: "outflow",
      category: "ap_payment",
      amount: 2000,
      sourceKind: "ap_bill",
      sourceId: "bill-1",
      label: "Bill",
      explanation: "AP",
      metadata: { paymentDate: weeks[2]!.periodStart },
    },
    {
      weekIndex: 4,
      periodStart: weeks[3]!.periodStart,
      periodEnd: weeks[3]!.periodEnd,
      flowKind: "outflow",
      category: "payroll",
      amount: 4200,
      sourceKind: "payroll_posted",
      sourceId: "run-1",
      label: "Payroll posted",
      explanation: "Posted payroll",
      metadata: { payDate: weeks[3]!.periodStart },
    },
    {
      weekIndex: 5,
      periodStart: weeks[4]!.periodStart,
      periodEnd: weeks[4]!.periodEnd,
      flowKind: "outflow",
      category: "payroll",
      amount: 4000,
      sourceKind: "payroll_projection",
      sourceId: "proj-1",
      label: "Payroll projected",
      explanation: "Projected payroll",
      metadata: { payDate: weeks[4]!.periodStart },
    },
    {
      weekIndex: 6,
      periodStart: weeks[5]!.periodStart,
      periodEnd: weeks[5]!.periodEnd,
      flowKind: "outflow",
      category: "purchasing",
      amount: 1500,
      sourceKind: "po_line_commitment",
      sourceId: "po-1",
      label: "PO commitment",
      explanation: "PO",
      metadata: {},
    },
    {
      weekIndex: 7,
      periodStart: weeks[6]!.periodStart,
      periodEnd: weeks[6]!.periodEnd,
      flowKind: "outflow",
      category: "purchasing",
      amount: 3000,
      sourceKind: "grni_receipt_line",
      sourceId: "grni-1",
      label: "GRNI",
      explanation: "GRNI",
      metadata: {},
    },
    {
      weekIndex: 8,
      periodStart: weeks[7]!.periodStart,
      periodEnd: weeks[7]!.periodEnd,
      flowKind: "outflow",
      category: "capex",
      amount: 10000,
      sourceKind: "capex_plan",
      sourceId: "capex-1",
      label: "Van",
      explanation: "Capex plan",
      metadata: {},
    },
  ];

  const { weeks: aggregated, beyondHorizon, summary } = aggregateWeeklyCash({
    startingCash: 50000,
    horizonWeeks: weeks,
    flowLines: lines,
  });

  return {
    asOfDate,
    horizonWeeks: 13,
    horizonStart,
    horizonEnd,
    startingCash: { total: 50000, accounts: [], asOfDate },
    weeks: aggregated,
    beyondHorizon,
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

function wrapForecast(base: ReturnType<typeof sampleForecastReport>, scenario: ReturnType<typeof sampleForecastReport>): ScenarioForecastResult {
  return { base, scenario, drivers: [] };
}

function wrapCash(base: CashOutlookReport, scenario: CashOutlookReport): ScenarioCashResult {
  return { base, scenario, drivers: [] };
}

describe("Phase 14H forecast overlay", () => {
  it("base scenario leaves forward forecast unchanged", () => {
    const base = sampleForecastReport();
    const scenario = applyForecastScenarioOverlay(base, []);
    const forwardRev = scenario.accounts
      .find((row) => row.accountId === "rev")
      ?.periods.find((row) => row.periodMonth === "2027-09-01");
    expect(forwardRev?.amount).toBe(10000);
    expect(scenario.summary.revenue.rollingTotal).toBe(base.summary.revenue.rollingTotal);
  });

  it("applies downside revenue percentage to forward periods only", () => {
    const base = sampleForecastReport();
    const scenario = applyForecastScenarioOverlay(base, [{ driverType: "revenue_percentage", valueNumeric: -10 }]);
    const revenue = scenario.accounts.find((row) => row.accountId === "rev")!;
    expect(revenue.ytdActual).toBe(8000);
    const forwardRev = revenue.periods.find((row) => row.periodMonth === "2027-09-01");
    expect(forwardRev?.kind).toBe("forecast");
    expect(forwardRev?.amount).toBe(9000);
  });

  it("applies upside revenue percentage", () => {
    const base = sampleForecastReport();
    const scenario = applyForecastScenarioOverlay(base, [{ driverType: "revenue_percentage", valueNumeric: 10 }]);
    const forwardRev = scenario.accounts
      .find((row) => row.accountId === "rev")
      ?.periods.find((row) => row.periodMonth === "2027-09-01");
    expect(forwardRev?.amount).toBe(11000);
  });

  it("derives COGS from gross margin points after revenue change", () => {
    const base = sampleForecastReport();
    const scenario = applyForecastScenarioOverlay(base, [
      { driverType: "revenue_percentage", valueNumeric: 10 },
      { driverType: "gross_margin_points", valueNumeric: -2 },
    ]);
    const forwardRev = scenario.accounts
      .find((row) => row.accountId === "rev")
      ?.periods.find((row) => row.periodMonth === "2027-09-01")!.amount;
    const forwardCogs = scenario.accounts
      .filter((row) => row.category === "cogs")
      .reduce((sum, row) => sum + (row.periods.find((p) => p.periodMonth === "2027-09-01")?.amount ?? 0), 0);
    expect(forwardRev).toBeDefined();
    const margin = ((forwardRev! - forwardCogs) / forwardRev!) * 100;
    const baseMargin = ((11000 - 4000) / 11000) * 100;
    expect(Math.round(margin * 100) / 100).toBe(Math.round((baseMargin - 2) * 100) / 100);
  });

  it("applies expense percentage to forward expense periods", () => {
    const base = sampleForecastReport();
    const scenario = applyForecastScenarioOverlay(base, [{ driverType: "expense_percentage", valueNumeric: 5 }]);
    const forwardExp = scenario.accounts
      .find((row) => row.accountId === "exp")
      ?.periods.find((row) => row.periodMonth === "2027-09-01");
    expect(forwardExp?.amount).toBe(3150);
  });

  it("recalculation is idempotent", () => {
    const base = sampleForecastReport();
    const drivers = [{ driverType: "revenue_percentage" as const, valueNumeric: 10 }];
    const once = applyForecastScenarioOverlay(base, drivers);
    const twice = applyForecastScenarioOverlay(base, drivers);
    expect(twice.summary.revenue.rollingTotal).toBe(once.summary.revenue.rollingTotal);
    expect(twice.summary.revenue.rollingTotal).toBe(11000);
  });

  it("rejects incompatible cogs and margin drivers", () => {
    expect(() =>
      validateScenarioDrivers([
        { driverType: "cogs_percentage", valueNumeric: 5 },
        { driverType: "gross_margin_points", valueNumeric: -2 },
      ]),
    ).toThrow(/Cannot combine/);
  });
});

describe("Phase 14H cash overlay", () => {
  it("shifts AR collections slower", () => {
    const base = sampleCashReport();
    const arLine = base.weeks.flatMap((week) => week.lines).find((line) => line.category === "ar_collection")!;
    const originalWeek = arLine.weekIndex;
    const scenario = applyCashScenarioOverlay(base, [{ driverType: "ar_days_adjustment", valueNumeric: 10 }]);
    const shifted = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "inv-1")!;
    expect(shifted.weekIndex).not.toBe(originalWeek);
    expect(shifted.metadata?.scenarioDayShift).toBe(10);
  });

  it("shifts AR collections faster", () => {
    const base = sampleCashReport();
    const scenario = applyCashScenarioOverlay(base, [{ driverType: "ar_days_adjustment", valueNumeric: -5 }]);
    const shifted = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "inv-1")!;
    expect(shifted.metadata?.scenarioDayShift).toBe(-5);
  });

  it("shifts AP payment timing without changing amount", () => {
    const base = sampleCashReport();
    const scenario = applyCashScenarioOverlay(base, [{ driverType: "ap_days_adjustment", valueNumeric: 7 }]);
    const ap = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "bill-1")!;
    expect(ap.amount).toBe(2000);
    expect(ap.metadata?.scenarioDayShift).toBe(7);
  });

  it("protects posted payroll from percentage adjustment", () => {
    const base = sampleCashReport();
    const scenario = applyCashScenarioOverlay(base, [{ driverType: "payroll_percentage", valueNumeric: 10 }]);
    const posted = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "run-1")!;
    const projected = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "proj-1")!;
    expect(posted.amount).toBe(4200);
    expect(projected.amount).toBe(4400);
  });

  it("protects GRNI and AP bill from purchasing percentage", () => {
    const base = sampleCashReport();
    const scenario = applyCashScenarioOverlay(base, [{ driverType: "purchasing_percentage", valueNumeric: -15 }]);
    const grni = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "grni-1")!;
    const po = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "po-1")!;
    expect(grni.amount).toBe(3000);
    expect(po.amount).toBe(1275);
  });

  it("adjusts planned capex percentage", () => {
    const base = sampleCashReport();
    const scenario = applyCashScenarioOverlay(base, [{ driverType: "capex_percentage", valueNumeric: -50 }]);
    const capex = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceId === "capex-1")!;
    expect(capex.amount).toBe(5000);
  });

  it("adds scenario-only manual cash adjustment", () => {
    const base = sampleCashReport();
    const scenario = applyCashScenarioOverlay(
      base,
      [],
      [{ effectiveDate: "2027-09-15", flowKind: "outflow", amount: 25000, label: "Emergency repair" }],
    );
    const manual = scenario.weeks.flatMap((week) => week.lines).find((line) => line.sourceKind === "scenario_manual");
    expect(manual?.amount).toBe(25000);
  });

  it("classifies real vs projected sources", () => {
    expect(isRealCashObligation("ap_bill")).toBe(true);
    expect(isRealCashObligation("payroll_projection")).toBe(false);
    expect(isProjectedCashSource("po_line_commitment")).toBe(true);
  });
});

describe("Phase 14H comparison", () => {
  it("computes operating income and ending cash deltas", () => {
    const baseForecast = sampleForecastReport();
    const downsideForecast = applyForecastScenarioOverlay(baseForecast, [
      { driverType: "revenue_percentage", valueNumeric: -10 },
      { driverType: "expense_percentage", valueNumeric: 5 },
    ]);
    const baseCash = sampleCashReport();
    const downsideCash = applyCashScenarioOverlay(baseCash, [{ driverType: "ar_days_adjustment", valueNumeric: 10 }]);

    const comparison = buildScenarioComparison({
      baseScenarioId: "base",
      results: [
        {
          scenarioId: "base",
          scenarioName: "Base Plan",
          scenarioType: "base",
          forecast: wrapForecast(baseForecast, baseForecast),
          cash: wrapCash(baseCash, baseCash),
        },
        {
          scenarioId: "down",
          scenarioName: "Downside",
          scenarioType: "downside",
          forecast: wrapForecast(baseForecast, downsideForecast),
          cash: wrapCash(baseCash, downsideCash),
        },
      ],
    });

    expect(comparison.rows).toHaveLength(2);
    expect(comparison.forecastMetrics[0]!.delta).toBeLessThan(0);
    expect(comparison.cashMetrics[0]!.label).toBe("Ending Cash");
    expect(comparison.forecastMetrics[1]!.label).toBe("Revenue");
  });
});

describe("Phase 14H validation and boundary", () => {
  it("validates cash adjustment inputs", () => {
    expect(() =>
      validateCashAdjustment({
        effectiveDate: "2027-09-01",
        flowKind: "outflow",
        amount: 0,
        label: "x",
      }),
    ).toThrow(/positive/);
  });

  it("preview path uses overlay only — source report clone differs from base when drivers present", () => {
    const base = sampleForecastReport();
    const scenario = applyForecastScenarioOverlay(base, [{ driverType: "revenue_percentage", valueNumeric: 10 }]);
    expect(scenario.summary.revenue.rollingTotal).not.toBe(base.summary.revenue.rollingTotal);
    expect(base.summary.revenue.rollingTotal).toBe(10000);
    expect(base.accounts.find((row) => row.accountId === "rev")!.ytdActual).toBe(8000);
  });
});
