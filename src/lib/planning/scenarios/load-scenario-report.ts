import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountRow } from "@/lib/accounting/reports";
import { loadCashOutlookReport } from "@/lib/planning/cash/load-cash-outlook";
import { loadRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import { applyCashScenarioOverlay } from "./cash-overlay";
import { buildScenarioComparison } from "./comparison";
import { applyForecastScenarioOverlay } from "./forecast-overlay";
import {
  getScenario,
  listScenarioCashAdjustments,
  listScenarioDrivers,
} from "./scenario-crud";
import type {
  ScenarioCashResult,
  ScenarioComparisonReport,
  ScenarioDriverInput,
  ScenarioForecastResult,
  ScenarioPreviewInput,
} from "./types";

export async function loadScenarioForecastResult(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    forecastId: string;
    forecastVersionId: string;
    drivers: ScenarioDriverInput[];
  },
): Promise<ScenarioForecastResult> {
  const base = await loadRollingForecastReport(supabase, organizationId, {
    forecastId: input.forecastId,
    versionId: input.forecastVersionId,
  });
  const scenario = applyForecastScenarioOverlay(base, input.drivers);
  return { base, scenario, drivers: input.drivers as ScenarioForecastResult["drivers"] };
}

export async function loadScenarioCashResult(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate?: string;
    accounts: AccountRow[];
    drivers: ScenarioDriverInput[];
    cashAdjustments?: Array<{
      effectiveDate: string;
      flowKind: "inflow" | "outflow";
      amount: number;
      label: string;
      notes?: string;
    }>;
  },
): Promise<ScenarioCashResult> {
  const base = await loadCashOutlookReport(supabase, organizationId, {
    asOfDate: input.asOfDate,
    accounts: input.accounts,
  });
  const scenario = applyCashScenarioOverlay(base, input.drivers, input.cashAdjustments ?? []);
  return { base, scenario, drivers: input.drivers as ScenarioCashResult["drivers"] };
}

export async function previewScenario(
  supabase: SupabaseClient,
  organizationId: string,
  input: ScenarioPreviewInput & { accounts: AccountRow[] },
): Promise<{ forecast: ScenarioForecastResult; cash: ScenarioCashResult }> {
  const drivers =
    input.scenarioType === "base" ? [] : input.drivers;

  const [forecast, cash] = await Promise.all([
    loadScenarioForecastResult(supabase, organizationId, {
      forecastId: input.forecastId,
      forecastVersionId: input.forecastVersionId,
      drivers,
    }),
    loadScenarioCashResult(supabase, organizationId, {
      asOfDate: input.asOfDate,
      accounts: input.accounts,
      drivers,
      cashAdjustments: input.cashAdjustments,
    }),
  ]);

  return { forecast, cash };
}

export async function loadScenarioResults(
  supabase: SupabaseClient,
  organizationId: string,
  scenarioId: string,
  input: { accounts: AccountRow[]; asOfDate?: string },
): Promise<{ forecast: ScenarioForecastResult; cash: ScenarioCashResult; scenario: Awaited<ReturnType<typeof getScenario>> }> {
  const scenario = await getScenario(supabase, organizationId, scenarioId);
  const [drivers, cashAdjustments] = await Promise.all([
    listScenarioDrivers(supabase, organizationId, scenarioId),
    listScenarioCashAdjustments(supabase, organizationId, scenarioId),
  ]);

  const driverInputs: ScenarioDriverInput[] = drivers.map((row) => ({
    driverType: row.driverType,
    valueNumeric: row.valueNumeric,
    valueText: row.valueText,
    targetScope: row.targetScope,
  }));

  const [forecast, cash] = await Promise.all([
    loadScenarioForecastResult(supabase, organizationId, {
      forecastId: scenario.forecastId,
      forecastVersionId: scenario.forecastVersionId,
      drivers: driverInputs,
    }),
    loadScenarioCashResult(supabase, organizationId, {
      asOfDate: input.asOfDate,
      accounts: input.accounts,
      drivers: driverInputs,
      cashAdjustments,
    }),
  ]);

  return { forecast, cash, scenario };
}

export async function compareScenarios(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    scenarioIds: string[];
    baseScenarioId?: string | null;
    accounts: AccountRow[];
    asOfDate?: string;
  },
): Promise<ScenarioComparisonReport> {
  const results = await Promise.all(
    input.scenarioIds.map(async (scenarioId) => {
      const loaded = await loadScenarioResults(supabase, organizationId, scenarioId, {
        accounts: input.accounts,
        asOfDate: input.asOfDate,
      });
      return {
        scenarioId,
        scenarioName: loaded.scenario.name,
        scenarioType: loaded.scenario.scenarioType,
        forecast: loaded.forecast,
        cash: loaded.cash,
      };
    }),
  );

  const baseScenarioId =
    input.baseScenarioId ??
    results.find((row) => row.scenarioType === "base")?.scenarioId ??
    results[0]?.scenarioId ??
    null;

  return buildScenarioComparison({ baseScenarioId, results });
}
