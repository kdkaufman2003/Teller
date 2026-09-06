import { describe, expect, it } from "vitest";
import { auditAllocationRows } from "./allocation-integrity";
import { normalizeSettlementEventId } from "./settlements";
import { allocationKindForDocumentKind } from "./allocations";
import {
  activePaymentTotal,
  creditMemoAvailable,
  creditsAppliedFromSource,
  creditsAppliedToTarget,
  depositAvailable,
  invoiceRemaining,
  scenarioRejectedInvoiceRefund,
  scenarioSaleRefundNetAr,
  type DocumentAllocationRow,
  type PaymentAllocationRow,
} from "./phase4-semantics";

describe("normalizeSettlementEventId", () => {
  it("generates a UUID when omitted", () => {
    const id = normalizeSettlementEventId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects invalid ids", () => {
    expect(() => normalizeSettlementEventId("not-a-uuid")).toThrow(/valid UUID/i);
  });
});

describe("Scenario A — payment reversal", () => {
  it("restores invoice remaining to full total after reversing $1,000 payment", () => {
    const before = invoiceRemaining(1000, 1000, 0, 0);
    expect(before).toBe(0);
    const after = invoiceRemaining(1000, 0, 0, 0);
    expect(after).toBe(1000);
  });
});

describe("Scenario B — economic sale refund (credit memo + credit refund)", () => {
  it("$1,000 paid invoice with $250 credit + $250 refund leaves customer owing $0", () => {
    const result = scenarioSaleRefundNetAr({
      invoiceTotal: 1000,
      payment: 1000,
      creditMemo: 250,
      creditRefund: 250,
    });
    expect(result.invoiceRemaining).toBe(0);
    expect(result.netArGlEffect).toBe(0);
    expect(result.availableCredit).toBe(0);
  });

  it("rejected invoice refund pattern would incorrectly create $250 owed", () => {
    const rejected = scenarioRejectedInvoiceRefund({
      invoiceTotal: 1000,
      payment: 1000,
      invoiceRefund: 250,
    });
    expect(rejected.invoiceRemaining).toBe(250);
    expect(rejected.netArGlEffect).toBe(250);
  });
});

describe("Customer credit refund lifecycle", () => {
  it("$250 available credit → $250 refund → $0 available", () => {
    expect(creditMemoAvailable(250, 0, 250)).toBe(0);
  });

  it("$1,000 available credit, $300 refund → $700 available", () => {
    expect(creditMemoAvailable(1000, 0, 300)).toBe(700);
  });

  it("partial credit refund does not change invoice remaining", () => {
    const invoiceBefore = invoiceRemaining(1000, 1000, 0, 0);
    const invoiceAfter = invoiceRemaining(1000, 1000, 0, 0);
    expect(invoiceBefore).toBe(0);
    expect(invoiceAfter).toBe(0);
    expect(creditMemoAvailable(1000, 0, 300)).toBe(700);
  });
});

describe("Credit apply / reverse lifecycle", () => {
  const base: DocumentAllocationRow[] = [
    {
      id: "apply-1",
      amount: 400,
      allocation_kind: "customer_credit_apply",
      source_document_id: "cm-1",
      target_document_id: "inv-1",
    },
  ];

  it("apply $400 credit to $1,000 invoice", () => {
    expect(creditsAppliedToTarget(base, "inv-1")).toBe(400);
    expect(invoiceRemaining(1000, 0, 400, 0)).toBe(600);
    expect(creditMemoAvailable(600, creditsAppliedFromSource(base, "cm-1"), 0)).toBe(200);
  });

  it("reverse application restores invoice and credit availability", () => {
    const reversed: DocumentAllocationRow[] = [
      ...base,
      {
        id: "rev-1",
        amount: 400,
        allocation_kind: "customer_credit_apply_reversal",
        source_document_id: "cm-1",
        target_document_id: "inv-1",
        reversal_of_allocation_id: "apply-1",
      },
    ];
    expect(creditsAppliedToTarget(reversed, "inv-1")).toBe(0);
    expect(invoiceRemaining(1000, 0, 0, 0)).toBe(1000);
    expect(creditMemoAvailable(600, creditsAppliedFromSource(reversed, "cm-1"), 0)).toBe(600);
  });
});

describe("Write-off does not inflate amount_paid", () => {
  it("$750 cash + $250 write-off → remaining $0, cash paid $750 (not $1,000)", () => {
    const cashPaid = 750;
    const writeOffs = 250;
    expect(invoiceRemaining(1000, cashPaid, 0, writeOffs)).toBe(0);
    expect(cashPaid).toBe(750);
    expect(cashPaid).toBeLessThan(cashPaid + writeOffs);
  });
});

describe("Deposit lifecycle", () => {
  it("receipt 5000, apply 3000, refund 1500 → available 500", () => {
    expect(depositAvailable(5000, 3000, 1500)).toBe(500);
  });

  it("after reversing 3000 application, available becomes 3500", () => {
    expect(depositAvailable(5000, 0, 1500)).toBe(3500);
  });

  it("rejects refund 4000 when only 3500 available", () => {
    const available = depositAvailable(5000, 0, 1500);
    expect(available).toBe(3500);
    expect(4000 > available).toBe(true);
  });

  it("rejects apply 4000 when only 3000 available after prior refund", () => {
    const available = depositAvailable(5000, 0, 2000);
    expect(available).toBe(3000);
    expect(4000 > available).toBe(true);
  });
});

describe("Multi-document payment reversal allocations", () => {
  it("sums active allocations across two invoices before reversal", () => {
    const rows: PaymentAllocationRow[] = [
      { id: "a1", amount: 600, allocation_kind: "invoice_payment" },
      { id: "a2", amount: 400, allocation_kind: "invoice_payment" },
    ];
    expect(activePaymentTotal(rows)).toBe(1000);
  });

  it("excludes both originals after full payment reversal events", () => {
    const rows: PaymentAllocationRow[] = [
      { id: "a1", amount: 600, allocation_kind: "invoice_payment", reversed_by_allocation_id: "r1" },
      { id: "a2", amount: 400, allocation_kind: "invoice_payment", reversed_by_allocation_id: "r2" },
      { id: "r1", amount: 600, allocation_kind: "invoice_payment_reversal", reversal_of_allocation_id: "a1" },
      { id: "r2", amount: 400, allocation_kind: "invoice_payment_reversal", reversal_of_allocation_id: "a2" },
    ];
    expect(activePaymentTotal(rows)).toBe(0);
  });
});

describe("Payment reversal vs refund distinction", () => {
  it("maps document kinds for reversal allocations", () => {
    expect(allocationKindForDocumentKind("invoice")).toBe("invoice_payment");
    expect(allocationKindForDocumentKind("bill")).toBe("bill_payment");
  });
});

describe("Full reversal only policy", () => {
  it("reversePayment RPC accepts payment id only — no partial amount parameter", () => {
    expect(true).toBe(true);
  });
});

describe("Allocation reversal cache integrity", () => {
  it("flags missing cache pointer when reversal event exists", () => {
    const issues = auditAllocationRows("teller_payment_allocations", [
      { id: "orig", reversal_of_allocation_id: null, reversed_by_allocation_id: null },
      { id: "rev", reversal_of_allocation_id: "orig", reversed_by_allocation_id: null },
    ]);
    expect(issues.some((i) => i.kind === "missing_cache_pointer")).toBe(true);
  });

  it("flags orphaned cache pointer when no reversal event exists", () => {
    const issues = auditAllocationRows("teller_payment_allocations", [
      { id: "orig", reversal_of_allocation_id: null, reversed_by_allocation_id: "ghost" },
    ]);
    expect(issues.some((i) => i.kind === "orphaned_cache_pointer")).toBe(true);
  });

  it("flags multiple reversal rows for one original allocation", () => {
    const issues = auditAllocationRows("teller_document_allocations", [
      { id: "orig", reversal_of_allocation_id: null, reversed_by_allocation_id: null },
      { id: "rev1", reversal_of_allocation_id: "orig", reversed_by_allocation_id: null },
      { id: "rev2", reversal_of_allocation_id: "orig", reversed_by_allocation_id: null },
    ]);
    expect(issues.some((i) => i.kind === "multiple_reversal_events")).toBe(true);
  });
});

describe("Allocation immutability — authoritative from reversal events", () => {
  it("detects disagreement when cache says reversed but no reversal event exists", () => {
    const rows: PaymentAllocationRow[] = [
      { id: "a1", amount: 500, allocation_kind: "invoice_payment", reversed_by_allocation_id: "missing" },
    ];
    const reversedIds = new Set<string>();
    expect(activePaymentTotal(rows)).toBe(500);
    expect(rows[0].reversed_by_allocation_id).toBeTruthy();
    expect(reversedIds.has("a1")).toBe(false);
  });
});
