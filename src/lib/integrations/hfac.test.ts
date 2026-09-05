import { describe, expect, it, vi } from "vitest";
import {
  billingExternalId,
  billingEntryIsOpen,
  billingEntryIsVoid,
  buildBillingFeeFromEntry,
  importSubscribersFromHfac,
  normalizeBillingEntry,
  paymentFeeRecorded,
} from "./hfac";

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

describe("normalizeBillingEntry", () => {
  it("maps HFAC stripe fee field names", () => {
    expect(
      normalizeBillingEntry({
        id: "entry-1",
        companyId: "co-1",
        date: "2026-03-01",
        description: "Platform fee",
        amountCents: 150000,
        status: "paid",
        stripeInvoiceId: "in_abc",
        stripeFeeCents: 4350,
        netReceivedCents: 145650,
      }),
    ).toMatchObject({
      feeAmountCents: 4350,
      netAmountCents: 145650,
      processor: "stripe",
    });
  });

  it("prefers explicit fee field names when both are sent", () => {
    expect(
      normalizeBillingEntry({
        id: "entry-1",
        companyId: "co-1",
        date: "2026-03-01",
        description: "Platform fee",
        amountCents: 10000,
        status: "paid",
        feeAmountCents: 300,
        stripeFeeCents: 999,
        netAmountCents: 9700,
        netReceivedCents: 8888,
      }).feeAmountCents,
    ).toBe(300);
  });
});

describe("billing import helpers", () => {
  it("treats pending HFAC rows as open invoices", () => {
    expect(billingEntryIsOpen("pending")).toBe(true);
    expect(billingEntryIsOpen("invoiced")).toBe(true);
    expect(billingEntryIsOpen("paid")).toBe(false);
  });

  it("treats credit HFAC rows as voided Stripe invoices", () => {
    expect(billingEntryIsVoid("credit")).toBe(true);
    expect(billingEntryIsVoid("paid")).toBe(false);
    expect(billingEntryIsVoid("pending")).toBe(false);
  });

  it("builds fee payload from HFAC stripe fields", () => {
    expect(
      buildBillingFeeFromEntry(
        normalizeBillingEntry({
          id: "entry-1",
          companyId: "co-1",
          date: "2026-03-01",
          description: "Platform subscription",
          amountCents: 25000,
          status: "paid",
          stripeInvoiceId: "in_abc",
          stripeFeeCents: 755,
          netReceivedCents: 24245,
        }),
        250,
      ),
    ).toEqual({
      feeAmount: 7.55,
      netAmount: 242.45,
      processorName: "stripe",
    });
  });

  it("detects when payment fees were already stored", () => {
    expect(paymentFeeRecorded({ payment: { fee: 42.65 } })).toBe(true);
    expect(paymentFeeRecorded({ payment: { gross: 1500 } })).toBe(false);
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
