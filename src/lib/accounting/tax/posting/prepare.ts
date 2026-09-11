import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateTaxForOrganization } from "../calculate-for-org";
import { loadTaxSettings } from "../load-tax-settings";
import { planTaxPosting } from "../posting-contract";
import type { TaxCalculationInput, TaxCalculationResult } from "../calculation/types";
import type { TaxSourceType, TaxTransactionType } from "../types";
import { resolveSalesTaxPayableAccountId } from "./resolve-payable";

export type PreparedDocumentTaxPosting = {
  calculation: TaxCalculationResult;
  taxTotal: number;
  salesTaxPayableAccountId: string | null;
  schemaReady: boolean;
  canPost: boolean;
  reason?: string;
};

export async function prepareDocumentTaxPosting(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    calculationInput: TaxCalculationInput;
    sourceType: TaxSourceType;
    sourceId: string;
    transactionType: TaxTransactionType;
  },
): Promise<PreparedDocumentTaxPosting> {
  const { settings, schemaReady } = await loadTaxSettings(supabase, organizationId);
  const calculation = await calculateTaxForOrganization(supabase, organizationId, input.calculationInput);

  let salesTaxPayableAccountId: string | null = null;
  try {
    salesTaxPayableAccountId = resolveSalesTaxPayableAccountId(settings, calculation.taxTotal);
  } catch (error) {
    return {
      calculation,
      taxTotal: calculation.taxTotal,
      salesTaxPayableAccountId: null,
      schemaReady,
      canPost: false,
      reason: error instanceof Error ? error.message : "Sales tax payable account is not configured",
    };
  }

  const plan = planTaxPosting({
    organizationId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    transactionType: input.transactionType,
    transactionDate: input.calculationInput.transactionDate,
    calculation,
    salesTaxPayableAccountId: salesTaxPayableAccountId ?? "",
  });

  return {
    calculation,
    taxTotal: calculation.taxTotal,
    salesTaxPayableAccountId,
    schemaReady,
    canPost: plan.canPost,
    reason: plan.reason,
  };
}

export async function isPhase15TaxPostingEnabled(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { settings, schemaReady } = await loadTaxSettings(supabase, organizationId);
  if (!schemaReady) return false;
  return (
    settings.setupStatus === "configured" &&
    Boolean(settings.salesTaxPayableAccountId?.trim())
  );
}
