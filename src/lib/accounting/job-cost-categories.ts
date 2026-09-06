import type { SupabaseClient } from "@supabase/supabase-js";

export type JobCostCategorySeed = {
  code: string;
  name: string;
  categoryType: "material" | "labor" | "subcontract" | "equipment" | "other";
  sortOrder: number;
};

export const HVAC_DEFAULT_COST_CATEGORIES: JobCostCategorySeed[] = [
  { code: "equipment", name: "Equipment", categoryType: "equipment", sortOrder: 10 },
  { code: "materials", name: "Materials", categoryType: "material", sortOrder: 20 },
  { code: "labor", name: "Labor", categoryType: "labor", sortOrder: 30 },
  { code: "subcontractors", name: "Subcontractors", categoryType: "subcontract", sortOrder: 40 },
  { code: "permits", name: "Permits", categoryType: "other", sortOrder: 50 },
  { code: "freight", name: "Freight", categoryType: "other", sortOrder: 60 },
  { code: "rentals", name: "Rentals", categoryType: "equipment", sortOrder: 70 },
  { code: "disposal", name: "Disposal", categoryType: "other", sortOrder: 80 },
  { code: "other_direct", name: "Other Direct Cost", categoryType: "other", sortOrder: 90 },
];

export const HVAC_DEFAULT_JOB_TYPES = [
  "Replacement",
  "New Construction",
  "Service",
  "Commercial",
  "Maintenance",
  "Other",
];

export async function seedHvacJobCostCategories(
  supabase: SupabaseClient,
  organizationId: string,
) {
  for (const row of HVAC_DEFAULT_COST_CATEGORIES) {
    const { data: existing } = await supabase
      .from("teller_job_cost_categories")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) continue;

    await supabase.from("teller_job_cost_categories").insert({
      organization_id: organizationId,
      code: row.code,
      name: row.name,
      category_type: row.categoryType,
      sort_order: row.sortOrder,
      active: true,
    });
  }
}
