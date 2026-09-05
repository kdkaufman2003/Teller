import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/admin";
import { getBankingProvider } from "./provider";
import {
  importBankTransactions,
  readConnectionSecret,
  removeBankTransactionsByExternalIds,
  storeConnectionSecret,
  upsertBankAccounts,
} from "./store";
import { bestSuggestion, suggestBankTransactionMatches } from "./match";

export async function connectBankFromPublicToken(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    publicToken: string;
    provider?: string;
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

  return { connectionId: connection.id, accounts: accounts.length };
}

export async function syncBankConnection(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    connectionId: string;
    provider?: string;
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

  const serviceSupabase = createServiceClient();
  const accessToken = await readConnectionSecret(serviceSupabase, connection.id);
  if (!accessToken) throw new Error("Bank connection credentials are missing");

  const previousSummary =
    connection.last_sync_summary && typeof connection.last_sync_summary === "object"
      ? (connection.last_sync_summary as Record<string, unknown>)
      : {};
  const cursor = typeof previousSummary.cursor === "string" ? previousSummary.cursor : null;

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

  for (const account of sync.accounts) {
    const bankAccountId = accountByExternal.get(account.externalAccountId);
    if (!bankAccountId) continue;

    const accountAdded = sync.added.filter(
      (txn) => txn.externalAccountId === account.externalAccountId,
    );
    const accountModified = sync.modified.filter(
      (txn) => txn.externalAccountId === account.externalAccountId,
    );

    const added = await importBankTransactions(supabase, {
      organizationId: input.organizationId,
      bankAccountId,
      transactions: accountAdded,
    });
    imported += added.imported;
    updated += added.updated;

    const modified = await importBankTransactions(supabase, {
      organizationId: input.organizationId,
      bankAccountId,
      transactions: accountModified,
    });
    imported += modified.imported;
    updated += modified.updated;
  }

  const removed = await removeBankTransactionsByExternalIds(
    supabase,
    input.organizationId,
    sync.removed,
  );

  await applyMatchSuggestions(supabase, input.organizationId);

  const summary = {
    imported,
    updated,
    removed,
    cursor: sync.cursor ?? cursor,
  };

  await supabase
    .from("teller_bank_connections")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_summary: summary,
      status: "active",
      error_message: null,
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

  return summary;
}

export async function applyMatchSuggestions(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const [{ data: transactions }, { data: invoices }, { data: expenses }, { data: entries }] =
    await Promise.all([
      supabase
        .from("teller_bank_transactions")
        .select("id, amount, posted_date, name, match_status")
        .eq("organization_id", organizationId)
        .in("match_status", ["unmatched", "suggested"]),
      supabase
        .from("teller_documents")
        .select("id, number, total, amount_paid, issue_date, status")
        .eq("organization_id", organizationId)
        .eq("kind", "invoice"),
      supabase
        .from("teller_documents")
        .select("id, number, total, issue_date, memo")
        .eq("organization_id", organizationId)
        .eq("kind", "expense"),
      supabase
        .from("teller_journal_entries")
        .select("id, entry_date, memo")
        .eq("organization_id", organizationId),
    ]);

  const entryIds = (entries ?? []).map((row) => row.id);
  const { data: journalLines } = entryIds.length
    ? await supabase
        .from("teller_journal_lines")
        .select("entry_id, debit")
        .in("entry_id", entryIds)
        .gt("debit", 0)
    : { data: [] };

  const entryById = new Map((entries ?? []).map((row) => [row.id, row]));
  const journalDeposits = (journalLines ?? []).map((row) => {
    const entry = entryById.get(row.entry_id as string);
    return {
      id: row.entry_id as string,
      entry_date: entry?.entry_date ?? "",
      memo: entry?.memo ?? "",
      debit: Number(row.debit),
    };
  });

  for (const txn of transactions ?? []) {
    const suggestions = suggestBankTransactionMatches(txn, {
      invoices: invoices ?? [],
      expenses: expenses ?? [],
      journalDeposits,
    });
    const top = bestSuggestion(suggestions);
    if (!top) continue;

    await supabase
      .from("teller_bank_transactions")
      .update({
        match_status: "suggested",
        match_confidence: top.confidence,
        matched_document_id: top.kind === "journal" ? null : top.resourceId,
        matched_journal_entry_id: top.kind === "journal" ? top.resourceId : null,
        metadata: { suggestion: top },
        updated_at: new Date().toISOString(),
      })
      .eq("id", txn.id);
  }
}

export async function confirmBankTransactionMatch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    transactionId: string;
    documentId?: string | null;
    journalEntryId?: string | null;
  },
) {
  const { error } = await supabase
    .from("teller_bank_transactions")
    .update({
      match_status: "matched",
      matched_document_id: input.documentId ?? null,
      matched_journal_entry_id: input.journalEntryId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.transactionId);

  if (error) throw new Error(error.message);
}
