import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountByCode, accountBySubtype } from "./accounts";
import {
  authoritativeDocumentAmountPaid,
  documentRemainingBalance,
} from "./balances";
import { documentHasActivePayments } from "./allocations";
import {
  documentAllocationKind,
  documentHasAppliedCredits,
  recordDocumentAllocation,
  sumCreditsAppliedFromDocument,
  sumCreditsAppliedToDocument,
} from "./document-allocations";
import {
  assertCreditDocumentStatusTransition,
  creditDocumentStatusAfterApplication,
  invoiceStatusAfterSettlement,
  billStatusAfterPayment,
  type CreditDocumentStatus,
} from "./document-transitions";
import { recordDocumentJournalLink } from "./journal-links";
import { roundMoney } from "./payment-fees";
import { postJournal, loadOrgAccounts, reverseJournalEntry, assertOrgPeriodOpen } from "./post";

type JournalLineInput = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  memo?: string;
};

export async function postCreditMemoOpen(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    reason?: string;
    lines: { amount: number; account_id: string | null; description: string }[];
    actorId?: string | null;
  },
) {
  assertCreditDocumentStatusTransition("draft", "open");

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  const taxPayable = accountBySubtype(accounts, "tax") || accountByCode(accounts, "2100");
  const fallbackDebit = accounts.find((a) => a.type === "revenue");

  if (!ar) throw new Error("Accounts Receivable is missing from the chart of accounts");

  const journal: JournalLineInput[] = [];
  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  const total = subtotal + tax;

  for (const line of input.lines) {
    const debitId = line.account_id || fallbackDebit?.id;
    if (!debitId) throw new Error("Each credit memo line needs a debit account");
    journal.push({
      account_id: debitId,
      debit: asNumber(line.amount),
      party_id: input.partyId,
      job_id: input.jobId,
      memo: line.description,
    });
  }

  if (tax > 0) {
    if (!taxPayable) throw new Error("Tax adjustment but no tax payable account exists");
    journal.push({
      account_id: taxPayable.id,
      debit: tax,
      memo: `Tax on credit ${input.number}`,
    });
  }

  journal.push({
    account_id: ar.id,
    credit: total,
    party_id: input.partyId,
    job_id: null,
    memo: input.reason ? `Credit ${input.number}: ${input.reason}` : `Credit memo ${input.number}`,
  });

  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: input.reason ? `Credit memo ${input.number} · ${input.reason}` : `Credit memo ${input.number}`,
    sourceKind: "credit-memo",
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
    linkKind: "credit",
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "credit_memo.posted",
    resourceKind: "credit_memo",
    resourceId: input.documentId,
    metadata: { number: input.number, total, entryId, reason: input.reason },
  });

  return entryId;
}

export async function postVendorCreditOpen(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    reason?: string;
    lines: { amount: number; account_id: string | null; description: string }[];
    actorId?: string | null;
  },
) {
  assertCreditDocumentStatusTransition("draft", "open");

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  const taxPayable = accountBySubtype(accounts, "tax") || accountByCode(accounts, "2100");
  const fallbackCredit = accounts.find(
    (a) => a.type === "expense" || a.type === "cogs" || a.type === "asset",
  );

  if (!ap) throw new Error("Accounts Payable is missing from the chart of accounts");

  const journal: JournalLineInput[] = [];
  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  const total = subtotal + tax;

  journal.push({
    account_id: ap.id,
    debit: total,
    party_id: input.partyId,
    job_id: input.jobId,
    memo: input.reason ? `Vendor credit ${input.number}: ${input.reason}` : `Vendor credit ${input.number}`,
  });

  for (const line of input.lines) {
    const creditId = line.account_id || fallbackCredit?.id;
    if (!creditId) throw new Error("Each vendor credit line needs a credit account");
    journal.push({
      account_id: creditId,
      credit: asNumber(line.amount),
      party_id: input.partyId,
      job_id: input.jobId,
      memo: line.description,
    });
  }

  if (tax > 0) {
    if (!taxPayable) throw new Error("Tax adjustment but no tax payable account exists");
    journal.push({
      account_id: taxPayable.id,
      credit: tax,
      memo: `Tax on vendor credit ${input.number}`,
    });
  }

  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: input.reason
      ? `Vendor credit ${input.number} · ${input.reason}`
      : `Vendor credit ${input.number}`,
    sourceKind: "vendor-credit",
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
    linkKind: "credit",
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "vendor_credit.posted",
    resourceKind: "vendor_credit",
    resourceId: input.documentId,
    metadata: { number: input.number, total, entryId, reason: input.reason },
  });

  return entryId;
}

export async function applyDocumentCredit(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceDocumentId: string;
    targetDocumentId: string;
    amount: number;
    actorId?: string | null;
  },
) {
  const amount = roundMoney(asNumber(input.amount));
  if (amount <= 0.009) throw new Error("Credit application amount must be greater than zero.");

  const [{ data: source }, { data: target }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("id", input.sourceDocumentId)
      .maybeSingle(),
    supabase
      .from("teller_documents")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("id", input.targetDocumentId)
      .maybeSingle(),
  ]);

  if (!source || !target) throw new Error("Source or target document not found");
  if (source.status === "void" || target.status === "void") {
    throw new Error("Cannot apply credit to or from a void document.");
  }
  if (source.status === "draft" || target.status === "draft") {
    throw new Error("Both documents must be posted before applying credit.");
  }

  const allocationKind = documentAllocationKind(source.kind as string, target.kind as string);

  if (source.party_id !== target.party_id) {
    throw new Error(
      "Credit can only be applied to documents for the same customer or vendor.",
    );
  }

  const sourceApplied = await sumCreditsAppliedFromDocument(
    supabase,
    input.organizationId,
    input.sourceDocumentId,
  );
  const sourceRemaining = documentRemainingBalance(asNumber(source.total), sourceApplied);
  if (amount > sourceRemaining + 0.009) {
    throw new Error(
      `Credit application of $${amount.toFixed(2)} exceeds unapplied credit of $${sourceRemaining.toFixed(2)}.`,
    );
  }

  const targetPaid = await authoritativeDocumentAmountPaid(
    supabase,
    input.organizationId,
    input.targetDocumentId,
  );
  const targetCredits = await sumCreditsAppliedToDocument(
    supabase,
    input.organizationId,
    input.targetDocumentId,
  );
  const targetRemaining = documentRemainingBalance(
    asNumber(target.total),
    roundMoney(targetPaid + targetCredits),
  );
  if (amount > targetRemaining + 0.009) {
    throw new Error(
      `Credit application of $${amount.toFixed(2)} exceeds target remaining balance of $${targetRemaining.toFixed(2)}.`,
    );
  }

  const allocationId = await recordDocumentAllocation(supabase, {
    organizationId: input.organizationId,
    sourceDocumentId: input.sourceDocumentId,
    targetDocumentId: input.targetDocumentId,
    amount,
    allocationKind,
  });

  const newSourceApplied = roundMoney(sourceApplied + amount);
  const sourceStatus = creditDocumentStatusAfterApplication(
    asNumber(source.total),
    newSourceApplied,
  ) as CreditDocumentStatus;

  const newTargetCredits = roundMoney(targetCredits + amount);
  let targetStatus: string;
  if (target.kind === "invoice") {
    targetStatus = invoiceStatusAfterSettlement(
      asNumber(target.total),
      targetPaid,
      newTargetCredits,
    );
  } else {
    targetStatus = billStatusAfterPayment(
      asNumber(target.total),
      targetPaid,
      newTargetCredits,
    );
  }

  await supabase
    .from("teller_documents")
    .update({ status: sourceStatus, updated_at: new Date().toISOString() })
    .eq("id", input.sourceDocumentId);

  await supabase
    .from("teller_documents")
    .update({ status: targetStatus, updated_at: new Date().toISOString() })
    .eq("id", input.targetDocumentId);

  const auditAction =
    source.kind === "credit_memo" ? "credit_memo.applied" : "vendor_credit.applied";

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: auditAction,
    resourceKind: source.kind as string,
    resourceId: input.sourceDocumentId,
    metadata: {
      amount,
      targetDocumentId: input.targetDocumentId,
      allocationId,
      sourceStatus,
      targetStatus,
    },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "document_credit_allocation.created",
    resourceKind: "document_allocation",
    resourceId: allocationId,
    metadata: {
      amount,
      sourceDocumentId: input.sourceDocumentId,
      targetDocumentId: input.targetDocumentId,
      allocationKind,
    },
  });

  return { allocationId, sourceStatus, targetStatus };
}

export async function voidCreditDocument(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    kind: "credit_memo" | "vendor_credit";
    number: string;
    voidDate: string;
    postedEntryId?: string | null;
    currentStatus?: CreditDocumentStatus;
    actorId?: string | null;
  },
) {
  const hasApplied = await documentHasAppliedCredits(
    supabase,
    input.organizationId,
    input.documentId,
    true,
  );
  if (hasApplied) {
    throw new Error(
      "Cannot void a credit with applications. Reverse allocations first.",
    );
  }

  const fromStatus = input.currentStatus ?? "open";
  assertCreditDocumentStatusTransition(fromStatus, "void");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.voidDate);

  const { data: linkedEntries } = await supabase
    .from("teller_journal_entries")
    .select("id")
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
      memo: `Void ${input.kind.replace("_", " ")} ${input.number}`,
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
    .update({ status: "void", updated_at: new Date().toISOString() })
    .eq("id", input.documentId);

  const auditAction =
    input.kind === "credit_memo" ? "credit_memo.voided" : "vendor_credit.voided";

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: auditAction,
    resourceKind: input.kind,
    resourceId: input.documentId,
    metadata: { number: input.number },
  });
}

function isCustomerCreditRefundRow(
  row: { document_id?: string | null; metadata?: unknown },
  creditMemoId: string,
): boolean {
  if (row.document_id !== creditMemoId) return false;
  if (!row.metadata || typeof row.metadata !== "object") return false;
  return (row.metadata as Record<string, unknown>).kind === "customer_credit_refund";
}

/** Posted cash refunds against unapplied customer credit (not deposit refunds). */
export async function sumCustomerCreditRefundsForMemo(
  supabase: SupabaseClient,
  organizationId: string,
  creditMemoId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_payments")
    .select("amount, document_id, metadata")
    .eq("organization_id", organizationId)
    .eq("document_id", creditMemoId)
    .eq("payment_type", "customer_refund")
    .eq("status", "posted");

  if (error) throw new Error(error.message);

  return roundMoney(
    (data ?? [])
      .filter((row) => isCustomerCreditRefundRow(row, creditMemoId))
      .reduce((sum, row) => sum + asNumber(row.amount), 0),
  );
}

export async function batchCustomerCreditRefundsForMemos(
  supabase: SupabaseClient,
  organizationId: string,
  creditMemoIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!creditMemoIds.length) return result;
  for (const id of creditMemoIds) result.set(id, 0);

  const { data, error } = await supabase
    .from("teller_payments")
    .select("amount, document_id, metadata")
    .eq("organization_id", organizationId)
    .in("document_id", creditMemoIds)
    .eq("payment_type", "customer_refund")
    .eq("status", "posted");

  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    const id = row.document_id as string;
    if (!isCustomerCreditRefundRow(row, id)) continue;
    result.set(id, roundMoney((result.get(id) ?? 0) + asNumber(row.amount)));
  }

  return result;
}
