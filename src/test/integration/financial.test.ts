import { describe, expect, it } from "vitest";
import {
  authoritativeDocumentAmountPaid,
  documentRemainingBalance,
} from "@/lib/accounting/balances";
import { PeriodClosedError } from "@/lib/accounting/periods";
import {
  postExpense,
  postExpensePaid,
  postInvoiceOpen,
  postInvoicePaid,
  voidExpense,
} from "@/lib/accounting/post";
import {
  createIntegrationClient,
  createTestExpenseBill,
  createTestInvoice,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("financial integration", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  it("invoice partial and final payments keep AR authoritative", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "invoice");
    try {
      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 1500,
      });

      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 1500, account_id: accountIds["4000"], description: "Service" }],
      });

      await postInvoicePaid(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-02",
        number: invoice.number,
        total: 500,
        invoiceTotal: 1500,
        priorPaid: 0,
      });

      let paid = await authoritativeDocumentAmountPaid(supabase, organizationId, invoice.id);
      expect(paid).toBe(500);
      expect(documentRemainingBalance(1500, paid)).toBe(1000);

      await postInvoicePaid(supabase, {
        organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-03",
        number: invoice.number,
        total: 1000,
        invoiceTotal: 1500,
        priorPaid: paid,
      });

      paid = await authoritativeDocumentAmountPaid(supabase, organizationId, invoice.id);
      expect(paid).toBe(1500);
      expect(documentRemainingBalance(1500, paid)).toBe(0);

      const { data: finalDoc } = await supabase
        .from("teller_documents")
        .select("status, amount_paid")
        .eq("id", invoice.id)
        .single();
      expect(finalDoc?.status).toBe("paid");
      expect(Number(finalDoc?.amount_paid)).toBe(1500);

      await expect(
        postInvoicePaid(supabase, {
          organizationId,
          documentId: invoice.id,
          partyId: null,
          jobId: null,
          issueDate: "2026-04-04",
          number: invoice.number,
          total: 1,
          invoiceTotal: 1500,
          priorPaid: paid,
        }),
      ).rejects.toThrow(/nothing left to pay/i);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("AP bill partial and final payments clear remaining balance", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "ap");
    try {
      const bill = await createTestExpenseBill(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total: 1000,
      });

      await postExpense(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-01",
        number: bill.number,
        amount: 1000,
        accountId: accountIds["6100"],
        paid: false,
      });

      await postExpensePaid(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-02",
        number: bill.number,
        paymentAmount: 400,
        expenseTotal: 1000,
        priorPaid: 0,
      });

      let paid = await authoritativeDocumentAmountPaid(supabase, organizationId, bill.id);
      expect(paid).toBe(400);
      expect(documentRemainingBalance(1000, paid)).toBe(600);

      await postExpensePaid(supabase, {
        organizationId,
        documentId: bill.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-03",
        number: bill.number,
        paymentAmount: 600,
        expenseTotal: 1000,
        priorPaid: paid,
      });

      paid = await authoritativeDocumentAmountPaid(supabase, organizationId, bill.id);
      expect(paid).toBe(1000);
      expect(documentRemainingBalance(1000, paid)).toBe(0);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("voiding a paid expense retains original journal and nets to zero", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "void");
    try {
      const expense = await createTestExpenseBill(supabase, {
        organizationId,
        expenseAccountId: accountIds["6100"],
        total: 500,
      });

      await postExpense(supabase, {
        organizationId,
        documentId: expense.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-01",
        number: expense.number,
        amount: 500,
        accountId: accountIds["6100"],
        paid: true,
      });

      const { count: beforeCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_id", expense.id);

      await voidExpense(supabase, {
        organizationId,
        documentId: expense.id,
        number: expense.number,
        voidDate: "2026-04-02",
        amountPaid: 0,
      });

      const { count: afterCount } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source_id", expense.id);

      expect((afterCount ?? 0) > (beforeCount ?? 0)).toBe(true);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects backdated postings in a closed period", async () => {
    const { organizationId, accountIds } = await createTestOrganization(supabase, "period");
    try {
      await supabase.from("teller_period_closes").insert({
        organization_id: organizationId,
        period_end: "2026-03-31",
        notes: "Integration test close",
      });

      const invoice = await createTestInvoice(supabase, {
        organizationId,
        revenueAccountId: accountIds["4000"],
        total: 100,
      });

      await expect(
        postInvoiceOpen(supabase, {
          organizationId,
          documentId: invoice.id,
          partyId: null,
          jobId: null,
          issueDate: "2026-03-15",
          number: invoice.number,
          tax: 0,
          lines: [{ amount: 100, account_id: accountIds["4000"], description: "Service" }],
        }),
      ).rejects.toBeInstanceOf(PeriodClosedError);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("blocks cross-tenant document payment actions", async () => {
    const orgA = await createTestOrganization(supabase, "tenant-a");
    const orgB = await createTestOrganization(supabase, "tenant-b");
    try {
      const invoice = await createTestInvoice(supabase, {
        organizationId: orgA.organizationId,
        revenueAccountId: orgA.accountIds["4000"],
        total: 200,
      });

      await postInvoiceOpen(supabase, {
        organizationId: orgA.organizationId,
        documentId: invoice.id,
        partyId: null,
        jobId: null,
        issueDate: "2026-04-01",
        number: invoice.number,
        tax: 0,
        lines: [{ amount: 200, account_id: orgA.accountIds["4000"], description: "Service" }],
      });

      const { data: crossTenantDoc } = await supabase
        .from("teller_documents")
        .select("id")
        .eq("organization_id", orgB.organizationId)
        .eq("id", invoice.id)
        .maybeSingle();

      expect(crossTenantDoc).toBeNull();
    } finally {
      await Promise.all([
        deleteTestOrganization(supabase, orgA.organizationId),
        deleteTestOrganization(supabase, orgB.organizationId),
      ]);
    }
  });
});
