import type { SupabaseClient } from "@supabase/supabase-js";
import { accountBySubtype, accountByCode } from "../../accounts";
import { loadOrgAccounts } from "../../post";
import { loadTaxSettings } from "../load-tax-settings";
import { resolveSalesTaxPayableAccountId } from "../posting/resolve-payable";
import { assertSameOrganization } from "../tenant-isolation";

export type TaxPaymentAccounts = {
  salesTaxPayableAccountId: string;
  cashAccountId: string;
  penaltyExpenseAccountId: string | null;
  interestExpenseAccountId: string | null;
  overpaymentAccountId: string | null;
};

export async function resolveTaxPaymentAccounts(
  supabase: SupabaseClient,
  organizationId: string,
  cashAccountId: string,
): Promise<TaxPaymentAccounts> {
  const { settings, schemaReady } = await loadTaxSettings(supabase, organizationId);
  if (!schemaReady) throw new Error("Tax settings schema is not available");

  const salesTaxPayableAccountId = resolveSalesTaxPayableAccountId(settings, 1);
  if (!salesTaxPayableAccountId) throw new Error("Sales tax payable account is not configured");

  const { data: cashAccount } = await supabase
    .from("teller_accounts")
    .select("id, organization_id, subtype")
    .eq("id", cashAccountId)
    .maybeSingle();
  if (!cashAccount) throw new Error("Cash account not found");
  assertSameOrganization(organizationId, cashAccount.organization_id as string, "Cash account");

  const { data: settingsRow } = await supabase
    .from("teller_tax_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const row = settingsRow as Record<string, unknown> | null;
  const metadata =
    row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};

  const readAccountId = (columnKey: string, metadataKey: string): string | null => {
    const columnValue = row?.[columnKey];
    if (typeof columnValue === "string" && columnValue.trim()) return columnValue.trim();
    const metadataValue = metadata[metadataKey];
    if (typeof metadataValue === "string" && metadataValue.trim()) return metadataValue.trim();
    return null;
  };

  return {
    salesTaxPayableAccountId,
    cashAccountId,
    penaltyExpenseAccountId: readAccountId("tax_penalty_expense_account_id", "tax_penalty_expense_account_id"),
    interestExpenseAccountId: readAccountId("tax_interest_expense_account_id", "tax_interest_expense_account_id"),
    overpaymentAccountId: readAccountId("tax_overpayment_account_id", "tax_overpayment_account_id"),
  };
}

export async function resolveDefaultCashAccountId(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const accounts = await loadOrgAccounts(supabase, organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  if (!cash) throw new Error("Cash or bank account is missing");
  return cash.id;
}
