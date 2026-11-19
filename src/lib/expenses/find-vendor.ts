import type { SupabaseClient } from "@supabase/supabase-js";
import { matchVendorName } from "./vendor-match";

export async function findOrCreateVendor(
  supabase: SupabaseClient,
  organizationId: string,
  input: { partyId?: string | null; vendorName?: string | null },
): Promise<string | null> {
  const requestedId = input.partyId?.trim() || "";
  if (requestedId) {
    const { data, error } = await supabase
      .from("teller_parties")
      .select("id, kind")
      .eq("organization_id", organizationId)
      .eq("id", requestedId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || (data.kind !== "vendor" && data.kind !== "both")) {
      throw new Error("Choose a vendor from this company.");
    }
    return data.id as string;
  }

  const name = input.vendorName?.trim() || "";
  if (!name) return null;

  const { data: vendors, error } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId)
    .in("kind", ["vendor", "both"]);
  if (error) throw new Error(error.message);

  const match = matchVendorName(name, vendors ?? []);
  if (match) return match.id;

  const { data: created, error: insertError } = await supabase
    .from("teller_parties")
    .insert({ organization_id: organizationId, kind: "vendor", name })
    .select("id")
    .single();
  if (insertError || !created) {
    throw new Error(insertError?.message || "Could not save the vendor");
  }
  return created.id as string;
}
