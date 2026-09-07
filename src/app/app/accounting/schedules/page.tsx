"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  routes,
  scheduleNewPath,
} from "@/lib/routes";
import type { ScheduleHubSummary } from "@/lib/accounting/schedules/schedule-summary";

export default function SchedulesHubPage() {
  const [summary, setSummary] = useState<ScheduleHubSummary | null>(null);
  const [schemaReady, setSchemaReady] = useState(true);

  useEffect(() => {
    void Promise.all([
      fetch("/api/accounting/schedules/summary").then((r) => r.json()),
      fetch("/api/accounting/schedules").then((r) => r.json()),
    ]).then(([summaryData, listData]) => {
      setSummary((summaryData as { summary?: ScheduleHubSummary }).summary ?? null);
      setSchemaReady((listData as { schemaReady?: boolean }).schemaReady !== false);
    });
  }, []);

  const cards = summary
    ? [
        { label: "Active prepaids", value: summary.activePrepaids, href: routes.accountingSchedulesPrepaids },
        { label: "Active accruals", value: summary.activeAccruals, href: routes.accountingSchedulesAccruals },
        { label: "Deferred revenue", value: summary.activeDeferredRevenue, href: routes.accountingSchedulesRevenue },
        { label: "Due this period", value: summary.dueThisPeriod, href: routes.accountingSchedules },
        { label: "Overdue", value: summary.overdue, href: routes.accountingSchedules },
        { label: "Needs review", value: summary.needsReview, href: routes.accountingSchedules },
        { label: "Failed", value: summary.failed, href: routes.accountingSchedules },
      ]
    : [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Accounting schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prepaid expenses, accruals, and deferred revenue recognition — all posts flow through the general ledger.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={scheduleNewPath("prepaid_expense")} className="rounded-md bg-navy px-4 py-2 text-sm text-white">
            New schedule
          </Link>
        </div>
      </div>

      {!schemaReady ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Apply migration 027 to enable schedule storage.
        </p>
      ) : null}

      {cards.length ? (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((card) => (
            <Link key={card.label} href={card.href} className="rounded-lg border border-rule bg-paper-strong p-4 hover:border-navy">
              <p className="text-xs uppercase tracking-wide text-muted">{card.label}</p>
              <p className="font-ledger mt-2 text-3xl text-navy">{card.value}</p>
            </Link>
          ))}
        </section>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        <li>
          <Link className="block rounded-lg border p-4 hover:bg-muted/50" href={routes.accountingSchedulesPrepaids}>
            <strong>Prepaid schedules</strong>
            <p className="mt-1 text-sm text-muted-foreground">Straight-line expense recognition from prepaid assets.</p>
          </Link>
        </li>
        <li>
          <Link className="block rounded-lg border p-4 hover:bg-muted/50" href={routes.accountingSchedulesAccruals}>
            <strong>Accrual schedules</strong>
            <p className="mt-1 text-sm text-muted-foreground">Recurring expense accruals with optional auto-reversal.</p>
          </Link>
        </li>
        <li>
          <Link className="block rounded-lg border p-4 hover:bg-muted/50" href={routes.accountingSchedulesRevenue}>
            <strong>Deferred revenue</strong>
            <p className="mt-1 text-sm text-muted-foreground">Recognize customer deposit liability over time.</p>
          </Link>
        </li>
        <li>
          <Link className="block rounded-lg border p-4 hover:bg-muted/50" href={routes.accountingRecurringJournals}>
            <strong>Recurring journals</strong>
            <p className="mt-1 text-sm text-muted-foreground">Automated adjusting entries.</p>
          </Link>
        </li>
      </ul>
    </div>
  );
}
