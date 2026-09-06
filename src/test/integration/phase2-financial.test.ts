import { describe, expect, it } from "vitest";
import {
  authoritativeDocumentAmountPaid,
  authoritativeDocumentRemaining,
  documentRemainingBalance,
} from "@/lib/accounting/balances";
import { postBillOpen, postBillPaid, voidBill } from "@/lib/accounting/bills";
import {
  applyDocumentCredit,
  postCreditMemoOpen,
  postVendorCreditOpen,
} from "@/lib/accounting/credits";
import { PeriodClosedError } from "@/lib/accounting/periods";
import { postInvoiceOpen } from "@/lib/accounting/post";
import {
  authoritativeCreditRemaining,
  authoritativeInvoiceRemaining,
  computeApControlSubledgerTotal,
  computeArControlSubledgerTotal,
} from "@/lib/accounting/party-balances";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import {
  createIntegrationClient,
  createTestBill,
  createTestCreditMemo,
  createTestInvoice,
  createTestOrganization,
  createTestVendorCredit,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("Phase 2 financial integration", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  it("vendor bill partial and final payments with overpayment rejection", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "bill-pay");
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
        issueDate: "2026-04-01",
        number: bill.number,
        tax: 0,
        lines: [{ amount: 5000, account_id: accountIds["6100"], description: "Materials" }],
      });

      await postBillPaid(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-02",
        number: bill.number,
        paymentAmount: 2000,
        billTotal: 5000,
        priorPaid: 0,
      });

      let paid = await authoritativeDocumentAmountPaid(supabase, organizationId, bill.id);
      expect(paid).toBe(2000);
      expect(documentRemainingBalance(5000, paid)).toBe(3000);

      const { data: partialDoc } = await supabase
        .from("teller_documents")
        .select("status")
        .eq("id", bill.id)
        .single();
      expect(partialDoc?.status).toBe("partially_paid");

      await postBillPaid(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-03",
        number: bill.number,
        paymentAmount: 3000,
        billTotal: 5000,
        priorPaid: paid,
      });

      paid = await authoritativeDocumentAmountPaid(supabase, organizationId, bill.id);
      expect(paid).toBe(5000);

      const { data: paidDoc } = await supabase
        .from("teller_documents")
        .select("status, total")
        .eq("id", bill.id)
        .single();
      expect(paidDoc?.status).toBe("paid");
      expect(Number(paidDoc?.total)).toBe(5000);

      await expect(
        postBillPaid(supabase, {
          organizationId,
          documentId: bill.id,
          partyId: null,
          jobId: null,
          issueDate: "2026-04-04",
          number: bill.number,
          paymentAmount: 1,
          billTotal: 5000,
          priorPaid: paid,
        }),
      ).rejects.toThrow(/nothing left to pay|exceeds remaining/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("blocks void on partially paid bill", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "bill-void");
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
        issueDate: "2026-04-01",
        number: bill.number,
        tax: 0,
        lines: [{ amount: 5000, account_id: accountIds["6100"], description: "Materials" }],
      });

      await postBillPaid(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-02",
        number: bill.number,
        paymentAmount: 1000,
        billTotal: 5000,
        priorPaid: 0,
      });

      await expect(
        voidBill(supabase, {
          organizationId,
          documentId: bill.id,
          number: bill.number,
          voidDate: "2026-04-03",
          currentStatus: "partially_paid",
        }),
      ).rejects.toThrow(/payment or vendor credit/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("customer credit memo reduces invoice AR without changing invoice total", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "cm-apply");
    try {
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 10000,
      });

      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 10000, account_id: accountIds["4000"], description: "Service" }],
      });

      const creditMemo = await createTestCreditMemo(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1000,
        appliesToDocumentId: invoice.id,
      });

      await postCreditMemoOpen(supabase, {
        organizationId,
        documentId: creditMemo.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-02",
        number: creditMemo.number,
        tax: 0,
        reason: "Pricing adjustment",
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Credit" }],
      });

      await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: creditMemo.id,
        targetDocumentId: invoice.id,
        amount: 1000,
      });

      const remaining = await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        invoice.id,
        10000,
      );
      expect(remaining).toBe(9000);

      const { data: unchangedInvoice } = await supabase
        .from("teller_documents")
        .select("total")
        .eq("id", invoice.id)
        .single();
      expect(Number(unchangedInvoice?.total)).toBe(10000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("vendor credit reduces bill remaining without changing bill total", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "vc-apply");
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
        issueDate: "2026-04-01",
        number: bill.number,
        tax: 0,
        lines: [{ amount: 5000, account_id: accountIds["6100"], description: "Equipment" }],
      });

      const vendorCredit = await createTestVendorCredit(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total: 500,
        appliesToDocumentId: bill.id,
      });

      await postVendorCreditOpen(supabase, {
        organizationId,
        documentId: vendorCredit.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-02",
        number: vendorCredit.number,
        tax: 0,
        reason: "Return credit",
        lines: [{ amount: 500, account_id: accountIds["6100"], description: "Return" }],
      });

      await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: vendorCredit.id,
        targetDocumentId: bill.id,
        amount: 500,
      });

      const remaining = await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        bill.id,
        5000,
      );
      expect(remaining).toBe(4500);

      const { data: unchangedBill } = await supabase
        .from("teller_documents")
        .select("total")
        .eq("id", bill.id)
        .single();
      expect(Number(unchangedBill?.total)).toBe(5000);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("reconciles AR/AP subledgers after credits and payments", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "reconcile");
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
        issueDate: "2026-04-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1000, account_id: accountIds["4000"], description: "Service" }],
      });

      const bill = await createTestBill(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total: 800,
      });
      await postBillOpen(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-01",
        number: bill.number,
        tax: 0,
        lines: [{ amount: 800, account_id: accountIds["6100"], description: "Parts" }],
      });

      const results = await reconcileSubledgersToGl(supabase, organizationId);
      expect(results.length).toBeGreaterThan(0);
      for (const row of results) {
        expect(row.consistent).toBe(true);
      }
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("blocks bill posting in closed period", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "period-bill");
    try {
      await supabase.from("teller_period_closes").insert({
        organization_id: organizationId,
        period_end: "2026-03-31",
        notes: "Phase 2 period lock test",
      });

      const bill = await createTestBill(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total: 500,
      });

      await expect(
        postBillOpen(supabase, {
          organizationId,
          documentId: bill.id,
          partyId: null,
          jobId: null,
          issueDate: "2026-03-15",
          number: bill.number,
          tax: 0,
          lines: [{ amount: 500, account_id: accountIds["6100"], description: "Parts" }],
        }),
      ).rejects.toBeInstanceOf(PeriodClosedError);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  describe("AR control reconciliation with customer credits", () => {
    async function postCustomerInvoice(
      organizationId: string,
      accountIds: Record<string, string>,
      total: number,
      partyId: string | null = null,
    ) {
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total,
      });
      if (partyId) {
        await supabase
          .from("teller_documents")
          .update({ party_id: partyId })
          .eq("id", invoice.id);
      }
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId,
        jobId: null,
        issueDate: "2026-04-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: total, account_id: accountIds["4000"], description: "Service" }],
      });
      return invoice;
    }

    async function postCustomerCredit(
      organizationId: string,
      accountIds: Record<string, string>,
      total: number,
      partyId: string | null = null,
    ) {
      const creditMemo = await createTestCreditMemo(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total,
        partyId,
      });
      await postCreditMemoOpen(supabase, {
        organizationId,
        documentId: creditMemo.id,
        partyId,
        jobId: null,
        issueDate: "2026-04-02",
        number: creditMemo.number,
        tax: 0,
        reason: "Credit",
        lines: [{ amount: total, account_id: accountIds["4000"], description: "Credit" }],
      });
      return creditMemo;
    }

    it("unapplied credit: invoice 10,000 + credit 1,000 → customer AR 9,000 reconciles to GL", async () => {
      const { organizationId, accountIds } = await createTestOrganization(supabase, "ar-unapplied");
      try {
        const invoice = await postCustomerInvoice(organizationId, accountIds, 10000);
        const creditMemo = await postCustomerCredit(organizationId, accountIds, 1000);

        const invoiceRemaining = await authoritativeInvoiceRemaining(
          supabase,
          organizationId,
          invoice.id,
          10000,
        );
        const creditRemaining = await authoritativeCreditRemaining(
          supabase,
          organizationId,
          creditMemo.id,
          1000,
        );
        const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
        const [arResult] = await reconcileSubledgersToGl(supabase, organizationId);

        expect(invoiceRemaining).toBe(10000);
        expect(creditRemaining).toBe(1000);
        expect(arControl.invoiceRemainingTotal).toBe(10000);
        expect(arControl.unappliedCreditTotal).toBe(1000);
        expect(arControl.netSubledgerBalance).toBe(9000);
        expect(arResult?.consistent).toBe(true);
        expect(arResult?.glControlBalance).toBe(9000);
        expect(arResult?.difference).toBeLessThanOrEqual(0.01);
      } finally {
        await deleteTestOrganization(supabase, organizationId);
      }
    });

    it("partial credit application: invoice 9,000 remaining + credit 2,000 unapplied → customer AR 7,000", async () => {
      const { organizationId, accountIds } = await createTestOrganization(supabase, "ar-partial");
      try {
        const invoice = await postCustomerInvoice(organizationId, accountIds, 10000);
        const creditMemo = await postCustomerCredit(organizationId, accountIds, 3000);

        await applyDocumentCredit(supabase, {
          organizationId,
          sourceDocumentId: creditMemo.id,
          targetDocumentId: invoice.id,
          amount: 1000,
        });

        const invoiceRemaining = await authoritativeInvoiceRemaining(
          supabase,
          organizationId,
          invoice.id,
          10000,
        );
        const creditRemaining = await authoritativeCreditRemaining(
          supabase,
          organizationId,
          creditMemo.id,
          3000,
        );
        const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
        const [arResult] = await reconcileSubledgersToGl(supabase, organizationId);

        expect(invoiceRemaining).toBe(9000);
        expect(creditRemaining).toBe(2000);
        expect(arControl.netSubledgerBalance).toBe(7000);
        expect(arResult?.consistent).toBe(true);
        expect(arResult?.glControlBalance).toBe(7000);
      } finally {
        await deleteTestOrganization(supabase, organizationId);
      }
    });

    it("full credit application: invoice 7,000 remaining + credit 0 unapplied → customer AR 7,000", async () => {
      const { organizationId, accountIds } = await createTestOrganization(supabase, "ar-full");
      try {
        const invoice = await postCustomerInvoice(organizationId, accountIds, 10000);
        const creditMemo = await postCustomerCredit(organizationId, accountIds, 3000);

        await applyDocumentCredit(supabase, {
          organizationId,
          sourceDocumentId: creditMemo.id,
          targetDocumentId: invoice.id,
          amount: 3000,
        });

        const invoiceRemaining = await authoritativeInvoiceRemaining(
          supabase,
          organizationId,
          invoice.id,
          10000,
        );
        const creditRemaining = await authoritativeCreditRemaining(
          supabase,
          organizationId,
          creditMemo.id,
          3000,
        );
        const arControl = await computeArControlSubledgerTotal(supabase, organizationId);
        const [arResult] = await reconcileSubledgersToGl(supabase, organizationId);

        expect(invoiceRemaining).toBe(7000);
        expect(creditRemaining).toBe(0);
        expect(arControl.netSubledgerBalance).toBe(7000);
        expect(arResult?.consistent).toBe(true);
      } finally {
        await deleteTestOrganization(supabase, organizationId);
      }
    });
  });

  describe("AP control reconciliation with vendor credits", () => {
    async function postVendorBill(
      organizationId: string,
      accountIds: Record<string, string>,
      total: number,
      partyId: string | null = null,
    ) {
      const bill = await createTestBill(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total,
        partyId,
      });
      await postBillOpen(supabase, {
        organizationId,
        documentId: bill.id,
        partyId,
        jobId: null,
        issueDate: "2026-04-01",
        number: bill.number,
        tax: 0,
        lines: [{ amount: total, account_id: accountIds["6100"], description: "Parts" }],
      });
      return bill;
    }

    async function postVendorCreditDoc(
      organizationId: string,
      accountIds: Record<string, string>,
      total: number,
      partyId: string | null = null,
    ) {
      const vendorCredit = await createTestVendorCredit(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total,
        partyId,
      });
      await postVendorCreditOpen(supabase, {
        organizationId,
        documentId: vendorCredit.id,
        partyId,
        jobId: null,
        issueDate: "2026-04-02",
        number: vendorCredit.number,
        tax: 0,
        reason: "Credit",
        lines: [{ amount: total, account_id: accountIds["6100"], description: "Credit" }],
      });
      return vendorCredit;
    }

    it("unapplied vendor credit: bill 5,000 + credit 500 → vendor AP 4,500 reconciles to GL", async () => {
      const { organizationId, accountIds } = await createTestOrganization(supabase, "ap-unapplied");
      try {
        const bill = await postVendorBill(organizationId, accountIds, 5000);
        const vendorCredit = await postVendorCreditDoc(organizationId, accountIds, 500);

        const billRemaining = await authoritativeDocumentRemaining(
          supabase,
          organizationId,
          bill.id,
          5000,
        );
        const creditRemaining = await authoritativeCreditRemaining(
          supabase,
          organizationId,
          vendorCredit.id,
          500,
        );
        const apControl = await computeApControlSubledgerTotal(supabase, organizationId);
        const results = await reconcileSubledgersToGl(supabase, organizationId);
        const apResult = results.find((row) => row.side === "ap");

        expect(billRemaining).toBe(5000);
        expect(creditRemaining).toBe(500);
        expect(apControl.netSubledgerBalance).toBe(4500);
        expect(apResult?.consistent).toBe(true);
        expect(apResult?.glControlBalance).toBe(4500);
      } finally {
        await deleteTestOrganization(supabase, organizationId);
      }
    });

    it("partial vendor credit: bill 4,500 + credit 200 unapplied → vendor AP 4,300", async () => {
      const { organizationId, accountIds } = await createTestOrganization(supabase, "ap-partial");
      try {
        const bill = await postVendorBill(organizationId, accountIds, 5000);
        const vendorCredit = await postVendorCreditDoc(organizationId, accountIds, 500);

        await applyDocumentCredit(supabase, {
          organizationId,
          sourceDocumentId: vendorCredit.id,
          targetDocumentId: bill.id,
          amount: 300,
        });

        const billRemaining = await authoritativeDocumentRemaining(
          supabase,
          organizationId,
          bill.id,
          5000,
        );
        const creditRemaining = await authoritativeCreditRemaining(
          supabase,
          organizationId,
          vendorCredit.id,
          500,
        );
        const apControl = await computeApControlSubledgerTotal(supabase, organizationId);
        const apResult = (await reconcileSubledgersToGl(supabase, organizationId)).find(
          (row) => row.side === "ap",
        );

        expect(billRemaining).toBe(4700);
        expect(creditRemaining).toBe(200);
        expect(apControl.netSubledgerBalance).toBe(4500);
        expect(apResult?.consistent).toBe(true);
      } finally {
        await deleteTestOrganization(supabase, organizationId);
      }
    });

    it("fully applied vendor credit: bill 4,500 + credit 0 unapplied → vendor AP 4,500", async () => {
      const { organizationId, accountIds } = await createTestOrganization(supabase, "ap-full");
      try {
        const bill = await postVendorBill(organizationId, accountIds, 5000);
        const vendorCredit = await postVendorCreditDoc(organizationId, accountIds, 500);

        await applyDocumentCredit(supabase, {
          organizationId,
          sourceDocumentId: vendorCredit.id,
          targetDocumentId: bill.id,
          amount: 500,
        });

        const billRemaining = await authoritativeDocumentRemaining(
          supabase,
          organizationId,
          bill.id,
          5000,
        );
        const creditRemaining = await authoritativeCreditRemaining(
          supabase,
          organizationId,
          vendorCredit.id,
          500,
        );
        const apControl = await computeApControlSubledgerTotal(supabase, organizationId);
        const apResult = (await reconcileSubledgersToGl(supabase, organizationId)).find(
          (row) => row.side === "ap",
        );

        expect(billRemaining).toBe(4500);
        expect(creditRemaining).toBe(0);
        expect(apControl.netSubledgerBalance).toBe(4500);
        expect(apResult?.consistent).toBe(true);
      } finally {
        await deleteTestOrganization(supabase, organizationId);
      }
    });
  });
});
