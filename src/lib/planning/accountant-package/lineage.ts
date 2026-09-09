import type { SelectedPlanningSources } from "@/lib/planning/dashboard/source-selection";
import type { RollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import type { ScenarioRecord } from "@/lib/planning/scenarios/types";
import type { AccountantSourceLineage, AccountantSourceMismatch } from "./types";

export function buildSourceLineage(input: {
  sources: SelectedPlanningSources;
  periodEnd: string;
  periodLabel: string;
  forecastReport?: RollingForecastReport | null;
  cashAsOfDate?: string;
  cashRunId?: string;
  scenarioRecords?: ScenarioRecord[];
}): AccountantSourceLineage {
  return {
    reportPeriod: {
      label: input.periodLabel,
      periodEnd: input.periodEnd,
      fiscalYear: input.sources.fiscalYear,
      throughMonth: input.sources.throughMonth,
    },
    budget: input.sources.budget
      ? {
          name: input.sources.budget.budgetName,
          fiscalYear: input.sources.fiscalYear,
          versionLabel: input.sources.budget.versionLabel,
          versionStatus: input.sources.budget.versionStatus,
          versionId: input.sources.budget.versionId,
        }
      : undefined,
    forecast: input.forecastReport
      ? {
          name: input.forecastReport.forecastName,
          versionLabel: input.forecastReport.version.label,
          versionStatus: input.forecastReport.version.status,
          versionId: input.forecastReport.version.id,
          anchorMonth: input.forecastReport.anchorMonth,
          publishedAt: input.forecastReport.version.publishedAt,
          actualCutoffMonth: input.forecastReport.actualCutoffMonth,
          sourceBudgetVersionId: input.forecastReport.version.sourceBudgetVersionId,
          stale: input.forecastReport.staleForecast,
          staleMessage: input.forecastReport.staleMessage,
        }
      : input.sources.forecast
        ? {
            name: input.sources.forecast.forecastName,
            versionLabel: input.sources.forecast.versionLabel,
            versionStatus: input.sources.forecast.versionStatus,
            versionId: input.sources.forecast.versionId,
            anchorMonth: input.sources.forecast.anchorMonth,
            sourceBudgetVersionId: input.sources.forecast.sourceBudgetVersionId,
            stale: false,
          }
        : undefined,
    cash: input.cashAsOfDate
      ? {
          asOfDate: input.cashAsOfDate,
          generatedAt: new Date().toISOString(),
          runId: input.cashRunId,
        }
      : undefined,
    scenarios: (input.scenarioRecords ?? []).map((row) => ({
      name: row.name,
      type: row.scenarioType,
      forecastVersionId: row.forecastVersionId,
    })),
  };
}

export function detectSourceMismatches(input: {
  sources: SelectedPlanningSources;
  forecastReport?: RollingForecastReport | null;
  scenarioRecords?: ScenarioRecord[];
}): AccountantSourceMismatch[] {
  const mismatches: AccountantSourceMismatch[] = [];
  const forecastVersionId =
    input.forecastReport?.version.id ?? input.sources.forecast?.versionId;

  for (const scenario of input.scenarioRecords ?? []) {
    if (forecastVersionId && scenario.forecastVersionId !== forecastVersionId) {
      mismatches.push({
        code: `scenario_${scenario.scenarioType}_forecast_mismatch`,
        message: `${scenario.name} is tied to a different forecast version than the package forecast — review recommended.`,
      });
    }
  }

  const budgetVersionId = input.sources.budget?.versionId;
  const forecastBudgetLink =
    input.forecastReport?.version.sourceBudgetVersionId ??
    input.sources.forecast?.sourceBudgetVersionId;
  if (
    budgetVersionId &&
    forecastBudgetLink &&
    forecastBudgetLink !== budgetVersionId
  ) {
    mismatches.push({
      code: "forecast_budget_version_mismatch",
      message: "Forecast source budget version differs from the package budget version — review recommended.",
    });
  }

  return mismatches;
}
