"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TaxNav } from "@/components/TaxNav";
import { attentionSeverityLabel } from "@/lib/accounting/tax/owner";
import type { TaxOwnerSummary } from "@/lib/accounting/tax/owner";
import { formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";

export function TaxOverviewView() {
  const [summary, setSummary] = useState<TaxOwnerSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/tax/overview")
      .then((response) => response.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setSummary(data as TaxOwnerSummary);
      })
      .catch(() => setError("Could not load tax overview"));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <TaxNav />
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <TaxNav />
        <p className="text-muted text-sm">Loading tax overview…</p>
      </div>
    );
  }

  if (!summary.schemaReady) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <TaxNav />
        <header className="page-header">
          <h1>Tax</h1>
          <p className="text-muted">Tax accounting is not available in this environment yet.</p>
        </header>
      </div>
    );
  }

  if (!summary.configured) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <TaxNav />
        <header className="page-header">
          <h1>Tax</h1>
          <p className="text-muted">Based on your Teller records, tax is not configured yet.</p>
        </header>
        <div className="card space-y-3 p-6">
          <h2 className="text-lg font-medium">Tax isn&apos;t configured yet</h2>
          <p className="text-muted text-sm">
            Set up tax registration, payable account, and rates before tracking liability and payments.
          </p>
          <Link href={routes.taxConfigure} className="btn btn-primary inline-flex">
            Set up tax
          </Link>
        </div>
      </div>
    );
  }

  const showZeroActivity = summary.configured && !summary.hasActivity;
  const primaryAction = summary.nextPeriod
    ? {
        href: `${routes.taxPeriods}/${summary.nextPeriod.id}`,
        label:
          summary.nextPeriod.remaining > 0 ? "Record payment" : "Review filing period",
      }
    : summary.attentionCount > 0
      ? { href: routes.taxReports, label: "Review tax issues" }
      : { href: routes.taxReports, label: "View tax reports" };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <TaxNav />

      <header className="page-header">
        <h1>Tax</h1>
        <p className="text-muted">
          Based on your Teller records · Setup: {summary.setupStatusLabel} · As of{" "}
          {formatDate(summary.asOfDate)}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <section className="card p-4" aria-label="Tax owed">
          <h2 className="text-muted text-sm">Tax owed</h2>
          <p className="mt-1 text-2xl font-semibold">{money(summary.taxOwed.amount)}</p>
          <p className="text-muted mt-1 text-xs">Remaining on open and filed periods</p>
        </section>

        <section className="card p-4" aria-label="Tax paid">
          <h2 className="text-muted text-sm">Tax paid</h2>
          <p className="mt-1 text-2xl font-semibold">{money(summary.taxPaid.amount)}</p>
          <p className="text-muted mt-1 text-xs">
            Authority payments {formatDate(summary.taxPaid.scopeStart)} –{" "}
            {formatDate(summary.taxPaid.scopeEnd)}
          </p>
        </section>

        <section className="card p-4" aria-label="Next filing period">
          <h2 className="text-muted text-sm">Next filing period</h2>
          {summary.nextPeriod ? (
            <>
              <p className="mt-1 text-lg font-semibold">
                {summary.nextPeriod.state ?? "Tax"} · {formatDate(summary.nextPeriod.periodStart)} –{" "}
                {formatDate(summary.nextPeriod.periodEnd)}
              </p>
              <p className="text-sm">{summary.nextPeriod.statusLabel}</p>
              <p className="text-muted mt-1 text-xs">
                Due date:{" "}
                {summary.nextPeriod.dueDateConfigured
                  ? formatDate(summary.nextPeriod.dueDate)
                  : "Not configured"}
              </p>
            </>
          ) : (
            <p className="mt-1 text-lg font-semibold">No upcoming period</p>
          )}
        </section>

        <section className="card p-4" aria-label="Needs attention">
          <h2 className="text-muted text-sm">Needs attention</h2>
          <p className="mt-1 text-2xl font-semibold">{summary.attentionCount}</p>
          <p className="text-muted mt-1 text-xs">Items to review or resolve</p>
        </section>
      </div>

      {summary.unappliedOverpayment.amount > 0 ? (
        <div className="card border-blue-200 bg-blue-50 p-4 text-sm">
          <strong>{money(summary.unappliedOverpayment.amount)}</strong> tax overpayment / unapplied — review
          payment allocation in filing periods.
        </div>
      ) : null}

      {showZeroActivity ? (
        <div className="card p-4 text-sm">
          Tax is configured. No tax activity has been recorded for this period based on your Teller records.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Link href={primaryAction.href} className="btn btn-primary">
          {primaryAction.label}
        </Link>
        <Link href={routes.taxReports} className="btn btn-secondary">
          View tax reports
        </Link>
        <a href="/api/reports/tax/accountant-package" className="btn btn-secondary">
          Download tax package for accountant
        </a>
        <Link href={routes.taxConfigure} className="btn btn-secondary">
          Configure tax
        </Link>
      </div>

      {summary.nextPeriod ? (
        <section className="card space-y-3 p-4">
          <h2 className="font-medium">Upcoming tax work</h2>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted">Period</span>
              <p>
                {formatDate(summary.nextPeriod.periodStart)} – {formatDate(summary.nextPeriod.periodEnd)}
              </p>
            </div>
            <div>
              <span className="text-muted">Authority</span>
              <p>{summary.nextPeriod.authorityName ?? summary.nextPeriod.state ?? "—"}</p>
            </div>
            <div>
              <span className="text-muted">Tax owed</span>
              <p>{money(summary.nextPeriod.taxOwed)}</p>
            </div>
            <div>
              <span className="text-muted">Paid / remaining</span>
              <p>
                {money(summary.nextPeriod.taxPaid)} paid · {money(summary.nextPeriod.remaining)} remaining
              </p>
            </div>
          </div>
          <Link href={`${routes.taxPeriods}/${summary.nextPeriod.id}`} className="text-sm underline">
            Open period detail
          </Link>
        </section>
      ) : null}

      {summary.statePacks.length ? (
        <section className="card space-y-2 p-4">
          <h2 className="font-medium">State configuration</h2>
          <ul className="space-y-2 text-sm">
            {summary.statePacks.map((pack) => (
              <li key={pack.state} className="flex flex-wrap items-center justify-between gap-2">
                <span>{pack.state}</span>
                <span className="text-muted">{pack.statusLabel}</span>
              </li>
            ))}
          </ul>
          {summary.presentationMode === "accountant"
            ? summary.statePacks.map((pack) => (
                <p key={`${pack.state}-detail`} className="text-muted text-xs">
                  {pack.packLabel}
                </p>
              ))
            : null}
        </section>
      ) : null}

      {summary.attentionItems.length ? (
        <section className="card space-y-3 p-4" aria-label="Tax items needing attention">
          <h2 className="font-medium">Items needing attention</h2>
          <ul className="space-y-3">
            {summary.attentionItems.map((item) => (
              <li key={item.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="text-muted text-sm">{item.description}</p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      item.severity === "critical"
                        ? "bg-red-100 text-red-800"
                        : item.severity === "needs_review"
                          ? "bg-amber-100 text-amber-900"
                          : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {attentionSeverityLabel(item.severity)}
                  </span>
                </div>
                <Link href={item.actionHref} className="mt-2 inline-block text-sm underline">
                  {item.actionLabel}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="card p-4 text-sm">
          No tax issues need attention right now based on your Teller records.
        </section>
      )}

      {summary.presentationMode === "accountant" && summary.accountantDetail ? (
        <section className="card space-y-2 p-4 text-sm">
          <h2 className="font-medium">Accountant detail</h2>
          <p>Needs-review transactions: {summary.accountantDetail.needsReviewTransactionCount}</p>
          <p>Periods loaded: {summary.accountantDetail.periodCount}</p>
          <p>Payment report rows: {summary.accountantDetail.queryBounds.paymentReportRows}</p>
        </section>
      ) : null}
    </div>
  );
}
