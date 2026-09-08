import type { SupabaseClient } from "@supabase/supabase-js";
import {
  actionToStatus,
  assertLinesEditable,
  assertVersionAction,
  assertVersionStatusTransition,
} from "./lifecycle";
import { recordPlanningAuditEvent } from "./audit";
import {
  type AccountRef,
  validateBulkLines,
  validateBudgetName,
  validateFiscalYear,
} from "./validation";
import { copyForwardLines } from "./copy-forward";
import {
  buildPriorYearActualBaselineLines,
  type PlanningAccount,
} from "./prior-year-baseline";
import type {
  BudgetBaselineKind,
  BudgetCsvImportMode,
  BudgetLineInput,
  BudgetType,
  BudgetVersionAction,
  BudgetVersionStatus,
} from "./types";

export type CreateBudgetInput = {
  organizationId: string;
  name: string;
  fiscalYear: number;
  budgetType?: BudgetType;
  currencyCode?: string;
  baselineKind?: BudgetBaselineKind;
  actorId?: string | null;
};

export async function loadAccountsById(
  supabase: SupabaseClient,
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, AccountRef>> {
  if (!accountIds.length) return new Map();
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, organization_id, code, archived")
    .eq("organization_id", organizationId)
    .in("id", accountIds);
  if (error) throw new Error(error.message);
  const map = new Map<string, AccountRef>();
  for (const row of data ?? []) {
    map.set(row.id as string, {
      id: row.id as string,
      organizationId: row.organization_id as string,
      code: row.code as string,
      archived: Boolean(row.archived),
    });
  }
  return map;
}

export async function createBudget(
  supabase: SupabaseClient,
  input: CreateBudgetInput,
) {
  validateBudgetName(input.name);
  validateFiscalYear(input.fiscalYear);

  const { data: budget, error: budgetError } = await supabase
    .from("teller_budgets")
    .insert({
      organization_id: input.organizationId,
      name: input.name.trim(),
      fiscal_year: input.fiscalYear,
      budget_type: input.budgetType ?? "operating",
      currency_code: input.currencyCode ?? "USD",
      status: "active",
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();

  if (budgetError || !budget) {
    if (/duplicate key|unique/i.test(budgetError?.message ?? "")) {
      throw new Error("An active budget already exists for this fiscal year");
    }
    throw new Error(budgetError?.message || "Could not create budget");
  }

  const { data: version, error: versionError } = await supabase
    .from("teller_budget_versions")
    .insert({
      organization_id: input.organizationId,
      budget_id: budget.id,
      version_number: 1,
      label: "Version 1",
      status: "draft",
      baseline_kind: input.baselineKind ?? "blank",
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();

  if (versionError || !version) {
    throw new Error(versionError?.message || "Could not create initial budget version");
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "budget_created",
    entityKind: "budget",
    entityId: budget.id as string,
    payload: { fiscalYear: input.fiscalYear, name: input.name.trim() },
  });

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "version_created",
    entityKind: "budget_version",
    entityId: version.id as string,
    payload: { budgetId: budget.id, versionNumber: 1 },
  });

  return { budget, version };
}

export async function loadPlanningAccounts(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PlanningAccount[]> {
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

export async function createBudgetWithBaseline(
  supabase: SupabaseClient,
  input: CreateBudgetInput & { baselineKind: BudgetBaselineKind },
) {
  const result = await createBudget(supabase, input);

  if (input.baselineKind === "prior_year_actual") {
    const accounts = await loadPlanningAccounts(supabase, input.organizationId);
    const lines = await buildPriorYearActualBaselineLines(supabase, {
      organizationId: input.organizationId,
      targetFiscalYear: input.fiscalYear,
      accounts,
    });
    if (lines.length) {
      await bulkUpsertBudgetLines(supabase, {
        organizationId: input.organizationId,
        budgetId: result.budget.id as string,
        versionId: result.version.id as string,
        fiscalYear: input.fiscalYear,
        lines: lines.map((line) => ({ ...line, notes: line.notes ?? "" })),
        actorId: input.actorId,
      });
      await supabase
        .from("teller_budget_lines")
        .update({ source_kind: "actual_baseline" })
        .eq("organization_id", input.organizationId)
        .eq("budget_version_id", result.version.id as string);
    }
    await recordPlanningAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      eventKind: "budget_created_from_actuals",
      entityKind: "budget_version",
      entityId: result.version.id as string,
      payload: { fiscalYear: input.fiscalYear, lineCount: lines.length },
    });
  }

  return result;
}

export async function copyBudgetForward(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceBudgetId: string;
    sourceVersionId: string;
    targetFiscalYear: number;
    name: string;
    actorId?: string | null;
  },
) {
  validateBudgetName(input.name);
  validateFiscalYear(input.targetFiscalYear);

  const { budget: sourceBudget, versions } = await getBudgetWithVersions(
    supabase,
    input.organizationId,
    input.sourceBudgetId,
  );
  const sourceVersion = versions.find((version) => version.id === input.sourceVersionId);
  if (!sourceVersion) throw new Error("Source version not found");

  const sourceLinesRaw = await listBudgetLines(
    supabase,
    input.organizationId,
    input.sourceVersionId,
  );
  const sourceLines: BudgetLineInput[] = sourceLinesRaw.map((line) => ({
    accountId: line.account_id as string,
    periodMonth: line.period_month as string,
    amount: Number(line.amount),
    notes: (line.notes as string) ?? "",
  }));

  const result = await createBudget(supabase, {
    organizationId: input.organizationId,
    name: input.name,
    fiscalYear: input.targetFiscalYear,
    baselineKind: "prior_version",
    actorId: input.actorId,
  });

  const shifted = copyForwardLines(
    sourceLines,
    Number(sourceBudget.fiscal_year),
    input.targetFiscalYear,
  );
  if (shifted.length) {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: input.organizationId,
      budgetId: result.budget.id as string,
      versionId: result.version.id as string,
      fiscalYear: input.targetFiscalYear,
      lines: shifted,
      actorId: input.actorId,
    });
    await supabase
      .from("teller_budget_lines")
      .update({ source_kind: "prior_version" })
      .eq("organization_id", input.organizationId)
      .eq("budget_version_id", result.version.id as string);
  }

  await supabase
    .from("teller_budget_versions")
    .update({ source_version_id: input.sourceVersionId })
    .eq("organization_id", input.organizationId)
    .eq("id", result.version.id as string);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "budget_copied_forward",
    entityKind: "budget",
    entityId: result.budget.id as string,
    payload: {
      sourceBudgetId: input.sourceBudgetId,
      sourceVersionId: input.sourceVersionId,
      targetFiscalYear: input.targetFiscalYear,
      lineCount: shifted.length,
    },
  });

  return result;
}

export async function applyBudgetCsvImport(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    budgetId: string;
    versionId: string;
    fiscalYear: number;
    lines: BudgetLineInput[];
    mode: BudgetCsvImportMode;
    actorId?: string | null;
    sourceFilename?: string;
  },
) {
  const version = await getBudgetVersion(supabase, input.organizationId, input.versionId);
  assertLinesEditable(version.status as BudgetVersionStatus);

  let linesToSave = input.lines;
  if (input.mode === "merge") {
    linesToSave = input.lines.filter((line) => Math.abs(line.amount) >= 0.005);
    const existing = await listBudgetLines(supabase, input.organizationId, input.versionId);
    const importedKeys = new Set(
      linesToSave.map((line) => `${line.accountId}::${line.periodMonth}`),
    );
    const preserved = existing
      .filter((line) => !importedKeys.has(`${line.account_id}::${line.period_month}`))
      .map((line) => ({
        accountId: line.account_id as string,
        periodMonth: line.period_month as string,
        amount: Number(line.amount),
        notes: (line.notes as string) ?? "",
      }));
    linesToSave = [...preserved, ...linesToSave];
  }

  const result = await bulkUpsertBudgetLines(supabase, {
    organizationId: input.organizationId,
    budgetId: input.budgetId,
    versionId: input.versionId,
    fiscalYear: input.fiscalYear,
    lines: linesToSave,
    actorId: input.actorId,
  });

  if (input.lines.length) {
    const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
    for (const accountId of accountIds) {
      await supabase
        .from("teller_budget_lines")
        .update({ source_kind: "import" })
        .eq("organization_id", input.organizationId)
        .eq("budget_version_id", input.versionId)
        .eq("account_id", accountId);
    }
  }

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "budget_csv_imported",
    entityKind: "budget_version",
    entityId: input.versionId,
    payload: {
      mode: input.mode,
      lineCount: input.lines.length,
      saved: result.saved,
      sourceFilename: input.sourceFilename?.slice(0, 120),
    },
  });

  return result;
}

export async function getBudgetWithVersions(
  supabase: SupabaseClient,
  organizationId: string,
  budgetId: string,
) {
  const { data: budget, error } = await supabase
    .from("teller_budgets")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", budgetId)
    .single();
  if (error || !budget) throw new Error(error?.message || "Budget not found");

  const { data: versions, error: versionsError } = await supabase
    .from("teller_budget_versions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("budget_id", budgetId)
    .order("version_number", { ascending: false });

  if (versionsError) throw new Error(versionsError.message);

  return { budget, versions: versions ?? [] };
}

export async function getBudgetVersion(
  supabase: SupabaseClient,
  organizationId: string,
  versionId: string,
) {
  const { data, error } = await supabase
    .from("teller_budget_versions")
    .select("*, teller_budgets!inner(*)")
    .eq("organization_id", organizationId)
    .eq("id", versionId)
    .single();
  if (error || !data) throw new Error(error?.message || "Budget version not found");
  return data;
}

export async function listBudgetLines(
  supabase: SupabaseClient,
  organizationId: string,
  versionId: string,
) {
  const { data, error } = await supabase
    .from("teller_budget_lines")
    .select("id, account_id, period_month, amount, notes")
    .eq("organization_id", organizationId)
    .eq("budget_version_id", versionId)
    .order("account_id")
    .order("period_month");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function bulkUpsertBudgetLines(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    budgetId: string;
    versionId: string;
    fiscalYear: number;
    lines: BudgetLineInput[];
    actorId?: string | null;
  },
) {
  const version = await getBudgetVersion(supabase, input.organizationId, input.versionId);
  const budget = version.teller_budgets as { id: string; fiscal_year: number };
  if (budget.id !== input.budgetId) throw new Error("Version does not belong to this budget");
  if (Number(budget.fiscal_year) !== input.fiscalYear) {
    throw new Error("Fiscal year mismatch");
  }

  const versionStatus = version.status as BudgetVersionStatus;
  const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
  const accountsById = await loadAccountsById(supabase, input.organizationId, accountIds);
  const normalized = validateBulkLines({
    lines: input.lines,
    fiscalYear: input.fiscalYear,
    organizationId: input.organizationId,
    versionStatus,
    accountsById,
  });

  assertLinesEditable(versionStatus);

  const rows = normalized.map((line) => ({
    organization_id: input.organizationId,
    budget_version_id: input.versionId,
    account_id: line.accountId,
    period_month: line.periodMonth,
    amount: line.amount,
    notes: line.notes ?? "",
    source_kind: "manual",
  }));

  if (!rows.length) {
    return { saved: 0 };
  }

  const { error } = await supabase.from("teller_budget_lines").upsert(rows, {
    onConflict: "budget_version_id,account_id,period_month",
  });
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "budget_saved",
    entityKind: "budget_version",
    entityId: input.versionId,
    payload: { lineCount: rows.length },
  });

  return { saved: rows.length };
}

export async function runBudgetVersionLifecycle(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    versionId: string;
    action: BudgetVersionAction;
    actorId?: string | null;
  },
) {
  const { data: current, error } = await supabase
    .from("teller_budget_versions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.versionId)
    .single();
  if (error || !current) throw new Error(error?.message || "Budget version not found");

  const status = current.status as BudgetVersionStatus;
  assertVersionAction(status, input.action);
  const nextStatus = actionToStatus(input.action);

  if (input.action === "approve") {
    const { data, error: rpcError } = await supabase.rpc("teller_atomic_approve_budget_version", {
      p_organization_id: input.organizationId,
      p_version_id: input.versionId,
      p_actor_id: input.actorId ?? "00000000-0000-0000-0000-000000000000",
    });
    if (rpcError) throw new Error(rpcError.message);
    await recordPlanningAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      eventKind: "version_approved",
      entityKind: "budget_version",
      entityId: input.versionId,
    });
    return data;
  }

  if (input.action === "lock") {
    const { data, error: rpcError } = await supabase.rpc("teller_atomic_lock_budget_version", {
      p_organization_id: input.organizationId,
      p_version_id: input.versionId,
      p_actor_id: input.actorId ?? "00000000-0000-0000-0000-000000000000",
    });
    if (rpcError) throw new Error(rpcError.message);
    await recordPlanningAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      eventKind: "version_locked",
      entityKind: "budget_version",
      entityId: input.versionId,
    });
    return data;
  }

  assertVersionStatusTransition(status, nextStatus);
  const { data: updated, error: updateError } = await supabase
    .from("teller_budget_versions")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.versionId)
    .select("*")
    .single();
  if (updateError || !updated) throw new Error(updateError?.message || "Could not update version");

  const eventKind =
    input.action === "submit"
      ? "version_submitted"
      : input.action === "archive"
        ? "version_archived"
        : "version_created";

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind,
    entityKind: "budget_version",
    entityId: input.versionId,
    payload: { action: input.action },
  });

  return updated;
}

export async function cloneBudgetVersion(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceVersionId: string;
    label?: string;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_clone_budget_version", {
    p_organization_id: input.organizationId,
    p_source_version_id: input.sourceVersionId,
    p_actor_id: input.actorId ?? "00000000-0000-0000-0000-000000000000",
    p_label: input.label ?? "",
  });
  if (error) throw new Error(error.message);

  await recordPlanningAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    eventKind: "version_cloned",
    entityKind: "budget_version",
    entityId: data.id as string,
    payload: { sourceVersionId: input.sourceVersionId },
  });

  return data;
}
