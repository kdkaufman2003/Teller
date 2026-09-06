import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  receiveCustomerDeposit,
} from "@/lib/accounting/deposits";
import { postCreditMemoOpen, applyDocumentCredit } from "@/lib/accounting/credits";
import { postInvoiceOpen, postInvoicePaid } from "@/lib/accounting/post";
import { postBillOpen, postBillPaid } from "@/lib/accounting/bills";
import { reconcileSettlementControls } from "@/lib/accounting/settlement-reconciliation";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import {
  normalizeSettlementEventId,
  refundCustomerCredit,
  refundCustomerDeposit,
  reverseDepositApplication,
  reverseDocumentAllocation,
  reversePayment,
  writeOffInvoice,
} from "@/lib/accounting/settlements";
import {
  createIntegrationClient,
  createTestBill,
  createTestCreditMemo,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 settlement integration", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function createCustomer(organizationId: string) {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "customer",
        name: `Phase4 Customer ${Date.now()}`,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not create customer");
    return data.id as string;
  }

  it("customer payment reversal restores invoice remaining and AR reconciliation", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-pay-rev");
    try {
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 800,
      });
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 800, account_id: accountIds["4000"], description: "Service" }],
      });
      const paid = await postInvoicePaid(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-02",
        number: invoice.number,
        total: 800,
        invoiceTotal: 800,
        priorPaid: 0,
      });

      await reversePayment(supabase, {
        organizationId,
        paymentId: paid.paymentId!,
        reversalDate: "2026-06-03",
        reversalEventId: randomUUID(),
        reason: "NSF",
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 800)).toBe(
        800,
      );
      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("bill payment reversal restores AP remaining", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-bill-rev");
    try {
      const bill = await createTestBill(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total: 5000,
      });
      await postBillOpen(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-01",
        number: bill.number,
        tax: 0,
        lines: [{ amount: 5000, account_id: accountIds["6100"], description: "Parts" }],
      });
      const paid = await postBillPaid(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-02",
        number: bill.number,
        paymentAmount: 2000,
        billTotal: 5000,
        priorPaid: 0,
      });
      expect(await authoritativeDocumentRemaining(supabase, organizationId, bill.id, 5000)).toBe(
        3000,
      );

      await reversePayment(supabase, {
        organizationId,
        paymentId: paid.paymentId!,
        reversalDate: "2026-06-03",
        reversalEventId: randomUUID(),
        reason: "Wrong payment",
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, bill.id, 5000)).toBe(
        5000,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("credit memo + credit refund does not increase invoice remaining", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-credit-ref");
    try {
      const partyId = await createCustomer(organizationId);
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
      });
      await supabase.from("teller_documents").update({ party_id: partyId }).eq("id", invoice.id);
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Service" }],
      });
      await postInvoicePaid(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-02",
        number: invoice.number,
        total: 1000,
        invoiceTotal: 1000,
        priorPaid: 0,
      });

      const credit = await createTestCreditMemo(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        partyId,
        total: 250,
      });
      await postCreditMemoOpen(supabase, {
        organizationId,
        documentId: credit.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-03",
        number: credit.number,
        tax: 0,
        lines: [{ amount: 250, account_id: accountIds["4000"], description: "Sale adjustment" }],
      });

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 250,
        refundDate: "2026-06-04",
        refundEventId: randomUUID(),
        reason: "Customer refund",
      });

      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000),
      ).toBe(0);
      expect(await sumCreditsAppliedFromDocument(supabase, organizationId, credit.id)).toBe(0);

      const { data: doc } = await supabase
        .from("teller_documents")
        .select("amount_paid")
        .eq("id", invoice.id)
        .single();
      expect(Number(doc?.amount_paid)).toBe(1000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("partial credit refund leaves remaining available credit", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-partial-cr");
    try {
      const partyId = await createCustomer(organizationId);
      const credit = await createTestCreditMemo(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        partyId,
        total: 1000,
      });
      await postCreditMemoOpen(supabase, {
        organizationId,
        documentId: credit.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: credit.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Credit" }],
      });

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 300,
        refundDate: "2026-06-02",
        refundEventId: randomUUID(),
        reason: "Partial refund",
      });

      const { data: refunds } = await supabase
        .from("teller_payments")
        .select("amount")
        .eq("organization_id", organizationId)
        .eq("document_id", credit.id)
        .eq("payment_type", "customer_refund");

      const refunded = (refunds ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
      expect(refunded).toBe(300);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("deposit receipt/apply/refund/application-reversal combination", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-combo");
    try {
      const partyId = await createCustomer(organizationId);
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 10000,
      });
      await supabase.from("teller_documents").update({ party_id: partyId }).eq("id", invoice.id);
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 10000, account_id: accountIds["4000"], description: "Install" }],
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-06-01",
      });

      const applied = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 3000,
        applicationDate: "2026-06-02",
        applicationEventId: randomUUID(),
      });

      await refundCustomerDeposit(supabase, {
        organizationId,
        depositPaymentId: deposit.paymentId!,
        amount: 1500,
        refundDate: "2026-06-03",
        refundEventId: randomUUID(),
        reason: "Partial deposit refund",
      });

      expect(
        await authoritativeDepositRemaining(supabase, organizationId, deposit.paymentId!, 5000),
      ).toBe(500);

      await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalDate: "2026-06-04",
        reversalEventId: randomUUID(),
        reason: "Undo application",
      });

      expect(
        await authoritativeDepositRemaining(supabase, organizationId, deposit.paymentId!, 5000),
      ).toBe(3500);

      const report = await reconcileSettlementControls(supabase, organizationId);
      expect(report.deposits?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("write-off does not count as cash amount_paid", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-wo-cache");
    try {
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
      });
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Service" }],
      });
      await postInvoicePaid(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-02",
        number: invoice.number,
        total: 750,
        invoiceTotal: 1000,
        priorPaid: 0,
      });
      await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: invoice.id,
        amount: 250,
        writeoffDate: "2026-06-05",
        writeoffEventId: randomUUID(),
        reason: "Uncollectible remainder",
      });

      const { data: doc } = await supabase
        .from("teller_documents")
        .select("amount_paid, status")
        .eq("id", invoice.id)
        .single();

      expect(Number(doc?.amount_paid)).toBe(750);
      expect(doc?.status).toBe("paid");
      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        0,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("credit apply and reverse lifecycle", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-apply");
    try {
      const partyId = await createCustomer(organizationId);
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
      });
      await supabase.from("teller_documents").update({ party_id: partyId }).eq("id", invoice.id);
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Service" }],
      });

      const credit = await createTestCreditMemo(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        partyId,
        total: 600,
      });
      await postCreditMemoOpen(supabase, {
        organizationId,
        documentId: credit.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-02",
        number: credit.number,
        tax: 0,
        lines: [{ amount: 600, account_id: accountIds["4000"], description: "Credit" }],
      });

      const applied = await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: credit.id,
        targetDocumentId: invoice.id,
        amount: 400,
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        600,
      );
      expect(await sumCreditsAppliedFromDocument(supabase, organizationId, credit.id)).toBe(400);

      await reverseDocumentAllocation(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalEventId: randomUUID(),
        reason: "Applied in error",
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        1000,
      );
      expect(await sumCreditsAppliedFromDocument(supabase, organizationId, credit.id)).toBe(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects invalid settlement event ids", () => {
    expect(() => normalizeSettlementEventId("bad-id")).toThrow(/valid UUID/i);
  });
});
