"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TaxNav } from "@/components/TaxNav";
import { filingPeriodStatusLabel } from "@/lib/accounting/tax/owner";
import type { TaxOwnerPeriodSummary, TaxOwnerSummary } from "@/lib/accounting/tax/owner";
import { formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";

type FilingPeriodRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  filingFrequency: string;
  status: string;
  jurisdictionKey?: string | null;
  metadata?: Record<string, unknown>;
};

export function TaxFilingPeriodsView() {
  const [periods, setPeriods] = useState<FilingPeriodRow[]>([]);
  const [periodSummaries, setPeriodSummaries] = useState<Map<string, TaxOwnerPeriodSummary>>(new Map());
  const [accountantMode, setAccountantMode] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void Promise.all([
      fetch("/api/tax/filing-periods").then((response) => response.json()),
      fetch("/api/tax/overview").then((response) => response.json()),
    ])
      .then(([periodData, overviewData]) => {
        setPeriods(
          (periodData.periods ?? []).map((row: Record<string, unknown>) => ({
            id: row.id as string,
            periodStart: String(row.periodStart ?? row.period_start),
            periodEnd: String(row.periodEnd ?? row.period_end),
            filingFrequency: String(row.filingFrequency ?? row.filing_frequency),
            status: row.status as string,
            jurisdictionKey: (row.jurisdictionKey ?? row.jurisdiction_key) as string | null,
            metadata: (row.metadata as Record<string, unknown> | null) ?? {},
          })),
        );
        const overview = overviewData as TaxOwnerSummary;
        if (!("error" in overviewData)) {
          setAccountantMode(overview.presentationMode === "accountant");
          setPeriodSummaries(new Map(overview.periodSummaries.map((row) => [row.id, row])));
        }
        if (periodData.error) setMessage(periodData.error);
        setLoading(false);
      })
      .catch(() => {
        setMessage("Could not load filing periods");
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <TaxNav />
        <p className="text-muted text-sm">Loading tax periods…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <TaxNav />

      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Filing periods</h1>
          <p className="text-muted text-sm">
            Review tax owed, payments, and period status based on your Teller records.
          </p>
        </div>
        <Link href={routes.taxSettings} className="text-sm underline">
          Tax overview
        </Link>
      </div>

      {message ? <p className="text-destructive text-sm">{message}</p> : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Authority</th>
              <th className="px-3 py-2">Tax owed</th>
              <th className="px-3 py-2">Paid</th>
              <th className="px-3 py-2">Remaining</th>
              <th className="px-3 py-2">Status</th>
              {accountantMode ? <th className="px-3 py-2">GL difference</th> : null}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => {
              const summary = periodSummaries.get(period.id);
              const reconciliation = (period.metadata?.lastReconciliation ?? null) as
                | { subledgerToGlDifference?: number }
                | null;
              const difference = reconciliation?.subledgerToGlDifference ?? null;
              return (
                <tr key={period.id} className="border-t">
                  <td className="px-3 py-2">
                    {formatDate(period.periodStart)} – {formatDate(period.periodEnd)}
                  </td>
                  <td className="px-3 py-2">
                    {summary?.authorityName ?? summary?.state ?? period.jurisdictionKey ?? "—"}
                  </td>
                  <td className="px-3 py-2">{summary ? money(summary.taxOwed) : "—"}</td>
                  <td className="px-3 py-2">{summary ? money(summary.taxPaid) : "—"}</td>
                  <td className="px-3 py-2">{summary ? money(summary.remaining) : "—"}</td>
                  <td className="px-3 py-2">{filingPeriodStatusLabel(period.status)}</td>
                  {accountantMode ? (
                    <td className="px-3 py-2">{difference === null ? "—" : money(difference)}</td>
                  ) : null}
                  <td className="px-3 py-2 text-right">
                    <Link href={`${routes.taxPeriods}/${period.id}`} className="underline">
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
            {!periods.length ? (
              <tr>
                <td colSpan={accountantMode ? 8 : 7} className="text-muted px-3 py-6">
                  No filing periods yet. Generate periods from an active tax registration in tax settings.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
