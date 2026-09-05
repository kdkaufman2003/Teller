import { describe, expect, it } from "vitest";
import { classifyLegacyPaymentDocument } from "./legacy-payments";

describe("classifyLegacyPaymentDocument", () => {
  it("marks aligned sources as CONSISTENT", () => {
    expect(
      classifyLegacyPaymentDocument({
        kind: "invoice",
        status: "open",
        documentTotal: 1500,
        cachedPaid: 500,
        paymentsSum: 500,
        ledgerPaid: 500,
      }),
    ).toBe("CONSISTENT");
  });

  it("detects cache-only legacy payments", () => {
    expect(
      classifyLegacyPaymentDocument({
        kind: "invoice",
        status: "open",
        documentTotal: 1000,
        cachedPaid: 500,
        paymentsSum: 0,
        ledgerPaid: 0,
      }),
    ).toBe("CACHE_ONLY_PAYMENT");
  });

  it("detects ledger-only legacy payments", () => {
    expect(
      classifyLegacyPaymentDocument({
        kind: "invoice",
        status: "open",
        documentTotal: 1000,
        cachedPaid: 0,
        paymentsSum: 0,
        ledgerPaid: 1000,
      }),
    ).toBe("LEDGER_ONLY_PAYMENT");
  });

  it("detects paid status mismatch", () => {
    expect(
      classifyLegacyPaymentDocument({
        kind: "expense",
        status: "paid",
        documentTotal: 500,
        cachedPaid: 500,
        paymentsSum: 200,
        ledgerPaid: 200,
      }),
    ).toBe("PAID_STATUS_MISMATCH");
  });

  it("detects void mismatch", () => {
    expect(
      classifyLegacyPaymentDocument({
        kind: "invoice",
        status: "void",
        documentTotal: 500,
        cachedPaid: 100,
        paymentsSum: 0,
        ledgerPaid: 0,
      }),
    ).toBe("VOID_MISMATCH");
  });
});
