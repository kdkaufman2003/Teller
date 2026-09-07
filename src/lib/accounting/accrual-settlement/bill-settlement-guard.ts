import type { SupabaseClient } from "@supabase/supabase-js";

export const BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE =
  "This bill includes an accrual settlement. Reverse the accrual settlement before voiding the bill.";

const ACTIVE_SETTLEMENT_STATUSES = ["posted", "partially_settled", "settled"] as const;

export async function hasActiveAccrualSettlementOnBill(
  supabase: SupabaseClient,
  organizationId: string,
  billId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("teller_accrual_settlements")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("bill_id", billId)
    .in("status", [...ACTIVE_SETTLEMENT_STATUSES])
    .limit(1);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return false;
    throw new Error(error.message);
  }
  return (data ?? []).length > 0;
}

export async function assertBillVoidAllowedWithoutActiveSettlement(
  supabase: SupabaseClient,
  organizationId: string,
  billId: string,
): Promise<void> {
  const blocked = await hasActiveAccrualSettlementOnBill(supabase, organizationId, billId);
  if (blocked) {
    throw new Error(BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE);
  }
}

export async function getActiveAccrualSettlementForBill(
  supabase: SupabaseClient,
  organizationId: string,
  billId: string,
) {
  const { data, error } = await supabase
    .from("teller_accrual_settlements")
    .select("id, status, settlement_journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("bill_id", billId)
    .in("status", [...ACTIVE_SETTLEMENT_STATUSES])
    .maybeSingle();

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  return data;
}

export function isActiveSettlementStatus(status: string): boolean {
  return (ACTIVE_SETTLEMENT_STATUSES as readonly string[]).includes(status);
}
