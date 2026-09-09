"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { money } from "@/lib/format";
import type { PlanningDashboardReport } from "@/lib/planning/dashboard/types";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";

function VarianceNote({ amount, label }: { amount?: number; label?: string }) {
  if (amount == null || Math.abs(amount) < 0.01) {
    return <p className="mt-1 text-xs text-muted-foreground">On plan</p>;
  }
  const sign = amount > 0 ? "+" : "";
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {sign}
      {money(amount)} {label ?? "vs plan"}
    </p>
  );
}

function DashboardCard({
  title,
  href,
  children,
  emphasis,
}: {
  title: string;
  href: string;
  children: ReactNode;
  emphasis?: "warn" | "critical" | "neutral";
}) {
  const border =
    emphasis === "critical"
      ? "border-red-300 bg-red-50"
      : emphasis === "warn"
        ? "border-amber-300 bg-amber-50"
        : "border-border bg-card";
  return (
    <Link
      href={href}
      className={`block rounded-lg border p-4 transition hover:shadow-sm ${border}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-2">{children}</div>
    </Link>
  );
}

function CashTrendChart({ weeks }: { weeks: PlanningDashboardReport["cashWeeks"] }) {
  if (!weeks.length) return null;
  const min = Math.min(...weeks.map((week) => week.closingCash));
  const max = Math.max(...weeks.map((week) => week.closingCash));
  const span = Math.max(max - min, 1);

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-medium">13-week projected closing cash</h2>
      <div className="mt-4 flex h-32 items-end gap-1">
        {weeks.map((week) => {
          const height = Math.max(8, ((week.closingCash - min) / span) * 100);
          const negative = week.closingCash < 0;
          return (
            <div key={week.weekIndex} className="flex flex-1 flex-col items-center gap-1">
              <div
                className={`w-full rounded-t ${negative ? "bg-red-500" : "bg-navy/80"}`}
                style={{ height: `${height}%` }}
                title={`${week.label}: ${money(week.closingCash)}`}
              />
              <span className="text-[10px] text-muted-foreground">{week.weekIndex}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PlanningDashboardView({ initialAsOfDate }: { initialAsOfDate: string }) {
  const [dashboard, setDashboard] = useState<PlanningDashboardReport | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);

  useEffect(() => {
    setPending(true);
    setError("");
    void fetch(`/api/planning/dashboard?asOfDate=${initialAsOfDate}`)
      .then((response) => response.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setDashboard(data.dashboard as PlanningDashboardReport);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not load dashboard");
        setDashboard(null);
      })
      .finally(() => setPending(false));
  }, [initialAsOfDate]);

  if (pending && !dashboard) {
    return <p className="text-sm text-muted-foreground">Loading planning dashboard…</p>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        {error}
      </div>
    );
  }

  if (!dashboard) return null;

  const vsPlanAmount =
    dashboard.vsPlan.available === "ready" && dashboard.vsPlan.direction !== "on_plan"
      ? dashboard.vsPlan.variance?.amount
      : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Planning</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your decision summary — ahead or behind plan, expected finish, and cash outlook.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">As of {dashboard.asOfDate}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <DashboardCard title={planningOwnerLabel("Vs Plan")} href={dashboard.vsPlan.href}>
          {dashboard.vsPlan.available === "ready" ? (
            <>
              <p className="text-2xl font-semibold">
                {vsPlanAmount != null ? money(Math.abs(vsPlanAmount)) : "On Plan"}{" "}
                <span className="text-base font-medium">
                  {dashboard.vsPlan.headline}
                </span>
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Actual operating income {money(dashboard.vsPlan.actual ?? 0)}
              </p>
              <p className="text-sm text-muted-foreground">
                Plan {money(dashboard.vsPlan.plan ?? 0)}
                {dashboard.vsPlan.throughMonthLabel
                  ? ` · through ${dashboard.vsPlan.throughMonthLabel}`
                  : ""}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No plan yet — create a budget to compare.</p>
          )}
        </DashboardCard>

        <DashboardCard title="Expected Revenue" href={dashboard.expectedRevenue.href}>
          {dashboard.expectedRevenue.available === "ready" ? (
            <>
              <p className="text-2xl font-semibold">{money(dashboard.expectedRevenue.value ?? 0)}</p>
              <VarianceNote
                amount={dashboard.expectedRevenue.vsPlan?.amount}
                label="vs plan"
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No forecast yet.</p>
          )}
        </DashboardCard>

        <DashboardCard title="Expected Operating Income" href={dashboard.expectedOperatingIncome.href}>
          {dashboard.expectedOperatingIncome.available === "ready" ? (
            <>
              <p className="text-2xl font-semibold">
                {money(dashboard.expectedOperatingIncome.value ?? 0)}
              </p>
              <VarianceNote
                amount={dashboard.expectedOperatingIncome.vsPlan?.amount}
                label="vs plan"
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No forecast yet.</p>
          )}
        </DashboardCard>

        <DashboardCard title="13-Week Cash Outlook" href={dashboard.cashOutlook.href}>
          {dashboard.cashOutlook.available === "ready" ? (
            <>
              <p className="text-2xl font-semibold">{money(dashboard.cashOutlook.endingCash ?? 0)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Expected ending cash</p>
              {dashboard.cashOutlook.startingCash != null ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Starting cash {money(dashboard.cashOutlook.startingCash)}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Cash outlook unavailable.</p>
          )}
        </DashboardCard>

        <DashboardCard
          title="Lowest Projected Cash"
          href={dashboard.lowestCash.href}
          emphasis={
            dashboard.lowestCash.shortfall
              ? "critical"
              : (dashboard.lowestCash.lowestCash ?? 0) < (dashboard.cashOutlook.startingCash ?? 0) * 0.5
                ? "warn"
                : "neutral"
          }
        >
          {dashboard.lowestCash.available === "ready" ? (
            <>
              <p className="text-2xl font-semibold">{money(dashboard.lowestCash.lowestCash ?? 0)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {dashboard.lowestCash.lowestCashDate
                  ? `Week of ${dashboard.lowestCash.lowestCashDate}`
                  : dashboard.lowestCash.lowestCashWeekIndex
                    ? `Week ${dashboard.lowestCash.lowestCashWeekIndex}`
                    : "Within horizon"}
              </p>
              {dashboard.lowestCash.firstNegativeWeekIndex != null ? (
                <p className="mt-2 text-sm font-medium text-red-800">
                  Projected shortfall: {dashboard.lowestCash.firstNegativeWeekLabel ?? `Week ${dashboard.lowestCash.firstNegativeWeekIndex}`}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No projected shortfall</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Cash outlook unavailable.</p>
          )}
        </DashboardCard>

        {dashboard.downside.exists ? (
          <DashboardCard title="Downside Outlook" href={dashboard.downside.href}>
            <p className="text-2xl font-semibold">{money(dashboard.downside.endingCash ?? 0)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Downside ending cash</p>
            {dashboard.downside.endingCashDelta != null ? (
              <VarianceNote amount={dashboard.downside.endingCashDelta} label="vs base" />
            ) : null}
          </DashboardCard>
        ) : (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Downside Outlook
            </p>
            <p className="mt-2 text-sm text-muted-foreground">No downside scenario</p>
            <Link
              href={dashboard.downside.createHref}
              className="mt-2 inline-block text-sm text-navy underline"
            >
              Create Downside Scenario
            </Link>
          </div>
        )}
      </div>

      {dashboard.cashWeeks.length ? <CashTrendChart weeks={dashboard.cashWeeks} /> : null}

      {dashboard.attention.length ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Needs Attention</h2>
          <ul className="space-y-2">
            {dashboard.attention.map((item) => (
              <li
                key={item.code}
                className={`rounded-lg border px-4 py-3 text-sm ${
                  item.severity === "critical"
                    ? "border-red-200 bg-red-50 text-red-900"
                    : item.severity === "warn"
                      ? "border-amber-200 bg-amber-50 text-amber-950"
                      : "border-border bg-muted/30"
                }`}
              >
                {item.href ? (
                  <Link href={item.href} className="hover:underline">
                    {item.message}
                  </Link>
                ) : (
                  item.message
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          {dashboard.quickActions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted/40"
            >
              {action.label}
            </Link>
          ))}
        </div>
      </section>

      {(dashboard.budget.available === "ready" || dashboard.forecast.available === "ready") && (
        <p className="text-xs text-muted-foreground">
          {dashboard.budget.available === "ready"
            ? `Plan: ${dashboard.budget.budgetName} (${dashboard.budget.versionLabel})`
            : null}
          {dashboard.budget.available === "ready" && dashboard.forecast.available === "ready" ? " · " : null}
          {dashboard.forecast.available === "ready"
            ? `Forecast: ${dashboard.forecast.forecastName} (${dashboard.forecast.versionLabel})`
            : null}
          {dashboard.cash.available === "ready" ? ` · Cash as of ${dashboard.cash.asOfDate}` : null}
        </p>
      )}
    </div>
  );
}
