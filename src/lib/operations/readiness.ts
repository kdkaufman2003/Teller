import type { SupabaseClient } from "@supabase/supabase-js";

export type ReadinessCheck = {
  ok: boolean;
  db: "connected" | "unavailable";
  probes?: {
    phase17b?: boolean;
    phase17c?: boolean;
    phase17d?: boolean;
    phase17e?: boolean;
  };
};

export async function checkDatabaseReadiness(
  supabase: SupabaseClient,
  options?: { includeProbes?: boolean },
): Promise<ReadinessCheck> {
  const { error } = await supabase
    .from("teller_organizations")
    .select("id", { head: true, count: "exact" })
    .limit(1);

  if (error) {
    return { ok: false, db: "unavailable" };
  }

  const result: ReadinessCheck = { ok: true, db: "connected" };

  if (options?.includeProbes) {
    const probes: ReadinessCheck["probes"] = {};
    const probeNames = [
      ["phase17b", "teller_phase17b_journal_insert_blocked"],
      ["phase17c", "teller_phase17c_reliability_probe"],
      ["phase17d", "teller_phase17d_performance_probe"],
      ["phase17e", "teller_phase17e_operations_probe"],
    ] as const;

    for (const [key, rpc] of probeNames) {
      const { data, error: probeError } = await supabase.rpc(rpc);
      if (probeError?.message?.includes("Could not find the function")) {
        probes[key] = false;
      } else {
        probes[key] = data === true;
      }
    }
    result.probes = probes;
  }

  return result;
}
