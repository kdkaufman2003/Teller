import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allocateJobNumber } from "./job-numbering";

describe("allocateJobNumber", () => {
  it("calls teller_allocate_sequence_number RPC with org-scoped job key", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "JOB-1001", error: null });
    const supabase = { rpc } as unknown as SupabaseClient;

    const number = await allocateJobNumber(supabase, "org-abc");

    expect(number).toBe("JOB-1001");
    expect(rpc).toHaveBeenCalledWith("teller_allocate_sequence_number", {
      p_organization_id: "org-abc",
      p_sequence_key: "job",
      p_default_prefix: "JOB",
    });
  });

  it("returns distinct numbers from concurrent RPC calls", async () => {
    let counter = 1000;
    const rpc = vi.fn().mockImplementation(async () => {
      counter += 1;
      return { data: `JOB-${counter}`, error: null };
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const [a, b, c] = await Promise.all([
      allocateJobNumber(supabase, "org-abc"),
      allocateJobNumber(supabase, "org-abc"),
      allocateJobNumber(supabase, "org-abc"),
    ]);

    expect(new Set([a, b, c]).size).toBe(3);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("surfaces RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "denied" } });
    const supabase = { rpc } as unknown as SupabaseClient;
    await expect(allocateJobNumber(supabase, "org-abc")).rejects.toThrow("denied");
  });
});
