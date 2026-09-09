import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { recordPlanningAuditEvent } from "@/lib/planning/budgets/audit";
import { loadAccountsById } from "@/lib/planning/budgets/budget-crud";
import { isValidPeriodMonth } from "@/lib/planning/budgets/periods";
import {
  assertForecastLinesEditable,
  assertForecastVersionTransition,
} from "./lifecycle";
import { buildForecastLinesFromBudget } from "./seed-from-budget";
import { validateAssumptionInput, normalizeAssumptionInput } from "./assumption-validation";
import type {
  CreateForecastInput,
  ForecastAssumptionInput,
  ForecastAssumptionKind,
  ForecastAssumptionValueType,
  ForecastBaselineKind,
  ForecastLineInput,
  ForecastVersionStatus,
} from "./types";
import { MAX_FORECAST_BULK_LINES } from "./types";

function validateForecastName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw new Error("Forecast name must be between 2 and 120 characters");
  }
}

function validateAnchorMonth(anchorMonth: string): void {
  if (!isValidPeriodMonth(anchorMonth)) {
    throw new Error("Anchor month must be the first day of a month (YYYY-MM-01)");
  }
}

function validateForecastLines(lines: ForecastLineInput[]): ForecastLineInput[] {
  if (lines.length > MAX_FORECAST_BULK_LINES) {
    throw new Error(`Cannot save more than ${MAX_FORECAST_BULK_LINES} lines at once`);
  }
  const seen = new Set<string>();
  const normalized: ForecastLineInput[] = [];
  for (const line of lines) {
    if (!isValidPeriodMonth(line.periodMonth)) {
      throw new Error(`Invalid period month: ${line.periodMonth}`);
    }
    const key = `${line.accountId}::${line.periodMonth}`;
    if (seen.has(key)) {
      throw new Error("Duplicate account and period in forecast lines");
    }
    seen.add(key);
    normalized.push({ ...line, amount: roundMoney(line.amount) });
  }
  return normalized;
}

async function assertBudgetVersionInOrg(
  supabase: SupabaseClient,
  organizationId: string,
  budgetVersionId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_budget_versions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", budgetVersionId)
    .maybeSingle();
  if (error || !data) {
    throw new Error("Budget version not found or not in your organization");
  }
}

async function assertForecastVersionInOrg(
  supabase: SupabaseClient,
  organizationId: string,
  forecastVersionId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_forecast_versions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", forecastVersionId)
    .maybeSingle();
  if (error || !data) {
    throw new Error("Forecast version not found or not in your organization");
  }
}

export async function createForecast(supabase: SupabaseClient, input: CreateForecastInput) {
  validateForecastName(input.name);
  validateAnchorMonth(input.anchorMonth);

  const baselineKind: ForecastBaselineKind = input.baselineKind ?? "blank";
  if (baselineKind === "budget" && input.sourceBudgetVersionId) {
    await assertBudgetVersionInOrg(supabase, input.organizationId, input.sourceBudgetVersionId);
  }
  if (baselineKind === "prior_forecast" && input.sourceForecastVersionId) {
    await assertForecastVersionInOrg(supabase, input.organizationId, input.sourceForecastVersionId);
  }

  const { data: forecast, error: forecastError } = await supabase
    .from("teller_forecasts")
    .insert({
      organization_id: input.organizationId,
      name: input.name.trim(),
      forecast_kind: "rolling_pl",
      anchor_month: input.anchorMonth,
      horizon_months: input.horizonMonths ?? 12,
      active: true,
    })
    .select("*")
    .single();

  if (forecastError || !forecast) {
    throw new Error(forecastError?.message || "Could not create forecast");
  }

  const { data: version, error: versionError } = await supabase
    .from("teller_forecast_versions")
    .insert({
      organization_id: input.organizationId,
      forecast_id: forecast.id,
      version_number: 1,
      label: "Version 1",
      status: "draft",
      baseline_kind: baselineKind,
      source_budget_version_id: input.sourceBudgetVersionId ?? null,
      source_forecast_version_id: input.sourceForecastVersionId ?? null,
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();

  if (versionError || !version) {
    throw new Error(versionError?.message || "Could not create initial forecast version");
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_created",
    entityKind: "forecast",
    entityId: forecast.id as string,
    payload: { name: input.name.trim(), anchorMonth: input.anchorMonth },
  });

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_version_created",
    entityKind: "forecast_version",
    entityId: version.id as string,
    payload: { forecastId: forecast.id, versionNumber: 1 },
  });

  return { forecast, version };
}

export async function createForecastWithSeed(
  supabase: SupabaseClient,
  input: CreateForecastInput & {
    accounts?: Array<{ id: string; code: string; name: string; type: string; archived: boolean }>;
  },
) {
  const result = await createForecast(supabase, input);

  if (input.baselineKind === "budget" && input.sourceBudgetVersionId) {
    const accounts =
      input.accounts ?? (await loadPlanningAccountsForForecast(supabase, input.organizationId));
    const lines = await buildForecastLinesFromBudget(supabase, {
      organizationId: input.organizationId,
      budgetVersionId: input.sourceBudgetVersionId,
      anchorMonth: input.anchorMonth,
      horizonMonths: input.horizonMonths ?? 12,
      accounts,
    });
    if (lines.length) {
      await bulkUpsertForecastLines(supabase, {
        organizationId: input.organizationId,
        forecastId: result.forecast.id as string,
        versionId: result.version.id as string,
        lines,
        actorId: input.actorId,
      });
    }
    await recordPlanningAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      eventKind: "forecast_initialized_from_budget",
      entityKind: "forecast_version",
      entityId: result.version.id as string,
      payload: { budgetVersionId: input.sourceBudgetVersionId, lineCount: lines.length },
    });
  }

  return result;
}

export async function loadPlanningAccountsForForecast(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, archived")
    .eq("organization_id", organizationId)
    .order("code");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    type: row.type as string,
    archived: Boolean(row.archived),
  }));
}

export async function listForecasts(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("teller_forecasts")
    .select("*, teller_forecast_versions(id, version_number, label, status, published_at, created_at)")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getForecastDetail(
  supabase: SupabaseClient,
  organizationId: string,
  forecastId: string,
) {
  const { data: forecast, error } = await supabase
    .from("teller_forecasts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", forecastId)
    .single();
  if (error || !forecast) throw new Error(error?.message || "Forecast not found");

  const { data: versions, error: versionsError } = await supabase
    .from("teller_forecast_versions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("forecast_id", forecastId)
    .order("version_number", { ascending: false });
  if (versionsError) throw new Error(versionsError.message);

  return { forecast, versions: versions ?? [] };
}

export async function getForecastVersion(
  supabase: SupabaseClient,
  organizationId: string,
  versionId: string,
) {
  const { data, error } = await supabase
    .from("teller_forecast_versions")
    .select("*, teller_forecasts!inner(*)")
    .eq("organization_id", organizationId)
    .eq("id", versionId)
    .single();
  if (error || !data) throw new Error(error?.message || "Forecast version not found");
  return data;
}

export async function listForecastLines(
  supabase: SupabaseClient,
  organizationId: string,
  versionId: string,
) {
  const { data, error } = await supabase
    .from("teller_forecast_lines")
    .select("id, account_id, period_month, amount, source_kind, notes, metadata")
    .eq("organization_id", organizationId)
    .eq("forecast_version_id", versionId)
    .order("account_id")
    .order("period_month");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function bulkUpsertForecastLines(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
    lines: ForecastLineInput[];
    actorId?: string | null;
    skipAudit?: boolean;
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

  const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
  const accountsById = await loadAccountsById(supabase, input.organizationId, accountIds);
  for (const line of input.lines) {
    const account = accountsById.get(line.accountId);
    if (!account || account.organizationId !== input.organizationId) {
      throw new Error("One or more accounts are invalid for this organization");
    }
    if (account.archived) {
      throw new Error(`Account ${account.code} is archived`);
    }
  }

  const normalized = validateForecastLines(input.lines);
  if (!normalized.length) return { saved: 0 };

  const rows = normalized.map((line) => ({
    organization_id: input.organizationId,
    forecast_version_id: input.versionId,
    account_id: line.accountId,
    period_month: line.periodMonth,
    amount: line.amount,
    notes: line.notes ?? "",
    source_kind: line.sourceKind ?? "manual",
    metadata: line.metadata ?? {},
  }));

  const { error } = await supabase.from("teller_forecast_lines").upsert(rows, {
    onConflict: "forecast_version_id,account_id,period_month",
  });
  if (error) throw new Error(error.message);

  if (!input.skipAudit) {
    await recordPlanningAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      eventKind: "forecast_saved",
      entityKind: "forecast_version",
      entityId: input.versionId,
      payload: { lineCount: rows.length },
    });
  }

  return { saved: rows.length };
}

export async function listForecastAssumptions(
  supabase: SupabaseClient,
  organizationId: string,
  versionId: string,
) {
  const { data, error } = await supabase
    .from("teller_forecast_assumptions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("forecast_version_id", versionId)
    .order("priority")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertForecastAssumption(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
    assumption: ForecastAssumptionInput;
    assumptionId?: string;
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

  const accountIds = input.assumption.targetAccountId ? [input.assumption.targetAccountId] : [];
  const accountsById = await loadAccountsById(supabase, input.organizationId, accountIds);
  const accountRefs = new Map<string, { type: string; organizationId: string }>();
  if (input.assumption.targetAccountId) {
    const { data: accountRow } = await supabase
      .from("teller_accounts")
      .select("id, type, organization_id")
      .eq("id", input.assumption.targetAccountId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    if (!accountRow || !accountsById.has(input.assumption.targetAccountId)) {
      throw new Error("Target account not found in your organization");
    }
    accountRefs.set(input.assumption.targetAccountId, {
      type: accountRow.type as string,
      organizationId: accountRow.organization_id as string,
    });
  }

  const validated = validateAssumptionInput(input.assumption, accountRefs);
  const normalized = normalizeAssumptionInput(validated);

  const row = {
    organization_id: input.organizationId,
    forecast_version_id: input.versionId,
    name: normalized.name.trim(),
    description: normalized.description?.trim() ?? "",
    assumption_kind: (normalized.assumptionKind ?? "general") as ForecastAssumptionKind,
    value_type: (normalized.valueType ?? "text") as ForecastAssumptionValueType,
    value_numeric: normalized.valueNumeric ?? null,
    value_text: normalized.valueText ?? null,
    effective_start_month: normalized.effectiveStartMonth ?? null,
    effective_end_month: normalized.effectiveEndMonth ?? null,
    target_account_id: normalized.targetAccountId ?? null,
    parameters: normalized.parameters ?? {},
    priority: normalized.priority ?? 100,
  };

  if (input.assumptionId) {
    const { data, error } = await supabase
      .from("teller_forecast_assumptions")
      .update(row)
      .eq("organization_id", input.organizationId)
      .eq("forecast_version_id", input.versionId)
      .eq("id", input.assumptionId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not update assumption");
    await recordPlanningAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      eventKind: "forecast_assumption_saved",
      entityKind: "forecast_assumption",
      entityId: data.id as string,
      payload: { action: "update", name: normalized.name.trim() },
    });
    return data;
  }

  const { data, error } = await supabase
    .from("teller_forecast_assumptions")
    .insert(row)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create assumption");
  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_assumption_saved",
    entityKind: "forecast_assumption",
    entityId: data.id as string,
    payload: { action: "create", name: normalized.name.trim() },
  });
  return data;
}

export async function deleteForecastAssumption(
  supabase: SupabaseClient,
  input: { organizationId: string; versionId: string; assumptionId: string },
) {
  const version = await getForecastVersion(supabase, input.organizationId, input.versionId);
  assertForecastLinesEditable(
    version.status as ForecastVersionStatus,
    Boolean(version.is_immutable),
  );

  const { error } = await supabase
    .from("teller_forecast_assumptions")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("forecast_version_id", input.versionId)
    .eq("id", input.assumptionId);
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: undefined,
    eventKind: "forecast_assumption_deleted",
    entityKind: "forecast_assumption",
    entityId: input.assumptionId,
  });
}

export async function publishForecastVersion(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    forecastId: string;
    versionId: string;
    actualCutoffMonth: string;
    snapshotLines: ForecastLineInput[];
    actorId?: string | null;
  },
) {
  const version = await getForecastVersion(supabase, input.organizationId, input.versionId);
  const forecast = version.teller_forecasts as { id: string };
  if (forecast.id !== input.forecastId) {
    throw new Error("Version does not belong to this forecast");
  }
  if (version.status !== "draft") {
    throw new Error("Only draft forecast versions can be published");
  }

  if (input.snapshotLines.length) {
    await bulkUpsertForecastLines(supabase, {
      organizationId: input.organizationId,
      forecastId: input.forecastId,
      versionId: input.versionId,
      lines: input.snapshotLines.map((line) => ({
        ...line,
        sourceKind: line.sourceKind ?? "actual",
      })),
      actorId: input.actorId,
      skipAudit: true,
    });
  }

  const { data, error } = await supabase.rpc("teller_atomic_publish_forecast_version", {
    p_organization_id: input.organizationId,
    p_version_id: input.versionId,
    p_actor_id: input.actorId ?? "00000000-0000-0000-0000-000000000000",
    p_actual_cutoff_month: input.actualCutoffMonth,
  });
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_published",
    entityKind: "forecast_version",
    entityId: input.versionId,
    payload: { actualCutoffMonth: input.actualCutoffMonth },
  });

  return data;
}

export async function cloneForecastVersion(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceVersionId: string;
    label?: string;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_clone_forecast_version", {
    p_organization_id: input.organizationId,
    p_source_version_id: input.sourceVersionId,
    p_actor_id: input.actorId ?? "00000000-0000-0000-0000-000000000000",
    p_label: input.label ?? "",
  });
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_revision_created",
    entityKind: "forecast_version",
    entityId: data.id as string,
    payload: { sourceVersionId: input.sourceVersionId },
  });

  return data;
}

export async function archiveForecastVersion(
  supabase: SupabaseClient,
  input: { organizationId: string; versionId: string; actorId?: string | null },
) {
  const version = await getForecastVersion(supabase, input.organizationId, input.versionId);
  assertForecastVersionTransition(version.status as ForecastVersionStatus, "archived");

  const { data, error } = await supabase
    .from("teller_forecast_versions")
    .update({ status: "archived" })
    .eq("organization_id", input.organizationId)
    .eq("id", input.versionId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not archive forecast version");

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "forecast_archived",
    entityKind: "forecast_version",
    entityId: input.versionId,
  });

  return data;
}
