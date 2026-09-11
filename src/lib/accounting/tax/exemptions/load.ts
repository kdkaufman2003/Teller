import type { SupabaseClient } from "@supabase/supabase-js";
import { parseTaxExemptionRow } from "./parse";
import type { ParsedTaxExemption, TaxExemptionRow } from "./types";

export async function loadPartyTaxExemptions(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string,
  asOf?: string,
): Promise<ParsedTaxExemption[]> {
  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("party_id", partyId)
    .order("effective_from", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => parseTaxExemptionRow(row as TaxExemptionRow, asOf));
}

export async function loadOrganizationTaxExemptions(
  supabase: SupabaseClient,
  organizationId: string,
  filters?: { status?: string; partyId?: string },
  asOf?: string,
): Promise<ParsedTaxExemption[]> {
  let query = supabase.from("teller_tax_exemptions").select("*").eq("organization_id", organizationId);
  if (filters?.partyId) query = query.eq("party_id", filters.partyId);
  if (filters?.status) query = query.eq("status", filters.status);
  const { data, error } = await query.order("effective_from", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => parseTaxExemptionRow(row as TaxExemptionRow, asOf));
}
