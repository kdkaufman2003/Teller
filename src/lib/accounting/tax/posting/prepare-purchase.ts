import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateTaxForOrganization } from "../calculate-for-org";
import { comparePurchaseTax, type PurchaseLineClassificationInput } from "../purchase/compare-vendor-tax";
import type { PurchaseTaxComparisonResult } from "../purchase/types";
import type { TaxCalculationInput, TaxCalculationResult } from "../calculation/types";
import { loadTaxSettings } from "../load-tax-settings";
import type { TaxSourceType } from "../types";
import {
  MissingTaxLiabilityAccountError,
  MissingUseTaxExpenseAccountError,
  resolveSalesTaxPayableAccountId,
  resolveUseTaxExpenseAccountId,
} from "./resolve-payable";

export type PreparedPurchaseTaxPosting = {
  calculation: TaxCalculationResult;
  comparison: PurchaseTaxComparisonResult;
  vendorTaxCharged: number;
  useTaxDueTotal: number;
  salesTaxPayableAccountId: string | null;
  useTaxExpenseAccountId: string | null;
  schemaReady: boolean;
  canPost: boolean;
  reason?: string;
};

export async function preparePurchaseTaxPosting(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    calculationInput: TaxCalculationInput;
    vendorTaxCharged: number;
    vendorTaxByLine?: Record<string, number>;
    lineClassifications?: PurchaseLineClassificationInput[];
    sourceType: TaxSourceType;
    sourceId: string;
  },
): Promise<PreparedPurchaseTaxPosting> {
  const { settings, schemaReady } = await loadTaxSettings(supabase, organizationId);
  const calculation = await calculateTaxForOrganization(supabase, organizationId, input.calculationInput);
  const comparison = comparePurchaseTax({
    calculation,
    vendorTaxCharged: input.vendorTaxCharged,
    vendorTaxByLine: input.vendorTaxByLine,
    lineClassifications: input.lineClassifications,
  });

  if (calculation.status === "needs_review" || comparison.status === "needs_review") {
    return {
      calculation,
      comparison,
      vendorTaxCharged: input.vendorTaxCharged,
      useTaxDueTotal: comparison.useTaxDueTotal,
      salesTaxPayableAccountId: null,
      useTaxExpenseAccountId: null,
      schemaReady,
      canPost: false,
      reason: "Purchase tax determination needs review before posting",
    };
  }

  let salesTaxPayableAccountId: string | null = null;
  let useTaxExpenseAccountId: string | null = null;

  try {
    salesTaxPayableAccountId = resolveSalesTaxPayableAccountId(settings, comparison.useTaxDueTotal);
    useTaxExpenseAccountId = resolveUseTaxExpenseAccountId(
      settings,
      comparison,
      calculation.lineResults.map((line) => line.lineKey),
    );
  } catch (error) {
    return {
      calculation,
      comparison,
      vendorTaxCharged: input.vendorTaxCharged,
      useTaxDueTotal: comparison.useTaxDueTotal,
      salesTaxPayableAccountId: null,
      useTaxExpenseAccountId: null,
      schemaReady,
      canPost: false,
      reason:
        error instanceof MissingTaxLiabilityAccountError || error instanceof MissingUseTaxExpenseAccountError
          ? error.message
          : "Purchase tax accounts are not configured",
    };
  }

  if (comparison.useTaxDueTotal > 0.009 && !salesTaxPayableAccountId) {
    return {
      calculation,
      comparison,
      vendorTaxCharged: input.vendorTaxCharged,
      useTaxDueTotal: comparison.useTaxDueTotal,
      salesTaxPayableAccountId: null,
      useTaxExpenseAccountId,
      schemaReady,
      canPost: false,
      reason: "Sales tax payable account is not configured",
    };
  }

  return {
    calculation,
    comparison,
    vendorTaxCharged: input.vendorTaxCharged,
    useTaxDueTotal: comparison.useTaxDueTotal,
    salesTaxPayableAccountId,
    useTaxExpenseAccountId,
    schemaReady,
    canPost: true,
  };
}
