import type { SupabaseClient } from "@supabase/supabase-js";
import { getStateTaxPack, getStateTaxPackForState, toStatePackProfile } from "../state-packs/registry";
import { loadTaxSettings } from "../load-tax-settings";
import type { TaxRateComponentRecord, TaxabilityRuleRecord } from "../types";
import type { StatePackProfile } from "../state-packs/types";
import type { TaxCalculationConfig } from "./types";

type RateComponentRow = {
  id: string;
  rate_id: string;
  component_type: string;
  jurisdiction_key: string;
  authority_id: string | null;
  rate_percent: number;
  effective_from: string;
  effective_to: string | null;
};

type TaxabilityRuleRow = {
  id: string;
  organization_id: string;
  jurisdiction_key: string;
  tax_category_key: string;
  treatment: string;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  source_kind: string;
  rule_set_slug: string | null;
};

type RegistrationRow = {
  jurisdiction_key: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
};

function mapRateComponent(row: RateComponentRow): TaxRateComponentRecord & { rateId: string } {
  return {
    rateId: row.rate_id,
    componentType: row.component_type as TaxRateComponentRecord["componentType"],
    jurisdictionKey: row.jurisdiction_key,
    authorityId: row.authority_id,
    ratePercent: Number(row.rate_percent),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

function mapTaxabilityRule(row: TaxabilityRuleRow): TaxabilityRuleRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    jurisdictionKey: row.jurisdiction_key,
    taxCategoryKey: row.tax_category_key,
    treatment: row.treatment as TaxabilityRuleRecord["treatment"],
    priority: row.priority,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    sourceKind: row.source_kind as TaxabilityRuleRecord["sourceKind"],
    ruleSetSlug: row.rule_set_slug,
  };
}

function buildStatePackProfiles(registrations: RegistrationRow[]): Record<string, StatePackProfile> {
  const profiles: Record<string, StatePackProfile> = {};
  for (const registration of registrations) {
    if (registration.status !== "active") continue;
    const metadata = registration.metadata ?? {};
    const packId = typeof metadata.statePackId === "string" ? metadata.statePackId : null;
    const pack = packId ? getStateTaxPack(packId) : null;
    if (pack) {
      profiles[pack.state.toUpperCase()] = toStatePackProfile(pack);
      continue;
    }
    const state = registration.jurisdiction_key?.split("-")[1]?.toUpperCase();
    if (state) {
      const fallback = getStateTaxPackForState(state);
      if (fallback) profiles[state] = toStatePackProfile(fallback);
    }
  }
  return profiles;
}

/** Loads org-scoped tax configuration for calculation. Service role must filter by organizationId. */
export async function loadTaxCalculationConfig(
  supabase: SupabaseClient,
  organizationId: string,
  asOf: string,
): Promise<TaxCalculationConfig> {
  const { settings } = await loadTaxSettings(supabase, organizationId);

  const [{ data: rules }, { data: rateComponents }, { data: registrations }, { data: org }] = await Promise.all([
    supabase.from("teller_taxability_rules").select("*").eq("organization_id", organizationId),
    supabase
      .from("teller_tax_rate_components")
      .select("*")
      .lte("effective_from", asOf)
      .or(`effective_to.is.null,effective_to.gte.${asOf}`),
    supabase
      .from("teller_tax_registrations")
      .select("jurisdiction_key, metadata, status")
      .eq("organization_id", organizationId),
    supabase.from("teller_organizations").select("country, state, city, postal_code").eq("id", organizationId).maybeSingle(),
  ]);

  const statePackProfiles = buildStatePackProfiles((registrations ?? []) as RegistrationRow[]);

  return {
    organizationId,
    roundingPolicy: settings.roundingPolicy,
    taxabilityRules: (rules ?? []).map((row) => mapTaxabilityRule(row as TaxabilityRuleRow)),
    rateComponents: (rateComponents ?? []).map((row) => mapRateComponent(row as RateComponentRow)),
    sellerLocation: org
      ? {
          country: org.country ?? "US",
          state: org.state ?? undefined,
          city: org.city ?? undefined,
          postalCode: org.postal_code ?? undefined,
          locationKind: "seller",
        }
      : null,
    statePackProfiles,
    useIndustryHvacMapping: true,
  };
}
