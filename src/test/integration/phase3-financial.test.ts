import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  receiveCustomerDeposit,
  sumDepositApplicationsForPayment,
  voidCustomerDeposit,
} from "@/lib/accounting/deposits";
import { asNumber } from "@/lib/format";
import { reconcileDepositsToGl } from "@/lib/accounting/deposit-reconciliation";
import { computeArControlSubledgerTotal } from "@/lib/accounting/party-balances";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { accountByCode, accountBySubtype } from "@/lib/accounting/accounts";
import { loadOrgAccounts, postInvoiceOpen, postJournal } from "@/lib/accounting/post";
import {
  createIntegrationClient,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 3 deposit integration", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function createCustomer(organizationId: string) {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "customer",
        name: `Deposit Customer ${Date.now()}`,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not create customer");
    return data.id as string;
  }

  it("deposit receipt posts Dr Cash Cr Customer Deposits with full unapplied balance", async () => {
    const { organizationId } = await createTestOrganization(supabase, "dep-receipt");
    try {
      const partyId = await createCustomer(organizationId);
      const result = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-05-01",
      });

      expect(result.unapplied).toBe(5000);
      expect(result.duplicate).toBe(false);

      const depositRecon = await reconcileDepositsToGl(supabase, organizationId);
      expect(depositRecon?.consistent).toBe(true);
      expect(depositRecon?.glControlBalance).toBe(5000);
      expect(depositRecon?.subledgerUnappliedBalance).toBe(5000);

      const arRecon = await reconcileSubledgersToGl(supabase, organizationId);
      const ar = arRecon.find((row) => row.side === "ar");
      expect(ar?.glControlBalance ?? 0).toBe(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("partial and final deposit application with independent AR/deposit reconciliation", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-apply");
    try {
      const partyId = await createCustomer(organizationId);
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 15000,
      });
      await supabase
        .from("teller_documents")
        .update({ party_id: partyId })
        .eq("id", invoice.id);

      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-05-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 15000, account_id: accountIds["4000"], description: "Install" }],
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-05-02",
      });

      let arControl = await computeArControlSubledgerTotal(supabase, organizationId);
      let depositRecon = await reconcileDepositsToGl(supabase, organizationId);
      expect(arControl.netSubledgerBalance).toBe(15000);
      expect(depositRecon?.subledgerUnappliedBalance).toBe(5000);

      await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 3000,
        applicationDate: "2026-05-03",
      });

      const invoiceRemaining = await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        invoice.id,
        15000,
      );
      expect(invoiceRemaining).toBe(12000);

      arControl = await computeArControlSubledgerTotal(supabase, organizationId);
      depositRecon = await reconcileDepositsToGl(supabase, organizationId);
      expect(arControl.netSubledgerBalance).toBe(12000);
      expect(depositRecon?.subledgerUnappliedBalance).toBe(2000);

      const arResult = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(arResult?.consistent).toBe(true);
      expect(arResult?.glControlBalance).toBe(12000);
      expect(depositRecon?.consistent).toBe(true);
      expect(depositRecon?.glControlBalance).toBe(2000);

      await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 2000,
        applicationDate: "2026-05-04",
      });

      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 15000),
      ).toBe(10000);

      depositRecon = await reconcileDepositsToGl(supabase, organizationId);
      expect(depositRecon?.subledgerUnappliedBalance).toBe(0);
      expect(depositRecon?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects over-application and cross-customer apply", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-val");
    try {
      const partyA = await createCustomer(organizationId);
      const partyB = await createCustomer(organizationId);
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
      });
      await supabase.from("teller_documents").update({ party_id: partyA }).eq("id", invoice.id);
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: partyA,
        jobId: null,
        issueDate: "2026-05-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Service" }],
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId: partyB,
        amount: 500,
        paymentDate: "2026-05-02",
      });

      await expect(
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 100,
          applicationDate: "2026-05-03",
        }),
      ).rejects.toThrow(/same customer/i);

      const depositA = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId: partyA,
        amount: 200,
        paymentDate: "2026-05-02",
      });

      await expect(
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: depositA.paymentId!,
          invoiceId: invoice.id,
          amount: 500,
          applicationDate: "2026-05-03",
        }),
      ).rejects.toThrow(/exceeds deposit remaining/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("blocks void on applied deposit and allows void on unapplied", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-void");
    try {
      const partyId = await createCustomer(organizationId);

      const unapplied = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 1000,
        paymentDate: "2026-05-01",
        externalSource: "test",
        externalId: `void-unapplied-${Date.now()}`,
      });

      await expect(
        voidCustomerDeposit(supabase, {
          organizationId,
          paymentId: unapplied.paymentId!,
          voidDate: "2026-05-02",
        }),
      ).resolves.toMatchObject({ ok: true });

      const appliedDeposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 1000,
        paymentDate: "2026-05-01",
        externalSource: "test",
        externalId: `void-applied-${Date.now()}`,
      });

      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 500,
      });
      await supabase.from("teller_documents").update({ party_id: partyId }).eq("id", invoice.id);
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-05-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 500, account_id: accountIds["4000"], description: "S" }],
      });

      await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: appliedDeposit.paymentId!,
        invoiceId: invoice.id,
        amount: 200,
        applicationDate: "2026-05-02",
      });

      await expect(
        voidCustomerDeposit(supabase, {
          organizationId,
          paymentId: appliedDeposit.paymentId!,
          voidDate: "2026-05-03",
        }),
      ).rejects.toThrow(/applications/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("idempotent external deposit creates one payment", async () => {
    const { organizationId } = await createTestOrganization(supabase, "dep-idem");
    try {
      const partyId = await createCustomer(organizationId);
      const externalId = `ext-${Date.now()}`;
      const receiptEventId = randomUUID();
      const first = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 800,
        paymentDate: "2026-05-01",
        externalSource: "test",
        externalId,
        receiptEventId,
      });
      const second = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 800,
        paymentDate: "2026-05-01",
        externalSource: "test",
        externalId,
        receiptEventId,
      });
      expect(second.duplicate).toBe(true);
      expect(second.paymentId).toBe(first.paymentId);

      const { count } = await supabase
        .from("teller_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("external_source", "test")
        .eq("external_id", externalId);
      expect(count).toBe(1);

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "customer-deposit")
        .eq("source_id", receiptEventId);
      expect(journalCount).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("blocks deposit receipt in closed period without journal or payment", async () => {
    const { organizationId } = await createTestOrganization(supabase, "dep-period");
    try {
      const partyId = await createCustomer(organizationId);
      const receiptEventId = randomUUID();
      await supabase.from("teller_period_closes").insert({
        organization_id: organizationId,
        period_end: "2026-04-30",
        notes: "Phase 3 period test",
      });

      await expect(
        receiveCustomerDeposit(supabase, {
          organizationId,
          partyId,
          amount: 500,
          paymentDate: "2026-04-15",
          receiptEventId,
        }),
      ).rejects.toThrow(/closed/i);

      const { count: paymentCount } = await supabase
        .from("teller_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("receipt_event_id", receiptEventId);
      expect(paymentCount).toBe(0);

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "customer-deposit")
        .eq("source_id", receiptEventId);
      expect(journalCount).toBe(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  async function setupDepositApplyScenario(organizationId: string, accountIds: Record<string, string>) {
    const partyId = await createCustomer(organizationId);
    const invoice = await createTestInvoice(supabase, {
      organizationId,
      revenueAccountId: accountIds["4000"],
      total: 15000,
    });
    await supabase.from("teller_documents").update({ party_id: partyId }).eq("id", invoice.id);
    await postInvoiceOpen(supabase, {
      organizationId,
      documentId: invoice.id,
      partyId,
      jobId: null,
      issueDate: "2026-05-01",
      number: invoice.number,
      tax: 0,
      lines: [{ amount: 15000, account_id: accountIds["4000"], description: "Install" }],
    });
    const deposit = await receiveCustomerDeposit(supabase, {
      organizationId,
      partyId,
      amount: 5000,
      paymentDate: "2026-05-02",
    });
    return { partyId, invoice, deposit };
  }

  it("deposit application idempotency: first apply, identical retry, separate event", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-idem-apply");
    try {
      const { invoice, deposit } = await setupDepositApplyScenario(organizationId, accountIds);
      const eventA = randomUUID();
      const eventB = randomUUID();

      const first = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 3000,
        applicationDate: "2026-05-03",
        applicationEventId: eventA,
      });

      expect(first.duplicate).toBe(false);
      expect(first.depositRemaining).toBe(2000);
      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 15000),
      ).toBe(12000);

      const { count: journalCountAfterFirst } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "deposit-application");

      const retry = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 3000,
        applicationDate: "2026-05-03",
        applicationEventId: eventA,
      });

      expect(retry.duplicate).toBe(true);
      expect(retry.allocationId).toBe(first.allocationId);
      expect(retry.applicationEntryId).toBe(first.applicationEntryId);
      expect(retry.depositRemaining).toBe(2000);
      expect(
        await authoritativeDepositRemaining(
          supabase,
          organizationId,
          deposit.paymentId!,
          5000,
        ),
      ).toBe(2000);

      const { count: journalCountAfterRetry } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "deposit-application");
      expect(journalCountAfterRetry).toBe(journalCountAfterFirst);

      const { count: allocationCountAfterRetry } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("payment_id", deposit.paymentId!)
        .eq("allocation_kind", "deposit_apply");
      expect(allocationCountAfterRetry).toBe(1);

      const second = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 2000,
        applicationDate: "2026-05-04",
        applicationEventId: eventB,
      });

      expect(second.duplicate).toBe(false);
      expect(second.depositRemaining).toBe(0);
      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 15000),
      ).toBe(10000);

      const { count: allocationCountFinal } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("payment_id", deposit.paymentId!)
        .eq("allocation_kind", "deposit_apply");
      expect(allocationCountFinal).toBe(2);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects idempotency conflict when reusing event id with different amount", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-idem-conflict");
    try {
      const { invoice, deposit } = await setupDepositApplyScenario(organizationId, accountIds);
      const eventA = randomUUID();

      await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 3000,
        applicationDate: "2026-05-03",
        applicationEventId: eventA,
      });

      await expect(
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 2000,
          applicationDate: "2026-05-03",
          applicationEventId: eventA,
        }),
      ).rejects.toThrow(/idempotency conflict/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("recovers from partial failure when application journal already exists", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-recover");
    try {
      const { invoice, deposit, partyId } = await setupDepositApplyScenario(
        organizationId,
        accountIds,
      );
      const eventA = randomUUID();
      const accounts = await loadOrgAccounts(supabase, organizationId);
      const depositsAccount =
        accountBySubtype(accounts, "deposit") || accountByCode(accounts, "2300");
      const arAccount = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
      if (!depositsAccount || !arAccount) throw new Error("Missing COA accounts");

      const orphanJournalId = await postJournal(supabase, {
        organizationId,
        entryDate: "2026-05-03",
        memo: `Apply deposit to ${invoice.number}`,
        sourceKind: "deposit-application",
        sourceId: eventA,
        lines: [
          {
            account_id: depositsAccount.id,
            debit: 3000,
            party_id: partyId,
            memo: "Release customer deposit liability",
          },
          {
            account_id: arAccount.id,
            credit: 3000,
            party_id: partyId,
            memo: `Apply deposit to ${invoice.number}`,
          },
        ],
      });

      const recovered = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 3000,
        applicationDate: "2026-05-03",
        applicationEventId: eventA,
      });

      expect(recovered.recovered).toBe(true);
      expect(recovered.duplicate).toBe(false);
      expect(recovered.applicationEntryId).toBe(orphanJournalId);

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "deposit-application")
        .eq("source_id", eventA);
      expect(journalCount).toBe(1);

      const { count: allocationCount } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("application_event_id", eventA);
      expect(allocationCount).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("concurrent same-event applications produce one economic effect", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-conc-same");
    try {
      const { invoice, deposit } = await setupDepositApplyScenario(organizationId, accountIds);
      const eventA = randomUUID();

      const results = await Promise.allSettled([
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 3000,
          applicationDate: "2026-05-03",
          applicationEventId: eventA,
        }),
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 3000,
          applicationDate: "2026-05-03",
          applicationEventId: eventA,
        }),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const payloads = results.map(
        (result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof applyDepositToInvoice>>>).value,
      );
      expect(payloads.filter((row) => !row.duplicate).length).toBeLessThanOrEqual(1);
      expect(payloads.filter((row) => row.duplicate).length).toBeGreaterThanOrEqual(1);

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "deposit-application")
        .eq("source_id", eventA);
      expect(journalCount).toBe(1);

      const { count: allocationCount } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("application_event_id", eventA);
      expect(allocationCount).toBe(1);

      expect(
        await sumDepositApplicationsForPayment(supabase, organizationId, deposit.paymentId!),
      ).toBe(3000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("concurrent different events cannot over-apply a deposit", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-conc-over");
    try {
      const { invoice, deposit } = await setupDepositApplyScenario(organizationId, accountIds);
      const eventA = randomUUID();
      const eventB = randomUUID();

      const results = await Promise.allSettled([
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 4000,
          applicationDate: "2026-05-03",
          applicationEventId: eventA,
        }),
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 4000,
          applicationDate: "2026-05-03",
          applicationEventId: eventB,
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      expect(
        await sumDepositApplicationsForPayment(supabase, organizationId, deposit.paymentId!),
      ).toBe(4000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("concurrent different deposits cannot over-settle an invoice", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-conc-inv");
    try {
      const partyId = await createCustomer(organizationId);
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
        issueDate: "2026-05-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 5000, account_id: accountIds["4000"], description: "Install" }],
      });

      const depositA = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-05-02",
        externalSource: "test",
        externalId: `dep-a-${Date.now()}`,
      });
      const depositB = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-05-02",
        externalSource: "test",
        externalId: `dep-b-${Date.now()}`,
      });

      const results = await Promise.allSettled([
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: depositA.paymentId!,
          invoiceId: invoice.id,
          amount: 4000,
          applicationDate: "2026-05-03",
          applicationEventId: randomUUID(),
        }),
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: depositB.paymentId!,
          invoiceId: invoice.id,
          amount: 4000,
          applicationDate: "2026-05-03",
          applicationEventId: randomUUID(),
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 5000),
      ).toBe(1000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("allows safe concurrent applications when balances permit both", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-conc-ok");
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
        issueDate: "2026-05-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 10000, account_id: accountIds["4000"], description: "Install" }],
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 10000,
        paymentDate: "2026-05-02",
      });

      const eventA = randomUUID();
      const eventB = randomUUID();

      const results = await Promise.allSettled([
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 3000,
          applicationDate: "2026-05-03",
          applicationEventId: eventA,
        }),
        applyDepositToInvoice(supabase, {
          organizationId,
          paymentId: deposit.paymentId!,
          invoiceId: invoice.id,
          amount: 2000,
          applicationDate: "2026-05-03",
          applicationEventId: eventB,
        }),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(
        await sumDepositApplicationsForPayment(supabase, organizationId, deposit.paymentId!),
      ).toBe(5000);
      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 10000),
      ).toBe(5000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rolls back failed atomic application without persisting journal or allocation", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-rollback");
    try {
      const { invoice, deposit } = await setupDepositApplyScenario(organizationId, accountIds);
      const eventA = randomUUID();
      const accounts = await loadOrgAccounts(supabase, organizationId);
      const depositsAccount =
        accountBySubtype(accounts, "deposit") || accountByCode(accounts, "2300");
      if (!depositsAccount) throw new Error("Missing deposits account");

      const { error } = await supabase.rpc("teller_apply_deposit_to_invoice", {
        p_organization_id: organizationId,
        p_payment_id: deposit.paymentId!,
        p_invoice_id: invoice.id,
        p_amount: 3000,
        p_application_date: "2026-05-03",
        p_application_event_id: eventA,
        p_deposits_account_id: depositsAccount.id,
        p_ar_account_id: randomUUID(),
        p_memo: "",
      });

      expect(error).toBeTruthy();

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "deposit-application")
        .eq("source_id", eventA);
      expect(journalCount).toBe(0);

      const { count: allocationCount } = await supabase
        .from("teller_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("application_event_id", eventA);
      expect(allocationCount).toBe(0);

      const { data: invoiceRow } = await supabase
        .from("teller_documents")
        .select("amount_paid, status")
        .eq("id", invoice.id)
        .single();
      expect(asNumber(invoiceRow?.amount_paid)).toBe(0);
      expect(invoiceRow?.status).toBe("open");
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("atomic receipt: normal journal, payment, and unapplied balance", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-rcpt-norm");
    try {
      const partyId = await createCustomer(organizationId);
      const receiptEventId = randomUUID();
      const result = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-05-01",
        receiptEventId,
      });

      expect(result.duplicate).toBe(false);
      expect(result.unapplied).toBe(5000);

      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit, account_id")
        .eq("entry_id", result.entryId);

      const cashAccountId = accountIds["1000"];
      const depositAccountId = accountIds["2300"];
      const cashLine = (lines ?? []).find((row) => row.account_id === cashAccountId);
      const depositLine = (lines ?? []).find((row) => row.account_id === depositAccountId);
      expect(asNumber(cashLine?.debit)).toBe(5000);
      expect(asNumber(depositLine?.credit)).toBe(5000);

      const { count: paymentCount } = await supabase
        .from("teller_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("receipt_event_id", receiptEventId);
      expect(paymentCount).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects receipt idempotency conflict for same event with different amount", async () => {
    const { organizationId } = await createTestOrganization(supabase, "dep-rcpt-conflict");
    try {
      const partyId = await createCustomer(organizationId);
      const receiptEventId = randomUUID();
      await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 5000,
        paymentDate: "2026-05-01",
        receiptEventId,
      });

      await expect(
        receiveCustomerDeposit(supabase, {
          organizationId,
          partyId,
          amount: 4000,
          paymentDate: "2026-05-01",
          receiptEventId,
        }),
      ).rejects.toThrow(/idempotency conflict/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("concurrent same receipt event produces exactly one economic receipt", async () => {
    const { organizationId } = await createTestOrganization(supabase, "dep-rcpt-conc");
    try {
      const partyId = await createCustomer(organizationId);
      const receiptEventId = randomUUID();

      const results = await Promise.allSettled([
        receiveCustomerDeposit(supabase, {
          organizationId,
          partyId,
          amount: 5000,
          paymentDate: "2026-05-01",
          receiptEventId,
        }),
        receiveCustomerDeposit(supabase, {
          organizationId,
          partyId,
          amount: 5000,
          paymentDate: "2026-05-01",
          receiptEventId,
        }),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const payloads = results.map(
        (result) =>
          (result as PromiseFulfilledResult<Awaited<ReturnType<typeof receiveCustomerDeposit>>>)
            .value,
      );
      expect(new Set(payloads.map((row) => row.paymentId)).size).toBe(1);
      expect(payloads.filter((row) => !row.duplicate).length).toBeLessThanOrEqual(1);

      const { count: paymentCount } = await supabase
        .from("teller_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("receipt_event_id", receiptEventId);
      expect(paymentCount).toBe(1);

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "customer-deposit")
        .eq("source_id", receiptEventId);
      expect(journalCount).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rolls back failed atomic receipt without journal or payment", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "dep-rcpt-rb");
    try {
      const partyId = await createCustomer(organizationId);
      const receiptEventId = randomUUID();
      const cashAccountId = accountIds["1000"];

      const { error } = await supabase.rpc("teller_receive_customer_deposit", {
        p_organization_id: organizationId,
        p_party_id: partyId,
        p_amount: 5000,
        p_payment_date: "2026-05-01",
        p_cash_account_id: cashAccountId,
        p_deposits_account_id: randomUUID(),
        p_receipt_event_id: receiptEventId,
        p_job_id: null,
        p_payment_method: null,
        p_reference_number: null,
        p_external_source: null,
        p_external_id: null,
        p_memo: null,
      });

      expect(error).toBeTruthy();

      const { count: paymentCount } = await supabase
        .from("teller_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("receipt_event_id", receiptEventId);
      expect(paymentCount).toBe(0);

      const { count: journalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "customer-deposit")
        .eq("source_id", receiptEventId);
      expect(journalCount).toBe(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
