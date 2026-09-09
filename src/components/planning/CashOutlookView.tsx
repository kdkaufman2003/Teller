"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { money } from "@/lib/format";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import type { CashOutlookReport } from "@/lib/planning/cash/types";
import { CATEGORY_OWNER_LABELS } from "@/lib/planning/cash/source-coverage";
import { cashAccountGroupLabel } from "@/lib/planning/cash/starting-cash";
import { routes } from "@/lib/routes";

export function CashOutlookView({ initialAsOfDate }: { initialAsOfDate: string }) {
  const [asOfDate, setAsOfDate] = useState(initialAsOfDate);
  const [report, setReport] = useState<CashOutlookReport | null>(null);
  const [expandedWeek, setExpandedWeek] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [showAdjustForm, setShowAdjustForm] = useState(false);
  const [adjLabel, setAdjLabel] = useState("");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjDate, setAdjDate] = useState(initialAsOfDate);
  const [adjFlow, setAdjFlow] = useState<"inflow" | "outflow">("inflow");
  const [adjCategory, setAdjCategory] = useState<"general" | "capex">("general");

  async function loadReport() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/planning/cash/outlook?asOfDate=${asOfDate}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setReport(data.report as CashOutlookReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load cash outlook");
      setReport(null);
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void loadReport();
  }, [asOfDate]);

  async function saveAdjustment() {
    setError("");
    try {
      const response = await fetch("/api/planning/cash/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effectiveDate: adjDate,
          flowKind: adjFlow,
          amount: Number(adjAmount),
          label: adjLabel,
          planningCategory: adjCategory,
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setShowAdjustForm(false);
      setAdjLabel("");
      setAdjAmount("");
      await loadReport();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save adjustment");
    }
  }

  const summary = report?.summary;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{planningOwnerLabel("Cash Outlook")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            13-week projection from bank balances, receivables, payables, payroll, recurring bills, purchasing, and planned capex.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">
            As of
            <input
              type="date"
              className="ml-2 rounded border px-2 py-1"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
            />
          </label>
          <Link href={routes.planning} className="text-sm text-navy underline-offset-2 hover:underline">
            Planning hub
          </Link>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : null}

      {pending && !report ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {report && summary ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryCard label="Starting cash" value={money(summary.startingCash)} />
            <SummaryCard label="Expected money in" value={money(summary.expectedMoneyIn)} />
            <SummaryCard label="Expected money out" value={money(summary.expectedMoneyOut)} />
            <SummaryCard label="Lowest projected cash" value={money(summary.lowestCash)} />
            <SummaryCard label="Ending cash (Week 13)" value={money(summary.endingCash)} />
          </div>

          {report.sourceCoverage?.length ? (
            <section className="rounded-lg border p-4 text-sm">
              <h2 className="font-medium">Source coverage</h2>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {report.sourceCoverage.map((item) => (
                  <li key={item.key} className="flex items-center gap-2 text-muted-foreground">
                    <span className="text-green-700">{item.included ? "✓" : "○"}</span>
                    <span>
                      {item.label}
                      {item.count > 0 ? ` (${item.count})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="rounded-lg border p-4 text-sm">
            <div className="font-medium">Runway</div>
            <p className="mt-1 text-muted-foreground">
              {summary.firstNegativeWeekIndex
                ? `First projected shortfall: Week ${summary.firstNegativeWeekIndex} (${summary.firstNegativeWeekLabel})`
                : "No projected cash shortfall in the next 13 weeks (13+ weeks runway)."}
            </p>
          </div>

          <section className="rounded-lg border p-4">
            <h2 className="font-medium">Starting cash breakdown (GL)</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {report.startingCash.accounts.map((account) => (
                <li key={account.accountId} className="flex justify-between">
                  <span>
                    {cashAccountGroupLabel(account.subtype, account.name)} — {account.name} ({account.code})
                  </span>
                  <span className="font-ledger">{money(account.balance)}</span>
                </li>
              ))}
              <li className="flex justify-between border-t pt-2 font-medium">
                <span>Total starting cash</span>
                <span className="font-ledger">{money(report.startingCash.total)}</span>
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">13-week outlook</h2>
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm"
                onClick={() => setShowAdjustForm((value) => !value)}
              >
                Add manual adjustment
              </button>
            </div>

            {showAdjustForm ? (
              <div className="rounded-lg border p-4 space-y-3 text-sm">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    Description
                    <input
                      className="mt-1 w-full rounded border px-2 py-1"
                      value={adjLabel}
                      onChange={(e) => setAdjLabel(e.target.value)}
                      placeholder="Owner contribution"
                    />
                  </label>
                  <label className="block">
                    Amount
                    <input
                      className="mt-1 w-full rounded border px-2 py-1"
                      type="number"
                      min="0"
                      step="0.01"
                      value={adjAmount}
                      onChange={(e) => setAdjAmount(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    Date
                    <input
                      type="date"
                      className="mt-1 w-full rounded border px-2 py-1"
                      value={adjDate}
                      onChange={(e) => setAdjDate(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    Direction
                    <select
                      className="mt-1 w-full rounded border px-2 py-1"
                      value={adjFlow}
                      onChange={(e) => setAdjFlow(e.target.value as "inflow" | "outflow")}
                    >
                      <option value="inflow">Money in</option>
                      <option value="outflow">Money out</option>
                    </select>
                  </label>
                  <label className="block">
                    Category
                    <select
                      className="mt-1 w-full rounded border px-2 py-1"
                      value={adjCategory}
                      onChange={(e) => setAdjCategory(e.target.value as "general" | "capex")}
                    >
                      <option value="general">General manual adjustment</option>
                      <option value="capex">Planned equipment / capex</option>
                    </select>
                  </label>
                </div>
                <button type="button" className="rounded-md bg-navy px-4 py-2 text-sm text-white" onClick={() => void saveAdjustment()}>
                  Save adjustment
                </button>
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Week</th>
                    <th className="px-3 py-2 text-right">Opening</th>
                    <th className="px-3 py-2 text-right">Money in</th>
                    <th className="px-3 py-2 text-right">Money out</th>
                    <th className="px-3 py-2 text-right">Net</th>
                    <th className="px-3 py-2 text-right">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {report.weeks.map((week) => (
                    <Fragment key={week.weekIndex}>
                      <tr
                        className={`border-t cursor-pointer hover:bg-muted/20 ${week.closingCash < 0 ? "bg-red-50/50" : ""}`}
                        onClick={() =>
                          setExpandedWeek(expandedWeek === week.weekIndex ? null : week.weekIndex)
                        }
                      >
                        <td className="px-3 py-2">{week.label}</td>
                        <td className="px-3 py-2 text-right font-ledger">{money(week.openingCash)}</td>
                        <td className="px-3 py-2 text-right font-ledger text-green-700">{money(week.cashIn)}</td>
                        <td className="px-3 py-2 text-right font-ledger text-red-700">{money(week.cashOut)}</td>
                        <td className="px-3 py-2 text-right font-ledger">{money(week.netChange)}</td>
                        <td className="px-3 py-2 text-right font-ledger font-medium">{money(week.closingCash)}</td>
                      </tr>
                      {expandedWeek === week.weekIndex && week.lines.length ? (
                        <tr key={`${week.weekIndex}-detail`} className="border-t bg-muted/10">
                          <td colSpan={6} className="px-6 py-3">
                            <div className="space-y-3 text-xs text-muted-foreground">
                              {Object.entries(
                                week.lines.reduce<Record<string, typeof week.lines>>((groups, line) => {
                                  const key = line.category;
                                  groups[key] = groups[key] ?? [];
                                  groups[key]!.push(line);
                                  return groups;
                                }, {}),
                              ).map(([category, lines]) => (
                                <div key={category}>
                                  <div className="font-medium text-foreground">
                                    {CATEGORY_OWNER_LABELS[category] ?? category}
                                  </div>
                                  <ul className="mt-1 space-y-1">
                                    {lines.map((line, index) => (
                                      <li key={`${line.sourceId}-${index}`} className="flex justify-between gap-4">
                                        <span>{line.explanation}{line.overdue ? " (overdue)" : ""}</span>
                                        <span className="font-ledger shrink-0">{money(line.amount)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {report.unscheduledPurchasing?.length ? (
            <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 text-sm">
              <h2 className="font-medium">Unscheduled purchasing commitments</h2>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {report.unscheduledPurchasing.map((line, index) => (
                  <li key={`unscheduled-${index}`} className="flex justify-between">
                    <span>{line.explanation}</span>
                    <span className="font-ledger">{money(line.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.beyondHorizon.length ? (
            <section className="rounded-lg border p-4 text-sm">
              <h2 className="font-medium">Beyond 13 weeks</h2>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {report.beyondHorizon.map((line, index) => (
                  <li key={`beyond-${index}`} className="flex justify-between">
                    <span>{line.explanation}</span>
                    <span className="font-ledger">{money(line.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.warnings.length ? (
            <section className="rounded-lg border p-4 text-sm">
              <h2 className="font-medium">Notes</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                {report.warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold font-ledger">{value}</div>
    </div>
  );
}
