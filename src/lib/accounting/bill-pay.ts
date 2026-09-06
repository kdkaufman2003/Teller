import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordPaymentAllocation } from "./allocations";
import { authoritativeDocumentRemaining } from "./balances";
import { sumCreditsAppliedToDocument } from "./document-allocations";
import { billStatusAfterPayment } from "./document-transitions";
import { recordDocumentJournalLink } from "./journal-links";
import { recordAuditEvent } from "./audit";
import { accountByCode, accountBySubtype } from "./accounts";
import { loadOrgAccounts, postJournal, assertOrgPeriodOpen } from "./post";
import { recordTellerPayment } from "./payments";
import { roundMoney } from "./payment-fees";

export type BillPaymentAllocation = {
  documentId: string;
  amount: number;
};

export async function postMultiBillPayment(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    partyId: string;
    paymentDate: string;
    referenceNumber?: string;
    paymentMethod?: string;
    memo?: string;
    allocations: BillPaymentAllocation[];
    creditApplications?: Array<{ sourceDocumentId: string; targetDocumentId: string; amount: number }>;
    actorId?: string | null;
    idempotencyKey?: string;
  },
) {
  if (!input.allocations.length) throw new Error("Select at least one bill to pay");
  await assertOrgPeriodOpen(supabase, input.organizationId, input.paymentDate);

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  if (!cash || !ap) throw new Error("Cash or AP account is missing");

  let cashTotal = 0;
  const validated: Array<{ documentId: string; amount: number; number: string; jobId: string | null }> =
    [];

  for (const allocation of input.allocations) {
    const amount = roundMoney(asNumber(allocation.amount));
    if (amount <= 0) throw new Error("Each allocation must be greater than zero");

    const { data: bill, error } = await supabase
      .from("teller_documents")
      .select("id, number, total, status, party_id, job_id")
      .eq("organization_id", input.organizationId)
      .eq("kind", "bill")
      .eq("id", allocation.documentId)
      .maybeSingle();
    if (error || !bill) throw new Error("Bill not found");
    if (bill.party_id !== input.partyId) throw new Error("All bills must belong to the selected vendor");
    if (bill.status === "draft" || bill.status === "void" || bill.status === "pending_approval") {
      throw new Error(`Bill ${bill.number} is not payable`);
    }

    const remaining = await authoritativeDocumentRemaining(
      supabase,
      input.organizationId,
      bill.id as string,
      asNumber(bill.total),
    );
    if (amount > remaining + 0.009) {
      throw new Error(`Payment of ${amount} exceeds remaining ${remaining} on bill ${bill.number}`);
    }

    cashTotal += amount;
    validated.push({
      documentId: bill.id as string,
      amount,
      number: bill.number as string,
      jobId: (bill.job_id as string | null) ?? null,
    });
  }

  cashTotal = roundMoney(cashTotal);
  if (cashTotal <= 0) throw new Error("Payment total must be greater than zero");

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.paymentDate,
    memo: input.memo || `Vendor payment (${validated.length} bills)`,
    sourceKind: "bill-payment",
    sourceId: validated[0]?.documentId,
    lines: [
      {
        account_id: ap.id,
        debit: cashTotal,
        party_id: input.partyId,
        memo: "Clear accounts payable",
      },
      {
        account_id: cash.id,
        credit: cashTotal,
        party_id: input.partyId,
        memo: "Vendor payment",
      },
    ],
    actorId: input.actorId,
  });

  const { paymentId } = await recordTellerPayment(supabase, {
    organizationId: input.organizationId,
    documentId: null,
    documentKind: "bill",
    partyId: input.partyId,
    jobId: null,
    amount: cashTotal,
    paymentDate: input.paymentDate,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.referenceNumber,
    journalEntryId: entryId,
    paymentType: "bill_payment",
    createAllocation: false,
    metadata: input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {},
  });

  if (!paymentId) throw new Error("Could not record payment");

  for (const allocation of validated) {
    await recordPaymentAllocation(supabase, {
      organizationId: input.organizationId,
      paymentId,
      documentId: allocation.documentId,
      amount: allocation.amount,
      allocationKind: "bill_payment",
    });

    const { data: bill } = await supabase
      .from("teller_documents")
      .select("total, amount_paid")
      .eq("id", allocation.documentId)
      .single();
    const credits = await sumCreditsAppliedToDocument(
      supabase,
      input.organizationId,
      allocation.documentId,
    );
    const priorPaid = roundMoney(asNumber(bill?.amount_paid) + allocation.amount);
    const nextStatus = billStatusAfterPayment(asNumber(bill?.total), priorPaid, credits);

    await supabase
      .from("teller_documents")
      .update({
        status: nextStatus,
        amount_paid: priorPaid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", allocation.documentId);

    await recordDocumentJournalLink(supabase, {
      organizationId: input.organizationId,
      documentId: allocation.documentId,
      journalEntryId: entryId,
      linkKind: "payment",
      paymentId,
    });

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "bill.payment.recorded",
      resourceKind: "bill",
      resourceId: allocation.documentId,
      metadata: { paymentId, amount: allocation.amount, number: allocation.number },
    });
  }

  if (input.creditApplications?.length) {
    const { applyDocumentCredit } = await import("./credits");
    for (const credit of input.creditApplications) {
      await applyDocumentCredit(supabase, {
        organizationId: input.organizationId,
        sourceDocumentId: credit.sourceDocumentId,
        targetDocumentId: credit.targetDocumentId,
        amount: credit.amount,
        actorId: input.actorId,
      });
    }
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "payment.recorded",
    resourceKind: "payment",
    resourceId: paymentId,
    metadata: { billCount: validated.length, amount: cashTotal, entryId },
  });

  return { paymentId, entryId, total: cashTotal };
}
