import { rowsToCsv } from "@/lib/accounting/exports";
import { sanitizeCsvExportCell } from "@/lib/planning/budgets/csv";
import type { AccountantPlanningPackage } from "./types";

export type PlanningPackageExportFile = {
  filename: string;
  content: string;
  mimeType: string;
};

export function buildPlanningPackageExportFiles(
  pkg: AccountantPlanningPackage,
  organizationSlug: string,
): PlanningPackageExportFile[] {
  const prefix = organizationSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "teller";
  const files: PlanningPackageExportFile[] = [];

  if (pkg.budgetVsActual.available === "ready" && pkg.budgetVsActual.categories) {
    const rows = pkg.budgetVsActual.categories.flatMap((row) => [
      {
        section: row.label,
        period: "Month",
        budget: row.month.budget,
        actual: row.month.actual,
        variance: row.month.varianceAmount,
        variance_pct: row.month.variancePercent ?? "",
        status: row.month.status,
      },
      {
        section: row.label,
        period: "YTD",
        budget: row.ytd.budget,
        actual: row.ytd.actual,
        variance: row.ytd.varianceAmount,
        variance_pct: row.ytd.variancePercent ?? "",
        status: row.ytd.status,
      },
    ]);
    files.push({
      filename: `${prefix}-planning-budget-vs-actual.csv`,
      content: rowsToCsv(rows, [
        { key: "section", header: "Section" },
        { key: "period", header: "Period" },
        { key: "budget", header: "Budget" },
        { key: "actual", header: "Actual" },
        { key: "variance", header: "Variance" },
        { key: "variance_pct", header: "Variance %" },
        { key: "status", header: "Status" },
      ]),
      mimeType: "text/csv",
    });
  }

  if (pkg.forecast.available === "ready") {
    files.push({
      filename: `${prefix}-planning-forecast-summary.csv`,
      content: rowsToCsv(
        [
          {
            metric: "Expected Revenue",
            amount: pkg.forecast.expectedRevenue ?? 0,
            vs_budget: pkg.forecast.budgetComparison?.varianceAmount ?? "",
            stale: pkg.forecast.stale ? "yes" : "no",
          },
          {
            metric: "Expected Gross Profit",
            amount: pkg.forecast.expectedGrossProfit ?? 0,
            vs_budget: "",
            stale: pkg.forecast.stale ? "yes" : "no",
          },
          {
            metric: "Expected Operating Income",
            amount: pkg.forecast.expectedOperatingIncome ?? 0,
            vs_budget: "",
            stale: pkg.forecast.stale ? "yes" : "no",
          },
        ],
        [
          { key: "metric", header: "Metric" },
          { key: "amount", header: "Amount" },
          { key: "vs_budget", header: "Vs Budget Variance" },
          { key: "stale", header: "Stale" },
        ],
      ),
      mimeType: "text/csv",
    });
  }

  if (pkg.cash.available === "ready") {
    files.push({
      filename: `${prefix}-planning-cash-summary.csv`,
      content: rowsToCsv(
        [
          { metric: "Starting Cash", amount: pkg.cash.startingCash ?? 0 },
          { metric: "Expected Cash In", amount: pkg.cash.expectedMoneyIn ?? 0 },
          { metric: "Expected Cash Out", amount: pkg.cash.expectedMoneyOut ?? 0 },
          { metric: "Ending Cash", amount: pkg.cash.endingCash ?? 0 },
          { metric: "Lowest Cash", amount: pkg.cash.lowestCash ?? 0 },
          {
            metric: "First Negative Week",
            amount: pkg.cash.firstNegativeWeekIndex ?? "",
          },
        ],
        [
          { key: "metric", header: "Metric" },
          { key: "amount", header: "Amount" },
        ],
      ),
      mimeType: "text/csv",
    });

    if (pkg.cash.categoryTotals?.length) {
      files.push({
        filename: `${prefix}-planning-cash-by-category.csv`,
        content: rowsToCsv(
          pkg.cash.categoryTotals.map((row) => ({
            category: row.label,
            inflows: row.inflows,
            outflows: row.outflows,
          })),
          [
            { key: "category", header: "Category" },
            { key: "inflows", header: "Inflows" },
            { key: "outflows", header: "Outflows" },
          ],
        ),
        mimeType: "text/csv",
      });
    }
  }

  if (pkg.scenarios.available === "ready" && pkg.scenarios.rows?.length) {
    files.push({
      filename: `${prefix}-planning-scenario-comparison.csv`,
      content: rowsToCsv(
        pkg.scenarios.rows.map((row) => ({
          scenario_type: row.scenarioType,
          scenario_name: row.scenarioName,
          revenue: row.revenue,
          operating_income: row.operatingIncome,
          ending_cash: row.endingCash,
          lowest_cash: row.lowestCash,
          first_negative_week: row.firstNegativeWeekIndex ?? "",
        })),
        [
          { key: "scenario_type", header: "Scenario Type" },
          { key: "scenario_name", header: "Scenario Name" },
          { key: "revenue", header: "Revenue" },
          { key: "operating_income", header: "Operating Income" },
          { key: "ending_cash", header: "Ending Cash" },
          { key: "lowest_cash", header: "Lowest Cash" },
          { key: "first_negative_week", header: "First Negative Week" },
        ],
      ),
      mimeType: "text/csv",
    });
  }

  files.push({
    filename: `${prefix}-planning-source-lineage.csv`,
    content: lineageToCsv(pkg),
    mimeType: "text/csv",
  });

  return files;
}

function lineageToCsv(pkg: AccountantPlanningPackage): string {
  const safe = (value: string) => sanitizeCsvExportCell(value);
  const rows: Array<Record<string, string | number>> = [
    {
      source: "Report Period",
      name: safe(pkg.lineage.reportPeriod.label),
      detail: pkg.lineage.reportPeriod.periodEnd,
    },
  ];
  if (pkg.lineage.budget) {
    rows.push({
      source: "Budget",
      name: safe(pkg.lineage.budget.name),
      detail: safe(`${pkg.lineage.budget.versionLabel} (${pkg.lineage.budget.versionStatus})`),
    });
  }
  if (pkg.lineage.forecast) {
    rows.push({
      source: "Forecast",
      name: safe(pkg.lineage.forecast.name),
      detail: safe(`${pkg.lineage.forecast.versionLabel} (${pkg.lineage.forecast.versionStatus})`),
    });
  }
  if (pkg.lineage.cash) {
    rows.push({
      source: "Cash Outlook",
      name: pkg.lineage.cash.asOfDate,
      detail: safe(pkg.lineage.cash.runId ?? "computed"),
    });
  }
  for (const scenario of pkg.lineage.scenarios ?? []) {
    rows.push({
      source: "Scenario",
      name: safe(scenario.name),
      detail: safe(`${scenario.type} · forecast version ${scenario.forecastVersionId}`),
    });
  }
  return rowsToCsv(rows, [
    { key: "source", header: "Source" },
    { key: "name", header: "Name" },
    { key: "detail", header: "Detail" },
  ]);
}
