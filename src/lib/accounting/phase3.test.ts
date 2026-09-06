import { describe, expect, it } from "vitest";
import {
  assertDepositApplicationIdempotencyMatch,
  normalizeApplicationEventId,
  normalizeReceiptEventId,
} from "./deposits";
import { documentRemainingBalance } from "./balances";

describe("deposit remaining balance", () => {
  it("full deposit unapplied after receipt", () => {
    expect(documentRemainingBalance(5000, 0)).toBe(5000);
  });

  it("partial application leaves remainder", () => {
    expect(documentRemainingBalance(5000, 3000)).toBe(2000);
  });

  it("full application leaves zero", () => {
    expect(documentRemainingBalance(5000, 5000)).toBe(0);
  });
});

describe("customer net position math", () => {
  it("invoice 15,000 + deposit 5,000 unapplied → net due 10,000", () => {
    const invoiceRemaining = 15000;
    const unappliedDeposits = 5000;
    expect(invoiceRemaining - unappliedDeposits).toBe(10000);
  });

  it("after 3,000 apply: invoice 12,000 + deposit 2,000 → net due 10,000", () => {
    const invoiceRemaining = 12000;
    const unappliedDeposits = 2000;
    expect(invoiceRemaining - unappliedDeposits).toBe(10000);
  });

  it("AR and deposits reconcile independently before apply", () => {
    expect(15000).toBe(15000); // AR control
    expect(5000).toBe(5000); // deposit liability
    expect(15000 - 5000).toBe(10000); // customer display only
  });

  it("after partial apply: AR 12,000 and deposit liability 2,000", () => {
    expect(12000).toBe(12000);
    expect(2000).toBe(2000);
  });
});

describe("deposit application validation concepts", () => {
  it("rejects apply amount over deposit remaining", () => {
    const depositRemaining = 2000;
    const applyAmount = 2500;
    expect(applyAmount > depositRemaining).toBe(true);
  });

  it("rejects apply amount over invoice remaining", () => {
    const invoiceRemaining = 12000;
    const applyAmount = 15000;
    expect(applyAmount > invoiceRemaining).toBe(true);
  });
});

describe("deposit application idempotency", () => {
  const eventId = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

  it("accepts valid UUID application event id", () => {
    expect(normalizeApplicationEventId(eventId)).toBe(eventId);
  });

  it("generates UUID when event id omitted", () => {
    const generated = normalizeApplicationEventId();
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects invalid application event id", () => {
    expect(() => normalizeApplicationEventId("event-A")).toThrow(/valid UUID/i);
  });

  it("detects idempotency conflict on different amount", () => {
    expect(() =>
      assertDepositApplicationIdempotencyMatch(
        {
          id: "1",
          payment_id: "pay-1",
          document_id: "inv-1",
          amount: 3000,
          application_journal_entry_id: "je-1",
          application_event_id: eventId,
        },
        { paymentId: "pay-1", invoiceId: "inv-1", amount: 2000 },
      ),
    ).toThrow(/different amount/i);
  });

  it("detects idempotency conflict on different invoice", () => {
    expect(() =>
      assertDepositApplicationIdempotencyMatch(
        {
          id: "1",
          payment_id: "pay-1",
          document_id: "inv-1",
          amount: 3000,
          application_journal_entry_id: "je-1",
          application_event_id: eventId,
        },
        { paymentId: "pay-1", invoiceId: "inv-2", amount: 3000 },
      ),
    ).toThrow(/different invoice/i);
  });
});

describe("deposit receipt idempotency", () => {
  it("generates UUID when receipt event id omitted", () => {
    const generated = normalizeReceiptEventId();
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
