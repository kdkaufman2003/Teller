import type { TaxCategoryRecord } from "./types";

/** Generic reference categories — industry-agnostic; HVAC maps in later slices. */
export const REFERENCE_TAX_CATEGORIES: readonly TaxCategoryRecord[] = [
  { categoryKey: "general_merchandise", name: "General merchandise", scope: "reference" },
  { categoryKey: "equipment", name: "Equipment", scope: "reference" },
  { categoryKey: "materials", name: "Materials", scope: "reference" },
  { categoryKey: "labor", name: "Labor", scope: "reference" },
  { categoryKey: "service", name: "Service", scope: "reference" },
  { categoryKey: "installation", name: "Installation", scope: "reference" },
  { categoryKey: "shipping", name: "Shipping & delivery", scope: "reference" },
  { categoryKey: "maintenance_agreement", name: "Maintenance agreement", scope: "reference" },
  { categoryKey: "digital_service", name: "Digital service", scope: "reference" },
  { categoryKey: "other", name: "Other", scope: "reference" },
] as const;

const REFERENCE_BY_KEY = new Map(REFERENCE_TAX_CATEGORIES.map((c) => [c.categoryKey, c]));

export function resolveTaxCategory(
  categoryKey: string,
  orgCategories: TaxCategoryRecord[] = [],
): TaxCategoryRecord | null {
  const org = orgCategories.find((c) => c.categoryKey === categoryKey);
  if (org) return org;
  return REFERENCE_BY_KEY.get(categoryKey) ?? null;
}

export function normalizeTaxCategoryKey(raw?: string | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return "other";
  if (REFERENCE_BY_KEY.has(trimmed)) return trimmed;
  return trimmed.replace(/\s+/g, "_");
}
