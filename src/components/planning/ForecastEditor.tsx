"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { money } from "@/lib/format";
import { monthLabel } from "@/lib/planning/budgets/periods";
import { canEditForecastLines, forecastStatusLabel } from "@/lib/planning/forecasts/lifecycle";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import type {
  RollingForecastCategoryRollup,
  RollingForecastReport,
} from "@/lib/planning/reports/rolling-forecast";
import { routes } from "@/lib/routes";
import {
  assumptionFormToPayload,
  ForecastAssumptionBuilder,
  type AssumptionFormState,
} from "@/components/planning/ForecastAssumptionBuilder";
import type { AssumptionPreviewSummary } from "@/lib/planning/forecasts/types";

type AccountRow = { id: string; code: string; name: string; type: string };
type VersionRow = { id: string; version_number: number; label: string; status: string };
type LineRow = { account_id: string; period_month: string; amount: number; source_kind: string };
type AssumptionRow = {
  id: string;
  name: string;
  description: string;
  assumption_kind: string;
  value_type: string;
  value_numeric: number | null;
  parameters?: Record<string, unknown>;
};

export function ForecastEditor({
  forecastId,
  forecastName,
  anchorMonth,
  horizonMonths,
  versions,
  initialVersionId,
}: {
  forecastId: string;
  forecastName: string;
  anchorMonth: string;
  horizonMonths: number;
  versions: VersionRow[];
  initialVersionId?: string;
}) {
  const router = useRouter();
  const [versionId, setVersionId] = useState(initialVersionId ?? versions[0]?.id ?? "");
  const [versionStatus, setVersionStatus] = useState(versions[0]?.status ?? "draft");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [forwardMonths, setForwardMonths] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [lineSources, setLineSources] = useState<Record<string, string>>({});
  const [assumptions, setAssumptions] = useState<AssumptionRow[]>([]);
  const [report, setReport] = useState<RollingForecastReport | null>(null);
  const [preview, setPreview] = useState<AssumptionPreviewSummary | null>(null);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const editable = canEditForecastLines(versionStatus as "draft");

  const cellKey = (accountId: string, periodMonth: string) => `${accountId}::${periodMonth}`;

  const pnlAccounts = useMemo(
    () => accounts.filter((account) => ["revenue", "cogs", "expense"].includes(account.type)),
    [accounts],
  );

  async function loadVersionData() {
    if (!versionId) return;
    const [accountsData, versionData, reportData] = await Promise.all([
      fetch("/api/accounts").then((r) => r.json()),
      fetch(`/api/planning/forecasts/${forecastId}/versions/${versionId}`).then((r) => r.json()),
      fetch(`/api/planning/reports/rolling-forecast?forecastId=${forecastId}&versionId=${versionId}`).then(
        (r) => r.json(),
      ),
    ]);
    setAccounts((accountsData as { accounts?: AccountRow[] }).accounts ?? []);
    const lines = (versionData as { lines?: LineRow[] }).lines ?? [];
    const version = (versionData as { version?: { status?: string } }).version;
    if (version?.status) setVersionStatus(version.status);
    setAssumptions((versionData as { assumptions?: AssumptionRow[] }).assumptions ?? []);
    const nextAmounts: Record<string, number> = {};
    const nextSources: Record<string, string> = {};
    for (const line of lines) {
      const key = cellKey(line.account_id, line.period_month);
      nextAmounts[key] = Number(line.amount);
      nextSources[key] = line.source_kind;
    }
    setAmounts(nextAmounts);
    setLineSources(nextSources);
    const loadedReport = (reportData as { report?: RollingForecastReport }).report ?? null;
    setReport(loadedReport);
    const months = loadedReport?.forwardMonths ?? [];
    setForwardMonths(months);
    setSelectedMonth((current) => current || months[0] || "");
    setPreview(null);
  }

  useEffect(() => {
    void loadVersionData();
  }, [forecastId, versionId]);

  async function saveOverride(accountId: string, periodMonth: string, amount: number) {
    setPending("override");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/overrides`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", accountId, periodMonth, amount }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save override");
      setLineSources((current) => ({ ...current, [cellKey(accountId, periodMonth)]: "manual" }));
      setMessage("Manual override saved");
      await loadVersionData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save override");
    } finally {
      setPending("");
    }
  }

  async function clearOverride(accountId: string, periodMonth: string) {
    setPending("clear");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/overrides`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "clear", accountId, periodMonth }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not clear override");
      setMessage("Override cleared — refresh to apply calculated values");
      await loadVersionData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear override");
    } finally {
      setPending("");
    }
  }

  async function previewImpact() {
    setPending("preview");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/preview`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Preview failed");
      setPreview(data.preview.summary as AssumptionPreviewSummary);
      setMessage("Preview ready — no changes saved yet");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPending("");
    }
  }

  async function refreshForecast() {
    setPending("refresh");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/refresh`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Refresh failed");
      setPreview(data.summary as AssumptionPreviewSummary);
      setMessage(`Forecast refreshed (${data.saved ?? 0} lines updated)`);
      await loadVersionData();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setPending("");
    }
  }

  async function addAssumption(form: AssumptionFormState) {
    setPending("assumption");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/assumptions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(assumptionFormToPayload(form)),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save assumption");
      setAssumptions((current) => [...current, data.assumption as AssumptionRow]);
      setMessage("Assumption saved — preview or refresh to apply");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save assumption");
    } finally {
      setPending("");
    }
  }

  async function deleteAssumption(assumptionId: string) {
    setPending("delete");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/assumptions?assumptionId=${assumptionId}`,
        { method: "DELETE" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not delete assumption");
      setAssumptions((current) => current.filter((entry) => entry.id !== assumptionId));
      setMessage("Assumption deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete assumption");
    } finally {
      setPending("");
    }
  }

  async function lifecycle(action: "publish" | "revision" | "archive", label?: string) {
    setPending(action);
    setError("");
    try {
      const response = await fetch(
        `/api/planning/forecasts/${forecastId}/versions/${versionId}/lifecycle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, label }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Action failed");
      if (action === "revision" && data.version?.id) {
        router.replace(`${routes.planningForecasts}/${forecastId}?version=${data.version.id}`);
        return;
      }
      setMessage(action === "publish" ? "Forecast published" : "Forecast updated");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending("");
    }
  }

  function sourceLabel(source?: string): string | null {
    if (source === "manual") return "Override";
    if (source === "assumption") return "Assumption applied";
    if (source === "budget" || source === "clone") return "Baseline";
    return null;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.planningForecasts} className="text-sm text-muted-foreground hover:underline">
            ← {planningOwnerLabel("Forecast")}s
          </Link>
          <h1 className="text-2xl font-semibold">{forecastName}</h1>
          <p className="text-sm text-muted-foreground">
            As of {monthLabel(anchorMonth)} · {horizonMonths}-month rolling horizon ·{" "}
            {forecastStatusLabel(versionStatus as "draft")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <>
              <button
                type="button"
                onClick={() => void previewImpact()}
                disabled={!!pending}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                Preview impact
              </button>
              <button
                type="button"
                onClick={() => void refreshForecast()}
                disabled={!!pending}
                className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Refresh forecast
              </button>
              <button
                type="button"
                onClick={() => void lifecycle("publish")}
                disabled={!!pending}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                Publish forecast
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void lifecycle("revision", "Updated forecast")}
              disabled={!!pending}
              className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
            >
              Update forecast
            </button>
          )}
        </div>
      </div>

      {report?.staleForecast ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p>{report.staleMessage}</p>
          {editable ? (
            <button
              type="button"
              className="mt-2 underline"
              onClick={() => void lifecycle("revision", "Updated forecast")}
            >
              Create updated forecast
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? <p className="text-sm text-green-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ["Expected Revenue", report?.summary.revenue, report?.categories.find((c) => c.category === "revenue")],
            ["Expected Gross Profit", report?.summary.grossProfit, report?.categories.find((c) => c.category === "gross_profit")],
            ["Expected Expenses", report?.summary.expenses, report?.categories.find((c) => c.category === "expense")],
            [
              "Expected Operating Income",
              report?.summary.operatingIncome,
              report?.categories.find((c) => c.category === "operating_income"),
            ],
          ] satisfies Array<
            [string, RollingForecastReport["summary"]["revenue"] | undefined, RollingForecastCategoryRollup | undefined]
          >
        ).map(([label, values, category]) => (
          <div key={label} className="rounded-lg border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 font-ledger text-lg">{money(values?.rollingTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">YTD actual {money(values?.ytdActual ?? 0)}</p>
            {category?.forecastVsBudget ? (
              <p className="text-xs text-muted-foreground">
                vs budget {money(category.forecastVsBudget.varianceAmount)}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {preview ? (
        <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
          <h2 className="font-medium">Assumption impact preview</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {(["revenue", "cogs", "expenses", "grossProfit", "operatingIncome"] as const).map((key) => (
              <div key={key}>
                <p className="text-xs uppercase text-muted-foreground">{key}</p>
                <p className="font-ledger">
                  {money(preview[key].before)} → {money(preview[key].after)}
                </p>
                <p className={preview[key].change >= 0 ? "text-green-700" : "text-red-700"}>
                  {money(preview[key].change)}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Preview only — click Refresh forecast to apply.</p>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          Version
          <select
            className="ml-2 rounded border px-2 py-1"
            value={versionId}
            onChange={(event) => setVersionId(event.target.value)}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version_number} · {version.label || forecastStatusLabel(version.status as "draft")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Forecast month
          <select
            className="ml-2 rounded border px-2 py-1"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
          >
            {forwardMonths.map((periodMonth) => (
              <option key={periodMonth} value={periodMonth}>
                {monthLabel(periodMonth)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2 text-right">YTD Actual</th>
              <th className="px-3 py-2 text-right">{monthLabel(selectedMonth)} Forecast</th>
              <th className="px-3 py-2 text-right">Rolling 12 Total</th>
            </tr>
          </thead>
          <tbody>
            {pnlAccounts.map((account) => {
              const reportRow = report?.accounts.find((row) => row.accountId === account.id);
              const key = cellKey(account.id, selectedMonth);
              const monthAmount = selectedMonth ? (amounts[key] ?? 0) : 0;
              const source = sourceLabel(lineSources[key]);
              return (
                <tr key={account.id} className="border-t">
                  <td className="px-3 py-2">
                    <div className="font-medium">{account.code}</div>
                    <div className="text-xs text-muted-foreground">{account.name}</div>
                    {source ? (
                      <div className="mt-1 text-xs text-blue-700">{source}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-ledger">
                    {money(reportRow?.ytdActual ?? 0)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {editable ? (
                      <div className="flex flex-col items-end gap-1">
                        <input
                          type="number"
                          step="0.01"
                          className="w-28 rounded border px-2 py-1 text-right font-ledger"
                          value={monthAmount || ""}
                          onChange={(event) =>
                            setAmounts((current) => ({
                              ...current,
                              [key]: Number(event.target.value || 0),
                            }))
                          }
                          onBlur={() => {
                            if (selectedMonth) {
                              void saveOverride(account.id, selectedMonth, monthAmount);
                            }
                          }}
                        />
                        {lineSources[key] === "manual" ? (
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline"
                            onClick={() => void clearOverride(account.id, selectedMonth)}
                          >
                            Use calculated value
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <span className="font-ledger">{money(monthAmount)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-ledger">
                    {money(reportRow?.rollingTotal ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="rounded-lg border p-4">
        <h2 className="text-lg font-medium">Assumptions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set growth, cost, rent, and seasonal adjustments. Preview impact before refreshing the forecast.
        </p>
        {assumptions.length ? (
          <ul className="mt-3 space-y-2">
            {assumptions.map((assumption) => (
              <li
                key={assumption.id}
                className="flex items-start justify-between gap-3 rounded border px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">{assumption.name}</div>
                  {assumption.description ? (
                    <div className="text-muted-foreground">{assumption.description}</div>
                  ) : null}
                  {assumption.value_numeric != null ? (
                    <div className="text-xs text-muted-foreground">
                      Value: {assumption.value_numeric}
                      {assumption.value_type === "percentage" ? "%" : ""}
                    </div>
                  ) : null}
                </div>
                {editable ? (
                  <button
                    type="button"
                    className="text-xs text-red-700 underline"
                    onClick={() => void deleteAssumption(assumption.id)}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No assumptions yet.</p>
        )}
        {editable ? (
          <ForecastAssumptionBuilder
            accounts={pnlAccounts}
            forwardMonths={forwardMonths}
            pending={pending === "assumption"}
            onSubmit={addAssumption}
          />
        ) : null}
      </section>
    </div>
  );
}
