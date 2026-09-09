import { roundMoney } from "@/lib/accounting/payment-fees";
import type { RollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import type { ScenarioDriverInput } from "./types";

function driverValue(drivers: ScenarioDriverInput[], type: ScenarioDriverInput["driverType"]): number {
  const row = drivers.find((driver) => driver.driverType === type);
  return row?.valueNumeric != null ? Number(row.valueNumeric) : 0;
}

function cloneReport(base: RollingForecastReport): RollingForecastReport {
  return JSON.parse(JSON.stringify(base)) as RollingForecastReport;
}

function recomputeAccountRolling(account: RollingForecastReport["accounts"][number]): void {
  account.rollingTotal = roundMoney(
    account.periods.reduce((sum, period) => sum + period.amount, 0),
  );
}

function recomputeSummary(report: RollingForecastReport): void {
  const revenueAccounts = report.accounts.filter((row) => row.category === "revenue");
  const cogsAccounts = report.accounts.filter((row) => row.category === "cogs");
  const expenseAccounts = report.accounts.filter((row) => row.category === "expense");

  const sumRolling = (rows: typeof report.accounts) =>
    roundMoney(rows.reduce((sum, row) => sum + row.rollingTotal, 0));

  const revenue = sumRolling(revenueAccounts);
  const cogs = sumRolling(cogsAccounts);
  const expenses = sumRolling(expenseAccounts);
  const grossProfit = roundMoney(revenue - cogs);
  const operatingIncome = roundMoney(grossProfit - expenses);

  report.summary = {
    revenue: { ytdActual: report.summary.revenue.ytdActual, rollingTotal: revenue },
    grossProfit: { ytdActual: report.summary.grossProfit.ytdActual, rollingTotal: grossProfit },
    expenses: { ytdActual: report.summary.expenses.ytdActual, rollingTotal: expenses },
    operatingIncome: { ytdActual: report.summary.operatingIncome.ytdActual, rollingTotal: operatingIncome },
  };

  for (const rollup of report.categories) {
    if (rollup.category === "revenue") rollup.rollingTotal = revenue;
    if (rollup.category === "cogs") rollup.rollingTotal = cogs;
    if (rollup.category === "gross_profit") rollup.rollingTotal = grossProfit;
    if (rollup.category === "expense") rollup.rollingTotal = expenses;
    if (rollup.category === "operating_income") rollup.rollingTotal = operatingIncome;
  }
}

/**
 * Apply scenario drivers to forward forecast periods only. Actual periods are unchanged.
 */
export function applyForecastScenarioOverlay(
  base: RollingForecastReport,
  drivers: ScenarioDriverInput[],
): RollingForecastReport {
  if (!drivers.length) return cloneReport(base);

  const report = cloneReport(base);
  const forwardMonths = new Set(report.forwardMonths);
  const revenuePct = driverValue(drivers, "revenue_percentage");
  const cogsPct = driverValue(drivers, "cogs_percentage");
  const expensePct = driverValue(drivers, "expense_percentage");
  const marginPoints = driverValue(drivers, "gross_margin_points");

  for (const account of report.accounts) {
    for (const period of account.periods) {
      if (period.kind === "actual") continue;
      if (!forwardMonths.has(period.periodMonth)) continue;

      if (account.category === "revenue" && revenuePct !== 0) {
        period.amount = roundMoney(period.amount * (1 + revenuePct / 100));
      } else if (account.category === "cogs" && cogsPct !== 0 && marginPoints === 0) {
        period.amount = roundMoney(period.amount * (1 + cogsPct / 100));
      } else if (account.category === "expense" && expensePct !== 0) {
        period.amount = roundMoney(period.amount * (1 + expensePct / 100));
      }
    }
    recomputeAccountRolling(account);
  }

  if (marginPoints !== 0) {
    for (const periodMonth of report.forwardMonths) {
      let revenueTotal = 0;
      let cogsTotal = 0;
      for (const account of report.accounts) {
        const period = account.periods.find((row) => row.periodMonth === periodMonth);
        if (!period || period.kind === "actual") continue;
        if (account.category === "revenue") revenueTotal += period.amount;
        if (account.category === "cogs") cogsTotal += period.amount;
      }
      revenueTotal = roundMoney(revenueTotal);
      cogsTotal = roundMoney(cogsTotal);
      if (revenueTotal <= 0.009) continue;

      const baseMargin = roundMoney(((revenueTotal - cogsTotal) / revenueTotal) * 100);
      const scenarioMargin = roundMoney(baseMargin + marginPoints);
      const targetCogs = roundMoney(revenueTotal * (1 - scenarioMargin / 100));

      const cogsAccounts = report.accounts.filter((row) => row.category === "cogs");
      const baseCogsSum = roundMoney(
        cogsAccounts.reduce((sum, account) => {
          const period = account.periods.find((row) => row.periodMonth === periodMonth);
          return sum + (period?.amount ?? 0);
        }, 0),
      );
      for (const account of cogsAccounts) {
        const period = account.periods.find((row) => row.periodMonth === periodMonth);
        if (!period || period.kind === "actual") continue;
        if (baseCogsSum <= 0.009) {
          period.amount = roundMoney(targetCogs / cogsAccounts.length);
        } else {
          period.amount = roundMoney((period.amount / baseCogsSum) * targetCogs);
        }
      }
    }
    for (const account of report.accounts.filter((row) => row.category === "cogs")) {
      recomputeAccountRolling(account);
    }
  }

  recomputeSummary(report);
  return report;
}
