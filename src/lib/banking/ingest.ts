import type { SupabaseClient } from "@supabase/supabase-js";
import { recordBankingAuditEvent } from "./audit";
import type {
  BankImportResult,
  BankTransactionImportInput,
  BankTransactionRpcRow,
  NormalizedBankTransaction,
} from "./types";
import { toNormalizedBankTransaction } from "./types";

export function mapTransactionToRpcRow(txn: NormalizedBankTransaction): BankTransactionRpcRow {
  const normalized = toNormalizedBankTransaction(txn);
  return {
    provider_transaction_id: normalized.providerTransactionId,
    provider_pending_transaction_id: normalized.providerPendingTransactionId ?? null,
    posted_date: normalized.postedDate,
    authorized_date: normalized.authorizedDate ?? null,
    raw_amount: normalized.rawAmount,
    description: normalized.description,
    merchant_name: normalized.merchantName ?? null,
    transaction_type: normalized.transactionType ?? null,
    pending: normalized.pending,
    currency: normalized.currency ?? "USD",
    provider_category: normalized.providerCategory ?? [],
    raw_provider_metadata: normalized.rawProviderMetadata ?? {},
    import_fingerprint: normalized.importFingerprint ?? null,
  };
}

function mapRpcResult(data: unknown): BankImportResult {
  const row =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    imported: Number(row.imported ?? 0),
    updated: Number(row.updated ?? 0),
    superseded: Number(row.superseded ?? 0),
    removed: Number(row.removed ?? 0),
    duplicates: Number(row.duplicates ?? 0),
    errors: Array.isArray(row.errors)
      ? row.errors.map((entry) => String(entry))
      : [],
  };
}

/** Atomic batch ingest via teller_import_bank_transactions RPC. Never posts journals. */
export async function importBankTransactionsBatch(
  supabase: SupabaseClient,
  input: BankTransactionImportInput,
  options?: { actorId?: string | null; audit?: boolean },
): Promise<BankImportResult> {
  const transactions = input.transactions.map((txn) => mapTransactionToRpcRow(txn));
  const removedIds = input.removedProviderTransactionIds ?? [];

  const { data, error } = await supabase.rpc("teller_import_bank_transactions", {
    p_organization_id: input.organizationId,
    p_bank_account_id: input.bankAccountId,
    p_provider: input.provider,
    p_transactions: transactions,
    p_removed_provider_ids: removedIds,
    p_import_batch_id: input.importBatchId ?? null,
  });

  if (error) throw new Error(error.message);

  const result = mapRpcResult(data);

  if (options?.audit !== false) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: options?.actorId ?? null,
      action: "banking.transaction.imported",
      resourceKind: "bank_account",
      resourceId: input.bankAccountId,
      metadata: {
        provider: input.provider,
        importBatchId: input.importBatchId ?? null,
        ...result,
        transactionCount: transactions.length,
        removedCount: removedIds.length,
      },
    });
  }

  return result;
}

/** Group sync deltas by bank account and ingest atomically per account. */
export async function ingestProviderSyncBatch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankAccountId: string;
    provider: string;
    added: NormalizedBankTransaction[];
    modified: NormalizedBankTransaction[];
    removed: string[];
    actorId?: string | null;
  },
): Promise<BankImportResult> {
  const transactions = [...input.added, ...input.modified].map((txn) =>
    toNormalizedBankTransaction(txn),
  );

  return importBankTransactionsBatch(
    supabase,
    {
      organizationId: input.organizationId,
      bankAccountId: input.bankAccountId,
      provider: input.provider,
      transactions,
      removedProviderTransactionIds: input.removed,
    },
    { actorId: input.actorId, audit: true },
  );
}
