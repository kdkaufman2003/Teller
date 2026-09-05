import { describe, expect, it } from "vitest";
import {
  documentRemainingBalance,
  validateDocumentPayment,
} from "./balances";
import { buildInvoicePaymentLines } from "./payment-fees";
import { assertBalanced, buildReversalLines } from "./post";

describe("documentRemainingBalance", () => {
  it("returns zero when fully paid", () => {
    expect(documentRemainingBalance(1500, 1500)).toBe(0);
  });

  it("tracks partial payments", () => {
    expect(documentRemainingBalance(1500, 500)).toBe(1000);
  });
});

describe("validateDocumentPayment", () => {
  it("accepts a valid partial payment", () => {
    expect(
      validateDocumentPayment({
        documentTotal: 1500,
        amountPaid: 500,
        paymentAmount: 500,
      }),
    ).toEqual({ remainingBefore: 1000, paymentAmount: 500 });
  });

  it("accepts the final payment clearing balance", () => {
    expect(
      validateDocumentPayment({
        documentTotal: 1500,
        amountPaid: 500,
        paymentAmount: 1000,
      }),
    ).toEqual({ remainingBefore: 1000, paymentAmount: 1000 });
  });

  it("rejects payment when nothing remains", () => {
    expect(() =>
      validateDocumentPayment({
        documentTotal: 1500,
        amountPaid: 1500,
        paymentAmount: 1,
      }),
    ).toThrow(/nothing left to pay/i);
  });

  it("rejects overpayment", () => {
    expect(() =>
      validateDocumentPayment({
        documentTotal: 1500,
        amountPaid: 500,
        paymentAmount: 1001,
      }),
    ).toThrow(/exceeds remaining balance/i);
  });

  it("rejects zero payment", () => {
    expect(() =>
      validateDocumentPayment({
        documentTotal: 1500,
        amountPaid: 0,
        paymentAmount: 0,
      }),
    ).toThrow(/greater than zero/i);
  });
});

describe("invoice partial payment journal entries", () => {
  it("posts balanced partial and final payments without fees", () => {
    const partial = buildInvoicePaymentLines({
      cashAccountId: "cash",
      arAccountId: "ar",
      grossAmount: 500,
    });
    expect(() => assertBalanced(partial)).not.toThrow();

    const final = buildInvoicePaymentLines({
      cashAccountId: "cash",
      arAccountId: "ar",
      grossAmount: 1000,
    });
    expect(() => assertBalanced(final)).not.toThrow();
  });

  it("keeps payment fee journal balanced", () => {
    const lines = buildInvoicePaymentLines({
      cashAccountId: "cash",
      arAccountId: "ar",
      feeAccountId: "fee",
      grossAmount: 1000,
      feeAmount: 30,
      netAmount: 970,
    });
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(lines.find((line) => line.account_id === "ar")?.credit).toBe(1000);
    expect(lines.find((line) => line.account_id === "cash")?.debit).toBe(970);
    expect(lines.find((line) => line.account_id === "fee")?.debit).toBe(30);
  });
});

describe("expense void reversal", () => {
  it("nets paid expense GL to zero", () => {
    const original = [
      {
        account_id: "expense",
        debit: 500,
        credit: 0,
        party_id: null,
        job_id: null,
        memo: "Expense EXP-001",
      },
      {
        account_id: "cash",
        debit: 0,
        credit: 500,
        party_id: null,
        job_id: null,
        memo: "Expense EXP-001",
      },
    ];
    const reversed = buildReversalLines(original);
    expect(() => assertBalanced(reversed)).not.toThrow();

    const net = [...original, ...reversed];
    const debit = net.reduce((sum, line) => sum + (line.debit ?? 0), 0);
    const credit = net.reduce((sum, line) => sum + (line.credit ?? 0), 0);
    expect(debit).toBe(credit);
  });

  it("nets unpaid bill GL to zero", () => {
    const original = [
      {
        account_id: "expense",
        debit: 1000,
        credit: 0,
        party_id: null,
        job_id: null,
        memo: "Expense EXP-002",
      },
      {
        account_id: "ap",
        debit: 0,
        credit: 1000,
        party_id: null,
        job_id: null,
        memo: "Expense EXP-002",
      },
    ];
    const reversed = buildReversalLines(original);
    expect(() => assertBalanced(reversed)).not.toThrow();
  });
});

describe("AP payment journal", () => {
  it("posts balanced Dr AP / Cr Cash entries", () => {
    const lines = [
      { account_id: "ap", debit: 400, credit: 0 },
      { account_id: "cash", debit: 0, credit: 400 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });
});
