import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountRow } from "@/lib/accounting/reports";
import {
  cumulativeBalanceFromTotals,
  fetchGlAccountTotals,
} from "@/lib/accounting/gl-account-totals";
import { roundMoney } from "@/lib/accounting/payment-fees";
import type { CashStartingCash } from "./types";

export function isEligibleCashAccount(account: AccountRow & { archived?: boolean }): boolean {
  if (account.type !== "asset") return false;
  if (account.archived) return false;
  if (account.subtype === "bank") return true;
  if (account.subtype === "cash") return true;
  if (account.code === "1000") return true;
  return false;
}

export function cashAccountGroupLabel(subtype: string, name: string): string {
  const lower = name.toLowerCase();
  if (subtype === "bank" && lower.includes("saving")) return "Savings";
  if (subtype === "bank") return "Checking";
  if (subtype === "cash") return "Other Cash";
  return "Cash";
}

export async function loadStartingCashFromGl(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate: string,
  accounts: AccountRow[],
): Promise<CashStartingCash> {
  const cashAccounts = accounts.filter(isEligibleCashAccount);
  const totals = await fetchGlAccountTotals(
    supabase,
    organizationId,
    "1970-01-01",
    asOfDate.slice(0, 10),
  );

  const byAccountId = new Map(
    (totals ?? []).map((row) => [row.account_id as string, row]),
  );

  const breakdown = cashAccounts.map((account) => {
    const row = byAccountId.get(account.id);
    const balance = row
      ? cumulativeBalanceFromTotals(row, account.type)
      : 0;
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      subtype: account.subtype ?? "",
      balance: roundMoney(balance),
    };
  });

  const total = roundMoney(breakdown.reduce((sum, row) => sum + row.balance, 0));

  return {
    total,
    accounts: breakdown,
    asOfDate: asOfDate.slice(0, 10),
  };
}
