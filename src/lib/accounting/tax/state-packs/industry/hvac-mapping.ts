import { normalizeTaxCategoryKey } from "../../categories";

/** HVAC industry item types → generic tax categories (industry-agnostic engine). */
const HVAC_ITEM_TYPE_TO_CATEGORY: Record<string, string> = {
  hvac_equipment: "equipment",
  equipment: "equipment",
  hvac_parts: "materials",
  parts: "materials",
  repair_parts: "materials",
  hvac_installation: "installation",
  installation: "installation",
  hvac_labor: "labor",
  repair_labor: "labor",
  labor: "labor",
  hvac_service: "service",
  service: "service",
  maintenance: "maintenance_agreement",
  maintenance_agreement: "maintenance_agreement",
  service_agreement: "maintenance_agreement",
};

/** Fact patterns Teller cannot determine — always needs_review regardless of state pack defaults. */
const FACT_DEPENDENT_ITEM_TYPES = new Set([
  "real_property_improvement",
  "new_construction",
  "resale_purchase",
  "contractor_materials_bundled",
  "mixed_contract",
]);

export function mapHvacItemTypeToTaxCategory(itemType?: string | null): {
  categoryKey: string;
  factDependent: boolean;
} {
  const normalized = normalizeTaxCategoryKey(itemType);
  if (FACT_DEPENDENT_ITEM_TYPES.has(normalized)) {
    return { categoryKey: normalized, factDependent: true };
  }
  const mapped = HVAC_ITEM_TYPE_TO_CATEGORY[normalized] ?? normalized;
  return { categoryKey: mapped, factDependent: false };
}
