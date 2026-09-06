import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountByCode, accountBySubtype } from "./accounts";
import { documentRemainingBalance } from "./balances";
import { documentHasActivePayments } from "./allocations";
import { documentHasAppliedCredits, sumCreditsAppliedToDocument } from "./document-allocations";
import {
  assertBillStatusTransition,
  billStatusAfterPayment,
  type BillStatus,
} from "./document-transitions";
import { recordDocumentJournalLink } from "./journal-links";
import { roundMoney } from "./payment-fees";
import {
  postExpensePaid,
  postJournal,
  loadOrgAccounts,
  reverseJournalEntry,
  assertOrgPeriodOpen,
} from "./post";

type JournalLineInput = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  job_cost_category_id?: string | null;
  cost_classification?: string | null;
  memo?: string;
};

export async function postBillOpen(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    lines: {
      amount: number;
      account_id: string | null;
      description: string;
      job_id?: string | null;
      cost_category?: string;
      cost_type?: string;
      cost_classification?: string | null;
    }[];
    actorId?: string | null;
  },
) {
  const { data: currentDoc } = await supabase
    .from("teller_documents")
    .select("status, posted_entry_id")
    .eq("id", input.documentId)
    .maybeSingle();
  if (currentDoc?.posted_entry_id) {
    throw new Error("Bill is already posted");
  }
  const fromStatus = (currentDoc?.status as BillStatus) || "draft";
  assertBillStatusTransition(fromStatus, "open");
  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  const taxPayable = accountBySubtype(accounts, "tax") || accountByCode(accounts, "2100");
  const fallbackDebit = accounts.find((a) => a.type === "expense" || a.type === "cogs");

  if (!ap) throw new Error("Accounts Payable is missing from the chart of accounts");

  const journal: JournalLineInput[] = [];
  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  const total = subtotal + tax;

  for (const line of input.lines) {
    const debitId = line.account_id || fallbackDebit?.id;
    if (!debitId) throw new Error("Each bill line needs a debit account");
    journal.push({
      account_id: debitId,
      debit: asNumber(line.amount),
      party_id: input.partyId,
      job_id: line.job_id ?? input.jobId,
      cost_classification: line.cost_classification ?? "direct",
      memo: line.description,
    });
  }

  if (tax > 0) {
    if (!taxPayable) throw new Error("Tax on bill but no tax payable account exists");
    journal.push({
      account_id: taxPayable.id,
      debit: tax,
      memo: `Tax on ${input.number}`,
    });
  }

  journal.push({
    account_id: ap.id,
    credit: total,
    party_id: input.partyId,
    job_id: input.jobId,
    memo: `Bill ${input.number}`,
  });

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Bill ${input.number}`,
    sourceKind: "bill",
    sourceId: input.documentId,
    lines: journal,
    actorId: input.actorId,
  });

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: "open",
      posted_entry_id: entryId,
      subtotal,
      tax,
      total,
      amount_paid: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);

  await recordDocumentJournalLink(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    journalEntryId: entryId,
    linkKind: "accrual",
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "bill.posted",
    resourceKind: "bill",
    resourceId: input.documentId,
    metadata: { number: input.number, total, entryId },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "document.status_changed",
    resourceKind: "bill",
    resourceId: input.documentId,
    metadata: { number: input.number, from: "draft", to: "open" },
  });

  return entryId;
}

export async function postBillPaid(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    paymentAmount: number;
    billTotal?: number;
    priorPaid?: number;
    paymentMemo?: string;
    paymentMethod?: string;
    referenceNumber?: string;
    actorId?: string | null;
  },
) {
  const billTotal = input.billTotal ?? input.paymentAmount;
  const priorPaid = input.priorPaid ?? 0;
  const priorCredits = await sumCreditsAppliedToDocument(
    supabase,
    input.organizationId,
    input.documentId,
  );
  const settled = roundMoney(priorPaid + priorCredits);

  const remainingBefore = documentRemainingBalance(billTotal, settled);
  const paymentAmount = roundMoney(asNumber(input.paymentAmount));
  if (remainingBefore <= 0.009) throw new Error("Nothing left to pay on this bill.");
  if (paymentAmount <= 0.009) throw new Error("Payment amount must be greater than zero.");
  if (paymentAmount > remainingBefore + 0.009) {
    throw new Error(
      `Payment of $${paymentAmount.toFixed(2)} exceeds remaining balance of $${remainingBefore.toFixed(2)}.`,
    );
  }

  const result = await postExpensePaid(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.partyId,
    jobId: input.jobId,
    issueDate: input.issueDate,
    number: input.number,
    paymentAmount,
    expenseTotal: billTotal,
    priorPaid: settled,
    paymentMemo: input.paymentMemo,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.referenceNumber,
    documentKind: "bill",
    actorId: input.actorId,
  });

  const nextStatus = billStatusAfterPayment(billTotal, result.amountPaid, priorCredits);

  await supabase
    .from("teller_documents")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", input.documentId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "bill.payment.recorded",
    resourceKind: "bill",
    resourceId: input.documentId,
    metadata: {
      number: input.number,
      paymentAmount,
      amountPaid: result.amountPaid,
      billTotal,
    },
  });

  if (nextStatus === "paid") {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "bill.paid",
      resourceKind: "bill",
      resourceId: input.documentId,
      metadata: { number: input.number, billTotal },
    });
  } else {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "bill.partially_paid",
      resourceKind: "bill",
      resourceId: input.documentId,
      metadata: { number: input.number, remaining: documentRemainingBalance(billTotal, result.amountPaid + priorCredits) },
    });
  }

  return { ...result, fullyPaid: nextStatus === "paid", status: nextStatus };
}

export async function voidBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    number: string;
    voidDate: string;
    postedEntryId?: string | null;
    currentStatus?: BillStatus;
    actorId?: string | null;
  },
) {
  const hasPayments = await documentHasActivePayments(
    supabase,
    input.organizationId,
    input.documentId,
  );
  const hasCredits = await documentHasAppliedCredits(
    supabase,
    input.organizationId,
    input.documentId,
    false,
  );

  if (hasPayments || hasCredits) {
    throw new Error(
      "Cannot void a bill with payment or vendor credit activity. Reverse those first.",
    );
  }

  const fromStatus = input.currentStatus ?? "open";
  assertBillStatusTransition(fromStatus, "void");
  await assertOrgPeriodOpen(supabase, input.organizationId, input.voidDate);

  const { data: linkedEntries } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind")
    .eq("organization_id", input.organizationId)
    .eq("source_id", input.documentId)
    .is("reverses_entry_id", null)
    .neq("source_kind", "reversal");

  const entryIds = new Set((linkedEntries ?? []).map((e) => e.id as string));
  if (input.postedEntryId) entryIds.add(input.postedEntryId);

  for (const entryId of entryIds) {
    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("reverses_entry_id", entryId);
    if ((count ?? 0) > 0) continue;

    const reversalEntryId = await reverseJournalEntry(supabase, {
      organizationId: input.organizationId,
      entryId,
      entryDate: input.voidDate,
      memo: `Void bill ${input.number}`,
      sourceId: input.documentId,
      actorId: input.actorId,
    });

    await recordDocumentJournalLink(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId,
      journalEntryId: reversalEntryId,
      linkKind: "reversal",
    });
  }

  await supabase
    .from("teller_documents")
    .update({ status: "void", amount_paid: 0, updated_at: new Date().toISOString() })
    .eq("id", input.documentId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "bill.voided",
    resourceKind: "bill",
    resourceId: input.documentId,
    metadata: { number: input.number },
  });
}
