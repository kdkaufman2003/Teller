import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { checkAllocationReversalIntegrity } from "@/lib/accounting/allocation-integrity";
import { postCreditMemoOpen } from "@/lib/accounting/credits";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  receiveCustomerDeposit,
} from "@/lib/accounting/deposits";
import { recordPaymentAllocation } from "@/lib/accounting/allocations";
import { recordTellerPayment } from "@/lib/accounting/payments";
import { buildInvoicePaymentLines } from "@/lib/accounting/payment-fees";
import { postInvoiceOpen, postInvoicePaid, postJournal, loadOrgAccounts } from "@/lib/accounting/post";
import { accountByCode, accountBySubtype } from "@/lib/accounting/accounts";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import {
  refundCustomerCredit,
  refundCustomerDeposit,
  reverseDepositApplication,
  reverseDocumentAllocation,
  reversePayment,
  writeOffInvoice,
} from "@/lib/accounting/settlements";
import { applyDocumentCredit } from "@/lib/accounting/credits";
import {
  closeBooksThrough,
  countOrgRows,
  createIntegrationClient,
  createTestCreditMemo,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
  TELLER_INTEGRATION_FORCE_ROLLBACK,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 4 integration gates", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  async function createCustomer(organizationId: string) {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "customer",
        name: `Gate Customer ${Date.now()}`,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not create customer");
    return data.id as string;
  }

  async function seedPostedCreditMemo(
    organizationId: string,
    accountIds: Record<string, string>,
    partyId: string,
    total: number,
  ) {
    const credit = await createTestCreditMemo(supabase, {
      organizationId,
      revenueAccountId: accountIds["4000"],
      partyId,
      total,
    });
    await postCreditMemoOpen(supabase, {
      organizationId,
      documentId: credit.id,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: credit.number,
      tax: 0,
      lines: [{ amount: total, account_id: accountIds["4000"], description: "Credit" }],
    });
    return credit.id;
  }

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

  it("concurrent credit refund — exactly one of two $700 attempts succeeds against $1,000 credit", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-cc-conc");
    try {
      const partyId = await createCustomer(organizationId);
      const creditMemoId = await seedPostedCreditMemo(organizationId, accountIds, partyId, 1000);

      const attempts = await Promise.allSettled([
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId,
          amount: 700,
          refundDate: "2026-06-03",
          refundEventId: randomUUID(),
          reason: "Concurrent A",
        }),
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId,
          amount: 700,
          refundDate: "2026-06-03",
          refundEventId: randomUUID(),
          reason: "Concurrent B",
        }),
      ]);

      const succeeded = attempts.filter((r) => r.status === "fulfilled");
      const failed = attempts.filter((r) => r.status === "rejected");
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);

      const { data: refunds } = await supabase
        .from("teller_payments")
        .select("amount")
        .eq("organization_id", organizationId)
        .eq("document_id", creditMemoId)
        .eq("payment_type", "customer_refund");

      const refunded = (refunds ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
      expect(refunded).toBeLessThanOrEqual(1000);
      expect(refunded).toBeGreaterThan(0);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("concurrent deposit refund — exactly one of two $700 attempts succeeds against $1,000 deposit", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-dep-conc");
    try {
      const partyId = await createCustomer(organizationId);
      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 1000,
        paymentDate: "2026-06-01",
      });

      const attempts = await Promise.allSettled([
        refundCustomerDeposit(supabase, {
          organizationId,
          depositPaymentId: deposit.paymentId!,
          amount: 700,
          refundDate: "2026-06-02",
          refundEventId: randomUUID(),
          reason: "Concurrent A",
        }),
        refundCustomerDeposit(supabase, {
          organizationId,
          depositPaymentId: deposit.paymentId!,
          amount: 700,
          refundDate: "2026-06-02",
          refundEventId: randomUUID(),
          reason: "Concurrent B",
        }),
      ]);

      expect(attempts.filter((r) => r.status === "fulfilled").length).toBe(1);
      expect(attempts.filter((r) => r.status === "rejected").length).toBe(1);

      expect(
        await authoritativeDepositRemaining(
          supabase,
          organizationId,
          deposit.paymentId!,
          1000,
        ),
      ).toBeGreaterThanOrEqual(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("concurrent write-off — exactly one of two $700 attempts succeeds against $1,000 remaining", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-wo-conc");
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
      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000),
      ).toBeGreaterThanOrEqual(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("closed period — every Phase 4 economic RPC rejects with zero new rows", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-closed");
    try {
      const closedDate = "2026-06-15";
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
      const paid = await postInvoicePaid(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-02",
        number: invoice.number,
        total: 500,
        invoiceTotal: 1000,
        priorPaid: 0,
      });

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 200,
        paymentDate: "2026-06-01",
      });
      const applied = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: deposit.paymentId!,
        invoiceId: invoice.id,
        amount: 100,
        applicationDate: "2026-06-03",
        applicationEventId: randomUUID(),
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
        issueDate: "2026-06-01",
        number: credit.number,
        tax: 0,
        lines: [{ amount: 100, account_id: accountIds["4000"], description: "Credit" }],
      });
      const creditApplied = await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: credit.id,
        targetDocumentId: invoice.id,
        amount: 50,
      });

      const openInvoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 300,
      });
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: openInvoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-06-01",
        number: openInvoice.number,
        tax: 0,
        lines: [{ amount: 300, account_id: accountIds["4000"], description: "Service" }],
      });

      await closeBooksThrough(supabase, organizationId, "2026-06-30");

      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      const writeoffsBefore = await countOrgRows(supabase, "teller_write_offs", organizationId);

      const reject = /closed through/i;

      await expect(
        reversePayment(supabase, {
          organizationId,
          paymentId: paid.paymentId!,
          reversalDate: closedDate,
          reversalEventId: randomUUID(),
          reason: "Closed period test",
        }),
      ).rejects.toThrow(reject);

      await expect(
        reverseDepositApplication(supabase, {
          organizationId,
          allocationId: applied.allocationId,
          reversalDate: closedDate,
          reversalEventId: randomUUID(),
          reason: "Closed period test",
        }),
      ).rejects.toThrow(reject);

      await expect(
        reverseDocumentAllocation(supabase, {
          organizationId,
          allocationId: creditApplied.allocationId,
          reversalDate: closedDate,
          reversalEventId: randomUUID(),
          reason: "Closed period test",
        }),
      ).rejects.toThrow(reject);

      await expect(
        refundCustomerDeposit(supabase, {
          organizationId,
          depositPaymentId: deposit.paymentId!,
          amount: 50,
          refundDate: closedDate,
          refundEventId: randomUUID(),
          reason: "Closed period test",
        }),
      ).rejects.toThrow(reject);

      await expect(
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId: credit.id,
          amount: 25,
          refundDate: closedDate,
          refundEventId: randomUUID(),
          reason: "Closed period test",
        }),
      ).rejects.toThrow(reject);

      await expect(
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: openInvoice.id,
          amount: 100,
          writeoffDate: closedDate,
          writeoffEventId: randomUUID(),
          reason: "Closed period test",
        }),
      ).rejects.toThrow(reject);

      expect(await countOrgRows(supabase, "teller_journal_entries", organizationId)).toBe(
        journalsBefore,
      );
      expect(await countOrgRows(supabase, "teller_write_offs", organizationId)).toBe(
        writeoffsBefore,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("cross-org — Phase 4 RPCs reject foreign resource substitution", async () => {
    const orgA = await createTestOrganization(supabase, "gate-org-a");
    const orgB = await createTestOrganization(supabase, "gate-org-b");
    try {
      const partyA = await createCustomer(orgA.organizationId);
      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId: orgA.organizationId,
        partyId: partyA,
        amount: 500,
        paymentDate: "2026-06-01",
      });

      const reject = /not found|does not belong|organization/i;

      const { error: depositRefundError } = await supabase.rpc("teller_refund_customer_deposit", {
        p_organization_id: orgA.organizationId,
        p_deposit_payment_id: deposit.paymentId,
        p_amount: 100,
        p_refund_date: "2026-06-02",
        p_refund_event_id: randomUUID(),
        p_reason: "Cross-org cash",
        p_cash_account_id: orgB.accountIds["1000"],
        p_deposits_account_id: orgA.accountIds["2300"],
      });
      expect(depositRefundError?.message).toMatch(reject);

      const { error: depositRefundDepError } = await supabase.rpc("teller_refund_customer_deposit", {
        p_organization_id: orgA.organizationId,
        p_deposit_payment_id: deposit.paymentId,
        p_amount: 100,
        p_refund_date: "2026-06-02",
        p_refund_event_id: randomUUID(),
        p_reason: "Cross-org deposits account",
        p_cash_account_id: orgA.accountIds["1000"],
        p_deposits_account_id: orgB.accountIds["2300"],
      });
      expect(depositRefundDepError?.message).toMatch(reject);

      const creditA = await seedPostedCreditMemo(
        orgA.organizationId,
        orgA.accountIds,
        partyA,
        200,
      );

      const { error: creditRefundError } = await supabase.rpc("teller_refund_customer_credit", {
        p_organization_id: orgA.organizationId,
        p_credit_memo_id: creditA,
        p_amount: 50,
        p_refund_date: "2026-06-02",
        p_refund_event_id: randomUUID(),
        p_reason: "Cross-org AR",
        p_cash_account_id: orgA.accountIds["1000"],
        p_ar_account_id: orgB.accountIds["1100"],
      });
      expect(creditRefundError?.message).toMatch(reject);

      const invoiceA = await createTestInvoice(supabase, {
        organizationId: orgA.organizationId,
        revenueAccountId: orgA.accountIds["4000"],
        total: 400,
      });
      await postInvoiceOpen(supabase, {
        organizationId: orgA.organizationId,
        documentId: invoiceA.id,
        partyId: partyA,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoiceA.number,
        tax: 0,
        lines: [{ amount: 400, account_id: orgA.accountIds["4000"], description: "Service" }],
      });

      const { error: writeoffError } = await supabase.rpc("teller_write_off_invoice", {
        p_organization_id: orgA.organizationId,
        p_invoice_id: invoiceA.id,
        p_amount: 100,
        p_writeoff_date: "2026-06-05",
        p_writeoff_event_id: randomUUID(),
        p_reason: "Cross-org bad debt",
        p_bad_debt_account_id: orgB.accountIds["6850"],
        p_ar_account_id: orgA.accountIds["1100"],
      });
      expect(writeoffError?.message).toMatch(reject);

      const paid = await postInvoicePaid(supabase, {
        organizationId: orgA.organizationId,
        documentId: invoiceA.id,
        partyId: partyA,
        jobId: null,
        issueDate: "2026-06-02",
        number: invoiceA.number,
        total: 400,
        invoiceTotal: 400,
        priorPaid: 0,
      });

      const { error: reversePayError } = await supabase.rpc("teller_reverse_payment", {
        p_organization_id: orgB.organizationId,
        p_payment_id: paid.paymentId,
        p_reversal_date: "2026-06-03",
        p_reversal_event_id: randomUUID(),
        p_reason: "Cross-org payment",
      });
      expect(reversePayError?.message).toMatch(reject);

      const { error: wrongOrgDepositError } = await supabase.rpc("teller_refund_customer_deposit", {
        p_organization_id: orgB.organizationId,
        p_deposit_payment_id: deposit.paymentId,
        p_amount: 50,
        p_refund_date: "2026-06-02",
        p_refund_event_id: randomUUID(),
        p_reason: "Org B claiming Org A deposit",
        p_cash_account_id: orgB.accountIds["1000"],
        p_deposits_account_id: orgB.accountIds["2300"],
      });
      expect(wrongOrgDepositError?.message).toMatch(reject);

      const { error: wrongOrgCreditError } = await supabase.rpc("teller_refund_customer_credit", {
        p_organization_id: orgB.organizationId,
        p_credit_memo_id: creditA,
        p_amount: 25,
        p_refund_date: "2026-06-02",
        p_refund_event_id: randomUUID(),
        p_reason: "Org B claiming Org A credit",
        p_cash_account_id: orgB.accountIds["1000"],
        p_ar_account_id: orgB.accountIds["1100"],
      });
      expect(wrongOrgCreditError?.message).toMatch(reject);
    } finally {
      await deleteTestOrganization(supabase, orgA.organizationId);
      await deleteTestOrganization(supabase, orgB.organizationId);
    }
  });

  it("idempotency — same event + same payload is duplicate with one economic effect", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-idem-same");
    try {
      const partyId = await createCustomer(organizationId);
      const creditMemoId = await seedPostedCreditMemo(organizationId, accountIds, partyId, 500);
      const eventId = randomUUID();

      const first = await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId,
        amount: 200,
        refundDate: "2026-06-03",
        refundEventId: eventId,
        reason: "Idempotent refund",
      });
      const second = await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId,
        amount: 200,
        refundDate: "2026-06-03",
        refundEventId: eventId,
        reason: "Idempotent refund",
      });

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(first.refundPaymentId).toBe(second.refundPaymentId);

      const { count } = await supabase
        .from("teller_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("refund_event_id", eventId);
      expect(count).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("idempotency — same event + different payload hard rejects", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-idem-diff");
    try {
      const partyId = await createCustomer(organizationId);
      const creditMemoId = await seedPostedCreditMemo(organizationId, accountIds, partyId, 500);
      const eventId = randomUUID();

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId,
        amount: 200,
        refundDate: "2026-06-03",
        refundEventId: eventId,
        reason: "First payload",
      });

      await expect(
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId,
          amount: 300,
          refundDate: "2026-06-03",
          refundEventId: eventId,
          reason: "Different amount",
        }),
      ).rejects.toThrow(/Idempotency conflict/i);

      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 400,
        paymentDate: "2026-06-01",
      });
      const depositEvent = randomUUID();
      await refundCustomerDeposit(supabase, {
        organizationId,
        depositPaymentId: deposit.paymentId!,
        amount: 100,
        refundDate: "2026-06-02",
        refundEventId: depositEvent,
        reason: "First deposit refund",
      });
      await expect(
        refundCustomerDeposit(supabase, {
          organizationId,
          depositPaymentId: deposit.paymentId!,
          amount: 150,
          refundDate: "2026-06-02",
          refundEventId: depositEvent,
          reason: "Different deposit amount",
        }),
      ).rejects.toThrow(/Idempotency conflict/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("forced failure rolls back with no orphan economic rows", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-rollback");
    try {
      const partyId = await createCustomer(organizationId);
      const creditMemoId = await seedPostedCreditMemo(organizationId, accountIds, partyId, 300);
      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId,
        partyId,
        amount: 300,
        paymentDate: "2026-06-01",
      });
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 500,
      });
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 500, account_id: accountIds["4000"], description: "Service" }],
      });

      const journalsBefore = await countOrgRows(supabase, "teller_journal_entries", organizationId);
      const paymentsBefore = await countOrgRows(supabase, "teller_payments", organizationId);
      const writeoffsBefore = await countOrgRows(supabase, "teller_write_offs", organizationId);

      await expect(
        refundCustomerCredit(supabase, {
          organizationId,
          creditMemoId,
          amount: 100,
          refundDate: "2026-06-03",
          refundEventId: randomUUID(),
          reason: TELLER_INTEGRATION_FORCE_ROLLBACK,
        }),
      ).rejects.toThrow(/FORCE_ROLLBACK/i);

      await expect(
        refundCustomerDeposit(supabase, {
          organizationId,
          depositPaymentId: deposit.paymentId!,
          amount: 100,
          refundDate: "2026-06-02",
          refundEventId: randomUUID(),
          reason: TELLER_INTEGRATION_FORCE_ROLLBACK,
        }),
      ).rejects.toThrow(/FORCE_ROLLBACK/i);

      await expect(
        writeOffInvoice(supabase, {
          organizationId,
          invoiceId: invoice.id,
          amount: 100,
          writeoffDate: "2026-06-05",
          writeoffEventId: randomUUID(),
          reason: TELLER_INTEGRATION_FORCE_ROLLBACK,
        }),
      ).rejects.toThrow(/FORCE_ROLLBACK/i);

      expect(await countOrgRows(supabase, "teller_journal_entries", organizationId)).toBe(
        journalsBefore,
      );
      expect(await countOrgRows(supabase, "teller_payments", organizationId)).toBe(paymentsBefore);
      expect(await countOrgRows(supabase, "teller_write_offs", organizationId)).toBe(
        writeoffsBefore,
      );
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("multi-invoice payment reversal restores both invoices and preserves allocation history", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-multi-inv");
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

      const { data: allocs } = await supabase
        .from("teller_payment_allocations")
        .select("allocation_kind, amount, reversal_of_allocation_id")
        .eq("organization_id", organizationId)
        .eq("payment_id", paymentId);

      const originals = (allocs ?? []).filter((row) => !row.reversal_of_allocation_id);
      const reversals = (allocs ?? []).filter((row) => row.reversal_of_allocation_id);
      expect(originals.length).toBe(2);
      expect(reversals.length).toBe(2);

      const integrity = await checkAllocationReversalIntegrity(supabase, organizationId);
      expect(integrity.consistent).toBe(true);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);

      const { data: payment } = await supabase
        .from("teller_payments")
        .select("status, void_journal_entry_id")
        .eq("id", paymentId)
        .single();
      expect(payment?.status).toBe("void");
      expect(payment?.void_journal_entry_id).toBeTruthy();
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("duplicate deposit application reversal — event A idempotent, event B rejected", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-dep-rev-dup");
    try {
      const partyId = await createCustomer(organizationId);
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

      const eventA = randomUUID();
      const first = await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalDate: "2026-06-03",
        reversalEventId: eventA,
        reason: "Undo application",
      });
      const second = await reverseDepositApplication(supabase, {
        organizationId,
        allocationId: applied.allocationId,
        reversalDate: "2026-06-03",
        reversalEventId: eventA,
        reason: "Undo application",
      });
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);

      await expect(
        reverseDepositApplication(supabase, {
          organizationId,
          allocationId: applied.allocationId,
          reversalDate: "2026-06-04",
          reversalEventId: randomUUID(),
          reason: "Second reversal attempt",
        }),
      ).rejects.toThrow(/already been reversed/i);

      const { count: reversalJournalCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_kind", "deposit-application-reversal");
      expect(reversalJournalCount).toBe(1);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("credit refund does not alter invoice amount_paid or remaining", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-cr-inv");
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

      const creditMemoId = await seedPostedCreditMemo(organizationId, accountIds, partyId, 250);
      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000),
      ).toBe(0);

      await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId,
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
      expect(
        await authoritativeDocumentRemaining(supabase, organizationId, invoice.id, 1000),
      ).toBe(0);
      expect(await sumCreditsAppliedFromDocument(supabase, organizationId, creditMemoId)).toBe(0);

      const ar = (await reconcileSubledgersToGl(supabase, organizationId)).find(
        (row) => row.side === "ar",
      );
      expect(ar?.consistent).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("write-off presentation — amount_paid is cash only, status settled as paid", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "gate-wo-pres");
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
        reason: "Uncollectible",
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

      const { data: payments } = await supabase
        .from("teller_payments")
        .select("amount, payment_type")
        .eq("organization_id", organizationId)
        .eq("document_id", invoice.id);
      const cashPayments = (payments ?? []).filter((p) => p.payment_type === "customer_payment");
      expect(cashPayments.reduce((s, p) => s + Number(p.amount), 0)).toBe(750);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
