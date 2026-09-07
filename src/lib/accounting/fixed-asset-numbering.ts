import type { SupabaseClient } from "@supabase/supabase-js";

/** Concurrency-safe FA-1001 style numbers via teller_allocate_sequence_number RPC. */
export async function allocateAssetNumber(
  supabase: SupabaseClient,
  organizationId: string,
  prefix = "FA",
): Promise<string> {
  const { data, error } = await supabase.rpc("teller_allocate_sequence_number", {
    p_organization_id: organizationId,
    p_sequence_key: "fixed_asset",
    p_default_prefix: prefix,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "string") throw new Error("Could not allocate asset number");
  return data;
}
