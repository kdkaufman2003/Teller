/**
 * Read-only settlement reconciliation helpers for Phase 4 reporting.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileSubledgersToGl } from "./subledger";
import { reconcileDepositsToGl } from "./deposit-reconciliation";

export type SettlementReconciliationReport = {
  arAp: Awaited<ReturnType<typeof reconcileSubledgersToGl>>;
  deposits: Awaited<ReturnType<typeof reconcileDepositsToGl>>;
  notes: string[];
};

export async function reconcileSettlementControls(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SettlementReconciliationReport> {
  const [arAp, deposits] = await Promise.all([
    reconcileSubledgersToGl(supabase, organizationId),
    reconcileDepositsToGl(supabase, organizationId),
  ]);

  return {
    arAp,
    deposits,
    notes: [
      "AR subledger includes cash payments, credits, and write-offs.",
      "Sale-related cash refunds require credit memo + teller_refund_customer_credit (not invoice refund).",
      "Deposit liability excludes reversed applications and posted deposit refunds.",
      "Payment reversals void the original payment row and reverse the payment journal.",
      "Credit application reversals adjust allocations only — credit memo journals are unchanged.",
    ],
  };
}
