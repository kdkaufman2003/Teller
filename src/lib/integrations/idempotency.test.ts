import { describe, expect, it } from "vitest";
import { paymentIdempotencyKey, quoteIdempotencyKey } from "./idempotency";

describe("paymentIdempotencyKey", () => {
  it("prefers Stripe payment intent id", () => {
    expect(
      paymentIdempotencyKey({
        stripePaymentIntentId: "pi_abc123",
        paidAt: "2026-03-01T12:00:00Z",
        amount: 8500,
      }),
    ).toBe("stripe:pi:pi_abc123");
  });

  it("falls back to Stripe invoice id and date", () => {
    expect(
      paymentIdempotencyKey({
        stripeInvoiceId: "in_xyz",
        paidAt: "2026-03-01T12:00:00Z",
        amount: 1200,
      }),
    ).toBe("stripe:in:in_xyz:2026-03-01");
  });

  it("uses HFAC deal id when Stripe ids are absent", () => {
    expect(
      paymentIdempotencyKey({
        hfacDealId: "deal-99",
        paidAt: "2026-03-01",
        amount: 500,
      }),
    ).toBe("hfac:deal:deal-99:2026-03-01:500");
  });
});

describe("quoteIdempotencyKey", () => {
  it("includes source and quote id", () => {
    expect(quoteIdempotencyKey("deal", "q-42")).toBe("hfac:quote:deal:q-42");
  });
});
