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
import type { AccrualAllocationInput } from "./accrual-settlement/types";
import { postAccrualSettlementWithBill } from "./accrual-settlement/settlement-service";
import { assertBillVoidAllowedWithoutActiveSettlement } from "./accrual-settlement/bill-settlement-guard";
import { allocateVendorPurchaseTax } from "./accrual-settlement/purchase-tax";
import {
  postExpensePaid,
  postJournal,
  loadOrgAccounts,
  reverseJournalEntry,
  assertOrgPeriodOpen,
} from "./post";
import { recordPurchaseTaxReversalForDocument } from "./tax/posting/reverse-transactions";

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
      taxAmount?: number;
      taxable?: boolean;
      recoverableInputTax?: boolean;
      occurrenceId?: string | null;
      settlesAccrual?: boolean;
    }[];
    actorId?: string | null;
    accrualAllocations?: AccrualAllocationInput[];
    settlementIdempotencyKey?: string | null;
    additionalJournalLines?: JournalLineInput[];
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

  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  const total = subtotal + tax;

  if (input.accrualAllocations && input.accrualAllocations.length > 0) {
    const settlement = await postAccrualSettlementWithBill(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId,
      partyId: input.partyId,
      jobId: input.jobId,
      issueDate: input.issueDate,
      number: input.number,
      tax,
      lines: input.lines,
      allocations: input.accrualAllocations,
      actorId: input.actorId,
      idempotencyKey: input.settlementIdempotencyKey,
    });

    const { error } = await supabase
      .from("teller_documents")
      .update({
        status: "open",
        posted_entry_id: settlement.journalEntryId,
        subtotal,
        tax,
        total,
        amount_paid: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.documentId);

    if (error) throw new Error(error.message);

    await supabase.from("teller_document_lines").delete().eq("document_id", input.documentId);
    const { error: linesError } = await supabase.from("teller_document_lines").insert(
      input.lines.map((line, index) => ({
        document_id: input.documentId,
        description: line.description,
        quantity: 1,
        unit_price: asNumber(line.amount),
        amount: asNumber(line.amount),
        account_id: line.account_id,
        job_id: line.job_id ?? input.jobId,
        cost_category: line.cost_category ?? "",
        cost_type: line.cost_type ?? "",
        cost_classification: line.cost_classification ?? "direct",
        item_type: "expense",
        sort_order: index,
      })),
    );
    if (linesError) throw new Error(linesError.message);

    await recordDocumentJournalLink(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId,
      journalEntryId: settlement.journalEntryId,
      linkKind: "accrual",
    });

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "bill.posted",
      resourceKind: "bill",
      resourceId: input.documentId,
      metadata: {
        number: input.number,
        total,
        entryId: settlement.journalEntryId,
        settlementId: settlement.settlementId,
        accrualSettlement: true,
      },
    });

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "document.status_changed",
      resourceKind: "bill",
      resourceId: input.documentId,
      metadata: { number: input.number, from: fromStatus, to: "open" },
    });

    return settlement.journalEntryId;
  }

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  const fallbackDebit = accounts.find((a) => a.type === "expense" || a.type === "cogs");

  if (!ap) throw new Error("Accounts Payable is missing from the chart of accounts");

  const journal: JournalLineInput[] = [];

  const lineTargets = input.lines.map((line) => {
    const debitId = line.account_id || fallbackDebit?.id;
    if (!debitId) throw new Error("Each bill line needs a debit account");
    const account = accounts.find((row) => row.id === debitId);
    return {
      accountId: debitId,
      amount: asNumber(line.amount),
      accountType: account?.type ?? null,
      line,
    };
  });

  for (const target of lineTargets) {
    journal.push({
      account_id: target.accountId,
      debit: target.amount,
      party_id: input.partyId,
      job_id: target.line.job_id ?? input.jobId,
      cost_classification: target.line.cost_classification ?? "direct",
      memo: target.line.description,
    });
  }

  if (tax > 0) {
    const recoverableInputTaxAccountId =
      accountBySubtype(accounts, "input_tax")?.id ??
      accountBySubtype(accounts, "tax_receivable")?.id ??
      accountByCode(accounts, "1350")?.id ??
      null;
    const taxAllocations = allocateVendorPurchaseTax({
      taxAmount: tax,
      targets: lineTargets.map((target) => ({
        accountId: target.accountId,
        amount: target.amount,
        accountType: target.accountType,
      })),
      recoverableInputTaxAccountId,
    });
    for (const taxLine of taxAllocations) {
      journal.push({
        account_id: taxLine.accountId,
        debit: taxLine.amount,
        party_id: input.partyId,
        memo: taxLine.memo ?? `Tax on ${input.number}`,
      });
    }
  }

  if (input.additionalJournalLines?.length) {
    journal.push(...input.additionalJournalLines);
  }

  journal.push({
    account_id: ap.id,
    credit: total,
    party_id: input.partyId,
    job_id: null,
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

  await supabase.from("teller_document_lines").delete().eq("document_id", input.documentId);
  const { error: linesError } = await supabase.from("teller_document_lines").insert(
    input.lines.map((line, index) => ({
      document_id: input.documentId,
      description: line.description,
      quantity: 1,
      unit_price: asNumber(line.amount),
      amount: asNumber(line.amount),
      account_id: line.account_id,
      job_id: line.job_id ?? input.jobId,
      cost_category: line.cost_category ?? "",
      cost_type: line.cost_type ?? "",
      cost_classification: line.cost_classification ?? "direct",
      item_type: "expense",
      sort_order: index,
    })),
  );
  if (linesError) throw new Error(linesError.message);

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

  await assertBillVoidAllowedWithoutActiveSettlement(
    supabase,
    input.organizationId,
    input.documentId,
  );

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

  let billReversalEntryId: string | null = null;

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

    if (!billReversalEntryId && (!input.postedEntryId || entryId === input.postedEntryId)) {
      billReversalEntryId = reversalEntryId;
    }
  }

  if (billReversalEntryId) {
    await recordPurchaseTaxReversalForDocument(supabase, input.organizationId, {
      documentId: input.documentId,
      reversalJournalEntryId: billReversalEntryId,
      voidDate: input.voidDate,
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
