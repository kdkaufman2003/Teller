import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import { reconcileTaxPeriod } from "../filing/reconcile";
import type { TaxPeriodPaymentSummary } from "./types";

export async function loadTaxPeriodPaymentSummary(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    filingPeriodId: string;
  },
): Promise<TaxPeriodPaymentSummary> {
  const { data: period, error } = await supabase
    .from("teller_tax_filing_periods")
    .select("id, registration_id, period_start, period_end")
    .eq("organization_id", input.organizationId)
    .eq("id", input.filingPeriodId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!period) throw new Error("Filing period not found");

  const reconciliation = await reconcileTaxPeriod(supabase, {
    organizationId: input.organizationId,
    registrationId: period.registration_id as string,
    periodStart: period.period_start as string,
    periodEnd: period.period_end as string,
    filingPeriodId: period.id as string,
  });

  const { data: allocations } = await supabase
    .from("teller_tax_authority_payment_allocations")
    .select("allocated_amount, teller_tax_authority_payments!inner(status)")
    .eq("organization_id", input.organizationId)
    .eq("filing_period_id", input.filingPeriodId);

  let previouslyPaid = 0;
  for (const row of allocations ?? []) {
    const payment = row.teller_tax_authority_payments as { status?: string };
    if (payment?.status === "reversed" || payment?.status === "voided") continue;
    previouslyPaid = roundMoney(previouslyPaid + Number(row.allocated_amount));
  }

  const filedLiability = roundMoney(reconciliation.endingSubledgerLiability);
  const remainingBalance = roundMoney(Math.max(filedLiability - previouslyPaid, 0));

  const { data: unappliedRows } = await supabase
    .from("teller_tax_authority_payments")
    .select("unapplied_amount, status")
    .eq("organization_id", input.organizationId)
    .eq("registration_id", period.registration_id);

  let unappliedPayments = 0;
  for (const row of unappliedRows ?? []) {
    if (row.status === "reversed" || row.status === "voided") continue;
    unappliedPayments = roundMoney(unappliedPayments + Number(row.unapplied_amount));
  }

  return {
    filedLiability,
    previouslyPaid,
    remainingBalance,
    unappliedPayments,
  };
}
