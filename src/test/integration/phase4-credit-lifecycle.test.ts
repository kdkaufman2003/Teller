import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { applyDocumentCredit, postCreditMemoOpen } from "@/lib/accounting/credits";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { postInvoiceOpen, postInvoicePaid } from "@/lib/accounting/post";
import { authoritativeCreditRemaining, computeArControlSubledgerTotal } from "@/lib/accounting/party-balances";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { refundCustomerCredit, reverseDocumentAllocation } from "@/lib/accounting/settlements";
import {
  countOrgRows,
  createIntegrationClient,
  createTestCreditMemo,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 credit application/reversal/refund lifecycle", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function seedParty(organizationId: string) {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "customer",
        name: `Credit Lifecycle Customer ${Date.now()}`,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not create customer");
    return data.id as string;
  }

  async function seedInvoice1000(organizationId: string, accountIds: Record<string, string>, partyId: string) {
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
    return invoice;
  }

  async function seedCreditMemo400(
    organizationId: string,
    accountIds: Record<string, string>,
    partyId: string,
  ) {
    const credit = await createTestCreditMemo(supabase, {
      organizationId,
      revenueAccountId: accountIds["4000"],
      partyId,
      total: 400,
    });
    await postCreditMemoOpen(supabase, {
      organizationId,
      documentId: credit.id,
      partyId,
      jobId: null,
      issueDate: "2026-06-02",
      number: credit.number,
      tax: 0,
      lines: [{ amount: 400, account_id: accountIds["4000"], description: "Credit" }],
    });
    return credit;
  }

  it("A — invoice 1000 + credit memo 400 → available 400, invoice remaining 1000, net AR 600", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-a");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await seedInvoice1000(organizationId, accountIds, partyId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        1000,
      );
      expect(await authoritativeCreditRemaining(supabase, organizationId, credit.id, 400)).toBe(
        400,
      );

      const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
      expect(arControl.invoiceRemainingTotal).toBe(1000);
      expect(arControl.unappliedCreditTotal).toBe(400);
      expect(arControl.netSubledgerBalance).toBe(600);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("B — apply credit 400 → invoice remaining 600, available 0, no new journal", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-b");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await seedInvoice1000(organizationId, accountIds, partyId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);

      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: credit.id,
        targetDocumentId: invoice.id,
        amount: 400,
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        600,
      );
      expect(await authoritativeCreditRemaining(supabase, organizationId, credit.id, 400)).toBe(0);
      expect(await sumCreditsAppliedFromDocument(supabase, organizationId, credit.id)).toBe(400);

      const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
      expect(arControl.netSubledgerBalance).toBe(600);

      expect(await countOrgRows(supabase, "teller_journal_entries", organizationId)).toBe(
        journalsBefore,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("C — reverse credit application → invoice 1000, available 400, AR consistent, no journal", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-c");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await seedInvoice1000(organizationId, accountIds, partyId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);

      const applied = await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: credit.id,
        targetDocumentId: invoice.id,
        amount: 400,
      });

      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      await reverseDocumentAllocation(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalEventId: randomUUID(),
        reason: "Applied in error",
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        1000,
      );
      expect(await authoritativeCreditRemaining(supabase, organizationId, credit.id, 400)).toBe(
        400,
      );
      expect(await sumCreditsAppliedFromDocument(supabase, organizationId, credit.id)).toBe(0);

      const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
      expect(arControl.netSubledgerBalance).toBe(600);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);

      expect(await countOrgRows(supabase, "teller_journal_entries", organizationId)).toBe(
        journalsBefore,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("D — retry exact same reversal event → duplicate=true, one reversal row", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-d");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await seedInvoice1000(organizationId, accountIds, partyId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);

      const applied = await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: credit.id,
        targetDocumentId: invoice.id,
        amount: 400,
      });

      const eventId = randomUUID();
      const first = await reverseDocumentAllocation(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalEventId: eventId,
        reason: "Undo",
      });
      const second = await reverseDocumentAllocation(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalEventId: eventId,
        reason: "Undo",
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(first.reversalAllocationId).toBe(second.reversalAllocationId);

      const { count } = await supabase
        .from("teller_document_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("reversal_event_id", eventId);
      expect(count).toBe(1);

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        1000,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("E — refund 250 available credit after fully paid invoice → net AR 0, reconciliation true", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-e");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await seedInvoice1000(organizationId, accountIds, partyId);
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
        lines: [{ amount: 250, account_id: accountIds["4000"], description: "Credit" }],
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        0,
      );
      expect(await authoritativeCreditRemaining(supabase, organizationId, credit.id, 250)).toBe(
        250,
      );

      const arBefore = await computeArControlSubledgerTotal(supabase, organizationId);
      expect(arBefore.netSubledgerBalance).toBe(-250);

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 250,
        refundDate: "2026-06-04",
        refundEventId: randomUUID(),
        reason: "Full credit refund",
      });

      const { data: doc } = await supabase
        .from("teller_documents")
        .select("amount_paid, status")
        .eq("id", invoice.id)
        .single();
      expect(Number(doc?.amount_paid)).toBe(1000);
      expect(doc?.status).toBe("paid");
      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        0,
      );
      expect(await authoritativeCreditRemaining(supabase, organizationId, credit.id, 250)).toBe(0);

      const arAfter = await computeArControlSubledgerTotal(supabase, organizationId);
      expect(arAfter.netSubledgerBalance).toBe(0);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("F — refund more than available credit → reject", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-f");
    try {
      const partyId = await seedParty(organizationId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);

      await expect(
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId: credit.id,
          amount: 500,
          refundDate: "2026-06-03",
          refundEventId: randomUUID(),
          reason: "Too much",
        }),
      ).rejects.toThrow(/exceeds unapplied credit/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("G — same refund event + same payload → duplicate=true", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-g");
    try {
      const partyId = await seedParty(organizationId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);
      const eventId = randomUUID();

      const first = await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 200,
        refundDate: "2026-06-03",
        refundEventId: eventId,
        reason: "Partial refund",
      });
      const second = await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 200,
        refundDate: "2026-06-03",
        refundEventId: eventId,
        reason: "Partial refund",
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(first.refundPaymentId).toBe(second.refundPaymentId);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("H — same refund event + conflicting payload → reject", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-h");
    try {
      const partyId = await seedParty(organizationId);
      const credit = await seedCreditMemo400(organizationId, accountIds, partyId);
      const eventId = randomUUID();

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 200,
        refundDate: "2026-06-03",
        refundEventId: eventId,
        reason: "First",
      });

      await expect(
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId: credit.id,
          amount: 300,
          refundDate: "2026-06-03",
          refundEventId: eventId,
          reason: "Different amount",
        }),
      ).rejects.toThrow(/Idempotency conflict/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("I — credit refund does not create invoice payment allocation", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-cr-life-i");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await seedInvoice1000(organizationId, accountIds, partyId);
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
        total: 100,
      });
      await postCreditMemoOpen(supabase, {
        organizationId,
        documentId: credit.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-03",
        number: credit.number,
        tax: 0,
        lines: [{ amount: 100, account_id: accountIds["4000"], description: "Credit" }],
      });

      const paymentsBefore = await countOrgRows(supabase, "teller_payments", organizationId);
      const invoiceAllocsBefore = await countOrgRows(
        supabase,
        "teller_payment_allocations",
        organizationId,
      );

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: credit.id,
        amount: 100,
        refundDate: "2026-06-04",
        refundEventId: randomUUID(),
        reason: "Refund unapplied credit",
      });

      const { count: invoicePaymentAllocs } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("document_id", invoice.id)
        .eq("allocation_kind", "invoice_payment");

      expect(invoicePaymentAllocs).toBe(1);
      expect(await countOrgRows(supabase, "teller_payments", organizationId)).toBe(
        paymentsBefore + 1,
      );
      expect(await countOrgRows(supabase, "teller_payment_allocations", organizationId)).toBe(
        invoiceAllocsBefore,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
