import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateTax } from "./calculation/engine";
import { loadTaxCalculationConfig } from "./calculation/load-config";
import { loadPartyTaxExemptions } from "./exemptions/load";
import type { TaxCalculationInput, TaxCalculationResult } from "./calculation/types";

/** Server-side calculation — org derived from authenticated context, never client-supplied alone. */
export async function calculateTaxForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  input: TaxCalculationInput,
): Promise<TaxCalculationResult> {
  const config = await loadTaxCalculationConfig(supabase, organizationId, input.transactionDate);
  if (config.organizationId !== organizationId) {
    throw new Error("Tax configuration organization mismatch");
  }

  if (input.customer?.partyId && !input.customer.exemption) {
    config.partyExemptions = await loadPartyTaxExemptions(
      supabase,
      organizationId,
      input.customer.partyId,
      input.transactionDate,
    );
  }

  return calculateTax(input, config);
}
