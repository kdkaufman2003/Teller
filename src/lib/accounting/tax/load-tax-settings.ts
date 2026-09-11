import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateTaxReadiness } from "./readiness";
import { DEFAULT_TAX_SETTINGS, parseTaxSettingsRow, type TaxSettingsRow } from "./settings";
import type { TaxSettingsRecord } from "./types";

function isMissingTaxSettingsTable(message: string): boolean {
  return /does not exist|schema cache/i.test(message);
}

export async function loadTaxSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{
  settings: TaxSettingsRecord;
  schemaReady: boolean;
  readiness: ReturnType<typeof evaluateTaxReadiness>;
}> {
  const { data, error } = await supabase
    .from("teller_tax_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error && isMissingTaxSettingsTable(error.message)) {
    const settings = { organizationId, ...DEFAULT_TAX_SETTINGS };
    return {
      settings,
      schemaReady: false,
      readiness: evaluateTaxReadiness({ settings }),
    };
  }
  if (error) throw new Error(error.message);

  const settings = parseTaxSettingsRow(data as TaxSettingsRow | null, organizationId);

  const [{ count: registrationCount }, { count: ruleCount }, { count: rateCount }] = await Promise.all([
    supabase
      .from("teller_tax_registrations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "active"),
    supabase
      .from("teller_taxability_rules")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    supabase
      .from("teller_tax_rate_components")
      .select("id", { count: "exact", head: true }),
  ]);

  const { data: registrations } = await supabase
    .from("teller_tax_registrations")
    .select("status")
    .eq("organization_id", organizationId);

  const readiness = evaluateTaxReadiness({
    settings,
    registrations: (registrations ?? []) as Array<{ status: "active" | "inactive" | "pending" }>,
    hasActiveRates: (rateCount ?? 0) > 0,
    hasTaxabilityRules: (ruleCount ?? 0) > 0,
  });

  if (registrationCount === null && ruleCount === null) {
    return { settings, schemaReady: false, readiness: evaluateTaxReadiness({ settings }) };
  }

  return {
    settings: { ...settings, setupStatus: readiness.status },
    schemaReady: true,
    readiness,
  };
}
