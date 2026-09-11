"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TaxNav } from "@/components/TaxNav";
import { routes } from "@/lib/routes";

type TaxSummary = {
  taxableSales: number;
  exemptSales: number;
  nonTaxableSales: number;
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  taxAdjustments: number;
  authorityPayments: number;
  netLiabilityChange: number;
  needsReviewCount: number;
};

type Readiness = {
  status: string;
  blockingReasons: string[];
  exceptionCount: number;
};

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function defaultRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  };
}

export function TaxReportsView() {
  const initial = useMemo(() => defaultRange(), []);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [summary, setSummary] = useState<TaxSummary | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadSummary() {
    setLoading(true);
    setMessage("");
    const params = new URLSearchParams({
      report: "summary",
      startDate,
      endDate,
      includeReadiness: "true",
    });
    const response = await fetch(`/api/reports/tax?${params.toString()}`);
    const data = await response.json();
    setLoading(false);
    if (!response.ok) {
      setMessage(data.error || "Could not load tax summary");
      setSummary(null);
      return;
    }
    setSummary(data.report as TaxSummary);
    setReadiness(data.readiness as Readiness);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setMessage("");
      const params = new URLSearchParams({
        report: "summary",
        startDate: initial.startDate,
        endDate: initial.endDate,
        includeReadiness: "true",
      });
      const response = await fetch(`/api/reports/tax?${params.toString()}`);
      const data = await response.json();
      if (cancelled) return;
      setLoading(false);
      if (!response.ok) {
        setMessage(data.error || "Could not load tax summary");
        setSummary(null);
        return;
      }
      setSummary(data.report as TaxSummary);
      setReadiness(data.readiness as Readiness);
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.startDate, initial.endDate]);

  async function downloadPackage() {
    const params = new URLSearchParams({ startDate, endDate });
    const response = await fetch(`/api/reports/tax/accountant-package?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Export failed");
      return;
    }
    for (const file of data.files as Array<{ filename: string; content: string }>) {
      const blob = new Blob([file.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename.endsWith(".csv") || file.filename.endsWith(".txt") ? file.filename : `${file.filename}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  }

  const reportLinks = [
    { label: "Sales tax detail", report: "sales_detail" },
    { label: "Use tax detail", report: "use_detail" },
    { label: "Liability rollforward", report: "rollforward" },
    { label: "GL reconciliation", report: "gl_reconciliation" },
    { label: "Exempt transactions", report: "exempt" },
    { label: "Needs review", report: "needs_review" },
    { label: "Tax payments", report: "payments" },
    { label: "Adjustments", report: "adjustments" },
    { label: "Jurisdiction summary", report: "jurisdictions" },
    { label: "Authority summary", report: "authorities" },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <TaxNav />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Tax reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Posted tax subledger and filing data. Date basis: tax transaction date.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href={routes.taxSettings} className="underline">
            Tax overview
          </Link>
          <Link href={routes.taxPeriods} className="underline">
            Filing periods
          </Link>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-4">
        <label className="text-sm">
          Start date
          <input
            type="date"
            className="mt-1 w-full rounded border px-2 py-1"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label className="text-sm">
          End date
          <input
            type="date"
            className="mt-1 w-full rounded border px-2 py-1"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>
        <div className="flex items-end gap-2 md:col-span-2">
          <button
            type="button"
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
            onClick={() => void loadSummary()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => void downloadPackage()}>
            Download accountant package
          </button>
        </div>
      </div>

      {message ? <p className="text-sm text-destructive">{message}</p> : null}

      {readiness ? (
        <div className="rounded-lg border p-4">
          <h2 className="font-medium">Accountant readiness</h2>
          <p className="mt-1 text-sm capitalize">Status: {readiness.status.replace(/_/g, " ")}</p>
          {readiness.blockingReasons.length ? (
            <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
              {readiness.blockingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No blocking issues for the selected period.</p>
          )}
        </div>
      ) : null}

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Tax collected / accrued", summary.salesTaxAccrued + summary.useTaxAccrued],
            ["Tax paid", summary.authorityPayments],
            ["Net change", summary.netLiabilityChange],
            ["Taxable sales", summary.taxableSales],
            ["Exempt sales", summary.exemptSales],
            ["Needs review items", summary.needsReviewCount],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-1 text-xl font-semibold">
                {typeof value === "number" && label !== "Needs review items" ? `$${money(value)}` : String(value)}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border p-4">
        <h2 className="font-medium">Detailed reports</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {reportLinks.map((item) => (
            <li key={item.report}>
              <a
                className="text-sm underline"
                href={`/api/reports/tax?report=${item.report}&startDate=${startDate}&endDate=${endDate}&format=csv`}
              >
                {item.label} (CSV)
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
