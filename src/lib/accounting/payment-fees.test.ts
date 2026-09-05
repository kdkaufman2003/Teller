import { describe, expect, it } from "vitest";
import {
  buildInvoicePaymentLines,
  paymentProcessingFeeAccount,
  resolvePaymentAmounts,
} from "./payment-fees";

const ACCOUNTS = [
  { id: "cash", code: "1000", type: "asset", subtype: "bank", name: "Cash" },
  { id: "ar", code: "1100", type: "asset", subtype: "receivable", name: "Accounts Receivable" },
  { id: "fee", code: "6150", type: "expense", subtype: "payment_fee", name: "Payment Processing Fees" },
  { id: "other", code: "6900", type: "expense", name: "Other Expense" },
];

describe("resolvePaymentAmounts", () => {
  it("derives net from gross and fee", () => {
    expect(resolvePaymentAmounts({ grossAmount: 100, feeAmount: 2.9 })).toEqual({
      grossAmount: 100,
      feeAmount: 2.9,
      netAmount: 97.1,
    });
  });

  it("derives fee from gross and net", () => {
    expect(resolvePaymentAmounts({ grossAmount: 1500, netAmount: 1456.5 })).toEqual({
      grossAmount: 1500,
      feeAmount: 43.5,
      netAmount: 1456.5,
    });
  });

  it("treats full deposit as gross when no fee is sent", () => {
    expect(resolvePaymentAmounts({ grossAmount: 500 })).toEqual({
      grossAmount: 500,
      feeAmount: 0,
      netAmount: 500,
    });
  });
});

describe("buildInvoicePaymentLines", () => {
  it("splits cash, fee, and AR when a processor fee exists", () => {
    const lines = buildInvoicePaymentLines({
      cashAccountId: "cash",
      arAccountId: "ar",
      feeAccountId: "fee",
      grossAmount: 100,
      feeAmount: 2.9,
      processorName: "Stripe",
    });

    expect(lines).toEqual([
      expect.objectContaining({ account_id: "cash", debit: 97.1 }),
      expect.objectContaining({ account_id: "fee", debit: 2.9, memo: "Stripe processing fee" }),
      expect.objectContaining({ account_id: "ar", credit: 100 }),
    ]);
  });

  it("uses the classic two-line entry when there is no fee", () => {
    const lines = buildInvoicePaymentLines({
      cashAccountId: "cash",
      arAccountId: "ar",
      grossAmount: 250,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ account_id: "cash", debit: 250 });
    expect(lines[1]).toMatchObject({ account_id: "ar", credit: 250 });
  });
});

describe("paymentProcessingFeeAccount", () => {
  it("prefers the payment_fee subtype", () => {
    expect(paymentProcessingFeeAccount(ACCOUNTS)?.id).toBe("fee");
  });

  it("falls back to other expense", () => {
    expect(
      paymentProcessingFeeAccount([
        { id: "cash", code: "1000", type: "asset" },
        { id: "other", code: "6900", type: "expense", name: "Other Expense" },
      ])?.id,
    ).toBe("other");
  });
});
