import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import {
  authoritativeDocumentRemaining,
  sumWriteOffsForDocument,
} from "@/lib/accounting/balances";
import { postInvoiceOpen, postInvoicePaid } from "@/lib/accounting/post";
import { computeArControlSubledgerTotal } from "@/lib/accounting/party-balances";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { writeOffInvoice } from "@/lib/accounting/settlements";
import {
  countOrgRows,
  createIntegrationClient,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 invoice write-off lifecycle", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function seedInvoice1000Paid750(
    organizationId: string,
    accountIds: Record<string, string>,
  ) {
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
    return invoice;
  }

  async function glAccountBalance(
    organizationId: string,
    accountId: string,
    side: "debit" | "credit" = "debit",
  ) {
    const { data: account } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", accountId)
      .maybeSingle();
    if (!account?.id) return 0;

    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit, entry_id")
      .eq("account_id", accountId);

    const entryIds = [...new Set((lines ?? []).map((line) => line.entry_id as string))];
    if (!entryIds.length) return 0;

    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id, reverses_entry_id")
      .eq("organization_id", organizationId)
      .in("id", entryIds);

    const reversalEntries = new Set(
      (entries ?? [])
        .filter((entry) => entry.reverses_entry_id)
        .map((entry) => entry.id as string),
    );

    const { data: reversals } = await supabase
      .from("teller_journal_entries")
      .select("reverses_entry_id")
      .eq("organization_id", organizationId)
      .in("reverses_entry_id", entryIds);

    const reversedOriginals = new Set(
      (reversals ?? []).map((row) => row.reverses_entry_id as string),
    );

    return (lines ?? []).reduce((sum, line) => {
      const entryId = line.entry_id as string;
      if (reversalEntries.has(entryId) || reversedOriginals.has(entryId)) return sum;
      if (side === "debit") {
        return sum + Number(line.debit) - Number(line.credit);
      }
      return sum + Number(line.credit) - Number(line.debit);
    }, 0);
  }

  it("A — invoice 1000, cash 750, write-off 250 → settled with cash-only amount_paid", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-wo-life");
    try {
      const invoice = await seedInvoice1000Paid750(organizationId, accountIds);

      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      const paymentsBefore = await countOrgRows(supabase, "teller_payments", organizationId);
      const allocsBefore = await countOrgRows(
        supabase,
        "teller_payment_allocations",
        organizationId,
      );

      const result = await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: invoice.id,
        amount: 250,
        writeoffDate: "2026-06-05",
        writeoffEventId: randomUUID(),
        reason: "Uncollectible remainder",
      });

      expect(result.duplicate).toBe(false);
      expect(result.writeoffId).toBeTruthy();
      expect(result.journalEntryId).toBeTruthy();

      const { data: doc } = await supabase
        .from("teller_documents")
        .select("amount_paid, status")
        .eq("id", invoice.id)
        .single();
      expect(Number(doc?.amount_paid)).toBe(750);
      expect(doc?.status).toBe("paid");
      expect(await sumWriteOffsForDocument(supabase, organizationId, invoice.id)).toBe(250);
      expect(await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000)).toBe(
        0,
      );

      expect(await countOrgRows(supabase, "teller_payments", organizationId)).toBe(paymentsBefore);
      expect(await countOrgRows(supabase, "teller_payment_allocations", organizationId)).toBe(
        allocsBefore,
      );
      expect(await countOrgRows(supabase, "teller_journal_entries", organizationId)).toBe(
        journalsBefore + 1,
      );

      const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
      expect(arControl.invoiceRemainingTotal).toBe(0);
      expect(arControl.netSubledgerBalance).toBe(0);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.glControlBalance).toBe(0);
      expect(ar?.consistent).toBe(true);

      const arBalance = await glAccountBalance(organizationId, accountIds["1100"], "debit");
      const badDebtBalance = await glAccountBalance(organizationId, accountIds["6850"], "debit");
      const cashBalance = await glAccountBalance(organizationId, accountIds["1000"], "debit");
      const revenueBalance = await glAccountBalance(organizationId, accountIds["4000"], "credit");

      expect(arBalance).toBe(0);
      expect(badDebtBalance).toBe(250);
      expect(cashBalance).toBe(750);
      expect(revenueBalance).toBe(1000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("B — idempotent retry same event returns duplicate=true with one write-off row", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-wo-idem");
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

      const eventId = randomUUID();
      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);

      const first = await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: invoice.id,
        amount: 250,
        writeoffDate: "2026-06-05",
        writeoffEventId: eventId,
        reason: "Partial uncollectible",
      });
      const second = await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: invoice.id,
        amount: 250,
        writeoffDate: "2026-06-05",
        writeoffEventId: eventId,
        reason: "Partial uncollectible",
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(first.writeoffId).toBe(second.writeoffId);

      expect(await countOrgRows(supabase, "teller_journal_entries", organizationId)).toBe(
        journalsBefore + 1,
      );

      const { count } = await supabase
        .from("teller_write_offs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("writeoff_event_id", eventId);
      expect(count).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("C — same event with conflicting amount rejects", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-wo-conflict");
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

      const eventId = randomUUID();
      await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: invoice.id,
        amount: 200,
        writeoffDate: "2026-06-05",
        writeoffEventId: eventId,
        reason: "First amount",
      });

      await expect(
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: invoice.id,
          amount: 300,
          writeoffDate: "2026-06-05",
          writeoffEventId: eventId,
          reason: "Different amount",
        }),
      ).rejects.toThrow(/Idempotency conflict/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("D — concurrent $700 write-offs against $1000 remaining → one succeeds, AR reconciled", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-wo-conc");
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

      const attempts = await Promise.allSettled([
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: invoice.id,
          amount: 700,
          writeoffDate: "2026-06-05",
          writeoffEventId: randomUUID(),
          reason: "Concurrent A",
        }),
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: invoice.id,
          amount: 700,
          writeoffDate: "2026-06-05",
          writeoffEventId: randomUUID(),
          reason: "Concurrent B",
        }),
      ]);

      expect(attempts.filter((r) => r.status === "fulfilled").length).toBe(1);
      expect(attempts.filter((r) => r.status === "rejected").length).toBe(1);

      const totalWrittenOff = await sumWriteOffsForDocument(supabase, organizationId, invoice.id);
      expect(totalWrittenOff).toBeLessThanOrEqual(1000);
      expect(totalWrittenOff).toBe(700);

      const { count: writeoffJournals } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "invoice-writeoff");
      expect(writeoffJournals).toBe(1);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("E — boundary rejects over-remaining, zero, and fully settled invoice", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p4-wo-bound");
    try {
      const openInvoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 500,
      });
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: openInvoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-01",
        number: openInvoice.number,
        tax: 0,
        lines: [{ amount: 500, account_id: accountIds["4000"], description: "Service" }],
      });

      await expect(
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: openInvoice.id,
          amount: 0,
          writeoffDate: "2026-06-05",
          writeoffEventId: randomUUID(),
          reason: "Zero",
        }),
      ).rejects.toThrow(/greater than zero/i);

      await expect(
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: openInvoice.id,
          amount: 600,
          writeoffDate: "2026-06-05",
          writeoffEventId: randomUUID(),
          reason: "Too much",
        }),
      ).rejects.toThrow(/exceeds remaining/i);

      await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: openInvoice.id,
        amount: 500,
        writeoffDate: "2026-06-05",
        writeoffEventId: randomUUID(),
        reason: "Exact remaining",
      });

      await expect(
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: openInvoice.id,
          amount: 1,
          writeoffDate: "2026-06-06",
          writeoffEventId: randomUUID(),
          reason: "Already settled",
        }),
      ).rejects.toThrow(/exceeds remaining/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("F — cross-org invoice write-off rejects", async () => {
    const orgA = await createTestOrganization(supabase, "p4-wo-org-a");
    const orgB = await createTestOrganization(supabase, "p4-wo-org-b");
    try {
      const invoice = await createTestInvoice(supabase, {
        organizationId: orgA.organizationId,
        revenueAccountId: orgA.accountIds["4000"],
        total: 1000,
      });
      await postInvoiceOpen(supabase, {
        organizationId: orgA.organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: orgA.accountIds["4000"], description: "Service" }],
      });

      const { error } = await supabase.rpc("teller_write_off_invoice", {
        p_organization_id: orgB.organizationId,
        p_invoice_id: invoice.id,
        p_amount: 100,
        p_writeoff_date: "2026-06-05",
        p_writeoff_event_id: randomUUID(),
        p_reason: "Wrong org",
        p_bad_debt_account_id: orgB.accountIds["6850"],
        p_ar_account_id: orgB.accountIds["1100"],
      });
      expect(error?.message).toMatch(/not found|Invoice/i);
    } finally {
      await deleteTestOrganization(supabase, orgA.organizationId);
      await deleteTestOrganization(supabase, orgB.organizationId);
    }
  });
});
