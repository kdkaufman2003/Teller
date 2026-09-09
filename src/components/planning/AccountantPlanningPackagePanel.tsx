"use client";

import Link from "next/link";
import { money } from "@/lib/format";
import type { AccountantPlanningPackage } from "@/lib/planning/accountant-package/types";

function AvailabilityBadge({ available }: { available: "ready" | "missing" }) {
  if (available === "ready") {
    return <span className="text-xs text-emerald-700">Ready</span>;
  }
  return <span className="text-xs text-muted">Not configured</span>;
}

function varianceLabel(status: string): string {
  if (status === "favorable") return "Favorable";
  if (status === "unfavorable") return "Unfavorable";
  return "On plan";
}

export function AccountantPlanningPackagePanel({
  pkg,
  exportHref,
}: {
  pkg: AccountantPlanningPackage;
  exportHref: string;
}) {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Accountant planning package</p>
          <p className="font-ledger text-xl text-navy">{pkg.lineage.reportPeriod.label}</p>
          <p className="mt-1 text-xs text-muted">
            Generated {new Date(pkg.generatedAt).toLocaleString()} · Read-only context for period
            close
          </p>
        </div>
        <Link href={exportHref} className="rounded-md border border-rule px-3 py-1.5 text-sm">
          Export planning CSV
        </Link>
      </div>

      {pkg.sourceMismatches.length ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-medium text-amber-900">Source mismatch — review recommended</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {pkg.sourceMismatches.map((row) => (
              <li key={row.code}>{row.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {pkg.risks.length ? (
        <section className="card p-4">
          <h2 className="font-medium">Planning risks / items to review</h2>
          <ul className="mt-3 space-y-2">
            {pkg.risks.map((risk) => (
              <li key={risk.code} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="capitalize text-muted">{risk.severity}</span>
                {risk.href ? (
                  <Link href={risk.href} className="flex-1 text-sky hover:underline">
                    {risk.message}
                  </Link>
                ) : (
                  <span className="flex-1">{risk.message}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-medium">Budget vs Actual</h2>
          <div className="flex items-center gap-3">
            <AvailabilityBadge available={pkg.budgetVsActual.available} />
            <Link href={pkg.links.budgetVsActual} className="text-sm text-sky hover:underline">
              Detail report
            </Link>
          </div>
        </div>
        {pkg.budgetVsActual.available === "ready" && pkg.budgetVsActual.categories ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Section</th>
                <th className="text-right">Period actual</th>
                <th className="text-right">Period budget</th>
                <th className="text-right">Period variance</th>
                <th className="text-right">YTD actual</th>
                <th className="text-right">YTD budget</th>
                <th className="text-right">YTD variance</th>
              </tr>
            </thead>
            <tbody>
              {pkg.budgetVsActual.categories.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="text-right font-ledger">{money(row.month.actual)}</td>
                  <td className="text-right font-ledger">{money(row.month.budget)}</td>
                  <td className="text-right font-ledger">
                    {money(row.month.varianceAmount)}{" "}
                    <span className="text-xs text-muted">({varianceLabel(row.month.status)})</span>
                  </td>
                  <td className="text-right font-ledger">{money(row.ytd.actual)}</td>
                  <td className="text-right font-ledger">{money(row.ytd.budget)}</td>
                  <td className="text-right font-ledger">
                    {money(row.ytd.varianceAmount)}{" "}
                    <span className="text-xs text-muted">({varianceLabel(row.ytd.status)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-sm text-muted">No approved budget for this fiscal year.</p>
        )}
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Current forecast</h2>
          <div className="flex items-center gap-3">
            <AvailabilityBadge available={pkg.forecast.available} />
            <Link href={pkg.links.forecast} className="text-sm text-sky hover:underline">
              Forecast detail
            </Link>
          </div>
        </div>
        {pkg.forecast.available === "ready" ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Expected full-year revenue</dt>
              <dd className="font-ledger text-lg">{money(pkg.forecast.expectedRevenue ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Expected gross profit</dt>
              <dd className="font-ledger text-lg">{money(pkg.forecast.expectedGrossProfit ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Expected operating income</dt>
              <dd className="font-ledger text-lg">
                {money(pkg.forecast.expectedOperatingIncome ?? 0)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted">No published or draft forecast available.</p>
        )}
        {pkg.forecast.stale ? (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {pkg.forecast.staleMessage ?? "Forecast is stale — new actuals exist beyond the last actualized period."}
          </p>
        ) : null}
        {pkg.forecast.budgetComparison ? (
          <p className="mt-2 text-sm text-muted">
            Operating income vs budget: {money(pkg.forecast.budgetComparison.varianceAmount)} (
            {varianceLabel(pkg.forecast.budgetComparison.status)})
          </p>
        ) : null}
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">13-week cash forecast</h2>
          <div className="flex items-center gap-3">
            <AvailabilityBadge available={pkg.cash.available} />
            <Link href={pkg.links.cash} className="text-sm text-sky hover:underline">
              Cash outlook
            </Link>
          </div>
        </div>
        {pkg.cash.available === "ready" ? (
          <>
            <dl className="mt-4 grid gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Starting cash</dt>
                <dd className="font-ledger">{money(pkg.cash.startingCash ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Expected cash in</dt>
                <dd className="font-ledger">{money(pkg.cash.expectedMoneyIn ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Expected cash out</dt>
                <dd className="font-ledger">{money(pkg.cash.expectedMoneyOut ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Ending cash</dt>
                <dd className="font-ledger">{money(pkg.cash.endingCash ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Lowest cash</dt>
                <dd className="font-ledger">{money(pkg.cash.lowestCash ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">First negative week</dt>
                <dd className="font-ledger">
                  {pkg.cash.firstNegativeWeekLabel ??
                    (pkg.cash.firstNegativeWeekIndex != null
                      ? `Week ${pkg.cash.firstNegativeWeekIndex}`
                      : "None")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Runway</dt>
                <dd className="font-ledger">
                  {pkg.cash.runwayWeeks != null ? `${pkg.cash.runwayWeeks} weeks` : "—"}
                </dd>
              </div>
            </dl>
            {pkg.cash.categoryTotals?.length ? (
              <table className="data-table mt-4">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="text-right">Inflows</th>
                    <th className="text-right">Outflows</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.cash.categoryTotals.map((row) => (
                    <tr key={row.category}>
                      <td>{row.label}</td>
                      <td className="text-right font-ledger">{money(row.inflows)}</td>
                      <td className="text-right font-ledger">{money(row.outflows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {pkg.cash.sourceCoverage?.length ? (
              <p className="mt-3 text-xs text-muted">
                Source coverage:{" "}
                {pkg.cash.sourceCoverage
                  .map((row) => `${row.label} (${row.count})`)
                  .join(" · ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">Cash outlook not generated for this as-of date.</p>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-medium">Scenario analysis</h2>
          <div className="flex items-center gap-3">
            <AvailabilityBadge available={pkg.scenarios.available} />
            <Link href={pkg.links.scenarios} className="text-sm text-sky hover:underline">
              Scenarios
            </Link>
          </div>
        </div>
        {pkg.scenarios.available === "ready" && pkg.scenarios.rows ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="text-right">Revenue</th>
                <th className="text-right">Operating income</th>
                <th className="text-right">Ending cash</th>
                <th className="text-right">Lowest cash</th>
                <th>First negative week</th>
              </tr>
            </thead>
            <tbody>
              {pkg.scenarios.rows.map((row) => (
                <tr key={row.scenarioName}>
                  <td>
                    <span className="capitalize">{row.scenarioType.replace(/_/g, " ")}</span>
                    <span className="ml-2 text-muted">({row.scenarioName})</span>
                  </td>
                  <td className="text-right font-ledger">{money(row.revenue)}</td>
                  <td className="text-right font-ledger">{money(row.operatingIncome)}</td>
                  <td className="text-right font-ledger">{money(row.endingCash)}</td>
                  <td className="text-right font-ledger">{money(row.lowestCash)}</td>
                  <td>
                    {row.firstNegativeWeekIndex != null ? `Week ${row.firstNegativeWeekIndex}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-sm text-muted">No scenarios configured for the selected forecast.</p>
        )}
      </section>

      <section className="card p-4">
        <h2 className="font-medium">Source lineage</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Reporting period</dt>
            <dd>
              {pkg.lineage.reportPeriod.label} (through {pkg.lineage.reportPeriod.throughMonth.slice(0, 7)})
            </dd>
          </div>
          {pkg.lineage.budget ? (
            <div>
              <dt className="text-muted">Budget</dt>
              <dd>
                {pkg.lineage.budget.name} · {pkg.lineage.budget.versionLabel} ({pkg.lineage.budget.versionStatus})
              </dd>
            </div>
          ) : null}
          {pkg.lineage.forecast ? (
            <div>
              <dt className="text-muted">Forecast</dt>
              <dd>
                {pkg.lineage.forecast.name} · {pkg.lineage.forecast.versionLabel} (
                {pkg.lineage.forecast.versionStatus})
                {pkg.lineage.forecast.publishedAt
                  ? ` · Published ${pkg.lineage.forecast.publishedAt.slice(0, 10)}`
                  : ""}
              </dd>
            </div>
          ) : null}
          {pkg.lineage.cash ? (
            <div>
              <dt className="text-muted">Cash outlook</dt>
              <dd>As of {pkg.lineage.cash.asOfDate}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-4 text-xs text-muted">
          Planning context does not block period close and does not post adjusting entries.
        </p>
      </section>
    </div>
  );
}
