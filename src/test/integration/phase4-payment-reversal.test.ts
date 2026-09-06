import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { checkAllocationReversalIntegrity } from "@/lib/accounting/allocation-integrity";
import { recordPaymentAllocation } from "@/lib/accounting/allocations";
import { recordTellerPayment } from "@/lib/accounting/payments";
import { buildInvoicePaymentLines } from "@/lib/accounting/payment-fees";
import { postInvoiceOpen, postInvoicePaid, postJournal, loadOrgAccounts } from "@/lib/accounting/post";
import { accountByCode, accountBySubtype } from "@/lib/accounting/accounts";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { reversePayment } from "@/lib/accounting/settlements";
import {
  countOrgRows,
  createIntegrationClient,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 payment reversal integration", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function createMultiInvoicePayment(
    organizationId: string,
    accountIds: Record<string, string>,
    invoiceA: { id: string; total: number },
    invoiceB: { id: string; total: number },
    amounts: [number, number],
  ) {
    const accounts = await loadOrgAccounts(supabase, organizationId);
    const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
    const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
    if (!cash || !ar) throw new Error("Cash or AR missing");

    const total = amounts[0] + amounts[1];
    const entryId = await postJournal(supabase, {
      organizationId,
      entryDate: "2026-06-02",
      memo: "Multi-invoice payment",
      sourceKind: "invoice-payment",
      lines: buildInvoicePaymentLines({
        cashAccountId: cash.id,
        arAccountId: ar.id,
        grossAmount: total,
        feeAmount: 0,
        netAmount: total,
        partyId: null,
        jobId: null,
      }),
    });

    const { paymentId } = await recordTellerPayment(supabase, {
      organizationId,
      partyId: null,
      jobId: null,
      amount: total,
      paymentDate: "2026-06-02",
      journalEntryId: entryId,
      createAllocation: false,
    });
    if (!paymentId) throw new Error("Payment not created");

    await recordPaymentAllocation(supabase, {
      organizationId,
      paymentId,
      documentId: invoiceA.id,
      amount: amounts[0],
      allocationKind: "invoice_payment",
    });
    await recordPaymentAllocation(supabase, {
      organizationId,
      paymentId,
      documentId: invoiceB.id,
      amount: amounts[1],
      allocationKind: "invoice_payment",
    });

    return paymentId;
  }

  async function seedSingleInvoicePayment(organizationId: string, accountIds: Record<string, string>) {
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
    if (!paid.paymentId) throw new Error("Payment not created");
    return { invoice, paymentId: paid.paymentId };
  }

  it("A — single-invoice payment reversal restores remaining and AR", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-rev-single");
    try {
      const { invoice, paymentId } = await seedSingleInvoicePayment(organizationId, accountIds);

      await reversePayment(supabase, {
        organizationId,
        paymentId,
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

  it("B — multi-invoice payment reversal 600 + 400 restores both invoices", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-rev-multi");
    try {
      const invA = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 600,
        number: `INV-A-${Date.now()}`,
      });
      const invB = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 400,
        number: `INV-B-${Date.now()}`,
      });
      for (const inv of [invA, invB]) {
        await postInvoiceOpen(supabase, {
          organizationId,
          documentId: inv.id,
          partyId: null,
          jobId: null,
          issueDate: "2026-06-01",
          number: inv.number,
          tax: 0,
          lines: [{ amount: inv.total, account_id: accountIds["4000"], description: "Service" }],
        });
      }

      const paymentId = await createMultiInvoicePayment(
        organizationId,
        accountIds,
        invA,
        invB,
        [600, 400],
      );

      await reversePayment(supabase, {
        organizationId,
        paymentId,
        reversalDate: "2026-06-03",
        reversalEventId: randomUUID(),
        reason: "Full multi-invoice reversal",
      });

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invA.id, 600)).toBe(600);
      expect(await authoritativeDocumentRemaining(supabase, organizationId, invB.id, 400)).toBe(400);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("C — repeated identical reversal event id is idempotent", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-rev-idem");
    try {
      const { paymentId } = await seedSingleInvoicePayment(organizationId, accountIds);
      const eventId = randomUUID();

      const first = await reversePayment(supabase, {
        organizationId,
        paymentId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "NSF",
      });
      const second = await reversePayment(supabase, {
        organizationId,
        paymentId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "NSF retry",
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(first.reversalEntryId).toBe(second.reversalEntryId);

      const { count } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "payment-reversal")
        .eq("source_id", eventId);
      expect(count).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("D — same reversal event id on a different payment rejects", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-rev-conflict");
    try {
      const first = await seedSingleInvoicePayment(organizationId, accountIds);
      const second = await seedSingleInvoicePayment(organizationId, accountIds);
      const eventId = randomUUID();

      await reversePayment(supabase, {
        organizationId,
        paymentId: first.paymentId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "First payment reversal",
      });

      await expect(
        reversePayment(supabase, {
          organizationId,
          paymentId: second.paymentId,
          reversalDate: "2026-06-03",
          reversalEventId: eventId,
          reason: "Conflicting reuse of event id",
        }),
      ).rejects.toThrow(/duplicate key|already been reversed|unique/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("E-H — multi-invoice reversal preserves allocations, one journal, integrity, AR", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-rev-invariants");
    try {
      const invA = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 600,
        number: `INV-INV-A-${Date.now()}`,
      });
      const invB = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 400,
        number: `INV-INV-B-${Date.now()}`,
      });
      for (const inv of [invA, invB]) {
        await postInvoiceOpen(supabase, {
          organizationId,
          documentId: inv.id,
          partyId: null,
          jobId: null,
          issueDate: "2026-06-01",
          number: inv.number,
          tax: 0,
          lines: [{ amount: inv.total, account_id: accountIds["4000"], description: "Service" }],
        });
      }

      const paymentId = await createMultiInvoicePayment(
        organizationId,
        accountIds,
        invA,
        invB,
        [600, 400],
      );
      const eventId = randomUUID();
      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      await reversePayment(supabase, {
        organizationId,
        paymentId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "Invariant check reversal",
      });

      const { data: allocs } = await supabase
        .from("teller_payment_allocations")
        .select("id, allocation_kind, amount, reversal_of_allocation_id, reversed_by_allocation_id, reversal_event_id")
        .eq("organization_id", organizationId)
        .eq("payment_id", paymentId)
        .order("created_at", { ascending: true });

      const originals = (allocs ?? []).filter((row) => !row.reversal_of_allocation_id);
      const reversals = (allocs ?? []).filter((row) => row.reversal_of_allocation_id);

      expect(originals.length).toBe(2);
      expect(reversals.length).toBe(2);

      for (const original of originals) {
        expect(original.reversed_by_allocation_id).toBeTruthy();
        const matching = reversals.filter(
          (row) => row.reversal_of_allocation_id === original.id,
        );
        expect(matching.length).toBe(1);
        expect(matching[0]?.reversal_event_id).toBe(eventId);
      }

      const reversalJournals = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      expect(reversalJournals - journalsBefore).toBe(1);

      const integrity = await checkAllocationReversalIntegrity(supabase, organizationId);
      expect(integrity.consistent).toBe(true);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
