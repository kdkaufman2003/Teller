import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/admin";
import { recordBankingAuditEvent } from "./audit";
import { confirmBankMatch, excludeBankTransaction } from "./categorize";
import { ingestProviderSyncBatch } from "./ingest";
import {
  bestSuggestionV2,
  matchAmountForTransaction,
  suggestBankTransactionMatchesV2,
  type PaymentMatchCandidate,
} from "./match-v2";
import { getBankingProvider } from "./provider";
import {
  readConnectionSecret,
  storeConnectionSecret,
  upsertBankAccounts,
} from "./store";
import { toNormalizedBankTransaction } from "./types";

async function loadMatchCandidates(
  supabase: SupabaseClient,
  organizationId: string,
  glAccountId?: string | null,
): Promise<{
  payments: PaymentMatchCandidate[];
  journalEntries: Awaited<ReturnType<typeof loadJournalCandidates>>;
}> {
  const [{ data: payments }, journalEntries] = await Promise.all([
    supabase
      .from("teller_payments")
      .select(
        "id, payment_type, amount, net_amount, payment_date, party_id, reference_number, journal_entry_id, external_id",
      )
      .eq("organization_id", organizationId)
      .eq("status", "posted")
      .order("payment_date", { ascending: false })
      .limit(500),
    loadJournalCandidates(supabase, organizationId, glAccountId),
  ]);

  const partyIds = [...new Set((payments ?? []).map((row) => row.party_id).filter(Boolean))];
  const { data: parties } = partyIds.length
    ? await supabase
        .from("teller_parties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", partyIds as string[])
    : { data: [] };

  const partyNameById = new Map((parties ?? []).map((row) => [row.id as string, row.name as string]));

  const paymentIds = (payments ?? []).map((row) => row.id as string);
  const { data: matchTotals } = paymentIds.length
    ? await supabase
        .from("teller_bank_matches")
        .select("matched_resource_id, matched_amount")
        .eq("organization_id", organizationId)
        .eq("matched_resource_type", "customer_payment")
        .in("matched_resource_id", paymentIds)
        .eq("status", "confirmed")
    : { data: [] };

  const matchedByPayment = new Map<string, number>();
  for (const row of matchTotals ?? []) {
    const id = row.matched_resource_id as string;
    matchedByPayment.set(id, (matchedByPayment.get(id) ?? 0) + Number(row.matched_amount));
  }

  return {
    payments: (payments ?? []).map((row) => ({
      id: row.id as string,
      payment_type: row.payment_type as string,
      amount: Number(row.amount),
      net_amount: row.net_amount == null ? null : Number(row.net_amount),
      payment_date: row.payment_date as string,
      party_id: row.party_id as string | null,
      reference_number: row.reference_number as string | null,
      journal_entry_id: row.journal_entry_id as string | null,
      external_id: row.external_id as string | null,
      party_name: row.party_id ? (partyNameById.get(row.party_id as string) ?? null) : null,
      matched_total: matchedByPayment.get(row.id as string) ?? 0,
    })),
    journalEntries,
  };
}

async function loadJournalCandidates(
  supabase: SupabaseClient,
  organizationId: string,
  glAccountId?: string | null,
) {
  if (!glAccountId) return [];

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit, teller_journal_entries!inner(id, entry_date, memo, organization_id)")
    .eq("account_id", glAccountId)
    .eq("teller_journal_entries.organization_id", organizationId)
    .limit(500);

  return (lines ?? []).map((row) => {
    const rawEntry = row.teller_journal_entries;
    const entry = (Array.isArray(rawEntry) ? rawEntry[0] : rawEntry) as {
      id: string;
      entry_date: string;
      memo: string;
    } | null;
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    return {
      id: entry?.id ?? (row.entry_id as string),
      entry_date: entry?.entry_date ?? "",
      memo: entry?.memo ?? "",
      bank_line_amount: Math.max(debit, credit),
      source_kind: null,
    };
  });
}

export async function connectBankFromPublicToken(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    publicToken: string;
    provider?: string;
    actorId?: string | null;
  },
) {
  const banking = getBankingProvider(input.provider);
  if (!banking?.isConfigured()) {
    throw new Error("Banking provider is not configured on the server");
  }

  const exchange = await banking.exchangePublicToken(input.publicToken);

  const { data: connection, error } = await supabase
    .from("teller_bank_connections")
    .upsert(
      {
        organization_id: input.organizationId,
        provider: banking.name,
        external_item_id: exchange.itemId,
        institution_id: exchange.institutionId,
        institution_name: exchange.institutionName ?? "Connected bank",
        status: "active",
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider,external_item_id" },
    )
    .select("id")
    .single();

  if (error || !connection) throw new Error(error?.message || "Could not save bank connection");

  const serviceSupabase = createServiceClient();
  await storeConnectionSecret(serviceSupabase, connection.id, exchange.accessToken);

  const accounts = await banking.fetchAccounts(exchange.accessToken);
  await upsertBankAccounts(supabase, {
    organizationId: input.organizationId,
    connectionId: connection.id,
    accounts,
  });

  await supabase.from("teller_integrations").upsert({
    organization_id: input.organizationId,
    provider: banking.name,
    enabled: true,
    last_synced_at: new Date().toISOString(),
    last_sync_summary: { connected: true, accounts: accounts.length },
  });

  await recordBankingAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    action: "banking.connection.created",
    resourceKind: "bank_connection",
    resourceId: connection.id,
    metadata: { provider: banking.name, accounts: accounts.length },
  });

  return { connectionId: connection.id, accounts: accounts.length };
}

export async function syncBankConnection(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    connectionId: string;
    provider?: string;
    actorId?: string | null;
  },
) {
  const banking = getBankingProvider(input.provider);
  if (!banking?.isConfigured()) {
    throw new Error("Banking provider is not configured on the server");
  }

  const { data: connection } = await supabase
    .from("teller_bank_connections")
    .select("id, external_item_id, last_sync_summary")
    .eq("organization_id", input.organizationId)
    .eq("id", input.connectionId)
    .maybeSingle();

  if (!connection) throw new Error("Bank connection not found");

  await recordBankingAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    action: "banking.sync.started",
    resourceKind: "bank_connection",
    resourceId: connection.id,
  });

  const serviceSupabase = createServiceClient();
  const accessToken = await readConnectionSecret(serviceSupabase, connection.id);
  if (!accessToken) throw new Error("Bank connection credentials are missing");

  const previousSummary =
    connection.last_sync_summary && typeof connection.last_sync_summary === "object"
      ? (connection.last_sync_summary as Record<string, unknown>)
      : {};
  const cursor = typeof previousSummary.cursor === "string" ? previousSummary.cursor : null;

  try {
    const sync = await banking.syncTransactions(accessToken, cursor);

    await upsertBankAccounts(supabase, {
      organizationId: input.organizationId,
      connectionId: connection.id,
      accounts: sync.accounts,
    });

    const { data: bankAccounts } = await supabase
      .from("teller_bank_accounts")
      .select("id, external_account_id")
      .eq("connection_id", connection.id);

    const accountByExternal = new Map(
      (bankAccounts ?? []).map((row) => [row.external_account_id as string, row.id as string]),
    );

    let imported = 0;
    let updated = 0;
    let superseded = 0;
    let removed = 0;
    let duplicates = 0;

    for (const account of sync.accounts) {
      const bankAccountId = accountByExternal.get(account.externalAccountId);
      if (!bankAccountId) continue;

      const accountAdded = sync.added
        .filter((txn) => txn.externalAccountId === account.externalAccountId)
        .map((txn) => toNormalizedBankTransaction(txn));
      const accountModified = sync.modified
        .filter((txn) => txn.externalAccountId === account.externalAccountId)
        .map((txn) => toNormalizedBankTransaction(txn));

      const result = await ingestProviderSyncBatch(supabase, {
        organizationId: input.organizationId,
        bankAccountId,
        provider: banking.name,
        added: accountAdded,
        modified: accountModified,
        removed: sync.removed,
        actorId: input.actorId,
      });

      imported += result.imported;
      updated += result.updated;
      superseded += result.superseded;
      removed += result.removed;
      duplicates += result.duplicates;
    }

    await applyMatchSuggestionsV2(supabase, input.organizationId);

    const summary = {
      imported,
      updated,
      superseded,
      removed,
      duplicates,
      cursor: sync.cursor ?? cursor,
    };

    await supabase
      .from("teller_bank_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        last_successful_sync_at: new Date().toISOString(),
        last_sync_summary: summary,
        status: "active",
        error_message: null,
        sync_error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    await supabase.from("teller_integrations").upsert({
      organization_id: input.organizationId,
      provider: banking.name,
      enabled: true,
      last_synced_at: new Date().toISOString(),
      last_sync_summary: summary,
    });

    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.sync.completed",
      resourceKind: "bank_connection",
      resourceId: connection.id,
      metadata: summary,
    });

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    await supabase
      .from("teller_bank_connections")
      .update({
        status: "error",
        error_message: message,
        sync_error_message: message,
        last_attempted_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.sync.failed",
      resourceKind: "bank_connection",
      resourceId: connection.id,
      metadata: { error: message },
    });

    throw error;
  }
}

export async function applyMatchSuggestionsV2(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const { data: transactions } = await supabase
    .from("teller_bank_transactions")
    .select(
      "id, bank_account_id, posted_date, normalized_amount, amount, description, name, merchant_name, status",
    )
    .eq("organization_id", organizationId)
    .in("status", ["unreviewed", "suggested"]);

  const candidates = await loadMatchCandidates(supabase, organizationId);

  for (const txn of transactions ?? []) {
    const suggestions = suggestBankTransactionMatchesV2(
      {
        id: txn.id as string,
        bank_account_id: txn.bank_account_id as string,
        posted_date: txn.posted_date as string,
        normalized_amount: Number(txn.normalized_amount ?? txn.amount),
        description: txn.description as string | undefined,
        name: txn.name as string | undefined,
        merchant_name: txn.merchant_name as string | null,
      },
      candidates,
    );
    const top = bestSuggestionV2(suggestions);
    if (!top) continue;

    await supabase
      .from("teller_bank_transactions")
      .update({
        status: "suggested",
        match_confidence: top.confidence,
        metadata: { suggestionV2: top },
        updated_at: new Date().toISOString(),
      })
      .eq("id", txn.id);

    await recordBankingAuditEvent(supabase, {
      organizationId,
      action: "banking.match.suggested",
      resourceKind: "bank_transaction",
      resourceId: txn.id as string,
      metadata: { suggestion: top },
    });
  }
}

export async function confirmBankTransactionMatch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    transactionId: string;
    matchedResourceType: string;
    matchedResourceId: string;
    matchedAmount?: number;
    idempotencyEventId?: string | null;
    actorId?: string | null;
  },
) {
  const { data: txn } = await supabase
    .from("teller_bank_transactions")
    .select("id, normalized_amount, amount")
    .eq("organization_id", input.organizationId)
    .eq("id", input.transactionId)
    .maybeSingle();

  if (!txn) throw new Error("Bank transaction not found");

  const matchedAmount =
    input.matchedAmount ??
    matchAmountForTransaction({
      id: txn.id as string,
      bank_account_id: "",
      posted_date: "",
      normalized_amount: Number(txn.normalized_amount ?? txn.amount),
    });

  return confirmBankMatch(supabase, {
    organizationId: input.organizationId,
    bankTransactionId: input.transactionId,
    matchedResourceType: input.matchedResourceType as Parameters<
      typeof confirmBankMatch
    >[1]["matchedResourceType"],
    matchedResourceId: input.matchedResourceId,
    matchedAmount,
    idempotencyEventId: input.idempotencyEventId,
    actorId: input.actorId,
  });
}

export { excludeBankTransaction };

export async function loadTransactionMatchSuggestions(
  supabase: SupabaseClient,
  organizationId: string,
  transactionId: string,
) {
  const { data: txn, error } = await supabase
    .from("teller_bank_transactions")
    .select(
      "id, bank_account_id, posted_date, normalized_amount, amount, description, name, merchant_name, status, metadata",
    )
    .eq("organization_id", organizationId)
    .eq("id", transactionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!txn) throw new Error("Transaction not found");

  const { data: bankAccount } = await supabase
    .from("teller_bank_accounts")
    .select("gl_account_id, teller_account_id")
    .eq("id", txn.bank_account_id)
    .maybeSingle();

  const glAccountId = bankAccount?.gl_account_id ?? bankAccount?.teller_account_id ?? null;
  const candidates = await loadMatchCandidates(supabase, organizationId, glAccountId);

  const suggestions = suggestBankTransactionMatchesV2(
    {
      id: txn.id as string,
      bank_account_id: txn.bank_account_id as string,
      posted_date: txn.posted_date as string,
      normalized_amount: Number(txn.normalized_amount ?? txn.amount),
      description: txn.description as string | undefined,
      name: txn.name as string | undefined,
      merchant_name: txn.merchant_name as string | null,
      status: txn.status as string | undefined,
    },
    candidates,
  );

  return { transaction: txn, suggestions, best: bestSuggestionV2(suggestions) };
}
