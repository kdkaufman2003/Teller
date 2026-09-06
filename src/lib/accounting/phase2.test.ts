import { describe, expect, it } from "vitest";
import {
  allocationKindForDocumentKind,
  paymentTypeForDocumentKind,
} from "./allocations";
import { documentAllocationKind } from "./document-allocations";
import {
  assertBillStatusTransition,
  assertCreditDocumentStatusTransition,
  billStatusAfterPayment,
  creditDocumentStatusAfterApplication,
  invoiceStatusAfterSettlement,
} from "./document-transitions";
import {
  documentRemainingBalance,
  validateDocumentPayment,
  validateDocumentSettlement,
} from "./balances";

describe("bill status", () => {
  it("stays open with no payments or credits", () => {
    expect(billStatusAfterPayment(5000, 0, 0)).toBe("open");
  });

  it("becomes partially_paid after partial payment", () => {
    expect(billStatusAfterPayment(5000, 2000, 0)).toBe("partially_paid");
  });

  it("becomes paid when payments and credits settle the bill", () => {
    expect(billStatusAfterPayment(5000, 4500, 500)).toBe("paid");
  });

  it("blocks invalid bill transitions", () => {
    expect(() => assertBillStatusTransition("paid", "open")).toThrow(/invalid/i);
  });
});

describe("credit document status", () => {
  it("becomes partially_applied when partially allocated", () => {
    expect(creditDocumentStatusAfterApplication(1000, 400)).toBe("partially_applied");
  });

  it("becomes applied when fully allocated", () => {
    expect(creditDocumentStatusAfterApplication(1000, 1000)).toBe("applied");
  });

  it("blocks void from applied credit", () => {
    expect(() => assertCreditDocumentStatusTransition("applied", "void")).toThrow(/invalid/i);
  });
});

describe("invoice settlement with credits", () => {
  it("keeps invoice open when only credits partially settle", () => {
    expect(invoiceStatusAfterSettlement(10000, 0, 1000)).toBe("partially_paid");
  });

  it("shows paid when payments plus credits settle total", () => {
    expect(invoiceStatusAfterSettlement(10000, 5000, 5000)).toBe("paid");
  });

  it("preserves original total in remaining calculation", () => {
    expect(documentRemainingBalance(10000, 1000)).toBe(9000);
  });
});

describe("document allocation kinds", () => {
  it("maps credit memo to invoice", () => {
    expect(documentAllocationKind("credit_memo", "invoice")).toBe("customer_credit_apply");
  });

  it("maps vendor credit to bill", () => {
    expect(documentAllocationKind("vendor_credit", "bill")).toBe("vendor_credit_apply");
  });

  it("rejects cross-kind applications", () => {
    expect(() => documentAllocationKind("credit_memo", "bill")).toThrow(/cannot apply/i);
  });
});

describe("payment type mapping for bills", () => {
  it("maps bill to bill_payment", () => {
    expect(paymentTypeForDocumentKind("bill")).toBe("bill_payment");
    expect(allocationKindForDocumentKind("bill")).toBe("bill_payment");
  });
});

describe("credit application party matching", () => {
  it("requires same party on source and target kinds", () => {
    expect(() => documentAllocationKind("credit_memo", "invoice")).not.toThrow();
    expect(() => documentAllocationKind("vendor_credit", "bill")).not.toThrow();
    expect(() => documentAllocationKind("credit_memo", "bill")).toThrow(/cannot apply/i);
  });
});

describe("overpayment protection", () => {
  it("rejects payment exceeding remaining balance", () => {
    expect(() =>
      validateDocumentPayment({
        documentTotal: 5000,
        amountPaid: 2000,
        paymentAmount: 3500,
      }),
    ).toThrow(/exceeds remaining/i);
  });

  it("rejects settlement exceeding remaining after credits", () => {
    expect(() =>
      validateDocumentSettlement({
        documentTotal: 5000,
        amountPaid: 2000,
        creditsApplied: 500,
        settlementAmount: 3000,
      }),
    ).toThrow(/exceeds remaining/i);
  });

  it("allows valid partial payment", () => {
    const result = validateDocumentPayment({
      documentTotal: 5000,
      amountPaid: 0,
      paymentAmount: 2000,
    });
    expect(result.paymentAmount).toBe(2000);
    expect(result.remainingBefore).toBe(5000);
  });
});
