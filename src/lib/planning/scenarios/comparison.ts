import { roundMoney } from "@/lib/accounting/payment-fees";
import { variancePercent } from "@/lib/planning/reports/variance";
import type { ScenarioCashResult, ScenarioComparisonReport, ScenarioForecastResult } from "./types";

export function buildScenarioComparison(input: {
  baseScenarioId: string | null;
  results: Array<{
    scenarioId: string;
    scenarioName: string;
    scenarioType: ScenarioComparisonReport["rows"][number]["scenarioType"];
    forecast: ScenarioForecastResult;
    cash: ScenarioCashResult;
  }>;
}): ScenarioComparisonReport {
  const baseRow =
    input.results.find((row) => row.scenarioId === input.baseScenarioId) ?? input.results[0];

  const rows = input.results.map((row) => ({
    scenarioId: row.scenarioId,
    scenarioName: row.scenarioName,
    scenarioType: row.scenarioType,
    revenue: row.forecast.scenario.summary.revenue.rollingTotal,
    operatingIncome: row.forecast.scenario.summary.operatingIncome.rollingTotal,
    endingCash: row.cash.scenario.summary.endingCash,
    lowestCash: row.cash.scenario.summary.lowestCash,
    firstNegativeWeekIndex: row.cash.scenario.summary.firstNegativeWeekIndex,
    runwayWeeks: row.cash.scenario.summary.runwayWeeks,
  }));

  const baseOperating = baseRow?.forecast.scenario.summary.operatingIncome.rollingTotal ?? 0;
  const baseEndingCash = baseRow?.cash.scenario.summary.endingCash ?? 0;
  const baseLowest = baseRow?.cash.scenario.summary.lowestCash ?? 0;

  const compareScenario = input.results.find((row) => row.scenarioId !== baseRow?.scenarioId) ?? baseRow;
  const scenarioOperating = compareScenario?.forecast.scenario.summary.operatingIncome.rollingTotal ?? 0;
  const scenarioEndingCash = compareScenario?.cash.scenario.summary.endingCash ?? 0;
  const scenarioLowest = compareScenario?.cash.scenario.summary.lowestCash ?? 0;

  const forecastMetrics = [
    {
      label: "Operating Income",
      base: baseOperating,
      scenario: scenarioOperating,
      delta: roundMoney(scenarioOperating - baseOperating),
      deltaPercent: variancePercent(scenarioOperating, baseOperating),
    },
    {
      label: "Revenue",
      base: baseRow?.forecast.scenario.summary.revenue.rollingTotal ?? 0,
      scenario: compareScenario?.forecast.scenario.summary.revenue.rollingTotal ?? 0,
      delta: roundMoney(
        (compareScenario?.forecast.scenario.summary.revenue.rollingTotal ?? 0) -
          (baseRow?.forecast.scenario.summary.revenue.rollingTotal ?? 0),
      ),
      deltaPercent: variancePercent(
        compareScenario?.forecast.scenario.summary.revenue.rollingTotal ?? 0,
        baseRow?.forecast.scenario.summary.revenue.rollingTotal ?? 0,
      ),
    },
  ];

  const cashMetrics = [
    {
      label: "Ending Cash",
      base: baseEndingCash,
      scenario: scenarioEndingCash,
      delta: roundMoney(scenarioEndingCash - baseEndingCash),
      deltaPercent: variancePercent(scenarioEndingCash, baseEndingCash),
    },
    {
      label: "Lowest Cash",
      base: baseLowest,
      scenario: scenarioLowest,
      delta: roundMoney(scenarioLowest - baseLowest),
      deltaPercent: variancePercent(scenarioLowest, baseLowest),
    },
  ];

  const deltaExplanation = buildDeltaExplanation(
    input.results.find((row) => row.scenarioId === baseRow?.scenarioId),
    compareScenario,
  );

  const warnings: ScenarioComparisonReport["warnings"] = [];
  for (const row of rows) {
    if (row.firstNegativeWeekIndex != null) {
      warnings.push({
        code: "negative_cash",
        message: `${row.scenarioName}: projected cash shortfall in Week ${row.firstNegativeWeekIndex}.`,
        severity: "warn",
      });
    }
  }

  return {
    baseScenarioId: input.baseScenarioId,
    rows,
    forecastMetrics,
    cashMetrics,
    deltaExplanation,
    warnings,
  };
}

function buildDeltaExplanation(
  base:
    | {
        forecast: ScenarioForecastResult;
        cash: ScenarioCashResult;
      }
    | undefined,
  scenario:
    | {
        forecast: ScenarioForecastResult;
        cash: ScenarioCashResult;
      }
    | undefined,
): Array<{ label: string; amount: number }> {
  if (!base || !scenario) return [];

  const endingDelta = roundMoney(
    scenario.cash.scenario.summary.endingCash - base.cash.scenario.summary.endingCash,
  );
  if (Math.abs(endingDelta) < 0.01) return [];

  const revenueDelta = roundMoney(
    scenario.forecast.scenario.summary.revenue.rollingTotal -
      base.forecast.scenario.summary.revenue.rollingTotal,
  );
  const payrollDelta = roundMoney(
    sumCategory(scenario.cash.scenario, "payroll") - sumCategory(base.cash.scenario, "payroll"),
  );
  const capexDelta = roundMoney(
    sumCategory(scenario.cash.scenario, "capex") - sumCategory(base.cash.scenario, "capex"),
  );

  const items = [
    { label: "Revenue (forecast)", amount: revenueDelta },
    { label: "Payroll (cash)", amount: payrollDelta },
    { label: "Planned capex", amount: capexDelta },
  ].filter((row) => Math.abs(row.amount) >= 0.01);

  return items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5);
}

function sumCategory(report: ScenarioCashResult["base"], category: string): number {
  return roundMoney(
    report.weeks.flatMap((week) => week.lines).filter((line) => line.category === category)
      .reduce((sum, line) => sum + line.amount, 0),
  );
}
