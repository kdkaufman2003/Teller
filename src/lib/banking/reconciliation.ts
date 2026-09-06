import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { inferBankGlKind } from "./normalize";
import { recordBankingAuditEvent } from "./audit";
import type { ReconciliationSummary } from "./types";

const CURRENCY_TOLERANCE = 0.01;

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function signedReconciliationItemAmount(item: {
  cleared_amount: unknown;
  bank_transaction_id: string | null;
  journal_line_id: string | null;
  teller_bank_transactions: unknown;
  teller_journal_lines: unknown;
}): number {
  const bankTxn = relationOne(
    item.teller_bank_transactions as
      | { normalized_amount: unknown }
      | { normalized_amount: unknown }[]
      | null
      | undefined,
  );
  if (item.bank_transaction_id && bankTxn) {
    return asNumber(bankTxn.normalized_amount);
  }

  const journalLine = relationOne(
    item.teller_journal_lines as
      | { debit: unknown; credit: unknown }
      | { debit: unknown; credit: unknown }[]
      | null
      | undefined,
  );
  if (item.journal_line_id && journalLine) {
    return asNumber(journalLine.debit) - asNumber(journalLine.credit);
  }

  return asNumber(item.cleared_amount);
}

export type ReconciliationItemInput = {
  journalEntryId?: string | null;
  journalLineId?: string | null;
  bankTransactionId?: string | null;
  clearedAmount: number;
  clearedDate: string;
};

export async function priorCompletedReconciliationBalance(
  supabase: SupabaseClient,
  organizationId: string,
  bankAccountId: string,
): Promise<number> {
  const { data } = await supabase
    .from("teller_bank_reconciliations")
    .select("statement_ending_balance")
    .eq("organization_id", organizationId)
    .eq("bank_account_id", bankAccountId)
    .eq("status", "completed")
    .order("statement_end_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return asNumber(data?.statement_ending_balance ?? 0);
}

export function computeReconciliationBalances(input: {
  beginningReconciledBalance: number;
  statementEndingBalance: number;
  items: Array<{ clearedAmount: number; direction: "increase" | "decrease" }>;
  glKind?: "asset_bank" | "credit_card_liability";
}): ReconciliationSummary {
  const glKind = input.glKind ?? "asset_bank";
  let clearedIncreases = 0;
  let clearedDecreases = 0;

  for (const item of input.items) {
    if (item.direction === "increase") clearedIncreases += asNumber(item.clearedAmount);
    else clearedDecreases += asNumber(item.clearedAmount);
  }

  const calculatedEndingBalance =
    glKind === "credit_card_liability"
      ? input.beginningReconciledBalance + clearedIncreases - clearedDecreases
      : input.beginningReconciledBalance + clearedIncreases - clearedDecreases;

  const difference = input.statementEndingBalance - calculatedEndingBalance;

  return {
    reconciliationId: "",
    bankAccountId: "",
    statementStartDate: "",
    statementEndDate: "",
    beginningReconciledBalance: input.beginningReconciledBalance,
    statementEndingBalance: input.statementEndingBalance,
    clearedIncreases,
    clearedDecreases,
    calculatedEndingBalance,
    difference,
    status: "draft",
  };
}

export function reconciliationDifferenceOk(difference: number): boolean {
  return Math.abs(difference) <= CURRENCY_TOLERANCE;
}

export async function startBankReconciliation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankAccountId: string;
    statementStartDate: string;
    statementEndDate: string;
    statementEndingBalance: number;
    beginningReconciledBalance?: number | null;
    actorId?: string | null;
  },
): Promise<{ reconciliationId: string }> {
  const beginning =
    input.beginningReconciledBalance ??
    (await priorCompletedReconciliationBalance(
      supabase,
      input.organizationId,
      input.bankAccountId,
    ));

  const { data, error } = await supabase
    .from("teller_bank_reconciliations")
    .insert({
      organization_id: input.organizationId,
      bank_account_id: input.bankAccountId,
      statement_start_date: input.statementStartDate,
      statement_end_date: input.statementEndDate,
      beginning_reconciled_balance: beginning,
      statement_ending_balance: asNumber(input.statementEndingBalance),
      status: "in_progress",
      started_by: input.actorId ?? null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not start reconciliation");

  await recordBankingAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    action: "banking.reconciliation.started",
    resourceKind: "bank_reconciliation",
    resourceId: data.id as string,
    metadata: {
      bankAccountId: input.bankAccountId,
      statementStartDate: input.statementStartDate,
      statementEndDate: input.statementEndDate,
      statementEndingBalance: input.statementEndingBalance,
    },
  });

  return { reconciliationId: data.id as string };
}

export async function addReconciliationItems(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reconciliationId: string;
    items: ReconciliationItemInput[];
  },
): Promise<number> {
  if (!input.items.length) return 0;
  const rows = input.items.map((item) => ({
    organization_id: input.organizationId,
    reconciliation_id: input.reconciliationId,
    journal_entry_id: item.journalEntryId ?? null,
    journal_line_id: item.journalLineId ?? null,
    bank_transaction_id: item.bankTransactionId ?? null,
    cleared_amount: asNumber(item.clearedAmount),
    cleared_date: item.clearedDate,
  }));

  const { data, error } = await supabase
    .from("teller_bank_reconciliation_items")
    .insert(rows)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

export async function loadReconciliationSummary(
  supabase: SupabaseClient,
  organizationId: string,
  reconciliationId: string,
): Promise<ReconciliationSummary> {
  const [{ data: reconciliation, error }, { data: items }] = await Promise.all([
    supabase
      .from("teller_bank_reconciliations")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("id", reconciliationId)
      .maybeSingle(),
    supabase
      .from("teller_bank_reconciliation_items")
      .select(
        "cleared_amount, bank_transaction_id, journal_entry_id, journal_line_id, teller_bank_transactions(normalized_amount), teller_journal_lines(debit, credit)",
      )
      .eq("organization_id", organizationId)
      .eq("reconciliation_id", reconciliationId),
  ]);

  if (error) throw new Error(error.message);
  if (!reconciliation) throw new Error("Reconciliation not found");

  const { data: bankAccount } = await supabase
    .from("teller_bank_accounts")
    .select("account_type, account_subtype")
    .eq("id", reconciliation.bank_account_id)
    .maybeSingle();

  const glKind = inferBankGlKind({
    bankAccountType: bankAccount?.account_type,
    bankAccountSubtype: bankAccount?.account_subtype,
  });

  const itemRows = (items ?? []).map((item) => {
    const signed = signedReconciliationItemAmount(item);

    if (signed >= 0) {
      return { clearedAmount: signed, direction: "increase" as const };
    }
    return { clearedAmount: Math.abs(signed), direction: "decrease" as const };
  });

  const summary = computeReconciliationBalances({
    beginningReconciledBalance: asNumber(reconciliation.beginning_reconciled_balance),
    statementEndingBalance: asNumber(reconciliation.statement_ending_balance),
    items: itemRows,
    glKind,
  });

  return {
    ...summary,
    reconciliationId,
    bankAccountId: reconciliation.bank_account_id as string,
    statementStartDate: reconciliation.statement_start_date as string,
    statementEndDate: reconciliation.statement_end_date as string,
    status: reconciliation.status as string,
  };
}

export async function finalizeBankReconciliation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reconciliationId: string;
    actorId?: string | null;
  },
): Promise<{ duplicate: boolean }> {
  const summary = await loadReconciliationSummary(
    supabase,
    input.organizationId,
    input.reconciliationId,
  );
  if (!reconciliationDifferenceOk(summary.difference)) {
    throw new Error(
      `Reconciliation difference ${summary.difference.toFixed(2)} exceeds tolerance`,
    );
  }

  const { data, error } = await supabase.rpc("teller_finalize_bank_reconciliation", {
    p_organization_id: input.organizationId,
    p_reconciliation_id: input.reconciliationId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = (data ?? {}) as Record<string, unknown>;
  const duplicate = Boolean(row.duplicate);
  if (!duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.reconciliation.finalized",
      resourceKind: "bank_reconciliation",
      resourceId: input.reconciliationId,
      metadata: { difference: summary.difference },
    });
  }

  return { duplicate };
}

export async function reopenBankReconciliation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reconciliationId: string;
    reason: string;
    actorId?: string | null;
  },
): Promise<{ duplicate: boolean }> {
  const { data, error } = await supabase.rpc("teller_reopen_bank_reconciliation", {
    p_organization_id: input.organizationId,
    p_reconciliation_id: input.reconciliationId,
    p_reason: input.reason.trim(),
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = (data ?? {}) as Record<string, unknown>;
  const duplicate = Boolean(row.duplicate);
  if (!duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.reconciliation.reopened",
      resourceKind: "bank_reconciliation",
      resourceId: input.reconciliationId,
      metadata: { reason: input.reason.trim() },
    });
  }

  return { duplicate };
}

export async function computeBookBalanceForBankAccount(
  supabase: SupabaseClient,
  organizationId: string,
  bankAccountId: string,
): Promise<number> {
  const { data: bankAccount } = await supabase
    .from("teller_bank_accounts")
    .select("gl_account_id, teller_account_id")
    .eq("organization_id", organizationId)
    .eq("id", bankAccountId)
    .maybeSingle();

  const glAccountId = bankAccount?.gl_account_id ?? bankAccount?.teller_account_id;
  if (!glAccountId) return 0;

  const { data: lines, error } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit, entry_id, teller_journal_entries!inner(organization_id)")
    .eq("account_id", glAccountId)
    .eq("teller_journal_entries.organization_id", organizationId);

  if (error) throw new Error(error.message);

  return (lines ?? []).reduce(
    (sum, line) => sum + asNumber(line.debit) - asNumber(line.credit),
    0,
  );
}
