import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { listBudgetLines } from "@/lib/planning/budgets/budget-crud";
import { recordPlanningAuditEvent } from "@/lib/planning/budgets/audit";
import { applyForecastAssumptions, serializeAssumptionPreview } from "./assumption-engine";
import { parseAssumptionRecord } from "./assumption-validation";
import {
  bulkUpsertForecastLines,
  getForecastVersion,
  listForecastAssumptions,
  listForecastLines,
  loadPlanningAccountsForForecast,
} from "./forecast-crud";
import { assertForecastLinesEditable } from "./lifecycle";
import {
  resolveActualCutoffMonth,
  rollingForwardMonths,
} from "./periods";
import type { ForecastVersionStatus } from "./types";
import { BASELINE_SOURCE_KINDS } from "./types";

function cellKey(accountId: string, periodMonth: string): string {
  return `${accountId}::${periodMonth}`;
}

export async function loadForecastBaselineMap(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    versionId: string;
    forwardMonths: string[];
    sourceBudgetVersionId?: string | null;
  },
): Promise<Map<string, number>> {
  const baseline = new Map<string, number>();

  if (input.sourceBudgetVersionId) {
    const budgetLines = await listBudgetLines(
      supabase,
      input.organizationId,
      input.sourceBudgetVersionId,
    );
    for (const periodMonth of input.forwardMonths) {
      for (const line of budgetLines) {
        const budgetMonth = `${Number(periodMonth.slice(0, 4))}-${line.period_month.slice(5, 7)}-01`;
        if (budgetMonth !== periodMonth) continue;
        const key = cellKey(line.account_id as string, periodMonth);
        baseline.set(key, roundMoney(Number(line.amount)));
      }
    }
  }

  const lines = await listForecastLines(supabase, input.organizationId, input.versionId);
  for (const line of lines) {
    const sourceKind = line.source_kind as string;
    const key = cellKey(line.account_id as string, line.period_month as string);
    if (BASELINE_SOURCE_KINDS.includes(sourceKind as "budget" | "clone")) {
      baseline.set(key, roundMoney(Number(line.amount)));
      continue;
    }
    if (sourceKind === "assumption") {
      const metadata = (line.metadata as Record<string, unknown> | undefined) ?? {};
      if (metadata.baselineAmount != null) {
        baseline.set(key, roundMoney(Number(metadata.baselineAmount)));
      }
    }
  }

  return baseline;
}

export function loadManualOverrideMap(
  lines: Array<{ account_id: string; period_month: string; amount: number; source_kind: string }>,
  forwardMonths: string[],
): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const line of lines) {
    if (line.source_kind !== "manual") continue;
    if (!forwardMonths.includes(line.period_month as string)) continue;
    overrides.set(
      cellKey(line.account_id as string, line.period_month as string),
      roundMoney(Number(line.amount)),
    );
  }
  return overrides;
}

export async function previewForecastAssumptions(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
  },
) {
  const version = await getForecastVersion(supabase, input.organizationId, input.versionId);
  const forecast = version.teller_forecasts as {
    id: string;
    anchor_month: string;
    horizon_months: number;
  };
  if (forecast.id !== input.forecastId) {
    throw new Error("Version does not belong to this forecast");
  }

  const anchorMonth = forecast.anchor_month as string;
  const forwardMonths = rollingForwardMonths(anchorMonth, Number(forecast.horizon_months));
  const actualCutoffMonth = resolveActualCutoffMonth(
    version.actual_cutoff_month as string | null,
    anchorMonth,
  );

  const [accounts, assumptionRows, lines] = await Promise.all([
    loadPlanningAccountsForForecast(supabase, input.organizationId),
    listForecastAssumptions(supabase, input.organizationId, input.versionId),
    listForecastLines(supabase, input.organizationId, input.versionId),
  ]);

  const assumptions = assumptionRows.map((row) => parseAssumptionRecord(row as Record<string, unknown>));
  const baseline = await loadForecastBaselineMap(supabase, {
    organizationId: input.organizationId,
    versionId: input.versionId,
    forwardMonths,
    sourceBudgetVersionId: version.source_budget_version_id as string | null,
  });
  const manualOverrides = loadManualOverrideMap(
    lines.map((line) => ({
      account_id: line.account_id as string,
      period_month: line.period_month as string,
      amount: Number(line.amount),
      source_kind: line.source_kind as string,
    })),
    forwardMonths,
  );

  const pnlAccounts = accounts.filter((account) =>
    ["revenue", "cogs", "expense"].includes(account.type),
  );

  const result = applyForecastAssumptions({
    accounts: pnlAccounts,
    forwardMonths,
    actualCutoffMonth,
    baseline,
    manualOverrides,
    assumptions,
  });

  return serializeAssumptionPreview(result);
}

export async function refreshForecastFromAssumptions(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
    actorId?: string | null;
  },
) {
  const version = await getForecastVersion(supabase, input.organizationId, input.versionId);
  const forecast = version.teller_forecasts as {
    id: string;
    anchor_month: string;
    horizon_months: number;
  };
  if (forecast.id !== input.forecastId) {
    throw new Error("Version does not belong to this forecast");
  }

  assertForecastLinesEditable(
    version.status as ForecastVersionStatus,
    Boolean(version.is_immutable),
  );

  const anchorMonth = forecast.anchor_month as string;
  const forwardMonths = rollingForwardMonths(anchorMonth, Number(forecast.horizon_months));
  const actualCutoffMonth = resolveActualCutoffMonth(
    version.actual_cutoff_month as string | null,
    anchorMonth,
  );

  const [accounts, assumptionRows, lines] = await Promise.all([
    loadPlanningAccountsForForecast(supabase, input.organizationId),
    listForecastAssumptions(supabase, input.organizationId, input.versionId),
    listForecastLines(supabase, input.organizationId, input.versionId),
  ]);

  const assumptions = assumptionRows.map((row) => parseAssumptionRecord(row as Record<string, unknown>));
  const baseline = await loadForecastBaselineMap(supabase, {
    organizationId: input.organizationId,
    versionId: input.versionId,
    forwardMonths,
    sourceBudgetVersionId: version.source_budget_version_id as string | null,
  });
  const manualOverrides = loadManualOverrideMap(
    lines.map((line) => ({
      account_id: line.account_id as string,
      period_month: line.period_month as string,
      amount: Number(line.amount),
      source_kind: line.source_kind as string,
    })),
    forwardMonths,
  );

  const pnlAccounts = accounts.filter((account) =>
    ["revenue", "cogs", "expense"].includes(account.type),
  );

  const result = applyForecastAssumptions({
    accounts: pnlAccounts,
    forwardMonths,
    actualCutoffMonth,
    baseline,
    manualOverrides,
    assumptions,
  });

  await supabase
    .from("teller_forecast_lines")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("forecast_version_id", input.versionId)
    .eq("source_kind", "assumption");

  const manualLines = result.linesToPersist.filter((line) => line.sourceKind === "manual");
  const assumptionLines = result.linesToPersist.filter((line) => line.sourceKind === "assumption");
  const baselineLines = result.linesToPersist.filter(
    (line) => line.sourceKind !== "manual" && line.sourceKind !== "assumption",
  );

  const persisted = await bulkUpsertForecastLines(supabase, {
    organizationId: input.organizationId,
    forecastId: input.forecastId,
    versionId: input.versionId,
    lines: [...assumptionLines, ...baselineLines.filter((line) => {
      const key = cellKey(line.accountId, line.periodMonth);
      return !manualOverrides.has(key);
    })],
    actorId: input.actorId,
    skipAudit: true,
  });

  if (manualLines.length) {
    await bulkUpsertForecastLines(supabase, {
      organizationId: input.organizationId,
      forecastId: input.forecastId,
      versionId: input.versionId,
      lines: manualLines,
      actorId: input.actorId,
      skipAudit: true,
    });
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_refreshed",
    entityKind: "forecast_version",
    entityId: input.versionId,
    payload: {
      assumptionCount: assumptions.length,
      linesCalculated: result.linesToPersist.length,
      linesPersisted: persisted.saved + manualLines.length,
    },
  });

  return {
    saved: persisted.saved + manualLines.length,
    summary: result.summary,
  };
}

export async function clearForecastOverride(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
    accountId: string;
    periodMonth: string;
    actorId?: string | null;
  },
) {
  const version = await getForecastVersion(supabase, input.organizationId, input.versionId);
  const forecast = version.teller_forecasts as { id: string };
  if (forecast.id !== input.forecastId) {
    throw new Error("Version does not belong to this forecast");
  }
  assertForecastLinesEditable(
    version.status as ForecastVersionStatus,
    Boolean(version.is_immutable),
  );

  const { error } = await supabase
    .from("teller_forecast_lines")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("forecast_version_id", input.versionId)
    .eq("account_id", input.accountId)
    .eq("period_month", input.periodMonth)
    .eq("source_kind", "manual");

  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_override_cleared",
    entityKind: "forecast_version",
    entityId: input.versionId,
    payload: { accountId: input.accountId, periodMonth: input.periodMonth },
  });
}

export async function saveManualForecastOverride(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
    accountId: string;
    periodMonth: string;
    amount: number;
    actorId?: string | null;
  },
) {
  return bulkUpsertForecastLines(supabase, {
    organizationId: input.organizationId,
    forecastId: input.forecastId,
    versionId: input.versionId,
    lines: [
      {
        accountId: input.accountId,
        periodMonth: input.periodMonth,
        amount: input.amount,
        sourceKind: "manual",
        notes: "Manual override",
      },
    ],
    actorId: input.actorId,
  });
}
