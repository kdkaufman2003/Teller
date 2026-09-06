import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  receiveCustomerDeposit,
} from "@/lib/accounting/deposits";
import { reconcileDepositsToGl } from "@/lib/accounting/deposit-reconciliation";
import { postInvoiceOpen } from "@/lib/accounting/post";
import { reconcileSettlementControls } from "@/lib/accounting/settlement-reconciliation";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import {
  refundCustomerDeposit,
  reverseDepositApplication,
} from "@/lib/accounting/settlements";
import {
  countOrgRows,
  createIntegrationClient,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 deposit reversal/refund lifecycle", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function seedParty(organizationId: string) {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "customer",
        name: `Deposit Lifecycle Customer ${Date.now()}`,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not create customer");
    return data.id as string;
  }

  async function runComboLifecycle(organizationId: string, accountIds: Record<string, string>) {
    const partyId = await seedParty(organizationId);
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

    const reversal = await reverseDepositApplication(supabase, {
      organizationId,
      allocationId: applied.allocationId,
      reversalDate: "2026-06-04",
      reversalEventId: randomUUID(),
      reason: "Undo application",
    });

    return { partyId, invoice, deposit, applied, reversal };
  }

  it("A — receive 5000, apply 3000, refund 1500, reverse apply → available 3500 and GL reconciles", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-life");
    try {
      const { deposit, invoice } = await runComboLifecycle(organizationId, accountIds);

      const remaining = await authoritativeDepositRemaining(
        supabase,
        organizationId,
        deposit.paymentId!,
        5000,
      );
      expect(remaining).toBe(3500);

      const deposits = await reconcileDepositsToGl(supabase, organizationId);
      expect(deposits?.subledgerUnappliedBalance).toBe(3500);
      expect(deposits?.glControlBalance).toBe(3500);
      expect(deposits?.consistent).toBe(true);

      const report = await reconcileSettlementControls(supabase, organizationId);
      expect(report.deposits?.consistent).toBe(true);

      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 10000)).toBe(
        10000,
      );

      const ar = report.arAp.find((row) => row.side === "ar");
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("B/C — reversal succeeds then identical event returns duplicate without second journal", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-rev-idem");
    try {
      const partyId = await seedParty(organizationId);
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 2000,
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
        lines: [{ amount: 2000, account_id: accountIds["4000"], description: "Install" }],
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 500,
        paymentDate: "2026-06-01",
      });
      const applied = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 500,
        applicationDate: "2026-06-02",
        applicationEventId: randomUUID(),
      });

      const eventId = randomUUID();
      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      const first = await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "Undo application",
      });
      const second = await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "Undo application retry",
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);

      const journalsAfter = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      expect(journalsAfter - journalsBefore).toBe(1);

      const { count: reversalRows } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("allocation_kind", "deposit_apply_reversal")
        .eq("reversal_of_allocation_id", applied.allocationId);
      expect(reversalRows).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("D — same reversal event id with conflicting allocation rejects", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-rev-conflict");
    try {
      const partyId = await seedParty(organizationId);
      const invA = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
        number: `INV-A-${Date.now()}`,
      });
      const invB = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
        number: `INV-B-${Date.now()}`,
      });
      for (const inv of [invA, invB]) {
        await supabase.from("teller_documents").update({ party_id: partyId }).eq("id", inv.id);
        await postInvoiceOpen(supabase, {
          organizationId,
          documentId: inv.id,
          partyId,
          jobId: null,
          issueDate: "2026-06-01",
          number: inv.number,
          tax: 0,
          lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Install" }],
        });
      }

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 2000,
        paymentDate: "2026-06-01",
      });
      const applyA = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invA.id,
        amount: 500,
        applicationDate: "2026-06-02",
        applicationEventId: randomUUID(),
      });
      const applyB = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invB.id,
        amount: 500,
        applicationDate: "2026-06-02",
        applicationEventId: randomUUID(),
      });

      const eventId = randomUUID();
      await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applyA.allocationId,
        reversalDate: "2026-06-03",
        reversalEventId: eventId,
        reason: "Reverse A",
      });

      await expect(
        reverseDepositApplication(supabase, {
          organizationId,
          allocationId: applyB.allocationId,
          reversalDate: "2026-06-03",
          reversalEventId: eventId,
          reason: "Conflicting reuse on B",
        }),
      ).rejects.toThrow(/duplicate key|unique|already/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("E — new event cannot reverse an already-reversed application", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-rev-twice");
    try {
      const partyId = await seedParty(organizationId);
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
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Install" }],
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 500,
        paymentDate: "2026-06-01",
      });
      const applied = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 500,
        applicationDate: "2026-06-02",
        applicationEventId: randomUUID(),
      });

      await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalDate: "2026-06-03",
        reversalEventId: randomUUID(),
        reason: "First reversal",
      });

      await expect(
        reverseDepositApplication(supabase, {
          organizationId,
          allocationId: applied.allocationId,
          reversalDate: "2026-06-04",
          reversalEventId: randomUUID(),
          reason: "Second reversal attempt",
        }),
      ).rejects.toThrow(/already been reversed/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("F — refund exceeding available deposit rejects", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-refund-cap");
    try {
      const { deposit } = await runComboLifecycle(organizationId, accountIds);

      await expect(
        refundCustomerDeposit(supabase, {
          organizationId,
          depositPaymentId: deposit.paymentId!,
          amount: 4000,
          refundDate: "2026-06-05",
          refundEventId: randomUUID(),
          reason: "Over refund",
        }),
      ).rejects.toThrow(/exceeds unapplied/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("G — AR reconciles after deposit application reversal", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-ar");
    try {
      await runComboLifecycle(organizationId, accountIds);
      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
