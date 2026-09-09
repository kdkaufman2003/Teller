import type { CashOutlookReport } from "@/lib/planning/cash/types";
import type { RollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import { routes } from "@/lib/routes";
import type { DashboardAttentionItem } from "./types";

const MAX_ATTENTION_ITEMS = 5;

export type AttentionInput = {
  hasBudget: boolean;
  hasForecast: boolean;
  hasCash: boolean;
  hasDownsideScenario: boolean;
  forecastStale?: boolean;
  cashReport?: CashOutlookReport | null;
  forecastReport?: RollingForecastReport | null;
};

function overdueArAmount(report: CashOutlookReport): number {
  return report.weeks
    .flatMap((week) => week.lines)
    .filter((line) => line.category === "ar_collection" && line.overdue)
    .reduce((sum, line) => sum + line.amount, 0);
}

function overdueApAmount(report: CashOutlookReport): number {
  return report.weeks
    .flatMap((week) => week.lines)
    .filter((line) => line.category === "ap_payment" && line.overdue)
    .reduce((sum, line) => sum + line.amount, 0);
}

export function buildAttentionItems(input: AttentionInput): DashboardAttentionItem[] {
  const items: DashboardAttentionItem[] = [];

  if (input.hasCash && input.cashReport?.summary.firstNegativeWeekIndex != null) {
    items.push({
      code: "negative_cash",
      severity: "critical",
      message: `Projected cash shortfall in ${input.cashReport.summary.firstNegativeWeekLabel ?? `Week ${input.cashReport.summary.firstNegativeWeekIndex}`}.`,
      href: routes.planningCash,
    });
  }

  if (input.forecastStale) {
    items.push({
      code: "stale_forecast",
      severity: "warn",
      message: "Forecast needs updating — new actuals are available since it was published.",
      href: input.forecastReport ? `${routes.planningForecasts}/${input.forecastReport.forecastId}` : routes.planningForecasts,
    });
  }

  if (!input.hasBudget) {
    items.push({
      code: "missing_budget",
      severity: "warn",
      message: "No approved plan yet for this year.",
      href: routes.planningBudgetNew,
    });
  }

  if (!input.hasForecast) {
    items.push({
      code: "missing_forecast",
      severity: "warn",
      message: "No forecast yet — expected revenue and profit are unavailable.",
      href: routes.planningForecastNew,
    });
  }

  if (input.hasCash && input.cashReport) {
    const arOverdue = overdueArAmount(input.cashReport);
    if (arOverdue >= 1000) {
      items.push({
        code: "overdue_ar",
        severity: "warn",
        message: `$${arOverdue.toLocaleString(undefined, { maximumFractionDigits: 0 })} overdue receivables included in Week 1.`,
        href: routes.planningCash,
      });
    }

    const apOverdue = overdueApAmount(input.cashReport);
    if (apOverdue >= 1000) {
      items.push({
        code: "overdue_ap",
        severity: "warn",
        message: `$${apOverdue.toLocaleString(undefined, { maximumFractionDigits: 0 })} overdue bills included in Week 1.`,
        href: routes.planningCash,
      });
    }

    for (const warning of input.cashReport.warnings) {
      if (warning.code === "payroll_amount_unavailable") {
        items.push({
          code: "payroll_projection",
          severity: "warn",
          message: warning.message,
          href: routes.planningCash,
        });
      }
      if (warning.code === "unscheduled_purchasing") {
        items.push({
          code: "unscheduled_purchasing",
          severity: "warn",
          message: warning.message,
          href: routes.planningCash,
        });
      }
    }

    const incompleteCoverage = input.cashReport.sourceCoverage.filter(
      (row) => !row.included || (row.key === "payroll" && row.count === 0),
    );
    if (incompleteCoverage.some((row) => row.key === "payroll" && row.count === 0)) {
      items.push({
        code: "cash_coverage_payroll",
        severity: "warn",
        message: "Cash outlook may be incomplete — payroll projection needs an expected amount.",
        href: routes.planningCash,
      });
    }
  }

  if (input.hasForecast && !input.hasDownsideScenario) {
    items.push({
      code: "missing_downside",
      severity: "info",
      message: "No downside scenario yet — consider modeling a conservative case.",
      href: routes.planningScenarioNew,
    });
  }

  const priority: Record<DashboardAttentionItem["severity"], number> = {
    critical: 0,
    warn: 1,
    info: 2,
  };

  return items
    .sort((a, b) => priority[a.severity] - priority[b.severity])
    .slice(0, MAX_ATTENTION_ITEMS);
}

export { MAX_ATTENTION_ITEMS };
