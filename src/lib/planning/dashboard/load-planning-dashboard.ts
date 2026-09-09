import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { loadCashOutlookReport } from "@/lib/planning/cash/load-cash-outlook";
import { loadPlanningAccountsForForecast } from "@/lib/planning/forecasts/forecast-crud";
import { loadBudgetVsActualReport } from "@/lib/planning/reports/budget-vs-actual";
import { loadRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import type { VarianceAmounts } from "@/lib/planning/reports/variance";
import { loadScenarioResults } from "@/lib/planning/scenarios/load-scenario-report";
import { routes } from "@/lib/routes";
import { buildAttentionItems } from "./attention";
import { selectPlanningSources } from "./source-selection";
import type {
  DashboardMetricVariance,
  PlanningDashboardReport,
} from "./types";

function vsPlanHeadline(variance: VarianceAmounts): {
  headline: string;
  direction: "ahead" | "behind" | "on_plan";
} {
  if (variance.status === "on_plan" || Math.abs(variance.varianceAmount) < 0.01) {
    return { headline: "On Plan", direction: "on_plan" };
  }
  const ahead = variance.status === "favorable";
  return {
    headline: ahead ? "Ahead" : "Behind",
    direction: ahead ? "ahead" : "behind",
  };
}

function metricVariance(variance: VarianceAmounts | undefined): DashboardMetricVariance | undefined {
  if (!variance) return undefined;
  const ahead = variance.status === "favorable";
  const behind = variance.status === "unfavorable";
  let label = "On plan";
  if (ahead) label = "Ahead of plan";
  if (behind) label = "Behind plan";
  return {
    amount: variance.varianceAmount,
    status: variance.status,
    label,
  };
}

function emptyDashboard(asOfDate: string): PlanningDashboardReport {
  const missingHref = routes.planningBudgetNew;
  return {
    asOfDate,
    budget: { available: "missing" },
    forecast: { available: "missing" },
    cash: { available: "missing" },
    scenario: { available: "missing" },
    vsPlan: { available: "missing", href: routes.planningBudgetVsActual },
    expectedRevenue: { available: "missing", href: routes.planningForecasts },
    expectedOperatingIncome: { available: "missing", href: routes.planningForecasts },
    cashOutlook: { available: "missing", href: routes.planningCash },
    lowestCash: { available: "missing", href: routes.planningCash },
    downside: {
      available: "missing",
      exists: false,
      href: routes.planningScenarios,
      createHref: routes.planningScenarioNew,
    },
    attention: [],
    quickActions: [
      { label: "Create Plan", href: routes.planningBudgetNew },
      { label: "Create Forecast", href: routes.planningForecastNew },
      { label: "View Cash Outlook", href: routes.planningCash },
      { label: "Run Downside Scenario", href: routes.planningScenarioNew },
    ],
    cashWeeks: [],
    sourceCoverage: [],
  };
}

export async function loadPlanningDashboard(
  supabase: SupabaseClient,
  organizationId: string,
  input?: { asOfDate?: string; fiscalYear?: number },
): Promise<PlanningDashboardReport> {
  const asOfDate = input?.asOfDate ?? new Date().toISOString().slice(0, 10);
  const sources = await selectPlanningSources(supabase, organizationId, {
    fiscalYear: input?.fiscalYear,
  });

  const dashboard = emptyDashboard(asOfDate);

  const [budgetReportResult, forecastReportResult, cashReportResult, downsideResult] =
    await Promise.all([
      sources.budget
        ? loadBudgetVsActualReport(supabase, organizationId, {
            fiscalYear: sources.fiscalYear,
            throughMonth: sources.throughMonth,
            versionId: sources.budget.versionId,
          }).catch(() => null)
        : Promise.resolve(null),
      sources.forecast
        ? loadRollingForecastReport(supabase, organizationId, {
            forecastId: sources.forecast.forecastId,
            versionId: sources.forecast.versionId,
            budgetVersionId: sources.budget?.versionId ?? sources.forecast.sourceBudgetVersionId,
          }).catch(() => null)
        : Promise.resolve(null),
      loadPlanningAccountsForForecast(supabase, organizationId)
        .then((accounts) =>
          loadCashOutlookReport(supabase, organizationId, {
            asOfDate,
            accounts,
          }),
        )
        .catch(() => null),
      sources.downsideScenario
        ? loadPlanningAccountsForForecast(supabase, organizationId)
            .then((accounts) =>
              loadScenarioResults(supabase, organizationId, sources.downsideScenario!.scenarioId, {
                accounts,
                asOfDate,
              }),
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

  if (sources.budget) {
    dashboard.budget = {
      available: "ready",
      budgetId: sources.budget.budgetId,
      budgetName: sources.budget.budgetName,
      versionId: sources.budget.versionId,
      versionLabel: sources.budget.versionLabel,
      versionStatus: sources.budget.versionStatus,
      fiscalYear: sources.fiscalYear,
    };
  }

  if (sources.forecast) {
    dashboard.forecast = {
      available: "ready",
      forecastId: sources.forecast.forecastId,
      forecastName: sources.forecast.forecastName,
      versionId: sources.forecast.versionId,
      versionLabel: sources.forecast.versionLabel,
      versionStatus: sources.forecast.versionStatus,
      anchorMonth: sources.forecast.anchorMonth,
      stale: forecastReportResult?.staleForecast ?? false,
      staleMessage: forecastReportResult?.staleMessage,
    };
  }

  if (cashReportResult) {
    dashboard.cash = {
      available: "ready",
      asOfDate: cashReportResult.asOfDate,
      runId: cashReportResult.runId,
    };
    dashboard.sourceCoverage = cashReportResult.sourceCoverage;
    dashboard.cashWeeks = cashReportResult.weeks.map((week) => ({
      weekIndex: week.weekIndex,
      label: week.label,
      closingCash: week.closingCash,
    }));
  }

  if (sources.downsideScenario) {
    dashboard.scenario = {
      available: "ready",
      scenarioId: sources.downsideScenario.scenarioId,
      scenarioName: sources.downsideScenario.scenarioName,
      forecastVersionId: sources.downsideScenario.forecastVersionId,
    };
  }

  if (budgetReportResult) {
    const oi = budgetReportResult.summary.operatingIncome;
    const headline = vsPlanHeadline(oi);
    dashboard.vsPlan = {
      available: "ready",
      headline: headline.headline,
      direction: headline.direction,
      actual: oi.actual,
      plan: oi.budget,
      variance: metricVariance(oi),
      throughMonthLabel: budgetReportResult.throughMonthLabel,
      href: routes.planningBudgetVsActual,
    };
  }

  if (forecastReportResult) {
    const revenueRollup = forecastReportResult.categories.find((row) => row.category === "revenue");
    const oiRollup = forecastReportResult.categories.find((row) => row.category === "operating_income");
    dashboard.expectedRevenue = {
      available: "ready",
      value: forecastReportResult.summary.revenue.rollingTotal,
      vsPlan: metricVariance(revenueRollup?.forecastVsBudget),
      href: `${routes.planningForecasts}/${forecastReportResult.forecastId}`,
    };
    dashboard.expectedOperatingIncome = {
      available: "ready",
      value: forecastReportResult.summary.operatingIncome.rollingTotal,
      vsPlan: metricVariance(oiRollup?.forecastVsBudget),
      href: `${routes.planningForecasts}/${forecastReportResult.forecastId}`,
    };
  }

  if (cashReportResult) {
    const summary = cashReportResult.summary;
    dashboard.cashOutlook = {
      available: "ready",
      startingCash: summary.startingCash,
      endingCash: summary.endingCash,
      href: routes.planningCash,
    };
    dashboard.lowestCash = {
      available: "ready",
      lowestCash: summary.lowestCash,
      lowestCashWeekIndex: summary.lowestCashWeekIndex,
      lowestCashDate: summary.lowestCashDate,
      firstNegativeWeekIndex: summary.firstNegativeWeekIndex,
      firstNegativeWeekLabel: summary.firstNegativeWeekLabel,
      shortfall: summary.firstNegativeWeekIndex != null,
      href: routes.planningCash,
    };
  }

  if (downsideResult) {
    const baseOi = downsideResult.forecast.base.summary.operatingIncome.rollingTotal;
    const scenarioOi = downsideResult.forecast.scenario.summary.operatingIncome.rollingTotal;
    const baseEnding = downsideResult.cash.base.summary.endingCash;
    const scenarioEnding = downsideResult.cash.scenario.summary.endingCash;
    dashboard.downside = {
      available: "ready",
      exists: true,
      endingCash: scenarioEnding,
      operatingIncome: scenarioOi,
      endingCashDelta: roundMoney(scenarioEnding - baseEnding),
      operatingIncomeDelta: roundMoney(scenarioOi - baseOi),
      href: `${routes.planningScenarios}/${sources.downsideScenario!.scenarioId}`,
      createHref: routes.planningScenarioNew,
    };
  } else if (sources.forecast) {
    dashboard.downside = {
      available: "ready",
      exists: false,
      href: routes.planningScenarios,
      createHref: routes.planningScenarioNew,
    };
  }

  dashboard.attention = buildAttentionItems({
    hasBudget: Boolean(sources.budget && budgetReportResult),
    hasForecast: Boolean(sources.forecast && forecastReportResult),
    hasCash: Boolean(cashReportResult),
    hasDownsideScenario: Boolean(sources.downsideScenario && downsideResult),
    forecastStale: forecastReportResult?.staleForecast,
    cashReport: cashReportResult,
    forecastReport: forecastReportResult,
  });

  dashboard.quickActions = [
    {
      label: forecastReportResult?.staleForecast ? "Update Forecast" : "View Forecast",
      href: forecastReportResult
        ? `${routes.planningForecasts}/${forecastReportResult.forecastId}`
        : routes.planningForecastNew,
    },
    { label: "View Cash Outlook", href: routes.planningCash },
    { label: "Review Vs Plan", href: routes.planningBudgetVsActual },
    {
      label: sources.downsideScenario ? "View Downside Scenario" : "Run Downside Scenario",
      href: sources.downsideScenario
        ? `${routes.planningScenarios}/${sources.downsideScenario.scenarioId}`
        : routes.planningScenarioNew,
    },
  ].slice(0, 4);

  return dashboard;
}
