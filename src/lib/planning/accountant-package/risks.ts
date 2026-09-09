import { routes } from "@/lib/routes";
import type { AccountantPlanningRisk, AccountantSourceMismatch } from "./types";

export const MAX_PLANNING_RISKS = 5;

export const MATERIAL_YTD_VARIANCE = 25000;

export function buildPlanningRisks(input: {
  hasBudget: boolean;
  hasForecast: boolean;
  hasCash: boolean;
  forecastStale?: boolean;
  firstNegativeWeek?: number | null;
  cashCoverageIncomplete?: boolean;
  unscheduledPurchasing?: boolean;
  significantYtdVariance?: number;
  downsideShortfall?: boolean;
  hasDownsideScenario: boolean;
  sourceMismatches: AccountantSourceMismatch[];
}): AccountantPlanningRisk[] {
  const items: AccountantPlanningRisk[] = [];

  if (input.firstNegativeWeek != null) {
    items.push({
      code: "negative_cash",
      severity: "critical",
      message: `Projected cash shortfall in Week ${input.firstNegativeWeek}.`,
      href: routes.planningCash,
    });
  }

  for (const mismatch of input.sourceMismatches) {
    items.push({
      code: mismatch.code,
      severity: "warn",
      message: mismatch.message,
      href: routes.planningForecasts,
    });
  }

  if (input.forecastStale) {
    items.push({
      code: "stale_forecast",
      severity: "warn",
      message: "Forecast is stale — new actuals exist beyond the last actualized period.",
      href: routes.planningForecasts,
    });
  }

  if (
    input.significantYtdVariance != null &&
    Math.abs(input.significantYtdVariance) >= MATERIAL_YTD_VARIANCE
  ) {
    items.push({
      code: "material_variance",
      severity: "warn",
      message: `Material YTD operating income variance: ${input.significantYtdVariance >= 0 ? "+" : ""}${input.significantYtdVariance.toLocaleString(undefined, { maximumFractionDigits: 0 })} vs budget.`,
      href: routes.planningBudgetVsActual,
    });
  }

  if (input.downsideShortfall) {
    items.push({
      code: "downside_shortfall",
      severity: "warn",
      message: "Downside scenario projects cash shortfall within the 13-week horizon.",
      href: routes.planningScenarios,
    });
  }

  if (input.cashCoverageIncomplete) {
    items.push({
      code: "cash_coverage",
      severity: "warn",
      message: "Cash forecast source coverage may be incomplete (review payroll projection).",
      href: routes.planningCash,
    });
  }

  if (input.unscheduledPurchasing) {
    items.push({
      code: "unscheduled_purchasing",
      severity: "warn",
      message: "Purchasing commitments lack expected dates — review unscheduled items.",
      href: routes.planningCash,
    });
  }

  if (!input.hasBudget) {
    items.push({
      code: "missing_budget",
      severity: "info",
      message: "No approved budget configured for this fiscal year.",
      href: routes.planningBudgetNew,
    });
  }

  if (!input.hasForecast) {
    items.push({
      code: "missing_forecast",
      severity: "info",
      message: "No published or draft forecast available.",
      href: routes.planningForecastNew,
    });
  }

  if (input.hasForecast && !input.hasDownsideScenario) {
    items.push({
      code: "missing_downside",
      severity: "info",
      message: "No downside scenario on file.",
      href: routes.planningScenarioNew,
    });
  }

  const priority = { critical: 0, warn: 1, info: 2 };
  return items.sort((a, b) => priority[a.severity] - priority[b.severity]).slice(0, MAX_PLANNING_RISKS);
}
