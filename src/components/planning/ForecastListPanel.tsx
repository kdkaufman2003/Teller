"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { forecastPath } from "@/lib/routes";
import { forecastStatusLabel } from "@/lib/planning/forecasts/lifecycle";

type ForecastRow = {
  id: string;
  name: string;
  anchor_month: string;
  horizon_months: number;
  teller_forecast_versions?: Array<{
    id: string;
    version_number: number;
    label: string;
    status: string;
    published_at?: string | null;
  }>;
};

export function ForecastListPanel() {
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const [schemaReady, setSchemaReady] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/planning/forecasts")
      .then((response) => response.json())
      .then((data) => {
        setForecasts((data.forecasts ?? []) as ForecastRow[]);
        setSchemaReady(data.schemaReady !== false);
        if (data.error) setError(data.error);
      })
      .catch(() => setError("Could not load forecasts"));
  }, []);

  if (!schemaReady) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
        Apply the Phase 14D SQL patch to enable {planningOwnerLabel("Forecast").toLowerCase()}s.
      </p>
    );
  }

  if (error) {
    return <p className="text-sm text-red-700">{error}</p>;
  }

  if (!forecasts.length) {
    return (
      <p className="rounded-lg border px-4 py-6 text-sm text-muted-foreground">
        No forecasts yet. Create your first rolling forecast to see expected revenue and costs.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {forecasts.map((forecast) => {
        const latest = [...(forecast.teller_forecast_versions ?? [])].sort(
          (a, b) => b.version_number - a.version_number,
        )[0];
        return (
          <li key={forecast.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <Link href={forecastPath(forecast.id)} className="font-medium text-navy hover:underline">
                {forecast.name}
              </Link>
              <p className="text-xs text-muted-foreground">
                As of {forecast.anchor_month?.slice(0, 7)} · {forecast.horizon_months}-month horizon
                {latest ? ` · ${forecastStatusLabel(latest.status as "draft")}` : ""}
              </p>
            </div>
            <Link href={forecastPath(forecast.id)} className="text-sm text-navy hover:underline">
              Open
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
