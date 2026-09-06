import { NextResponse } from "next/server";
import { requireBooks } from "@/lib/api";
import { bankingConfigured } from "@/lib/banking/provider";
import {
  computeBookBalanceForBankAccount,
  priorCompletedReconciliationBalance,
} from "@/lib/banking/reconciliation";
import { TAB_STATUS_MAP } from "@/lib/banking/types";
import { hasServiceRole } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const bankAccountId = url.searchParams.get("bankAccountId");

  const [{ data: connections }, { data: accounts }, { data: integration }] = await Promise.all([
    supabase
      .from("teller_bank_connections")
      .select("id, provider, institution_name, status, last_synced_at, last_sync_summary, error_message")
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false }),
    supabase
      .from("teller_bank_accounts")
      .select("id, connection_id, name, mask, account_type, account_subtype, current_balance, gl_account_id, teller_account_id, last_synced_at")
      .eq("organization_id", organizationId)
      .order("name"),
    supabase
      .from("teller_integrations")
      .select("enabled, last_synced_at, last_sync_summary")
      .eq("organization_id", organizationId)
      .eq("provider", "plaid")
      .maybeSingle(),
  ]);

  const selectedAccount =
    (accounts ?? []).find((account) => account.id === bankAccountId) ?? accounts?.[0] ?? null;

  const tabCounts: Record<string, number> = {};
  await Promise.all(
    Object.entries(TAB_STATUS_MAP).map(async ([tab, statuses]) => {
      let query = supabase
        .from("teller_bank_transactions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", statuses);
      if (selectedAccount?.id) query = query.eq("bank_account_id", selectedAccount.id);
      const { count } = await query;
      tabCounts[tab] = count ?? 0;
    }),
  );

  let balances = null;
  if (selectedAccount?.id) {
    const [bookBalance, clearedBalance] = await Promise.all([
      computeBookBalanceForBankAccount(supabase, organizationId, selectedAccount.id),
      priorCompletedReconciliationBalance(supabase, organizationId, selectedAccount.id),
    ]);
    const providerBalance =
      selectedAccount.current_balance == null ? null : Number(selectedAccount.current_balance);
    balances = {
      bankAccountId: selectedAccount.id,
      providerBalance,
      bookBalance,
      clearedBalance,
      difference: providerBalance == null ? bookBalance - clearedBalance : providerBalance - bookBalance,
      lastSyncedAt: selectedAccount.last_synced_at ?? null,
    };
  }

  return NextResponse.json({
    configured: bankingConfigured(),
    serviceRoleConfigured: hasServiceRole(),
    connections: connections ?? [],
    accounts: accounts ?? [],
    selectedAccountId: selectedAccount?.id ?? null,
    integration: integration ?? null,
    tabCounts,
    unmatchedCount: tabCounts.for_review ?? 0,
    balances,
  });
}
