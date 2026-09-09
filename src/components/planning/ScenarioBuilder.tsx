"use client";

import { useCallback, useEffect, useState } from "react";
import { money } from "@/lib/format";
import {
  DOWNSIDE_TEMPLATE_DRIVERS,
  UPSIDE_TEMPLATE_DRIVERS,
} from "@/lib/planning/scenarios/templates";
import type { ScenarioDriverInput, ScenarioType } from "@/lib/planning/scenarios/types";
import { ScenarioSummaryCards } from "./ScenarioListPanel";

type ForecastOption = {
  id: string;
  name: string;
  teller_forecast_versions?: Array<{
    id: string;
    version_number: number;
    label: string;
    status: string;
  }>;
};

const DRIVER_FIELDS: Array<{
  driverType: ScenarioDriverInput["driverType"];
  label: string;
  suffix: string;
  step?: number;
}> = [
  { driverType: "revenue_percentage", label: "Revenue", suffix: "%" },
  { driverType: "gross_margin_points", label: "Gross Margin", suffix: " points" },
  { driverType: "expense_percentage", label: "Operating Expenses", suffix: "%" },
  { driverType: "ar_days_adjustment", label: "Customers Pay", suffix: " days", step: 1 },
  { driverType: "ap_days_adjustment", label: "Bills Paid", suffix: " days", step: 1 },
  { driverType: "payroll_percentage", label: "Payroll", suffix: "%" },
  { driverType: "purchasing_percentage", label: "Purchasing", suffix: "%" },
  { driverType: "capex_percentage", label: "Planned Capex", suffix: "%" },
];

function driversForType(scenarioType: ScenarioType): ScenarioDriverInput[] {
  if (scenarioType === "downside") return [...DOWNSIDE_TEMPLATE_DRIVERS];
  if (scenarioType === "upside") return [...UPSIDE_TEMPLATE_DRIVERS];
  return DRIVER_FIELDS.map((field) => ({ driverType: field.driverType, valueNumeric: 0 }));
}

function driverMap(drivers: ScenarioDriverInput[]): Map<string, number> {
  return new Map(
    drivers.map((driver) => [driver.driverType, driver.valueNumeric ?? 0]),
  );
}

export function ScenarioBuilder({
  initialScenarioType = "downside",
  initialForecastId,
  initialVersionId,
  scenarioId,
  initialName,
  initialDrivers,
  onSaved,
}: {
  initialScenarioType?: ScenarioType;
  initialForecastId?: string;
  initialVersionId?: string;
  scenarioId?: string;
  initialName?: string;
  initialDrivers?: ScenarioDriverInput[];
  onSaved?: (scenarioId: string) => void;
}) {
  const [forecasts, setForecasts] = useState<ForecastOption[]>([]);
  const [scenarioType, setScenarioType] = useState<ScenarioType>(initialScenarioType);
  const [name, setName] = useState(initialName ?? "");
  const [forecastId, setForecastId] = useState(initialForecastId ?? "");
  const [forecastVersionId, setForecastVersionId] = useState(initialVersionId ?? "");
  const [drivers, setDrivers] = useState<ScenarioDriverInput[]>(
    initialDrivers ?? driversForType(initialScenarioType),
  );
  const [preview, setPreview] = useState<{
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
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);

  useEffect(() => {
    void fetch("/api/planning/forecasts")
      .then((response) => response.json())
      .then((data) => {
        const rows = (data.forecasts ?? []) as ForecastOption[];
        setForecasts(rows);
        if (!forecastId && rows[0]) {
          setForecastId(rows[0].id);
          const version = [...(rows[0].teller_forecast_versions ?? [])].sort(
            (a, b) => b.version_number - a.version_number,
          )[0];
          if (version) setForecastVersionId(version.id);
        }
      });
  }, [forecastId]);

  useEffect(() => {
    if (initialDrivers) return;
    setDrivers(driversForType(scenarioType));
  }, [scenarioType, initialDrivers]);

  const values = driverMap(drivers);

  const updateDriver = (driverType: ScenarioDriverInput["driverType"], raw: string) => {
    const valueNumeric = raw === "" ? 0 : Number(raw);
    setDrivers((current) => {
      const next = current.filter((row) => row.driverType !== driverType);
      next.push({ driverType, valueNumeric });
      return next;
    });
  };

  const loadPreview = useCallback(async () => {
    if (!forecastId || !forecastVersionId) return;
    setPreviewPending(true);
    setError("");
    try {
      const response = await fetch("/api/planning/scenarios/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forecastId,
          forecastVersionId,
          scenarioType,
          drivers: scenarioType === "base" ? [] : drivers,
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      setPreview(null);
    } finally {
      setPreviewPending(false);
    }
  }, [forecastId, forecastVersionId, scenarioType, drivers]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadPreview();
    }, 400);
    return () => clearTimeout(timer);
  }, [loadPreview]);

  async function saveScenario() {
    if (!forecastId || !forecastVersionId) {
      setError("Select a forecast version");
      return;
    }
    setPending(true);
    setError("");
    try {
      const payload = {
        forecastId,
        forecastVersionId,
        scenarioType,
        name: name.trim() || undefined,
        drivers: scenarioType === "base" ? [] : drivers,
      };
      const response = await fetch(
        scenarioId ? `/api/planning/scenarios/${scenarioId}` : "/api/planning/scenarios",
        {
          method: scenarioId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      onSaved?.(data.scenario.id as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save scenario");
    } finally {
      setPending(false);
    }
  }

  const selectedForecast = forecasts.find((row) => row.id === forecastId);
  const versions = [...(selectedForecast?.teller_forecast_versions ?? [])].sort(
    (a, b) => b.version_number - a.version_number,
  );

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          Scenario type
          <select
            className="mt-1 w-full rounded border px-2 py-1.5"
            value={scenarioType}
            onChange={(event) => setScenarioType(event.target.value as ScenarioType)}
            disabled={Boolean(scenarioId && scenarioType === "base")}
          >
            <option value="base">Base Plan</option>
            <option value="downside">Downside</option>
            <option value="upside">Upside</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="block text-sm">
          Name
          <input
            className="mt-1 w-full rounded border px-2 py-1.5"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={scenarioType === "downside" ? "Downside" : "Scenario name"}
          />
        </label>
        <label className="block text-sm">
          Source forecast
          <select
            className="mt-1 w-full rounded border px-2 py-1.5"
            value={forecastId}
            onChange={(event) => {
              setForecastId(event.target.value);
              const forecast = forecasts.find((row) => row.id === event.target.value);
              const version = [...(forecast?.teller_forecast_versions ?? [])].sort(
                (a, b) => b.version_number - a.version_number,
              )[0];
              setForecastVersionId(version?.id ?? "");
            }}
            disabled={Boolean(scenarioId)}
          >
            {forecasts.map((forecast) => (
              <option key={forecast.id} value={forecast.id}>
                {forecast.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Source version
          <select
            className="mt-1 w-full rounded border px-2 py-1.5"
            value={forecastVersionId}
            onChange={(event) => setForecastVersionId(event.target.value)}
            disabled={Boolean(scenarioId)}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version_number} — {version.label} ({version.status})
              </option>
            ))}
          </select>
        </label>
      </div>

      {scenarioType !== "base" ? (
        <section className="rounded-lg border p-4">
          <h2 className="text-sm font-medium">Adjustments</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Structured drivers only — no formulas. Forward forecast periods and projected cash are adjusted.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {DRIVER_FIELDS.map((field) => (
              <label key={field.driverType} className="flex items-center justify-between gap-3 text-sm">
                <span>{field.label}</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    step={field.step ?? 0.1}
                    className="w-24 rounded border px-2 py-1 text-right"
                    value={values.get(field.driverType) ?? 0}
                    onChange={(event) => updateDriver(field.driverType, event.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">{field.suffix}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      ) : (
        <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Base scenario mirrors the source forecast and cash outlook with no overlay adjustments.
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Live preview</h2>
          {previewPending ? <span className="text-xs text-muted-foreground">Calculating…</span> : null}
        </div>
        {preview ? (
          <ScenarioSummaryCards
            forecastSummary={preview.forecastSummary}
            cashSummary={preview.cashSummary}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Select a forecast version to preview results.</p>
        )}
      </section>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
          onClick={() => void saveScenario()}
          disabled={pending}
        >
          {pending ? "Saving…" : scenarioId ? "Save changes" : "Save scenario"}
        </button>
      </div>
    </div>
  );
}

export function ScenarioComparisonTable({
  comparison,
}: {
  comparison: {
    rows: Array<{
      scenarioName: string;
      scenarioType: ScenarioType;
      operatingIncome: number;
      endingCash: number;
      lowestCash: number;
      firstNegativeWeekIndex: number | null;
    }>;
    forecastMetrics: Array<{ label: string; base: number; scenario: number; delta: number }>;
    cashMetrics: Array<{ label: string; base: number; scenario: number; delta: number }>;
    deltaExplanation: Array<{ label: string; amount: number }>;
    warnings: Array<{ message: string }>;
  };
}) {
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="px-3 py-2">Scenario</th>
              <th className="px-3 py-2 text-right">Operating Income</th>
              <th className="px-3 py-2 text-right">Ending Cash</th>
              <th className="px-3 py-2 text-right">Lowest Cash</th>
              <th className="px-3 py-2 text-right">First Negative Week</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.scenarioName} className="border-b">
                <td className="px-3 py-2 font-medium">{row.scenarioName}</td>
                <td className="px-3 py-2 text-right">{money(row.operatingIncome)}</td>
                <td className="px-3 py-2 text-right">{money(row.endingCash)}</td>
                <td className="px-3 py-2 text-right">{money(row.lowestCash)}</td>
                <td className="px-3 py-2 text-right">
                  {row.firstNegativeWeekIndex != null ? `Week ${row.firstNegativeWeekIndex}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {comparison.deltaExplanation.length ? (
        <section className="rounded-lg border p-4">
          <h3 className="text-sm font-medium">Main changes vs Base</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {comparison.deltaExplanation.map((row) => (
              <li key={row.label}>
                {row.label}: {money(row.amount)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {comparison.warnings.length ? (
        <ul className="space-y-2 text-sm text-amber-800">
          {comparison.warnings.map((warning) => (
            <li key={warning.message} className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
