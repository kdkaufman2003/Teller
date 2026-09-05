import type { SupabaseClient } from "@supabase/supabase-js";
import { accountByCode, accountBySubtype } from "@/lib/accounting/accounts";
import type {
  NormalizedBankAccount,
  NormalizedBankTransaction,
} from "./types";

export async function resolveDefaultCashAccountId(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, type, subtype")
    .eq("organization_id", organizationId)
    .eq("archived", false);

  const cash =
    accountBySubtype(accounts ?? [], "bank") || accountByCode(accounts ?? [], "1000");
  return cash?.id ?? null;
}

export async function upsertBankAccounts(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    connectionId: string;
    accounts: NormalizedBankAccount[];
    defaultTellerAccountId?: string | null;
  },
) {
  const defaultCash =
    input.defaultTellerAccountId ??
    (await resolveDefaultCashAccountId(supabase, input.organizationId));

  for (const account of input.accounts) {
    const { data: existing } = await supabase
      .from("teller_bank_accounts")
      .select("id, teller_account_id")
      .eq("organization_id", input.organizationId)
      .eq("connection_id", input.connectionId)
      .eq("external_account_id", account.externalAccountId)
      .maybeSingle();

    const tellerAccountId =
      existing?.teller_account_id ??
      (account.subtype === "checking" || account.type === "depository" ? defaultCash : null);

    const row = {
      organization_id: input.organizationId,
      connection_id: input.connectionId,
      external_account_id: account.externalAccountId,
      name: account.name,
      official_name: account.officialName ?? "",
      mask: account.mask ?? null,
      account_type: account.type ?? null,
      account_subtype: account.subtype ?? null,
      currency: account.currency ?? "USD",
      current_balance: account.currentBalance,
      teller_account_id: tellerAccountId,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      const { error } = await supabase
        .from("teller_bank_accounts")
        .update(row)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("teller_bank_accounts").insert(row);
      if (error) throw new Error(error.message);
    }
  }
}

export async function importBankTransactions(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankAccountId: string;
    transactions: NormalizedBankTransaction[];
  },
) {
  let imported = 0;
  let updated = 0;

  for (const txn of input.transactions) {
    const { data: existing } = await supabase
      .from("teller_bank_transactions")
      .select("id, match_status")
      .eq("organization_id", input.organizationId)
      .eq("external_transaction_id", txn.externalTransactionId)
      .maybeSingle();

    const row = {
      organization_id: input.organizationId,
      bank_account_id: input.bankAccountId,
      external_transaction_id: txn.externalTransactionId,
      posted_date: txn.postedDate,
      authorized_date: txn.authorizedDate,
      amount: txn.amount,
      name: txn.name,
      merchant_name: txn.merchantName,
      pending: txn.pending,
      category: txn.category ?? [],
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      if (existing.match_status === "matched") continue;
      const { error } = await supabase
        .from("teller_bank_transactions")
        .update(row)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      updated += 1;
    } else {
      const { error } = await supabase.from("teller_bank_transactions").insert({
        ...row,
        match_status: "unmatched",
      });
      if (error && !error.message.includes("duplicate")) throw new Error(error.message);
      if (!error) imported += 1;
    }
  }

  return { imported, updated };
}

export async function storeConnectionSecret(
  serviceSupabase: SupabaseClient,
  connectionId: string,
  accessToken: string,
) {
  const { error } = await serviceSupabase.from("teller_bank_connection_secrets").upsert({
    connection_id: connectionId,
    access_token: accessToken,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function readConnectionSecret(
  serviceSupabase: SupabaseClient,
  connectionId: string,
): Promise<string | null> {
  const { data } = await serviceSupabase
    .from("teller_bank_connection_secrets")
    .select("access_token")
    .eq("connection_id", connectionId)
    .maybeSingle();
  return data?.access_token ?? null;
}

export async function removeBankTransactionsByExternalIds(
  supabase: SupabaseClient,
  organizationId: string,
  externalIds: string[],
) {
  if (!externalIds.length) return 0;
  const { data, error } = await supabase
    .from("teller_bank_transactions")
    .delete()
    .eq("organization_id", organizationId)
    .in("external_transaction_id", externalIds)
    .neq("match_status", "matched")
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
