"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ScenarioBuilder, ScenarioComparisonTable } from "./ScenarioBuilder";
import { ScenarioSummaryCards, ScenarioTypeBadge } from "./ScenarioListPanel";
import type { ScenarioDriverInput, ScenarioRecord } from "@/lib/planning/scenarios/types";
import { routes } from "@/lib/routes";

export function ScenarioDetailView({ scenarioId }: { scenarioId: string }) {
  const [scenario, setScenario] = useState<ScenarioRecord | null>(null);
  const [drivers, setDrivers] = useState<ScenarioDriverInput[]>([]);
  const [results, setResults] = useState<{
    forecastSummary: {
      revenue: { rollingTotal: number };
      grossProfit: { rollingTotal: number };
      expenses: { rollingTotal: number };
      operatingIncome: { rollingTotal: number };
    };
    cashSummary: {
      endingCash: number;
      lowestCash: number;
      firstNegativeWeekIndex: number | null;
      runwayWeeks: number | "13+";
    };
  } | null>(null);
  const [comparison, setComparison] = useState<Parameters<typeof ScenarioComparisonTable>[0]["comparison"] | null>(
    null,
  );
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState("");

  async function loadScenario() {
    const response = await fetch(`/api/planning/scenarios/${scenarioId}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    setScenario(data.scenario as ScenarioRecord);
    setDrivers((data.drivers ?? []) as ScenarioDriverInput[]);
  }

  async function loadResults() {
    if (!scenario) return;
    const response = await fetch("/api/planning/scenarios/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        forecastId: scenario.forecastId,
        forecastVersionId: scenario.forecastVersionId,
        scenarioType: scenario.scenarioType,
        drivers: scenario.scenarioType === "base" ? [] : drivers,
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    setResults({
      forecastSummary: data.forecastSummary,
      cashSummary: data.cashSummary,
    });
  }

  async function loadComparison() {
    const listResponse = await fetch(
      `/api/planning/scenarios?forecastId=${scenario?.forecastId ?? ""}`,
    );
    const listData = await listResponse.json();
    const ids = ((listData.scenarios ?? []) as ScenarioRecord[])
      .filter((row) => row.forecastId === scenario?.forecastId)
      .slice(0, 4)
      .map((row) => row.id);
    if (!ids.includes(scenarioId)) ids.unshift(scenarioId);
    const params = new URLSearchParams();
    for (const id of ids.slice(0, 4)) params.append("scenarioId", id);
    const base = (listData.scenarios as ScenarioRecord[] | undefined)?.find(
      (row) => row.scenarioType === "base",
    );
    if (base) params.set("baseScenarioId", base.id);

    const response = await fetch(`/api/planning/scenarios/compare?${params.toString()}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    setComparison(data.comparison);
  }

  useEffect(() => {
    void loadScenario().catch((err) => {
      setError(err instanceof Error ? err.message : "Could not load scenario");
    });
  }, [scenarioId]);

  useEffect(() => {
    if (!scenario || editMode) return;
    void loadResults().catch((err) => {
      setError(err instanceof Error ? err.message : "Could not load results");
    });
    void loadComparison().catch(() => {
      /* comparison optional when only one scenario */
    });
  }, [scenario, drivers, editMode]);

  if (error) {
    return <p className="text-sm text-red-700">{error}</p>;
  }

  if (!scenario) {
    return <p className="text-sm text-muted-foreground">Loading scenario…</p>;
  }

  if (editMode) {
    return (
      <div className="space-y-4">
        <button type="button" className="text-sm text-navy hover:underline" onClick={() => setEditMode(false)}>
          ← Back to results
        </button>
        <ScenarioBuilder
          scenarioId={scenario.id}
          initialScenarioType={scenario.scenarioType}
          initialForecastId={scenario.forecastId}
          initialVersionId={scenario.forecastVersionId}
          initialName={scenario.name}
          initialDrivers={drivers}
          onSaved={() => {
            setEditMode(false);
            void loadScenario();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{scenario.name}</h1>
            <ScenarioTypeBadge type={scenario.scenarioType} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Source version locked at save · Updated {scenario.updatedAt.slice(0, 10)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => setEditMode(true)}
          >
            Edit drivers
          </button>
          <Link href={routes.planningScenarios} className="rounded-md border px-3 py-1.5 text-sm">
            All scenarios
          </Link>
        </div>
      </div>

      {results ? (
        <ScenarioSummaryCards
          forecastSummary={results.forecastSummary}
          cashSummary={results.cashSummary}
        />
      ) : null}

      {comparison && comparison.rows.length > 1 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Comparison</h2>
          <ScenarioComparisonTable comparison={comparison} />
        </section>
      ) : null}
    </div>
  );
}
