import { normalizeTaxCategoryKey, resolveTaxCategory } from "../categories";
import { mapHvacItemTypeToTaxCategory } from "../state-packs/industry/hvac-mapping";
import { TaxReviewReason } from "./reason-codes";
import type { TaxCategoryRecord, TaxTreatment } from "../types";

export type CategoryResolutionInput = {
  explicitCategory?: string | null;
  itemType?: string | null;
  useIndustryHvacMapping?: boolean;
  productCategoryMapping?: Record<string, string>;
  industryCategoryMapping?: Record<string, string>;
  defaultCategory?: string | null;
  orgCategories?: TaxCategoryRecord[];
};

export type CategoryResolutionResult = {
  categoryKey: string | null;
  source: string;
  reasonCodes: string[];
};

export function resolveLineCategory(input: CategoryResolutionInput): CategoryResolutionResult {
  if (input.useIndustryHvacMapping && input.itemType?.trim() && !input.explicitCategory?.trim()) {
    const mapped = mapHvacItemTypeToTaxCategory(input.itemType);
    const reasonCodes: string[] = [];
    if (mapped.factDependent) reasonCodes.push(TaxReviewReason.FACT_DEPENDENT_CLASSIFICATION);
    if (resolveTaxCategory(mapped.categoryKey, input.orgCategories ?? [])) {
      return { categoryKey: mapped.categoryKey, source: "industry_hvac", reasonCodes };
    }
    return {
      categoryKey: mapped.categoryKey,
      source: "industry_hvac_unregistered",
      reasonCodes: [...reasonCodes, TaxReviewReason.MISSING_TAX_CATEGORY],
    };
  }

  if (input.explicitCategory?.trim()) {
    const key = normalizeTaxCategoryKey(input.explicitCategory);
    if (resolveTaxCategory(key, input.orgCategories ?? [])) {
      return { categoryKey: key, source: "explicit", reasonCodes: [] };
    }
    return {
      categoryKey: key,
      source: "explicit_unregistered",
      reasonCodes: [TaxReviewReason.MISSING_TAX_CATEGORY],
    };
  }

  return {
    categoryKey: null,
    source: "unresolved",
    reasonCodes: [TaxReviewReason.MISSING_TAX_CATEGORY],
  };
}

export function resolveIndustryTreatment(
  categoryKey: string,
  mapping?: Record<string, TaxTreatment>,
): TaxTreatment | null {
  return mapping?.[categoryKey] ?? null;
}
