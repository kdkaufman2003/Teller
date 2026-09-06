import type { SupabaseClient } from "@supabase/supabase-js";

/** Concurrency-safe JOB-1001 style numbers via teller_allocate_sequence_number RPC. */
export async function allocateJobNumber(
  supabase: SupabaseClient,
  organizationId: string,
  prefix = "JOB",
): Promise<string> {
  const { data, error } = await supabase.rpc("teller_allocate_sequence_number", {
    p_organization_id: organizationId,
    p_sequence_key: "job",
    p_default_prefix: prefix,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "string") throw new Error("Could not allocate job number");
  return data;
}
