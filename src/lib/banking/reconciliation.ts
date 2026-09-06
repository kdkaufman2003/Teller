import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { inferBankGlKind } from "./normalize";
import { recordBankingAuditEvent } from "./audit";
import type {
  ReconciliationCandidate,
  ReconciliationItemDetail,
  ReconciliationLandingAccount,
  ReconciliationRecord,
  ReconciliationSummary,
  ReconciliationWorkspacePayload,
} from "./types";
import {
  ACTIVE_RECONCILIATION_STATUSES,
  EDITABLE_RECONCILIATION_STATUSES,
} from "./types";

const CURRENCY_TOLERANCE = 0.01;

export {
  ACTIVE_RECONCILIATION_STATUSES,
  EDITABLE_RECONCILIATION_STATUSES,
} from "./types";

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
  const active = await getActiveReconciliationForAccount(
    supabase,
    input.organizationId,
    input.bankAccountId,
  );
  if (active) {
    throw new Error("An active reconciliation already exists for this bank account");
  }

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

function mapReconciliationRecord(row: Record<string, unknown>): ReconciliationRecord {
  return {
    id: row.id as string,
    bankAccountId: row.bank_account_id as string,
    statementStartDate: row.statement_start_date as string,
    statementEndDate: row.statement_end_date as string,
    beginningReconciledBalance: asNumber(row.beginning_reconciled_balance),
    statementEndingBalance: asNumber(row.statement_ending_balance),
    status: row.status as string,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    reopenedAt: (row.reopened_at as string | null) ?? null,
    reopenReason: (row.reopen_reason as string | null) ?? null,
    startedBy: (row.started_by as string | null) ?? null,
    completedBy: (row.completed_by as string | null) ?? null,
    reopenedBy: (row.reopened_by as string | null) ?? null,
  };
}

export async function getActiveReconciliationForAccount(
  supabase: SupabaseClient,
  organizationId: string,
  bankAccountId: string,
): Promise<ReconciliationRecord | null> {
  const { data, error } = await supabase
    .from("teller_bank_reconciliations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("bank_account_id", bankAccountId)
    .in("status", [...ACTIVE_RECONCILIATION_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapReconciliationRecord(data as Record<string, unknown>) : null;
}

export async function getLastCompletedReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  bankAccountId: string,
): Promise<ReconciliationRecord | null> {
  const { data, error } = await supabase
    .from("teller_bank_reconciliations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("bank_account_id", bankAccountId)
    .eq("status", "completed")
    .order("statement_end_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapReconciliationRecord(data as Record<string, unknown>) : null;
}

export async function loadReconciliationLandingAccounts(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ReconciliationLandingAccount[]> {
  const { data: accounts, error } = await supabase
    .from("teller_bank_accounts")
    .select(
      "id, name, mask, account_type, account_subtype, current_balance, last_synced_at, connection_id, teller_bank_connections(institution_name)",
    )
    .eq("organization_id", organizationId)
    .order("name");
  if (error) throw new Error(error.message);

  return Promise.all(
    (accounts ?? []).map(async (account) => {
      const connection = relationOne(
        account.teller_bank_connections as
          | { institution_name: string | null }
          | { institution_name: string | null }[]
          | null,
      );
      const [bookBalance, lastCompleted, activeReconciliation] = await Promise.all([
        computeBookBalanceForBankAccount(supabase, organizationId, account.id as string),
        getLastCompletedReconciliation(supabase, organizationId, account.id as string),
        getActiveReconciliationForAccount(supabase, organizationId, account.id as string),
      ]);

      return {
        bankAccountId: account.id as string,
        name: account.name as string,
        mask: (account.mask as string | null) ?? null,
        accountType: (account.account_type as string | null) ?? null,
        accountSubtype: (account.account_subtype as string | null) ?? null,
        institutionName: connection?.institution_name ?? null,
        providerBalance:
          account.current_balance == null ? null : asNumber(account.current_balance),
        bookBalance,
        lastSyncedAt: (account.last_synced_at as string | null) ?? null,
        lastReconciledDate: lastCompleted?.statementEndDate ?? null,
        lastReconciledEndingBalance: lastCompleted?.statementEndingBalance ?? null,
        activeReconciliation: activeReconciliation
          ? {
              id: activeReconciliation.id,
              status: activeReconciliation.status,
              statementEndDate: activeReconciliation.statementEndDate,
            }
          : null,
      };
    }),
  );
}

export async function loadReconciliationItems(
  supabase: SupabaseClient,
  organizationId: string,
  reconciliationId: string,
): Promise<ReconciliationItemDetail[]> {
  const { data, error } = await supabase
    .from("teller_bank_reconciliation_items")
    .select(
      "id, bank_transaction_id, journal_entry_id, journal_line_id, cleared_amount, cleared_date, teller_bank_transactions(posted_date, description, normalized_amount, status, provider, match_status), teller_journal_lines(debit, credit)",
    )
    .eq("organization_id", organizationId)
    .eq("reconciliation_id", reconciliationId)
    .order("cleared_date", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((item) => {
    const bankTxn = relationOne(
      item.teller_bank_transactions as
        | {
            posted_date: string;
            description: string | null;
            normalized_amount: number | string | null;
            status: string | null;
            provider: string | null;
            match_status: string | null;
          }
        | Array<{
            posted_date: string;
            description: string | null;
            normalized_amount: number | string | null;
            status: string | null;
            provider: string | null;
            match_status: string | null;
          }>
        | null,
    );
    const signed = signedReconciliationItemAmount(item);
    return {
      id: item.id as string,
      bankTransactionId: (item.bank_transaction_id as string | null) ?? null,
      journalEntryId: (item.journal_entry_id as string | null) ?? null,
      journalLineId: (item.journal_line_id as string | null) ?? null,
      clearedAmount: asNumber(item.cleared_amount),
      clearedDate: item.cleared_date as string,
      signedAmount: signed,
      postedDate: bankTxn?.posted_date ?? null,
      description: bankTxn?.description ?? null,
      status: bankTxn?.status ?? null,
      provider: bankTxn?.provider ?? null,
      matchStatus: bankTxn?.match_status ?? null,
    };
  });
}

export async function loadReconciliationCandidates(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reconciliationId: string;
    bankAccountId: string;
    statementStartDate: string;
    statementEndDate: string;
  },
): Promise<ReconciliationCandidate[]> {
  const { data: items } = await supabase
    .from("teller_bank_reconciliation_items")
    .select("id, bank_transaction_id")
    .eq("organization_id", input.organizationId)
    .eq("reconciliation_id", input.reconciliationId);

  const clearedByTxn = new Map<string, string>();
  for (const item of items ?? []) {
    if (item.bank_transaction_id) {
      clearedByTxn.set(item.bank_transaction_id as string, item.id as string);
    }
  }

  const { data: txns, error } = await supabase
    .from("teller_bank_transactions")
    .select(
      "id, posted_date, description, normalized_amount, status, provider, match_status",
    )
    .eq("organization_id", input.organizationId)
    .eq("bank_account_id", input.bankAccountId)
    .gte("posted_date", input.statementStartDate)
    .lte("posted_date", input.statementEndDate)
    .neq("status", "excluded")
    .eq("provider_lifecycle_state", "active")
    .order("posted_date", { ascending: true });
  if (error) throw new Error(error.message);

  return (txns ?? []).map((txn) => {
    const normalized = asNumber(txn.normalized_amount);
    const itemId = clearedByTxn.get(txn.id as string) ?? null;
    const cleared = Boolean(itemId);
    const lockedElsewhere = txn.status === "reconciled" && !cleared;
    return {
      bankTransactionId: txn.id as string,
      postedDate: txn.posted_date as string,
      description: (txn.description as string) || "Bank transaction",
      normalizedAmount: normalized,
      moneyIn: normalized > 0 ? normalized : 0,
      moneyOut: normalized < 0 ? Math.abs(normalized) : 0,
      status: txn.status as string,
      provider: (txn.provider as string | null) ?? null,
      cleared,
      reconciliationItemId: itemId,
      lockedElsewhere,
    };
  });
}

export async function loadReconciliationWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
  reconciliationId: string,
): Promise<ReconciliationWorkspacePayload> {
  const { data: reconciliation, error } = await supabase
    .from("teller_bank_reconciliations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", reconciliationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!reconciliation) throw new Error("Reconciliation not found");

  const [{ data: bankAccount }, summary, items, candidates, { data: auditEvents }] =
    await Promise.all([
      supabase
        .from("teller_bank_accounts")
        .select("id, name, mask, account_type, account_subtype")
        .eq("organization_id", organizationId)
        .eq("id", reconciliation.bank_account_id)
        .maybeSingle(),
      loadReconciliationSummary(supabase, organizationId, reconciliationId),
      loadReconciliationItems(supabase, organizationId, reconciliationId),
      loadReconciliationCandidates(supabase, {
        organizationId,
        reconciliationId,
        bankAccountId: reconciliation.bank_account_id as string,
        statementStartDate: reconciliation.statement_start_date as string,
        statementEndDate: reconciliation.statement_end_date as string,
      }),
      supabase
        .from("teller_audit_events")
        .select("action, created_at, metadata")
        .eq("organization_id", organizationId)
        .eq("resource_kind", "bank_reconciliation")
        .eq("resource_id", reconciliationId)
        .order("created_at", { ascending: true }),
    ]);

  const glKind = inferBankGlKind({
    bankAccountType: bankAccount?.account_type,
    bankAccountSubtype: bankAccount?.account_subtype,
  });

  return {
    reconciliation: mapReconciliationRecord(reconciliation as Record<string, unknown>),
    summary,
    items,
    candidates,
    bankAccount: {
      id: bankAccount?.id as string,
      name: bankAccount?.name as string,
      mask: (bankAccount?.mask as string | null) ?? null,
      accountType: (bankAccount?.account_type as string | null) ?? null,
      accountSubtype: (bankAccount?.account_subtype as string | null) ?? null,
      glKind,
    },
    auditEvents: (auditEvents ?? []).map((event) => ({
      action: event.action as string,
      createdAt: event.created_at as string,
      metadata: (event.metadata as Record<string, unknown> | null) ?? null,
    })),
  };
}

export async function removeReconciliationItems(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reconciliationId: string;
    itemIds?: string[];
    bankTransactionIds?: string[];
  },
): Promise<number> {
  await assertEditableReconciliation(supabase, input.organizationId, input.reconciliationId);

  let query = supabase
    .from("teller_bank_reconciliation_items")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("reconciliation_id", input.reconciliationId);

  if (input.itemIds?.length) {
    query = query.in("id", input.itemIds);
  } else if (input.bankTransactionIds?.length) {
    query = query.in("bank_transaction_id", input.bankTransactionIds);
  } else {
    return 0;
  }

  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

export async function toggleReconciliationBankTransaction(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reconciliationId: string;
    bankTransactionId: string;
    cleared: boolean;
  },
): Promise<{ summary: ReconciliationSummary }> {
  await assertEditableReconciliation(supabase, input.organizationId, input.reconciliationId);

  if (input.cleared) {
    const { data: txn, error: txnError } = await supabase
      .from("teller_bank_transactions")
      .select("id, posted_date, normalized_amount, status")
      .eq("organization_id", input.organizationId)
      .eq("id", input.bankTransactionId)
      .maybeSingle();
    if (txnError) throw new Error(txnError.message);
    if (!txn) throw new Error("Bank transaction not found");
    if (txn.status === "reconciled") {
      throw new Error("This transaction is already reconciled on a completed statement");
    }
    if (txn.status === "excluded") {
      throw new Error("Excluded transactions cannot be cleared");
    }

    const normalized = asNumber(txn.normalized_amount);
    if (Math.abs(normalized) <= 0.009) {
      throw new Error("Cannot clear a zero-amount transaction");
    }

    const { data: existing } = await supabase
      .from("teller_bank_reconciliation_items")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("reconciliation_id", input.reconciliationId)
      .eq("bank_transaction_id", input.bankTransactionId)
      .maybeSingle();
    if (existing) {
      const summary = await loadReconciliationSummary(
        supabase,
        input.organizationId,
        input.reconciliationId,
      );
      return { summary };
    }

    await addReconciliationItems(supabase, {
      organizationId: input.organizationId,
      reconciliationId: input.reconciliationId,
      items: [
        {
          bankTransactionId: input.bankTransactionId,
          clearedAmount: Math.abs(normalized),
          clearedDate: txn.posted_date as string,
        },
      ],
    });
  } else {
    await removeReconciliationItems(supabase, {
      organizationId: input.organizationId,
      reconciliationId: input.reconciliationId,
      bankTransactionIds: [input.bankTransactionId],
    });
  }

  const summary = await loadReconciliationSummary(
    supabase,
    input.organizationId,
    input.reconciliationId,
  );
  return { summary };
}

async function assertEditableReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  reconciliationId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_bank_reconciliations")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("id", reconciliationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Reconciliation not found");
  if (!EDITABLE_RECONCILIATION_STATUSES.includes(data.status as (typeof EDITABLE_RECONCILIATION_STATUSES)[number])) {
    throw new Error("This reconciliation is read-only");
  }
}
