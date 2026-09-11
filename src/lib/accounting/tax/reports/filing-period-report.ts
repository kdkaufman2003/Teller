import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import { reconcileTaxPeriod } from "../filing/reconcile";
import type { TaxFilingPeriodReport } from "./types";
import { TAX_REPORT_DATE_BASIS, TAX_REPORT_VERSION } from "./types";
import { resolveFilingPeriodDateRange } from "./load";

export async function buildFilingPeriodTaxReport(
  supabase: SupabaseClient,
  organizationId: string,
  filingPeriodId: string,
): Promise<TaxFilingPeriodReport> {
  const { data: period, error } = await supabase
    .from("teller_tax_filing_periods")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", filingPeriodId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!period) throw new Error("Filing period not found");

  const periodRange = await resolveFilingPeriodDateRange(supabase, organizationId, filingPeriodId);
  const reconciliation = await reconcileTaxPeriod(supabase, {
    organizationId,
    registrationId: periodRange.registrationId,
    periodStart: periodRange.startDate,
    periodEnd: periodRange.endDate,
  });

  let authorityName: string | null = null;
  if (period.authority_id) {
    const { data: authority } = await supabase
      .from("teller_tax_authorities")
      .select("name")
      .eq("id", period.authority_id)
      .maybeSingle();
    authorityName = (authority?.name as string | null) ?? null;
  }

  const paid = roundMoney(reconciliation.authorityPaymentsApplied);
  const netLiability = roundMoney(reconciliation.netSubledgerLiability);
  const remaining = roundMoney(reconciliation.endingOutstandingLiability);

  return {
    version: TAX_REPORT_VERSION,
    dateBasis: TAX_REPORT_DATE_BASIS,
    generatedAt: new Date().toISOString(),
    periodId: filingPeriodId,
    periodStart: period.period_start as string,
    periodEnd: period.period_end as string,
    registrationId: period.registration_id as string,
    jurisdictionKey: (period.jurisdiction_key as string | null) ?? null,
    authorityName,
    status: period.status as TaxFilingPeriodReport["status"],
    salesTaxAccrued: reconciliation.salesTaxAccrued,
    useTaxAccrued: reconciliation.useTaxAccrued,
    salesTaxCredits: reconciliation.salesTaxCredits,
    taxAdjustments: reconciliation.taxAdjustments,
    netLiability,
    paid,
    remaining,
    reconciliationDifference: reconciliation.subledgerToGlDifference,
    exceptionCount: reconciliation.exceptions.length,
    readiness: reconciliation.readiness,
  };
}
