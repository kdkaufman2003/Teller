import { describe, expect, it, vi } from "vitest";
import { billingExternalId, importSubscribersFromHfac } from "./hfac";

function mockSupabase(responses: {
  existing?: { id: string } | null;
  insertError?: string;
  updateError?: string;
}) {
  const insert = vi.fn().mockResolvedValue({ error: responses.insertError ? { message: responses.insertError } : null });
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: responses.updateError ? { message: responses.updateError } : null }),
  });

  return {
    from: vi.fn((table: string) => {
      if (table !== "teller_parties") throw new Error(`unexpected table ${table}`);
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: responses.existing ?? null }),
              }),
            }),
          }),
        }),
        insert,
        update,
      };
    }),
    insert,
    update,
  };
}

describe("billingExternalId", () => {
  it("prefers Stripe invoice id when present", () => {
    expect(
      billingExternalId({
        id: "entry-1",
        companyId: "co-1",
        stripeInvoiceId: "in_abc123",
      }),
    ).toBe("stripe-invoice:in_abc123");
  });

  it("falls back to company and entry id", () => {
    expect(
      billingExternalId({
        id: "entry-1",
        companyId: "co-1",
      }),
    ).toBe("billing:co-1:entry-1");
  });
});

describe("importSubscribersFromHfac", () => {
  it("creates a new subscriber party", async () => {
    const supabase = mockSupabase({ existing: null });
    const result = await importSubscribersFromHfac(supabase as never, "org-1", [
      { id: "sub-1", name: "ABC Mechanical", email: "a@example.com" },
    ]);
    expect(result).toEqual({ created: 1, updated: 0, skipped: 0 });
    expect(supabase.insert).toHaveBeenCalled();
  });

  it("updates an existing subscriber party", async () => {
    const supabase = mockSupabase({ existing: { id: "party-1" } });
    const result = await importSubscribersFromHfac(supabase as never, "org-1", [
      { id: "sub-1", name: "ABC Mechanical" },
    ]);
    expect(result).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(supabase.update).toHaveBeenCalled();
  });

  it("skips invalid rows", async () => {
    const supabase = mockSupabase({});
    const result = await importSubscribersFromHfac(supabase as never, "org-1", [
      { id: "", name: "No id" },
      { id: "sub-2", name: "   " },
    ]);
    expect(result.skipped).toBe(2);
  });
});
