import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBudgetVersionForReport } from "@/lib/planning/reports/budget-vs-actual";
import { listForecasts } from "@/lib/planning/forecasts/forecast-crud";
import { listScenarios } from "@/lib/planning/scenarios/scenario-crud";

export type SelectedPlanningSources = {
  fiscalYear: number;
  throughMonth: string;
  budget: {
    budgetId: string;
    budgetName: string;
    versionId: string;
    versionLabel: string;
    versionStatus: string;
  } | null;
  forecast: {
    forecastId: string;
    forecastName: string;
    versionId: string;
    versionLabel: string;
    versionStatus: string;
    anchorMonth: string;
    sourceBudgetVersionId: string | null;
  } | null;
  downsideScenario: {
    scenarioId: string;
    scenarioName: string;
    forecastVersionId: string;
  } | null;
  baseScenario: {
    scenarioId: string;
    scenarioName: string;
  } | null;
};

type ForecastVersionRow = {
  id: string;
  version_number: number;
  label: string;
  status: string;
  published_at?: string | null;
  source_budget_version_id?: string | null;
};

function currentFiscalYear(): number {
  return new Date().getFullYear();
}

function currentThroughMonth(fiscalYear: number): string {
  const today = new Date();
  const month = `${fiscalYear}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  if (Number(month.slice(0, 4)) === fiscalYear) return month;
  return `${fiscalYear}-12-01`;
}

export function selectForecastVersion(
  versions: ForecastVersionRow[],
): ForecastVersionRow | null {
  if (!versions.length) return null;
  const published = versions
    .filter((row) => row.status === "published")
    .sort((a, b) => {
      const aTime = a.published_at ? Date.parse(a.published_at) : 0;
      const bTime = b.published_at ? Date.parse(b.published_at) : 0;
      return bTime - aTime || b.version_number - a.version_number;
    })[0];
  if (published) return published;
  const draft = versions
    .filter((row) => row.status === "draft")
    .sort((a, b) => b.version_number - a.version_number)[0];
  return draft ?? versions.sort((a, b) => b.version_number - a.version_number)[0] ?? null;
}

function mapSelectedForecast(
  forecast: {
    id: string;
    name: string;
    anchor_month: string;
  },
  version: ForecastVersionRow,
): SelectedPlanningSources["forecast"] {
  return {
    forecastId: forecast.id,
    forecastName: forecast.name,
    versionId: version.id,
    versionLabel: version.label || `Version ${version.version_number}`,
    versionStatus: version.status,
    anchorMonth: forecast.anchor_month,
    sourceBudgetVersionId: version.source_budget_version_id ?? null,
  };
}

export function selectForecastFromList(
  forecasts: Array<{
    id: string;
    name: string;
    anchor_month: string;
    teller_forecast_versions?: ForecastVersionRow[];
  }>,
): SelectedPlanningSources["forecast"] {
  for (const forecast of forecasts) {
    const published = (forecast.teller_forecast_versions ?? []).find(
      (row) => row.status === "published",
    );
    if (published) return mapSelectedForecast(forecast, published);
  }

  for (const forecast of forecasts) {
    const version = selectForecastVersion(forecast.teller_forecast_versions ?? []);
    if (version) return mapSelectedForecast(forecast, version);
  }
  return null;
}

export async function selectPlanningSources(
  supabase: SupabaseClient,
  organizationId: string,
  input?: { fiscalYear?: number; throughMonth?: string },
): Promise<SelectedPlanningSources> {
  const fiscalYear = input?.fiscalYear ?? currentFiscalYear();
  const throughMonth = input?.throughMonth ?? currentThroughMonth(fiscalYear);

  let budget: SelectedPlanningSources["budget"] = null;
  try {
    const resolved = await resolveBudgetVersionForReport(supabase, organizationId, { fiscalYear });
    budget = {
      budgetId: resolved.budget.id as string,
      budgetName: resolved.budget.name as string,
      versionId: resolved.version.id as string,
      versionLabel: (resolved.version.label as string) || `Version ${resolved.version.version_number}`,
      versionStatus: resolved.version.status as string,
    };
  } catch {
    budget = null;
  }

  const forecasts = await listForecasts(supabase, organizationId);
  const forecast = selectForecastFromList(
    forecasts as Array<{
      id: string;
      name: string;
      anchor_month: string;
      teller_forecast_versions?: ForecastVersionRow[];
    }>,
  );

  let downsideScenario: SelectedPlanningSources["downsideScenario"] = null;
  let baseScenario: SelectedPlanningSources["baseScenario"] = null;
  if (forecast) {
    try {
      const scenarios = await listScenarios(supabase, organizationId, forecast.forecastId);
      const downside = scenarios.find((row) => row.scenarioType === "downside" && row.status === "active");
      if (downside) {
        downsideScenario = {
          scenarioId: downside.id,
          scenarioName: downside.name,
          forecastVersionId: downside.forecastVersionId,
        };
      }
      const base = scenarios.find((row) => row.scenarioType === "base" && row.status === "active");
      if (base) {
        baseScenario = { scenarioId: base.id, scenarioName: base.name };
      }
    } catch {
      /* scenario schema optional for degraded dashboard */
    }
  }

  return {
    fiscalYear,
    throughMonth,
    budget,
    forecast,
    downsideScenario,
    baseScenario,
  };
}
