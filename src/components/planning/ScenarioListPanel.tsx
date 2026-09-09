"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { money } from "@/lib/format";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import type { ScenarioRecord, ScenarioType } from "@/lib/planning/scenarios/types";
import { scenarioPath, routes } from "@/lib/routes";

const TYPE_LABELS: Record<ScenarioType, string> = {
  base: "Base",
  downside: "Downside",
  upside: "Upside",
  custom: "Custom",
};

type ScenarioRow = ScenarioRecord & {
  keyResult?: { endingCash?: number; operatingIncome?: number };
};

export function ScenarioListPanel() {
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([]);
  const [schemaReady, setSchemaReady] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/planning/scenarios")
      .then((response) => response.json())
      .then(async (data) => {
        setSchemaReady(data.schemaReady !== false);
        if (data.error) setError(data.error);
        const rows = (data.scenarios ?? []) as ScenarioRecord[];
        setScenarios(rows);
      })
      .catch(() => setError("Could not load scenarios"));
  }, []);

  if (!schemaReady) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
        Apply the Phase 14H SQL patch (034-phase14h-scenarios.sql) to enable scenario planning.
      </p>
    );
  }

  if (error) {
    return <p className="text-sm text-red-700">{error}</p>;
  }

  if (!scenarios.length) {
    return (
      <p className="rounded-lg border px-4 py-6 text-sm text-muted-foreground">
        No scenarios yet. Create Base, Downside, and Upside views from a forecast version.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {scenarios.map((scenario) => (
        <li key={scenario.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <Link href={scenarioPath(scenario.id)} className="font-medium text-navy hover:underline">
              {scenario.name}
            </Link>
            <p className="text-xs text-muted-foreground">
              {TYPE_LABELS[scenario.scenarioType]} · Updated {scenario.updatedAt.slice(0, 10)}
            </p>
          </div>
          <Link href={scenarioPath(scenario.id)} className="text-sm text-navy hover:underline">
            Open
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ScenarioTypeBadge({ type }: { type: ScenarioType }) {
  return (
    <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
      {TYPE_LABELS[type]}
    </span>
  );
}

export function ScenarioSummaryCards({
  forecastSummary,
  cashSummary,
}: {
  forecastSummary?: {
    revenue: { rollingTotal: number };
    grossProfit: { rollingTotal: number };
    expenses: { rollingTotal: number };
    operatingIncome: { rollingTotal: number };
  };
  cashSummary?: {
    endingCash: number;
    lowestCash: number;
    firstNegativeWeekIndex: number | null;
    runwayWeeks: number | "13+";
  };
}) {
  if (!forecastSummary && !cashSummary) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {forecastSummary ? (
        <>
          <SummaryCard label="Expected Revenue" value={money(forecastSummary.revenue.rollingTotal)} />
          <SummaryCard label="Gross Profit" value={money(forecastSummary.grossProfit.rollingTotal)} />
          <SummaryCard label="Operating Expenses" value={money(forecastSummary.expenses.rollingTotal)} />
          <SummaryCard label="Operating Income" value={money(forecastSummary.operatingIncome.rollingTotal)} />
        </>
      ) : null}
      {cashSummary ? (
        <>
          <SummaryCard label="Ending Cash" value={money(cashSummary.endingCash)} />
          <SummaryCard label="Lowest Cash" value={money(cashSummary.lowestCash)} />
          <SummaryCard
            label="First Negative Week"
            value={
              cashSummary.firstNegativeWeekIndex != null
                ? `Week ${cashSummary.firstNegativeWeekIndex}`
                : "None"
            }
          />
          <SummaryCard
            label="Cash Runway"
            value={cashSummary.runwayWeeks === "13+" ? "13+ weeks" : `${cashSummary.runwayWeeks} weeks`}
          />
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export function ScenarioHubLink() {
  return (
    <Link href={routes.planningScenarios} className="text-sm text-navy underline-offset-2 hover:underline">
      {planningOwnerLabel("Scenarios")}
    </Link>
  );
}
