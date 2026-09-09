import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { CATEGORY_OWNER_LABELS } from "@/lib/planning/cash/source-coverage";
import type { CashLineCategory } from "@/lib/planning/cash/types";
import { loadCashOutlookReport } from "@/lib/planning/cash/load-cash-outlook";
import { selectPlanningSources } from "@/lib/planning/dashboard/source-selection";
import { loadPlanningAccountsForForecast } from "@/lib/planning/forecasts/forecast-crud";
import {
  loadBudgetVsActualReport,
  type BudgetVsActualReport,
} from "@/lib/planning/reports/budget-vs-actual";
import { loadRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import { compareScenarios } from "@/lib/planning/scenarios/load-scenario-report";
import { listScenarios } from "@/lib/planning/scenarios/scenario-crud";
import type { ScenarioRecord, ScenarioType } from "@/lib/planning/scenarios/types";
import { routes } from "@/lib/routes";
import { buildSourceLineage, detectSourceMismatches } from "./lineage";
import { buildPlanningRisks, MATERIAL_YTD_VARIANCE } from "./risks";
import type {
  AccountantCashCategoryTotal,
  AccountantCategoryVariance,
  AccountantPlanningPackage,
  AccountantScenarioRow,
} from "./types";

const SCENARIO_ORDER: ScenarioType[] = ["base", "downside", "upside"];

function throughMonthFromPeriodEnd(periodEnd: string): string {
  return `${periodEnd.slice(0, 7)}-01`;
}

function categoryVariances(report: BudgetVsActualReport): AccountantCategoryVariance[] {
  return report.categories
    .filter((row) =>
      ["revenue", "cogs", "gross_profit", "expense", "operating_income"].includes(row.category),
    )
    .map((row) => ({
      label: row.label,
      month: row.month,
      ytd: row.ytd,
    }));
}

function cashCategoryTotals(
  report: Awaited<ReturnType<typeof loadCashOutlookReport>>,
): AccountantCashCategoryTotal[] {
  const totals = new Map<string, { inflows: number; outflows: number }>();
  for (const week of report.weeks) {
    for (const line of week.lines) {
      const bucket = totals.get(line.category) ?? { inflows: 0, outflows: 0 };
      if (line.flowKind === "inflow") bucket.inflows = roundMoney(bucket.inflows + line.amount);
      else bucket.outflows = roundMoney(bucket.outflows + line.amount);
      totals.set(line.category, bucket);
    }
  }

  const order: CashLineCategory[] = [
    "ar_collection",
    "ap_payment",
    "payroll",
    "recurring",
    "purchasing",
    "capex",
    "manual",
  ];

  return order
    .filter((key) => totals.has(key))
    .map((key) => ({
      category: key,
      label: CATEGORY_OWNER_LABELS[key] ?? key,
      inflows: totals.get(key)!.inflows,
      outflows: totals.get(key)!.outflows,
    }));
}

function orderedScenarioIds(records: ScenarioRecord[]): string[] {
  return records
    .filter((row) => SCENARIO_ORDER.includes(row.scenarioType))
    .sort(
      (a, b) =>
        SCENARIO_ORDER.indexOf(a.scenarioType) - SCENARIO_ORDER.indexOf(b.scenarioType),
    )
    .map((row) => row.id);
}

export async function loadAccountantPlanningPackage(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    periodEnd: string;
    periodLabel: string;
    fiscalYear?: number;
  },
): Promise<AccountantPlanningPackage> {
  const periodEnd = input.periodEnd.slice(0, 10);
  const fiscalYear = input.fiscalYear ?? Number(periodEnd.slice(0, 4));
  const throughMonth = throughMonthFromPeriodEnd(periodEnd);

  const sources = await selectPlanningSources(supabase, organizationId, {
    fiscalYear,
    throughMonth,
  });

  let scenarioRecords: ScenarioRecord[] = [];
  if (sources.forecast) {
    try {
      scenarioRecords = await listScenarios(supabase, organizationId, sources.forecast.forecastId);
    } catch {
      scenarioRecords = [];
    }
  }

  const scenarioIds = orderedScenarioIds(scenarioRecords);
  const baseScenarioId =
    scenarioRecords.find((row) => row.scenarioType === "base")?.id ?? scenarioIds[0] ?? null;

  const [budgetReport, forecastReport, cashReport, scenarioComparison] = await Promise.all([
    sources.budget
      ? loadBudgetVsActualReport(supabase, organizationId, {
          fiscalYear,
          throughMonth,
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
        loadCashOutlookReport(supabase, organizationId, { asOfDate: periodEnd, accounts }),
      )
      .catch(() => null),
    scenarioIds.length
      ? loadPlanningAccountsForForecast(supabase, organizationId)
          .then((accounts) =>
            compareScenarios(supabase, organizationId, {
              scenarioIds,
              baseScenarioId,
              accounts,
              asOfDate: periodEnd,
            }),
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const sourceMismatches = detectSourceMismatches({
    sources,
    forecastReport,
    scenarioRecords,
  });

  const lineage = buildSourceLineage({
    sources,
    periodEnd,
    periodLabel: input.periodLabel,
    forecastReport,
    cashAsOfDate: cashReport?.asOfDate,
    cashRunId: cashReport?.runId,
    scenarioRecords,
  });

  const oiCategory = budgetReport?.categories.find((row) => row.category === "operating_income");
  const oiRollup = forecastReport?.categories.find((row) => row.category === "operating_income");

  const scenarioRows: AccountantScenarioRow[] =
    scenarioComparison?.rows.map((row) => ({
      scenarioType: row.scenarioType,
      scenarioName: row.scenarioName,
      revenue: row.revenue,
      operatingIncome: row.operatingIncome,
      endingCash: row.endingCash,
      lowestCash: row.lowestCash,
      firstNegativeWeekIndex: row.firstNegativeWeekIndex,
    })) ?? [];

  const downsideRow = scenarioComparison?.rows.find((row) => row.scenarioType === "downside");

  return {
    generatedAt: new Date().toISOString(),
    presentationMode: "accountant",
    closeContext: {
      planningBlocksClose: false,
      closeRewritesPlanning: false,
    },
    lineage,
    sourceMismatches,
    budgetVsActual: {
      available: budgetReport ? "ready" : "missing",
      currentPeriodLabel: budgetReport?.throughMonthLabel,
      categories: budgetReport ? categoryVariances(budgetReport) : undefined,
      operatingIncome: oiCategory
        ? { month: oiCategory.month, ytd: oiCategory.ytd }
        : undefined,
      materialVariances: budgetReport
        ? categoryVariances(budgetReport)
            .filter((row) => Math.abs(row.ytd.varianceAmount) >= MATERIAL_YTD_VARIANCE)
            .map((row) => ({
              label: row.label,
              ytdVariance: row.ytd.varianceAmount,
              status: row.ytd.status,
            }))
            .sort((a, b) => Math.abs(b.ytdVariance) - Math.abs(a.ytdVariance))
            .slice(0, 3)
        : undefined,
    },
    forecast: {
      available: forecastReport ? "ready" : "missing",
      expectedRevenue: forecastReport?.summary.revenue.rollingTotal,
      expectedGrossProfit: forecastReport?.summary.grossProfit.rollingTotal,
      expectedOperatingIncome: forecastReport?.summary.operatingIncome.rollingTotal,
      budgetComparison: oiRollup?.forecastVsBudget,
      stale: forecastReport?.staleForecast,
      staleMessage: forecastReport?.staleMessage,
    },
    cash: {
      available: cashReport ? "ready" : "missing",
      startingCash: cashReport?.summary.startingCash,
      expectedMoneyIn: cashReport?.summary.expectedMoneyIn,
      expectedMoneyOut: cashReport?.summary.expectedMoneyOut,
      endingCash: cashReport?.summary.endingCash,
      lowestCash: cashReport?.summary.lowestCash,
      lowestCashDate: cashReport?.summary.lowestCashDate,
      firstNegativeWeekIndex: cashReport?.summary.firstNegativeWeekIndex,
      firstNegativeWeekLabel: cashReport?.summary.firstNegativeWeekLabel,
      runwayWeeks: cashReport?.summary.runwayWeeks,
      categoryTotals: cashReport ? cashCategoryTotals(cashReport) : undefined,
      sourceCoverage: cashReport?.sourceCoverage,
      warnings: cashReport?.warnings,
    },
    scenarios: {
      available: scenarioRows.length ? "ready" : "missing",
      rows: scenarioRows.length ? scenarioRows : undefined,
    },
    risks: buildPlanningRisks({
      hasBudget: Boolean(budgetReport),
      hasForecast: Boolean(forecastReport),
      hasCash: Boolean(cashReport),
      forecastStale: forecastReport?.staleForecast,
      firstNegativeWeek: cashReport?.summary.firstNegativeWeekIndex,
      cashCoverageIncomplete: cashReport?.sourceCoverage.some(
        (row) => row.key === "payroll" && row.count === 0,
      ),
      unscheduledPurchasing: cashReport?.warnings.some((row) => row.code === "unscheduled_purchasing"),
      significantYtdVariance: oiCategory?.ytd.varianceAmount,
      downsideShortfall: downsideRow?.firstNegativeWeekIndex != null,
      hasDownsideScenario: Boolean(sources.downsideScenario),
      sourceMismatches,
    }),
    links: {
      budgetVsActual: routes.planningBudgetVsActual,
      forecast: forecastReport
        ? `${routes.planningForecasts}/${forecastReport.forecastId}`
        : routes.planningForecasts,
      cash: routes.planningCash,
      scenarios: routes.planningScenarios,
    },
  };
}
