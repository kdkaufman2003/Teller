"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { money } from "@/lib/format";
import { fiscalYearCalendarMonths, monthLabel } from "@/lib/planning/budgets/periods";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { formatVariancePercent, varianceStatusLabel, type VarianceAmounts } from "@/lib/planning/reports/variance";
import type { BudgetVsActualReport } from "@/lib/planning/reports/budget-vs-actual";
import { accountActivityPath, planningBudgetPath, routes } from "@/lib/routes";

type BudgetOption = {
  id: string;
  fiscal_year: number;
  name: string;
  teller_budget_versions: Array<{
    id: string;
    version_number: number;
    label: string;
    status: string;
  }>;
};

function statusClass(status: string): string {
  if (status === "favorable") return "text-green-700";
  if (status === "unfavorable" || status === "unbudgeted") return "text-red-700";
  if (status === "on_plan") return "text-muted-foreground";
  return "text-muted-foreground";
}

function VarianceCell({ budget, actual, varianceAmount, variancePercent, status }: {
  budget: number;
  actual: number;
  varianceAmount: number;
  variancePercent: number | null;
  status: string;
}) {
  return (
    <div className="space-y-0.5 text-right text-sm">
      <div className="text-muted-foreground">Plan {money(budget)}</div>
      <div className="font-ledger">Actual {money(actual)}</div>
      <div className={`font-ledger ${statusClass(status)}`}>
        {money(varianceAmount)} · {formatVariancePercent(variancePercent)}
      </div>
      <div className={`text-xs ${statusClass(status)}`}>{varianceStatusLabel(status as never)}</div>
    </div>
  );
}

export function BudgetVsActualReportView({
  initialFiscalYear,
  initialThroughMonth,
  initialVersionId,
}: {
  initialFiscalYear: number;
  initialThroughMonth: string;
  initialVersionId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [fiscalYear, setFiscalYear] = useState(initialFiscalYear);
  const [throughMonth, setThroughMonth] = useState(initialThroughMonth);
  const [versionId, setVersionId] = useState(initialVersionId ?? "");
  const [report, setReport] = useState<BudgetVsActualReport | null>(null);
  const [budgets, setBudgets] = useState<BudgetOption[]>([]);
  const [filter, setFilter] = useState<"all" | "unfavorable" | "favorable" | "unbudgeted">("all");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const months = useMemo(() => fiscalYearCalendarMonths(fiscalYear), [fiscalYear]);
  const versions = useMemo(() => {
    const budget = budgets.find((entry) => Number(entry.fiscal_year) === fiscalYear);
    return budget?.teller_budget_versions ?? [];
  }, [budgets, fiscalYear]);

  useEffect(() => {
    void fetch("/api/planning/budgets")
      .then((response) => response.json())
      .then((data) => setBudgets((data.budgets ?? []) as BudgetOption[]));
  }, []);

  useEffect(() => {
    setPending(true);
    setError("");
    const params = new URLSearchParams({ fiscalYear: String(fiscalYear), throughMonth });
    if (versionId) params.set("versionId", versionId);
    void fetch(`/api/planning/reports/budget-vs-actual?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setReport(data.report as BudgetVsActualReport);
        if (!versionId && data.report?.version?.id) setVersionId(data.report.version.id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load report"))
      .finally(() => setPending(false));
  }, [fiscalYear, throughMonth, versionId]);

  function updateQuery(next: { fiscalYear?: number; throughMonth?: string; versionId?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.fiscalYear != null) params.set("fiscalYear", String(next.fiscalYear));
    if (next.throughMonth) params.set("throughMonth", next.throughMonth);
    if (next.versionId) params.set("versionId", next.versionId);
    router.replace(`${routes.planningBudgetVsActual}?${params.toString()}`);
  }

  const filteredAccounts = (report?.accounts ?? []).filter((row) => {
    if (filter === "all") return true;
    if (filter === "unbudgeted") return row.isUnbudgeted;
    return row.ytd.status === filter;
  });

  const monthStart = throughMonth.slice(0, 7) + "-01";
  const monthEndDate = (() => {
    const year = Number(throughMonth.slice(0, 4));
    const month = Number(throughMonth.slice(5, 7));
    return `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  })();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href={routes.planning} className="text-sm text-muted-foreground hover:underline">
          ← Planning
        </Link>
        <h1 className="text-2xl font-semibold">{planningOwnerLabel("Budget vs Actual")}</h1>
        <p className="text-sm text-muted-foreground">
          Compare approved plan amounts to posted general ledger actuals.
        </p>
      </header>

      <div className="flex flex-wrap gap-3 rounded-lg border p-4 text-sm">
        <label>
          Fiscal year
          <select
            value={fiscalYear}
            onChange={(event) => {
              const nextYear = Number(event.target.value);
              setFiscalYear(nextYear);
              const nextMonth = `${nextYear}-01-01`;
              setThroughMonth(nextMonth);
              setVersionId("");
              updateQuery({ fiscalYear: nextYear, throughMonth: nextMonth, versionId: "" });
            }}
            className="ml-2 rounded border px-2 py-1"
          >
            {budgets.map((budget) => (
              <option key={budget.id} value={budget.fiscal_year}>
                FY{budget.fiscal_year}
              </option>
            ))}
          </select>
        </label>
        <label>
          Through month
          <select
            value={throughMonth}
            onChange={(event) => {
              setThroughMonth(event.target.value);
              updateQuery({ throughMonth: event.target.value });
            }}
            className="ml-2 rounded border px-2 py-1"
          >
            {months.map((periodMonth) => (
              <option key={periodMonth} value={periodMonth}>
                {monthLabel(periodMonth)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Plan version
          <select
            value={versionId}
            onChange={(event) => {
              setVersionId(event.target.value);
              updateQuery({ versionId: event.target.value });
            }}
            className="ml-2 rounded border px-2 py-1"
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version_number} · {version.label || version.status} ({version.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            className="ml-2 rounded border px-2 py-1"
          >
            <option value="all">All accounts</option>
            <option value="unfavorable">Largest unfavorable</option>
            <option value="favorable">Favorable</option>
            <option value="unbudgeted">Unbudgeted actuals</option>
          </select>
        </label>
        {report ? (
          <a
            href={`/api/planning/reports/budget-vs-actual?fiscalYear=${fiscalYear}&throughMonth=${throughMonth}&versionId=${versionId}&format=csv`}
            className="ml-auto self-end rounded-md border px-3 py-1.5"
          >
            Export CSV
          </a>
        ) : null}
      </div>

      {report?.version.isDraft ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Viewing a draft plan version — comparisons are previews, not final approved plans.
        </p>
      ) : null}

      {pending ? <p className="text-sm text-muted-foreground">Loading report…</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {report ? (
        <>
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">
              {report.version.budgetName} · v{report.version.versionNumber}
              {report.version.label ? ` · ${report.version.label}` : ""} · {report.version.status}
            </p>
            <Link href={planningBudgetPath(report.version.budgetId)} className="text-navy underline">
              Open plan
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ["Revenue vs Plan", report.summary.revenue],
                ["Gross Profit vs Plan", report.summary.grossProfit],
                ["Expenses vs Plan", report.summary.expenses],
                ["Operating Income vs Plan", report.summary.operatingIncome],
              ] satisfies Array<[string, VarianceAmounts]>
            ).map(([label, amounts]) => (
              <div key={label} className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="mt-1 font-ledger text-xl">{money(amounts.actual)}</p>
                <p className="text-sm text-muted-foreground">
                  Plan {money(amounts.budget)} · Var {money(amounts.varianceAmount)}
                </p>
              </div>
            ))}
          </div>

          {report.summary.largestUnfavorable ? (
            <p className="text-sm text-muted-foreground">
              Largest unfavorable variance: {report.summary.largestUnfavorable.code}{" "}
              {report.summary.largestUnfavorable.name} (
              {money(report.summary.largestUnfavorable.varianceAmount)})
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-right">{report.throughMonthLabel} (month)</th>
                  <th className="px-3 py-2 text-right">YTD</th>
                  <th className="px-3 py-2 text-right">Annual plan</th>
                </tr>
              </thead>
              <tbody>
                {report.categories.map((category) => (
                  <tr key={category.category} className="border-b bg-muted/10 font-medium">
                    <td className="px-3 py-2">{category.label}</td>
                    <td className="px-3 py-2">
                      <VarianceCell {...category.month} status={category.month.status} />
                    </td>
                    <td className="px-3 py-2">
                      <VarianceCell {...category.ytd} status={category.ytd.status} />
                    </td>
                    <td className="px-3 py-2 text-right font-ledger">
                      <div>{money(category.annualBudget)}</div>
                      <div className="text-muted-foreground">Actual YTD {money(category.actualYtd)}</div>
                    </td>
                  </tr>
                ))}
                {filteredAccounts.map((row) => (
                  <tr key={row.accountId} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.code}</div>
                      <div className="text-muted-foreground">{row.name}</div>
                      {row.isUnbudgeted ? (
                        <span className="text-xs text-amber-800">Unbudgeted actual</span>
                      ) : null}
                      {row.hasBudgetWithoutActual ? (
                        <span className="text-xs text-muted-foreground">Budgeted, no actual yet</span>
                      ) : null}
                      <div className="mt-1 flex gap-2 text-xs">
                        <Link
                          href={accountActivityPath(row.accountId, {
                            startDate: monthStart,
                            endDate: monthEndDate,
                            period: "month",
                          })}
                          className="text-navy underline"
                        >
                          View actuals
                        </Link>
                        <Link
                          href={planningBudgetPath(report.version.budgetId)}
                          className="text-navy underline"
                        >
                          View plan
                        </Link>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <VarianceCell {...row.month} status={row.month.status} />
                    </td>
                    <td className="px-3 py-2">
                      <VarianceCell {...row.ytd} status={row.ytd.status} />
                    </td>
                    <td className="px-3 py-2 text-right font-ledger">
                      <div>{money(row.annual.budget)}</div>
                      <div className="text-muted-foreground">Actual YTD {money(row.annual.actualYtd)}</div>
                      <div className="text-muted-foreground">Remaining {money(row.annual.remainingBudget)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
