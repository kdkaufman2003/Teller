import { describe, expect, it } from "vitest";
import {
  allocationKindForDocumentKind,
  paymentTypeForDocumentKind,
} from "./allocations";
import {
  assertInvoiceStatusTransition,
  assertExpenseStatusTransition,
  canVoidInvoiceWithoutPayments,
  invoiceStatusAfterPayment,
} from "./document-transitions";
import { linkKindFromSourceKind } from "./journal-links";
import { buildArAging } from "./financial-reports";
import { isBilledInvoice } from "./reports";
import { validateDocumentPayment } from "./balances";

describe("invoiceStatusAfterPayment", () => {
  it("stays open with no payments", () => {
    expect(invoiceStatusAfterPayment(15000, 0)).toBe("open");
  });

  it("becomes partially_paid after partial payment", () => {
    expect(invoiceStatusAfterPayment(15000, 3000)).toBe("partially_paid");
  });

  it("becomes paid when fully collected", () => {
    expect(invoiceStatusAfterPayment(15000, 15000)).toBe("paid");
  });
});

describe("invoice status transitions", () => {
  it("allows draft to open", () => {
    expect(() => assertInvoiceStatusTransition("draft", "open")).not.toThrow();
  });

  it("allows open to partially_paid", () => {
    expect(() => assertInvoiceStatusTransition("open", "partially_paid")).not.toThrow();
  });

  it("allows partially_paid to paid", () => {
    expect(() => assertInvoiceStatusTransition("partially_paid", "paid")).not.toThrow();
  });

  it("blocks void when payments exist", () => {
    expect(() =>
      assertInvoiceStatusTransition("partially_paid", "void", { hasActivePayments: true }),
    ).toThrow(/payment activity/i);
  });

  it("allows void on unpaid invoice", () => {
    expect(canVoidInvoiceWithoutPayments(false)).toBe(true);
    expect(() =>
      assertInvoiceStatusTransition("open", "void", { hasActivePayments: false }),
    ).not.toThrow();
  });

  it("rejects impossible transitions", () => {
    expect(() => assertInvoiceStatusTransition("paid", "open")).toThrow(/invalid/i);
  });
});

describe("expense status transitions", () => {
  it("blocks void when payments exist", () => {
    expect(() =>
      assertExpenseStatusTransition("partially_paid", "void", { hasActivePayments: true }),
    ).toThrow(/payments recorded/i);
  });
});

describe("payment type mapping", () => {
  it("maps invoice to customer_payment", () => {
    expect(paymentTypeForDocumentKind("invoice")).toBe("customer_payment");
    expect(allocationKindForDocumentKind("invoice")).toBe("invoice_payment");
  });

  it("maps expense to bill_payment", () => {
    expect(paymentTypeForDocumentKind("expense")).toBe("bill_payment");
    expect(allocationKindForDocumentKind("expense")).toBe("bill_payment");
  });

  it("maps bill kind to bill_payment", () => {
    expect(paymentTypeForDocumentKind("bill")).toBe("bill_payment");
  });
});

describe("journal link kinds", () => {
  it("maps source kinds to link kinds", () => {
    expect(linkKindFromSourceKind("invoice")).toBe("accrual");
    expect(linkKindFromSourceKind("invoice-payment")).toBe("payment");
    expect(linkKindFromSourceKind("invoice-payment-fee")).toBe("fee");
    expect(linkKindFromSourceKind("expense-payment")).toBe("payment");
  });
});

describe("partial payment validation", () => {
  const total = 15000;

  it("tracks $3k then $12k on $15k invoice", () => {
    const first = validateDocumentPayment({
      documentTotal: total,
      amountPaid: 0,
      paymentAmount: 3000,
    });
    expect(first.paymentAmount).toBe(3000);
    expect(invoiceStatusAfterPayment(total, 3000)).toBe("partially_paid");

    const second = validateDocumentPayment({
      documentTotal: total,
      amountPaid: 3000,
      paymentAmount: 12000,
    });
    expect(second.paymentAmount).toBe(12000);
    expect(invoiceStatusAfterPayment(total, 15000)).toBe("paid");
  });

  it("rejects overpayment after full payment", () => {
    expect(() =>
      validateDocumentPayment({
        documentTotal: total,
        amountPaid: 15000,
        paymentAmount: 1,
      }),
    ).toThrow(/nothing left to pay/i);
  });
});

describe("AR aging with partially_paid", () => {
  it("includes partially paid invoices", () => {
    expect(
      isBilledInvoice({ status: "partially_paid", posted_entry_id: "je-1" }),
    ).toBe(true);

    const report = buildArAging(
      [
        {
          total: 15000,
          amount_paid: 3000,
          issue_date: "2026-01-01",
          due_date: "2026-01-31",
          party_id: "p1",
          status: "partially_paid",
          posted_entry_id: "je-1",
        },
      ],
      new Map([["p1", "Customer"]]),
      "2026-02-01",
    );

    expect(report.total).toBe(12000);
    expect(report.topCustomers[0]?.total).toBe(12000);
  });
});