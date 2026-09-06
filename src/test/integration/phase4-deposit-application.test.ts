import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  receiveCustomerDeposit,
} from "@/lib/accounting/deposits";
import { postInvoiceOpen } from "@/lib/accounting/post";
import { reconcileDepositsToGl } from "@/lib/accounting/deposit-reconciliation";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import {
  countOrgRows,
  createIntegrationClient,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 deposit application via PostgREST", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function seedDepositScenario(organizationId: string, accountIds: Record<string, string>) {
    const partyInsert = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "customer",
        name: `Deposit Apply Customer ${Date.now()}`,
      })
      .select("id")
      .single();
    if (partyInsert.error || !partyInsert.data) {
      throw new Error(partyInsert.error?.message || "Could not create customer");
    }
    const partyId = partyInsert.data.id as string;

    const invoice = await createTestInvoice(supabase, {
      organizationId,
      revenueAccountId: accountIds["4000"],
      total: 5000,
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
      lines: [{ amount: 5000, account_id: accountIds["4000"], description: "Install" }],
    });

    const deposit = await receiveCustomerDeposit(supabase, {
      organizationId,
      partyId,
      amount: 3000,
      paymentDate: "2026-06-01",
    });

    return { partyId, invoice, deposit };
  }

  it("applyDepositToInvoice succeeds through production RPC path with balances and journal", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-apply");
    try {
      const { invoice, deposit } = await seedDepositScenario(organizationId, accountIds);
      const eventId = randomUUID();
      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      const applied = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 1200,
        applicationDate: "2026-06-02",
        applicationEventId: eventId,
      });

      expect(applied.duplicate).toBe(false);
      expect(applied.allocationId).toBeTruthy();
      expect(applied.applicationEntryId).toBeTruthy();

      const journalsAfter = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      expect(journalsAfter - journalsBefore).toBe(1);

      expect(
        await authoritativeDepositRemaining(supabase, organizationId, deposit.paymentId!, 3000),
      ).toBe(1800);
      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 5000)).toBe(
        3800,
      );

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      const deposits = await reconcileDepositsToGl(supabase, organizationId);
      expect(ar?.consistent).toBe(true);
      expect(deposits?.consistent).toBe(true);
      expect(deposits?.subledgerUnappliedBalance).toBe(1800);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("repeated apply with same event id is idempotent with one journal", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-idem");
    try {
      const { invoice, deposit } = await seedDepositScenario(organizationId, accountIds);
      const eventId = randomUUID();
      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      const first = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 900,
        applicationDate: "2026-06-02",
        applicationEventId: eventId,
      });
      const second = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 900,
        applicationDate: "2026-06-02",
        applicationEventId: eventId,
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(first.allocationId).toBe(second.allocationId);
      expect(first.applicationEntryId).toBe(second.applicationEntryId);

      const journalsAfter = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      expect(journalsAfter - journalsBefore).toBe(1);

      const { count: allocCount } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("application_event_id", eventId)
        .eq("allocation_kind", "deposit_apply");
      expect(allocCount).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("applyDepositToInvoice succeeds on three consecutive calls with distinct events", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-dep-repeat");
    try {
      const { invoice, deposit } = await seedDepositScenario(organizationId, accountIds);

      for (const amount of [500, 400, 300]) {
        const result = await applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount,
          applicationDate: "2026-06-02",
          applicationEventId: randomUUID(),
        });
        expect(result.duplicate).toBe(false);
      }

      expect(
        await authoritativeDepositRemaining(supabase, organizationId, deposit.paymentId!, 3000),
      ).toBe(1800);
      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 5000)).toBe(
        3800,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
